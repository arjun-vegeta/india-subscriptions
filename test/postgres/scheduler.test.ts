import { describe, expect, it } from 'vitest';
import { BillingScheduler, CycleStatus, ScheduleStatus, scheduleIdFor, type TickResult } from '../../src/scheduler/index.js';
import { PostgresSchedulerStore } from '../../src/postgres/index.js';
import { Provider } from '../../src/constants.js';
import { DUE, FakeClock, FakeProvider, Style, plusHours, registration } from '../scheduler/helpers.js';
import { describePostgres, useDatabase } from './helpers.js';

describePostgres('BillingScheduler on PostgresSchedulerStore', () => {
  const db = useDatabase();

  /** Two workers, each with its own connections and its own store object, sharing the database and the gateway. */
  const workers = (provider: FakeProvider, clock: FakeClock, count = 2): BillingScheduler[] =>
    db.separateConnections(count).map(
      (pool) =>
        new BillingScheduler({
          store: new PostgresSchedulerStore(pool, db.options),
          resolveProvider: () => provider,
          now: clock.now,
        }),
    );

  const sum = (results: TickResult[], field: 'charged' | 'locked' | 'succeeded'): number =>
    results.reduce((total, result) => total + result[field], 0);

  it('two workers ticking at the same moment raise exactly one debit per schedule', async () => {
    await db.reset();
    const clock = new FakeClock(plusHours(DUE, 0));
    const provider = new FakeProvider({ style: Style.OnDue });
    provider.createDelayMs = 40; // keep each debit in flight long enough for the workers to collide
    const [a, b] = workers(provider, clock);
    const count = 12;
    for (let i = 0; i < count; i += 1) await a!.register(registration({ subscriptionId: `sub_${i}`, reference: `ref_${i}` }));

    const results = await Promise.all([a!.tick(), b!.tick()]);

    expect(provider.createCalls).toHaveLength(count);
    expect(new Set(provider.createCalls.map((call) => call.chargeId)).size).toBe(count);
    expect(sum(results, 'charged')).toBe(count);
    // The workers did collide: what one held, the other found locked and left alone.
    expect(sum(results, 'locked')).toBeGreaterThan(0);
    for (let i = 0; i < count; i += 1) {
      const cycle = await new PostgresSchedulerStore(db.pool, db.options).getCycle(scheduleIdFor(Provider.PayU, `ref_${i}`), 0);
      expect(cycle?.status).toBe(CycleStatus.Succeeded);
    }
  });

  it('keeps it to one debit per cycle over several billing periods with both workers ticking every time', async () => {
    await db.reset();
    const clock = new FakeClock(DUE);
    const provider = new FakeProvider({ style: Style.OnDue });
    provider.createDelayMs = 15;
    const [a, b, c] = workers(provider, clock, 3);
    const subscriptions = 5;
    for (let i = 0; i < subscriptions; i += 1) await a!.register(registration({ subscriptionId: `sub_${i}`, reference: `ref_${i}` }));

    const periods = 3;
    for (let period = 0; period < periods; period += 1) {
      // Each month's due date, ticked by all workers at once, twice (a second round must find nothing to do).
      clock.set(new Date(Date.parse(DUE) + period * 31 * 24 * 3600 * 1000).toISOString());
      await Promise.all([a!.tick(), b!.tick(), c!.tick()]);
      await Promise.all([a!.tick(), b!.tick(), c!.tick()]);
    }

    expect(provider.createCalls).toHaveLength(subscriptions * periods);
    expect(new Set(provider.createCalls.map((call) => call.chargeId)).size).toBe(subscriptions * periods);
    const store = new PostgresSchedulerStore(db.pool, db.options);
    for (let i = 0; i < subscriptions; i += 1) {
      const id = scheduleIdFor(Provider.PayU, `ref_${i}`);
      const cycles = await store.listCycles(id);
      expect(cycles.filter((cycle) => cycle.status === CycleStatus.Succeeded)).toHaveLength(periods);
      expect((await store.getSchedule(id))?.paidCycles).toBe(periods);
      expect((await store.getSchedule(id))?.status).toBe(ScheduleStatus.Active);
    }
  });

  it('a worker that took the lock and died does not block the schedule once the lock expires', async () => {
    await db.reset();
    const clock = new FakeClock(DUE);
    const provider = new FakeProvider({ style: Style.OnDue });
    const [alive] = workers(provider, clock, 1);
    await alive!.register(registration());
    const store = new PostgresSchedulerStore(db.pool, db.options);
    const id = scheduleIdFor(Provider.PayU, 'sub_1');
    // A crashed worker's lock: held, with the database saying it ended a second ago.
    await store.acquireLock(id, 60_000);
    expect((await alive!.tick()).charged).toBe(0);
    expect(provider.createCalls).toHaveLength(0);
    await db.pool.query(`UPDATE "${db.schema}"."india_subscriptions_schedule_locks" SET expires_at = clock_timestamp() - interval '1 second'`);
    expect((await alive!.tick()).charged).toBe(1);
    expect(provider.createCalls).toHaveLength(1);
  });
});
