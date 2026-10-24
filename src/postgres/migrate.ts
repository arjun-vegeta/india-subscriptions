import { ErrorCode } from '../constants.js';
import { SubscriptionError } from '../errors.js';
import type { PostgresConnection, PostgresPool, PostgresStoreOptions } from './client.js';
import { MIGRATION_LOCK_NAME, PostgresIndex, PostgresTable } from './constants.js';
import { resolveNames, type PostgresNames } from './names.js';

/** One schema change: a version number, a name, and the statements that make it. Never edit a shipped one; add the next. */
interface Migration {
  readonly version: number;
  readonly name: string;
  readonly statements: (names: PostgresNames) => string[];
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'scheduler, purchase and routing tables',
    statements: (n) => {
      const t = n.table;
      const i = n.index;
      return [
        // Scheduler. Every record is kept whole in `record`; the other columns are what the store queries by.
        // `COLLATE "C"` makes `ORDER BY id` the same on every database, whatever its locale.
        `CREATE TABLE IF NOT EXISTS ${t(PostgresTable.Schedules)} (
           id              text COLLATE "C" PRIMARY KEY,
           provider        text        NOT NULL,
           subscription_id text        NOT NULL,
           next_action_at  timestamptz,
           created_at      timestamptz NOT NULL,
           record          jsonb       NOT NULL
         )`,
        `CREATE INDEX IF NOT EXISTS ${i(PostgresIndex.SchedulesSubscription)}
           ON ${t(PostgresTable.Schedules)} (provider, subscription_id, created_at DESC)`,
        `CREATE INDEX IF NOT EXISTS ${i(PostgresIndex.SchedulesDue)}
           ON ${t(PostgresTable.Schedules)} (next_action_at, id) WHERE next_action_at IS NOT NULL`,
        `CREATE TABLE IF NOT EXISTS ${t(PostgresTable.Cycles)} (
           schedule_id        text COLLATE "C" NOT NULL,
           idx                integer NOT NULL,
           charge_id          text,
           provider_charge_id text,
           record             jsonb   NOT NULL,
           PRIMARY KEY (schedule_id, idx)
         )`,
        `CREATE INDEX IF NOT EXISTS ${i(PostgresIndex.CyclesCharge)}
           ON ${t(PostgresTable.Cycles)} (charge_id) WHERE charge_id IS NOT NULL`,
        `CREATE INDEX IF NOT EXISTS ${i(PostgresIndex.CyclesProviderCharge)}
           ON ${t(PostgresTable.Cycles)} (provider_charge_id) WHERE provider_charge_id IS NOT NULL`,
        `CREATE TABLE IF NOT EXISTS ${t(PostgresTable.ScheduleLocks)} (
           key        text        PRIMARY KEY,
           token      text        NOT NULL,
           expires_at timestamptz NOT NULL
         )`,

        // Purchases.
        `CREATE TABLE IF NOT EXISTS ${t(PostgresTable.Sessions)} (
           id              text COLLATE "C" PRIMARY KEY,
           customer_ref    text        NOT NULL,
           reference       text        NOT NULL,
           created_at      timestamptz NOT NULL,
           provider        text,
           subscription_id text,
           payment_id      text,
           option_keys     text[]      NOT NULL,
           record          jsonb       NOT NULL
         )`,
        `CREATE INDEX IF NOT EXISTS ${i(PostgresIndex.SessionsReference)}
           ON ${t(PostgresTable.Sessions)} (customer_ref, reference, created_at DESC)`,
        `CREATE INDEX IF NOT EXISTS ${i(PostgresIndex.SessionsOptionKeys)}
           ON ${t(PostgresTable.Sessions)} USING gin (option_keys)`,
        `CREATE INDEX IF NOT EXISTS ${i(PostgresIndex.SessionsSubscription)}
           ON ${t(PostgresTable.Sessions)} (provider, subscription_id) WHERE subscription_id IS NOT NULL`,
        `CREATE INDEX IF NOT EXISTS ${i(PostgresIndex.SessionsPayment)}
           ON ${t(PostgresTable.Sessions)} (provider, payment_id) WHERE payment_id IS NOT NULL`,
        `CREATE TABLE IF NOT EXISTS ${t(PostgresTable.Entitlements)} (
           id              text COLLATE "C" PRIMARY KEY,
           customer_ref    text        NOT NULL,
           provider        text        NOT NULL,
           subscription_id text,
           payment_id      text,
           updated_at      timestamptz NOT NULL,
           record          jsonb       NOT NULL
         )`,
        `CREATE INDEX IF NOT EXISTS ${i(PostgresIndex.EntitlementsCustomer)}
           ON ${t(PostgresTable.Entitlements)} (customer_ref, updated_at DESC)`,
        `CREATE INDEX IF NOT EXISTS ${i(PostgresIndex.EntitlementsSubscription)}
           ON ${t(PostgresTable.Entitlements)} (provider, subscription_id) WHERE subscription_id IS NOT NULL`,
        `CREATE INDEX IF NOT EXISTS ${i(PostgresIndex.EntitlementsPayment)}
           ON ${t(PostgresTable.Entitlements)} (provider, payment_id) WHERE payment_id IS NOT NULL`,
        `CREATE TABLE IF NOT EXISTS ${t(PostgresTable.Reports)} (
           id              text COLLATE "C" PRIMARY KEY,
           status          text        NOT NULL,
           due_by          timestamptz NOT NULL,
           next_attempt_at timestamptz NOT NULL,
           lease_token     text,
           lease_until     timestamptz,
           record          jsonb       NOT NULL
         )`,
        `CREATE INDEX IF NOT EXISTS ${i(PostgresIndex.ReportsClaim)}
           ON ${t(PostgresTable.Reports)} (status, due_by, id)`,
        `CREATE TABLE IF NOT EXISTS ${t(PostgresTable.PurchaseLocks)} (
           key        text        PRIMARY KEY,
           token      text        NOT NULL,
           expires_at timestamptz NOT NULL
         )`,

        // Routing statistics: one row per series and UTC hour. An empty `payment_method` is the gateway-wide series.
        `CREATE TABLE IF NOT EXISTS ${t(PostgresTable.RoutingStats)} (
           provider       text        NOT NULL,
           kind           text        NOT NULL,
           payment_method text        NOT NULL,
           bucket         timestamptz NOT NULL,
           success        bigint      NOT NULL DEFAULT 0,
           failure        bigint      NOT NULL DEFAULT 0,
           unavailable    bigint      NOT NULL DEFAULT 0,
           PRIMARY KEY (provider, kind, payment_method, bucket)
         )`,
      ];
    },
  },
];

