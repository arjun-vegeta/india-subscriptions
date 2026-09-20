import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { ErrorCode, type Provider } from './constants.js';
import { SubscriptionError } from './errors.js';
import type { SchedulerStore } from './scheduler/store.js';
import { CycleRecordSchema, ScheduleRecordSchema, type CycleRecord, type ScheduleRecord } from './scheduler/schemas.js';

/** Identifies a file written by this store; anything else is refused rather than overwritten. */
export const FILE_STORE_FORMAT = 'india-subscriptions/scheduler-store';
/** Layout version of the file. Bump it, and add a migration, if the layout changes. */
export const FILE_STORE_VERSION = 1;
/** The store holds customer data and mandate ids: owner read/write only. */
export const FILE_STORE_MODE = 0o600;
/** Mode for a directory this store has to create. */
const DIRECTORY_MODE = 0o700;
const JSON_INDENT = 2;
const TEMP_SUFFIX = 'tmp';
const MAX_REPORTED_ISSUES = 5;
/** Node's error code for a file that does not exist. */
const NOT_FOUND = 'ENOENT';

const StoreFileSchema = z.object({
  format: z.literal(FILE_STORE_FORMAT),
  version: z.literal(FILE_STORE_VERSION),
  schedules: z.array(ScheduleRecordSchema),
  cycles: z.array(CycleRecordSchema),
});
type StoreFile = z.infer<typeof StoreFileSchema>;

export interface FileSchedulerStoreOptions {
  /** Clock for lock expiry, in epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
}

interface LockEntry {
  token: string;
  expiresAt: number;
}

/**
 * A durable `SchedulerStore` that keeps every record in ONE JSON file, for the
 * self-hosted service (`india-subscriptions serve`) and small single-server
 * deployments.
 *
 * ## For ONE service instance only
 *
 * The file is read once at startup and then served from memory, so a second
 * process using the same file would neither see the first one's writes nor
 * respect its locks, and each would overwrite the other's file. Run exactly one
 * instance. Several instances (horizontal scaling, blue/green deploys that
 * overlap) need a shared store (Postgres, Redis, ...) that implements
 * `SchedulerStore`, in particular an atomic `acquireLock`.
 *
 * ## Guarantees
 *
 * - Every `save*` rewrites the whole file atomically (temp file in the same
 *   directory, `fsync`, `rename`, then `fsync` of the directory) and resolves
 *   only after that, so a crash leaves either the old or the new file, never a
 *   torn one. Reads see a save only once it is durable.
 * - An in-process mutex runs saves one at a time, so two concurrent calls can
 *   never interleave their writes. Each save costs a full rewrite of the file,
 *   which is fine for thousands of schedules and not for millions.
 * - The file is validated against the scheduler's record schemas when it is
 *   opened, and every record is validated before it is written. A corrupt or
 *   foreign file makes {@link FileSchedulerStore.open} throw; it is never
 *   replaced silently.
 * - The file is created with mode 0600 (and tightened if it already exists).
 * - Locks live in memory only (same semantics as `MemorySchedulerStore`): they
 *   belong to the one process that holds them, so a restart simply starts with
 *   no locks held.
 * - Everything else (copies in and out, ordering, `findBySubscriptionId` and
 *   `listDueSchedules` rules) matches `MemorySchedulerStore`.
 *
 * Use {@link FileSchedulerStore.open}; there is no public constructor because
 * loading the file is asynchronous.
 */
export class FileSchedulerStore implements SchedulerStore {
  private readonly schedules = new Map<string, ScheduleRecord>();
  private readonly cycles = new Map<string, Map<number, CycleRecord>>();
  private readonly locks = new Map<string, LockEntry>();
  private readonly clock: () => number;
  /** Tail of the write queue: each save chains onto it. */
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(
    readonly path: string,
    options: FileSchedulerStoreOptions,
  ) {
    this.clock = options.now ?? Date.now;
  }

