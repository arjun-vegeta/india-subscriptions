import { describe, expect, it } from 'vitest';
import { EventType, PaymentMethod, PaymentStatus } from '../../src/constants.js';
import {
  RazorpayOneTimeMethodName,
  RazorpayOrderStatus,
  RazorpayPaymentStatus,
  RazorpayPaymentWebhookEvent,
  RazorpayRefundWebhookEvent,
} from '../../src/providers/razorpay/constants.js';
import {
  ONE_TIME_PAYMENT_METHOD_MAP,
  ONE_TIME_PAYMENT_STATUS_MAP,
  ORDER_STATUS_MAP,
  PAYMENT_WEBHOOK_EVENT_MAP,
  REFUND_WEBHOOK_EVENT_MAP,
  UNKNOWN_ONE_TIME_PAYMENT_STATUS,
  mapAttemptStatus,
  mapOneTimePaymentMethod,
  mapPaymentMethod,
  pickAttempt,
} from '../../src/providers/razorpay/mapper.js';
import type { RazorpayPaymentEntity } from '../../src/providers/razorpay/schemas.js';

/*
 * Status and method lookup tables for one-time payments. The status names are
 * those of the Razorpay Payments entity (api/payments/entity) and Orders
 * entity (api/orders/entity); the table values are written out here
 * independently of the mapper.
 */

const attempt = (over: Partial<RazorpayPaymentEntity> = {}): RazorpayPaymentEntity => ({
  id: 'pay_1',
  amount: 1000,
  status: 'captured',
  order_id: 'order_1',
  ...over,
});

describe('one-time payment status tables', () => {
  it.each([
    ['created', PaymentStatus.Pending],
    ['authorized', PaymentStatus.Pending],
    ['captured', PaymentStatus.Succeeded],
    ['refunded', PaymentStatus.Refunded],
    ['failed', PaymentStatus.Failed],
  ])('maps the payment status %s to %s', (razorpayStatus, expected) => {
    expect(mapAttemptStatus(attempt({ status: razorpayStatus }))).toBe(expected);
  });

  it('covers every documented payment status, and nothing else', () => {
    expect(Object.keys(ONE_TIME_PAYMENT_STATUS_MAP).sort()).toEqual(Object.values(RazorpayPaymentStatus).sort());
    expect(Object.keys(ONE_TIME_PAYMENT_STATUS_MAP).sort()).toEqual(['authorized', 'captured', 'created', 'failed', 'refunded']);
  });

  it.each([
    ['created', PaymentStatus.Created],
    ['attempted', PaymentStatus.Pending],
    ['paid', PaymentStatus.Succeeded],
  ])('maps the order status %s to %s', (razorpayStatus, expected) => {
    expect(ORDER_STATUS_MAP[razorpayStatus as RazorpayOrderStatus]).toBe(expected);
  });

  it('covers every documented order status, and nothing else', () => {
    expect(Object.keys(ORDER_STATUS_MAP).sort()).toEqual(Object.values(RazorpayOrderStatus).sort());
    expect(Object.keys(ORDER_STATUS_MAP).sort()).toEqual(['attempted', 'created', 'paid']);
  });

  it('falls back to pending for a status Razorpay adds later, never to success', () => {
    expect(UNKNOWN_ONE_TIME_PAYMENT_STATUS).toBe(PaymentStatus.Pending);
    expect(mapAttemptStatus(attempt({ status: 'under_review' }))).toBe(PaymentStatus.Pending);
    expect(mapAttemptStatus(attempt({ status: 'toString' }))).toBe(PaymentStatus.Pending);
    expect(mapAttemptStatus(attempt({ status: '' }))).toBe(PaymentStatus.Pending);
  });

  describe('the refund state of a captured payment', () => {
    it.each([
      ['no refund', { amount_refunded: 0, refund_status: null }, PaymentStatus.Succeeded],
      ['no refund fields', {}, PaymentStatus.Succeeded],
      ['refund_status partial', { amount_refunded: 10, refund_status: 'partial' }, PaymentStatus.PartiallyRefunded],
      ['refund_status full', { amount_refunded: 1000, refund_status: 'full' }, PaymentStatus.Refunded],
      ['an amount refunded with no refund_status', { amount_refunded: 10 }, PaymentStatus.PartiallyRefunded],
      ['the whole amount refunded with no refund_status', { amount_refunded: 1000 }, PaymentStatus.Refunded],
    ])('%s', (_label, over, expected) => {
      expect(mapAttemptStatus(attempt(over))).toBe(expected);
    });

    it('does not read refund fields on a payment that was never captured', () => {
      expect(mapAttemptStatus(attempt({ status: 'failed', amount_refunded: 1000, refund_status: 'full' }))).toBe(PaymentStatus.Failed);
    });
  });
});

