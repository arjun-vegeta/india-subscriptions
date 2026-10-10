import { ErrorCode } from '../constants.js';
import { SubscriptionError } from '../errors.js';
import { STATS_BUCKET_MS } from './constants.js';
import type { RouteOutcomeResult } from './constants.js';
import type { RoutingStatsKey, RoutingStatsTotals } from './schemas.js';

/**
 * Persistence for the router's observed outcomes: counters in hourly buckets,
 * read back over a rolling window. Implement it on any database or cache; a
 * bucket is `(key, hour, success, failure, unavailable)`.
 *
 * Routing only needs the figures to be roughly right (a success rate over a
 * day), so the guarantees are lighter than the scheduler's, but these are
 * required:
 *
 * - **Increments are atomic and additive.** Many workers, in many processes,
 *   call `increment` for the same key and hour at once; none may be lost and
 *   none counted twice (`INSERT ... ON CONFLICT DO UPDATE SET n = n + 1`,
 *   `HINCRBY`, an atomic `ADD` update). A read-modify-write without a lock or a
 *   conditional write is not acceptable.
 * - **Buckets are UTC hours.** The bucket of an instant is that instant
 *   truncated to the hour (`statsBucketStart`). Use exactly these boundaries so
 *   a window reads the same on every implementation. An increment for an
 *   instant in the past goes to that instant's own bucket; the store does not
 *   require increments to arrive in time order.
 * - **Reads sum whole buckets.** `read(key, since)` adds up every bucket of the
 *   key whose start is at or after `statsBucketStart(since)`; there is no upper
 *   bound. So the window is rounded out to the hour: an observation up to one
 *   hour older than `since` may still be counted, never one newer than it left out.
 * - **A key nobody wrote returns zeros**, never `undefined` and never an error.
 * - **Keys are independent series.** `(provider, kind)` without a payment method
 *   is the gateway-wide series; the store never derives it from the per-method
 *   series. The router writes both.
 * - **A resolved `increment` is visible to later reads** from the same process.
 *   Reads served by a replica may lag a little: that only delays learning, it
 *   must never double count.
 * - **Copy on read.** The returned totals belong to the caller.
 * - **Retention.** A store may delete buckets older than a retention it
 *   chooses, but not buckets inside the window the router reads (the strategy's
 *   `windowHours`, default 24 hours, plus one hour of rounding). Seven days is a
 *   comfortable minimum; `MemoryRoutingStatsStore` keeps seven days.
 */
export interface RoutingStatsStore {
  /** Adds one observation to the bucket of `at` (a UTC ISO-8601 instant) for `key`. Durable when it resolves. */
  increment(key: RoutingStatsKey, result: RouteOutcomeResult, at: string): Promise<void>;

  /** The counts of every bucket of `key` that starts at or after `statsBucketStart(since)`. */
  read(key: RoutingStatsKey, since: string): Promise<RoutingStatsTotals>;
}

/**
 * The start of the UTC hour that contains `at`, as an ISO-8601 instant. Every
 * implementation of `RoutingStatsStore` buckets by this function.
 */
export function statsBucketStart(at: string): string {
  return new Date(bucketStartMs(at)).toISOString();
}

/** `statsBucketStart` as epoch milliseconds. Throws `VALIDATION` for a value that is not an instant. */
export function bucketStartMs(at: string): number {
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) {
    throw new SubscriptionError(ErrorCode.Validation, `Invalid instant for routing statistics: ${at}`);
  }
  return ms - mod(ms, STATS_BUCKET_MS);
}

function mod(value: number, by: number): number {
  return ((value % by) + by) % by;
}
