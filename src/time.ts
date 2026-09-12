import { invalid } from './errors.js';
import { IntervalUnit } from './constants.js';
import type { BillingInterval } from './schemas.js';

/**
 * Billing calendar maths is done in Indian Standard Time: mandates, gateway
 * dashboards and customers' bank statements all use IST dates. IST is a fixed
 * UTC+05:30 offset with no daylight saving, so plain offset arithmetic is exact.
 */
const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function toDate(value: Date | string | number, field = 'date'): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw invalid(`${field} is not a valid date: ${String(value)}`);
  return date;
}

export function toUnixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

export function fromUnixSeconds(value: unknown): Date | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return new Date(value * 1000);
}

/** Parses ISO-8601 strings; returns undefined instead of an Invalid Date. */
export function parseIso(value: unknown): Date | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** "2026-11-17T10:30:00+05:30" — the ISO form Indian gateways expect. */
export function toIstIso(date: Date): string {
  const shifted = new Date(date.getTime() + IST_OFFSET_MS);
  return shifted.toISOString().replace(/\.\d{3}Z$/, '+05:30');
}

/** "2026-11-17" — the calendar date in IST. */
export function toIstDateString(date: Date): string {
  return new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Parses "YYYY-MM-DD" as midnight IST of that day. */
export function fromIstDateString(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) return undefined;
  const utcMidnight = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(utcMidnight - IST_OFFSET_MS);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * The start of cycle `n` (0-based) for a schedule anchored at `anchor`.
 *
 * Computed from the anchor every time rather than by repeatedly adding one
 * interval, so a subscription anchored on the 31st bills on 31 Jan, 28 Feb,
 * 31 Mar — not 31 Jan, 28 Feb, 28 Mar.
 */
export function cycleStart(anchor: Date, interval: BillingInterval, n: number): Date {
  assertInterval(interval);
  if (!Number.isInteger(n) || n < 0) throw invalid(`cycle index must be a non-negative integer, got ${n}`);
  const steps = n * interval.count;
  if (steps === 0) return new Date(anchor.getTime());
  switch (interval.unit) {
    case IntervalUnit.Day:
      return addDays(anchor, steps);
    case IntervalUnit.Week:
      return addDays(anchor, steps * 7);
    case IntervalUnit.Month:
      return addMonthsIst(anchor, steps);
    case IntervalUnit.Year:
      return addMonthsIst(anchor, steps * 12);
  }
}

function addMonthsIst(anchor: Date, months: number): Date {
  const local = new Date(anchor.getTime() + IST_OFFSET_MS);
  const totalMonths = local.getUTCFullYear() * 12 + local.getUTCMonth() + months;
  const year = Math.floor(totalMonths / 12);
  const monthIndex = totalMonths - year * 12;
  const day = Math.min(local.getUTCDate(), daysInMonth(year, monthIndex));
  const shifted = Date.UTC(
    year,
    monthIndex,
    day,
    local.getUTCHours(),
    local.getUTCMinutes(),
    local.getUTCSeconds(),
    local.getUTCMilliseconds(),
  );
  return new Date(shifted - IST_OFFSET_MS);
}

export function assertInterval(interval: BillingInterval): void {
  const units: IntervalUnit[] = Object.values(IntervalUnit);
  if (!interval || !units.includes(interval.unit)) {
    throw invalid(`interval.unit must be one of ${units.join(', ')}`);
  }
  if (!Number.isInteger(interval.count) || interval.count < 1) {
    throw invalid(`interval.count must be a positive integer, got ${String(interval?.count)}`);
  }
}

/**
 * Resolves the two ways of asking for a delayed first charge into one date.
 * `trial.days` counts from `now`; `trial.endsAt` and `startAt` are absolute.
 */
export function resolveFirstChargeAt(
  input: { trial?: { days?: number; endsAt?: Date | string | number }; startAt?: Date | string | number },
  now: Date,
): { firstChargeAt?: Date; isTrial: boolean } {
  const { trial, startAt } = input;
  if (trial && startAt !== undefined) {
    throw invalid('Pass either trial or startAt, not both: both set the date of the first charge');
  }
  if (trial) {
    const hasDays = trial.days !== undefined;
    const hasEnd = trial.endsAt !== undefined;
    if (hasDays === hasEnd) throw invalid('trial needs exactly one of days or endsAt');
    if (hasDays) {
      if (!Number.isInteger(trial.days) || (trial.days as number) < 1) {
        throw invalid(`trial.days must be a positive integer, got ${String(trial.days)}`);
      }
      return { firstChargeAt: addDays(now, trial.days as number), isTrial: true };
    }
    const endsAt = toDate(trial.endsAt as Date | string | number, 'trial.endsAt');
    if (endsAt.getTime() <= now.getTime()) throw invalid('trial.endsAt must be in the future');
    return { firstChargeAt: endsAt, isTrial: true };
  }
  if (startAt !== undefined) {
    const date = toDate(startAt, 'startAt');
    if (date.getTime() <= now.getTime()) throw invalid('startAt must be in the future');
    return { firstChargeAt: date, isTrial: false };
  }
  return { isTrial: false };
}

/** Normalised output form: UTC ISO-8601 ("2026-11-17T05:00:00.000Z"). */
export function toIso(date: Date): string {
  return date.toISOString();
}

export function isoOrUndefined(date: Date | undefined): string | undefined {
  return date ? date.toISOString() : undefined;
}

/** Unix seconds (as gateways send them) to a normalised ISO string. */
export function unixToIso(value: unknown): string | undefined {
  return isoOrUndefined(fromUnixSeconds(value));
}

/** Any parseable date string from a gateway to a normalised ISO string. */
export function anyToIso(value: unknown): string | undefined {
  return isoOrUndefined(parseIso(value));
}
