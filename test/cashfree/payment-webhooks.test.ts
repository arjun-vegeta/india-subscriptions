import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Environment, ErrorCode, EventType, PaymentMethod, PaymentStatus, Provider, RefundStatus } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import { CashfreeProvider } from '../../src/providers/cashfree/index.js';
import type { SubscriptionEvent } from '../../src/schemas.js';
import {
  AUTO_REFUND_2023,
  PAYMENT_CHARGES_2026,
  PAYMENT_FAILED_2026,
  PAYMENT_SUCCESS_2025,
  PAYMENT_SUCCESS_2026,
  PAYMENT_USER_DROPPED_2026,
  REFUND_STATUS_2023,
  REFUND_STATUS_2025,
  SUBSCRIPTION_PAYMENT_SUCCESS_2026,
  SUBSCRIPTION_REFUND_STATUS_2025,
} from './payment-fixtures.js';

const CLIENT_SECRET = 'test_client_secret_ZZ9_do_not_leak';
const WEBHOOK_SECRET = 'whsec_do_not_leak_987';
/** 2026-11-17 10:30 IST. */
const NOW = new Date('2026-11-17T05:00:00.000Z');
/** The documentation gives the header's value as epoch milliseconds (for example `1785401067911`). */
const TIMESTAMP = '1785401067911';

function provider(webhookSecret?: string): CashfreeProvider {
  return new CashfreeProvider(
    { clientId: 'id', clientSecret: CLIENT_SECRET, environment: Environment.Test, ...(webhookSecret ? { webhookSecret } : {}) },
    { now: () => NOW },
  );
}

/** Independent of the library: base64(HMAC-SHA256(secret, timestamp + rawBody)) (webhooks/signature-verification). */
function sign(rawBody: string, secret = CLIENT_SECRET, timestamp = TIMESTAMP): string {
  return createHmac('sha256', secret).update(timestamp + rawBody).digest('base64');
}

function signedHeaders(rawBody: string, secret = CLIENT_SECRET): Record<string, string> {
  return { 'x-webhook-signature': sign(rawBody, secret), 'x-webhook-timestamp': TIMESTAMP, 'x-webhook-version': '2026-01-01' };
}

function parse(rawBody: string): SubscriptionEvent {
  const events = provider().parseWebhook({ rawBody, headers: signedHeaders(rawBody) });
  expect(events).toHaveLength(1);
  return events[0] as SubscriptionEvent;
}

function thrown(fn: () => unknown): SubscriptionError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SubscriptionError);
    return error as SubscriptionError;
  }
  throw new Error('expected a throw');
}

/** Re-serialises a documented sample with a change; the signature is computed over the new bytes. */
function edit(rawBody: string, change: (body: any) => void): string {
  const parsed = JSON.parse(rawBody);
  change(parsed);
  return JSON.stringify(parsed);
}

describe('payment-gateway webhooks: signature', () => {
  it('verifies the same signature scheme as subscription webhooks, over the raw bytes', () => {
    expect(parse(PAYMENT_SUCCESS_2026).type).toBe(EventType.PaymentSucceeded);
  });

  it('accepts a signature made with webhookSecret when one is configured, and only then', () => {
    const headers = signedHeaders(PAYMENT_SUCCESS_2026, WEBHOOK_SECRET);
    expect(provider(WEBHOOK_SECRET).parseWebhook({ rawBody: PAYMENT_SUCCESS_2026, headers })).toHaveLength(1);
    expect(thrown(() => provider().parseWebhook({ rawBody: PAYMENT_SUCCESS_2026, headers })).code).toBe(ErrorCode.SignatureInvalid);
  });

  it('rejects a body changed by one byte, a wrong signature, a missing signature and a missing timestamp', () => {
    const headers = signedHeaders(PAYMENT_SUCCESS_2026);
    const tampered = PAYMENT_SUCCESS_2026.replace('"order_amount": 1', '"order_amount": 9');
    expect(tampered).not.toBe(PAYMENT_SUCCESS_2026);
    expect(thrown(() => provider().parseWebhook({ rawBody: tampered, headers })).code).toBe(ErrorCode.SignatureInvalid);
    expect(
      thrown(() => provider().parseWebhook({ rawBody: PAYMENT_SUCCESS_2026, headers: { ...headers, 'x-webhook-signature': 'AAAA' } })).code,
    ).toBe(ErrorCode.SignatureInvalid);
    expect(
      thrown(() => provider().parseWebhook({ rawBody: PAYMENT_SUCCESS_2026, headers: { 'x-webhook-timestamp': TIMESTAMP } })).code,
    ).toBe(ErrorCode.SignatureInvalid);
    expect(
      thrown(() => provider().parseWebhook({ rawBody: PAYMENT_SUCCESS_2026, headers: { 'x-webhook-signature': headers['x-webhook-signature'] as string } })).code,
    ).toBe(ErrorCode.SignatureInvalid);
  });

  it('is case-insensitive about header names', () => {
    const headers = { 'X-Webhook-Signature': sign(PAYMENT_SUCCESS_2026), 'X-Webhook-Timestamp': TIMESTAMP };
    expect(provider().parseWebhook({ rawBody: PAYMENT_SUCCESS_2026, headers })).toHaveLength(1);
  });

  it('parses nothing from a signed body that is not JSON (the 2025-01-01 refund sample has an unquoted key)', () => {
    // refunds/webhooks, Version 2025-01-01, as printed: `terminalDetails:{` is not valid JSON.
    const error = thrown(() => provider().parseWebhook({ rawBody: REFUND_STATUS_2025, headers: signedHeaders(REFUND_STATUS_2025) }));
    expect(error.code).toBe(ErrorCode.UnexpectedResponse);
  });
});

