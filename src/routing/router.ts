import { ErrorCode, type PaymentMethod, ProductKind, type Provider, ProviderKind } from '../constants.js';
import { SubscriptionError, parseInput } from '../errors.js';
import type { Capabilities } from '../schemas.js';
import {
  BPS_PER_WHOLE,
  CircuitState,
  STATS_BUCKET_MS,
  RouteExclusion,
  type RouteExclusion as RouteExclusionValue,
  RouteNeed,
  RouteOutcomeResult,
  SCORE_PRECISION,
} from './constants.js';
import { MemoryRoutingStatsStore } from './memory-stats-store.js';
import {
  RouteOutcomeSchema,
  RouteRequestSchema,
  RoutingStrategySchema,
  type GatewayFee,
  type RouteCandidate,
  type RouteFactors,
  type RouteOutcome,
  type RouteRequest,
  type RoutingDecision,
  type RoutingStatsKey,
  type RoutingStatsTotals,
  type RoutingStrategy,
  type RoutingStrategyInput,
} from './schemas.js';
import type { RoutingStatsStore } from './stats-store.js';

export interface RouterOptions {
  /**
   * The capabilities of every configured provider, read on each `route` call so
   * the router always sees the current set (`subs.providers.map(capabilities)`).
   * Providers whose `kind` is not `gateway` (the app stores) are never candidates.
   */
  capabilities: () => Capabilities[];
  /** How to decide. Every field has a default; see `RoutingStrategySchema`. */
  strategy?: RoutingStrategyInput;
  /** Where outcomes are counted. Defaults to a `MemoryRoutingStatsStore`. */
  stats?: RoutingStatsStore;
  /** The clock for the circuit breaker and the statistics window. Defaults to `new Date()`. */
  now?: () => Date;
  /**
   * Called when the statistics store fails to read. Routing carries on as if
   * nothing had been observed (a statistics outage must not stop payments), so
   * use this to log it.
   */
  onStatsError?: (error: unknown) => void;
}

interface Breaker {
  /** Consecutive `unavailable` results since the last `success`. */
  streak: number;
  /** When the circuit opened (or reopened), in epoch milliseconds. */
  openedAtMs?: number;
}

interface Screened {
  capabilities: Capabilities;
  exclusions: RouteExclusionValue[];
  details: string[];
}

interface Scored {
  provider: Provider;
  score: number;
  factors: RouteFactors;
  priorityIndex: number;
}

const NO_PRIORITY = Number.POSITIVE_INFINITY;

/**
 * Chooses the gateway for a new subscription or one-time payment. See the
 * design note in `index.ts` for what "best" means.
 */
export class Router {
  readonly strategy: RoutingStrategy;
  private readonly capabilities: () => Capabilities[];
  private readonly stats: RoutingStatsStore;
  private readonly clock: () => Date;
  private readonly onStatsError: ((error: unknown) => void) | undefined;
  private readonly breakers = new Map<Provider, Breaker>();
  private readonly priorityIndex = new Map<Provider, number>();

  constructor(options: RouterOptions) {
    this.capabilities = options.capabilities;
    this.strategy = parseInput(RoutingStrategySchema, options.strategy ?? {}, 'routing strategy');
    this.stats = options.stats ?? new MemoryRoutingStatsStore();
    this.clock = options.now ?? (() => new Date());
    this.onStatsError = options.onStatsError;
    for (const provider of this.strategy.priority) {
      if (!this.priorityIndex.has(provider)) this.priorityIndex.set(provider, this.priorityIndex.size);
    }
  }

