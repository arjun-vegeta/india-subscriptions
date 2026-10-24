import type { Provider } from '../constants.js';
import { ReportStatus } from '../purchase/constants.js';
import {
  EntitlementRecordSchema,
  PurchaseSessionRecordSchema,
  ReportRecordSchema,
  type EntitlementRecord,
  type PurchaseSessionRecord,
  type ReportRecord,
} from '../purchase/schemas.js';
import type { EntitlementLookup, PurchaseStore } from '../purchase/store.js';
import type { PostgresQueryable, PostgresStoreOptions } from './client.js';
import { OPTION_KEY_SEPARATOR, PostgresTable } from './constants.js';
import { Database, assertInstant, rowLimit, validateRecord } from './database.js';
import { LockTable } from './lock.js';
import { resolveNames } from './names.js';

const OWNER = 'PostgreSQL purchase store';

/** The record fields a claim writes into the stored report, checked against the schema by the compiler. */
const LEASE_TOKEN_FIELD = 'leaseToken' satisfies keyof ReportRecord;
const LEASE_UNTIL_FIELD = 'leaseUntil' satisfies keyof ReportRecord;

/**
 * A `PurchaseStore` on PostgreSQL, for several servers sharing one database. Create the tables with
 * `migratePostgres` first. Pass a `pg.Pool` (or anything shaped like it); the store never opens or closes
 * connections itself.
 *
 * ## How each guarantee is kept
 *
 * - **Durability and read-your-writes.** Every `save*` and `enqueueReport` is one statement that has committed when
 *   it resolves; reads go to the same database. Point the pool at the primary and keep `synchronous_commit` on.
 * - **Copies.** Rows are read into fresh objects each time.
 * - **`enqueueReport`** is `INSERT ... ON CONFLICT (id) DO NOTHING RETURNING id`: one statement, `true` only for the
 *   caller whose row went in.
 * - **`claimDueReports`** is one statement: a `SELECT ... FOR UPDATE SKIP LOCKED` picks the due, unleased reports,
 *   most urgent first, and an `UPDATE` of exactly those rows writes a fresh lease token (`gen_random_uuid()`) and
 *   `leaseUntil` into the row. Two claims that run at the same moment lock different rows; a claim that started
 *   before another committed re-checks each row's conditions on its newest version, so no report is ever returned
 *   to two claimers while its lease runs.
 * - **`saveReport`** is `UPDATE ... WHERE id = $ AND status = 'queued' AND lease_token = $`: it replaces the report
 *   only while the stored lease token is the caller's, and says `false` when it did not. A claimer whose lease ran
 *   out and whose report another worker claimed therefore cannot overwrite the newer claim.
 * - **The lock** is one statement on the database's clock (see {@link LockTable.acquire}).
 * - **Which clock decides what.** Lock expiry: the database's `clock_timestamp()`. Report leases and due reports:
 *   the `at` instant the caller passes to `claimDueReports` and `listOverdueReports` (`leaseUntil` is `at` plus the
 *   lease, `nextAttemptAt` and `leaseUntil` are compared with `at`), so the clock that decides is the flush's own.
 *   The store has no clock of its own, so no clock option exists.
 * - **Instants** are stored whole inside the `jsonb` record (a record comes back with exactly the ISO strings it went
 *   in with) and as `timestamptz` columns the queries sort and compare on.
 * - **Validation.** A record is validated against its schema before it is written and after it is read.
 *
 * Needs PostgreSQL 13 or later (`gen_random_uuid()`).
 */
export class PostgresPurchaseStore implements PurchaseStore {
  private readonly database: Database;
  private readonly sessions: string;
  private readonly entitlements: string;
  private readonly reports: string;
  private readonly locks: LockTable;

  constructor(db: PostgresQueryable, options: PostgresStoreOptions = {}) {
    const names = resolveNames(options);
    this.database = new Database(db, OWNER);
    this.sessions = names.table(PostgresTable.Sessions);
    this.entitlements = names.table(PostgresTable.Entitlements);
    this.reports = names.table(PostgresTable.Reports);
    this.locks = new LockTable(this.database, names.table(PostgresTable.PurchaseLocks));
  }

  async getSession(id: string): Promise<PurchaseSessionRecord | undefined> {
    const rows = await this.database.rows(`SELECT record FROM ${this.sessions} WHERE id = $1`, [id]);
    return this.database.parseRecord(PurchaseSessionRecordSchema, rows[0], 'session');
  }

