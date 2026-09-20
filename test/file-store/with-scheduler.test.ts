import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BillingScheduler, CycleStatus, ScheduleStatus, scheduleIdFor } from '../../src/scheduler/index.js';
import { Provider } from '../../src/constants.js';
import { FileSchedulerStore } from '../../src/scheduler-file-store.js';
import { DUE, FakeClock, FakeProvider, plusHours, registration } from '../scheduler/helpers.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'india-subscriptions-sched-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('BillingScheduler on a FileSchedulerStore', () => {
  it('survives a restart between the notification and the debit, and debits exactly once', async () => {
    const path = join(dir, 'state.json');
    const clock = new FakeClock();
    const provider = new FakeProvider();
    const build = async (): Promise<BillingScheduler> =>
      new BillingScheduler({
        store: await FileSchedulerStore.open(path),
        resolveProvider: () => provider,
        now: clock.now,
      });

    const first = await build();
    await first.register(registration());
    clock.set(plusHours(DUE, -48));
    expect((await first.tick()).notified).toBe(1);

    // The process dies here; a new one starts from the file alone.
    const second = await build();
    const id = scheduleIdFor(Provider.PayU, 'sub_1');
    expect((await second.get(id))?.status).toBe(ScheduleStatus.Active);
    expect(provider.notifyCalls).toHaveLength(1);

    clock.set(DUE);
    expect((await second.tick()).charged).toBe(1);
    expect(provider.createCalls).toHaveLength(1);

    // A third start does not raise the debit again.
    const third = await build();
    clock.set(plusHours(DUE, 1));
    await third.tick();
    expect(provider.createCalls).toHaveLength(1);
    const store = await FileSchedulerStore.open(path);
    expect((await store.getCycle(id, 0))?.status).not.toBe(CycleStatus.Pending);
  });
});
