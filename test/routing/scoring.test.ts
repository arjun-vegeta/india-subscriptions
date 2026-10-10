import { describe, expect, it } from 'vitest';
import { PaymentMethod, Provider } from '../../src/constants.js';
import {
  DEFAULT_MIN_SAMPLES,
  DEFAULT_PRIOR_SUCCESS_RATE,
  DEFAULT_WEIGHT_PREFER,
  MemoryRoutingStatsStore,
  RouteExclusion,
  RouteOutcomeKind,
  RouteOutcomeResult,
  Router,
  type RoutingStatsStore,
} from '../../src/routing/index.js';
import { ALL_GATEWAYS, FakeClock, GATEWAYS, HOUR, PAYMENT, SUBSCRIPTION, caps, makeRouter, recordMany } from './helpers.js';

const { Success, Failure, Unavailable } = RouteOutcomeResult;
const { Razorpay, Cashfree, PayU, Paytm } = Provider;

/** Two gateways with identical capabilities, so only what the test varies can separate them. */
const TWO = [caps(Razorpay), caps(Cashfree)];

async function candidate(router: Router, provider: Provider, request = SUBSCRIPTION) {
  const decision = await router.route(request);
  const found = decision.candidates.find((c) => c.provider === provider);
  if (!found) throw new Error(`no candidate ${provider}`);
  return found;
}

