import { randomUUID } from 'node:crypto';
import {
  CycleRecordSchema,
  ScheduleRecordSchema,
  type CycleRecord,
  type Provider,
  type ScheduleRecord,
  type SchedulerStore,
} from 'india-subscriptions';

/**
 * The one thing this store needs from a Postgres client: run a statement with parameters and return its rows.
 * `pg.Pool#query(text, values)` has this shape. Typing against it keeps the example free of a dependency.
 */
export interface Queryable {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Array<{ record?: unknown; token?: string }> }>;
}

/**
 * A `SchedulerStore` on PostgreSQL, safe for several workers.
 *
 * Records are kept whole in `jsonb` columns, with the few fields the scheduler queries by in real columns.
 * The lock is one atomic statement, and it uses the database's clock, so workers with skewed clocks agree.
 */
export class PostgresSchedulerStore implements SchedulerStore {
  constructor(private readonly db: Queryable) {}

  /** Run once at deploy time. */
  static readonly schema = `
    CREATE TABLE IF NOT EXISTS billing_schedules (
      id              text PRIMARY KEY,
      provider        text NOT NULL,
      subscription_id text NOT NULL,
      next_action_at  timestamptz,
      created_at      timestamptz NOT NULL,
      record          jsonb NOT NULL
    );
    CREATE INDEX IF NOT EXISTS billing_schedules_subscription ON billing_schedules (provider, subscription_id);
    CREATE INDEX IF NOT EXISTS billing_schedules_due ON billing_schedules (next_action_at) WHERE next_action_at IS NOT NULL;

    CREATE TABLE IF NOT EXISTS billing_cycles (
      schedule_id        text NOT NULL,
      idx                integer NOT NULL,
      charge_id          text,
      provider_charge_id text,
      record             jsonb NOT NULL,
      PRIMARY KEY (schedule_id, idx)
    );
    CREATE INDEX IF NOT EXISTS billing_cycles_charge ON billing_cycles (charge_id);
    CREATE INDEX IF NOT EXISTS billing_cycles_provider_charge ON billing_cycles (provider_charge_id);

    CREATE TABLE IF NOT EXISTS billing_locks (
      schedule_id text PRIMARY KEY,
      token       text NOT NULL,
      expires_at  timestamptz NOT NULL
    );
  `;

  async getSchedule(id: string): Promise<ScheduleRecord | undefined> {
    const { rows } = await this.db.query('SELECT record FROM billing_schedules WHERE id = $1', [id]);
    return rows[0] ? ScheduleRecordSchema.parse(rows[0].record) : undefined;
  }

  async saveSchedule(schedule: ScheduleRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO billing_schedules (id, provider, subscription_id, next_action_at, created_at, record)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE
         SET provider = EXCLUDED.provider,
             subscription_id = EXCLUDED.subscription_id,
             next_action_at = EXCLUDED.next_action_at,
             record = EXCLUDED.record`,
      [
        schedule.id,
        schedule.provider,
        schedule.subscriptionId,
        schedule.nextActionAt ?? null,
        schedule.createdAt,
        JSON.stringify(schedule),
      ],
    );
  }

  async findBySubscriptionId(provider: Provider, subscriptionId: string): Promise<ScheduleRecord | undefined> {
    const { rows } = await this.db.query(
      `SELECT record FROM billing_schedules
       WHERE provider = $1 AND subscription_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [provider, subscriptionId],
    );
    return rows[0] ? ScheduleRecordSchema.parse(rows[0].record) : undefined;
  }

  async findScheduleByChargeId(chargeId: string): Promise<ScheduleRecord | undefined> {
    const { rows } = await this.db.query(
      `SELECT s.record FROM billing_cycles c
       JOIN billing_schedules s ON s.id = c.schedule_id
       WHERE c.charge_id = $1 OR c.provider_charge_id = $1
       ORDER BY s.created_at DESC LIMIT 1`,
      [chargeId],
    );
    return rows[0] ? ScheduleRecordSchema.parse(rows[0].record) : undefined;
  }

  async listDueSchedules(at: string, limit: number): Promise<ScheduleRecord[]> {
    const { rows } = await this.db.query(
      `SELECT record FROM billing_schedules
       WHERE next_action_at IS NOT NULL AND next_action_at <= $1::timestamptz
       ORDER BY next_action_at ASC LIMIT $2`,
      [at, limit],
    );
    return rows.map((row) => ScheduleRecordSchema.parse(row.record));
  }

  async getCycle(scheduleId: string, index: number): Promise<CycleRecord | undefined> {
    const { rows } = await this.db.query('SELECT record FROM billing_cycles WHERE schedule_id = $1 AND idx = $2', [
      scheduleId,
      index,
    ]);
    return rows[0] ? CycleRecordSchema.parse(rows[0].record) : undefined;
  }

  async saveCycle(cycle: CycleRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO billing_cycles (schedule_id, idx, charge_id, provider_charge_id, record)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (schedule_id, idx) DO UPDATE
         SET charge_id = EXCLUDED.charge_id,
             provider_charge_id = EXCLUDED.provider_charge_id,
             record = EXCLUDED.record`,
      [cycle.scheduleId, cycle.index, cycle.chargeId ?? null, cycle.providerChargeId ?? null, JSON.stringify(cycle)],
    );
  }

  async listCycles(scheduleId: string): Promise<CycleRecord[]> {
    const { rows } = await this.db.query('SELECT record FROM billing_cycles WHERE schedule_id = $1 ORDER BY idx ASC', [
      scheduleId,
    ]);
    return rows.map((row) => CycleRecordSchema.parse(row.record));
  }

  /**
   * One atomic statement. The row is inserted, or taken over when its lock has expired. When the lock is held and
   * live, the WHERE clause is false, nothing is returned and the caller gets `undefined`. It never waits.
   */
  async acquireLock(scheduleId: string, ttlMs: number): Promise<string | undefined> {
    const token = randomUUID();
    const { rows } = await this.db.query(
      `INSERT INTO billing_locks (schedule_id, token, expires_at)
       VALUES ($1, $2, now() + $3 * interval '1 millisecond')
       ON CONFLICT (schedule_id) DO UPDATE
         SET token = EXCLUDED.token, expires_at = EXCLUDED.expires_at
         WHERE billing_locks.expires_at <= now()
       RETURNING token`,
      [scheduleId, token, ttlMs],
    );
    return rows[0]?.token;
  }

  /** Deletes the lock only if `token` still holds it: a lock that expired and was taken by someone else stays taken. */
  async releaseLock(scheduleId: string, token: string): Promise<void> {
    await this.db.query('DELETE FROM billing_locks WHERE schedule_id = $1 AND token = $2', [scheduleId, token]);
  }
}
