import { randomUUID } from 'node:crypto';
import type { Provider } from '../constants.js';
import { ReportStatus } from './constants.js';
import type { EntitlementRecord, PurchaseSessionRecord, ReportRecord } from './schemas.js';
import type { EntitlementLookup, PurchaseStore } from './store.js';

export interface MemoryPurchaseStoreOptions {
  /** Clock for lock expiry, in epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
}

interface LockEntry {
  token: string;
  expiresAt: number;
}

/**
 * A correct in-memory `PurchaseStore` for tests and development. Records are deep-copied on the way in and on the
 * way out, so callers can never mutate stored state by accident. State is lost when the process exits and is not
 * shared between processes: use a real database in production.
 */
export class MemoryPurchaseStore implements PurchaseStore {
  private readonly sessions = new Map<string, PurchaseSessionRecord>();
  private readonly entitlements = new Map<string, EntitlementRecord>();
  private readonly reports = new Map<string, ReportRecord>();
  private readonly locks = new Map<string, LockEntry>();
  private readonly clock: () => number;

  constructor(options: MemoryPurchaseStoreOptions = {}) {
    this.clock = options.now ?? Date.now;
  }

  async getSession(id: string): Promise<PurchaseSessionRecord | undefined> {
    return copy(this.sessions.get(id));
  }

  async saveSession(session: PurchaseSessionRecord): Promise<void> {
    this.sessions.set(session.id, structuredClone(session));
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
    const best = matches.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
    return copy(best);
  }

  async saveEntitlement(entitlement: EntitlementRecord): Promise<void> {
    this.entitlements.set(entitlement.id, structuredClone(entitlement));
  }

  async enqueueReport(report: ReportRecord): Promise<boolean> {
    // No await between the check and the set: the insert-if-absent is atomic in a single-threaded runtime.
    if (this.reports.has(report.id)) return false;
    this.reports.set(report.id, structuredClone(report));
    return true;
  }

  async getReport(id: string): Promise<ReportRecord | undefined> {
    return copy(this.reports.get(id));
  }

  async claimDueReports(at: string, limit: number, leaseMs: number): Promise<ReportRecord[]> {
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
    const stored = this.reports.get(report.id);
    if (!stored || stored.status !== ReportStatus.Queued || stored.leaseToken !== leaseToken) return false;
    this.reports.set(report.id, structuredClone(report));
    return true;
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
}

function copy<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}

function newest(sessions: PurchaseSessionRecord[]): PurchaseSessionRecord | undefined {
  let best: PurchaseSessionRecord | undefined;
  for (const session of sessions) {
    if (!best || Date.parse(session.createdAt) >= Date.parse(best.createdAt)) best = session;
  }
  return best;
}
