import { beforeEach, describe, expect, it } from 'vitest';
import { ChargeStatus, Currency, IntervalUnit, Provider } from '../../src/constants.js';
import {
  CycleStatus,
  MemorySchedulerStore,
  ScheduleStatus,
  type CycleRecord,
  type ScheduleRecord,
} from '../../src/scheduler/index.js';
import { T0, plusHours } from './helpers.js';

function schedule(id: string, overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
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

function cycle(scheduleId: string, index: number): CycleRecord {
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
  };
}

describe('MemorySchedulerStore', () => {
  let store: MemorySchedulerStore;
  beforeEach(() => {
    store = new MemorySchedulerStore();
  });

  it('copies records in and out', async () => {
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
    expect(await store.getSchedule('nope')).toBeUndefined();
    expect(await store.getCycle('nope', 0)).toBeUndefined();
    expect(await store.listCycles('nope')).toEqual([]);
    expect(await store.findBySubscriptionId(Provider.PayU, 'nope')).toBeUndefined();
  });

  it('lists due schedules at or before an instant, oldest first, up to the limit', async () => {
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
    await store.saveSchedule(schedule('a', { nextActionAt: T0 }));
    expect(await store.listDueSchedules(T0, 10)).toHaveLength(1);
    const { nextActionAt: _removed, ...without } = schedule('a');
    await store.saveSchedule(without);
    expect(await store.listDueSchedules(T0, 10)).toHaveLength(0);
  });

  it('finds a schedule by provider and current subscription id, preferring the newest', async () => {
    await store.saveSchedule(schedule('old', { subscriptionId: 'shared', createdAt: T0 }));
    await store.saveSchedule(schedule('new', { subscriptionId: 'shared', createdAt: plusHours(T0, 1) }));
    await store.saveSchedule(schedule('other', { subscriptionId: 'shared', provider: Provider.Cashfree }));
    expect((await store.findBySubscriptionId(Provider.PayU, 'shared'))?.id).toBe('new');
    expect((await store.findBySubscriptionId(Provider.Cashfree, 'shared'))?.id).toBe('other');

    await store.saveSchedule(schedule('new', { subscriptionId: 'renamed', createdAt: plusHours(T0, 1) }));
    expect((await store.findBySubscriptionId(Provider.PayU, 'shared'))?.id).toBe('old');
  });

  it('lists cycles of one schedule ordered by index', async () => {
    await store.saveCycle(cycle('a', 2));
    await store.saveCycle(cycle('a', 0));
    await store.saveCycle(cycle('b', 0));
    await store.saveCycle(cycle('a', 1));
    expect((await store.listCycles('a')).map((c) => c.index)).toEqual([0, 1, 2]);
    expect(await store.listCycles('b')).toHaveLength(1);
  });

  it('upserts a cycle by (scheduleId, index)', async () => {
    await store.saveCycle(cycle('a', 0));
    await store.saveCycle({ ...cycle('a', 0), status: CycleStatus.Succeeded });
    expect(await store.listCycles('a')).toHaveLength(1);
    expect((await store.getCycle('a', 0))?.status).toBe(CycleStatus.Succeeded);
  });

  describe('locks', () => {
    it('grants a lock to exactly one of many concurrent callers', async () => {
      const tokens = await Promise.all(Array.from({ length: 10 }, () => store.acquireLock('a', 1000)));
      expect(tokens.filter((t) => t !== undefined)).toHaveLength(1);
    });

    it('locks are per schedule id, including ids that do not exist', async () => {
      expect(await store.acquireLock('a', 1000)).toBeDefined();
      expect(await store.acquireLock('b', 1000)).toBeDefined();
      expect(await store.acquireLock('a', 1000)).toBeUndefined();
    });

    it('releases only with the right token', async () => {
      const token = (await store.acquireLock('a', 1000))!;
      await store.releaseLock('a', 'wrong');
      expect(await store.acquireLock('a', 1000)).toBeUndefined();
      await store.releaseLock('a', token);
      expect(await store.acquireLock('a', 1000)).toBeDefined();
      await store.releaseLock('never-locked', 'x');
    });

    it('expires after the ttl, and a stale token cannot release the new holder', async () => {
      let now = 1_000;
      const timed = new MemorySchedulerStore({ now: () => now });
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
});
