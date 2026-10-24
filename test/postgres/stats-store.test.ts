import { describe, expect, it } from 'vitest';
import { ErrorCode, PaymentMethod, Provider } from '../../src/constants.js';
import { PostgresRoutingStatsStore } from '../../src/postgres/index.js';
import { RouteOutcomeKind, RouteOutcomeResult, type RoutingStatsKey } from '../../src/routing/index.js';
import { HOUR, T0 } from '../routing/helpers.js';
import { describePostgres, useDatabase } from './helpers.js';

const { Success, Failure, Unavailable } = RouteOutcomeResult;
const KEY: RoutingStatsKey = { provider: Provider.Razorpay, kind: RouteOutcomeKind.Authorization };
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const ZERO = { success: 0, failure: 0, unavailable: 0 };

// The cases of `MemoryRoutingStatsStore` that every `RoutingStatsStore` must keep (test/routing/stats-store.test.ts),
// plus what only a real database shows.
describePostgres('PostgresRoutingStatsStore', () => {
  const db = useDatabase();
  const make = async (retentionHours?: number) => {
    await db.reset();
    return new PostgresRoutingStatsStore(db.pool, { ...db.options, ...(retentionHours === undefined ? {} : { retentionHours }) });
  };

  it('returns zeros for a key nobody wrote', async () => {
    expect(await (await make()).read(KEY, at(-HOUR))).toEqual(ZERO);
  });

  it('adds up increments by result', async () => {
    const store = await make();
    await store.increment(KEY, Success, at(0));
    await store.increment(KEY, Success, at(1000));
    await store.increment(KEY, Failure, at(2000));
    await store.increment(KEY, Unavailable, at(3000));
    expect(await store.read(KEY, at(-HOUR))).toEqual({ success: 2, failure: 1, unavailable: 1 });
  });

  it('keeps keys apart: provider, kind and payment method, and the gateway-wide series is not derived', async () => {
    const store = await make();
    await store.increment(KEY, Success, at(0));
    await store.increment({ ...KEY, paymentMethod: PaymentMethod.Upi }, Failure, at(0));
    await store.increment({ ...KEY, kind: RouteOutcomeKind.Charge }, Failure, at(0));
    await store.increment({ ...KEY, provider: Provider.Cashfree }, Failure, at(0));
    expect(await store.read(KEY, at(-HOUR))).toEqual({ success: 1, failure: 0, unavailable: 0 });
    expect(await store.read({ ...KEY, paymentMethod: PaymentMethod.Upi }, at(-HOUR))).toEqual({ success: 0, failure: 1, unavailable: 0 });
    expect(await store.read({ ...KEY, paymentMethod: PaymentMethod.Card }, at(-HOUR))).toEqual(ZERO);
  });

  it('puts observations into hourly UTC buckets and reads whole buckets from the hour of `since`', async () => {
    const store = await make();
    await store.increment(KEY, Success, '2026-11-22T08:59:59.999Z');
    await store.increment(KEY, Success, '2026-11-22T09:00:00.000Z');
    await store.increment(KEY, Success, '2026-11-22T09:30:00.000Z');
    for (let i = 0; i < 4; i += 1) await store.increment(KEY, Success, '2026-11-22T10:05:00.000Z');

    expect((await store.read(KEY, '2026-11-22T08:00:00.000Z')).success).toBe(7);
    expect((await store.read(KEY, '2026-11-22T08:30:00.000Z')).success).toBe(7);
    expect((await store.read(KEY, '2026-11-22T09:00:00.000Z')).success).toBe(6);
    expect((await store.read(KEY, '2026-11-22T09:59:59.000Z')).success).toBe(6);
    expect((await store.read(KEY, '2026-11-22T10:00:00.000Z')).success).toBe(4);
    expect((await store.read(KEY, '2026-11-22T11:00:00.000Z')).success).toBe(0);
  });

  it('reads an offset instant as the instant it is', async () => {
    const store = await make();
    await store.increment(KEY, Success, '2026-11-22T16:00:00+05:30'); // 10:30Z, bucket 10:00Z
    expect((await store.read(KEY, '2026-11-22T10:00:00.000Z')).success).toBe(1);
    expect((await store.read(KEY, '2026-11-22T11:00:00.000Z')).success).toBe(0);
    const { rows } = await db.pool.query(`SELECT bucket FROM "${db.schema}"."india_subscriptions_routing_stats"`);
    expect(new Date(rows[0].bucket).toISOString()).toBe('2026-11-22T10:00:00.000Z');
  });

  it('accepts an increment for an instant in the past, in any order', async () => {
    const store = await make();
    await store.increment(KEY, Success, at(0));
    await store.increment(KEY, Failure, at(-5 * HOUR));
    expect(await store.read(KEY, at(-6 * HOUR))).toEqual({ success: 1, failure: 1, unavailable: 0 });
    expect(await store.read(KEY, at(-HOUR))).toEqual({ success: 1, failure: 0, unavailable: 0 });
  });

  it('returns a copy the caller may change', async () => {
    const store = await make();
    await store.increment(KEY, Success, at(0));
    const first = await store.read(KEY, at(-HOUR));
    first.success = 99;
    expect((await store.read(KEY, at(-HOUR))).success).toBe(1);
  });

  it('rejects an invalid instant', async () => {
    const store = await make();
    await expect(store.increment(KEY, Success, 'soon')).rejects.toMatchObject({ code: ErrorCode.Validation });
    await expect(store.read(KEY, 'soon')).rejects.toMatchObject({ code: ErrorCode.Validation });
  });

  describe('atomic counters', () => {
    it('loses no increment when many connections add to one bucket at once', async () => {
      await make();
      const stores = db.separateConnections(20).map((pool) => new PostgresRoutingStatsStore(pool, db.options));
      await Promise.all(
        stores.flatMap((store) => Array.from({ length: 25 }, (_, i) => store.increment(KEY, i % 5 === 0 ? Failure : Success, at(0)))),
      );
      expect(await stores[0]!.read(KEY, at(-HOUR))).toEqual({ success: 400, failure: 100, unavailable: 0 });
      const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM "${db.schema}"."india_subscriptions_routing_stats"`);
      expect(rows[0].n).toBe(1);
    });

    it('counts past the 32-bit range as numbers', async () => {
      const store = await make();
      await store.increment(KEY, Success, at(0));
      await db.pool.query(`UPDATE "${db.schema}"."india_subscriptions_routing_stats" SET success = 5000000000`);
      await store.increment(KEY, Success, at(0));
      expect((await store.read(KEY, at(-HOUR))).success).toBe(5_000_000_001);
    });
  });

  describe('retention', () => {
    it('deletes buckets older than the retention on the database clock, and keeps the rest', async () => {
      const store = await make(30);
      const now = Date.now();
      await store.increment(KEY, Success, new Date(now - 40 * HOUR).toISOString());
      await store.increment(KEY, Success, new Date(now - 20 * HOUR).toISOString());
      await store.increment(KEY, Success, new Date(now).toISOString());
      // `increment` pruned at most once per process; prune explicitly to be sure.
      await store.prune();
      expect((await store.read(KEY, new Date(now - 100 * HOUR).toISOString())).success).toBe(2);
      expect(await store.prune()).toBe(0);
    });

    it('refuses a retention shorter than the router window plus its rounding', async () => {
      expect(() => new PostgresRoutingStatsStore(db.pool, { ...db.options, retentionHours: 24 })).toThrow(expect.objectContaining({ code: ErrorCode.Config }));
    });
  });
});
