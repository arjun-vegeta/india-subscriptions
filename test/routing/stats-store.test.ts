import { describe, expect, it } from 'vitest';
import { ErrorCode, PaymentMethod, Provider } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import {
  MemoryRoutingStatsStore,
  RouteOutcomeKind,
  RouteOutcomeResult,
  statsBucketStart,
  type RoutingStatsKey,
} from '../../src/routing/index.js';
import { HOUR, T0, caps, makeRouter } from './helpers.js';

const { Success, Failure, Unavailable } = RouteOutcomeResult;
const KEY: RoutingStatsKey = { provider: Provider.Razorpay, kind: RouteOutcomeKind.Authorization };
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const ZERO = { success: 0, failure: 0, unavailable: 0 };

describe('statsBucketStart', () => {
  it('truncates an instant to the start of its UTC hour', () => {
    expect(statsBucketStart('2026-11-22T10:59:59.999Z')).toBe('2026-11-22T10:00:00.000Z');
    expect(statsBucketStart('2026-11-22T10:00:00.000Z')).toBe('2026-11-22T10:00:00.000Z');
  });

  it('reads an offset instant as the instant it is', () => {
    expect(statsBucketStart('2026-11-22T16:00:00+05:30')).toBe('2026-11-22T10:00:00.000Z');
  });

  it('rejects something that is not an instant', () => {
    expect(() => statsBucketStart('yesterday')).toThrow(SubscriptionError);
  });
});

describe('MemoryRoutingStatsStore', () => {
  it('returns zeros for a key nobody wrote', async () => {
    expect(await new MemoryRoutingStatsStore().read(KEY, at(-HOUR))).toEqual(ZERO);
  });

  it('adds up increments by result', async () => {
    const store = new MemoryRoutingStatsStore();
    await store.increment(KEY, Success, at(0));
    await store.increment(KEY, Success, at(1000));
    await store.increment(KEY, Failure, at(2000));
    await store.increment(KEY, Unavailable, at(3000));
    expect(await store.read(KEY, at(-HOUR))).toEqual({ success: 2, failure: 1, unavailable: 1 });
  });

  it('adds concurrent increments without losing any', async () => {
    const store = new MemoryRoutingStatsStore();
    await Promise.all(Array.from({ length: 200 }, () => store.increment(KEY, Success, at(0))));
    expect((await store.read(KEY, at(-HOUR))).success).toBe(200);
  });

  it('keeps keys apart: provider, kind and payment method', async () => {
    const store = new MemoryRoutingStatsStore();
    await store.increment(KEY, Success, at(0));
    await store.increment({ ...KEY, paymentMethod: PaymentMethod.Upi }, Failure, at(0));
    await store.increment({ ...KEY, kind: RouteOutcomeKind.Charge }, Failure, at(0));
    await store.increment({ ...KEY, provider: Provider.Cashfree }, Failure, at(0));
    expect(await store.read(KEY, at(-HOUR))).toEqual({ success: 1, failure: 0, unavailable: 0 });
    expect(await store.read({ ...KEY, paymentMethod: PaymentMethod.Upi }, at(-HOUR))).toEqual({ success: 0, failure: 1, unavailable: 0 });
    expect(await store.read({ ...KEY, paymentMethod: PaymentMethod.Card }, at(-HOUR))).toEqual(ZERO);
  });

  it('puts observations into hourly buckets and reads whole buckets from the hour of `since`', async () => {
    const store = new MemoryRoutingStatsStore();
    // Buckets: 08:00 (1), 09:00 (2), 10:00 (4)
    await store.increment(KEY, Success, '2026-11-22T08:59:59.999Z');
    await store.increment(KEY, Success, '2026-11-22T09:00:00.000Z');
    await store.increment(KEY, Success, '2026-11-22T09:30:00.000Z');
    for (let i = 0; i < 4; i += 1) await store.increment(KEY, Success, '2026-11-22T10:05:00.000Z');

    expect((await store.read(KEY, '2026-11-22T08:00:00.000Z')).success).toBe(7);
    expect((await store.read(KEY, '2026-11-22T08:30:00.000Z')).success).toBe(7); // rounded out to 08:00
    expect((await store.read(KEY, '2026-11-22T09:00:00.000Z')).success).toBe(6);
    expect((await store.read(KEY, '2026-11-22T09:59:59.000Z')).success).toBe(6);
    expect((await store.read(KEY, '2026-11-22T10:00:00.000Z')).success).toBe(4);
    expect((await store.read(KEY, '2026-11-22T11:00:00.000Z')).success).toBe(0);
  });

  it('accepts an increment for an instant in the past, in any order', async () => {
    const store = new MemoryRoutingStatsStore();
    await store.increment(KEY, Success, at(0));
    await store.increment(KEY, Failure, at(-5 * HOUR));
    expect(await store.read(KEY, at(-6 * HOUR))).toEqual({ success: 1, failure: 1, unavailable: 0 });
    expect(await store.read(KEY, at(-HOUR))).toEqual({ success: 1, failure: 0, unavailable: 0 });
  });

  it('returns a copy the caller may change', async () => {
    const store = new MemoryRoutingStatsStore();
    await store.increment(KEY, Success, at(0));
    const first = await store.read(KEY, at(-HOUR));
    first.success = 99;
    expect((await store.read(KEY, at(-HOUR))).success).toBe(1);
  });

  it('drops buckets older than its retention', async () => {
    const store = new MemoryRoutingStatsStore({ retentionHours: 2 });
    await store.increment(KEY, Success, at(-5 * HOUR));
    expect((await store.read(KEY, at(-6 * HOUR))).success).toBe(1);
    await store.increment(KEY, Success, at(0));
    expect((await store.read(KEY, at(-6 * HOUR))).success).toBe(1); // only the new one remains
    await store.increment(KEY, Success, at(HOUR));
    expect((await store.read(KEY, at(-6 * HOUR))).success).toBe(2);
  });

  it('rejects an invalid instant', async () => {
    const store = new MemoryRoutingStatsStore();
    await expect(store.increment(KEY, Success, 'soon')).rejects.toMatchObject({ code: ErrorCode.Validation });
    await expect(store.read(KEY, 'soon')).rejects.toMatchObject({ code: ErrorCode.Validation });
  });
});

describe('Router.record', () => {
  it('counts an outcome gateway-wide and, with a payment method, for that method', async () => {
    const { router, stats } = makeRouter({ capabilities: [caps(Provider.Razorpay)] });
    await router.record({ provider: Provider.Razorpay, kind: RouteOutcomeKind.Payment, result: Failure, paymentMethod: PaymentMethod.Upi });
    await router.record({ provider: Provider.Razorpay, kind: RouteOutcomeKind.Payment, result: Success });
    const key: RoutingStatsKey = { provider: Provider.Razorpay, kind: RouteOutcomeKind.Payment };
    const since = new Date(T0 - HOUR).toISOString();
    expect(await stats.read(key, since)).toEqual({ success: 1, failure: 1, unavailable: 0 });
    expect(await stats.read({ ...key, paymentMethod: PaymentMethod.Upi }, since)).toEqual({ success: 0, failure: 1, unavailable: 0 });
  });

  it('rejects an invalid outcome', async () => {
    const { router } = makeRouter();
    await expect(
      router.record({ provider: Provider.Razorpay, kind: 'bogus' as never, result: Success }),
    ).rejects.toMatchObject({ code: ErrorCode.Validation });
  });
});
