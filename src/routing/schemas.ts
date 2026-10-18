import { z } from 'zod';
import { ProductKind } from '../constants.js';
import {
  BillingIntervalSchema,
  IsoDateTimeSchema,
  PaymentMethodSchema,
  PositivePaiseSchema,
  ProductKindSchema,
  ProviderSchema,
} from '../schemas.js';
import {
  CircuitState,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_MIN_SAMPLES,
  DEFAULT_PRIOR_SUCCESS_RATE,
  DEFAULT_SUCCESS_WINDOW_HOURS,
  DEFAULT_WEIGHT_COST,
  DEFAULT_WEIGHT_PREFER,
  DEFAULT_WEIGHT_PRIORITY,
  DEFAULT_WEIGHT_SUCCESS_RATE,
  RouteExclusion,
  RouteOutcomeKind,
  RouteOutcomeResult,
} from './constants.js';

/**
 * Schemas of the gateway router. Every field carries a `describe()` because
 * these schemas are published in the OpenAPI document.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const RouteExclusionSchema = z
  .enum(RouteExclusion)
  .describe(
    'Why a gateway was ruled out: `wrong_product_kind` (no one-time payments), `missing_capability` (a `needs` flag it ' +
      'cannot meet), `payment_method_unsupported` (no overlap with the customer\'s methods), `excluded_by_merchant` ' +
      '(listed in `exclude`), `unhealthy` (circuit breaker open), `above_max_amount` and `below_min_amount` (the ' +
      'merchant\'s per-gateway amount bounds).',
  );

export const RouteOutcomeKindSchema = z
  .enum(RouteOutcomeKind)
  .describe(
    'What an outcome is about: `authorization` (a customer authorising a mandate), `charge` (a recurring debit), ' +
      '`payment` (a one-time payment) or `request` (any other call to the gateway).',
  );

export const RouteOutcomeResultSchema = z
  .enum(RouteOutcomeResult)
  .describe(
    '`success`, `failure` (the gateway answered and the attempt did not succeed, such as a declined card) or ' +
      '`unavailable` (the gateway could not be reached or errored out; this feeds the circuit breaker).',
  );

export const CircuitStateSchema = z
  .enum(CircuitState)
  .describe(
    'A gateway\'s circuit breaker: `closed` (normal), `open` (excluded until the cooldown passes) or `half_open` ' +
      '(a candidate again; one `unavailable` result reopens it, one `success` closes it).',
  );

// ---------------------------------------------------------------------------
// Request, candidate, decision
// ---------------------------------------------------------------------------

export const RouteNeedsSchema = z
  .object({
    trial: z.boolean().optional().describe('The gateway must support free trials.'),
    upfrontAmount: z.boolean().optional().describe('The gateway must be able to collect an upfront amount with the authorisation.'),
    quantity: z.boolean().optional().describe('The gateway must be able to bill several units of a plan.'),
    pause: z.boolean().optional().describe('The gateway must be able to pause a subscription.'),
    cancelAtPeriodEnd: z.boolean().optional().describe('The gateway must be able to cancel a subscription at the end of the paid period.'),
    changePlan: z.boolean().optional().describe('The gateway must be able to move a subscription to another plan.'),
    refunds: z.boolean().optional().describe('The gateway must be able to refund charges and payments.'),
  })
  .describe(
    'Capabilities the purchase depends on. A flag set to `true` excludes every gateway whose capability of the same ' +
      'name is off; `false` or absent means the capability is not needed.',
  );
export type RouteNeeds = z.infer<typeof RouteNeedsSchema>;

export const RouteRequestSchema = z
  .object({
    kind: ProductKindSchema.describe('Whether the purchase is a subscription or a one-time payment.'),
    amount: PositivePaiseSchema.describe(
      'The amount in paise: the amount of every cycle for a subscription, the payment amount for a one-time payment. ' +
        'Checked against the merchant\'s per-gateway bounds and used to price fees.',
    ),
    interval: BillingIntervalSchema.optional().describe(
      'How often a subscription bills. Accepted so a request can describe the whole plan; no gateway capability ' +
        'depends on it today, so it does not change the decision. Ignored for one-time payments.',
    ),
    paymentMethods: z
      .array(PaymentMethodSchema)
      .min(1)
      .optional()
      .describe(
        'The payment methods the customer can use. A gateway is a candidate only if it offers at least one of them ' +
          '(its mandate methods for a subscription, its one-time methods for a one-time payment). Absent: any method.',
      ),
    needs: RouteNeedsSchema.optional().describe('Capabilities the purchase depends on.'),
    exclude: z
      .array(ProviderSchema)
      .optional()
      .describe('Providers that must not be chosen, for example one that just failed this customer.'),
    prefer: ProviderSchema.optional().describe(
      'A provider to favour, for example the gateway the customer already has a mandate with. It earns a score bonus ' +
        'but is never chosen if a hard filter excludes it.',
    ),
  })
  .describe('What is about to be sold, and what the gateway must be able to do for it.');
export type RouteRequest = z.infer<typeof RouteRequestSchema>;

export const RouteFactorsSchema = z
  .object({
    successRate: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        'The success rate used in the score, from 0 to 1: successes over all observations in the window, with ' +
          'missing observations below the minimum sample count filled in with the prior rate.',
      ),
    samples: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('How many observations in the window the success rate is based on.'),
    cost: z
      .number()
      .nonnegative()
      .optional()
      .describe(
        'The gateway\'s estimated fee for this amount, in paise (fractional when it is the mean over several payment ' +
          'methods). Priced from the strategy\'s `costs`, or its `defaultCost` for a gateway without an entry.',
      ),
    priority: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('The priority factor from 0 to 1: 1 for the first provider in the merchant\'s priority list, 0 for one that is not listed.'),
    healthy: z
      .boolean()
      .optional()
      .describe('`true` when the circuit is closed, `false` when it is half-open and the gateway is on probation.'),
  })
  .describe('The inputs behind a candidate\'s score.');
export type RouteFactors = z.infer<typeof RouteFactorsSchema>;

export const RouteCandidateSchema = z
  .object({
    provider: ProviderSchema.describe('The gateway.'),
    eligible: z.boolean().describe('`true` when no hard filter excluded the gateway.'),
    exclusions: z
      .array(RouteExclusionSchema)
      .describe('Every hard filter that excluded the gateway; empty when it is eligible.'),
    details: z
      .array(z.string())
      .optional()
      .describe('A readable sentence for each entry of `exclusions`, in the same order. Absent when the gateway is eligible.'),
    score: z.number().optional().describe('The score of an eligible gateway; higher is better. Absent when excluded.'),
    factors: RouteFactorsSchema.optional().describe('The inputs behind the score. Absent when excluded.'),
  })
  .describe('One gateway considered for a request, with the reason it was excluded or the score it earned.');
export type RouteCandidate = z.infer<typeof RouteCandidateSchema>;

export const RoutingDecisionSchema = z
  .object({
    provider: ProviderSchema.describe('The best gateway for the request: the first of `ranked`.'),
    ranked: z
      .array(ProviderSchema)
      .min(1)
      .describe('Every eligible gateway, best first. Try them in this order when one fails to create the purchase.'),
    candidates: z
      .array(RouteCandidateSchema)
      .describe('Every gateway that was considered: the eligible ones in rank order, then the excluded ones by name.'),
  })
  .describe('The router\'s answer, with the reasoning behind it.');
export type RoutingDecision = z.infer<typeof RoutingDecisionSchema>;

// ---------------------------------------------------------------------------
// Outcomes and statistics
// ---------------------------------------------------------------------------

export const RouteOutcomeSchema = z
  .object({
    provider: ProviderSchema.describe('The gateway the attempt went to.'),
    kind: RouteOutcomeKindSchema.describe('What the attempt was: an authorisation, a charge, a payment or another request.'),
    result: RouteOutcomeResultSchema.describe('How it ended: `success`, `failure` or `unavailable`.'),
    paymentMethod: PaymentMethodSchema.optional().describe(
      'The payment method used, when known. It is recorded in addition to the gateway-wide figures.',
    ),
    at: IsoDateTimeSchema.optional().describe('When the attempt ended. Defaults to the router\'s clock.'),
  })
  .describe('How one attempt at a gateway ended; report it to `Router.record` so routing learns.');
export type RouteOutcome = z.infer<typeof RouteOutcomeSchema>;

export const RoutingStatsKeySchema = z
  .object({
    provider: ProviderSchema.describe('The gateway.'),
    kind: RouteOutcomeKindSchema,
    paymentMethod: PaymentMethodSchema.optional().describe(
      'Present for the figures of one payment method; absent for the gateway-wide figures (all methods).',
    ),
  })
  .describe('The series of counters a statistic belongs to.');
export type RoutingStatsKey = z.infer<typeof RoutingStatsKeySchema>;

const counter = (what: string) => z.number().int().nonnegative().describe(what);

export const RoutingStatsTotalsSchema = z
  .object({
    success: counter('Attempts that succeeded.'),
    failure: counter('Attempts the gateway answered that did not succeed.'),
    unavailable: counter('Attempts that found the gateway unavailable.'),
  })
  .describe('Counts of outcomes over a period.');
export type RoutingStatsTotals = z.infer<typeof RoutingStatsTotalsSchema>;

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

export const GatewayFeeSchema = z
  .object({
    percentBps: z
      .number()
      .int()
      .nonnegative()
      .describe('The percentage part of the fee in basis points of the amount: 200 is 2%.'),
    fixedPaise: z.number().int().nonnegative().describe('The fixed part of the fee in paise.'),
  })
  .describe('A fee: a percentage of the amount plus a fixed amount.');
export type GatewayFee = z.infer<typeof GatewayFeeSchema>;

export const GatewayCostSchema = GatewayFeeSchema.extend({
  methods: z
    .partialRecord(PaymentMethodSchema, GatewayFeeSchema)
    .optional()
    .describe('Fees that replace the gateway\'s own fee for a payment method (UPI is often cheaper than cards).'),
}).describe('What a gateway charges the merchant: a fee, optionally different per payment method.');
export type GatewayCost = z.infer<typeof GatewayCostSchema>;

export const AmountBoundsSchema = z
  .object({
    minAmount: PositivePaiseSchema.optional().describe('The smallest amount, in paise, the merchant sends to this gateway.'),
    maxAmount: PositivePaiseSchema.optional().describe(
      'The largest amount, in paise, the merchant sends to this gateway, for example the per-debit ceiling a mandate ' +
        'allows without extra authentication.',
    ),
  })
  .refine((bounds) => bounds.minAmount === undefined || bounds.maxAmount === undefined || bounds.minAmount <= bounds.maxAmount, {
    error: '`minAmount` must not exceed `maxAmount`.',
  })
  .describe('The amounts the merchant is willing to route to a gateway. Applies to subscriptions and one-time payments alike.');
export type AmountBounds = z.infer<typeof AmountBoundsSchema>;

const RoutingWeightsSchema = z
  .object({
    successRate: z
      .number()
      .nonnegative()
      .default(DEFAULT_WEIGHT_SUCCESS_RATE)
      .describe(`Weight of the success rate (0 to 1). Default ${DEFAULT_WEIGHT_SUCCESS_RATE}.`),
    cost: z
      .number()
      .nonnegative()
      .default(DEFAULT_WEIGHT_COST)
      .describe(`Weight of the share of the amount kept after the gateway's fee (0 to 1). Default ${DEFAULT_WEIGHT_COST}.`),
    priority: z
      .number()
      .nonnegative()
      .default(DEFAULT_WEIGHT_PRIORITY)
      .describe(`Weight of the priority factor (0 to 1). Default ${DEFAULT_WEIGHT_PRIORITY}.`),
    prefer: z
      .number()
      .nonnegative()
      .default(DEFAULT_WEIGHT_PREFER)
      .describe(`Bonus added to the gateway named in the request's \`prefer\`. Default ${DEFAULT_WEIGHT_PREFER}.`),
  })
  .describe('How much each factor counts. The score is the weighted sum of the factors plus the `prefer` bonus.');

const SuccessRateKindsSchema = z
  .object({
    [ProductKind.Subscription]: z
      .array(RouteOutcomeKindSchema)
      .min(1)
      .default([RouteOutcomeKind.Authorization, RouteOutcomeKind.Charge])
      .describe('Outcome kinds that count for a subscription. Default: `authorization` and `charge`.'),
    [ProductKind.OneTime]: z
      .array(RouteOutcomeKindSchema)
      .min(1)
      .default([RouteOutcomeKind.Payment])
      .describe('Outcome kinds that count for a one-time payment. Default: `payment`.'),
  })
  .describe('Which recorded outcome kinds make up the success rate, per product kind.');

const SuccessRateSettingsSchema = z
  .object({
    windowHours: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_SUCCESS_WINDOW_HOURS)
      .describe(
        `How many hours of statistics to look at. Statistics are kept in whole UTC hours, so the window is rounded ` +
          `out to the hour. Default ${DEFAULT_SUCCESS_WINDOW_HOURS}.`,
      ),
    minSamples: z
      .number()
      .int()
      .nonnegative()
      .default(DEFAULT_MIN_SAMPLES)
      .describe(
        `Observations needed before the observed rate counts fully. Below it, the missing observations are filled ` +
          `in with \`priorRate\`. Default ${DEFAULT_MIN_SAMPLES}.`,
      ),
    priorRate: z
      .number()
      .min(0)
      .max(1)
      .default(DEFAULT_PRIOR_SUCCESS_RATE)
      .describe(`The success rate assumed when nothing is known (0 to 1). Default ${DEFAULT_PRIOR_SUCCESS_RATE}.`),
    kinds: SuccessRateKindsSchema.prefault({}),
  })
  .describe('How the observed success rate is computed.');

const CircuitBreakerSettingsSchema = z
  .object({
    failureThreshold: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_FAILURE_THRESHOLD)
      .describe(`Consecutive \`unavailable\` results that open the circuit. Default ${DEFAULT_FAILURE_THRESHOLD}.`),
    cooldownMs: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_COOLDOWN_MS)
      .describe(`Milliseconds an open circuit waits before it half-opens. Default ${DEFAULT_COOLDOWN_MS}.`),
  })
  .describe('When a gateway that keeps being unavailable is taken out of rotation, and when it is let back in.');

export const RoutingStrategySchema = z
  .object({
    weights: RoutingWeightsSchema.prefault({}),
    successRate: SuccessRateSettingsSchema.prefault({}),
    costs: z
      .partialRecord(ProviderSchema, GatewayCostSchema)
      .default({})
      .describe('What each gateway charges the merchant. Absent for a gateway means `defaultCost` applies.'),
    defaultCost: GatewayFeeSchema.default({ percentBps: 0, fixedPaise: 0 }).describe(
      'The fee assumed for a gateway that has no entry in `costs`. Default: free, so list every gateway once you list any.',
    ),
    priority: z
      .array(ProviderSchema)
      .default([])
      .describe('Merchant preference order, most preferred first. Also breaks ties between equal scores.'),
    limits: z
      .partialRecord(ProviderSchema, AmountBoundsSchema)
      .default({})
      .describe('Per-gateway bounds on the amount the merchant routes there.'),
    circuitBreaker: CircuitBreakerSettingsSchema.prefault({}),
  })
  .describe('How the router decides: the weights of the score, the merchant\'s fees, priorities and limits, and the circuit breaker.');
export type RoutingStrategy = z.output<typeof RoutingStrategySchema>;
export type RoutingStrategyInput = z.input<typeof RoutingStrategySchema>;
