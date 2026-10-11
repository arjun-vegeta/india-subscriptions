import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ChargeStatus, ErrorCode, EventType, PaymentMethod, PaymentStatus, RefundStatus } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import { SubscriptionEventSchema, type WebhookRequest } from '../../src/schemas.js';
import { RazorpayHeader } from '../../src/providers/razorpay/constants.js';
import { razorpay } from '../../src/providers/razorpay/index.js';
import { mockFetch } from '../helpers/mock-fetch.js';
import {
  WEBHOOK_ORDER_PAID,
  WEBHOOK_PAYMENT_AUTHORIZED,
  WEBHOOK_PAYMENT_CAPTURED,
  WEBHOOK_PAYMENT_CAPTURED_CARD,
  WEBHOOK_PAYMENT_FAILED,
  WEBHOOK_PAYMENT_FAILED_UPI,
  WEBHOOK_REFUND_CREATED,
  WEBHOOK_REFUND_FAILED,
  WEBHOOK_REFUND_PROCESSED,
  WEBHOOK_REFUND_SPEED_CHANGED,
  WEBHOOK_SUBSCRIPTION_AUTHENTICATED,
  WEBHOOK_SUBSCRIPTION_CHARGED,
} from './one-time-fixtures.js';

/*
 * Webhook tests for one-time payments. Every payload is the verbatim sample of
 * the Razorpay webhook pages named in one-time-fixtures.ts; a test that needs
 * a different payload changes named fields of a sample and says so. The
 * signature is computed here with node:crypto: hex(HMAC_SHA256(secret, raw
 * body)) (webhooks/validate-test).
 */

const KEY_SECRET = 'test_key_secret_value';
const WEBHOOK_SECRET = 'test_webhook_secret_value';
const sign = (body: string, secret = WEBHOOK_SECRET) => createHmac('sha256', secret).update(body, 'utf8').digest('hex');
const iso = (unix: number) => new Date(unix * 1000).toISOString();
const json = (text: string) => JSON.parse(text) as Record<string, any>;

const provider = () => razorpay({ keyId: 'k', keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET }, { fetch: mockFetch([]).fetch });

function signed(body: string, eventId?: string): WebhookRequest {
  return {
    rawBody: body,
    headers: {
      [RazorpayHeader.Signature]: sign(body),
      ...(eventId === undefined ? {} : { [RazorpayHeader.EventId]: eventId }),
    },
  };
}

function parse(body: string, eventId?: string) {
  const events = provider().parseWebhook(signed(body, eventId));
  expect(events).toHaveLength(1);
  const [event] = events;
  expect(SubscriptionEventSchema.safeParse(event).success).toBe(true);
  return event!;
}

function thrown(run: () => unknown): SubscriptionError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SubscriptionError);
    return error as SubscriptionError;
  }
  throw new Error('expected the call to throw');
}

/** A sample with named fields of its payment entity changed. */
function withPayment(sample: string, over: Record<string, unknown>): string {
  const body = json(sample);
  Object.assign(body.payload.payment.entity, over);
  return JSON.stringify(body);
}

