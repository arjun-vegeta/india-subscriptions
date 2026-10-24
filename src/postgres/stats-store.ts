import { ErrorCode } from '../constants.js';
import { SubscriptionError } from '../errors.js';
import { RouteOutcomeResult } from '../routing/constants.js';
import type { RoutingStatsKey, RoutingStatsTotals } from '../routing/schemas.js';
import { statsBucketStart, type RoutingStatsStore } from '../routing/stats-store.js';
import type { PostgresQueryable, PostgresStoreOptions } from './client.js';
import {
  DEFAULT_STATS_RETENTION_HOURS,
  MIN_STATS_RETENTION_HOURS,
  PostgresTable,
  STATS_PRUNE_INTERVAL_MS,
} from './constants.js';
import { Database } from './database.js';
import { resolveNames } from './names.js';

const OWNER = 'PostgreSQL routing statistics store';

/** The `payment_method` of the gateway-wide series: no payment method is a real method named like this. */
const NO_PAYMENT_METHOD = '';

export interface PostgresRoutingStatsStoreOptions extends PostgresStoreOptions {
  /**
   * Hours of buckets to keep. Older buckets are deleted by `prune()`, which `increment` calls at most once an hour
   * per process. At least 25: the router's default window (24 hours) plus one hour of bucket rounding. Default 168
   * (seven days).
   */
  retentionHours?: number;
}

/** How much each result adds to the three counters, in the order success, failure, unavailable. */
const INCREMENTS = {
  [RouteOutcomeResult.Success]: [1, 0, 0],
  [RouteOutcomeResult.Failure]: [0, 1, 0],
  [RouteOutcomeResult.Unavailable]: [0, 0, 1],
} as const satisfies Record<RouteOutcomeResult, readonly [number, number, number]>;

/**
 * A `RoutingStatsStore` on PostgreSQL, for several servers sharing one database. Create the tables with
 * `migratePostgres` first. Pass a `pg.Pool` (or anything shaped like it).
 *
 * - **Atomic increments.** `increment` is one `INSERT ... ON CONFLICT (series, bucket) DO UPDATE SET n = n + 1`.
 *   PostgreSQL serialises concurrent updates of the same row, so none is lost or counted twice.
 * - **Buckets** are the UTC hour of the instant, computed with `statsBucketStart` (the same function every store
 *   uses) and stored as a `timestamptz`. `read` sums whole buckets at or after the bucket of `since`, in the database.
 * - **Keys are independent series.** The gateway-wide series is stored under an empty payment method and is never
 *   derived from the per-method series.
 * - **Clocks.** The instants are the caller's (`at`, `since`). The only clock the store reads itself is the
 *   database's, to decide which buckets are old enough to delete in `prune()`.
 */
export class PostgresRoutingStatsStore implements RoutingStatsStore {
  private readonly database: Database;
  private readonly table: string;
  private readonly retentionHours: number;
  private lastPrune = 0;

  constructor(db: PostgresQueryable, options: PostgresRoutingStatsStoreOptions = {}) {
    const names = resolveNames(options);
    const retention = options.retentionHours ?? DEFAULT_STATS_RETENTION_HOURS;
    if (!Number.isInteger(retention) || retention < MIN_STATS_RETENTION_HOURS) {
      throw new SubscriptionError(
        ErrorCode.Config,
        `retentionHours must be a whole number of at least ${MIN_STATS_RETENTION_HOURS}`,
      );
    }
    this.database = new Database(db, OWNER);
    this.table = names.table(PostgresTable.RoutingStats);
    this.retentionHours = retention;
  }

  async increment(key: RoutingStatsKey, result: RouteOutcomeResult, at: string): Promise<void> {
    const bucket = statsBucketStart(at);
    const [success, failure, unavailable] = INCREMENTS[result];
    await this.database.rows(
      `INSERT INTO ${this.table} AS stats (provider, kind, payment_method, bucket, success, failure, unavailable)
       VALUES ($1, $2, $3, $4::timestamptz, $5, $6, $7)
       ON CONFLICT (provider, kind, payment_method, bucket) DO UPDATE
         SET success = stats.success + EXCLUDED.success,
             failure = stats.failure + EXCLUDED.failure,
             unavailable = stats.unavailable + EXCLUDED.unavailable`,
      [key.provider, key.kind, key.paymentMethod ?? NO_PAYMENT_METHOD, bucket, success, failure, unavailable],
    );
    await this.pruneSometimes();
  }

  async read(key: RoutingStatsKey, since: string): Promise<RoutingStatsTotals> {
    const [row] = await this.database.rows(
      `SELECT COALESCE(SUM(success), 0)::text     AS success,
              COALESCE(SUM(failure), 0)::text     AS failure,
              COALESCE(SUM(unavailable), 0)::text AS unavailable
       FROM ${this.table}
       WHERE provider = $1 AND kind = $2 AND payment_method = $3 AND bucket >= $4::timestamptz`,
      [key.provider, key.kind, key.paymentMethod ?? NO_PAYMENT_METHOD, statsBucketStart(since)],
    );
    return {
      [RouteOutcomeResult.Success]: count(row?.['success']),
      [RouteOutcomeResult.Failure]: count(row?.['failure']),
      [RouteOutcomeResult.Unavailable]: count(row?.['unavailable']),
    };
  }

  /**
   * Deletes buckets that started more than `retentionHours` ago on the database's clock. Safe to call from any
   * number of workers. Returns how many buckets were deleted.
   */
  async prune(): Promise<number> {
    const rows = await this.database.rows(
      `WITH gone AS (
         DELETE FROM ${this.table}
         WHERE bucket < clock_timestamp() - $1::double precision * interval '1 hour'
         RETURNING 1
       )
       SELECT count(*)::text AS deleted FROM gone`,
      [this.retentionHours],
    );
    return count(rows[0]?.['deleted']);
  }

  private async pruneSometimes(): Promise<void> {
    const now = Date.now();
    if (now - this.lastPrune < STATS_PRUNE_INTERVAL_MS) return;
    this.lastPrune = now;
    // Housekeeping must never fail the observation that was just recorded.
    await this.prune().catch(() => undefined);
  }
}

/** A counter as the driver returns it (text for bigint in `pg`), as a number; refuses one a number cannot hold. */
function count(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new SubscriptionError(ErrorCode.Internal, `The ${OWNER} read a counter that is not a safe integer`);
  }
  return parsed;
}
