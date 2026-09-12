import { describe, expect, it } from 'vitest';
import { ErrorCode, IntervalUnit } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import type { BillingInterval } from '../../src/schemas.js';
import {
  addDays,
  anyToIso,
  assertInterval,
  cycleStart,
  fromIstDateString,
  fromUnixSeconds,
  isoOrUndefined,
  parseIso,
  resolveFirstChargeAt,
  toDate,
  toIso,
  toIstDateString,
  toIstIso,
  toUnixSeconds,
  unixToIso,
} from '../../src/time.js';

const iso = (value: Date | undefined) => value?.toISOString();

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof SubscriptionError ? error.code : `non-SubscriptionError: ${String(error)}`;
  }
  return undefined;
}

const every = (unit: IntervalUnit, count = 1): BillingInterval => ({ unit, count });

describe('toDate', () => {
  it('copies a Date instead of returning the same instance', () => {
    const original = new Date('2026-11-17T00:00:00Z');
    const copy = toDate(original);
    expect(copy).not.toBe(original);
    expect(copy.getTime()).toBe(original.getTime());
  });

  it('accepts ISO strings and epoch milliseconds', () => {
    expect(iso(toDate('2026-11-17T10:30:00+05:30'))).toBe('2026-11-17T05:00:00.000Z');
    expect(iso(toDate(Date.UTC(2026, 10, 17, 5, 30)))).toBe('2026-11-17T05:30:00.000Z');
  });

  it.each(['garbage', '', 'not-a-date', Number.NaN, new Date('x')])('throws VALIDATION naming the field for %j', (value) => {
    expect(codeOf(() => toDate(value, 'startAt'))).toBe(ErrorCode.Validation);
    expect(() => toDate(value, 'startAt')).toThrow(/startAt/);
  });
});

describe('unix / ISO helpers', () => {
  it('toUnixSeconds floors rather than rounds', () => {
    expect(toUnixSeconds(new Date(1999))).toBe(1);
    expect(toUnixSeconds(new Date(2000))).toBe(2);
    expect(toUnixSeconds(new Date('2026-11-17T05:00:00.999Z'))).toBe(1_794_891_600);
  });

  it('fromUnixSeconds converts seconds to a Date', () => {
    expect(iso(fromUnixSeconds(1_794_891_600))).toBe('2026-11-17T05:00:00.000Z');
    expect(iso(fromUnixSeconds(1.5))).toBe('1970-01-01T00:00:01.500Z');
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, '1794891600', null, undefined, {}])(
    'fromUnixSeconds returns undefined for %j',
    (value) => {
      expect(fromUnixSeconds(value)).toBeUndefined();
    },
  );

  it('parseIso parses valid strings, including offsets', () => {
    expect(iso(parseIso('2026-11-17T10:30:00+05:30'))).toBe('2026-11-17T05:00:00.000Z');
    expect(iso(parseIso('2026-11-17T05:00:00Z'))).toBe('2026-11-17T05:00:00.000Z');
  });

  it.each(['', '   ', 'garbage', '2026-13-45', 12345, null, undefined, {}, new Date()])(
    'parseIso returns undefined for %j',
    (value) => {
      expect(parseIso(value)).toBeUndefined();
    },
  );

  it('unixToIso / anyToIso / isoOrUndefined / toIso', () => {
    expect(unixToIso(1_794_891_600)).toBe('2026-11-17T05:00:00.000Z');
    expect(unixToIso(0)).toBeUndefined();
    expect(unixToIso('x')).toBeUndefined();
    expect(anyToIso('2026-11-17T10:30:00+05:30')).toBe('2026-11-17T05:00:00.000Z');
    expect(anyToIso('garbage')).toBeUndefined();
    expect(anyToIso(undefined)).toBeUndefined();
    expect(isoOrUndefined(undefined)).toBeUndefined();
    expect(isoOrUndefined(new Date('2026-11-17T05:00:00Z'))).toBe('2026-11-17T05:00:00.000Z');
    expect(toIso(new Date('2026-11-17T05:00:00Z'))).toBe('2026-11-17T05:00:00.000Z');
  });

  // DEFECT (src/time.ts, parseIso): it relies on `new Date(string)`, and V8 silently rolls
  // an impossible calendar day over (2026-02-30 -> 2026-03-02) instead of returning undefined.
  // A gateway date that is off by a few days would be accepted as a different, valid day.
  it.fails('parseIso rejects an impossible calendar date such as 2026-02-30', () => {
    expect(parseIso('2026-02-30')).toBeUndefined();
  });
});