describe('PAYMENT_SUCCESS_WEBHOOK', () => {
  it('is payment.succeeded, with the order id as the payment id (2026-01-01 sample)', () => {
    const event = parse(PAYMENT_SUCCESS_2026);
    expect(event).toEqual({
      id: 'PAYMENT_SUCCESS_WEBHOOK:1453995084705707520:SUCCESS:2026-09-17T11:47:29+05:30',
      provider: Provider.Cashfree,
      type: EventType.PaymentSucceeded,
      providerEventType: 'PAYMENT_SUCCESS_WEBHOOK',
      occurredAt: '2026-09-17T06:17:29.000Z',
      paymentId: 'order_1112353JRZPMsx42lOnAuXiz0vddwovDk',
      payment: {
        provider: Provider.Cashfree,
        id: 'order_1112353JRZPMsx42lOnAuXiz0vddwovDk',
        reference: 'order_1112353JRZPMsx42lOnAuXiz0vddwovDk',
        status: PaymentStatus.Succeeded,
        providerStatus: 'SUCCESS',
        amount: 100,
        currency: 'INR',
        paymentMethod: PaymentMethod.NetBanking,
        customer: { id: 'Customer_123', name: 'ABC co', phone: '8971520300' },
        paidAt: '2026-09-17T06:17:29.000Z',
        metadata: {
          GST: '364JPAYTM0312',
          Merchant_ID: '123456',
          Merchant_Note: '99month Incl GST for 12 MonthsJPAYTMTJMMO_0003',
        },
        raw: expect.objectContaining({ order: expect.objectContaining({ order_id: 'order_1112353JRZPMsx42lOnAuXiz0vddwovDk' }) }),
      },
      raw: JSON.parse(PAYMENT_SUCCESS_2026),
    });
  });

  it('reads a UPI payment and its customer (2025-01-01 sample)', () => {
    const event = parse(PAYMENT_SUCCESS_2025);
    expect(event.type).toBe(EventType.PaymentSucceeded);
    expect(event.paymentId).toBe('order_OFR_2');
    expect(event.payment).toMatchObject({
      status: PaymentStatus.Succeeded,
      paymentMethod: PaymentMethod.Upi,
      amount: 200,
      customer: { id: '7112AAA812234', email: 'test@gmail.com', phone: '9908734801' },
      paidAt: '2025-01-15T05:46:10.000Z',
    });
  });

  it('prefers the attempt completion time over the event time when the payload has one', () => {
    const body = edit(PAYMENT_SUCCESS_2026, (data) => {
      data.data.payment.payment_completion_time = '2026-09-17T11:47:25+05:30';
    });
    expect(parse(body).payment?.paidAt).toBe('2026-09-17T06:17:25.000Z');
  });

  it('gives a redelivery the same id, and another attempt or status another', () => {
    const first = parse(PAYMENT_SUCCESS_2026);
    expect(parse(PAYMENT_SUCCESS_2026).id).toBe(first.id);
    const otherAttempt = edit(PAYMENT_SUCCESS_2026, (data) => {
      data.data.payment.cf_payment_id = '1453995084705707521';
    });
    expect(parse(otherAttempt).id).not.toBe(first.id);
  });

  it('accepts a numeric cf_payment_id, as the charges sample sends one', () => {
    const body = edit(PAYMENT_SUCCESS_2026, (data) => {
      data.data.payment.cf_payment_id = 1453995084705707;
    });
    expect(parse(body).id).toContain(':1453995084705707:');
  });

  it('keeps an unknown payment status visible and in flight', () => {
    const body = edit(PAYMENT_SUCCESS_2026, (data) => {
      data.data.payment.payment_status = 'SOMETHING_NEW';
    });
    const event = parse(body);
    expect(event.payment).toMatchObject({ status: PaymentStatus.Pending, providerStatus: 'SOMETHING_NEW' });
  });
});

