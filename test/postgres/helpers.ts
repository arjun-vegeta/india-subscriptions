import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe } from 'vitest';
import { migratePostgres, PostgresTable, type PostgresPool, type PostgresStoreOptions } from '../../src/postgres/index.js';

/** The database the PostgreSQL tests run against. Unset: the tests are reported as skipped. `npm run test:postgres` sets it. */
export const DATABASE_URL = process.env['TEST_DATABASE_URL'];

/** `describe` when a database is available, `describe.skip` (shown as skipped in the report) when it is not. */
export function describePostgres(name: string, body: () => void): void {
  (DATABASE_URL ? describe : describe.skip)(name, body);
}

/** Prefix of the schemas the tests create; every test file makes its own and drops it when it finishes. */
const SCHEMA_PREFIX = 'ffu4_test_';

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function newPool(options: pg.PoolConfig = {}): pg.Pool {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4, ...options });
  // An idle connection can fail in the background; the tests that cause it assert on the effect.
  pool.on('error', () => undefined);
  return pool;
}

export function uniqueName(prefix: string): string {
  return `${prefix}${randomBytes(6).toString('hex')}`;
}

export interface TestDatabase {
  /** A pool for ordinary use. */
  readonly pool: pg.Pool;
  /** The schema this test file owns. */
  readonly schema: string;
  readonly options: PostgresStoreOptions;
  /** A new pool of its own: its own connections, closed by the fixture at the end of the file. */
  separatePool(config?: pg.PoolConfig): pg.Pool;
  /** Several independent pools of one connection each: concurrent callers that share nothing. */
  separateConnections(count: number): PostgresPool[];
  /** Empties every table the stores use, so each test starts from nothing. */
  reset(): Promise<void>;
}

/**
 * Registers hooks that create this file's schema and tables, and drop them again. Call it inside
 * `describePostgres(...)` so nothing runs when there is no database.
 */
export function useDatabase(): TestDatabase {
  const pools: pg.Pool[] = [];
  const state = {} as { pool: pg.Pool; schema: string; options: PostgresStoreOptions };

  const database: TestDatabase = {
    get pool() {
      return state.pool;
    },
    get schema() {
      return state.schema;
    },
    get options() {
      return state.options;
    },
    separatePool(config = {}) {
      const pool = newPool(config);
      pools.push(pool);
      return pool;
    },
    separateConnections(count) {
      return Array.from({ length: count }, () => database.separatePool({ max: 1 }));
    },
    async reset() {
      const tables = Object.values(PostgresTable)
        .filter((table) => table !== PostgresTable.Migrations)
        .map((table) => `"${state.schema}"."india_subscriptions_${table}"`);
      await state.pool.query(`TRUNCATE ${tables.join(', ')}`);
    },
  };

  beforeAll(async () => {
    state.schema = uniqueName(SCHEMA_PREFIX);
    state.options = { schema: state.schema };
    state.pool = newPool({ max: 10 });
    pools.push(state.pool);
    await migratePostgres(state.pool, state.options);
  });

  afterAll(async () => {
    try {
      await state.pool?.query(`DROP SCHEMA IF EXISTS "${state.schema}" CASCADE`);
    } finally {
      await Promise.all(pools.map((pool) => pool.end().catch(() => undefined)));
    }
  });

  return database;
}