  /**
   * Opens the store at `path`, creating the file (and its directory) when it
   * does not exist. Throws `CONFIG` when the file exists but is not a valid
   * store file, and `INTERNAL_ERROR` when it cannot be read or written.
   */
  static async open(path: string, options: FileSchedulerStoreOptions = {}): Promise<FileSchedulerStore> {
    if (typeof path !== 'string' || path.trim() === '') {
      throw new SubscriptionError(ErrorCode.Config, 'FileSchedulerStore needs a file path');
    }
    const store = new FileSchedulerStore(resolve(path), options);
    const existing = await readIfPresent(store.path);
    if (existing === undefined) {
      await mkdir(dirname(store.path), { recursive: true, mode: DIRECTORY_MODE }).catch((cause: unknown) => {
        throw storageError(`Cannot create the directory of scheduler store file ${store.path}`, cause);
      });
      // Writing the empty file now surfaces an unwritable location at startup, not at the first charge.
      await store.persist([], []);
    } else {
      store.load(existing);
      await chmod(store.path, FILE_STORE_MODE).catch(() => undefined);
    }
    return store;
  }

  /** Waits for in-flight saves, then refuses further ones. Call it on shutdown. */
  async close(): Promise<void> {
    this.closed = true;
    await this.queue.catch(() => undefined);
  }

  async getSchedule(id: string): Promise<ScheduleRecord | undefined> {
    return copy(this.schedules.get(id));
  }

  async saveSchedule(schedule: ScheduleRecord): Promise<void> {
    const record = validateRecord(ScheduleRecordSchema, schedule, 'schedule');
    await this.exclusive(async () => {
      const schedules = [...this.schedules.values()].filter((s) => s.id !== record.id);
      schedules.push(record);
      await this.persist(schedules, this.allCycles());
      this.schedules.set(record.id, record);
    });
  }

  async findBySubscriptionId(provider: Provider, subscriptionId: string): Promise<ScheduleRecord | undefined> {
    let best: ScheduleRecord | undefined;
    for (const schedule of this.schedules.values()) {
      if (schedule.provider !== provider || schedule.subscriptionId !== subscriptionId) continue;
      if (!best || Date.parse(schedule.createdAt) >= Date.parse(best.createdAt)) best = schedule;
    }
    return copy(best);
  }

  async listDueSchedules(at: string, limit: number): Promise<ScheduleRecord[]> {
    const cutoff = Date.parse(at);
    const due: ScheduleRecord[] = [];
    for (const schedule of this.schedules.values()) {
      if (schedule.nextActionAt !== undefined && Date.parse(schedule.nextActionAt) <= cutoff) due.push(schedule);
    }
    due.sort(
      (a, b) =>
        Date.parse(a.nextActionAt as string) - Date.parse(b.nextActionAt as string) || a.id.localeCompare(b.id),
    );
    return due.slice(0, Math.max(0, limit)).map((schedule) => structuredClone(schedule));
  }

  async getCycle(scheduleId: string, index: number): Promise<CycleRecord | undefined> {
    return copy(this.cycles.get(scheduleId)?.get(index));
  }

  async saveCycle(cycle: CycleRecord): Promise<void> {
    const record = validateRecord(CycleRecordSchema, cycle, 'cycle');
    await this.exclusive(async () => {
      const cycles = this.allCycles().filter((c) => c.scheduleId !== record.scheduleId || c.index !== record.index);
      cycles.push(record);
      await this.persist([...this.schedules.values()], cycles);
      let forSchedule = this.cycles.get(record.scheduleId);
      if (!forSchedule) {
        forSchedule = new Map();
        this.cycles.set(record.scheduleId, forSchedule);
      }
      forSchedule.set(record.index, record);
    });
  }

  async listCycles(scheduleId: string): Promise<CycleRecord[]> {
    const forSchedule = this.cycles.get(scheduleId);
    if (!forSchedule) return [];
    return [...forSchedule.values()].sort((a, b) => a.index - b.index).map((cycle) => structuredClone(cycle));
  }