describe('payment.captured and order.paid: payment.succeeded', () => {
  it('maps payment.captured (Netbanking sample): the payment is identified by its order id', () => {
    const event = parse(WEBHOOK_PAYMENT_CAPTURED, 'evt_cap');
    expect(event).toMatchObject({
      id: 'evt_cap',
      provider: 'razorpay',
      type: EventType.PaymentSucceeded,
      providerEventType: 'payment.captured',
      occurredAt: iso(1567674606),
      paymentId: 'order_DESlLckIVRkHWj',
    });
    expect(event.payment).toMatchObject({
      provider: 'razorpay',
      id: 'order_DESlLckIVRkHWj',
      status: PaymentStatus.Succeeded,
      providerStatus: 'captured',
      amount: 100,
      currency: 'INR',
      refundedAmount: 0,
      paymentMethod: PaymentMethod.NetBanking,
      createdAt: iso(1567674599),
      paidAt: iso(1567674599),
    });
    expect(event.payment?.customer).toBeUndefined(); // the sample's "<email>" and "<phone>" are not valid values
    expect(event.subscription).toBeUndefined();
    expect(event.charge).toBeUndefined();
    expect(event.subscriptionId).toBeUndefined();
    expect(event.raw).toEqual(json(WEBHOOK_PAYMENT_CAPTURED));
  });

  it('maps payment.captured (Card sample)', () => {
    const event = parse(WEBHOOK_PAYMENT_CAPTURED_CARD);
    expect(event).toMatchObject({
      type: EventType.PaymentSucceeded,
      paymentId: 'order_DESoU0U4ikYA19',
      payment: { status: PaymentStatus.Succeeded, paymentMethod: PaymentMethod.Card },
    });
  });

  it('maps order.paid (it carries the order too): the amount and the notes come from the order', () => {
    const event = parse(WEBHOOK_ORDER_PAID);
    expect(event).toMatchObject({
      type: EventType.PaymentSucceeded,
      providerEventType: 'order.paid',
      paymentId: 'order_DESlLckIVRkHWj',
      occurredAt: iso(1567674606),
    });
    expect(event.payment).toMatchObject({
      id: 'order_DESlLckIVRkHWj',
      status: PaymentStatus.Succeeded,
      amount: 100,
      createdAt: iso(1567674581),
      customer: { email: 'gaurav.kumar@example.com', phone: '+919876543210' },
    });
    expect(event.payment?.metadata).toBeUndefined();
  });

  it('reads the reference back from the order of an order.paid event', () => {
    const body = json(WEBHOOK_ORDER_PAID);
    body.payload.order.entity.notes = { india_subscriptions_payment_reference: 'order-1001', plan: 'pro' };
    const event = parse(JSON.stringify(body));
    expect(event.payment).toMatchObject({ reference: 'order-1001', metadata: { plan: 'pro' } });
  });

  it('builds a stable id from the event, the payment and the timestamp when the header is missing', () => {
    expect(parse(WEBHOOK_PAYMENT_CAPTURED).id).toBe('payment.captured:pay_DESlfW9H8K9uqM:1567674606');
    expect(parse(WEBHOOK_PAYMENT_CAPTURED).id).toBe(parse(WEBHOOK_PAYMENT_CAPTURED).id);
    expect(parse(WEBHOOK_ORDER_PAID).id).toBe('order.paid:pay_DESlfW9H8K9uqM:1567674606');
  });

  it('reports a refunded payment as refunded, from the payment entity (partial refund of a captured payment)', () => {
    const event = parse(withPayment(WEBHOOK_PAYMENT_CAPTURED, { amount_refunded: 40, refund_status: 'partial' }));
    expect(event.payment).toMatchObject({ status: PaymentStatus.PartiallyRefunded, refundedAmount: 40 });
  });

  it('leaves the method unset for a method with no unified name', () => {
    expect(parse(withPayment(WEBHOOK_PAYMENT_CAPTURED, { method: 'emi' })).payment?.paymentMethod).toBeUndefined();
    expect(parse(withPayment(WEBHOOK_PAYMENT_CAPTURED, { method: 'wallet' })).payment?.paymentMethod).toBe(PaymentMethod.Wallet);
  });
});

describe('payment.failed: payment.failed', () => {
  it('maps the Netbanking sample with the failure code and reason', () => {
    const event = parse(WEBHOOK_PAYMENT_FAILED, 'evt_fail');
    expect(event).toMatchObject({
      id: 'evt_fail',
      type: EventType.PaymentFailed,
      providerEventType: 'payment.failed',
      paymentId: 'order_DEATVTRRctwEGb',
    });
    expect(event.payment).toMatchObject({
      id: 'order_DEATVTRRctwEGb',
      status: PaymentStatus.Failed,
      providerStatus: 'failed',
      amount: 50000,
      paymentMethod: PaymentMethod.NetBanking,
      failureCode: 'BAD_REQUEST_ERROR',
      failureReason: 'Payment failed',
    });
    expect(event.payment?.paidAt).toBeUndefined();
  });

  it('maps the UPI sample', () => {
    const event = parse(WEBHOOK_PAYMENT_FAILED_UPI);
    expect(event).toMatchObject({ type: EventType.PaymentFailed, payment: { status: PaymentStatus.Failed, paymentMethod: PaymentMethod.Upi } });
  });
});

