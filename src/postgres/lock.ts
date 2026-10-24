import { randomUUID } from 'node:crypto';
import { ErrorCode } from '../constants.js';
import { SubscriptionError } from '../errors.js';
import { SqlState } from './constants.js';
import { Database, sqlStateOf } from './database.js';

/** The two statements of an expiring lock, on one table of `(key, token, expires_at)`. Shared by both stores. */
export class LockTable {
  constructor(
    private readonly database: Database,
    private readonly table: string,
  ) {}

  /**
   * ONE statement, no check-then-act. It inserts the row, or takes over the existing row when (and only when) that
   * row's `expires_at` is not in the future. When the lock is held and unexpired the `WHERE` is false, no row comes
   * back and the caller gets `undefined`; it never waits for the holder.
   *
   * Both the new expiry and the comparison use `clock_timestamp()`, the database's wall clock: callers on machines
   * with skewed clocks agree on who holds the lock. (`now()` would be the start of the surrounding transaction, which
   * is wrong for a lock taken inside a longer one.) At READ COMMITTED, the default, a caller that conflicts with a
   * concurrent winner waits for that single statement to commit, re-evaluates the `WHERE` on the new row version and
   * finds it unexpired. At a higher isolation level the same race is a serialization failure, which also means "held".
   */
  async acquire(key: string, ttlMs: number): Promise<string | undefined> {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new SubscriptionError(ErrorCode.Validation, 'A lock ttl must be a positive number of milliseconds');
    }
    const token = randomUUID();
    try {
      const rows = await this.database.rows(
        `INSERT INTO ${this.table} AS lock (key, token, expires_at)
         VALUES ($1, $2, clock_timestamp() + $3::double precision * interval '1 millisecond')
         ON CONFLICT (key) DO UPDATE
           SET token = EXCLUDED.token, expires_at = EXCLUDED.expires_at
           WHERE lock.expires_at <= clock_timestamp()
         RETURNING token`,
        [key, token, ttlMs],
      );
      return rows[0] === undefined ? undefined : token;
    } catch (error) {
      if (sqlStateOf(error) === SqlState.SerializationFailure) return undefined;
      throw error;
    }
  }

  /** Deletes the row only when `token` is the stored one: a lock that expired and was taken by someone else stays taken. */
  async release(key: string, token: string): Promise<void> {
    await this.database.rows(`DELETE FROM ${this.table} WHERE key = $1 AND token = $2`, [key, token]);
  }
}
