import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { ErrorCode, type Provider } from './constants.js';
import { SubscriptionError } from './errors.js';
import { ReportStatus } from './purchase/constants.js';
import {
  EntitlementRecordSchema,
  PurchaseSessionRecordSchema,
  ReportRecordSchema,
  type EntitlementRecord,
  type PurchaseSessionRecord,
  type ReportRecord,
} from './purchase/schemas.js';
import type { EntitlementLookup, PurchaseStore } from './purchase/store.js';

/** Identifies a file written by this store; anything else is refused rather than overwritten. */
export const PURCHASE_STORE_FORMAT = 'india-subscriptions/purchase-store';
/** Layout version of the file. Bump it, and add a migration, if the layout changes. */
export const PURCHASE_STORE_VERSION = 1;
/** The store holds customer data and purchase ids: owner read/write only. */
export const PURCHASE_STORE_MODE = 0o600;
/** Mode for a directory this store has to create. */
const DIRECTORY_MODE = 0o700;
const JSON_INDENT = 2;
const TEMP_SUFFIX = 'tmp';
const MAX_REPORTED_ISSUES = 5;
/** Node's error code for a file that does not exist. */
const NOT_FOUND = 'ENOENT';

const StoreFileSchema = z.object({
  format: z.literal(PURCHASE_STORE_FORMAT),
  version: z.literal(PURCHASE_STORE_VERSION),
  sessions: z.array(PurchaseSessionRecordSchema),
  entitlements: z.array(EntitlementRecordSchema),
  reports: z.array(ReportRecordSchema),
});
type StoreFile = z.infer<typeof StoreFileSchema>;

export interface FilePurchaseStoreOptions {
  /** Clock for lock expiry, in epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
}

interface LockEntry {
  token: string;
  expiresAt: number;
}

/**
 * A durable `PurchaseStore` that keeps every session, entitlement and queued report in ONE JSON file, for the
 * self-hosted service (`india-subscriptions serve`) and small single-server deployments.
 *
 * ## For ONE service instance only
 *
 * The file is read once at startup and then served from memory, so a second process using the same file would neither
 * see the first one's writes nor respect its locks, and each would overwrite the other's file. Run exactly one
 * instance. Several instances need a shared store (Postgres, Redis, ...) that implements `PurchaseStore`, in
 * particular an atomic `acquireLock`, `enqueueReport` and `claimDueReports`.
 *
 * ## Guarantees
 *
 * - Every write (`saveSession`, `saveEntitlement`, `enqueueReport`, `saveReport`) rewrites the whole file atomically
 *   (temp file in the same directory, `fsync`, `rename`, then `fsync` of the directory) and resolves only after that,
 *   so a crash leaves either the old or the new file, never a torn one. This is what makes the report outbox durable:
 *   a resolved `enqueueReport` is on disk. Reads see a write only once it is durable.
 * - An in-process mutex runs writes one at a time, so two concurrent calls never interleave. `enqueueReport` checks
 *   for the id inside that mutex, so the insert-if-absent is atomic, and `saveReport` checks the lease inside it, so a
 *   report is replaced only by the holder of its lease. Each write costs a full rewrite of the file, which is fine
 *   for thousands of records and not for millions.
 * - The file is validated against the purchase module's record schemas when it is opened, and every record is
 *   validated before it is written. A corrupt or foreign file makes {@link FilePurchaseStore.open} throw; it is never
 *   replaced silently.
 * - The file is created with mode 0600 (and tightened if it already exists).
 * - Records are copied on the way in and on the way out: mutating what you got or what you saved never changes what
 *   is stored.
 * - Locks and report leases live in memory only (same semantics as `MemoryPurchaseStore`): they belong to the one
 *   process that holds them. A restart starts with no lock held, and every queued report is claimable again, which is
 *   what a crashed flush needs. The lease fields are never written to the file.
 * - Everything else (ordering, the lookups, `claimDueReports` and `listOverdueReports` rules) matches
 *   `MemoryPurchaseStore`.
 *
 * Use {@link FilePurchaseStore.open}; there is no public constructor because loading the file is asynchronous.
 */
export class FilePurchaseStore implements PurchaseStore {
  private readonly sessions = new Map<string, PurchaseSessionRecord>();
  private readonly entitlements = new Map<string, EntitlementRecord>();
  private readonly reports = new Map<string, ReportRecord>();
  private readonly locks = new Map<string, LockEntry>();
  private readonly clock: () => number;
  /** Tail of the write queue: each write chains onto it. */
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(
    readonly path: string,
    options: FilePurchaseStoreOptions,
  ) {
    this.clock = options.now ?? Date.now;
  }