  async saveSession(session: PurchaseSessionRecord): Promise<void> {
    const record = validateRecord(OWNER, PurchaseSessionRecordSchema, session, 'session');
    await this.database.rows(
      `INSERT INTO ${this.sessions}
         (id, customer_ref, reference, created_at, provider, subscription_id, payment_id, option_keys, record)
       VALUES ($1, $2, $3, $4::timestamptz, $5, $6, $7, $8::text[], $9::jsonb)
       ON CONFLICT (id) DO UPDATE
         SET customer_ref = EXCLUDED.customer_ref,
             reference = EXCLUDED.reference,
             created_at = EXCLUDED.created_at,
             provider = EXCLUDED.provider,
             subscription_id = EXCLUDED.subscription_id,
             payment_id = EXCLUDED.payment_id,
             option_keys = EXCLUDED.option_keys,
             record = EXCLUDED.record`,
      [
        record.id,
        record.customerRef,
        record.reference,
        record.createdAt,
        record.provider ?? null,
        record.subscriptionId ?? null,
        record.paymentId ?? null,
        record.options.map((option) => optionKey(option.provider, option.handle)),
        JSON.stringify(record),
      ],
    );
  }

  async findSessionByReference(customerRef: string, reference: string): Promise<PurchaseSessionRecord | undefined> {
    const rows = await this.database.rows(
      `SELECT record FROM ${this.sessions}
       WHERE customer_ref = $1 AND reference = $2
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [customerRef, reference],
    );
    return this.database.parseRecord(PurchaseSessionRecordSchema, rows[0], 'session');
  }

  async findSessionByHandle(provider: Provider, id: string): Promise<PurchaseSessionRecord | undefined> {
    const rows = await this.database.rows(
      `SELECT record FROM ${this.sessions}
       WHERE option_keys @> ARRAY[$1::text]
          OR (provider = $2 AND subscription_id = $3)
          OR (provider = $2 AND payment_id = $3)
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [optionKey(provider, id), provider, id],
    );
    return this.database.parseRecord(PurchaseSessionRecordSchema, rows[0], 'session');
  }

  async listEntitlements(customerRef: string): Promise<EntitlementRecord[]> {
    const rows = await this.database.rows(
      `SELECT record FROM ${this.entitlements} WHERE customer_ref = $1 ORDER BY updated_at DESC, id ASC`,
      [customerRef],
    );
    return rows.map((row) => this.database.parseRecord(EntitlementRecordSchema, row, 'entitlement') as EntitlementRecord);
  }

  async getEntitlement(id: string): Promise<EntitlementRecord | undefined> {
    const rows = await this.database.rows(`SELECT record FROM ${this.entitlements} WHERE id = $1`, [id]);
    return this.database.parseRecord(EntitlementRecordSchema, rows[0], 'entitlement');
  }

  async findEntitlement(provider: Provider, lookup: EntitlementLookup): Promise<EntitlementRecord | undefined> {
    const column = lookup.subscriptionId !== undefined ? 'subscription_id' : 'payment_id';
    const id = lookup.subscriptionId !== undefined ? lookup.subscriptionId : lookup.paymentId;
    const rows = await this.database.rows(
      `SELECT record FROM ${this.entitlements}
       WHERE provider = $1 AND ${column} = $2
       ORDER BY updated_at DESC, id ASC
       LIMIT 1`,
      [provider, id],
    );
    return this.database.parseRecord(EntitlementRecordSchema, rows[0], 'entitlement');
  }

  async saveEntitlement(entitlement: EntitlementRecord): Promise<void> {
    const record = validateRecord(OWNER, EntitlementRecordSchema, entitlement, 'entitlement');
    await this.database.rows(
      `INSERT INTO ${this.entitlements} (id, customer_ref, provider, subscription_id, payment_id, updated_at, record)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::jsonb)
       ON CONFLICT (id) DO UPDATE
         SET customer_ref = EXCLUDED.customer_ref,
             provider = EXCLUDED.provider,
             subscription_id = EXCLUDED.subscription_id,
             payment_id = EXCLUDED.payment_id,
             updated_at = EXCLUDED.updated_at,
             record = EXCLUDED.record`,
      [
        record.id,
        record.customerRef,
        record.provider,
        record.subscriptionId ?? null,
        record.paymentId ?? null,
        record.updatedAt,
        JSON.stringify(record),
      ],
    );
  }

