/**
 * # PostgreSQL stores
 *
 * The scheduler, purchase and routing-statistics stores on PostgreSQL, for several servers that share one database.
 * No driver is bundled: pass a `pg.Pool` (or anything with `query(text, values)` and `connect()`).
 *
 * ```ts
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * await migratePostgres(pool);
 * const scheduler = new BillingScheduler({ store: new PostgresSchedulerStore(pool), ... });
 * ```
 *
 * Run `migratePostgres` at every start-up: it is versioned, idempotent and safe when several instances do it at once.
 */
export type {
  PostgresConnection,
  PostgresPool,
  PostgresQueryable,
  PostgresQueryResult,
  PostgresStoreOptions,
} from './client.js';
export { DEFAULT_SCHEMA, DEFAULT_TABLE_PREFIX, PostgresTable } from './constants.js';
export { LATEST_MIGRATION_VERSION, migratePostgres, type MigrationResult } from './migrate.js';
export { PostgresPurchaseStore } from './purchase-store.js';
export { PostgresSchedulerStore } from './scheduler-store.js';
export { PostgresRoutingStatsStore, type PostgresRoutingStatsStoreOptions } from './stats-store.js';
