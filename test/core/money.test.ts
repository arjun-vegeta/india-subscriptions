import { describe, expect, it } from 'vitest';
import { ErrorCode } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import { assertPaise, paiseToRupeeNumber, paiseToRupeeString, rupeesToPaise, toPaiseOrUndefined } from '../../src/money.js';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof SubscriptionError ? error.code : `non-SubscriptionError: ${String(error)}`;
  }
  return undefined;
}

/** Independent oracle: decimal string -> BigInt paise with no floating point. */
function oraclePaise(rupees: string): bigint {
  const [whole = '0', frac = ''] = rupees.split('.');
  return BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
}

describe('assertPaise', () => {
  it.each([0, 1, 99, 49900, Number.MAX_SAFE_INTEGER])('accepts %s and returns it unchanged', (value) => {
    expect(assertPaise(value, 'amount')).toBe(value);
  });

  it.each([
    ['a fraction', 499.5],
    ['a tiny fraction', 0.1 + 0.2],
    ['a negative', -1],
    ['negative zero is fine but -0.5 is not', -0.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['an unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['a numeric string', '499'],
    ['null', null],
    ['undefined', undefined],
    ['an object', {}],
    ['a bigint', 5n],
  ])('rejects %s with VALIDATION', (_label, value) => {
    expect(codeOf(() => assertPaise(value, 'amount'))).toBe(ErrorCode.Validation);
  });

  it('names the offending field in the message', () => {
    expect(() => assertPaise(-5, 'upfrontAmount')).toThrow(/upfrontAmount/);
  });
});

describe('paiseToRupeeString', () => {
  it.each([
    [0, '0.00'],
    [1, '0.01'],
    [5, '0.05'],
    [7, '0.07'],
    [10, '0.10'],
    [99, '0.99'],
    [100, '1.00'],
    [115, '1.15'],
    [1999, '19.99'],
    [49900, '499.00'],
    [49950, '499.50'],
    [499999, '4999.99'],
    [123456789, '1234567.89'],
  ])('%s paise -> %s', (paise, expected) => {
    expect(paiseToRupeeString(paise)).toBe(expected);
  });

  it('handles the largest safe integer without drift', () => {
    expect(paiseToRupeeString(Number.MAX_SAFE_INTEGER)).toBe('90071992547409.91');
  });

  it.each([1.5, -1, Number.NaN, '100' as unknown as number])('rejects %s', (value) => {
    expect(codeOf(() => paiseToRupeeString(value))).toBe(ErrorCode.Validation);
  });
});

describe('paiseToRupeeNumber', () => {
  it.each([
    [0, 0],
    [7, 0.07],
    [115, 1.15],
    [1999, 19.99],
    [49900, 499],
    [49950, 499.5],
    [499999, 4999.99],
  ])('%s paise -> %s', (paise, expected) => {
    expect(paiseToRupeeNumber(paise)).toBe(expected);
  });

  it('rejects non-integer paise', () => {
    expect(codeOf(() => paiseToRupeeNumber(0.5))).toBe(ErrorCode.Validation);
  });
});

describe('rupeesToPaise', () => {
  it.each([
    ['499', 49900],
    ['499.5', 49950],
    ['499.50', 49950],
    ['499.00', 49900],
    ['0.07', 7],
    ['0.7', 70],
    ['0', 0],
    ['0.00', 0],
    ['1.15', 115],
    ['19.99', 1999],
    ['4999.99', 499999],
    ['  499.50  ', 49950],
    ['00499', 49900],
  ])('string %j -> %s', (input, expected) => {
    expect(rupeesToPaise(input)).toBe(expected);
  });

  it.each([
    [499, 49900],
    [499.5, 49950],
    [0.07, 7],
    [0.7, 70],
    [1.15, 115],
    [19.99, 1999],
    [4999.99, 499999],
    [0.1 + 0.2, 30],
    [1.1 + 2.2, 330],
    [0.57, 57],
    [8.2 - 0.1, 810],
    [0, 0],
  ])('number %s -> %s without float drift', (input, expected) => {
    expect(rupeesToPaise(input)).toBe(expected);
  });

  it('rounds a stray third decimal half up (gateways should never send one)', () => {
    expect(rupeesToPaise('1.004')).toBe(100);
    expect(rupeesToPaise('1.005')).toBe(101);
    expect(rupeesToPaise('499.999')).toBe(50000);
  });

  it('keeps the sign of negative amounts', () => {
    expect(rupeesToPaise('-5.25')).toBe(-525);
    expect(rupeesToPaise(-0.5)).toBe(-50);
  });

  it.each([undefined, null, ''])('returns undefined for empty input %j', (input) => {
    expect(rupeesToPaise(input)).toBeUndefined();
  });

  it.each([
    'abc',
    '12abc',
    '1,499.00',
    '₹499',
    '1e3',
    '.5',
    '499.',
    '--5',
    '1.2.3',
    ' ',
    'NaN',
    'Infinity',
    '0x10',
    true,
    {},
    [],
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ])('returns undefined for garbage %j', (input) => {
    expect(rupeesToPaise(input)).toBeUndefined();
  });

  it('round-trips every paise value 0..200000 through the string form', () => {
    for (let paise = 0; paise <= 200_000; paise++) {
      const text = paiseToRupeeString(paise);
      expect(text).toMatch(/^\d+\.\d{2}$/);
      if (rupeesToPaise(text) !== paise) expect.fail(`string round trip failed for ${paise}: ${text}`);
    }
  });

  it('round-trips every paise value 0..200000 through the JSON-number form', () => {
    for (let paise = 0; paise <= 200_000; paise++) {
      const rupees = paiseToRupeeNumber(paise);
      if (rupeesToPaise(rupees) !== paise) expect.fail(`number round trip failed for ${paise}: ${rupees}`);
    }
  });

  it('agrees with a BigInt oracle on large pseudo-random amounts', () => {
    let seed = 123456789;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let i = 0; i < 2000; i++) {
      // up to ~1e12 paise (1e10 rupees), well inside double precision for the number form
      const paise = next() * 400 + (next() % 400);
      const text = paiseToRupeeString(paise);
      expect(oraclePaise(text)).toBe(BigInt(paise));
      expect(rupeesToPaise(text)).toBe(paise);
      expect(rupeesToPaise(paiseToRupeeNumber(paise))).toBe(paise);
    }
  });

  // DEFECT (src/money.ts, toPlainString + rupeesToPaise): a non-integer double whose 4-decimal
  // rendering is all zeros (1.99999, 0.3 * 3 + 0.1 = 0.9999999999999999, 19.99 * 100 =
  // 1998.9999999999998, 0.00001) goes through toFixed(4).replace(/0+$/, ''), which leaves a
  // dangling "." ("2.", "1.", "1999.", "0."). The regex then rejects it and the amount comes back
  // as undefined instead of the nearest paise. Callers that treat undefined as "no amount" would
  // silently drop a real amount.
  it('parses 1.99999 as 200 paise', () => {
    expect(rupeesToPaise(1.99999)).toBe(200);
  });

  it('parses 0.3 * 3 + 0.1 (0.9999999999999999) as 100 paise', () => {
    expect(rupeesToPaise(0.3 * 3 + 0.1)).toBe(100);
  });

  it('parses 19.99 * 100 (1998.9999999999998) as 199900 paise', () => {
    expect(rupeesToPaise(19.99 * 100)).toBe(199900);
  });

  it('parses 0.00001 as 0 paise', () => {
    expect(rupeesToPaise(0.00001)).toBe(0);
  });
});

describe('toPaiseOrUndefined', () => {
  it.each([
    [499, 499],
    [499.4, 499],
    [499.5, 500],
    [0, 0],
  ])('%s -> %s', (input, expected) => {
    expect(toPaiseOrUndefined(input)).toBe(expected);
  });

  it.each(['499', null, undefined, Number.NaN, Number.POSITIVE_INFINITY, {}])('returns undefined for %j', (input) => {
    expect(toPaiseOrUndefined(input)).toBeUndefined();
  });
});