describe('PAYMENT_FAILED_WEBHOOK and PAYMENT_USER_DROPPED_WEBHOOK', () => {
  it('a failed attempt is payment.failed, with Cashfree`s error details (2026-01-01 sample)', () => {
    const event = parse(PAYMENT_FAILED_2026);
    expect(event).toMatchObject({
      id: 'PAYMENT_FAILED_WEBHOOK:1504280029:FAILED:2023-08-01T20:00:12+05:30',
      type: EventType.PaymentFailed,
      providerEventType: 'PAYMENT_FAILED_WEBHOOK',
      paymentId: 'CFPay_g47u3888d0k0_tblfm766qc',
      payment: {
        id: 'CFPay_g47u3888d0k0_tblfm766qc',
        status: PaymentStatus.Failed,
        providerStatus: 'FAILED',
        amount: 180,
        paymentMethod: PaymentMethod.NetBanking,
        failureCode: 'GATEWAY_ERROR',
        failureReason: 'AMOUNT SHOULD BE WITHIN RANGE BETWEEN 20.00 TO 500000.00. for this bank',
        customer: { email: 'test@gmail.com', phone: '9611199227' },
        metadata: { cf_link_id: '13746255', link_id: '7f0efd36-23f3-4213-95dc-3c32ba1a27e2' },
      },
    });
    expect(event.payment?.paidAt).toBeUndefined();
  });

  it('an abandoned attempt is payment.failed with a cancelled payment status (2026-01-01 sample)', () => {
    const event = parse(PAYMENT_USER_DROPPED_2026);
    expect(event).toMatchObject({
      type: EventType.PaymentFailed,
      providerEventType: 'PAYMENT_USER_DROPPED_WEBHOOK',
      paymentId: 'order_02',
      payment: {
        status: PaymentStatus.Cancelled,
        providerStatus: 'USER_DROPPED',
        amount: 200,
        failureReason: 'User dropped and did not complete the two factor authentication',
      },
    });
  });

  it('maps every attempt status a webhook can carry', () => {
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
    for (const [attemptStatus, status] of Object.entries(expected)) {
      const body = edit(PAYMENT_FAILED_2026, (data) => {
        data.data.payment.payment_status = attemptStatus;
      });
      expect(parse(body).payment?.status, attemptStatus).toBe(status);
    }
  });
});

describe('PAYMENT_CHARGES_WEBHOOK', () => {
  it('reports fees only: unknown event type, still about the order (2026-01-01 sample)', () => {
    const event = parse(PAYMENT_CHARGES_2026);
    expect(event).toMatchObject({
      type: EventType.Unknown,
      providerEventType: 'PAYMENT_CHARGES_WEBHOOK',
      paymentId: '14508_73_1783668483731',
      payment: { amount: 600, status: PaymentStatus.Succeeded },
    });
    expect(event.payment?.paymentMethod).toBeUndefined();
  });
});