/** The highest version this library knows how to create. */
export const LATEST_MIGRATION_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/** What `migratePostgres` did. */
export interface MigrationResult {
  /** The versions applied by this call, in order. Empty when the schema was already current (or another instance just did it). */
  applied: number[];
  /** The schema version after the call. */
  version: number;
}

/**
 * Creates or upgrades the tables of all three stores. Versioned, idempotent and safe to run from every instance at
 * start-up at once.
 *
 * Everything happens in one transaction that first takes `pg_advisory_xact_lock` on a key derived from the schema
 * name, so concurrent migrators queue up instead of racing on `CREATE TABLE` (which can fail with a unique violation
 * in the catalog when two sessions create the same table at the same moment). The ones that wait find the versions
 * already recorded and do nothing. A failure rolls the whole transaction back, so the schema is never half-migrated.
 *
 * Throws `CONFIG` when the database was migrated by a newer version of this library: upgrade the library instead of
 * running old code against a newer schema. `CREATE SCHEMA` is only attempted when the schema is missing, so a role
 * without that privilege can run it against a schema an administrator created.
 */
export async function migratePostgres(pool: PostgresPool, options: PostgresStoreOptions = {}): Promise<MigrationResult> {
  const names = resolveNames(options);
  const migrations = names.table(PostgresTable.Migrations);
  let connection: PostgresConnection;
  try {
    connection = await pool.connect();
  } catch (cause) {
    throw failure(cause);
  }
  let destroy = false;
  try {
    await connection.query('BEGIN');
    try {
      await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [
        `${MIGRATION_LOCK_NAME}/${names.schemaName}`,
      ]);
      const existing = await connection.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [names.schemaName]);
      if (existing.rows.length === 0) await connection.query(`CREATE SCHEMA ${names.schema}`);
      await connection.query(
        `CREATE TABLE IF NOT EXISTS ${migrations} (
           version    integer     PRIMARY KEY,
           name       text        NOT NULL,
           applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
         )`,
      );
      const done = await connection.query(`SELECT version FROM ${migrations}`);
      const recorded = new Set(done.rows.map((row) => Number(row['version'])));
      const newest = Math.max(0, ...recorded);
      if (newest > LATEST_MIGRATION_VERSION) {
        throw new SubscriptionError(
          ErrorCode.Config,
          `The PostgreSQL schema is at version ${newest}, newer than the ${LATEST_MIGRATION_VERSION} this version of ` +
            'india-subscriptions knows: upgrade the library',
        );
      }
      const applied: number[] = [];
      for (const migration of MIGRATIONS) {
        if (recorded.has(migration.version)) continue;
        for (const statement of migration.statements(names)) await connection.query(statement);
        await connection.query(`INSERT INTO ${migrations} (version, name) VALUES ($1, $2)`, [migration.version, migration.name]);
        applied.push(migration.version);
      }
      await connection.query('COMMIT');
      return { applied, version: Math.max(newest, LATEST_MIGRATION_VERSION) };
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => {
        destroy = true;
      });
      throw error;
    }
  } catch (error) {
    throw error instanceof SubscriptionError ? error : failure(error);
  } finally {
    connection.release(destroy);
  }
}

function failure(cause: unknown): SubscriptionError {
  return new SubscriptionError(ErrorCode.Internal, 'The PostgreSQL migration failed', { cause });
}
