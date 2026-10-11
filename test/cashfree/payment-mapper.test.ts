import { describe, expect, it } from 'vitest';
import { PaymentMethod, PaymentStatus, RefundStatus } from '../../src/constants.js';
import {
  ATTEMPT_STATUS_MAP,
  CashfreeAttemptStatus,
  CashfreeOrderRefundStatus,
  CashfreeOrderStatus,
  ORDER_PAYMENT_METHODS,
  ORDER_REFUND_STATUS_MAP,
  ORDER_STATUS_MAP,
  PAYMENT_METHOD_TO_FILTER_VALUES,
} from '../../src/providers/cashfree/constants.js';
import { mapAttemptStatus, mapOrderRefundStatus, mapOrderStatus, methodOfAttempt } from '../../src/providers/cashfree/mapper.js';

// The statuses and groups below are those listed on api-reference/payments/latest/orders/create (order_status),
// payments/online/resources/payment-lifecycle (payment states), api-reference/payments/latest/payments/get-payments-for-order
// (payment_group) and api-reference/payments/latest/refunds/create-refund (refund_status).

describe('order status', () => {
  const expected: Record<string, PaymentStatus> = {
    ACTIVE: PaymentStatus.Created,
    PAID: PaymentStatus.Succeeded,
    EXPIRED: PaymentStatus.Failed,
    TERMINATED: PaymentStatus.Cancelled,
    TERMINATION_REQUESTED: PaymentStatus.Pending,
  };

  it('has an entry for every documented status', () => {
    expect(Object.keys(ORDER_STATUS_MAP).sort()).toEqual(Object.values(CashfreeOrderStatus).sort());
    expect(Object.keys(ORDER_STATUS_MAP).sort()).toEqual(Object.keys(expected).sort());
  });

  it.each(Object.entries(expected))('%s maps to %s, whatever its case', (status, unified) => {
    expect(mapOrderStatus(status)).toBe(unified);
    expect(mapOrderStatus(status.toLowerCase())).toBe(unified);
  });

  it('maps a status Cashfree adds later to pending, never to paid or failed', () => {
    expect(mapOrderStatus('SETTLED')).toBe(PaymentStatus.Pending);
    expect(mapOrderStatus('constructor')).toBe(PaymentStatus.Pending);
    expect(mapOrderStatus('')).toBe(PaymentStatus.Pending);
  });
});

describe('payment attempt status', () => {
  const expected: Record<string, PaymentStatus> = {
    SUCCESS: PaymentStatus.Succeeded,
    NOT_ATTEMPTED: PaymentStatus.Created,
    FAILED: PaymentStatus.Failed,
    USER_DROPPED: PaymentStatus.Cancelled,
    VOID: PaymentStatus.Cancelled,
    CANCELLED: PaymentStatus.Cancelled,
    PENDING: PaymentStatus.Pending,
    FLAGGED: PaymentStatus.Pending,
  };

  it('has an entry for every documented status', () => {
    expect(Object.keys(ATTEMPT_STATUS_MAP).sort()).toEqual(Object.values(CashfreeAttemptStatus).sort());
    expect(Object.keys(ATTEMPT_STATUS_MAP).sort()).toEqual(Object.keys(expected).sort());
  });

  it.each(Object.entries(expected))('%s maps to %s', (status, unified) => {
    expect(mapAttemptStatus(status)).toBe(unified);
  });

  it('maps a missing or unknown status to pending', () => {
    expect(mapAttemptStatus(undefined)).toBe(PaymentStatus.Pending);
    expect(mapAttemptStatus(null)).toBe(PaymentStatus.Pending);
    expect(mapAttemptStatus('MYSTERY')).toBe(PaymentStatus.Pending);
  });
});

describe('refund status', () => {
  const expected: Record<string, RefundStatus> = {
    SUCCESS: RefundStatus.Succeeded,
    PENDING: RefundStatus.Pending,
    PENDING_APPROVAL: RefundStatus.Pending,
    ONHOLD: RefundStatus.Pending,
    CANCELLED: RefundStatus.Failed,
    REJECTED: RefundStatus.Failed,
  };

  it('has an entry for every documented status', () => {
    expect(Object.keys(ORDER_REFUND_STATUS_MAP).sort()).toEqual(Object.values(CashfreeOrderRefundStatus).sort());
    expect(Object.keys(ORDER_REFUND_STATUS_MAP).sort()).toEqual(Object.keys(expected).sort());
  });

  it.each(Object.entries(expected))('%s maps to %s', (status, unified) => {
    expect(mapOrderRefundStatus(status)).toBe(unified);
  });

  it('maps an unknown refund status to pending: the money may still move', () => {
    expect(mapOrderRefundStatus('REVERSED')).toBe(RefundStatus.Pending);
  });
});

describe('payment method of an attempt', () => {
  it.each([
    ['upi', PaymentMethod.Upi],
    ['upi_credit_card', PaymentMethod.Upi],
    ['upi_ppi', PaymentMethod.Upi],
    ['upi_ppi_offline', PaymentMethod.Upi],
    ['credit_card', PaymentMethod.Card],
    ['debit_card', PaymentMethod.Card],
    ['prepaid_card', PaymentMethod.Card],
    ['credit_card_emi', PaymentMethod.Card],
    ['debit_card_emi', PaymentMethod.Card],
    ['net_banking', PaymentMethod.NetBanking],
    ['wallet', PaymentMethod.Wallet],
  ])('payment_group %s is %s', (group, method) => {
    expect(methodOfAttempt({ payment_group: group })).toBe(method);
  });

  it('leaves a group with no unified method undefined', () => {
    for (const group of ['cash', 'paypal', 'cardless_emi', 'bank_transfer', 'pay_later', 'something_new']) {
      expect(methodOfAttempt({ payment_group: group }), group).toBeUndefined();
    }
  });

  it('falls back to the key of payment_method when there is no group', () => {
    expect(methodOfAttempt({ payment_method: { netbanking: { channel: null } } })).toBe(PaymentMethod.NetBanking);
    expect(methodOfAttempt({ payment_method: { card: {} } })).toBe(PaymentMethod.Card);
    expect(methodOfAttempt({ payment_method: { upi: {} } })).toBe(PaymentMethod.Upi);
    expect(methodOfAttempt({ payment_method: {} })).toBeUndefined();
    expect(methodOfAttempt({})).toBeUndefined();
  });
});

describe('payment method filters', () => {
  it('names every one-time method with values the documentation lists', () => {
    // api-reference/payments/latest/orders/create: "debit_card, credit_card, prepaid_card, upi, wallet, netbanking, ..."
    expect(Object.keys(PAYMENT_METHOD_TO_FILTER_VALUES).sort()).toEqual([...ORDER_PAYMENT_METHODS].sort());
    expect(PAYMENT_METHOD_TO_FILTER_VALUES).toEqual({
      [PaymentMethod.Upi]: ['upi'],
      [PaymentMethod.Card]: ['credit_card', 'debit_card', 'prepaid_card'],
      [PaymentMethod.NetBanking]: ['netbanking'],
      [PaymentMethod.Wallet]: ['wallet'],
    });
  });
});
