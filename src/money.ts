import { invalid } from './errors.js';

/**
 * Every amount in this library's public API is an integer in paise.
 * Gateways disagree (Razorpay: paise; Cashfree and PayU: rupees), so the
 * adapters convert at the edge with these helpers and never with float maths.
 */

export function assertPaise(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalid(`${field} must be a non-negative integer amount in paise, got ${String(value)}`);
  }
  return value;
}

/** 49900 -> "499.00" */
export function paiseToRupeeString(paise: number): string {
  assertPaise(paise, 'amount');
  const rupees = Math.trunc(paise / 100);
  const rest = paise % 100;
  return `${rupees}.${rest < 10 ? '0' : ''}${rest}`;
}

/** 49900 -> 499, 49950 -> 499.5 (a JSON number that round-trips exactly). */
export function paiseToRupeeNumber(paise: number): number {
  return Number(paiseToRupeeString(paise));
}

/**
 * Parses a rupee amount as gateways send it ("499", "499.5", "499.00", 499.5)
 * into paise without float drift. Returns undefined for empty input.
 */
export function rupeesToPaise(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const text = typeof value === 'number' ? toPlainString(value) : String(value).trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return undefined;
  const [, sign, whole, fraction = ''] = match;
  const padded = (fraction + '00').slice(0, 2);
  // Round half up on a third decimal, which gateways should never send.
  const roundUp = fraction.length > 2 && Number(fraction[2]) >= 5 ? 1 : 0;
  const paise = Number(whole) * 100 + Number(padded) + roundUp;
  return sign ? -paise : paise;
}

function toPlainString(value: number): string {
  if (!Number.isFinite(value)) return 'NaN';
  // Avoid exponent notation; amounts never need more than 2 decimals.
  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, '');
}

export function toPaiseOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined;
}
