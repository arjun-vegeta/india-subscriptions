import { describe, expect, it } from 'vitest';
import { PaymentMethod, ProductKind, Provider, ProviderKind } from '../../src/constants.js';
import { ErrorCode } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import type { Capabilities } from '../../src/schemas.js';
import {
  CircuitState,
  RouteExclusion,
  RouteOutcomeKind,
  RouteOutcomeResult,
  Router,
  type RouteRequest,
  type RoutingDecision,
  type RoutingStrategyInput,
} from '../../src/routing/index.js';
import { FakeClock, caps } from './helpers.js';

/** Small seeded generator (mulberry32), so a failing case can be replayed from its seed. */
function rng(seed: number) {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    chance: (p: number) => next() < p,
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
    subset: <T>(items: readonly T[], p = 0.5): T[] => items.filter(() => next() < p),
    shuffle: <T>(items: readonly T[]): T[] => {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
      }
      return copy;
    },
  };
}
type Rng = ReturnType<typeof rng>;

const GATEWAY_PROVIDERS = [Provider.Razorpay, Provider.Cashfree, Provider.PayU, Provider.PhonePe, Provider.Paytm];
const ALL_PROVIDERS = Object.values(Provider);
const METHODS = Object.values(PaymentMethod);
const NEEDS = ['trial', 'upfrontAmount', 'quantity', 'pause', 'cancelAtPeriodEnd', 'changePlan', 'refunds'] as const;
const FAILURE_THRESHOLD = 4;
const CASES = 250;

interface Scenario {
  capabilities: Capabilities[];
  strategy: RoutingStrategyInput;
  request: RouteRequest;
  /** Gateways whose circuit is forced open before routing. */
  open: Set<Provider>;
}

function scenario(r: Rng): Scenario {
  const capabilities: Capabilities[] = [];
  for (const provider of GATEWAY_PROVIDERS) {
    if (!r.chance(0.85)) continue;
    capabilities.push(
      caps(provider, {
        trial: r.chance(0.7),
        upfrontAmount: r.chance(0.7),
        quantity: r.chance(0.3),
        pause: r.chance(0.5),
        cancelAtPeriodEnd: r.chance(0.3),
        changePlan: r.chance(0.4),
        refunds: r.chance(0.8),
        oneTimePayments: r.chance(0.75),
        paymentMethods: r.subset(METHODS, 0.45),
        oneTimePaymentMethods: r.subset(METHODS, 0.55),
      }),
    );
  }
  for (const store of [Provider.AppStore, Provider.GooglePlay]) {
    if (r.chance(0.5)) capabilities.push(caps(store, { kind: ProviderKind.Store, oneTimePaymentMethods: [...METHODS], paymentMethods: [...METHODS] }));
  }

  const limits: Record<string, { minAmount?: number; maxAmount?: number }> = {};
  const costs: Record<string, { percentBps: number; fixedPaise: number }> = {};
  for (const provider of GATEWAY_PROVIDERS) {
    if (r.chance(0.4)) limits[provider] = { ...(r.chance(0.6) ? { maxAmount: r.int(1000, 2_000_000) } : {}), ...(r.chance(0.3) ? { minAmount: r.int(1, 500) } : {}) };
    if (r.chance(0.6)) costs[provider] = { percentBps: r.int(0, 400), fixedPaise: r.int(0, 500) };
  }
  // A bound pair with minAmount above maxAmount is invalid; drop the minimum in that case.
  for (const bounds of Object.values(limits)) {
    if (bounds.minAmount !== undefined && bounds.maxAmount !== undefined && bounds.minAmount > bounds.maxAmount) delete bounds.minAmount;
  }
  const strategy: RoutingStrategyInput = {
    limits,
    costs,
    priority: r.shuffle(GATEWAY_PROVIDERS).slice(0, r.int(0, 5)),
    weights: { successRate: r.next() * 2, cost: r.next() * 2, priority: r.next() * 0.2, prefer: r.next() * 0.2 },
    successRate: { minSamples: r.int(0, 30) },
    circuitBreaker: { failureThreshold: FAILURE_THRESHOLD, cooldownMs: 60_000 },
  };

  const request: RouteRequest = {
    kind: r.pick(Object.values(ProductKind)),
    amount: r.int(1, 3_000_000),
    ...(r.chance(0.5) ? { paymentMethods: r.subset(METHODS, 0.4).concat(r.pick(METHODS)) } : {}),
    ...(r.chance(0.5) ? { needs: Object.fromEntries(r.subset(NEEDS, 0.25).map((need) => [need, true])) } : {}),
    ...(r.chance(0.3) ? { exclude: r.subset(ALL_PROVIDERS, 0.2) } : {}),
    ...(r.chance(0.5) ? { prefer: r.pick(ALL_PROVIDERS) } : {}),
  };
  const open = new Set(GATEWAY_PROVIDERS.filter(() => r.chance(0.15)));
  return { capabilities, strategy, request, open };
}

