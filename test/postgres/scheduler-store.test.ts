import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode, Provider } from '../../src/constants.js';
import { PostgresSchedulerStore } from '../../src/postgres/index.js';
import { CycleStatus, ScheduleStatus } from '../../src/scheduler/index.js';
import { cycle, schedule, schedulerStoreSuite } from '../scheduler/store-suite.js';
import { T0, plusHours } from '../scheduler/helpers.js';
import { describePostgres, sleep, useDatabase } from './helpers.js';

describePostgres('PostgresSchedulerStore', () => {
  const db = useDatabase();
  const store = () => new PostgresSchedulerStore(db.pool, db.options);

  // The shared suite, against a real database. Lock expiry is the database's, so the suite's injected-clock test is
  // replaced by the expiry tests below.
  schedulerStoreSuite(
    'PostgresSchedulerStore',
    async () => {
      await db.reset();
      return store();
    },
    { injectableClock: false },
  );

  describe('instants', () => {
    it('returns the exact ISO strings that were stored, offsets and sub-millisecond digits included', async () => {
      await db.reset();
      const s = store();
      const record = schedule('a', {
        nextActionAt: '2026-01-15T10:00:00.123456+05:30',
        createdAt: '2026-01-01T05:30:00.000+05:30',
        anchorAt: '2026-01-15T04:30:00Z',
      });
      await s.saveSchedule(record);
      expect(await s.getSchedule('a')).toEqual(record);
    });

    it('compares instants in the database: an offset instant is due when its UTC instant is', async () => {
      await db.reset();
      const s = store();
      // 10:00 IST is 04:30 UTC.
      await s.saveSchedule(schedule('ist', { nextActionAt: '2026-01-15T10:00:00+05:30' }));
      await s.saveSchedule(schedule('utc', { nextActionAt: '2026-01-15T04:31:00.000Z' }));
      expect((await s.listDueSchedules('2026-01-15T04:30:00.000Z', 10)).map((x) => x.id)).toEqual(['ist']);
      expect((await s.listDueSchedules('2026-01-15T10:01:00+05:30', 10)).map((x) => x.id)).toEqual(['ist', 'utc']);
      // Sorting is by instant, not by string: the offset string sorts after the UTC one as text.
      await s.saveSchedule(schedule('late-ist', { nextActionAt: '2026-01-15T11:00:00+05:30' }));
      expect((await s.listDueSchedules('2027-01-01T00:00:00Z', 10)).map((x) => x.id)).toEqual(['ist', 'utc', 'late-ist']);
    });

    it('breaks ties between equal instants by id, and treats a limit of zero or less as nothing', async () => {
      await db.reset();
      const s = store();
      for (const id of ['c', 'a', 'b']) await s.saveSchedule(schedule(id, { nextActionAt: T0 }));
      expect((await s.listDueSchedules(T0, 10)).map((x) => x.id)).toEqual(['a', 'b', 'c']);
      expect(await s.listDueSchedules(T0, 0)).toEqual([]);
      expect(await s.listDueSchedules(T0, -5)).toEqual([]);
    });

    it('rejects an invalid instant before it reaches the database', async () => {
      await expect(store().listDueSchedules('soon', 1)).rejects.toMatchObject({ code: ErrorCode.Validation });
    });
  });

  describe('records', () => {
    it('refuses to store a record that does not match the schema', async () => {
      await expect(store().saveSchedule({ ...schedule('x'), amount: -1 })).rejects.toMatchObject({ code: ErrorCode.Validation });
      await expect(store().saveCycle({ ...cycle('x', 0), status: 'bogus' as never })).rejects.toMatchObject({ code: ErrorCode.Validation });
    });

    it('fails loudly on a stored row that no longer matches the schema', async () => {
      await db.reset();
      await db.pool.query(
        `INSERT INTO "${db.schema}"."india_subscriptions_schedules" (id, provider, subscription_id, created_at, record)
         VALUES ('broken', 'payu', 's', now(), '{"id":"broken"}')`,
      );
      await expect(store().getSchedule('broken')).rejects.toMatchObject({ code: ErrorCode.Internal });
    });

    it('is a replace: a saved schedule keeps nothing of the one before, and its indexed columns follow', async () => {
      await db.reset();
      const s = store();
      await s.saveSchedule(schedule('a', { nextActionAt: T0, createdAt: T0, metadata: { k: 'v' } }));
      await s.saveSchedule(schedule('a', { createdAt: plusHours(T0, 1), subscriptionId: 'renamed' }));
      expect(await s.getSchedule('a')).toEqual(schedule('a', { createdAt: plusHours(T0, 1), subscriptionId: 'renamed' }));
      expect(await s.listDueSchedules(plusHours(T0, 9), 10)).toEqual([]);
      expect((await s.findBySubscriptionId(Provider.PayU, 'renamed'))?.id).toBe('a');
      expect(await s.findBySubscriptionId(Provider.PayU, 'sub_a')).toBeUndefined();
      const { rows } = await db.pool.query(`SELECT created_at FROM "${db.schema}"."india_subscriptions_schedules"`);
      expect(new Date(rows[0].created_at).toISOString()).toBe(plusHours(T0, 1));
    });

    it('survives concurrent saves of different schedules and cycles', async () => {
      await db.reset();
      const s = store();
      await Promise.all(
        Array.from({ length: 30 }, (_, i) => Promise.all([s.saveSchedule(schedule(`s${i}`)), s.saveCycle(cycle(`s${i}`, 0)), s.saveCycle(cycle(`s${i}`, 1))])),
      );
      expect(await s.listDueSchedules(T0, 100)).toHaveLength(0);
      expect(await s.listCycles('s7')).toHaveLength(2);
      expect((await s.getSchedule('s29'))?.status).toBe(ScheduleStatus.Active);
      expect((await s.getCycle('s3', 1))?.status).toBe(CycleStatus.Pending);
    });
  });

  describe('the lock', () => {
    afterEach(() => vi.useRealTimers());

    it('of many concurrent callers on separate connections exactly one wins, every time', async () => {
      for (let round = 0; round < 5; round += 1) {
        await db.reset();
        const stores = db.separateConnections(24).map((pool) => new PostgresSchedulerStore(pool, db.options));
        const tokens = await Promise.all(stores.map((s) => s.acquireLock(`race-${round}`, 30_000)));
        expect(tokens.filter((token) => token !== undefined)).toHaveLength(1);
      }
    });

    it('lets one caller take a lock that has expired, even when many race for it', async () => {
      await db.reset();
      const first = (await store().acquireLock('k', 60_000))!;
      expect(first).toBeDefined();
      await db.pool.query(`UPDATE "${db.schema}"."india_subscriptions_schedule_locks" SET expires_at = clock_timestamp() - interval '1 second'`);
      const stores = db.separateConnections(24).map((pool) => new PostgresSchedulerStore(pool, db.options));
      const tokens = await Promise.all(stores.map((s) => s.acquireLock('k', 60_000)));
      expect(tokens.filter((token) => token !== undefined)).toHaveLength(1);
      expect(tokens.find((token) => token !== undefined)).not.toBe(first);
    });

    it('expires after the ttl on the real clock, and the stale token cannot release the new holder', async () => {
      await db.reset();
      const s = store();
      const first = (await s.acquireLock('k', 400))!;
      expect(await s.acquireLock('k', 400)).toBeUndefined();
      await sleep(550);
      const second = (await s.acquireLock('k', 60_000))!;
      expect(second).toBeDefined();
      expect(second).not.toBe(first);
      await s.releaseLock('k', first);
      expect(await s.acquireLock('k', 60_000)).toBeUndefined();
      await s.releaseLock('k', second);
      expect(await s.acquireLock('k', 60_000)).toBeDefined();
    });

    it('does not release a lock for an unknown token, and releasing nothing is not an error', async () => {
      await db.reset();
      const s = store();
      const token = (await s.acquireLock('k', 60_000))!;
      await s.releaseLock('k', 'not-the-token');
      await s.releaseLock('other', token);
      expect(await s.acquireLock('k', 60_000)).toBeUndefined();
      await expect(s.releaseLock('never', 'x')).resolves.toBeUndefined();
    });

    it('judges expiry on the database clock: a process whose own clock is wrong does not change who holds the lock', async () => {
      await db.reset();
      const s = store();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2100-01-01T00:00:00Z'));
      const token = (await s.acquireLock('k', 60_000))!;
      expect(token).toBeDefined();
      // This process now believes it is 1990: the lock must still be held, and another process on a sane clock agrees.
      vi.setSystemTime(new Date('1990-01-01T00:00:00Z'));
      expect(await s.acquireLock('k', 60_000)).toBeUndefined();
      vi.useRealTimers();
      expect(await new PostgresSchedulerStore(db.separatePool(), db.options).acquireLock('k', 60_000)).toBeUndefined();
      // And a lock that expired in the database is free whatever this process believes.
      await db.pool.query(`UPDATE "${db.schema}"."india_subscriptions_schedule_locks" SET expires_at = clock_timestamp() - interval '1 millisecond'`);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('1970-01-01T00:00:00Z'));
      expect(await s.acquireLock('k', 60_000)).toBeDefined();
    });

    it('rejects a ttl that is not a positive number', async () => {
      await expect(store().acquireLock('k', 0)).rejects.toMatchObject({ code: ErrorCode.Validation });
      await expect(store().acquireLock('k', Number.NaN)).rejects.toMatchObject({ code: ErrorCode.Validation });
    });

    it('still grants exactly one lock when the pool runs at REPEATABLE READ', async () => {
      await db.reset();
      const options = { options: '-c default_transaction_isolation=repeatable\\ read' };
      const stores = Array.from({ length: 20 }, () => new PostgresSchedulerStore(db.separatePool({ max: 1, ...options }), db.options));
      const tokens = await Promise.all(stores.map((s) => s.acquireLock('rr', 30_000)));
      expect(tokens.filter((token) => token !== undefined)).toHaveLength(1);
      // Now expired: the concurrent takeover is a serialization failure for the losers, which means "held".
      await db.pool.query(`UPDATE "${db.schema}"."india_subscriptions_schedule_locks" SET expires_at = clock_timestamp() - interval '1 second'`);
      const again = await Promise.all(stores.map((s) => s.acquireLock('rr', 30_000)));
      expect(again.filter((token) => token !== undefined)).toHaveLength(1);
    });
  });

  describe('errors', () => {
    it('says what to do when the tables are missing, and never puts the statement or its values in the message', async () => {
      const missing = new PostgresSchedulerStore(db.pool, { schema: db.schema, tablePrefix: 'nothing_here_' });
      const error = await missing.getSchedule('secret-customer-id').catch((e: unknown) => e);
      expect(error).toMatchObject({ code: ErrorCode.Config });
      expect((error as Error).message).toContain('migratePostgres');
      expect((error as Error).message).not.toContain('secret-customer-id');
    });
  });
});
