import { describe, expect, it } from 'vitest';
import { milliunitsToPaise } from '../../src/providers/appstore/index.js';
import { refundedAmountOf, isForeignCurrency } from '../../src/providers/appstore/mapper.js';
import { transactionPayload } from './helpers.js';
import { TransactionPayloadSchema } from '../../src/providers/appstore/schemas.js';

describe('price in milliunits to paise (App Store Server API: price)', () => {
  it.each([
    [499_000, 49_900],
    [0, 0],
    [10, 1],
    [1_000, 100],
    [99_000, 9_900],
    [1_499_000, 149_900],
    // Whole-rupee prices are exact; anything else is rounded half up in integers.
    [1_004, 100],
    [1_005, 101],
    [1_009, 101],
    [4, 0],
    [5, 1],
    // No float drift on large amounts: INR 9,999,999.99 and a sum that floats would round.
    [9_999_999_990, 999_999_999],
    [9_007_199_254_740_990, 900_719_925_474_099],
  ])('%i milliunits is %i paise', (milliunits, paise) => {
    expect(milliunitsToPaise(milliunits)).toBe(paise);
  });

  it("follows Apple's own examples: one currency unit is 1000 milliunits", () => {
    // `$1.99` is 1990 and `JPY 300` is 300000 on the price page; for INR 1.99, 1990 milliunits is 199 paise.
    expect(milliunitsToPaise(1_990)).toBe(199);
  });

  it('currency checks', () => {
    expect(isForeignCurrency('INR')).toBe(false);
    expect(isForeignCurrency(undefined)).toBe(false);
    expect(isForeignCurrency(null)).toBe(false);
    expect(isForeignCurrency('USD')).toBe(true);
    expect(isForeignCurrency('inr')).toBe(true);
  });

  it('prorates a refund in integers, half up', () => {
    const tx = (extra: Record<string, unknown>) => TransactionPayloadSchema.parse(transactionPayload({ revocationDate: 1, ...extra }));
    expect(refundedAmountOf(tx({ revocationType: 'REFUND_PRORATED', revocationPercentage: 100_000 }))).toBe(49_900);
    expect(refundedAmountOf(tx({ revocationType: 'REFUND_PRORATED', revocationPercentage: 1 }))).toBe(0);
    expect(refundedAmountOf(tx({ revocationType: 'REFUND_PRORATED', revocationPercentage: 50_000, price: 1_010 }))).toBe(51);
    expect(refundedAmountOf(tx({ revocationType: 'FAMILY_REVOKE' }))).toBeUndefined();
    expect(refundedAmountOf(TransactionPayloadSchema.parse(transactionPayload()))).toBeUndefined();
  });
});
