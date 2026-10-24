/**
 * Typed constants of the PostgreSQL stores. Same pattern as `src/constants.ts`: a name is written once, here.
 */

/** The schema the tables live in unless `schema` says otherwise. */
export const DEFAULT_SCHEMA = 'public';

/** Prepended to every table and index name unless `tablePrefix` says otherwise. */
export const DEFAULT_TABLE_PREFIX = 'india_subscriptions_';

/** PostgreSQL keeps at most this many bytes of an identifier and silently truncates the rest (`NAMEDATALEN` - 1). */
export const MAX_IDENTIFIER_BYTES = 63;

/** What a schema name or a table prefix may look like: letters, digits and underscores, not starting with a digit. */
export const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The tables, by the name they carry after the prefix. */
export const PostgresTable = {
  Migrations: 'migrations',
  Schedules: 'schedules',
  Cycles: 'cycles',
  ScheduleLocks: 'schedule_locks',
  Sessions: 'sessions',
  Entitlements: 'entitlements',
  Reports: 'reports',
  PurchaseLocks: 'purchase_locks',
  RoutingStats: 'routing_stats',
} as const;
export type PostgresTable = (typeof PostgresTable)[keyof typeof PostgresTable];

/** Indexes, by the suffix they carry after their table's name. */
export const PostgresIndex = {
  SchedulesSubscription: 'schedules_subscription_idx',
  SchedulesDue: 'schedules_due_idx',
  CyclesCharge: 'cycles_charge_idx',
  CyclesProviderCharge: 'cycles_provider_charge_idx',
  SessionsReference: 'sessions_reference_idx',
  SessionsOptionKeys: 'sessions_option_keys_idx',
  SessionsSubscription: 'sessions_subscription_idx',
  SessionsPayment: 'sessions_payment_idx',
  EntitlementsCustomer: 'entitlements_customer_idx',
  EntitlementsSubscription: 'entitlements_subscription_idx',
  EntitlementsPayment: 'entitlements_payment_idx',
  ReportsClaim: 'reports_claim_idx',
} as const;
export type PostgresIndex = (typeof PostgresIndex)[keyof typeof PostgresIndex];

/** PostgreSQL error codes (SQLSTATE) the stores react to. */
export const SqlState = {
  /** `undefined_table`: the migration has not run. */
  UndefinedTable: '42P01',
  /** `serialization_failure`: a concurrent update under REPEATABLE READ or SERIALIZABLE. */
  SerializationFailure: '40001',
} as const;
export type SqlState = (typeof SqlState)[keyof typeof SqlState];

/** Separates the provider from the handle in an entry of `option_keys` (a provider id never contains it). */
export const OPTION_KEY_SEPARATOR = ':';

/** Default hours of routing statistics kept: seven days, the minimum the interface recommends. */
export const DEFAULT_STATS_RETENTION_HOURS = 168;

/** The shortest retention accepted: the router's default window (24 hours) plus one hour of bucket rounding. */
export const MIN_STATS_RETENTION_HOURS = 25;

/** A process prunes old statistics at most this often (milliseconds). */
export const STATS_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** Separates parts of the advisory lock name that serialises migrations. */
export const MIGRATION_LOCK_NAME = 'india-subscriptions/migrate';