describe('REFUND_STATUS_WEBHOOK', () => {
  it('is refund.succeeded with the order id as paymentId and chargeId (2023-08-01 sample)', () => {
    const event = parse(REFUND_STATUS_2023);
    expect(event).toEqual({
      id: 'REFUND_STATUS_WEBHOOK:11325632:SUCCESS:2022-02-28T13:04:28+05:30',
      provider: Provider.Cashfree,
      type: EventType.RefundSucceeded,
      providerEventType: 'REFUND_STATUS_WEBHOOK',
      occurredAt: '2022-02-28T07:34:28.000Z',
      paymentId: 'sampleorder0413',
      refund: {
        provider: Provider.Cashfree,
        id: 'refund_sampleorder0413',
        reference: 'refund_sampleorder0413',
        chargeId: 'sampleorder0413',
        paymentId: 'sampleorder0413',
        status: RefundStatus.Succeeded,
        providerStatus: 'SUCCESS',
        amount: 200,
        currency: 'INR',
        createdAt: '2022-02-28T07:24:25.000Z',
        raw: expect.objectContaining({ cf_refund_id: 11325632 }),
      },
      raw: JSON.parse(REFUND_STATUS_2023),
    });
  });

  it('maps each refund status to an event', () => {
    const expected: Record<string, [EventType, RefundStatus]> = {
      SUCCESS: [EventType.RefundSucceeded, RefundStatus.Succeeded],
      CANCELLED: [EventType.RefundFailed, RefundStatus.Failed],
      REJECTED: [EventType.RefundFailed, RefundStatus.Failed],
      PENDING: [EventType.Unknown, RefundStatus.Pending],
      PENDING_APPROVAL: [EventType.Unknown, RefundStatus.Pending],
      ONHOLD: [EventType.Unknown, RefundStatus.Pending],
      SOMETHING_NEW: [EventType.Unknown, RefundStatus.Pending],
    };
    for (const [refundStatus, [type, status]] of Object.entries(expected)) {
      const body = edit(REFUND_STATUS_2023, (data) => {
        data.data.refund.refund_status = refundStatus;
      });
      const event = parse(body);
      expect(event.type, refundStatus).toBe(type);
      expect(event.refund?.status, refundStatus).toBe(status);
      expect(event.refund?.providerStatus).toBe(refundStatus);
      expect(event.paymentId).toBe('sampleorder0413');
    }
  });

  it('gives a repeat the same id and a later status another', () => {
    const cancelled = edit(REFUND_STATUS_2023, (data) => {
      data.data.refund.refund_status = 'CANCELLED';
    });
    expect(parse(REFUND_STATUS_2023).id).toBe(parse(REFUND_STATUS_2023).id);
    expect(parse(cancelled).id).not.toBe(parse(REFUND_STATUS_2023).id);
  });

  it('does not turn an auto refund into a refund of the order`s own payment', () => {
    // refunds/webhooks, AUTO_REFUND_STATUS_WEBHOOK: it refunds an extra payment ("Multiple payments were performed against same order").
    const event = parse(AUTO_REFUND_2023);
    expect(event.type).toBe(EventType.Unknown);
    expect(event.providerEventType).toBe('AUTO_REFUND_STATUS_WEBHOOK');
    expect(event.paymentId).toBeUndefined();
    expect(event.refund).toBeUndefined();
    expect(event.payment).toBeUndefined();
  });
});

describe('payment-gateway and subscription webhooks are told apart by type', () => {
  it('leaves a subscription payment webhook a subscription event with no payment fields (2026-01-01 sample)', () => {
    const event = parse(SUBSCRIPTION_PAYMENT_SUCCESS_2026);
    expect(event.type).toBe(EventType.SubscriptionCharged);
    expect(event.providerEventType).toBe('SUBSCRIPTION_PAYMENT_SUCCESS');
    expect(event.subscriptionId).toBe('moznV33AssPd6vXsSm2');
    expect(event.charge).toBeDefined();
    expect(event.paymentId).toBeUndefined();
    expect(event.payment).toBeUndefined();
  });

  it('leaves a subscription refund webhook a refund of a charge, not of a one-time payment (2025-01-01 sample)', () => {
    const event = parse(SUBSCRIPTION_REFUND_STATUS_2025);
    expect(event.type).toBe(EventType.RefundSucceeded);
    expect(event.providerEventType).toBe('SUBSCRIPTION_REFUND_STATUS');
    expect(event.refund?.chargeId).toBe('yCzJxeT2aXDqI');
    expect(event.refund?.paymentId).toBeUndefined();
    expect(event.paymentId).toBeUndefined();
  });

  it('refuses a payment-gateway type whose data is not an order payment', () => {
    const body = edit(PAYMENT_SUCCESS_2026, (data) => {
      delete data.data.order;
    });
    expect(thrown(() => provider().parseWebhook({ rawBody: body, headers: signedHeaders(body) })).code).toBe(ErrorCode.UnexpectedResponse);
  });

  it('refuses a refund webhook without an order id', () => {
    const body = edit(REFUND_STATUS_2023, (data) => {
      delete data.data.refund.order_id;
    });
    expect(thrown(() => provider().parseWebhook({ rawBody: body, headers: signedHeaders(body) })).code).toBe(ErrorCode.UnexpectedResponse);
  });

  it('keeps an unknown type of either family as an unknown event with its type visible', () => {
    for (const type of ['PAYMENT_SOMETHING_NEW', 'SUBSCRIPTION_SOMETHING_NEW']) {
      const body = edit(PAYMENT_SUCCESS_2026, (data) => {
        data.type = type;
      });
      const event = parse(body);
      expect(event.type).toBe(EventType.Unknown);
      expect(event.providerEventType).toBe(type);
      expect(event.paymentId).toBeUndefined();
    }
  });
});