describe('success rate', () => {
  it('uses the prior for a gateway with no observations', async () => {
    const { router } = makeRouter({ capabilities: TWO });
    const razorpay = await candidate(router, Razorpay);
    expect(razorpay.factors).toMatchObject({ successRate: DEFAULT_PRIOR_SUCCESS_RATE, samples: 0, healthy: true });
  });

  it('uses the observed rate once the minimum sample count is reached', async () => {
    const { router } = makeRouter({ capabilities: TWO });
    await recordMany(router, Razorpay, Success, 15);
    await recordMany(router, Razorpay, Failure, 5);
    const razorpay = await candidate(router, Razorpay);
    expect(razorpay.factors).toMatchObject({ successRate: 0.75, samples: DEFAULT_MIN_SAMPLES });
  });

  it('ranks the gateway that succeeds more often first, regardless of name order', async () => {
    const { router } = makeRouter({ capabilities: TWO });
    await recordMany(router, Razorpay, Success, 30);
    await recordMany(router, Razorpay, Failure, 30);
    await recordMany(router, Cashfree, Success, 58);
    await recordMany(router, Cashfree, Failure, 2);
    const decision = await router.route(SUBSCRIPTION);
    expect(decision.ranked).toEqual([Cashfree, Razorpay]);
    expect(decision.candidates[0]?.score).toBeGreaterThan(decision.candidates[1]?.score ?? Infinity);
  });

  it('below the minimum sample count, fills the missing observations with the prior', async () => {
    const { router } = makeRouter({ capabilities: TWO });
    await recordMany(router, Razorpay, Success, 5);
    const razorpay = await candidate(router, Razorpay);
    const expected = (5 + DEFAULT_PRIOR_SUCCESS_RATE * (DEFAULT_MIN_SAMPLES - 5)) / DEFAULT_MIN_SAMPLES;
    expect(razorpay.factors?.successRate).toBeCloseTo(expected, 12);
    expect(razorpay.factors?.samples).toBe(5);
  });

  it('does not let a handful of failures condemn a gateway as a full sample would', async () => {
    const { router } = makeRouter({ capabilities: TWO });
    await recordMany(router, Razorpay, Failure, 3);
    await recordMany(router, Cashfree, Failure, DEFAULT_MIN_SAMPLES);
    const few = (await candidate(router, Razorpay)).factors?.successRate ?? 0;
    const many = (await candidate(router, Cashfree)).factors?.successRate ?? 1;
    expect(few).toBeGreaterThan(0.5);
    expect(many).toBe(0);
  });

  it('counts unavailable results against the gateway', async () => {
    const { router } = makeRouter({ capabilities: TWO, strategy: { circuitBreaker: { failureThreshold: 1000 } } });
    await recordMany(router, Razorpay, Success, 10);
    await recordMany(router, Razorpay, Unavailable, 10);
    expect((await candidate(router, Razorpay)).factors?.successRate).toBe(0.5);
  });

  it('counts the outcome kinds that match the product kind and ignores the rest', async () => {
    const { router } = makeRouter({ capabilities: TWO });
    await recordMany(router, Razorpay, Failure, 30, RouteOutcomeKind.Payment);
    await recordMany(router, Razorpay, Failure, 30, RouteOutcomeKind.Request);
    const subscription = await candidate(router, Razorpay, SUBSCRIPTION);
    expect(subscription.factors).toMatchObject({ successRate: DEFAULT_PRIOR_SUCCESS_RATE, samples: 0 });
    const payment = await candidate(router, Razorpay, PAYMENT);
    expect(payment.factors).toMatchObject({ successRate: 0, samples: 30 });
  });

  it('counts both authorisations and charges for a subscription', async () => {
    const { router } = makeRouter({ capabilities: TWO });
    await recordMany(router, Razorpay, Success, 10, RouteOutcomeKind.Authorization);
    await recordMany(router, Razorpay, Failure, 10, RouteOutcomeKind.Charge);
    expect((await candidate(router, Razorpay)).factors).toMatchObject({ successRate: 0.5, samples: 20 });
  });

  it('follows the outcome kinds set in the strategy', async () => {
    const { router } = makeRouter({
      capabilities: TWO,
      strategy: { successRate: { kinds: { subscription: [RouteOutcomeKind.Request] } } },
    });
    await recordMany(router, Razorpay, Failure, 20, RouteOutcomeKind.Request);
    await recordMany(router, Razorpay, Success, 20, RouteOutcomeKind.Authorization);
    expect((await candidate(router, Razorpay)).factors).toMatchObject({ successRate: 0, samples: 20 });
  });

  it('honours a custom minimum sample count and prior', async () => {
    const { router } = makeRouter({ capabilities: TWO, strategy: { successRate: { minSamples: 4, priorRate: 0.5 } } });
    expect((await candidate(router, Razorpay)).factors?.successRate).toBe(0.5);
    await recordMany(router, Razorpay, Success, 4);
    expect((await candidate(router, Razorpay)).factors?.successRate).toBe(1);
  });

  it('uses the success rate of the requested payment method, filled in with the gateway-wide rate', async () => {
    const { router } = makeRouter({ capabilities: TWO });
    await recordMany(router, Razorpay, Success, 20, RouteOutcomeKind.Authorization, PaymentMethod.Card);
    await recordMany(router, Razorpay, Failure, 20, RouteOutcomeKind.Authorization, PaymentMethod.Upi);
    const upi = await candidate(router, Razorpay, { ...SUBSCRIPTION, paymentMethods: [PaymentMethod.Upi] });
    const card = await candidate(router, Razorpay, { ...SUBSCRIPTION, paymentMethods: [PaymentMethod.Card] });
    const any = await candidate(router, Razorpay, SUBSCRIPTION);
    expect(upi.factors).toMatchObject({ successRate: 0, samples: 20 });
    expect(card.factors).toMatchObject({ successRate: 1, samples: 20 });
    expect(any.factors).toMatchObject({ successRate: 0.5, samples: 40 });
  });

  it('falls back to the gateway-wide rate for a payment method nothing was recorded for', async () => {
    const { router } = makeRouter({ capabilities: TWO });
    await recordMany(router, Razorpay, Failure, 20);
    const upi = await candidate(router, Razorpay, { ...SUBSCRIPTION, paymentMethods: [PaymentMethod.Upi] });
    expect(upi.factors).toMatchObject({ successRate: 0, samples: 0 });
  });

  it('sums the methods the customer could use when several are requested', async () => {
    const { router } = makeRouter({ capabilities: TWO });
    await recordMany(router, Razorpay, Success, 10, RouteOutcomeKind.Authorization, PaymentMethod.Upi);
    await recordMany(router, Razorpay, Failure, 10, RouteOutcomeKind.Authorization, PaymentMethod.Card);
    const both = await candidate(router, Razorpay, { ...SUBSCRIPTION, paymentMethods: [PaymentMethod.Upi, PaymentMethod.Card] });
    expect(both.factors).toMatchObject({ successRate: 0.5, samples: 20 });
  });

  it('keeps routing when the statistics store fails to read, and reports the error', async () => {
    const failing: RoutingStatsStore = {
      increment: async () => undefined,
      read: async () => {
        throw new Error('stats down');
      },
    };
    const errors: unknown[] = [];
    const router = new Router({
      capabilities: () => TWO,
      stats: failing,
      now: new FakeClock().now,
      onStatsError: (error) => errors.push(error),
    });
    const decision = await router.route(SUBSCRIPTION);
    expect(decision.provider).toBe(Cashfree);
    expect(decision.candidates[0]?.factors).toMatchObject({ successRate: DEFAULT_PRIOR_SUCCESS_RATE, samples: 0 });
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('statistics window', () => {
  it('forgets observations older than the window', async () => {
    const { router, clock } = makeRouter({ capabilities: TWO });
    await recordMany(router, Razorpay, Failure, 30);
    expect((await candidate(router, Razorpay)).factors).toMatchObject({ successRate: 0, samples: 30 });

    clock.advance(23 * HOUR);
    expect((await candidate(router, Razorpay)).factors?.samples).toBe(30);

    clock.advance(2 * HOUR); // 25 hours after the failures: outside the 24 hour window even with hour rounding
    expect((await candidate(router, Razorpay)).factors).toMatchObject({ successRate: DEFAULT_PRIOR_SUCCESS_RATE, samples: 0 });
  });

  it('lets a gateway that failed yesterday win traffic back', async () => {
    const { router, clock } = makeRouter({ capabilities: TWO });
    await recordMany(router, Razorpay, Failure, 40);
    expect((await router.route(SUBSCRIPTION)).provider).toBe(Cashfree);
    clock.advance(26 * HOUR);
    expect((await router.route(SUBSCRIPTION)).provider).toBe(Cashfree); // tie by name now: cashfree < razorpay
    await recordMany(router, Cashfree, Failure, 40);
    expect((await router.route(SUBSCRIPTION)).provider).toBe(Razorpay);
  });

  it('keeps recent observations when older ones expire', async () => {
    const { router, clock } = makeRouter({ capabilities: TWO });
    await recordMany(router, Razorpay, Failure, 20);
    clock.advance(20 * HOUR);
    await recordMany(router, Razorpay, Success, 20);
    clock.advance(6 * HOUR);
    expect((await candidate(router, Razorpay)).factors).toMatchObject({ successRate: 1, samples: 20 });
  });

  it('honours a custom window', async () => {
    const { router, clock } = makeRouter({ capabilities: TWO, strategy: { successRate: { windowHours: 2 } } });
    await recordMany(router, Razorpay, Failure, 30);
    clock.advance(3 * HOUR);
    expect((await candidate(router, Razorpay)).factors?.samples).toBe(0);
  });

  it('stamps an outcome with its own time when `at` is given', async () => {
    const { router, clock } = makeRouter({ capabilities: TWO });
    for (let i = 0; i < 30; i += 1) {
      await router.record({ provider: Razorpay, kind: RouteOutcomeKind.Authorization, result: Failure, at: clock.iso(-30 * HOUR) });
    }
    expect((await candidate(router, Razorpay)).factors?.samples).toBe(0);
  });
});

describe('cost', () => {
  const costs = {
    [Razorpay]: { percentBps: 200, fixedPaise: 0 },
    [Cashfree]: { percentBps: 150, fixedPaise: 300 },
  };

  it('prices the fee in integer paise, rounding up, and reports it', async () => {
    const { router } = makeRouter({ capabilities: TWO, strategy: { costs } });
    expect((await candidate(router, Razorpay)).factors?.cost).toBe(998); // 2% of 49,900
    expect((await candidate(router, Cashfree)).factors?.cost).toBe(749 + 300); // ceil(748.5) + 300
    const odd = await candidate(router, Razorpay, { ...SUBSCRIPTION, amount: 333 });
    expect(odd.factors?.cost).toBe(7); // ceil(6.66)
  });

  it('prefers the cheaper gateway, and the fixed fee matters more on small amounts', async () => {
    const { router } = makeRouter({ capabilities: TWO, strategy: { costs } });
    expect((await router.route({ ...SUBSCRIPTION, amount: 49_900 })).provider).toBe(Razorpay);
    expect((await router.route({ ...SUBSCRIPTION, amount: 4_900 })).provider).toBe(Razorpay);
    expect((await router.route({ ...SUBSCRIPTION, amount: 1_000_000 })).provider).toBe(Cashfree);
  });

  it('lets a per-method fee replace the gateway fee', async () => {
    const { router } = makeRouter({
      capabilities: TWO,
      strategy: {
        costs: {
          [Razorpay]: { percentBps: 200, fixedPaise: 0, methods: { [PaymentMethod.Upi]: { percentBps: 0, fixedPaise: 0 } } },
          [Cashfree]: { percentBps: 100, fixedPaise: 0 },
        },
      },
    });
    const upi = await router.route({ ...SUBSCRIPTION, paymentMethods: [PaymentMethod.Upi] });
    expect(upi.provider).toBe(Razorpay);
    expect(upi.candidates[0]?.factors?.cost).toBe(0);
    const card = await router.route({ ...SUBSCRIPTION, paymentMethods: [PaymentMethod.Card] });
    expect(card.provider).toBe(Cashfree);
  });

  it('averages the fees of the methods the customer could use', async () => {
    const { router } = makeRouter({
      capabilities: [caps(Razorpay)],
      strategy: {
        costs: { [Razorpay]: { percentBps: 200, fixedPaise: 0, methods: { [PaymentMethod.Upi]: { percentBps: 0, fixedPaise: 0 } } } },
      },
    });
    const both = await router.route({ ...SUBSCRIPTION, amount: 10_000, paymentMethods: [PaymentMethod.Upi, PaymentMethod.Card] });
    expect(both.candidates[0]?.factors?.cost).toBe(100); // mean of 0 and 200
    const unrestricted = await router.route({ ...SUBSCRIPTION, amount: 10_000 });
    expect(unrestricted.candidates[0]?.factors?.cost).toBe(100); // the gateway's two mandate methods
  });

  it('prices a gateway without an entry at the default cost', async () => {
    const { router } = makeRouter({
      capabilities: TWO,
      strategy: { costs: { [Razorpay]: { percentBps: 100, fixedPaise: 0 } }, defaultCost: { percentBps: 300, fixedPaise: 0 } },
    });
    expect((await candidate(router, Cashfree)).factors?.cost).toBe(1497);
    expect((await router.route(SUBSCRIPTION)).provider).toBe(Razorpay);
  });

  it('a success rate gap of a few points outweighs a cost gap of a fraction of a point', async () => {
    const { router } = makeRouter({
      capabilities: TWO,
      strategy: { costs: { [Razorpay]: { percentBps: 150, fixedPaise: 0 }, [Cashfree]: { percentBps: 200, fixedPaise: 0 } } },
    });
    await recordMany(router, Razorpay, Success, 90);
    await recordMany(router, Razorpay, Failure, 10);
    await recordMany(router, Cashfree, Success, 99);
    await recordMany(router, Cashfree, Failure, 1);
    expect((await router.route(SUBSCRIPTION)).provider).toBe(Cashfree);
  });
});

describe('priority', () => {
  it('turns the merchant order into a factor from 1 down to 0', async () => {
    const { router } = makeRouter({ capabilities: ALL_GATEWAYS, strategy: { priority: [Paytm, PayU, Cashfree] } });
    const decision = await router.route(SUBSCRIPTION);
    const factor = (provider: Provider) => decision.candidates.find((c) => c.provider === provider)?.factors?.priority;
    expect(factor(Paytm)).toBe(1);
    expect(factor(PayU)).toBeCloseTo(2 / 3, 12);
    expect(factor(Cashfree)).toBeCloseTo(1 / 3, 12);
    expect(factor(Razorpay)).toBe(0);
    expect(decision.ranked.slice(0, 3)).toEqual([Paytm, PayU, Cashfree]);
  });

  it('is a nudge: a clearly better success rate beats a higher priority', async () => {
    const { router } = makeRouter({ capabilities: TWO, strategy: { priority: [Razorpay, Cashfree] } });
    await recordMany(router, Razorpay, Success, 50);
    await recordMany(router, Razorpay, Failure, 10);
    await recordMany(router, Cashfree, Success, 60);
    expect((await router.route(SUBSCRIPTION)).provider).toBe(Cashfree);
  });

  it('can be made dominant through its weight', async () => {
    const { router } = makeRouter({ capabilities: TWO, strategy: { priority: [Razorpay, Cashfree], weights: { priority: 10 } } });
    await recordMany(router, Razorpay, Failure, 60);
    await recordMany(router, Cashfree, Success, 60);
    expect((await router.route(SUBSCRIPTION)).provider).toBe(Razorpay);
  });

  it('ignores duplicates in the priority list', async () => {
    const { router } = makeRouter({ capabilities: TWO, strategy: { priority: [Cashfree, Cashfree, Razorpay] } });
    const decision = await router.route(SUBSCRIPTION);
    expect(decision.candidates.map((c) => [c.provider, c.factors?.priority])).toEqual([
      [Cashfree, 1],
      [Razorpay, 0.5],
    ]);
  });
});

describe('prefer', () => {
  it('adds the bonus to the preferred gateway', async () => {
    const { router } = makeRouter({ capabilities: TWO });
    const plain = await router.route(SUBSCRIPTION);
    const preferred = await router.route({ ...SUBSCRIPTION, prefer: Razorpay });
    const score = (d: typeof plain, p: Provider) => d.candidates.find((c) => c.provider === p)?.score ?? 0;
    expect(plain.provider).toBe(Cashfree);
    expect(preferred.provider).toBe(Razorpay);
    expect(score(preferred, Razorpay) - score(plain, Razorpay)).toBeCloseTo(DEFAULT_WEIGHT_PREFER, 9);
    expect(score(preferred, Cashfree)).toBe(score(plain, Cashfree));
  });

  it('does not beat a much better gateway', async () => {
    const { router } = makeRouter({ capabilities: TWO });
    await recordMany(router, Razorpay, Failure, 50);
    await recordMany(router, Cashfree, Success, 50);
    expect((await router.route({ ...SUBSCRIPTION, prefer: Razorpay })).provider).toBe(Cashfree);
  });

  it('is never chosen when a hard filter excludes it', async () => {
    const { router } = makeRouter({ capabilities: TWO });
    const decision = await router.route({ ...SUBSCRIPTION, prefer: Razorpay, exclude: [Razorpay] });
    expect(decision.ranked).toEqual([Cashfree]);
    expect(decision.candidates.find((c) => c.provider === Razorpay)?.exclusions).toContain(RouteExclusion.ExcludedByMerchant);
  });

  it('follows the bonus weight', async () => {
    const { router } = makeRouter({ capabilities: TWO, strategy: { weights: { prefer: 0 } } });
    expect((await router.route({ ...SUBSCRIPTION, prefer: Razorpay })).provider).toBe(Cashfree);
  });
});

describe('tie-breaking', () => {
  it('orders equal scores by merchant priority, then by provider name', async () => {
    const { router } = makeRouter({
      capabilities: ALL_GATEWAYS.map((c) => caps(c.provider)),
      strategy: { weights: { priority: 0 }, priority: [Paytm, Razorpay] },
    });
    const decision = await router.route(SUBSCRIPTION);
    expect(decision.ranked).toEqual([Paytm, Razorpay, Cashfree, PayU, Provider.PhonePe]);
  });

  it('gives the same decision whatever order the capabilities are listed in', async () => {
    const reference = await makeRouter({ capabilities: ALL_GATEWAYS }).router.route(SUBSCRIPTION);
    const reversed = await makeRouter({ capabilities: [...ALL_GATEWAYS].reverse() }).router.route(SUBSCRIPTION);
    expect(reversed).toEqual(reference);
  });

  it('is not decided by floating point noise', async () => {
    // 0.1 + 0.2 style sums: three gateways whose factors add up in different orders must still tie.
    const { router } = makeRouter({
      capabilities: [caps(Cashfree), caps(PayU), caps(Razorpay)],
      strategy: { weights: { successRate: 0.1, cost: 0.2, priority: 0 }, successRate: { priorRate: 0.3 } },
    });
    expect((await router.route(SUBSCRIPTION)).ranked).toEqual([Cashfree, PayU, Razorpay]);
  });

  it('puts a listed gateway ahead of an unlisted one on equal scores', async () => {
    const { router } = makeRouter({ capabilities: TWO, strategy: { weights: { priority: 0 }, priority: [Razorpay] } });
    expect((await router.route(SUBSCRIPTION)).ranked).toEqual([Razorpay, Cashfree]);
  });
});

describe('scores', () => {
  it('equal the weighted sum of the reported factors', async () => {
    const { router } = makeRouter({
      capabilities: [GATEWAYS.razorpay],
      strategy: {
        weights: { successRate: 2, cost: 3, priority: 0.5, prefer: 0.25 },
        costs: { [Razorpay]: { percentBps: 250, fixedPaise: 0 } },
        priority: [Razorpay],
      },
    });
    await recordMany(router, Razorpay, Success, 15);
    await recordMany(router, Razorpay, Failure, 5);
    const { factors, score } = await candidate(router, Razorpay, { ...SUBSCRIPTION, prefer: Razorpay });
    const costFactor = 1 - (factors?.cost ?? 0) / SUBSCRIPTION.amount;
    expect(score).toBeCloseTo(2 * 0.75 + 3 * costFactor + 0.5 * 1 + 0.25, 9);
  });
});
