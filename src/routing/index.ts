/**
 * # Gateway router
 *
 * Chooses the payment gateway for a new subscription or one-time payment. It
 * is pure decision logic plus a small statistics store: it never calls a
 * gateway, and it never moves an existing mandate. A mandate stays at the
 * gateway that created it; to keep a returning customer there, pass that
 * gateway as `prefer`.
 *
 * ## What "best" means
 *
 * First the hard filters remove every gateway that cannot do the job. Each
 * is a named `RouteExclusion` and a gateway can fail several: the wrong
 * product kind (no one-time payments), a `needs` capability it lacks, no
 * overlap between the customer's payment methods and its own, a merchant
 * `exclude`, an open circuit breaker, and the merchant's `minAmount` /
 * `maxAmount` for the gateway. Only providers of kind `gateway` are ever
 * candidates. Then every survivor gets a score, and the highest wins:
 *
 *     score = weights.successRate * successRate
 *           + weights.cost        * costFactor
 *           + weights.priority    * priorityFactor
 *           + (provider === prefer ? weights.prefer : 0)
 *
 * The first two factors are on the same scale (a fraction of the amount that
 * arrives), so with equal weights a point of success rate is worth a point of
 * fee. Defaults, all overridable in `RoutingStrategy`:
 *
 * - **successRate** (weight 1). Successes over all observations of the last
 *   24 hours (`windowHours`), counting `success`, `failure` and `unavailable`.
 *   Subscriptions use the `authorization` and `charge` outcomes, one-time
 *   payments use `payment`. Below 20 observations (`minSamples`) the missing
 *   ones are filled in with a prior of 0.9 (`priorRate`), so a gateway nothing
 *   is known about scores the prior, an untried gateway still gets traffic, and
 *   confidence builds gradually instead of jumping at the threshold. When the
 *   request names payment methods, the rate is the one observed for those
 *   methods, with its own missing observations filled in with the gateway-wide
 *   rate. A recorded failure can only lower a gateway's score.
 * - **cost** (weight 1). `1 - fee / amount`, where the fee is
 *   `ceil(amount * percentBps / 10000) + fixedPaise` from the merchant's cost
 *   table (a per-method fee replaces the gateway's own; with several possible
 *   methods the fees are averaged). A gateway without an entry costs
 *   `defaultCost`, which is zero.
 * - **priority** (weight 0.02). 1 for the first gateway in the merchant's
 *   priority list, falling in equal steps to the last, 0 for unlisted ones.
 * - **prefer** (bonus 0.05). Added to the gateway named in the request. It
 *   cannot revive a gateway a hard filter removed.
 *
 * Equal scores (rounded to 9 decimals) are ordered by merchant priority, then
 * by provider name, so the same inputs always give the same decision. Every
 * candidate in the decision carries either its exclusions with a readable
 * reason each, or its score and factors. When no gateway is eligible, `route`
 * rejects with `NO_ROUTE` and a message listing why each one was excluded.
 *
 * ## Circuit breaker
 *
 * `record` reports each outcome. `failureThreshold` (default 5) consecutive
 * `unavailable` results open a gateway's circuit and exclude it for
 * `cooldownMs` (default 60 seconds). After that it is half-open: a candidate
 * again, with `healthy: false` in its factors. The next `unavailable` result
 * reopens it for another cooldown; the next `success` closes it. A `failure`
 * (a declined card) does not move the breaker. While half-open, every request
 * may go to the gateway until an outcome is recorded, so a busy deployment can
 * send several probes at once. Breaker state lives in the router's memory: each
 * process learns about outages from its own traffic, and a restart starts with
 * every circuit closed. Success rates, by contrast, are shared through the
 * statistics store.
 *
 * ## What it deliberately does not do
 *
 * - It does not call gateways, check their status pages or probe them.
 * - It never moves an existing mandate or subscription to another gateway.
 * - It does not know any regulatory limit. Amount bounds come from the
 *   strategy, so the merchant states, per gateway, the ceiling its mandates
 *   allow.
 * - It does not retry: `ranked` is the fallback order, and the caller tries the
 *   next gateway when creating the purchase fails.
 * - It does not fail a request because the statistics store is down; it routes
 *   as if nothing had been observed and reports the error to `onStatsError`.
 */
export * from './constants.js';
export * from './schemas.js';
export { Router, type RouterOptions } from './router.js';
export type { RoutingStatsStore } from './stats-store.js';
export { statsBucketStart } from './stats-store.js';
export { MemoryRoutingStatsStore, type MemoryRoutingStatsStoreOptions } from './memory-stats-store.js';
