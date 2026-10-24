import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import type { PostgresPool } from '../../src/postgres/index.js';

// Compile-time: `pg.Pool` is a `PostgresPool` structurally, so the library needs no driver dependency.
export const poolIsAPostgresPool = (pool: pg.Pool): PostgresPool => pool;
export const poolClientIsAConnection = async (pool: pg.Pool) => {
  const connection: Awaited<ReturnType<PostgresPool['connect']>> = await pool.connect();
  connection.release();
};

describe('the driver interface', () => {
  it('is satisfied by pg.Pool (checked when the tests are type-checked)', () => {
    expect(poolIsAPostgresPool).toBeTypeOf('function');
  });
});
