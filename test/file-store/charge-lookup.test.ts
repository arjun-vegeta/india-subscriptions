import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Currency, IntervalUnit, Provider } from '../../src/constants.js';
import { CycleStatus, MemorySchedulerStore, ScheduleStatus, type CycleRecord, type ScheduleRecord, type SchedulerStore } from '../../src/scheduler/index.js';
import { FileSchedulerStore } from '../../src/scheduler-file-store.js';

const T0 = '2026-01-01T00:00:00.000Z';

function schedule(id: string, createdAt = T0): ScheduleRecord {
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
    createdAt,
    updatedAt: createdAt,
  };
}

function cycle(scheduleId: string, index: number, over: Partial<CycleRecord> = {}): CycleRecord {
  return {
    scheduleId,
    index,
    status: CycleStatus.Charging,
    dueAt: T0,
    attemptDueAt: T0,
    attempt: 1,
    notificationRound: 1,
    attempts: [],
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'india-subscriptions-charge-lookup-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const stores: Array<[string, (dir: string) => Promise<SchedulerStore>]> = [
  ['MemorySchedulerStore', async () => new MemorySchedulerStore()],
  ['FileSchedulerStore', async (where) => FileSchedulerStore.open(join(where, 'store.json'))],
];

describe.each(stores)('%s.findScheduleByChargeId', (_name, open) => {
  it('finds the schedule by the merchant charge id or the gateway charge id of one of its cycles, and by nothing else', async () => {
    const store = await open(dir);
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
    const store = await open(dir);
    await store.saveSchedule(schedule('old', T0));
    await store.saveSchedule(schedule('new', '2026-02-01T00:00:00.000Z'));
    await store.saveCycle(cycle('old', 0, { chargeId: 'shared' }));
    await store.saveCycle(cycle('new', 0, { chargeId: 'shared' }));
    await store.saveCycle(cycle('ghost', 0, { chargeId: 'ghost_charge' }));
    const found = await store.findScheduleByChargeId('shared');
    expect(found?.id).toBe('new');
    (found as ScheduleRecord).amount = 1;
    expect((await store.findScheduleByChargeId('shared'))?.amount).toBe(100);
    expect(await store.findScheduleByChargeId('ghost_charge')).toBeUndefined();
  });

  it('follows the cycle when its charge id changes (a retry attempt)', async () => {
    const store = await open(dir);
    await store.saveSchedule(schedule('a'));
    await store.saveCycle(cycle('a', 0, { chargeId: 'first' }));
    await store.saveCycle(cycle('a', 0, { chargeId: 'second', attempt: 2 }));
    expect(await store.findScheduleByChargeId('first')).toBeUndefined();
    expect((await store.findScheduleByChargeId('second'))?.id).toBe('a');
  });
});
