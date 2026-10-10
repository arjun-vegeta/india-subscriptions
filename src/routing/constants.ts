/**
 * Typed constants for the gateway router. Same pattern as `src/constants.ts`:
 * an `as const` object plus a union type of the same name. Code must reference
 * these, never the bare literals.
 */

/** Why a gateway was ruled out for a request. Every exclusion is a hard filter: an excluded gateway is never chosen. */
export const RouteExclusion = {
  /** The request is for a one-time payment and the gateway does not take them (`oneTimePayments` is false). */
  WrongProductKind: 'wrong_product_kind',
  /** The request needs a capability (`needs`) the gateway does not have. */
  MissingCapability: 'missing_capability',
  /** None of the payment methods the customer can use is one the gateway offers for this product kind. */
  PaymentMethodUnsupported: 'payment_method_unsupported',
  /** The merchant listed the gateway in the request's `exclude`. */
  ExcludedByMerchant: 'excluded_by_merchant',
  /** The circuit breaker is open: the gateway kept answering `unavailable` and its cooldown has not passed. */
  Unhealthy: 'unhealthy',
  /** The amount is above the `maxAmount` the strategy sets for the gateway. */
  AboveMaxAmount: 'above_max_amount',
  /** The amount is below the `minAmount` the strategy sets for the gateway. */
  BelowMinAmount: 'below_min_amount',
} as const;
export type RouteExclusion = (typeof RouteExclusion)[keyof typeof RouteExclusion];

/** What an outcome reported to `Router.record` is about. */
export const RouteOutcomeKind = {
  /** A customer's attempt to authorise a mandate (the first step of a subscription). */
  Authorization: 'authorization',
  /** A recurring debit on an existing mandate. */
  Charge: 'charge',
  /** A one-time payment. */
  Payment: 'payment',
  /** An API call to the gateway that is not one of the above (creating a plan, an order, a subscription). */
  Request: 'request',
} as const;
export type RouteOutcomeKind = (typeof RouteOutcomeKind)[keyof typeof RouteOutcomeKind];

/** How an attempt ended, as far as routing is concerned. */
export const RouteOutcomeResult = {
  /** The gateway did what was asked. */
  Success: 'success',
  /** The gateway answered and the attempt did not succeed (a declined card, a refused mandate, a validation error). It says nothing about the gateway being down. */
  Failure: 'failure',
  /** The gateway could not be reached or answered with an outage-class error (HTTP 5xx, timeout, network). Feeds the circuit breaker. */
  Unavailable: 'unavailable',
} as const;
export type RouteOutcomeResult = (typeof RouteOutcomeResult)[keyof typeof RouteOutcomeResult];

/** State of one gateway's circuit breaker. */
export const CircuitState = {
  /** Normal: the gateway is a candidate. */
  Closed: 'closed',
  /** The failure threshold was reached and the cooldown has not passed: the gateway is excluded. */
  Open: 'open',
  /** The cooldown passed: the gateway is a candidate again. One `unavailable` result reopens it, one `success` closes it. */
  HalfOpen: 'half_open',
} as const;
export type CircuitState = (typeof CircuitState)[keyof typeof CircuitState];

/**
 * The `needs` flags of a request, each named after the capability it requires.
 * Keys are the same strings as the `Capabilities` fields they are checked against.
 */
export const RouteNeed = {
  Trial: 'trial',
  UpfrontAmount: 'upfrontAmount',
  Quantity: 'quantity',
  Pause: 'pause',
  CancelAtPeriodEnd: 'cancelAtPeriodEnd',
  ChangePlan: 'changePlan',
  Refunds: 'refunds',
} as const;
export type RouteNeed = (typeof RouteNeed)[keyof typeof RouteNeed];

// ---------------------------------------------------------------------------
// Defaults (see the design note in `index.ts` for what each one means)
// ---------------------------------------------------------------------------

/** Weight of the success-rate factor in the score. One point of success rate is worth one point of the amount kept after fees. */
export const DEFAULT_WEIGHT_SUCCESS_RATE = 1;
/** Weight of the cost factor (the share of the amount left after the gateway's fee). */
export const DEFAULT_WEIGHT_COST = 1;
/** Weight of the priority factor: a gateway first in the merchant's priority list is worth two points of success rate over an unlisted one. */
export const DEFAULT_WEIGHT_PRIORITY = 0.02;
/** Bonus for the preferred gateway: worth five points of success rate or fee share. */
export const DEFAULT_WEIGHT_PREFER = 0.05;

/** Hours of statistics the observed success rate looks at. */
export const DEFAULT_SUCCESS_WINDOW_HOURS = 24;
/** Observations needed before the observed success rate counts fully; below it the missing observations are filled with the prior. */
export const DEFAULT_MIN_SAMPLES = 20;
/** The success rate assumed for a gateway nothing is known about: optimistic enough to give an untried gateway traffic, below what a healthy gateway delivers. */
export const DEFAULT_PRIOR_SUCCESS_RATE = 0.9;

/** Consecutive `unavailable` results that open a gateway's circuit. */
export const DEFAULT_FAILURE_THRESHOLD = 5;
/** Milliseconds an open circuit waits before it half-opens. */
export const DEFAULT_COOLDOWN_MS = 60_000;

/** Basis points in one whole (100%): fees are `percentBps / BPS_PER_WHOLE` of the amount. */
export const BPS_PER_WHOLE = 10_000;

/** Width of one statistics bucket: one hour in milliseconds. */
export const STATS_BUCKET_MS = 60 * 60 * 1000;
/** How long the in-memory statistics store keeps hourly buckets. It must be at least the window routing looks at. */
export const DEFAULT_MEMORY_RETENTION_HOURS = 7 * 24;

/** Decimal places a score is rounded to, so floating point noise never decides a ranking. */
export const SCORE_PRECISION = 1e9;