  /**
   * Opens the store at `path`, creating the file (and its directory) when it does not exist. Throws `CONFIG` when
   * the file exists but is not a valid store file, and `INTERNAL_ERROR` when it cannot be read or written.
   */
  static async open(path: string, options: FilePurchaseStoreOptions = {}): Promise<FilePurchaseStore> {
    if (typeof path !== 'string' || path.trim() === '') {
      throw new SubscriptionError(ErrorCode.Config, 'FilePurchaseStore needs a file path');
    }
    const store = new FilePurchaseStore(resolve(path), options);
    const existing = await readIfPresent(store.path);
    if (existing === undefined) {
      await mkdir(dirname(store.path), { recursive: true, mode: DIRECTORY_MODE }).catch((cause: unknown) => {
        throw storageError(`Cannot create the directory of purchase store file ${store.path}`, cause);
      });
      // Writing the empty file now surfaces an unwritable location at startup, not at the first purchase.
      await store.persist();
    } else {
      store.load(existing);
      await chmod(store.path, PURCHASE_STORE_MODE).catch(() => undefined);
    }
    return store;
  }

  /** Waits for in-flight writes, then refuses further ones. Call it on shutdown. */
  async close(): Promise<void> {
    this.closed = true;
    await this.queue.catch(() => undefined);
  }

  async getSession(id: string): Promise<PurchaseSessionRecord | undefined> {
    return copy(this.sessions.get(id));
  }

  async saveSession(session: PurchaseSessionRecord): Promise<void> {
    const record = validateRecord(PurchaseSessionRecordSchema, session, 'session');
    await this.exclusive(async () => {
      await this.persist({ sessions: withRecord(this.sessions, record.id, record) });
      this.sessions.set(record.id, record);
    });
  }

  async findSessionByReference(customerRef: string, reference: string): Promise<PurchaseSessionRecord | undefined> {
    return copy(newest([...this.sessions.values()].filter((s) => s.customerRef === customerRef && s.reference === reference)));
  }

  async findSessionByHandle(provider: Provider, id: string): Promise<PurchaseSessionRecord | undefined> {
    const owned = [...this.sessions.values()].filter(
      (session) =>
        session.options.some((option) => option.provider === provider && option.handle === id) ||
        (session.provider === provider && (session.subscriptionId === id || session.paymentId === id)),
    );
    return copy(newest(owned));
  }

