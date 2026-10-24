import { describe, expect, it } from 'vitest';
import { ErrorCode } from '../../src/constants.js';
import {
  LATEST_MIGRATION_VERSION,
  PostgresPurchaseStore,
  PostgresRoutingStatsStore,
  PostgresSchedulerStore,
  migratePostgres,
} from '../../src/postgres/index.js';
import { T0 } from '../purchase/helpers.js';
import { report } from '../purchase/store-suite.js';
import { schedule } from '../scheduler/store-suite.js';
import { describePostgres, newPool, uniqueName, useDatabase } from './helpers.js';

describePostgres('migratePostgres', () => {
  const db = useDatabase();

  const tablesIn = async (schema: string): Promise<string[]> => {
    const { rows } = await db.pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename`, [schema]);
    return rows.map((row) => row.tablename as string);
  };
  const indexesIn = async (schema: string): Promise<string[]> => {
    const { rows } = await db.pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname = $1 ORDER BY indexname`, [schema]);
    return rows.map((row) => row.indexname as string);
  };

  it('creates the schema and every table, then does nothing the second time', async () => {
    const schema = uniqueName('ffu4_test_mig_');
    try {
      const first = await migratePostgres(db.pool, { schema });
      expect(first).toEqual({ applied: [1], version: LATEST_MIGRATION_VERSION });
      const tables = await tablesIn(schema);
      expect(tables).toEqual([
        'india_subscriptions_cycles',
        'india_subscriptions_entitlements',
        'india_subscriptions_migrations',
        'india_subscriptions_purchase_locks',
        'india_subscriptions_reports',
        'india_subscriptions_routing_stats',
        'india_subscriptions_schedule_locks',
        'india_subscriptions_schedules',
        'india_subscriptions_sessions',
      ]);
      const indexes = await indexesIn(schema);

      const second = await migratePostgres(db.pool, { schema });
      expect(second).toEqual({ applied: [], version: LATEST_MIGRATION_VERSION });
      expect(await tablesIn(schema)).toEqual(tables);
      expect(await indexesIn(schema)).toEqual(indexes);
      const { rows } = await db.pool.query(`SELECT version FROM "${schema}"."india_subscriptions_migrations"`);
      expect(rows).toEqual([{ version: 1 }]);
    } finally {
      await db.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  });

  it('leaves one consistent schema when many instances migrate a brand-new schema at the same moment', async () => {
    for (let round = 0; round < 3; round += 1) {
      const schema = uniqueName('ffu4_test_race_');
      const pools = Array.from({ length: 16 }, () => newPool({ max: 1 }));
      try {
        const results = await Promise.all(pools.map((pool) => migratePostgres(pool, { schema })));
        // Exactly one instance applied the migration; the others found it done.
        expect(results.filter((result) => result.applied.length > 0)).toHaveLength(1);
        expect(results.every((result) => result.version === LATEST_MIGRATION_VERSION)).toBe(true);
        expect(await tablesIn(schema)).toHaveLength(9);
        const { rows } = await db.pool.query(`SELECT version FROM "${schema}"."india_subscriptions_migrations"`);
        expect(rows).toEqual([{ version: 1 }]);
      } finally {
        await Promise.all(pools.map((pool) => pool.end()));
        await db.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }
    }
  });

  it('migrating into an existing schema (public-style) does not need the privilege to create it', async () => {
    // `db.schema` exists already: the migration must not try to create it again.
    const result = await migratePostgres(db.pool, { ...db.options, tablePrefix: 'second_' });
    expect(result.version).toBe(LATEST_MIGRATION_VERSION);
    expect((await tablesIn(db.schema)).filter((name) => name.startsWith('second_'))).toHaveLength(9);
  });

  it('keeps two prefixes in one schema apart', async () => {
    const options = { schema: db.schema, tablePrefix: 'alpha_' };
    const other = { schema: db.schema, tablePrefix: 'beta_' };
    await migratePostgres(db.pool, options);
    await migratePostgres(db.pool, other);
    const a = new PostgresSchedulerStore(db.pool, options);
    const b = new PostgresSchedulerStore(db.pool, other);
    await a.saveSchedule(schedule('only-in-a'));
    expect(await b.getSchedule('only-in-a')).toBeUndefined();
    expect((await a.getSchedule('only-in-a'))?.id).toBe('only-in-a');
    const stats = new PostgresRoutingStatsStore(db.pool, options);
    const purchases = new PostgresPurchaseStore(db.pool, other);
    await purchases.enqueueReport(report());
    expect(await new PostgresPurchaseStore(db.pool, options).getReport('ext_1')).toBeUndefined();
    expect(stats).toBeDefined();
  });

  it('refuses a database migrated by a newer version of the library', async () => {
    const schema = uniqueName('ffu4_test_new_');
    try {
      await migratePostgres(db.pool, { schema });
      await db.pool.query(`INSERT INTO "${schema}"."india_subscriptions_migrations" (version, name) VALUES (999, 'from the future')`);
      await expect(migratePostgres(db.pool, { schema })).rejects.toMatchObject({ code: ErrorCode.Config });
    } finally {
      await db.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  });

  it('rolls back completely when a statement fails, leaving nothing half-made', async () => {
    const schema = uniqueName('ffu4_test_fail_');
    try {
      await db.pool.query(`CREATE SCHEMA "${schema}"`);
      // A table of the same name as one the migration creates, but of another kind, makes `CREATE INDEX` fail midway.
      await db.pool.query(`CREATE VIEW "${schema}"."india_subscriptions_schedules" AS SELECT 1 AS id`);
      await expect(migratePostgres(db.pool, { schema })).rejects.toBeDefined();
      expect(await tablesIn(schema)).toEqual([]);
      await db.pool.query(`DROP VIEW "${schema}"."india_subscriptions_schedules"`);
      expect((await migratePostgres(db.pool, { schema })).applied).toEqual([1]);
    } finally {
      await db.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  });

  it('gives the connection back to the pool when it fails', async () => {
    const pool = newPool({ max: 1 });
    try {
      await expect(migratePostgres(pool, { schema: 'pg_catalog' })).rejects.toBeDefined();
      await expect(pool.query('SELECT 1')).resolves.toBeDefined();
    } finally {
      await pool.end();
    }
  });

  describe('identifiers', () => {
    const bad = ['', 'a-b', 'a b', 'a"b', '1abc', 'a;DROP TABLE x', 'ünï', 'a'.repeat(64), 'public.other', 'a\0b'];

    it.each(bad)('rejects the schema %j before any statement runs', async (schema) => {
      await expect(migratePostgres(db.pool, { schema })).rejects.toMatchObject({ code: ErrorCode.Config });
      expect(() => new PostgresSchedulerStore(db.pool, { schema })).toThrow(expect.objectContaining({ code: ErrorCode.Config }));
    });

    it.each(bad.filter((value) => value !== ''))('rejects the table prefix %j', async (tablePrefix) => {
      await expect(migratePostgres(db.pool, { tablePrefix })).rejects.toMatchObject({ code: ErrorCode.Config });
      expect(() => new PostgresPurchaseStore(db.pool, { tablePrefix })).toThrow(expect.objectContaining({ code: ErrorCode.Config }));
    });

    it('rejects a prefix so long that PostgreSQL would truncate two names into one', async () => {
      expect(() => new PostgresSchedulerStore(db.pool, { tablePrefix: 'p'.repeat(40) })).toThrow(expect.objectContaining({ code: ErrorCode.Config }));
    });

    it('quotes what it accepts, so mixed case and reserved words are safe, and the injected statement never runs', async () => {
      const schema = uniqueName('Ffu4_MixedCase_');
      const options = { schema, tablePrefix: 'Select_' };
      try {
        await migratePostgres(db.pool, options);
        const store = new PostgresSchedulerStore(db.pool, options);
        await store.saveSchedule(schedule("x'; DROP TABLE y; --", { subscriptionId: "sub'--" }));
        expect((await store.getSchedule("x'; DROP TABLE y; --"))?.subscriptionId).toBe("sub'--");
        expect(await tablesIn(schema)).toContain('Select_schedules');
        // Values travel as parameters: a hostile lock key is just a key.
        const token = await store.acquireLock("k'); DELETE FROM x; --", 1000);
        expect(token).toBeDefined();
      } finally {
        await db.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }
      void T0;
    });
  });
});