/** What the hard filters should do, written independently of the router. */
function expectedEligible(s: Scenario): Set<Provider> {
  const eligible = new Set<Provider>();
  const seen = new Set<Provider>();
  for (const c of s.capabilities) {
    if (seen.has(c.provider)) continue;
    seen.add(c.provider);
    if (c.kind !== ProviderKind.Gateway) continue;
    const { request } = s;
    if (request.exclude?.includes(c.provider)) continue;
    if (request.kind === ProductKind.OneTime && !c.oneTimePayments) continue;
    if (NEEDS.some((need) => request.needs?.[need] === true && !c[need])) continue;
    const offered = request.kind === ProductKind.Subscription ? c.paymentMethods : c.oneTimePaymentMethods;
    if (request.paymentMethods && !request.paymentMethods.some((m) => offered.includes(m))) continue;
    if (s.open.has(c.provider)) continue;
    const bounds = s.strategy.limits?.[c.provider];
    if (bounds?.maxAmount !== undefined && request.amount > bounds.maxAmount) continue;
    if (bounds?.minAmount !== undefined && request.amount < bounds.minAmount) continue;
    eligible.add(c.provider);
  }
  return eligible;
}

function build(s: Scenario, clock: FakeClock, order: (items: Capabilities[]) => Capabilities[] = (x) => x) {
  return new Router({ capabilities: () => order(s.capabilities), strategy: s.strategy, now: clock.now });
}

/** Opens the circuits of `s.open`. Done after the statistics are seeded, because a recorded success closes a circuit. */
async function openCircuits(router: Router, s: Scenario) {
  for (const provider of s.open) {
    for (let i = 0; i < FAILURE_THRESHOLD; i += 1) {
      await router.record({ provider, kind: RouteOutcomeKind.Request, result: RouteOutcomeResult.Unavailable });
    }
  }
}

async function seedStats(router: Router, r: Rng, s: Scenario) {
  const { Success, Failure } = RouteOutcomeResult;
  for (const provider of GATEWAY_PROVIDERS) {
    const n = r.int(0, 40);
    const rate = r.next();
    for (let i = 0; i < n; i += 1) {
      await router.record({
        provider,
        kind: s.request.kind === ProductKind.OneTime ? RouteOutcomeKind.Payment : r.pick([RouteOutcomeKind.Authorization, RouteOutcomeKind.Charge]),
        result: r.chance(rate) ? Success : Failure,
        paymentMethod: r.chance(0.5) ? r.pick(METHODS) : undefined,
      });
    }
  }
}

async function decide(router: Router, request: RouteRequest): Promise<RoutingDecision | SubscriptionError> {
  try {
    return await router.route(request);
  } catch (error) {
    if (error instanceof SubscriptionError) return error;
    throw error;
  }
}