  async enqueueReport(report: ReportRecord): Promise<boolean> {
    const record = validateRecord(OWNER, ReportRecordSchema, report, 'report');
    const rows = await this.database.rows(
      `INSERT INTO ${this.reports} (id, status, due_by, next_attempt_at, lease_token, lease_until, record)
       VALUES ($1, $2, $3::timestamptz, $4::timestamptz, $5, $6::timestamptz, $7::jsonb)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      reportColumns(record),
    );
    return rows.length === 1;
  }

  async getReport(id: string): Promise<ReportRecord | undefined> {
    const rows = await this.database.rows(`SELECT record FROM ${this.reports} WHERE id = $1`, [id]);
    return this.database.parseRecord(ReportRecordSchema, rows[0], 'report');
  }

  async claimDueReports(at: string, limit: number, leaseMs: number): Promise<ReportRecord[]> {
    assertInstant(at, 'The claim instant');
    const count = rowLimit(limit);
    if (count === 0) return [];
    const leaseUntil = new Date(Date.parse(at) + Math.max(0, leaseMs)).toISOString();
    const rows = await this.database.rows(
      `WITH due AS MATERIALIZED (
         SELECT id, gen_random_uuid()::text AS token
         FROM ${this.reports}
         WHERE status = $1
           AND next_attempt_at <= $2::timestamptz
           AND (lease_until IS NULL OR lease_until <= $2::timestamptz)
         ORDER BY due_by ASC, id ASC
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       ), claimed AS (
         UPDATE ${this.reports} r
         SET lease_token = due.token,
             lease_until = $4::timestamptz,
             record = r.record || jsonb_build_object($5::text, due.token, $6::text, $7::text)
         FROM due
         WHERE r.id = due.id
         RETURNING r.id, r.due_by, r.record
       )
       SELECT record FROM claimed ORDER BY due_by ASC, id ASC`,
      [ReportStatus.Queued, at, count, leaseUntil, LEASE_TOKEN_FIELD, LEASE_UNTIL_FIELD, leaseUntil],
    );
    return rows.map((row) => this.database.parseRecord(ReportRecordSchema, row, 'report') as ReportRecord);
  }

  async saveReport(report: ReportRecord, leaseToken: string): Promise<boolean> {
    if (typeof leaseToken !== 'string' || leaseToken === '') return false;
    const record = validateRecord(OWNER, ReportRecordSchema, report, 'report');
    const rows = await this.database.rows(
      `UPDATE ${this.reports}
       SET status = $2,
           due_by = $3::timestamptz,
           next_attempt_at = $4::timestamptz,
           lease_token = $5,
           lease_until = $6::timestamptz,
           record = $7::jsonb
       WHERE id = $1 AND status = $8 AND lease_token = $9
       RETURNING id`,
      [...reportColumns(record), ReportStatus.Queued, leaseToken],
    );
    return rows.length === 1;
  }

  async listOverdueReports(at: string, limit: number): Promise<ReportRecord[]> {
    const rows = await this.database.rows(
      `SELECT record FROM ${this.reports}
       WHERE status = $1 AND due_by < $2::timestamptz
       ORDER BY due_by ASC, id ASC
       LIMIT $3`,
      [ReportStatus.Queued, assertInstant(at, 'The overdue instant'), rowLimit(limit)],
    );
    return rows.map((row) => this.database.parseRecord(ReportRecordSchema, row, 'report') as ReportRecord);
  }

  acquireLock(key: string, ttlMs: number): Promise<string | undefined> {
    return this.locks.acquire(key, ttlMs);
  }

  releaseLock(key: string, token: string): Promise<void> {
    return this.locks.release(key, token);
  }
}

/** The parameters `$1` to `$7` of the report statements: id, status, due_by, next_attempt_at, lease token, lease until, record. */
function reportColumns(record: ReportRecord): unknown[] {
  return [
    record.id,
    record.status,
    record.dueBy,
    record.nextAttemptAt,
    record.leaseToken ?? null,
    record.leaseUntil ?? null,
    JSON.stringify(record),
  ];
}

/** An entry of the `option_keys` column: finds a session by the id one of its options was created with. */
function optionKey(provider: Provider, handle: string): string {
  return `${provider}${OPTION_KEY_SEPARATOR}${handle}`;
}
