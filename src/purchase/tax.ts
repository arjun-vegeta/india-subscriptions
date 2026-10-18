import { BPS_DENOMINATOR } from './constants.js';

/** A charge split into what Google calls the pre-tax amount and the tax, in integer paise. */
export interface TaxSplit {
  /** Pre-tax amount in paise. */
  amount: number;
  /** Tax in paise. */
  taxAmount: number;
}

/**
 * Splits a tax-inclusive charge: `gross = amount + taxAmount` always holds. The pre-tax amount is
 * `gross * 10000 / (10000 + rateBps)` rounded half up, the tax is the rest, so the two never drift from the charge.
 * A rate of 0 puts everything in `amount`. Integer arithmetic only.
 */
export function splitTax(gross: number, taxRateBps: number): TaxSplit {
  if (!Number.isInteger(gross) || gross < 0) throw new RangeError(`gross must be a non-negative integer, got ${gross}`);
  if (!Number.isInteger(taxRateBps) || taxRateBps < 0) throw new RangeError(`taxRateBps must be a non-negative integer, got ${taxRateBps}`);
  const divisor = BPS_DENOMINATOR + taxRateBps;
  const amount = Math.floor((2 * gross * BPS_DENOMINATOR + divisor) / (2 * divisor));
  return { amount, taxAmount: gross - amount };
}

/**
 * Splits a refund of `refund` paise (tax included) in the same proportions as the transaction it refunds, so the
 * parts sum to the refund and the pre-tax part never exceeds the transaction's pre-tax amount.
 */
export function splitRefund(refund: number, original: TaxSplit): TaxSplit {
  const gross = original.amount + original.taxAmount;
  if (gross === 0) return { amount: 0, taxAmount: refund };
  const amount = Math.floor((2 * refund * original.amount + gross) / (2 * gross));
  return { amount, taxAmount: refund - amount };
}
