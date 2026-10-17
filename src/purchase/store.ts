import type { Provider } from '../constants.js';
import type { EntitlementRecord, PurchaseSessionRecord, ReportRecord } from './schemas.js';

/** How an entitlement is looked up by what the provider calls it. Exactly one field is set. */
export type EntitlementLookup = { subscriptionId: string; paymentId?: undefined } | { paymentId: string; subscriptionId?: undefined };

/**
 * Persistence for purchase sessions, entitlements and the Google report outbox. Implement it on any database; the
 * records are plain JSON (see `schemas.ts`).
 *
 * `Purchases` is safe to run on several workers at once, but only if the store honours the guarantees below. The two
 * that matter most are the lock (`acquireLock`) and durability (a resolved `save*` / `enqueueReport` really is stored):
 * `complete` queues the Google report BEFORE it returns, and relies on that write surviving a crash. Every write
 * `Purchases` makes is idempotent (ids are deterministic and `enqueueReport` inserts only when absent), so a crash
 * between two writes is repaired by repeating the call; the locks only keep concurrent callers from doing the work twice.
 *
 * Write ordering in `complete`: the report is enqueued first, the entitlement saved second, the session saved last.
 */
export interface PurchaseStore {
  /**
   * Returns the session with this id, or `undefined`.
   *
   * Must read your own writes: after `saveSession` resolves, every later `getSession` (from any worker) returns that
   * version or a newer one. On a replicated database read from the primary / use strong consistency. The returned
   * object must be the caller's own copy (mutating it must not change what is stored).
   */
  getSession(id: string): Promise<PurchaseSessionRecord | undefined>;

  /** Inserts or replaces the whole session (upsert, last write wins: writers are excluded by `acquireLock`). Durable when it resolves. */
  saveSession(session: PurchaseSessionRecord): Promise<void>;

  /**
   * Returns the session of this customer whose `reference` equals this one, or `undefined`. If several match (a
   * reference reused after a failed or expired session), return the most recently created. A copy. Same
   * read-your-writes rule as `getSession`. Index `(customerRef, reference)`.
   */
  findSessionByReference(customerRef: string, reference: string): Promise<PurchaseSessionRecord | undefined>;

  /**
   * Returns the session that owns this provider's id, or `undefined`: the session with an option on `provider` whose
   * `handle` equals `id`, or whose `provider` and `subscriptionId` or `paymentId` equal them. It is how a webhook event
   * finds its session. If several match, return the most recently created. A copy. Same read-your-writes rule as
   * `getSession`. Index both.
   */
  findSessionByHandle(provider: Provider, id: string): Promise<PurchaseSessionRecord | undefined>;

  /** All entitlement items of a customer, newest `updatedAt` first. Copies. Same read-your-writes rule as `getSession`. */
  listEntitlements(customerRef: string): Promise<EntitlementRecord[]>;

  /** Returns the entitlement with this id, or `undefined`. A copy. */
  getEntitlement(id: string): Promise<EntitlementRecord | undefined>;

  /**
   * Returns the entitlement of this provider whose `subscriptionId` or `paymentId` equals the one given, or
   * `undefined`. At most one exists (the id is derived from them); if several do, return the most recently updated.
   * A copy. Index `(provider, subscriptionId)` and `(provider, paymentId)`.
   */
  findEntitlement(provider: Provider, lookup: EntitlementLookup): Promise<EntitlementRecord | undefined>;

  /** Inserts or replaces the whole entitlement (upsert, last write wins). Durable when it resolves. */
  saveEntitlement(entitlement: EntitlementRecord): Promise<void>;

  /**
   * Stores the report unless a report with this id exists already, and says which: `true` when it was stored, `false`
   * when the id was taken (the stored report is left untouched, whatever its status). Atomic (insert if absent). Durable
   * when it resolves: it is the promise that Google will be told.
   */
  enqueueReport(report: ReportRecord): Promise<boolean>;

  /** Returns the report with this id (queued, sent or rejected), or `undefined`. A copy. Reports are never deleted by `Purchases`. */
  getReport(id: string): Promise<ReportRecord | undefined>;

  /**
   * Claims up to `limit` queued reports for sending: those with `status: queued`, `nextAttemptAt` at or before `at`
   * (a UTC ISO-8601 instant) and no lease that is still running (`leaseUntil` unset or at or before `at`), the most
   * urgent first (earliest `dueBy`, then `id`). Atomically gives each a fresh `leaseToken` and sets `leaseUntil` to
   * `at` plus `leaseMs`, and returns copies carrying them. Two concurrent claims never return the same report.
   * A claim is a lease, not a lock: if the claimer crashes the report is claimable again once the lease ends.
   */
  claimDueReports(at: string, limit: number, leaseMs: number): Promise<ReportRecord[]>;

  /**
   * Replaces a claimed report, if, and only if, `leaseToken` is the token of the lease the stored report holds and the
   * stored report is still queued. Returns `false` (and stores nothing) otherwise: the lease expired and another
   * claimer took the report. The caller clears `leaseToken` and `leaseUntil` on the record it saves. Durable when it resolves.
   */
  saveReport(report: ReportRecord, leaseToken: string): Promise<boolean>;

  /**
   * Returns up to `limit` queued reports whose `dueBy` is before `at` (strictly: a report is late only after its deadline), most overdue first, whatever their
   * `nextAttemptAt` or lease. Copies. The flush uses it to flag reports that missed Google's 24-hour deadline.
   */
  listOverdueReports(at: string, limit: number): Promise<ReportRecord[]>;

  /**
   * Tries to take the exclusive lock for a key (a session, an entitlement, a customer's start). Same contract as
   * `SchedulerStore.acquireLock`: atomic, never blocks, returns an opaque unguessable token or `undefined` while the
   * lock is held and unexpired, and the lock expires `ttlMs` after it was taken so a crashed worker cannot block a
   * key forever.
   */
  acquireLock(key: string, ttlMs: number): Promise<string | undefined>;

  /** Releases the lock if, and only if, `token` is the current holder's token. A stale or unknown token is a no-op. */
  releaseLock(key: string, token: string): Promise<void>;
}
