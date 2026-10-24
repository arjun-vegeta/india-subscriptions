import { describe, expect, it } from 'vitest';
import { ChargeStatus, Currency, IntervalUnit, Provider } from '../../src/constants.js';
import {
  CycleStatus,
  ScheduleStatus,
  type CycleRecord,
  type ScheduleRecord,
  type SchedulerStore,
} from '../../src/scheduler/index.js';
import { T0, plusHours } from './helpers.js';

export function schedule(id: string, overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    id,
    provider: Provider.PayU,
    subscriptionId: `sub_${id}`,
    status: ScheduleStatus.Active,
    amount: 100,
    currency: Currency.INR,
    interval: { unit: IntervalUnit.Month, count: 1 },
    policy: { notifyLeadHours: 48, minNoticeHours: 24, maxAttempts: 3, retryIntervalHours: 24 },
    fingerprint: 'f',
    firstChargeAt: T0,
    anchorAt: T0,
    anchorIndex: 0,
    cycleIndex: 0,
    paidCycles: 0,
    retrying: false,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

export function cycle(scheduleId: string, index: number, overrides: Partial<CycleRecord> = {}): CycleRecord {
  return {
    scheduleId,
    index,
    status: CycleStatus.Pending,
    dueAt: T0,
    attemptDueAt: T0,
    attempt: 1,
    notificationRound: 1,
    attempts: [],
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

/** Builds a store under test, empty. `now` is the lock clock in epoch milliseconds, for stores that take one. */
export type SchedulerStoreFactory = (options?: { now?: () => number }) => Promise<SchedulerStore>;

export interface SchedulerStoreSuiteOptions {
  /**
   * True (the default) when the store judges lock expiry on a clock the test can inject. A store that asks the
   * database for the time sets it to false and tests expiry itself.
   */
  injectableClock?: boolean;
}

/** The behaviours every `SchedulerStore` must have (see the guarantees documented on the interface). */
export function schedulerStoreSuite(name: string, make: SchedulerStoreFactory, options: SchedulerStoreSuiteOptions = {}): void {
  const injectableClock = options.injectableClock ?? true;

  describe(`${name}: schedules and cycles`, () => {
    it('copies records in and out', async () => {
      const store = await make();
      const original = schedule('a', { metadata: { k: 'v' } });
      await store.saveSchedule(original);
      original.amount = 999;
      original.metadata!.k = 'changed';

      const read = await store.getSchedule('a');
      expect(read?.amount).toBe(100);
      expect(read?.metadata).toEqual({ k: 'v' });

      read!.amount = 5;
      expect((await store.getSchedule('a'))?.amount).toBe(100);

      const c = cycle('a', 0);
      await store.saveCycle(c);
      c.attempts.push({ attempt: 1, chargeId: 'x', status: ChargeStatus.Failed, at: T0 });
      expect((await store.getCycle('a', 0))?.attempts).toHaveLength(0);
      (await store.getCycle('a', 0))!.attempt = 9;
      expect((await store.getCycle('a', 0))?.attempt).toBe(1);
    });

    it('returns undefined for missing records', async () => {
      const store = await make();
      expect(await store.getSchedule('nope')).toBeUndefined();
      expect(await store.getCycle('nope', 0)).toBeUndefined();
      expect(await store.listCycles('nope')).toEqual([]);
      expect(await store.findBySubscriptionId(Provider.PayU, 'nope')).toBeUndefined();
    });

    it('lists due schedules at or before an instant, oldest first, up to the limit', async () => {
      const store = await make();
      await store.saveSchedule(schedule('late', { nextActionAt: plusHours(T0, 5) }));
      await store.saveSchedule(schedule('early', { nextActionAt: plusHours(T0, 1) }));
      await store.saveSchedule(schedule('exact', { nextActionAt: plusHours(T0, 3) }));
      await store.saveSchedule(schedule('none'));
      // A non-active schedule with a nextActionAt (a debit being reconciled) is still listed.
      await store.saveSchedule(schedule('cancelled', { status: ScheduleStatus.Cancelled, nextActionAt: plusHours(T0, 2) }));

      expect((await store.listDueSchedules(plusHours(T0, 3), 10)).map((s) => s.id)).toEqual(['early', 'cancelled', 'exact']);
      expect((await store.listDueSchedules(plusHours(T0, 3), 2)).map((s) => s.id)).toEqual(['early', 'cancelled']);
      expect(await store.listDueSchedules(T0, 10)).toEqual([]);
      expect((await store.listDueSchedules(plusHours(T0, 100), 10)).map((s) => s.id)).toHaveLength(4);
    });

    it('follows nextActionAt as it changes', async () => {
      const store = await make();
      await store.saveSchedule(schedule('a', { nextActionAt: T0 }));
      expect(await store.listDueSchedules(T0, 10)).toHaveLength(1);
      const { nextActionAt: _removed, ...without } = schedule('a');
      await store.saveSchedule(without);
      expect(await store.listDueSchedules(T0, 10)).toHaveLength(0);
    });

    it('finds a schedule by provider and current subscription id, preferring the newest', async () => {
      const store = await make();
      await store.saveSchedule(schedule('old', { subscriptionId: 'shared', createdAt: T0 }));
      await store.saveSchedule(schedule('new', { subscriptionId: 'shared', createdAt: plusHours(T0, 1) }));
      await store.saveSchedule(schedule('other', { subscriptionId: 'shared', provider: Provider.Cashfree }));
      expect((await store.findBySubscriptionId(Provider.PayU, 'shared'))?.id).toBe('new');
      expect((await store.findBySubscriptionId(Provider.Cashfree, 'shared'))?.id).toBe('other');

      await store.saveSchedule(schedule('new', { subscriptionId: 'renamed', createdAt: plusHours(T0, 1) }));
      expect((await store.findBySubscriptionId(Provider.PayU, 'shared'))?.id).toBe('old');
    });

    it('lists cycles of one schedule ordered by index', async () => {
      const store = await make();
      await store.saveCycle(cycle('a', 2));
      await store.saveCycle(cycle('a', 0));
      await store.saveCycle(cycle('b', 0));
      await store.saveCycle(cycle('a', 1));
      expect((await store.listCycles('a')).map((c) => c.index)).toEqual([0, 1, 2]);
      expect(await store.listCycles('b')).toHaveLength(1);
    });

    it('upserts a cycle by (scheduleId, index)', async () => {
      const store = await make();
      await store.saveCycle(cycle('a', 0));
      await store.saveCycle({ ...cycle('a', 0), status: CycleStatus.Succeeded });
      expect(await store.listCycles('a')).toHaveLength(1);
      expect((await store.getCycle('a', 0))?.status).toBe(CycleStatus.Succeeded);
    });
  });

  describe(`${name}: findScheduleByChargeId`, () => {
    it('finds the schedule by the merchant charge id or the gateway charge id of one of its cycles, and by nothing else', async () => {
      const store = await make();
      await store.saveSchedule(schedule('a'));
      await store.saveSchedule(schedule('b'));
      await store.saveCycle(cycle('a', 0, { chargeId: 'c_a_0_1', providerChargeId: 'pay_9' }));
      await store.saveCycle(cycle('b', 0, { chargeId: 'c_b_0_1' }));
      expect((await store.findScheduleByChargeId('c_a_0_1'))?.id).toBe('a');
      expect((await store.findScheduleByChargeId('pay_9'))?.id).toBe('a');
      expect((await store.findScheduleByChargeId('c_b_0_1'))?.id).toBe('b');
      expect(await store.findScheduleByChargeId('nope')).toBeUndefined();
      expect(await store.findScheduleByChargeId('')).toBeUndefined();
    });

    it('returns a copy, ignores cycles of a schedule that does not exist, and prefers the most recently created schedule', async () => {
      const store = await make();
      await store.saveSchedule(schedule('old', { createdAt: T0 }));
      await store.saveSchedule(schedule('new', { createdAt: '2026-02-01T00:00:00.000Z' }));
      await store.saveCycle(cycle('old', 0, { chargeId: 'shared' }));
      await store.saveCycle(cycle('new', 0, { chargeId: 'shared' }));
      await store.saveCycle(cycle('ghost', 0, { chargeId: 'ghost_charge' }));
      const found = await store.findScheduleByChargeId('shared');
      expect(found?.id).toBe('new');
      found!.amount = 1;
      expect((await store.findScheduleByChargeId('shared'))?.amount).toBe(100);
      expect(await store.findScheduleByChargeId('ghost_charge')).toBeUndefined();
    });

    it('follows the cycle when its charge id changes (a retry attempt)', async () => {
      const store = await make();
      await store.saveSchedule(schedule('a'));
      await store.saveCycle(cycle('a', 0, { chargeId: 'first' }));
      await store.saveCycle(cycle('a', 0, { chargeId: 'second', attempt: 2 }));
      expect(await store.findScheduleByChargeId('first')).toBeUndefined();
      expect((await store.findScheduleByChargeId('second'))?.id).toBe('a');
    });
  });

  describe(`${name}: locks`, () => {
    it('grants a lock to exactly one of many concurrent callers', async () => {
      const store = await make();
      const tokens = await Promise.all(Array.from({ length: 10 }, () => store.acquireLock('a', 1000)));
      expect(tokens.filter((t) => t !== undefined)).toHaveLength(1);
    });

    it('locks are per schedule id, including ids that do not exist', async () => {
      const store = await make();
      expect(await store.acquireLock('a', 1000)).toBeDefined();
      expect(await store.acquireLock('b', 1000)).toBeDefined();
      expect(await store.acquireLock('a', 1000)).toBeUndefined();
    });

    it('releases only with the right token', async () => {
      const store = await make();
      const token = (await store.acquireLock('a', 1000))!;
      await store.releaseLock('a', 'wrong');
      expect(await store.acquireLock('a', 1000)).toBeUndefined();
      await store.releaseLock('a', token);
      expect(await store.acquireLock('a', 1000)).toBeDefined();
      await store.releaseLock('never-locked', 'x');
    });

    it.runIf(injectableClock)('expires after the ttl, and a stale token cannot release the new holder', async () => {
      let now = 1_000;
      const timed = await make({ now: () => now });
      const first = (await timed.acquireLock('a', 100))!;
      now = 1_099;
      expect(await timed.acquireLock('a', 100)).toBeUndefined();
      now = 1_100;
      const second = (await timed.acquireLock('a', 100))!;
      expect(second).not.toBe(first);

      await timed.releaseLock('a', first);
      expect(await timed.acquireLock('a', 100)).toBeUndefined();
      await timed.releaseLock('a', second);
      expect(await timed.acquireLock('a', 100)).toBeDefined();
    });
  });
}
