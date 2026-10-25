/**
 * The service's PostgreSQL connection: loads the driver on demand, opens a pool, migrates the schema, and builds the three
 * stores over it. Nothing here is imported unless `DATABASE_URL` is set, and the driver (`pg`) is an optional peer
 * dependency, so a service on files never needs it.
 *
 * The connection string is a secret. Messages carry the variable name, the package name and the driver's error code
 * (`ECONNREFUSED`, `28P01`), never the string, a host, or the driver's own message.
 */
import { ErrorCode } from './constants.js';
import { SubscriptionError } from './errors.js';
import { migratePostgres, PostgresPurchaseStore, PostgresRoutingStatsStore, PostgresSchedulerStore } from './postgres/index.js';
import type { PostgresPool } from './postgres/index.js';
import { EnvVar, type DatabaseConfig } from './service-config.js';

/** The npm package the service loads to talk to PostgreSQL. */
export const DATABASE_DRIVER_PACKAGE = 'pg';

/** How long a new connection may take before the start-up fails, in milliseconds. */
export const DATABASE_CONNECT_TIMEOUT_MS = 10_000;

/** Node's and CommonJS's codes for a package that is not installed. */
const MODULE_NOT_FOUND_CODES: readonly string[] = ['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'];

/** What a driver error code looks like: an errno name (`ECONNREFUSED`) or a SQLSTATE (`28P01`). */
const ERROR_CODE_PATTERN = /^[A-Za-z0-9_]{1,40}$/;

/** Loads the PostgreSQL driver module. Tests pass their own; the default is `import('pg')`. */
export type DriverImporter = () => Promise<unknown>;

/** The module is named through a variable so no bundler or type checker needs the package to be present. */
export const importDatabaseDriver: DriverImporter = () => import(DATABASE_DRIVER_PACKAGE);

/** What the service needs from a pool beyond the store interface: a listener for background failures and a way to close. */
export interface DatabasePool extends PostgresPool {
  on(event: 'error', listener: (error: unknown) => void): unknown;
  end(): Promise<void>;
}

type PoolConstructor = new (config: { connectionString: string; max: number; connectionTimeoutMillis: number }) => DatabasePool;

/** An open, migrated database and the three stores on it. */
export interface Database {
  readonly scheduler: PostgresSchedulerStore;
  readonly purchases: PostgresPurchaseStore;
  readonly routingStats: PostgresRoutingStatsStore;
  /** Closes the pool: waits for checked-out connections to be returned, then disconnects. Safe to call twice. */
  close(): Promise<void>;
}

export interface OpenDatabaseOptions {
  importDriver?: DriverImporter;
  /** Told about a connection that failed while idle. Receives a message free of the connection string. */
  onPoolError?: (message: string) => void;
}

/**
 * Loads the driver, opens the pool, checks that the database answers, and runs the migrations. Rejects with `CONFIG` when
 * the driver is missing or the schema belongs to a newer version of this library, and with `INTERNAL_ERROR` when the
 * database cannot be reached or the migration fails; the pool is closed first in every failing case.
 */
export async function openDatabase(config: DatabaseConfig, options: OpenDatabaseOptions = {}): Promise<Database> {
  const Pool = await loadPoolConstructor(options.importDriver ?? importDatabaseDriver);

  let pool: DatabasePool;
  try {
    pool = new Pool({ connectionString: config.url, max: config.poolSize, connectionTimeoutMillis: DATABASE_CONNECT_TIMEOUT_MS });
  } catch {
    // The driver's parse error can quote the string it was given.
    throw new SubscriptionError(ErrorCode.Config, `${EnvVar.DatabaseUrl}: the PostgreSQL driver could not use this connection string`);
  }
  // An idle connection that the server drops emits `error` on the pool; unhandled it would end the process.
  pool.on('error', (error) => options.onPoolError?.(`a database connection failed (${codeOf(error)}); it was removed from the pool`));

  const storeOptions = { schema: config.schema, tablePrefix: config.tablePrefix };
  try {
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      throw new SubscriptionError(
        ErrorCode.Internal,
        `Cannot connect to the PostgreSQL database named by ${EnvVar.DatabaseUrl} (${codeOf(error)}): check the address, the credentials and that the database accepts connections from this host`,
      );
    }
    try {
      await migratePostgres(pool, storeOptions);
    } catch (error) {
      if (error instanceof SubscriptionError && error.code === ErrorCode.Config) throw error;
      throw new SubscriptionError(
        ErrorCode.Internal,
        `The PostgreSQL migration failed (${codeOf(error instanceof SubscriptionError ? error.cause : error)}): check that the role in ${EnvVar.DatabaseUrl} may create tables in the schema`,
      );
    }
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }

  let closing: Promise<void> | undefined;
  return {
    scheduler: new PostgresSchedulerStore(pool, storeOptions),
    purchases: new PostgresPurchaseStore(pool, storeOptions),
    routingStats: new PostgresRoutingStatsStore(pool, storeOptions),
    close: () => (closing ??= pool.end().catch(() => undefined)),
  };
}

async function loadPoolConstructor(importDriver: DriverImporter): Promise<PoolConstructor> {
  let loaded: unknown;
  try {
    loaded = await importDriver();
  } catch (error) {
    const code = codeOf(error);
    const missing = MODULE_NOT_FOUND_CODES.includes(code);
    throw new SubscriptionError(
      ErrorCode.Config,
      missing
        ? `${EnvVar.DatabaseUrl} is set, but the PostgreSQL driver is not installed: run \`npm install ${DATABASE_DRIVER_PACKAGE}\` next to india-subscriptions`
        : `${EnvVar.DatabaseUrl} is set, but the PostgreSQL driver "${DATABASE_DRIVER_PACKAGE}" could not be loaded (${code}): reinstall it with \`npm install ${DATABASE_DRIVER_PACKAGE}\``,
    );
  }
  // CommonJS `pg` seen from ESM: the class is on the namespace, and also on `default`.
  const candidates = [loaded, (loaded as { default?: unknown } | null | undefined)?.default];
  for (const candidate of candidates) {
    const pool = (candidate as { Pool?: unknown } | null | undefined)?.Pool;
    if (typeof pool === 'function') return pool as PoolConstructor;
  }
  throw new SubscriptionError(
    ErrorCode.Config,
    `${EnvVar.DatabaseUrl} is set, but the module "${DATABASE_DRIVER_PACKAGE}" has no Pool: install the real PostgreSQL driver with \`npm install ${DATABASE_DRIVER_PACKAGE}\``,
  );
}

/** The `code` of a driver or system error when it is short and plain, else `unknown`. */
function codeOf(error: unknown): string {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && ERROR_CODE_PATTERN.test(code) ? code : 'unknown';
}