  async listEntitlements(customerRef: string): Promise<EntitlementRecord[]> {
    return [...this.entitlements.values()]
      .filter((entitlement) => entitlement.customerRef === customerRef)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id))
      .map((entitlement) => structuredClone(entitlement));
  }

  async getEntitlement(id: string): Promise<EntitlementRecord | undefined> {
    return copy(this.entitlements.get(id));
  }

  async findEntitlement(provider: Provider, lookup: EntitlementLookup): Promise<EntitlementRecord | undefined> {
    const matches = [...this.entitlements.values()].filter(
      (entitlement) =>
        entitlement.provider === provider &&
        (lookup.subscriptionId !== undefined
          ? entitlement.subscriptionId === lookup.subscriptionId
          : entitlement.paymentId === lookup.paymentId),
    );
    return copy(matches.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0]);
  }

  async saveEntitlement(entitlement: EntitlementRecord): Promise<void> {
    const record = validateRecord(EntitlementRecordSchema, entitlement, 'entitlement');
    await this.exclusive(async () => {
      await this.persist({ entitlements: withRecord(this.entitlements, record.id, record) });
      this.entitlements.set(record.id, record);
    });
  }

  async enqueueReport(report: ReportRecord): Promise<boolean> {
    const record = validateRecord(ReportRecordSchema, report, 'report');
    let stored = false;
    await this.exclusive(async () => {
      // Inside the write queue, so the check and the insert cannot interleave with another enqueue.
      if (this.reports.has(record.id)) return;
      await this.persist({ reports: withRecord(this.reports, record.id, record) });
      this.reports.set(record.id, record);
      stored = true;
    });
    return stored;
  }

  async getReport(id: string): Promise<ReportRecord | undefined> {
    return copy(this.reports.get(id));
  }

  async claimDueReports(at: string, limit: number, leaseMs: number): Promise<ReportRecord[]> {
    // Leases are memory-only, so a claim writes nothing. No await below: the claim is atomic in a single-threaded runtime.
    const cutoff = Date.parse(at);
    const due = [...this.reports.values()]
      .filter(
        (report) =>
          report.status === ReportStatus.Queued &&
          Date.parse(report.nextAttemptAt) <= cutoff &&
          (report.leaseUntil === undefined || Date.parse(report.leaseUntil) <= cutoff),
      )
      .sort((a, b) => Date.parse(a.dueBy) - Date.parse(b.dueBy) || a.id.localeCompare(b.id))
      .slice(0, Math.max(0, limit));
    return due.map((report) => {
      report.leaseToken = randomUUID();
      report.leaseUntil = new Date(cutoff + leaseMs).toISOString();
      return structuredClone(report);
    });
  }

  async saveReport(report: ReportRecord, leaseToken: string): Promise<boolean> {
    const record = validateRecord(ReportRecordSchema, report, 'report');
    let saved = false;
    await this.exclusive(async () => {
      const stored = this.reports.get(record.id);
      if (!stored || stored.status !== ReportStatus.Queued || stored.leaseToken !== leaseToken) return;
      await this.persist({ reports: withRecord(this.reports, record.id, record) });
      this.reports.set(record.id, record);
      saved = true;
    });
    return saved;
  }

  async listOverdueReports(at: string, limit: number): Promise<ReportRecord[]> {
    const cutoff = Date.parse(at);
    return [...this.reports.values()]
      .filter((report) => report.status === ReportStatus.Queued && Date.parse(report.dueBy) < cutoff)
      .sort((a, b) => Date.parse(a.dueBy) - Date.parse(b.dueBy) || a.id.localeCompare(b.id))
      .slice(0, Math.max(0, limit))
      .map((report) => structuredClone(report));
  }

  async acquireLock(key: string, ttlMs: number): Promise<string | undefined> {
    // No await between the check and the set: the check-and-set is atomic in a single-threaded runtime.
    const now = this.clock();
    const held = this.locks.get(key);
    if (held && held.expiresAt > now) return undefined;
    const token = randomUUID();
    this.locks.set(key, { token, expiresAt: now + ttlMs });
    return token;
  }

  async releaseLock(key: string, token: string): Promise<void> {
    if (this.locks.get(key)?.token === token) this.locks.delete(key);
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /** Runs `task` after every earlier write has finished, whether or not those succeeded. */
  private exclusive(task: () => Promise<void>): Promise<void> {
    if (this.closed) {
      return Promise.reject(storageError('The purchase store file has been closed'));
    }
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private load(text: string): void {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (cause) {
      throw new SubscriptionError(
        ErrorCode.Config,
        `Purchase store file ${this.path} is not valid JSON. It was left untouched: repair it, restore a backup, ` +
          'or delete it to start with an empty store.',
        { cause },
      );
    }
    const parsed = StoreFileSchema.safeParse(json);
    if (!parsed.success) {
      throw new SubscriptionError(
        ErrorCode.Config,
        `Purchase store file ${this.path} is not a valid ${PURCHASE_STORE_FORMAT} file (${summarise(parsed.error)}). ` +
          'It was left untouched: point the service at another path or fix the file.',
      );
    }
    const loadAll = <T extends { id: string }>(into: Map<string, T>, records: T[], what: string): void => {
      for (const record of records) {
        if (into.has(record.id)) {
          throw new SubscriptionError(
            ErrorCode.Config,
            `Purchase store file ${this.path} holds the ${what} ${JSON.stringify(record.id)} twice`,
          );
        }
        into.set(record.id, record);
      }
    };
    loadAll(this.sessions, parsed.data.sessions, 'session');
    loadAll(this.entitlements, parsed.data.entitlements, 'entitlement');
    // Leases do not survive a restart: whatever was in flight died with the old process.
    loadAll(this.reports, parsed.data.reports.map(withoutLease), 'report');
  }

  /**
   * Atomically replaces the file with the current records, with `change` applied on top (the in-memory maps are
   * updated by the caller once this resolves): temp file, fsync, rename, fsync of the directory.
   */
  private async persist(change: Partial<Record<'sessions' | 'entitlements' | 'reports', Map<string, unknown>>> = {}): Promise<void> {
    const document: StoreFile = {
      format: PURCHASE_STORE_FORMAT,
      version: PURCHASE_STORE_VERSION,
      sessions: sortedById((change.sessions ?? this.sessions) as Map<string, PurchaseSessionRecord>),
      entitlements: sortedById((change.entitlements ?? this.entitlements) as Map<string, EntitlementRecord>),
      reports: sortedById((change.reports ?? this.reports) as Map<string, ReportRecord>).map(withoutLease),
    };
    const data = JSON.stringify(document, null, JSON_INDENT) + '\n';
    const directory = dirname(this.path);
    const temp = join(directory, `.${basename(this.path)}.${process.pid}.${randomUUID()}.${TEMP_SUFFIX}`);
    try {
      const handle = await open(temp, 'wx', PURCHASE_STORE_MODE);
      try {
        await handle.chmod(PURCHASE_STORE_MODE).catch(() => undefined);
        await handle.writeFile(data, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, this.path);
    } catch (cause) {
      await unlink(temp).catch(() => undefined);
      throw storageError(`Cannot write purchase store file ${this.path}`, cause);
    }
    await syncDirectory(directory);
  }
}

function copy<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}

/** A copy of `map` with `record` set under `id`: what the file will hold once the write succeeds. */
function withRecord<T>(map: Map<string, T>, id: string, record: T): Map<string, T> {
  const next = new Map(map);
  next.set(id, record);
  return next;
}

function sortedById<T extends { id: string }>(map: Map<string, T>): T[] {
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** A report as it is written to the file: no lease. */
function withoutLease(report: ReportRecord): ReportRecord {
  const { leaseToken: _token, leaseUntil: _until, ...rest } = report;
  return rest;
}

function newest(sessions: PurchaseSessionRecord[]): PurchaseSessionRecord | undefined {
  let best: PurchaseSessionRecord | undefined;
  for (const session of sessions) {
    if (!best || Date.parse(session.createdAt) >= Date.parse(best.createdAt)) best = session;
  }
  return best;
}

/** Refuses a record this store could not load again, so a bad write can never make the file unreadable. */
function validateRecord<S extends z.ZodType>(schema: S, value: unknown, what: string): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new SubscriptionError(
      ErrorCode.Validation,
      `The purchase store refused to save an invalid ${what} record (${summarise(parsed.error)})`,
    );
  }
  return structuredClone(parsed.data);
}

/** Field paths and messages only: record values (customer data) never go into an error. */
function summarise(error: z.ZodError): string {
  const shown = error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => {
    const where = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
    return `${where}: ${issue.message}`;
  });
  const more = error.issues.length - shown.length;
  return more > 0 ? `${shown.join('; ')}; and ${more} more` : shown.join('; ');
}

function storageError(message: string, cause?: unknown): SubscriptionError {
  const reason = cause instanceof Error && 'code' in cause ? ` (${String(cause.code)})` : '';
  return new SubscriptionError(ErrorCode.Internal, `${message}${reason}`, { cause });
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (cause) {
    if (cause instanceof Error && 'code' in cause && cause.code === NOT_FOUND) return undefined;
    throw storageError(`Cannot read purchase store file ${path}`, cause);
  }
}

/** Makes the rename durable. Not every platform can open a directory, so failure here is not fatal. */
async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Best effort (Windows cannot fsync a directory).
  }
}