  /**
   * Picks the best gateway for `request` and explains the choice: every
   * gateway considered is in `candidates` with its exclusions or its score and
   * factors, and `ranked` lists the eligible ones best first.
   *
   * Calling it has no side effects, so the same request against the same
   * capabilities, statistics, strategy and clock gives the same decision.
   * Rejects with `VALIDATION` for a malformed request and with `NO_ROUTE`,
   * whose message says why each gateway was excluded, when none is eligible.
   */
  async route(input: RouteRequest): Promise<RoutingDecision> {
    const request = parseInput(RouteRequestSchema, input, 'route request');
    const nowMs = this.clock().getTime();

    const screened = this.gateways().map((capabilities) => this.screen(capabilities, request, nowMs));
    const eligible = screened.filter((entry) => entry.exclusions.length === 0);
    const scored = await Promise.all(eligible.map((entry) => this.score(entry.capabilities, request, nowMs)));
    scored.sort((a, b) => b.score - a.score || a.priorityIndex - b.priorityIndex || compare(a.provider, b.provider));

    const excluded: RouteCandidate[] = screened
      .filter((entry) => entry.exclusions.length > 0)
      .map((entry) => ({
        provider: entry.capabilities.provider,
        eligible: false,
        exclusions: entry.exclusions,
        details: entry.details,
      }))
      .sort((a, b) => compare(a.provider, b.provider));

    if (scored.length === 0) throw noRoute(request, screened.length, excluded);

    const ranked = scored.map((entry) => entry.provider);
    return {
      provider: ranked[0] as Provider,
      ranked,
      candidates: [
        ...scored.map((entry) => ({
          provider: entry.provider,
          eligible: true,
          exclusions: [],
          score: entry.score,
          factors: entry.factors,
        })),
        ...excluded,
      ],
    };
  }

  /**
   * Reports how an attempt at a gateway ended. It feeds the observed success
   * rate (in the statistics store, as a gateway-wide count and, when
   * `paymentMethod` is given, a per-method count) and the circuit breaker:
   * `unavailable` counts toward opening it, `success` closes it, `failure`
   * leaves it alone (a declined card says nothing about the gateway being up).
   */
  async record(input: RouteOutcome): Promise<void> {
    const outcome = parseInput(RouteOutcomeSchema, input, 'routing outcome');
    const at = outcome.at ?? this.clock().toISOString();
    this.updateBreaker(outcome.provider, outcome.result, this.clock().getTime());

    const key: RoutingStatsKey = { provider: outcome.provider, kind: outcome.kind };
    await this.stats.increment(key, outcome.result, at);
    if (outcome.paymentMethod !== undefined) {
      await this.stats.increment({ ...key, paymentMethod: outcome.paymentMethod }, outcome.result, at);
    }
  }

  /** The circuit breaker state of a provider right now. */
  circuitState(provider: Provider): CircuitState {
    return this.circuitStateAt(provider, this.clock().getTime());
  }

  // -------------------------------------------------------------------------
  // Hard filters
  // -------------------------------------------------------------------------

  /** Capabilities of the configured gateways, one per provider (the first wins), store providers dropped. */
  private gateways(): Capabilities[] {
    const seen = new Set<Provider>();
    const gateways: Capabilities[] = [];
    for (const capabilities of this.capabilities()) {
      if (capabilities.kind !== ProviderKind.Gateway || seen.has(capabilities.provider)) continue;
      seen.add(capabilities.provider);
      gateways.push(capabilities);
    }
    return gateways;
  }

  private screen(capabilities: Capabilities, request: RouteRequest, nowMs: number): Screened {
    const { provider } = capabilities;
    const exclusions: RouteExclusionValue[] = [];
    const details: string[] = [];
    const exclude = (exclusion: RouteExclusionValue, detail: string): void => {
      exclusions.push(exclusion);
      details.push(detail);
    };

    if (request.exclude?.includes(provider)) {
      exclude(RouteExclusion.ExcludedByMerchant, 'excluded in the request');
    }

    const wrongKind = request.kind === ProductKind.OneTime && !capabilities.oneTimePayments;
    if (wrongKind) exclude(RouteExclusion.WrongProductKind, 'does not take one-time payments');

    const missing = Object.values(RouteNeed).filter((need) => request.needs?.[need] === true && !capabilities[need]);
    if (missing.length > 0) exclude(RouteExclusion.MissingCapability, `lacks ${missing.join(', ')}`);

    if (request.paymentMethods && !wrongKind && this.methodsOverlap(capabilities, request).length === 0) {
      const offered = methodsFor(capabilities, request.kind);
      exclude(
        RouteExclusion.PaymentMethodUnsupported,
        `offers ${offered.length > 0 ? offered.join('/') : 'no payment method'} for ${request.kind} payments, ` +
          `the customer can use ${request.paymentMethods.join('/')}`,
      );
    }

    if (this.circuitStateAt(provider, nowMs) === CircuitState.Open) {
      exclude(RouteExclusion.Unhealthy, 'circuit open after repeated unavailable results');
    }

    const bounds = this.strategy.limits[provider];
    if (bounds?.maxAmount !== undefined && request.amount > bounds.maxAmount) {
      exclude(RouteExclusion.AboveMaxAmount, `${request.amount} paise is above its maximum of ${bounds.maxAmount}`);
    }
    if (bounds?.minAmount !== undefined && request.amount < bounds.minAmount) {
      exclude(RouteExclusion.BelowMinAmount, `${request.amount} paise is below its minimum of ${bounds.minAmount}`);
    }

    return { capabilities, exclusions, details };
  }

