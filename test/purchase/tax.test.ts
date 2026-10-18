import { describe, expect, it } from 'vitest';
import { splitRefund, splitTax } from '../../src/purchase/index.js';

describe('splitTax', () => {
  it('splits a tax-inclusive charge', () => {
    expect(splitTax(59_000, 1800)).toEqual({ amount: 50_000, taxAmount: 9_000 });
    expect(splitTax(11_800, 1800)).toEqual({ amount: 10_000, taxAmount: 1_800 });
    expect(splitTax(100, 0)).toEqual({ amount: 100, taxAmount: 0 });
    expect(splitTax(0, 1800)).toEqual({ amount: 0, taxAmount: 0 });
  });

  it('rounds the pre-tax amount half up and gives the tax the rest', () => {
    // 100 paise at 18%: 84.745... pre-tax
    expect(splitTax(100, 1800)).toEqual({ amount: 85, taxAmount: 15 });
    // 1 paise at 18%: 0.847 -> 1, tax 0
    expect(splitTax(1, 1800)).toEqual({ amount: 1, taxAmount: 0 });
  });

  it('always sums to the charged amount, never goes negative, and the tax never exceeds the rate', () => {
    for (const rate of [0, 1, 500, 1200, 1800, 2800, 10_000]) {
      for (let gross = 0; gross <= 5_000; gross += 7) {
        const { amount, taxAmount } = splitTax(gross, rate);
        expect(amount + taxAmount).toBe(gross);
        expect(amount).toBeGreaterThanOrEqual(0);
        expect(taxAmount).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(amount) && Number.isInteger(taxAmount)).toBe(true);
        // Within one paisa of the exact split.
        expect(Math.abs(taxAmount - (gross * rate) / (10_000 + rate))).toBeLessThanOrEqual(0.5 + 1e-9);
      }
    }
  });

  it('is exact for large amounts', () => {
    const gross = 9_999_999_999;
    const { amount, taxAmount } = splitTax(gross, 1800);
    expect(amount + taxAmount).toBe(gross);
  });

  it('rejects amounts and rates that are not whole non-negative numbers', () => {
    expect(() => splitTax(-1, 1800)).toThrow(RangeError);
    expect(() => splitTax(10.5, 1800)).toThrow(RangeError);
    expect(() => splitTax(100, -1)).toThrow(RangeError);
    expect(() => splitTax(100, 18.5)).toThrow(RangeError);
  });
});

describe('splitRefund', () => {
  const original = { amount: 50_000, taxAmount: 9_000 };

  it('splits a partial refund in the proportions of the transaction', () => {
    expect(splitRefund(11_800, original)).toEqual({ amount: 10_000, taxAmount: 1_800 });
    expect(splitRefund(29_500, original)).toEqual({ amount: 25_000, taxAmount: 4_500 });
  });

  it('always sums to the refund and never refunds more pre-tax than was charged', () => {
    for (let refund = 0; refund <= 59_000; refund += 131) {
      const split = splitRefund(refund, original);
      expect(split.amount + split.taxAmount).toBe(refund);
      expect(split.amount).toBeLessThanOrEqual(original.amount);
      expect(split.taxAmount).toBeLessThanOrEqual(original.taxAmount);
      expect(split.taxAmount).toBeGreaterThanOrEqual(0);
    }
    expect(splitRefund(59_000, original)).toEqual(original);
  });

  it('puts everything in the tax when the original was a zero transaction', () => {
    expect(splitRefund(100, { amount: 0, taxAmount: 0 })).toEqual({ amount: 0, taxAmount: 100 });
  });
});
