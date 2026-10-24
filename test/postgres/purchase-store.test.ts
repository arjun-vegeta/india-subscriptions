import { describe, expect, it } from 'vitest';
import { ErrorCode, Provider } from '../../src/constants.js';
import { PostgresPurchaseStore } from '../../src/postgres/index.js';
import { ReportStatus, SessionStatus, type ReportRecord } from '../../src/purchase/index.js';
import { MINUTE, T0 } from '../purchase/helpers.js';
import { entitlement, purchaseStoreSuite, report, session } from '../purchase/store-suite.js';
import { describePostgres, useDatabase } from './helpers.js';

const at = (offsetMs: number): string => new Date(Date.parse(T0) + offsetMs).toISOString();

describePostgres('PostgresPurchaseStore', () => {
  const db = useDatabase();
  const store = () => new PostgresPurchaseStore(db.pool, db.options);

  purchaseStoreSuite(
    'PostgresPurchaseStore',
    async () => {
      await db.reset();
      return store();
    },
    { injectableClock: false },
  );

  describe('the report outbox across workers', () => {
    it('of many concurrent enqueues of one id exactly one is stored', async () => {
      await db.reset();
      const stores = db.separateConnections(20).map((pool) => new PostgresPurchaseStore(pool, db.options));
      const results = await Promise.all(stores.map((s, i) => s.enqueueReport(report({ id: 'same', attempts: i }))));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await store().getReport('same')).toMatchObject({ id: 'same' });
    });

    it('concurrent claims on separate connections never return the same report, and between them return every report', async () => {
      await db.reset();
      const total = 120;
      for (let i = 0; i < total; i += 1) {
        await store().enqueueReport(report({ id: `r${String(i).padStart(3, '0')}`, dueBy: at(i * 1000 + 24 * 60 * MINUTE) }));
      }
      const workers = db.separateConnections(12).map((pool) => new PostgresPurchaseStore(pool, db.options));
      const claimedBy = await Promise.all(
        workers.map(async (worker) => {
          const mine: ReportRecord[] = [];
          for (;;) {
            const batch = await worker.claimDueReports(T0, 7, 5 * MINUTE);
            if (batch.length === 0) return mine;
            mine.push(...batch);
          }
        }),
      );
      const ids = claimedBy.flat().map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(total);
      // Every claimed copy carries its own token and the lease end, and the stored rows agree with it.
      for (const claimed of claimedBy.flat()) {
        expect(claimed.leaseUntil).toBe(at(5 * MINUTE));
        expect((await store().getReport(claimed.id))?.leaseToken).toBe(claimed.leaseToken);
      }
    });

    it('one claim, started while another is still running, skips what the other holds', async () => {
      await db.reset();
      for (let i = 0; i < 10; i += 1) await store().enqueueReport(report({ id: `r${i}` }));
      // Hold a row lock on r0..r4 in an open transaction, as a slow concurrent claimer would.
      const holder = await db.pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(
          `SELECT id FROM "${db.schema}"."india_subscriptions_reports" WHERE id = ANY($1) ORDER BY id FOR UPDATE`,
          [['r0', 'r1', 'r2', 'r3', 'r4']],
        );
        // A claim that waited for the held rows would hit this timeout instead of returning.
        const impatient = new PostgresPurchaseStore(db.separatePool({ max: 1, options: '-c lock_timeout=2000' }), db.options);
        const claimed = await impatient.claimDueReports(T0, 10, MINUTE);
        expect(claimed.map((r) => r.id).sort()).toEqual(['r5', 'r6', 'r7', 'r8', 'r9']);
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
      expect((await store().claimDueReports(T0, 10, MINUTE)).map((r) => r.id).sort()).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
    });

    it('a lease that ends makes the report claimable again, with a new token', async () => {
      await db.reset();
      await store().enqueueReport(report());
      const [first] = await store().claimDueReports(T0, 1, 5 * MINUTE);
      expect(await store().claimDueReports(at(5 * MINUTE - 1), 1, 5 * MINUTE)).toEqual([]);
      const [second] = await store().claimDueReports(at(5 * MINUTE), 1, 5 * MINUTE);
      expect(second?.id).toBe('ext_1');
      expect(second?.leaseToken).not.toBe(first?.leaseToken);
      expect(second?.leaseUntil).toBe(at(10 * MINUTE));
    });

    it('saving with a stale lease token does not overwrite the newer claim', async () => {
      await db.reset();
      const s = store();
      await s.enqueueReport(report());
      const [slow] = await s.claimDueReports(T0, 1, MINUTE);
      // The slow claimer stalls; its lease ends and another worker claims the report.
      const [fast] = await s.claimDueReports(at(2 * MINUTE), 1, MINUTE);
      expect(fast?.leaseToken).not.toBe(slow?.leaseToken);

      const lateSave = await s.saveReport({ ...slow!, status: ReportStatus.Sent, leaseToken: undefined, leaseUntil: undefined }, slow!.leaseToken as string);
      expect(lateSave).toBe(false);
      const stored = await s.getReport('ext_1');
      expect(stored?.status).toBe(ReportStatus.Queued);
      expect(stored?.leaseToken).toBe(fast?.leaseToken);

      expect(await s.saveReport({ ...fast!, status: ReportStatus.Sent, leaseToken: undefined, leaseUntil: undefined }, fast!.leaseToken as string)).toBe(true);
      expect((await s.getReport('ext_1'))?.status).toBe(ReportStatus.Sent);
      expect((await s.getReport('ext_1'))?.leaseToken).toBeUndefined();
    });

    it('a lease that ran out but was not taken by anyone can still be saved (the interface asks only for the holder\'s token)', async () => {
      await db.reset();
      const s = store();
      await s.enqueueReport(report());
      const [claimed] = await s.claimDueReports(T0, 1, MINUTE);
      const saved = { ...claimed!, status: ReportStatus.Queued, attempts: 1, leaseToken: undefined, leaseUntil: undefined };
      expect(await s.saveReport(saved, claimed!.leaseToken as string)).toBe(true);
      // The lease is cleared, so the report is claimable straight away.
      expect(await s.claimDueReports(T0, 1, MINUTE)).toHaveLength(1);
    });

    it('two workers racing to save the same claim: exactly one save wins', async () => {
      await db.reset();
      await store().enqueueReport(report());
      const [claimed] = await store().claimDueReports(T0, 1, MINUTE);
      const savers = db.separateConnections(10).map((pool) => new PostgresPurchaseStore(pool, db.options));
      const results = await Promise.all(
        savers.map((s, i) => s.saveReport({ ...claimed!, status: ReportStatus.Sent, attempts: i + 1, leaseToken: undefined, leaseUntil: undefined }, claimed!.leaseToken as string)),
      );
      // A save clears the lease on the stored row, so once one has won, the token no longer matches for the others.
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('does not hand out a report that is not queued, not yet due, or leased, and counts overdue ones strictly', async () => {
      await db.reset();
      const s = store();
      await s.enqueueReport(report({ id: 'sent', status: ReportStatus.Sent }));
      await s.enqueueReport(report({ id: 'rejected', status: ReportStatus.Rejected }));
      await s.enqueueReport(report({ id: 'future', nextAttemptAt: at(MINUTE) }));
      await s.enqueueReport(report({ id: 'leased', leaseToken: 'x', leaseUntil: at(MINUTE) }));
      await s.enqueueReport(report({ id: 'due', dueBy: at(-1) }));
      expect((await s.claimDueReports(T0, 10, MINUTE)).map((r) => r.id)).toEqual(['due']);
      expect((await s.listOverdueReports(at(-1), 10)).map((r) => r.id)).toEqual([]);
      expect((await s.listOverdueReports(T0, 10)).map((r) => r.id)).toEqual(['due']);
    });

    it('returns the exact instants it was given, and sorts urgent reports by instant, not by string', async () => {
      await db.reset();
      const s = store();
      // 11:00+05:30 is 05:30Z, earlier than 06:00Z although the string sorts later.
      await s.enqueueReport(report({ id: 'a', dueBy: '2026-11-23T06:00:00.000Z' }));
      await s.enqueueReport(report({ id: 'b', dueBy: '2026-11-23T11:00:00+05:30' }));
      const claimed = await s.claimDueReports(T0, 10, MINUTE);
      expect(claimed.map((r) => [r.id, r.dueBy])).toEqual([
        ['b', '2026-11-23T11:00:00+05:30'],
        ['a', '2026-11-23T06:00:00.000Z'],
      ]);
    });

    it('refuses an invalid report and an invalid instant', async () => {
      await expect(store().enqueueReport({ ...report(), attempts: -1 })).rejects.toMatchObject({ code: ErrorCode.Validation });
      await expect(store().claimDueReports('now', 1, MINUTE)).rejects.toMatchObject({ code: ErrorCode.Validation });
    });
  });

  describe('lookups', () => {
    it('finds a session by an option handle through the index, among many sessions', async () => {
      await db.reset();
      const s = store();
      for (let i = 0; i < 50; i += 1) {
        await s.saveSession(
          session({
            id: `ps_${i}`,
            reference: `r${i}`,
            options: [{ channel: 'gateway', provider: Provider.Razorpay, checkout: { kind: 'redirect', url: 'https://pay.example/1' }, handle: `h_${i}` }],
          }),
        );
      }
      expect((await s.findSessionByHandle(Provider.Razorpay, 'h_37'))?.id).toBe('ps_37');
      expect(await s.findSessionByHandle(Provider.Cashfree, 'h_37')).toBeUndefined();
      // A handle that merely contains the separator or looks like another provider's key matches nothing.
      expect(await s.findSessionByHandle(Provider.Razorpay, 'razorpay:h_37')).toBeUndefined();
      // The lookup the store runs can use the index on `option_keys` (a sequential scan is the planner's choice, not a need).
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL enable_seqscan = off');
        const plan = await client.query(
          `EXPLAIN SELECT record FROM "${db.schema}"."india_subscriptions_sessions" WHERE option_keys @> ARRAY['razorpay:h_37']::text[]`,
        );
        expect(plan.rows.map((row) => Object.values(row)[0]).join('\n')).toContain('india_subscriptions_sessions_option_keys_idx');
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    it('follows a session whose options and completion ids change', async () => {
      await db.reset();
      const s = store();
      await s.saveSession(session());
      await s.saveSession(session({ status: SessionStatus.Completed, provider: Provider.Razorpay, subscriptionId: 'sub_real', options: [] }));
      expect(await s.findSessionByHandle(Provider.Razorpay, 'sub_1')).toBeUndefined();
      expect((await s.findSessionByHandle(Provider.Razorpay, 'sub_real'))?.status).toBe(SessionStatus.Completed);
    });

    it('breaks equal updatedAt ties by id for entitlements', async () => {
      await db.reset();
      const s = store();
      await s.saveEntitlement(entitlement({ id: 'ent_b', subscriptionId: 'sub_b' }));
      await s.saveEntitlement(entitlement({ id: 'ent_a', subscriptionId: 'sub_a' }));
      expect((await s.listEntitlements('c1')).map((e) => e.id)).toEqual(['ent_a', 'ent_b']);
    });
  });

  describe('the lock', () => {
    it('of many concurrent callers on separate connections exactly one wins, and an expired lock is taken over', async () => {
      await db.reset();
      const stores = db.separateConnections(24).map((pool) => new PostgresPurchaseStore(pool, db.options));
      const first = await Promise.all(stores.map((s) => s.acquireLock('customer:c1', 30_000)));
      expect(first.filter((token) => token !== undefined)).toHaveLength(1);
      await db.pool.query(`UPDATE "${db.schema}"."india_subscriptions_purchase_locks" SET expires_at = clock_timestamp() - interval '1 second'`);
      const second = await Promise.all(stores.map((s) => s.acquireLock('customer:c1', 30_000)));
      expect(second.filter((token) => token !== undefined)).toHaveLength(1);
      // The first holder's token is stale now and releases nothing.
      const winner = first.find((token) => token !== undefined)!;
      await store().releaseLock('customer:c1', winner);
      expect(await store().acquireLock('customer:c1', 30_000)).toBeUndefined();
    });

    it('scheduler locks and purchase locks are separate', async () => {
      await db.reset();
      expect(await store().acquireLock('same-key', 30_000)).toBeDefined();
      await expect(
        db.pool.query(`SELECT count(*)::int AS n FROM "${db.schema}"."india_subscriptions_schedule_locks"`),
      ).resolves.toMatchObject({ rows: [{ n: 0 }] });
    });
  });
});