describe('payment events that are not a result', () => {
  it('returns payment.authorized as unknown: an authorised payment is not captured yet', () => {
    const event = parse(WEBHOOK_PAYMENT_AUTHORIZED, 'evt_auth');
    expect(event).toMatchObject({ id: 'evt_auth', type: EventType.Unknown, providerEventType: 'payment.authorized' });
    expect(event.payment).toBeUndefined();
    expect(event.paymentId).toBeUndefined();
    expect(event.raw).toEqual(json(WEBHOOK_PAYMENT_AUTHORIZED));
  });
});

describe('refund events about a one-time payment', () => {
  it('maps refund.processed to refund.succeeded with the refund, the payment id and the payment', () => {
    const event = parse(WEBHOOK_REFUND_PROCESSED, 'evt_ref');
    expect(event).toMatchObject({
      id: 'evt_ref',
      type: EventType.RefundSucceeded,
      providerEventType: 'refund.processed',
      occurredAt: iso(1597734071),
      paymentId: 'order_FPoIeimWki9j8A',
    });
    expect(event.refund).toEqual({
      provider: 'razorpay',
      id: 'rfnd_FS8TWyPrCsa0OB',
      chargeId: 'order_FPoIeimWki9j8A',
      paymentId: 'order_FPoIeimWki9j8A',
      status: RefundStatus.Succeeded,
      providerStatus: 'processed',
      amount: 50000,
      currency: 'INR',
      createdAt: iso(1597734071),
      raw: json(WEBHOOK_REFUND_PROCESSED).payload.refund.entity,
    });
    expect(event.payment).toMatchObject({
      id: 'order_FPoIeimWki9j8A',
      status: PaymentStatus.PartiallyRefunded,
      amount: 500000,
      refundedAmount: 190000,
      paymentMethod: PaymentMethod.NetBanking,
    });
    expect(event.subscription).toBeUndefined();
  });

  it('maps refund.failed to refund.failed', () => {
    const event = parse(WEBHOOK_REFUND_FAILED);
    expect(event).toMatchObject({
      type: EventType.RefundFailed,
      providerEventType: 'refund.failed',
      paymentId: 'order_FPoIeimWki9j8A',
      refund: { status: RefundStatus.Failed, providerStatus: 'failed', paymentId: 'order_FPoIeimWki9j8A' },
    });
  });

  it('returns refund.created and refund.speed_changed as unknown', () => {
    for (const [sample, name] of [
      [WEBHOOK_REFUND_CREATED, 'refund.created'],
      [WEBHOOK_REFUND_SPEED_CHANGED, 'refund.speed_changed'],
    ] as const) {
      const event = parse(sample);
      expect(event).toMatchObject({ type: EventType.Unknown, providerEventType: name });
      expect(event.refund).toBeUndefined();
      expect(event.paymentId).toBeUndefined();
    }
  });

  it('uses the refund id in the event id when the header is missing', () => {
    expect(parse(WEBHOOK_REFUND_PROCESSED).id).toBe('refund.processed:rfnd_FS8TWyPrCsa0OB:1597734071');
  });
});