describe('properties over generated inputs', () => {
  it('an excluded gateway is never chosen, and `ranked` is exactly the eligible gateways', async () => {
    let routed = 0;
    let refused = 0;
    for (let seed = 1; seed <= CASES; seed += 1) {
      const r = rng(seed);
      const s = scenario(r);
      const clock = new FakeClock();
      const router = build(s, clock);
      await seedStats(router, r, s);
      await openCircuits(router, s);
      const expected = expectedEligible(s);
      const result = await decide(router, s.request);

      if (expected.size === 0) {
        expect(result, `seed ${seed}`).toBeInstanceOf(SubscriptionError);
        expect((result as SubscriptionError).code, `seed ${seed}`).toBe(ErrorCode.NoRoute);
        refused += 1;
        continue;
      }
      routed += 1;
      const decision = result as RoutingDecision;
      expect(new Set(decision.ranked), `seed ${seed}`).toEqual(expected);
      expect(decision.ranked.length, `seed ${seed}`).toBe(expected.size);
      expect(decision.provider, `seed ${seed}`).toBe(decision.ranked[0]);
      expect(expected.has(decision.provider), `seed ${seed}`).toBe(true);

      for (const candidate of decision.candidates) {
        expect(candidate.eligible, `seed ${seed}`).toBe(expected.has(candidate.provider));
        expect(candidate.exclusions.length === 0, `seed ${seed}`).toBe(candidate.eligible);
        expect(candidate.score !== undefined, `seed ${seed}`).toBe(candidate.eligible);
      }
      // Stores never appear, and every gateway appears once.
      const names = decision.candidates.map((c) => c.provider);
      expect(new Set(names).size, `seed ${seed}`).toBe(names.length);
      expect(names.every((name) => (GATEWAY_PROVIDERS as Provider[]).includes(name)), `seed ${seed}`).toBe(true);
      // An open circuit is reported as such.
      for (const provider of s.open) {
        const c = decision.candidates.find((x) => x.provider === provider);
        if (c) expect(c.exclusions, `seed ${seed}`).toContain(RouteExclusion.Unhealthy);
      }
    }
    // The generator must exercise both outcomes, or the checks above prove little.
    expect(routed).toBeGreaterThan(CASES / 2);
    expect(refused).toBeGreaterThan(CASES / 50);
  });

  it('ranks by score, best first', async () => {
    for (let seed = 1000; seed < 1000 + CASES; seed += 1) {
      const r = rng(seed);
      const s = scenario(r);
      const router = build(s, new FakeClock());
      await seedStats(router, r, s);
      await openCircuits(router, s);
      const decision = await decide(router, s.request);
      if (decision instanceof SubscriptionError) continue;
      const scores = decision.candidates.filter((c) => c.eligible).map((c) => c.score as number);
      expect(scores, `seed ${seed}`).toEqual([...scores].sort((a, b) => b - a));
    }
  });

  it('gives the same decision for the same inputs, whatever the order the capabilities are listed in', async () => {
    for (let seed = 2000; seed < 2000 + CASES; seed += 1) {
      const r = rng(seed);
      const s = scenario(r);
      const forward = build(s, new FakeClock());
      const shuffled = build(s, new FakeClock(), (items) => rng(seed).shuffle(items));
      const statsSeed = rng(seed + 77);
      await seedStats(forward, statsSeed, s);
      await seedStats(shuffled, rng(seed + 77), s);
      await openCircuits(forward, s);
      await openCircuits(shuffled, s);

      const first = await decide(forward, s.request);
      const again = await decide(forward, s.request);
      const other = await decide(shuffled, s.request);
      expect(again, `seed ${seed}`).toEqual(first);
      expect(other, `seed ${seed}`).toEqual(first);
    }
  });

  it('adding a failure never raises a gateway\'s rank or score', async () => {
    for (let seed = 3000; seed < 3000 + CASES; seed += 1) {
      const r = rng(seed);
      const s = scenario(r);
      const router = build(s, new FakeClock());
      await seedStats(router, r, s);
      await openCircuits(router, s);
      const before = await decide(router, s.request);
      if (before instanceof SubscriptionError) continue;

      const target = r.pick(before.ranked) as Provider;
      const result = r.pick([RouteOutcomeResult.Failure, RouteOutcomeResult.Unavailable]);
      await router.record({
        provider: target,
        kind: s.request.kind === ProductKind.OneTime ? RouteOutcomeKind.Payment : RouteOutcomeKind.Authorization,
        result,
        paymentMethod: r.chance(0.5) ? r.pick(METHODS) : undefined,
      });
      const after = await decide(router, s.request);
      if (after instanceof SubscriptionError) continue; // the gateway became unavailable and nothing is left: rank cannot have risen

      const rankBefore = before.ranked.indexOf(target);
      const rankAfter = after.ranked.indexOf(target); // -1: the failure opened its circuit, the lowest rank of all
      if (rankAfter !== -1) expect(rankAfter, `seed ${seed}`).toBeGreaterThanOrEqual(rankBefore);
      const scoreBefore = before.candidates.find((c) => c.provider === target)?.score as number;
      const scoreAfter = after.candidates.find((c) => c.provider === target)?.score;
      if (scoreAfter !== undefined) expect(scoreAfter, `seed ${seed}`).toBeLessThanOrEqual(scoreBefore);
    }
  });

  it('adding a failure to one gateway never lowers another gateway\'s score', async () => {
    for (let seed = 4000; seed < 4000 + 100; seed += 1) {
      const r = rng(seed);
      const s = scenario(r);
      const router = build(s, new FakeClock());
      await seedStats(router, r, s);
      await openCircuits(router, s);
      const before = await decide(router, s.request);
      if (before instanceof SubscriptionError || before.ranked.length < 2) continue;
      const [target, other] = r.shuffle(before.ranked);
      await router.record({ provider: target as Provider, kind: RouteOutcomeKind.Authorization, result: RouteOutcomeResult.Failure });
      const after = await decide(router, s.request);
      if (after instanceof SubscriptionError) continue;
      const score = (d: RoutingDecision) => d.candidates.find((c) => c.provider === other)?.score;
      expect(score(after), `seed ${seed}`).toBe(score(before));
    }
  });

  it('a failure never raises the score, including the one that reaches the minimum sample count', async () => {
    for (let minSamples = 1; minSamples <= 30; minSamples += 1) {
      for (const successes of [0, minSamples - 1, minSamples + 3]) {
        for (const withMethod of [false, true]) {
          const method = withMethod ? PaymentMethod.Upi : undefined;
          const router = new Router({
            capabilities: () => [caps(Provider.Razorpay), caps(Provider.Cashfree)],
            strategy: { successRate: { minSamples, priorRate: 0.4 } },
            now: new FakeClock().now,
          });
          const request: RouteRequest = { kind: ProductKind.Subscription, amount: 10_000, ...(method ? { paymentMethods: [method] } : {}) };
          const scoreOf = async () => (await router.route(request)).candidates.find((c) => c.provider === Provider.Razorpay)?.score as number;
          for (let i = 0; i < successes; i += 1) {
            await router.record({ provider: Provider.Razorpay, kind: RouteOutcomeKind.Authorization, result: RouteOutcomeResult.Success, paymentMethod: method });
          }
          let previous = await scoreOf();
          for (let i = 0; i < minSamples + 5; i += 1) {
            await router.record({ provider: Provider.Razorpay, kind: RouteOutcomeKind.Authorization, result: RouteOutcomeResult.Failure, paymentMethod: method });
            const current = await scoreOf();
            expect(current, `min ${minSamples}, ${successes} successes, failure ${i + 1}`).toBeLessThanOrEqual(previous);
            previous = current;
          }
        }
      }
    }
  });

  it('closed circuits come back: after the cooldown every gateway is eligible again', async () => {
    for (let seed = 5000; seed < 5000 + 50; seed += 1) {
      const r = rng(seed);
      const s = scenario(r);
      const clock = new FakeClock();
      const router = build(s, clock);
      await openCircuits(router, s);
      clock.advance(60_000);
      for (const provider of s.open) expect(router.circuitState(provider), `seed ${seed}`).toBe(CircuitState.HalfOpen);
      s.open.clear();
      const expected = expectedEligible(s);
      const decision = await decide(router, s.request);
      if (expected.size === 0) continue;
      expect(new Set((decision as RoutingDecision).ranked), `seed ${seed}`).toEqual(expected);
    }
  });
});
