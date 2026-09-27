import { randomUUID } from 'node:crypto';
import type { Provider } from '../constants.js';
import type { CycleRecord, ScheduleRecord } from './schemas.js';
import type { SchedulerStore } from './store.js';

export interface MemorySchedulerStoreOptions {
  /** Clock for lock expiry, in epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
}

interface LockEntry {
  token: string;
  expiresAt: number;
}

/**
 * A correct in-memory `SchedulerStore` for tests and development. Records are
 * deep-copied on the way in and on the way out, so callers can never mutate
 * stored state by accident. State is lost when the process exits and is not
 * shared between processes: use a real database in production.
 */
export class MemorySchedulerStore implements SchedulerStore {
  private readonly schedules = new Map<string, ScheduleRecord>();
  private readonly cycles = new Map<string, Map<number, CycleRecord>>();
  private readonly locks = new Map<string, LockEntry>();
  private readonly clock: () => number;

  constructor(options: MemorySchedulerStoreOptions = {}) {
    this.clock = options.now ?? Date.now;
  }

  async getSchedule(id: string): Promise<ScheduleRecord | undefined> {
    return copy(this.schedules.get(id));
  }

  async saveSchedule(schedule: ScheduleRecord): Promise<void> {
    this.schedules.set(schedule.id, structuredClone(schedule));
  }

  async findBySubscriptionId(provider: Provider, subscriptionId: string): Promise<ScheduleRecord | undefined> {
    let best: ScheduleRecord | undefined;
    for (const schedule of this.schedules.values()) {
      if (schedule.provider !== provider || schedule.subscriptionId !== subscriptionId) continue;
      if (!best || Date.parse(schedule.createdAt) >= Date.parse(best.createdAt)) best = schedule;
    }
    return copy(best);
  }

  async findScheduleByChargeId(chargeId: string): Promise<ScheduleRecord | undefined> {
    let best: ScheduleRecord | undefined;
    for (const [scheduleId, forSchedule] of this.cycles) {
      const owned = [...forSchedule.values()].some(
        (cycle) => cycle.chargeId === chargeId || cycle.providerChargeId === chargeId,
      );
      const schedule = owned ? this.schedules.get(scheduleId) : undefined;
      if (schedule && (!best || Date.parse(schedule.createdAt) >= Date.parse(best.createdAt))) best = schedule;
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
    let forSchedule = this.cycles.get(cycle.scheduleId);
    if (!forSchedule) {
      forSchedule = new Map();
      this.cycles.set(cycle.scheduleId, forSchedule);
    }
    forSchedule.set(cycle.index, structuredClone(cycle));
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
}

function copy<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}