  /** The requested payment methods the gateway offers for this product kind. */
  private methodsOverlap(capabilities: Capabilities, request: RouteRequest): PaymentMethod[] {
    const offered = methodsFor(capabilities, request.kind);
    return (request.paymentMethods ?? []).filter((method) => offered.includes(method));
  }

  // -------------------------------------------------------------------------
  // Scoring
  // -------------------------------------------------------------------------

  private async score(capabilities: Capabilities, request: RouteRequest, nowMs: number): Promise<Scored> {
    const { weights } = this.strategy;
    const { provider } = capabilities;
    const methods = request.paymentMethods ? this.methodsOverlap(capabilities, request) : [];

    const observed = await this.observedSuccessRate(provider, request, methods, nowMs);
    const fee = this.estimatedFee(capabilities, request, methods);
    const costFactor = clamp(1 - fee / request.amount);
    const index = this.priorityIndex.get(provider);
    const size = this.priorityIndex.size;
    const priorityFactor = index === undefined ? 0 : (size - index) / size;
    const healthy = this.circuitStateAt(provider, nowMs) === CircuitState.Closed;

    const raw =
      weights.successRate * observed.rate +
      weights.cost * costFactor +
      weights.priority * priorityFactor +
      (request.prefer === provider ? weights.prefer : 0);

    return {
      provider,
      score: Math.round(raw * SCORE_PRECISION) / SCORE_PRECISION,
      priorityIndex: index ?? NO_PRIORITY,
      factors: { successRate: observed.rate, samples: observed.samples, cost: fee, priority: priorityFactor, healthy },
    };
  }

  /**
   * The success rate of a gateway for this request, from 0 to 1.
   *
   * Gateway-wide: successes over all observations in the window, with the
   * observations missing below `minSamples` filled in with `priorRate`. With no
   * observations at all it is the prior. When the request names payment
   * methods, the figure is the one for those methods, with its own missing
   * observations filled in with the gateway-wide rate. Each failure recorded
   * can only lower the result, never raise it.
   */
  private async observedSuccessRate(
    provider: Provider,
    request: RouteRequest,
    methods: readonly PaymentMethod[],
    nowMs: number,
  ): Promise<{ rate: number; samples: number }> {
    const { windowHours, minSamples, priorRate, kinds } = this.strategy.successRate;
    const since = new Date(nowMs - windowHours * STATS_BUCKET_MS).toISOString();
    const outcomeKinds = kinds[request.kind];

    const read = async (paymentMethod?: PaymentMethod): Promise<RoutingStatsTotals> => {
      const totals = await Promise.all(
        outcomeKinds.map((kind) => this.readStats({ provider, kind, ...(paymentMethod ? { paymentMethod } : {}) }, since)),
      );
      return addTotals(totals);
    };

    const overall = await read();
    const overallRate = paddedRate(overall, minSamples, priorRate);
    if (methods.length === 0) return { rate: overallRate, samples: count(overall) };

    const perMethod = addTotals(await Promise.all(methods.map((method) => read(method))));
    return { rate: paddedRate(perMethod, minSamples, overallRate), samples: count(perMethod) };
  }

