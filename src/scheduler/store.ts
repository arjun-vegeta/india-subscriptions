import type { Provider } from '../constants.js';
import type { CycleRecord, ScheduleRecord } from './schemas.js';

/**
 * Persistence for the billing scheduler. Implement it on any database; the
 * records are plain JSON (see `schemas.ts`).
 *
 * The scheduler is safe to run on several workers at once, but only if the
 * store honours the guarantees below. The two that matter most are the lock
 * (`acquireLock`) and durability (a resolved `save*` really is stored): the
 * scheduler persists a cycle as `charging` BEFORE it asks the gateway to debit
 * a customer, and relies on that write surviving a crash.
 *
 * Write ordering: whenever the scheduler changes both a cycle and its schedule
 * it saves the cycle first and the schedule second, and it recovers from a crash
 * between the two (the schedule's pointer simply catches up on the next tick).
 * A store that can write both in one transaction may do so, but need not.
 */
export interface SchedulerStore {
  /**
   * Returns the schedule with this id, or `undefined`.
   *
   * Must read your own writes: after `saveSchedule` resolves, every later
   * `getSchedule` (from any worker) returns that version or a newer one. On a
   * replicated database read from the primary / use strong consistency.
   * The returned object must be the caller's own copy (mutating it must not
   * change what is stored).
   */
  getSchedule(id: string): Promise<ScheduleRecord | undefined>;

  /**
   * Inserts or replaces the whole schedule record (upsert, last write wins).
   * Concurrent writers are excluded by `acquireLock`, so no compare-and-set is
   * needed. Must be durable when it resolves. Store `nextActionAt` as an
   * indexed, sortable instant so `listDueSchedules` is cheap.
   */
  saveSchedule(schedule: ScheduleRecord): Promise<void>;

  /**
   * Returns the schedule whose current `subscriptionId` equals this one on this
   * provider, or `undefined`. `subscriptionId` can change (`activate`), so index
   * `(provider, subscriptionId)` and keep it in step with `saveSchedule`. If
   * several schedules match, return the most recently created.
   */
  findBySubscriptionId(provider: Provider, subscriptionId: string): Promise<ScheduleRecord | undefined>;

  /**
   * Returns up to `limit` schedules whose `nextActionAt` is set and is at or
   * before `at` (a UTC ISO-8601 instant), oldest `nextActionAt` first. Ignore
   * schedules without `nextActionAt`; do not filter on `status` (a paused or
   * cancelled schedule keeps a `nextActionAt` while a debit is still being
   * reconciled). Each returned record is the caller's own copy.
   *
   * It is a hint, not a lease: two workers may receive the same schedule. The
   * scheduler takes the lock and re-reads the schedule before acting. It may be
   * eventually consistent (a stale entry is re-checked after the lock), but must
   * not permanently miss a schedule whose `nextActionAt` has passed.
   */
  listDueSchedules(at: string, limit: number): Promise<ScheduleRecord[]>;

  /** Returns the cycle `(scheduleId, index)`, or `undefined`. Same read-your-writes rule as `getSchedule`. */
  getCycle(scheduleId: string, index: number): Promise<CycleRecord | undefined>;

  /** Inserts or replaces the cycle `(record.scheduleId, record.index)`. Durable when it resolves. */
  saveCycle(cycle: CycleRecord): Promise<void>;

  /** All cycles of a schedule, ordered by `index` ascending. Copies. */
  listCycles(scheduleId: string): Promise<CycleRecord[]>;

  /**
   * Tries to take the exclusive lock for a schedule id (the id need not exist:
   * `register` locks before the schedule is created).
   *
   * Must be atomic (compare-and-set / `SET NX PX` / conditional put): of any
   * number of concurrent callers, at most one gets a token. Returns an opaque,
   * unguessable token on success, or `undefined` if the lock is held and has not
   * expired. A lock expires `ttlMs` after it was taken, so a crashed worker
   * cannot block a schedule forever; a caller that finds an expired lock takes it.
   * Must not block waiting for the lock.
   */
  acquireLock(scheduleId: string, ttlMs: number): Promise<string | undefined>;

  /**
   * Releases the lock if, and only if, `token` is the current holder's token. A
   * stale or unknown token is a no-op (a lock that expired and was taken by
   * someone else must stay taken). Never throws for a missing lock.
   */
  releaseLock(scheduleId: string, token: string): Promise<void>;
}
