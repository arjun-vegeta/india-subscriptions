import type { Provider } from '../constants.js';
import {
  CycleRecordSchema,
  ScheduleRecordSchema,
  type CycleRecord,
  type ScheduleRecord,
} from '../scheduler/schemas.js';
import type { SchedulerStore } from '../scheduler/store.js';
import type { PostgresQueryable, PostgresStoreOptions } from './client.js';
import { PostgresTable } from './constants.js';
import { Database, assertInstant, rowLimit, validateRecord } from './database.js';
import { LockTable } from './lock.js';
import { resolveNames } from './names.js';

const OWNER = 'PostgreSQL scheduler store';

/**
 * A `SchedulerStore` on PostgreSQL, for several servers sharing one database. Create the tables with
 * `migratePostgres` first. Pass a `pg.Pool` (or anything shaped like it); the store never opens or closes
 * connections itself.
 *
 * ## How each guarantee is kept
 *
 * - **Durability and read-your-writes.** Every `save*` is one `INSERT ... ON CONFLICT DO UPDATE` that has committed
 *   when it resolves, and every read goes to the same database, so a later read from any worker sees it. Point the
 *   pool at the primary, not at a replica, and keep `synchronous_commit` on.
 * - **Copies.** Rows are read into fresh objects each time; a caller mutating one changes nothing stored.
 * - **The lock** is one statement on the database's clock (see {@link LockTable.acquire}); the expiry of a lock is
 *   decided by PostgreSQL's `clock_timestamp()` and by nothing on the caller's machine, so no clock option exists.
 * - **Instants** are stored twice: whole inside the `jsonb` record (so a record comes back with exactly the ISO
 *   strings it went in with) and as `timestamptz` columns the queries sort and compare on. `listDueSchedules(at)`
 *   compares against the `at` the caller passes: the clock that decides what is due is the scheduler's own.
 * - **Validation.** A record is validated against its schema before it is written and after it is read.
 *
 * Needs PostgreSQL 13 or later. At the default READ COMMITTED isolation level the upserts and the lock are atomic;
 * the lock also stays correct at REPEATABLE READ and SERIALIZABLE.
 */
export class PostgresSchedulerStore implements SchedulerStore {
  private readonly database: Database;
  private readonly schedules: string;
  private readonly cycles: string;
  private readonly locks: LockTable;

  constructor(db: PostgresQueryable, options: PostgresStoreOptions = {}) {
    const names = resolveNames(options);
    this.database = new Database(db, OWNER);
    this.schedules = names.table(PostgresTable.Schedules);
    this.cycles = names.table(PostgresTable.Cycles);
    this.locks = new LockTable(this.database, names.table(PostgresTable.ScheduleLocks));
  }

  async getSchedule(id: string): Promise<ScheduleRecord | undefined> {
    const rows = await this.database.rows(`SELECT record FROM ${this.schedules} WHERE id = $1`, [id]);
    return this.database.parseRecord(ScheduleRecordSchema, rows[0], 'schedule');
  }

  async saveSchedule(schedule: ScheduleRecord): Promise<void> {
    const record = validateRecord(OWNER, ScheduleRecordSchema, schedule, 'schedule');
    await this.database.rows(
      `INSERT INTO ${this.schedules} (id, provider, subscription_id, next_action_at, created_at, record)
       VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6::jsonb)
       ON CONFLICT (id) DO UPDATE
         SET provider = EXCLUDED.provider,
             subscription_id = EXCLUDED.subscription_id,
             next_action_at = EXCLUDED.next_action_at,
             created_at = EXCLUDED.created_at,
             record = EXCLUDED.record`,
      [
        record.id,
        record.provider,
        record.subscriptionId,
        record.nextActionAt ?? null,
        record.createdAt,
        JSON.stringify(record),
      ],
    );
  }

  async findBySubscriptionId(provider: Provider, subscriptionId: string): Promise<ScheduleRecord | undefined> {
    const rows = await this.database.rows(
      `SELECT record FROM ${this.schedules}
       WHERE provider = $1 AND subscription_id = $2
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [provider, subscriptionId],
    );
    return this.database.parseRecord(ScheduleRecordSchema, rows[0], 'schedule');
  }

  async findScheduleByChargeId(chargeId: string): Promise<ScheduleRecord | undefined> {
    const rows = await this.database.rows(
      `SELECT s.record
       FROM ${this.schedules} s
       WHERE s.id IN (
         SELECT schedule_id FROM ${this.cycles} WHERE charge_id = $1
         UNION
         SELECT schedule_id FROM ${this.cycles} WHERE provider_charge_id = $1
       )
       ORDER BY s.created_at DESC, s.id DESC
       LIMIT 1`,
      [chargeId],
    );
    return this.database.parseRecord(ScheduleRecordSchema, rows[0], 'schedule');
  }

  async listDueSchedules(at: string, limit: number): Promise<ScheduleRecord[]> {
    const rows = await this.database.rows(
      `SELECT record FROM ${this.schedules}
       WHERE next_action_at IS NOT NULL AND next_action_at <= $1::timestamptz
       ORDER BY next_action_at ASC, id ASC
       LIMIT $2`,
      [assertInstant(at, 'The due instant'), rowLimit(limit)],
    );
    return rows.map((row) => this.database.parseRecord(ScheduleRecordSchema, row, 'schedule') as ScheduleRecord);
  }

  async getCycle(scheduleId: string, index: number): Promise<CycleRecord | undefined> {
    const rows = await this.database.rows(`SELECT record FROM ${this.cycles} WHERE schedule_id = $1 AND idx = $2`, [
      scheduleId,
      index,
    ]);
    return this.database.parseRecord(CycleRecordSchema, rows[0], 'cycle');
  }

  async saveCycle(cycle: CycleRecord): Promise<void> {
    const record = validateRecord(OWNER, CycleRecordSchema, cycle, 'cycle');
    await this.database.rows(
      `INSERT INTO ${this.cycles} (schedule_id, idx, charge_id, provider_charge_id, record)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (schedule_id, idx) DO UPDATE
         SET charge_id = EXCLUDED.charge_id,
             provider_charge_id = EXCLUDED.provider_charge_id,
             record = EXCLUDED.record`,
      [record.scheduleId, record.index, record.chargeId ?? null, record.providerChargeId ?? null, JSON.stringify(record)],
    );
  }

  async listCycles(scheduleId: string): Promise<CycleRecord[]> {
    const rows = await this.database.rows(`SELECT record FROM ${this.cycles} WHERE schedule_id = $1 ORDER BY idx ASC`, [
      scheduleId,
    ]);
    return rows.map((row) => this.database.parseRecord(CycleRecordSchema, row, 'cycle') as CycleRecord);
  }

  acquireLock(scheduleId: string, ttlMs: number): Promise<string | undefined> {
    return this.locks.acquire(scheduleId, ttlMs);
  }

  releaseLock(scheduleId: string, token: string): Promise<void> {
    return this.locks.release(scheduleId, token);
  }
}
