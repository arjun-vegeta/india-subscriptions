import { DEFAULT_MEMORY_RETENTION_HOURS, STATS_BUCKET_MS, RouteOutcomeResult } from './constants.js';
import type { RoutingStatsKey, RoutingStatsTotals } from './schemas.js';
import { bucketStartMs, type RoutingStatsStore } from './stats-store.js';

export interface MemoryRoutingStatsStoreOptions {
  /**
   * Hours of buckets to keep. Older buckets are dropped as new increments
   * arrive. Must exceed the strategy's `windowHours`. Default 168 (seven days).
   */
  retentionHours?: number;
}

/**
 * A correct in-memory `RoutingStatsStore` for tests and development: hourly
 * UTC buckets, atomic increments (single-threaded, no await inside), totals
 * copied on read. State is lost when the process exits and is not shared
 * between processes: use a real database when several workers route.
 */
export class MemoryRoutingStatsStore implements RoutingStatsStore {
  private readonly series = new Map<string, Map<number, RoutingStatsTotals>>();
  private readonly retentionMs: number;
  private newest = Number.NEGATIVE_INFINITY;

  constructor(options: MemoryRoutingStatsStoreOptions = {}) {
    this.retentionMs = (options.retentionHours ?? DEFAULT_MEMORY_RETENTION_HOURS) * STATS_BUCKET_MS;
  }

  async increment(key: RoutingStatsKey, result: RouteOutcomeResult, at: string): Promise<void> {
    const bucket = bucketStartMs(at);
    const id = seriesId(key);
    let buckets = this.series.get(id);
    if (!buckets) {
      buckets = new Map();
      this.series.set(id, buckets);
    }
    const totals = buckets.get(bucket) ?? { success: 0, failure: 0, unavailable: 0 };
    totals[result] += 1;
    buckets.set(bucket, totals);
    if (bucket > this.newest) {
      this.newest = bucket;
      this.prune();
    }
  }

  async read(key: RoutingStatsKey, since: string): Promise<RoutingStatsTotals> {
    const from = bucketStartMs(since);
    const sum: RoutingStatsTotals = { success: 0, failure: 0, unavailable: 0 };
    for (const [bucket, totals] of this.series.get(seriesId(key)) ?? []) {
      if (bucket < from) continue;
      sum[RouteOutcomeResult.Success] += totals.success;
      sum[RouteOutcomeResult.Failure] += totals.failure;
      sum[RouteOutcomeResult.Unavailable] += totals.unavailable;
    }
    return sum;
  }

  private prune(): void {
    const oldest = this.newest - this.retentionMs;
    for (const [id, buckets] of this.series) {
      for (const bucket of buckets.keys()) if (bucket < oldest) buckets.delete(bucket);
      if (buckets.size === 0) this.series.delete(id);
    }
  }
}

function seriesId(key: RoutingStatsKey): string {
  return JSON.stringify([key.provider, key.kind, key.paymentMethod ?? null]);
}