  async acquireLock(scheduleId: string, ttlMs: number): Promise<string | undefined> {
    // No await between the check and the set: the check-and-set is atomic in a single-threaded runtime.
    const now = this.clock();
    const held = this.locks.get(scheduleId);
    if (held && held.expiresAt > now) return undefined;
    const token = randomUUID();
    this.locks.set(scheduleId, { token, expiresAt: now + ttlMs });
    return token;
  }

  async releaseLock(scheduleId: string, token: string): Promise<void> {
    if (this.locks.get(scheduleId)?.token === token) this.locks.delete(scheduleId);
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /** Runs `task` after every earlier save has finished, whether or not those succeeded. */
  private exclusive(task: () => Promise<void>): Promise<void> {
    if (this.closed) {
      return Promise.reject(storageError('The scheduler store file has been closed'));
    }
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private allCycles(): CycleRecord[] {
    const all: CycleRecord[] = [];
    for (const forSchedule of this.cycles.values()) all.push(...forSchedule.values());
    return all;
  }

  private load(text: string): void {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (cause) {
      throw new SubscriptionError(
        ErrorCode.Config,
        `Scheduler store file ${this.path} is not valid JSON. It was left untouched: repair it, restore a backup, ` +
          'or delete it to start with an empty store.',
        { cause },
      );
    }
    const parsed = StoreFileSchema.safeParse(json);
    if (!parsed.success) {
      throw new SubscriptionError(
        ErrorCode.Config,
        `Scheduler store file ${this.path} is not a valid ${FILE_STORE_FORMAT} file (${summarise(parsed.error)}). ` +
          'It was left untouched: point the service at another path or fix the file.',
      );
    }
    for (const schedule of parsed.data.schedules) {
      if (this.schedules.has(schedule.id)) {
        throw new SubscriptionError(
          ErrorCode.Config,
          `Scheduler store file ${this.path} holds the schedule ${JSON.stringify(schedule.id)} twice`,
        );
      }
      this.schedules.set(schedule.id, schedule);
    }
    for (const cycle of parsed.data.cycles) {
      let forSchedule = this.cycles.get(cycle.scheduleId);
      if (!forSchedule) {
        forSchedule = new Map();
        this.cycles.set(cycle.scheduleId, forSchedule);
      }
      if (forSchedule.has(cycle.index)) {
        throw new SubscriptionError(
          ErrorCode.Config,
          `Scheduler store file ${this.path} holds cycle ${cycle.index} of ${JSON.stringify(cycle.scheduleId)} twice`,
        );
      }
      forSchedule.set(cycle.index, cycle);
    }
  }

  /** Atomically replaces the file with these records: temp file, fsync, rename, fsync of the directory. */
  private async persist(schedules: ScheduleRecord[], cycles: CycleRecord[]): Promise<void> {
    const document: StoreFile = {
      format: FILE_STORE_FORMAT,
      version: FILE_STORE_VERSION,
      schedules: [...schedules].sort((a, b) => a.id.localeCompare(b.id)),
      cycles: [...cycles].sort((a, b) => a.scheduleId.localeCompare(b.scheduleId) || a.index - b.index),
    };
    const data = JSON.stringify(document, null, JSON_INDENT) + '\n';
    const directory = dirname(this.path);
    const temp = join(directory, `.${basename(this.path)}.${process.pid}.${randomUUID()}.${TEMP_SUFFIX}`);
    try {
      const handle = await open(temp, 'wx', FILE_STORE_MODE);
      try {
        await handle.chmod(FILE_STORE_MODE).catch(() => undefined);
        await handle.writeFile(data, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, this.path);
    } catch (cause) {
      await unlink(temp).catch(() => undefined);
      throw storageError(`Cannot write scheduler store file ${this.path}`, cause);
    }
    await syncDirectory(directory);
  }
}

function copy<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}

/** Refuses a record this store could not load again, so a bad write can never make the file unreadable. */
function validateRecord<S extends z.ZodType>(schema: S, value: unknown, what: string): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new SubscriptionError(
      ErrorCode.Validation,
      `The scheduler store refused to save an invalid ${what} record (${summarise(parsed.error)})`,
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
    throw storageError(`Cannot read scheduler store file ${path}`, cause);
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