describe('IST formatting', () => {
  it('toIstIso renders +05:30 wall-clock time', () => {
    expect(toIstIso(new Date('2026-11-17T05:00:00Z'))).toBe('2026-11-17T10:30:00+05:30');
    expect(toIstIso(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01T05:30:00+05:30');
  });

  it('toIstIso drops milliseconds', () => {
    expect(toIstIso(new Date('2026-11-17T05:00:00.987Z'))).toBe('2026-11-17T10:30:00+05:30');
  });

  it('toIstIso crosses the date line at 18:30Z', () => {
    expect(toIstIso(new Date('2026-11-17T18:29:59Z'))).toBe('2026-11-17T23:59:59+05:30');
    expect(toIstIso(new Date('2026-11-17T18:30:00Z'))).toBe('2026-11-18T00:00:00+05:30');
    expect(toIstIso(new Date('2025-12-31T18:30:00Z'))).toBe('2026-01-01T00:00:00+05:30');
  });

  it('toIstIso output parses back to the same instant (to the second)', () => {
    const date = new Date('2026-03-08T13:14:15Z');
    expect(toUnixSeconds(new Date(toIstIso(date)))).toBe(toUnixSeconds(date));
  });

  it('toIstDateString is the IST calendar day', () => {
    expect(toIstDateString(new Date('2026-11-17T05:00:00Z'))).toBe('2026-11-17');
    expect(toIstDateString(new Date('2026-11-17T18:29:59.999Z'))).toBe('2026-11-17');
    expect(toIstDateString(new Date('2026-11-17T18:30:00.000Z'))).toBe('2026-11-18');
    expect(toIstDateString(new Date('2026-11-17T00:00:00Z'))).toBe('2026-11-17');
    expect(toIstDateString(new Date('2025-12-31T18:30:00Z'))).toBe('2026-01-01');
  });

  it('fromIstDateString returns midnight IST', () => {
    expect(iso(fromIstDateString('2026-11-17'))).toBe('2026-11-16T18:30:00.000Z');
    expect(iso(fromIstDateString('2026-01-01'))).toBe('2025-12-31T18:30:00.000Z');
    expect(iso(fromIstDateString('  2026-11-17  '))).toBe('2026-11-16T18:30:00.000Z');
  });

  it('fromIstDateString and toIstDateString round-trip every day of 2024 and 2025', () => {
    for (let t = Date.UTC(2024, 0, 1); t < Date.UTC(2026, 0, 1); t += 86_400_000) {
      const day = new Date(t).toISOString().slice(0, 10);
      const parsed = fromIstDateString(day);
      expect(parsed).toBeDefined();
      expect(toIstDateString(parsed as Date)).toBe(day);
      expect(toIstIso(parsed as Date)).toBe(`${day}T00:00:00+05:30`);
    }
  });

  it.each(['garbage', '', '17-11-2026', '2026/11/17', '26-11-17', 20261117, null, undefined, {}])(
    'fromIstDateString returns undefined for %j',
    (value) => {
      expect(fromIstDateString(value)).toBeUndefined();
    },
  );

  // DEFECT (src/time.ts, fromIstDateString): the regex only checks the digit shape, then
  // Date.UTC() normalises out-of-range parts. "2026-02-30" becomes 2 March, "2026-13-45" becomes
  // 14 January 2027, "2026-00-00" becomes 30 November 2025 - none return undefined.
  it.fails('fromIstDateString rejects 2026-02-30', () => {
    expect(fromIstDateString('2026-02-30')).toBeUndefined();
  });
  it.fails('fromIstDateString rejects month 13', () => {
    expect(fromIstDateString('2026-13-01')).toBeUndefined();
  });
  it.fails('fromIstDateString rejects day 00', () => {
    expect(fromIstDateString('2026-11-00')).toBeUndefined();
  });

  it('addDays adds exact 24h days and does not mutate its input', () => {
    const base = new Date('2026-11-17T05:00:00Z');
    expect(iso(addDays(base, 30))).toBe('2026-12-17T05:00:00.000Z');
    expect(iso(addDays(base, -17))).toBe('2026-10-31T05:00:00.000Z');
    expect(iso(base)).toBe('2026-11-17T05:00:00.000Z');
  });
});

describe('assertInterval', () => {
  it.each(Object.values(IntervalUnit))('accepts unit %s', (unit) => {
    expect(() => assertInterval({ unit, count: 1 })).not.toThrow();
    expect(() => assertInterval({ unit, count: 12 })).not.toThrow();
  });

  it.each([
    ['count 0', { unit: IntervalUnit.Month, count: 0 }],
    ['negative count', { unit: IntervalUnit.Month, count: -1 }],
    ['fractional count', { unit: IntervalUnit.Month, count: 1.5 }],
    ['NaN count', { unit: IntervalUnit.Month, count: Number.NaN }],
    ['Infinity count', { unit: IntervalUnit.Month, count: Number.POSITIVE_INFINITY }],
    ['string count', { unit: IntervalUnit.Month, count: '1' }],
    ['unknown unit', { unit: 'fortnight', count: 1 }],
    ['missing unit', { count: 1 }],
    ['empty object', {}],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s with VALIDATION', (_label, interval) => {
    expect(codeOf(() => assertInterval(interval as unknown as BillingInterval))).toBe(ErrorCode.Validation);
  });
});

describe('cycleStart: day and week', () => {
  const anchor = new Date('2026-11-17T05:00:00Z');

  it('cycle 0 is the anchor itself (a copy)', () => {
    const start = cycleStart(anchor, every(IntervalUnit.Month), 0);
    expect(start).not.toBe(anchor);
    expect(iso(start)).toBe(iso(anchor));
  });

  it('days', () => {
    expect(iso(cycleStart(anchor, every(IntervalUnit.Day), 1))).toBe('2026-11-18T05:00:00.000Z');
    expect(iso(cycleStart(anchor, every(IntervalUnit.Day, 10), 3))).toBe('2026-12-17T05:00:00.000Z');
  });

  it('weeks', () => {
    expect(iso(cycleStart(anchor, every(IntervalUnit.Week), 1))).toBe('2026-11-24T05:00:00.000Z');
    expect(iso(cycleStart(anchor, every(IntervalUnit.Week, 2), 3))).toBe('2026-12-29T05:00:00.000Z');
  });

  it('days and weeks cross month and year ends', () => {
    expect(iso(cycleStart(new Date('2026-12-31T05:00:00Z'), every(IntervalUnit.Day), 1))).toBe('2027-01-01T05:00:00.000Z');
    expect(iso(cycleStart(new Date('2027-02-28T05:00:00Z'), every(IntervalUnit.Week), 1))).toBe('2027-03-07T05:00:00.000Z');
  });
});

describe('cycleStart: month and year (IST anchoring)', () => {
  // 10:00 IST == 04:30Z
  const at = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T04:30:00.000Z`;

  it('a 31 January anchor bills 31 Jan, 28 Feb, 31 Mar, 30 Apr, 31 May (never drifting to the 28th)', () => {
    const anchor = new Date(at(2026, 1, 31));
    const monthly = every(IntervalUnit.Month);
    expect([0, 1, 2, 3, 4, 5, 12].map((n) => iso(cycleStart(anchor, monthly, n)))).toEqual([
      at(2026, 1, 31),
      at(2026, 2, 28),
      at(2026, 3, 31),
      at(2026, 4, 30),
      at(2026, 5, 31),
      at(2026, 6, 30),
      at(2027, 1, 31),
    ]);
  });

  it('a 30 January anchor bills 30 Jan, 28 Feb, 30 Mar', () => {
    const anchor = new Date(at(2026, 1, 30));
    expect([1, 2].map((n) => iso(cycleStart(anchor, every(IntervalUnit.Month), n)))).toEqual([at(2026, 2, 28), at(2026, 3, 30)]);
  });

  it('a 30 or 31 January anchor lands on 29 Feb in a leap year', () => {
    expect(iso(cycleStart(new Date(at(2028, 1, 31)), every(IntervalUnit.Month), 1))).toBe(at(2028, 2, 29));
    expect(iso(cycleStart(new Date(at(2028, 1, 30)), every(IntervalUnit.Month), 1))).toBe(at(2028, 2, 29));
    expect(iso(cycleStart(new Date(at(2028, 1, 29)), every(IntervalUnit.Month), 1))).toBe(at(2028, 2, 29));
  });

  it('a 29 Feb anchor in a leap year: 28 Feb the next year, 29 Feb four years on', () => {
    const anchor = new Date(at(2024, 2, 29));
    const yearly = every(IntervalUnit.Year);
    expect(iso(cycleStart(anchor, yearly, 1))).toBe(at(2025, 2, 28));
    expect(iso(cycleStart(anchor, yearly, 2))).toBe(at(2026, 2, 28));
    expect(iso(cycleStart(anchor, yearly, 3))).toBe(at(2027, 2, 28));
    expect(iso(cycleStart(anchor, yearly, 4))).toBe(at(2028, 2, 29));
    expect(iso(cycleStart(anchor, every(IntervalUnit.Month), 12))).toBe(at(2025, 2, 28));
    expect(iso(cycleStart(anchor, every(IntervalUnit.Month), 48))).toBe(at(2028, 2, 29));
  });

  it('a 29 Feb anchor billed monthly goes 29 Feb, 29 Mar, 29 Apr', () => {
    const anchor = new Date(at(2024, 2, 29));
    expect([1, 2].map((n) => iso(cycleStart(anchor, every(IntervalUnit.Month), n)))).toEqual([at(2024, 3, 29), at(2024, 4, 29)]);
  });

  it('counts greater than one multiply the step: quarterly from 30 Nov', () => {
    const anchor = new Date(at(2026, 11, 30));
    const quarterly = every(IntervalUnit.Month, 3);
    expect([1, 2, 3, 4].map((n) => iso(cycleStart(anchor, quarterly, n)))).toEqual([
      at(2027, 2, 28),
      at(2027, 5, 30),
      at(2027, 8, 30),
      at(2027, 11, 30),
    ]);
  });

  it('every 2 years from 29 Feb 2024', () => {
    const anchor = new Date(at(2024, 2, 29));
    const biennial = every(IntervalUnit.Year, 2);
    expect(iso(cycleStart(anchor, biennial, 1))).toBe(at(2026, 2, 28));
    expect(iso(cycleStart(anchor, biennial, 2))).toBe(at(2028, 2, 29));
  });

  it('rolls over year boundaries', () => {
    const anchor = new Date(at(2025, 11, 15));
    expect(iso(cycleStart(anchor, every(IntervalUnit.Month), 3))).toBe(at(2026, 2, 15));
    expect(iso(cycleStart(anchor, every(IntervalUnit.Month), 14))).toBe(at(2027, 1, 15));
    expect(iso(cycleStart(new Date(at(2026, 12, 31)), every(IntervalUnit.Month, 2), 1))).toBe(at(2027, 2, 28));
  });

  it('keeps the IST time of day', () => {
    const start = cycleStart(new Date('2026-01-31T12:34:56.789Z'), every(IntervalUnit.Month), 1);
    expect(iso(start)).toBe('2026-02-28T12:34:56.789Z');
  });

  it('is computed from the anchor, not by chaining (n=2 is not n=1 plus one month)', () => {
    const anchor = new Date(at(2026, 1, 31));
    const first = cycleStart(anchor, every(IntervalUnit.Month), 1); // 28 Feb
    const chained = cycleStart(first, every(IntervalUnit.Month), 1); // 28 Mar if chained
    const direct = cycleStart(anchor, every(IntervalUnit.Month), 2); // 31 Mar
    expect(iso(chained)).toBe(at(2026, 3, 28));
    expect(iso(direct)).toBe(at(2026, 3, 31));
  });

  it('for every anchor day 1..31, every month unit cycle lands on min(day, month length) in IST', () => {
    const daysIn = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
    for (const startYear of [2023, 2024, 2025]) {
      for (let m0 = 0; m0 < 12; m0++) {
        const maxDay = daysIn(startYear, m0);
        for (let day = 1; day <= maxDay; day++) {
          const anchor = new Date(Date.UTC(startYear, m0, day, 4, 30));
          let previous = anchor.getTime() - 1;
          for (let n = 0; n <= 30; n++) {
            const start = cycleStart(anchor, every(IntervalUnit.Month), n);
            const targetIndex = m0 + n;
            const year = startYear + Math.floor(targetIndex / 12);
            const month0 = targetIndex % 12;
            const expected = `${year}-${String(month0 + 1).padStart(2, '0')}-${String(Math.min(day, daysIn(year, month0))).padStart(2, '0')}`;
            if (toIstDateString(start) !== expected) {
              expect.fail(`anchor ${anchor.toISOString()} cycle ${n}: got ${toIstDateString(start)}, want ${expected}`);
            }
            if (start.getTime() <= previous) expect.fail(`cycles not strictly increasing at ${anchor.toISOString()} n=${n}`);
            previous = start.getTime();
          }
        }
      }
    }
  });
});

describe('cycleStart around IST midnight', () => {
  const monthly = every(IntervalUnit.Month);

  it('18:29Z and 18:31Z on 31 Jan are different IST days and anchor different billing days', () => {
    const before = new Date('2026-01-31T18:29:00Z'); // 31 Jan 23:59 IST
    const after = new Date('2026-01-31T18:31:00Z'); //  1 Feb 00:01 IST
    expect(toIstDateString(before)).toBe('2026-01-31');
    expect(toIstDateString(after)).toBe('2026-02-01');

    // 31 Jan anchor -> end-of-month rules apply
    expect([1, 2, 3].map((n) => iso(cycleStart(before, monthly, n)))).toEqual([
      '2026-02-28T18:29:00.000Z', // 28 Feb 23:59 IST
      '2026-03-31T18:29:00.000Z', // 31 Mar 23:59 IST
      '2026-04-30T18:29:00.000Z', // 30 Apr 23:59 IST
    ]);
    // 1 Feb anchor -> bills on the 1st
    expect([1, 2, 3].map((n) => iso(cycleStart(after, monthly, n)))).toEqual([
      '2026-02-28T18:31:00.000Z', // 1 Mar 00:01 IST
      '2026-03-31T18:31:00.000Z', // 1 Apr 00:01 IST
      '2026-04-30T18:31:00.000Z', // 1 May 00:01 IST
    ]);
    expect(toIstDateString(cycleStart(after, monthly, 1))).toBe('2026-03-01');
    expect(toIstDateString(cycleStart(before, monthly, 1))).toBe('2026-02-28');
  });

  it('exactly 18:30:00Z is already the next IST day', () => {
    const boundary = new Date('2026-01-31T18:30:00Z');
    expect(toIstDateString(boundary)).toBe('2026-02-01');
    expect(iso(cycleStart(boundary, monthly, 1))).toBe('2026-02-28T18:30:00.000Z'); // 1 Mar 00:00 IST
  });

  it('a UTC-based implementation would use day 31 for the 18:31Z anchor; IST uses day 1', () => {
    const after = new Date('2026-03-31T18:31:00Z'); // 1 Apr 00:01 IST
    expect(toIstDateString(cycleStart(after, monthly, 1))).toBe('2026-05-01');
    expect(toIstDateString(cycleStart(after, monthly, 2))).toBe('2026-06-01');
  });

  it('a 29 Feb 23:59 IST leap anchor stays on the leap day when the year is 4 years on', () => {
    const anchor = new Date('2024-02-29T18:29:00Z'); // 29 Feb 23:59 IST
    expect(iso(cycleStart(anchor, every(IntervalUnit.Year), 1))).toBe('2025-02-28T18:29:00.000Z');
    expect(iso(cycleStart(anchor, every(IntervalUnit.Year), 4))).toBe('2028-02-29T18:29:00.000Z');
  });
});

describe('cycleStart validation', () => {
  const anchor = new Date('2026-11-17T05:00:00Z');

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects cycle index %s', (n) => {
    expect(codeOf(() => cycleStart(anchor, every(IntervalUnit.Month), n))).toBe(ErrorCode.Validation);
  });

  it('rejects an invalid interval even for cycle 0', () => {
    expect(codeOf(() => cycleStart(anchor, { unit: IntervalUnit.Month, count: 0 }, 0))).toBe(ErrorCode.Validation);
    expect(codeOf(() => cycleStart(anchor, { unit: 'decade' as IntervalUnit, count: 1 }, 1))).toBe(ErrorCode.Validation);
  });

  it('does not mutate the anchor', () => {
    const copy = anchor.getTime();
    cycleStart(anchor, every(IntervalUnit.Month), 5);
    expect(anchor.getTime()).toBe(copy);
  });
});

describe('resolveFirstChargeAt', () => {
  const now = new Date('2026-11-17T05:00:00Z');

  it('returns no date and not-a-trial when nothing is delayed', () => {
    expect(resolveFirstChargeAt({}, now)).toEqual({ isTrial: false });
  });

  it('trial.days counts from now', () => {
    const result = resolveFirstChargeAt({ trial: { days: 14 } }, now);
    expect(result.isTrial).toBe(true);
    expect(iso(result.firstChargeAt)).toBe('2026-12-01T05:00:00.000Z');
  });

  it('trial.endsAt accepts a string, a Date and epoch millis', () => {
    const endsAt = '2026-12-01T10:30:00+05:30';
    expect(iso(resolveFirstChargeAt({ trial: { endsAt } }, now).firstChargeAt)).toBe('2026-12-01T05:00:00.000Z');
    expect(iso(resolveFirstChargeAt({ trial: { endsAt: new Date(endsAt) } }, now).firstChargeAt)).toBe('2026-12-01T05:00:00.000Z');
    expect(iso(resolveFirstChargeAt({ trial: { endsAt: new Date(endsAt).getTime() } }, now).firstChargeAt)).toBe(
      '2026-12-01T05:00:00.000Z',
    );
    expect(resolveFirstChargeAt({ trial: { endsAt } }, now).isTrial).toBe(true);
  });

  it('startAt is a delayed start, not a trial', () => {
    const result = resolveFirstChargeAt({ startAt: '2026-12-01T05:00:00Z' }, now);
    expect(result.isTrial).toBe(false);
    expect(iso(result.firstChargeAt)).toBe('2026-12-01T05:00:00.000Z');
  });

  it('a trial one millisecond in the future is accepted', () => {
    const result = resolveFirstChargeAt({ startAt: new Date(now.getTime() + 1) }, now);
    expect(result.firstChargeAt?.getTime()).toBe(now.getTime() + 1);
  });

  it('rejects trial together with startAt', () => {
    expect(codeOf(() => resolveFirstChargeAt({ trial: { days: 7 }, startAt: '2026-12-01T05:00:00Z' }, now))).toBe(ErrorCode.Validation);
    expect(codeOf(() => resolveFirstChargeAt({ trial: { endsAt: '2026-12-01T05:00:00Z' }, startAt: '2026-12-02T05:00:00Z' }, now))).toBe(
      ErrorCode.Validation,
    );
  });

  it('rejects a trial with neither or both of days / endsAt', () => {
    expect(codeOf(() => resolveFirstChargeAt({ trial: {} }, now))).toBe(ErrorCode.Validation);
    expect(codeOf(() => resolveFirstChargeAt({ trial: { days: 7, endsAt: '2026-12-01T05:00:00Z' } }, now))).toBe(ErrorCode.Validation);
  });

  it.each([0, -3, 1.5, Number.NaN])('rejects trial.days %s', (days) => {
    expect(codeOf(() => resolveFirstChargeAt({ trial: { days } }, now))).toBe(ErrorCode.Validation);
  });

  it('rejects a trial that ends in the past or exactly now', () => {
    expect(codeOf(() => resolveFirstChargeAt({ trial: { endsAt: '2026-11-16T05:00:00Z' } }, now))).toBe(ErrorCode.Validation);
    expect(codeOf(() => resolveFirstChargeAt({ trial: { endsAt: now } }, now))).toBe(ErrorCode.Validation);
  });

  it('rejects startAt in the past or exactly now', () => {
    expect(codeOf(() => resolveFirstChargeAt({ startAt: '2026-11-16T05:00:00Z' }, now))).toBe(ErrorCode.Validation);
    expect(codeOf(() => resolveFirstChargeAt({ startAt: now }, now))).toBe(ErrorCode.Validation);
  });

  it('rejects unparseable dates, naming the field', () => {
    expect(() => resolveFirstChargeAt({ startAt: 'next tuesday' }, now)).toThrow(/startAt/);
    expect(() => resolveFirstChargeAt({ trial: { endsAt: 'soon' } }, now)).toThrow(/trial\.endsAt/);
  });

  it('does not mutate now', () => {
    const before = now.getTime();
    resolveFirstChargeAt({ trial: { days: 3 } }, now);
    expect(now.getTime()).toBe(before);
  });
});
