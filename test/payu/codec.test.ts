import { describe, expect, it } from 'vitest';
import { ErrorCode, PaymentMethod } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import {
  PAYU_MANDATE_METHODS,
  SUBSCRIPTION_ID_SEPARATOR,
  decodeSubscriptionId,
  encodeSubscriptionId,
} from '../../src/providers/payu/index.js';

function validationError(run: () => unknown): SubscriptionError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SubscriptionError);
    return error as SubscriptionError;
  }
  throw new Error('expected an error');
}

describe('subscription id codec', () => {
  it('uses ":" and the shared payment method tokens', () => {
    expect(SUBSCRIPTION_ID_SEPARATOR).toBe(':');
    expect(PAYU_MANDATE_METHODS).toEqual([PaymentMethod.Card, PaymentMethod.Upi, PaymentMethod.ENach]);
  });

  /** mihpayid values are from reference__upi-recurring-payment-consent-transaction, reference__credit-card-recurring-payment-consent-transaction and reference__netbanking-recurring-payment-consent-transaction. */
  it.each([
    [PaymentMethod.Upi, '25600438037', 'upi:25600438037'],
    [PaymentMethod.Card, '25600342065', 'card:25600342065'],
    [PaymentMethod.ENach, '403993715525331373', 'enach:403993715525331373'],
  ] as const)('round-trips %s', (method, mandateId, encoded) => {
    expect(encodeSubscriptionId({ method, mandateId })).toBe(encoded);
    expect(decodeSubscriptionId(encoded)).toEqual({ method, mandateId });
  });

  it('keeps an 18-digit id exact (no number round trip)', () => {
    expect(decodeSubscriptionId('enach:403993715525331373').mandateId).toBe('403993715525331373');
  });

  it.each([
    ['a bare mihpayid', '25600438037'],
    ['an unknown method', 'wallet:25600438037'],
    ['physical NACH, which PayU does not offer', 'physical_nach:25600438037'],
    ['an empty id', 'upi:'],
    ['an empty method', ':25600438037'],
    ['a method in the wrong case', 'UPI:25600438037'],
    ['an id with whitespace', 'upi:2560 0438037'],
    ['an id with a second separator', 'upi:256:00438037'],
    ['an id that could break out of JSON', 'upi:1","amount":"1'],
    ['an empty string', ''],
  ])('rejects %s with VALIDATION and a clear message', (_label, value) => {
    const error = validationError(() => decodeSubscriptionId(value));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(error.message).toContain('not a PayU subscription id');
    expect(error.message).toContain('verifyCheckout');
  });

  it('rejects a non-string', () => {
    expect(validationError(() => decodeSubscriptionId(undefined)).code).toBe(ErrorCode.Validation);
    expect(validationError(() => decodeSubscriptionId(12345)).code).toBe(ErrorCode.Validation);
  });

  it('refuses to encode a method or id PayU cannot use', () => {
    expect(validationError(() => encodeSubscriptionId({ method: PaymentMethod.PhysicalNach as never, mandateId: '1' })).code).toBe(
      ErrorCode.Validation,
    );
    expect(validationError(() => encodeSubscriptionId({ method: PaymentMethod.Upi, mandateId: '' })).code).toBe(
      ErrorCode.Validation,
    );
  });
});