  private async readStats(key: RoutingStatsKey, since: string): Promise<RoutingStatsTotals> {
    try {
      return await this.stats.read(key, since);
    } catch (error) {
      this.onStatsError?.(error);
      return { success: 0, failure: 0, unavailable: 0 };
    }
  }

  /** The gateway's fee for the amount in paise: the mean over the payment methods the customer could use. */
  private estimatedFee(capabilities: Capabilities, request: RouteRequest, methods: readonly PaymentMethod[]): number {
    const cost = this.strategy.costs[capabilities.provider];
    const base: GatewayFee = cost ?? this.strategy.defaultCost;
    const considered = request.paymentMethods ? methods : methodsFor(capabilities, request.kind);
    const fees = considered.map((method) => feeFor(request.amount, cost?.methods?.[method] ?? base));
    if (fees.length === 0) return feeFor(request.amount, base);
    return fees.reduce((sum, fee) => sum + fee, 0) / fees.length;
  }

  // -------------------------------------------------------------------------
  // Circuit breaker
  // -------------------------------------------------------------------------

  private circuitStateAt(provider: Provider, nowMs: number): CircuitState {
    const openedAtMs = this.breakers.get(provider)?.openedAtMs;
    if (openedAtMs === undefined) return CircuitState.Closed;
    return nowMs - openedAtMs >= this.strategy.circuitBreaker.cooldownMs ? CircuitState.HalfOpen : CircuitState.Open;
  }

  private updateBreaker(provider: Provider, result: RouteOutcomeResult, nowMs: number): void {
    if (result === RouteOutcomeResult.Success) {
      this.breakers.delete(provider);
      return;
    }
    if (result === RouteOutcomeResult.Failure) return;

    const breaker = this.breakers.get(provider) ?? { streak: 0 };
    const state = this.circuitStateAt(provider, nowMs);
    if (state === CircuitState.Open) return;
    if (state === CircuitState.HalfOpen) {
      breaker.openedAtMs = nowMs;
    } else {
      breaker.streak += 1;
      if (breaker.streak >= this.strategy.circuitBreaker.failureThreshold) breaker.openedAtMs = nowMs;
    }
    this.breakers.set(provider, breaker);
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function methodsFor(capabilities: Capabilities, kind: RouteRequest['kind']): PaymentMethod[] {
  return kind === ProductKind.Subscription ? capabilities.paymentMethods : capabilities.oneTimePaymentMethods;
}

/** `ceil(amount * percentBps / 10000) + fixedPaise`, in integer paise. */
function feeFor(amount: number, fee: GatewayFee): number {
  return Math.ceil((amount * fee.percentBps) / BPS_PER_WHOLE) + fee.fixedPaise;
}

function count(totals: RoutingStatsTotals): number {
  return totals.success + totals.failure + totals.unavailable;
}

function addTotals(all: readonly RoutingStatsTotals[]): RoutingStatsTotals {
  return all.reduce<RoutingStatsTotals>(
    (sum, totals) => ({
      success: sum.success + totals.success,
      failure: sum.failure + totals.failure,
      unavailable: sum.unavailable + totals.unavailable,
    }),
    { success: 0, failure: 0, unavailable: 0 },
  );
}

/** Success rate with the observations missing below `minSamples` filled in with `fill`. */
function paddedRate(totals: RoutingStatsTotals, minSamples: number, fill: number): number {
  const n = count(totals);
  if (n === 0) return fill;
  if (n >= minSamples) return totals.success / n;
  return (totals.success + fill * (minSamples - n)) / minSamples;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function noRoute(request: RouteRequest, gateways: number, excluded: RouteCandidate[]): SubscriptionError {
  const what = `${request.kind} of ${request.amount} paise`;
  const message =
    gateways === 0
      ? `No gateway can take this ${what}: no gateway provider is configured (app stores are never routed).`
      : `No gateway can take this ${what}: ` +
        excluded.map((candidate) => `${candidate.provider} (${(candidate.details ?? []).join('; ')})`).join(', ') +
        '.';
  return new SubscriptionError(ErrorCode.NoRoute, message, { raw: excluded });
}