describe('subscription payloads keep their mapping', () => {
  it('maps subscription.charged as before: a subscription event with a charge and no payment', () => {
    const event = parse(WEBHOOK_SUBSCRIPTION_CHARGED);
    expect(event).toMatchObject({ type: EventType.SubscriptionCharged, providerEventType: 'subscription.charged' });
    expect(event.subscriptionId).toBeDefined();
    expect(event.charge).toMatchObject({ status: ChargeStatus.Succeeded });
    expect(event.paymentId).toBeUndefined();
    expect(event.payment).toBeUndefined();
    expect(event.refund).toBeUndefined();
  });

  it('maps subscription.authenticated as before', () => {
    const event = parse(WEBHOOK_SUBSCRIPTION_AUTHENTICATED);
    expect(event.type).toBe(EventType.SubscriptionAuthorized);
    expect(event.payment).toBeUndefined();
  });

  it('keeps payment.captured, payment.failed, order.paid and refund events of a subscription debit as unknown: the payment has an invoice', () => {
    const invoiced = { invoice_id: 'inv_DEXFWVuM6rPqlK' };
    for (const [sample, name] of [
      [WEBHOOK_PAYMENT_CAPTURED, 'payment.captured'],
      [WEBHOOK_PAYMENT_FAILED, 'payment.failed'],
      [WEBHOOK_ORDER_PAID, 'order.paid'],
      [WEBHOOK_REFUND_PROCESSED, 'refund.processed'],
      [WEBHOOK_REFUND_FAILED, 'refund.failed'],
    ] as const) {
      const body = json(sample);
      Object.assign(body.payload.payment.entity, invoiced);
      const event = parse(JSON.stringify(body));
      expect(event, name).toMatchObject({ type: EventType.Unknown, providerEventType: name });
      expect(event.payment, name).toBeUndefined();
      expect(event.refund, name).toBeUndefined();
    }
  });

  it('keeps a payment event as unknown when the payload carries a subscription, or the payment has no order', () => {
    const withSubscription = json(WEBHOOK_PAYMENT_CAPTURED);
    withSubscription.payload.subscription = json(WEBHOOK_SUBSCRIPTION_CHARGED).payload.subscription;
    expect(parse(JSON.stringify(withSubscription)).type).toBe(EventType.Unknown);
    expect(parse(withPayment(WEBHOOK_PAYMENT_CAPTURED, { order_id: null })).type).toBe(EventType.Unknown);
    const noPayment = json(WEBHOOK_REFUND_PROCESSED);
    delete noPayment.payload.payment;
    expect(parse(JSON.stringify(noPayment)).type).toBe(EventType.Unknown);
  });
});

describe('payment webhooks: signature and malformed bodies', () => {
  it('rejects a wrong or missing signature with SIGNATURE_INVALID and parses nothing', () => {
    for (const sample of [WEBHOOK_PAYMENT_CAPTURED, WEBHOOK_REFUND_PROCESSED]) {
      expect(thrown(() => provider().parseWebhook({ rawBody: sample, headers: { [RazorpayHeader.Signature]: 'deadbeef' } })).code).toBe(
        ErrorCode.SignatureInvalid,
      );
      expect(thrown(() => provider().parseWebhook({ rawBody: sample, headers: {} })).code).toBe(ErrorCode.SignatureInvalid);
    }
  });

  it('rejects a payment body changed after signing, by a single character', () => {
    const tampered = WEBHOOK_PAYMENT_CAPTURED.replace('"amount": 100', '"amount": 900');
    expect(tampered).not.toBe(WEBHOOK_PAYMENT_CAPTURED);
    const request: WebhookRequest = { rawBody: tampered, headers: { [RazorpayHeader.Signature]: sign(WEBHOOK_PAYMENT_CAPTURED) } };
    expect(thrown(() => provider().parseWebhook(request)).code).toBe(ErrorCode.SignatureInvalid);
  });

  it('rejects a signature made with the API key secret', () => {
    const request: WebhookRequest = { rawBody: WEBHOOK_PAYMENT_CAPTURED, headers: { [RazorpayHeader.Signature]: sign(WEBHOOK_PAYMENT_CAPTURED, KEY_SECRET) } };
    expect(thrown(() => provider().parseWebhook(request)).code).toBe(ErrorCode.SignatureInvalid);
  });

  it('is UNEXPECTED_RESPONSE when the payment of a one-time payment event is not valid, never a guess', () => {
    expect(thrown(() => provider().parseWebhook(signed(withPayment(WEBHOOK_PAYMENT_CAPTURED, { amount: '100' })))).code).toBe(
      ErrorCode.UnexpectedResponse,
    );
    expect(thrown(() => provider().parseWebhook(signed(withPayment(WEBHOOK_PAYMENT_CAPTURED, { amount: 10.5 })))).code).toBe(
      ErrorCode.UnexpectedResponse,
    );
    const noRefund = json(WEBHOOK_REFUND_PROCESSED);
    delete noRefund.payload.refund;
    expect(thrown(() => provider().parseWebhook(signed(JSON.stringify(noRefund)))).code).toBe(ErrorCode.UnexpectedResponse);
  });

  it('keeps a status Razorpay adds later visible and never reports it as success', () => {
    const event = parse(withPayment(WEBHOOK_PAYMENT_CAPTURED, { status: 'under_review' }));
    expect(event.type).toBe(EventType.PaymentSucceeded);
    expect(event.payment).toMatchObject({ status: PaymentStatus.Pending, providerStatus: 'under_review' });
  });
});