describe('pickAttempt', () => {
  const failed = attempt({ id: 'pay_failed', status: 'failed', created_at: 100 });
  const later = attempt({ id: 'pay_later', status: 'failed', created_at: 200 });
  const authorized = attempt({ id: 'pay_auth', status: 'authorized', created_at: 150 });
  const captured = attempt({ id: 'pay_captured', status: 'captured', created_at: 120 });

  it('prefers the payment that took the money, then an authorised one, then the most recent', () => {
    expect(pickAttempt([failed, later, captured, authorized])?.id).toBe('pay_captured');
    expect(pickAttempt([failed, authorized, later])?.id).toBe('pay_auth');
    expect(pickAttempt([later, failed])?.id).toBe('pay_later');
    expect(pickAttempt([failed])?.id).toBe('pay_failed');
    expect(pickAttempt([])).toBeUndefined();
  });

  it('keeps the order Razorpay listed attempts in when timestamps are equal', () => {
    const a = attempt({ id: 'pay_a', status: 'failed', created_at: 5 });
    const b = attempt({ id: 'pay_b', status: 'created', created_at: 5 });
    expect(pickAttempt([a, b])?.id).toBe('pay_b');
  });

  it('treats a refunded payment as the one that took the money', () => {
    expect(pickAttempt([failed, attempt({ id: 'pay_refunded', status: 'refunded' })])?.id).toBe('pay_refunded');
  });
});

describe('payment methods', () => {
  it.each([
    ['card', PaymentMethod.Card],
    ['upi', PaymentMethod.Upi],
    ['netbanking', PaymentMethod.NetBanking],
    ['wallet', PaymentMethod.Wallet],
    ['UPI', PaymentMethod.Upi],
  ])('maps the payment method %s to %s', (method, expected) => {
    expect(mapOneTimePaymentMethod(method)).toBe(expected);
  });

  it('leaves methods with no unified name unset: emi, cod and anything new', () => {
    for (const method of ['emi', 'cod', 'paylater', 'toString', '', null, undefined]) {
      expect(mapOneTimePaymentMethod(method)).toBeUndefined();
    }
  });

  it('covers the Payments entity methods that have a unified name', () => {
    expect(Object.keys(ONE_TIME_PAYMENT_METHOD_MAP).sort()).toEqual(Object.values(RazorpayOneTimeMethodName).sort());
  });

  it('leaves the subscription mapping as it was: a mandate is never a wallet or net banking payment', () => {
    expect(mapPaymentMethod('wallet')).toBeUndefined();
    expect(mapPaymentMethod('netbanking')).toBeUndefined();
    expect(mapPaymentMethod('emandate')).toBe(PaymentMethod.ENach);
  });
});

describe('webhook event tables', () => {
  it('maps the payment and order events and leaves payment.authorized out', () => {
    expect(PAYMENT_WEBHOOK_EVENT_MAP).toEqual({
      'payment.captured': EventType.PaymentSucceeded,
      'order.paid': EventType.PaymentSucceeded,
      'payment.failed': EventType.PaymentFailed,
    });
    expect(Object.keys(PAYMENT_WEBHOOK_EVENT_MAP).sort()).toEqual(Object.values(RazorpayPaymentWebhookEvent).sort());
  });

  it('maps the refund events that say how a refund ended and leaves created and speed_changed out', () => {
    expect(REFUND_WEBHOOK_EVENT_MAP).toEqual({
      'refund.processed': EventType.RefundSucceeded,
      'refund.failed': EventType.RefundFailed,
    });
    expect(Object.keys(REFUND_WEBHOOK_EVENT_MAP).sort()).toEqual(Object.values(RazorpayRefundWebhookEvent).sort());
  });
});
