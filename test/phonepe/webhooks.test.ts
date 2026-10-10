import { describe, expect, it } from 'vitest';
import { ChargeKind, ChargeStatus, Currency, ErrorCode, EventType, IntervalUnit, PaymentMethod, Provider, RefundStatus, SchedulingMode, SubscriptionStatus } from '../../src/constants.js';
import {
  WEBHOOK_CANCELLED,
  WEBHOOK_CHECKOUT_ORDER_COMPLETED_ONE_OFF,
  WEBHOOK_CHECKOUT_ORDER_COMPLETED_SC_WEBHOOK,
  WEBHOOK_CHECKOUT_ORDER_FAILED_SC_WEBHOOK,
  WEBHOOK_NOTIFICATION_COMPLETED,
  WEBHOOK_PAUSED,
  WEBHOOK_REDEMPTION_ORDER_COMPLETED,
  WEBHOOK_REDEMPTION_ORDER_FAILED,
  WEBHOOK_REDEMPTION_TRANSACTION_COMPLETED,
  WEBHOOK_REDEMPTION_TRANSACTION_FAILED,
  WEBHOOK_REFUND_COMPLETED,
  WEBHOOK_REFUND_FAILED,
  WEBHOOK_REVOKED,
  WEBHOOK_SETUP_COMPLETED_A_WEBHOOK,
  WEBHOOK_SETUP_FAILED_A_WEBHOOK,
  WEBHOOK_UNPAUSED,
  REDEMPTION_ORDER_COMPLETED_A_REDORDER,
} from './fixtures.js';
import {
  CLIENT_ID,
  CLIENT_SECRET,
  CLIENT_VERSION,
  WEBHOOK_AUTHORIZATION,
  WEBHOOK_PASSWORD,
  WEBHOOK_USERNAME,
  everythingIn,
  makeProvider,
  rejection,
  sha256Hex,
  webhookRequest,
} from './helpers.js';
import { phonepe } from '../../src/providers/phonepe/index.js';
import { Environment, HttpMethod } from '../../src/constants.js';

const { provider } = makeProvider();

/** Parses one verified webhook and returns its single event. */
async function eventOf(body: unknown) {
  const events = await provider.parseWebhook(webhookRequest(body));
  expect(events).toHaveLength(1);
  return events[0]!;
}

/**
 * A refund payload has no `paymentFlow`, so the adapter reads the original order to learn what it refunds. This parses one
 * verified refund webhook while PhonePe answers that read with `order` (an Autopay redemption order by default).
 */
async function refundEventOf(body: unknown, order: unknown = REDEMPTION_ORDER_COMPLETED_A_REDORDER) {
  const harness = makeProvider([{ method: HttpMethod.Get, url: /\/checkout\/v2\/order\/[^/]+\/status/, json: order }]);
  const events = await harness.provider.parseWebhook(webhookRequest(body));
  expect(events).toHaveLength(1);
  return events[0]!;
}

describe('webhook authentication [G-UATCHECK, SDK CommonUtils: Authorization = SHA256(username:password)]', () => {
  it('the expected value is computed independently here from node:crypto', async () => {
    expect(WEBHOOK_AUTHORIZATION).toBe(sha256Hex(`${WEBHOOK_USERNAME}:${WEBHOOK_PASSWORD}`));
    expect(WEBHOOK_AUTHORIZATION).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts the right Authorization header (any header-name case) and returns the events', async () => {
    for (const name of ['authorization', 'Authorization', 'AUTHORIZATION']) {
      const events = await provider.parseWebhook({
        rawBody: JSON.stringify(WEBHOOK_PAUSED),
        headers: { [name]: WEBHOOK_AUTHORIZATION },
      });
      expect(events[0]?.type).toBe(EventType.SubscriptionPaused);
    }
    // A header received as a list uses its first value.
    expect(
      (await provider.parseWebhook({ rawBody: JSON.stringify(WEBHOOK_PAUSED), headers: { authorization: [WEBHOOK_AUTHORIZATION, 'x'] } }))[0]?.type,
    ).toBe(EventType.SubscriptionPaused);
  });

  it.each([
    ['a missing header', null],
    ['an empty header', ''],
    ['the hash of the wrong credentials', sha256Hex(`${WEBHOOK_USERNAME}:wrong`)],
    ['the hash of username and password without the colon', sha256Hex(`${WEBHOOK_USERNAME}${WEBHOOK_PASSWORD}`)],
    ['the hash of the password alone', sha256Hex(WEBHOOK_PASSWORD)],
    ['the credentials themselves', `${WEBHOOK_USERNAME}:${WEBHOOK_PASSWORD}`],
    ['a "SHA256 " scheme prefix (not the documented form)', `SHA256 ${WEBHOOK_AUTHORIZATION}`],
    ['a truncated hash', WEBHOOK_AUTHORIZATION.slice(0, 63)],
    ['a hash with trailing text', `${WEBHOOK_AUTHORIZATION}0`],
  ])('refuses %s with SIGNATURE_INVALID and parses nothing', async (_name, authorization) => {
    const error = await rejection(async () => provider.parseWebhook(webhookRequest(WEBHOOK_PAUSED, authorization)));
    expect(error.code).toBe(ErrorCode.SignatureInvalid);
    expect(everythingIn(error)).not.toContain(WEBHOOK_PASSWORD);
    expect(everythingIn(error)).not.toContain(WEBHOOK_AUTHORIZATION);
  });

  it('checks the header BEFORE reading the body: a forged request with garbage is SIGNATURE_INVALID, not a parse error', async () => {
    const error = await rejection(async () => provider.parseWebhook(webhookRequest('this is not json', 'nope')));
    expect(error.code).toBe(ErrorCode.SignatureInvalid);
  });

  it('without webhookUsername / webhookPassword in the config it is CONFIG, whatever the header says', async () => {
    const bare = phonepe({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, clientVersion: CLIENT_VERSION, environment: Environment.Test });
    const error = await rejection(async () => bare.parseWebhook(webhookRequest(WEBHOOK_PAUSED)));
    expect(error.code).toBe(ErrorCode.Config);
    expect(error.message).toMatch(/webhookUsername/);
  });

  it('a verified body that is not JSON, or has no event, is UNEXPECTED_RESPONSE', async () => {
    expect((await rejection(async () => provider.parseWebhook(webhookRequest('<html>')))).code).toBe(ErrorCode.UnexpectedResponse);
    expect((await rejection(async () => provider.parseWebhook(webhookRequest({ payload: {} })))).code).toBe(ErrorCode.UnexpectedResponse);
    expect((await rejection(async () => provider.parseWebhook(webhookRequest({ event: 'x' })))).code).toBe(ErrorCode.UnexpectedResponse);
  });
});

describe('setup events', () => {
  it('subscription.setup.order.completed [A-WEBHOOK] is subscription.authorized for the merchantSubscriptionId', async () => {
    const event = await eventOf(WEBHOOK_SETUP_COMPLETED_A_WEBHOOK);
    expect(event).toMatchObject({
      id: 'subscription.setup.order.completed:MO1708797962855',
      provider: Provider.PhonePe,
      type: EventType.SubscriptionAuthorized,
      providerEventType: 'subscription.setup.order.completed',
      occurredAt: new Date(1708797965588).toISOString(),
      subscriptionId: 'MS1708797962855',
      subscription: {
        id: 'MS1708797962855',
        reference: 'MS1708797962855',
        scheduling: SchedulingMode.Merchant,
        // The mandate's own state is not in the event: not claimed active.
        status: SubscriptionStatus.PendingAuthorization,
        providerStatus: 'COMPLETED',
        maxAmount: 200,
        mandateEndsAt: new Date(1741345725943).toISOString(),
        paymentMethod: PaymentMethod.Upi,
      },
      charge: {
        id: 'MO1708797962855',
        reference: 'MO1708797962855',
        subscriptionId: 'MS1708797962855',
        kind: ChargeKind.Upfront,
        status: ChargeStatus.Succeeded,
        amount: 200,
        paidAt: new Date(1708797965588).toISOString(),
      },
    });
    expect(event.subscription?.interval).toBeUndefined();
  });

  it('subscription.setup.order.failed is subscription.authorization_failed with the failure kept on the charge', async () => {
    const event = await eventOf(WEBHOOK_SETUP_FAILED_A_WEBHOOK);
    expect(event).toMatchObject({
      id: 'subscription.setup.order.failed:MO1708797962855',
      type: EventType.SubscriptionAuthorizationFailed,
      subscriptionId: 'MS1708797962855',
      subscription: { status: SubscriptionStatus.Failed },
      charge: { status: ChargeStatus.Failed, failureCode: 'INVALID_MPIN', failureReason: 'INVALID_MPIN (detailed error code ZM)' },
    });
  });

  it('checkout.order.completed [SC-WEBHOOK] of a PENNY_DROP setup: authorized, an authorization charge, DAILY read back as an interval', async () => {
    const event = await eventOf(WEBHOOK_CHECKOUT_ORDER_COMPLETED_SC_WEBHOOK);
    expect(event).toMatchObject({
      id: 'checkout.order.completed:TEST_ORD76218257999841196127',
      type: EventType.SubscriptionAuthorized,
      providerEventType: 'checkout.order.completed',
      subscriptionId: 'MSUB_5580745967290798888',
      subscription: { interval: { unit: IntervalUnit.Day, count: 1 } },
      charge: { kind: ChargeKind.Authorization, status: ChargeStatus.Succeeded, amount: 200, currency: Currency.INR },
    });
  });

  it('checkout.order.failed [SC-WEBHOOK] (INTENT_EXPIRED) is authorization_failed', async () => {
    const event = await eventOf(WEBHOOK_CHECKOUT_ORDER_FAILED_SC_WEBHOOK);
    expect(event).toMatchObject({
      type: EventType.SubscriptionAuthorizationFailed,
      subscriptionId: 'MSUB_5580745967290798888',
      charge: { status: ChargeStatus.Failed, failureCode: 'OTHERS', failureReason: 'OTHERS (detailed error code INTENT_EXPIRED)' },
    });
  });

  it('an order of a flow this adapter knows nothing about is NOT a subscription event: unknown, with its name (one-time payments: see payments.test.ts)', async () => {
    const body = {
      ...WEBHOOK_CHECKOUT_ORDER_COMPLETED_ONE_OFF,
      payload: { ...WEBHOOK_CHECKOUT_ORDER_COMPLETED_ONE_OFF.payload, paymentFlow: { type: 'PAYMENT_LINK' } },
    };
    const event = await eventOf(body);
    expect(event).toMatchObject({ type: EventType.Unknown, providerEventType: 'checkout.order.completed' });
    expect(event.subscriptionId).toBeUndefined();
    expect(event.id).toBe('checkout.order.completed:ONE_OFF_ORDER_1');
  });

  it('a setup event whose payload contradicts its name (completed event, FAILED state) is unknown, never authorized', async () => {
    const body = { ...WEBHOOK_SETUP_COMPLETED_A_WEBHOOK, payload: { ...WEBHOOK_SETUP_COMPLETED_A_WEBHOOK.payload, state: 'FAILED' } };
    expect((await eventOf(body)).type).toBe(EventType.Unknown);
  });

  it('the subscription id is recovered from the derived setup order id when the payload has no paymentFlow', async () => {
    const body = {
      event: 'subscription.setup.order.completed',
      payload: { merchantOrderId: 'ST_sub_ref_1', state: 'COMPLETED', amount: 200, paymentFlow: { type: 'SUBSCRIPTION_SETUP' } },
    };
    expect(await eventOf(body)).toMatchObject({ type: EventType.SubscriptionAuthorized, subscriptionId: 'sub_ref_1' });
  });
});

describe('mandate state changes', () => {
  it('subscription.paused is subscription.paused, with the pause start as occurredAt and in the id', async () => {
    const event = await eventOf(WEBHOOK_PAUSED);
    expect(event).toMatchObject({
      id: 'subscription.paused:MS1708797962855:1708798426196:1708885799000',
      type: EventType.SubscriptionPaused,
      providerEventType: 'subscription.paused',
      occurredAt: new Date(1708798426196).toISOString(),
      subscriptionId: 'MS1708797962855',
      subscription: { id: 'MS1708797962855', reference: 'MS1708797962855', status: SubscriptionStatus.Paused, providerStatus: 'PAUSED', maxAmount: 200 },
    });
  });

  it('subscription.unpaused is subscription.resumed', async () => {
    expect(await eventOf(WEBHOOK_UNPAUSED)).toMatchObject({
      id: 'subscription.unpaused:MS1708797962855:-:-',
      type: EventType.SubscriptionResumed,
      subscriptionId: 'MS1708797962855',
      subscription: { status: SubscriptionStatus.Active, providerStatus: 'ACTIVE' },
    });
  });

  it('subscription.revoked (the customer, in their app) and subscription.cancelled are both subscription.cancelled', async () => {
    expect(await eventOf(WEBHOOK_REVOKED)).toMatchObject({
      type: EventType.SubscriptionCancelled,
      providerEventType: 'subscription.revoked',
      subscriptionId: 'MS1708797962855',
      subscription: { status: SubscriptionStatus.Cancelled, providerStatus: 'REVOKED' },
    });
    expect(await eventOf(WEBHOOK_CANCELLED)).toMatchObject({
      type: EventType.SubscriptionCancelled,
      providerEventType: 'subscription.cancelled',
      subscription: { status: SubscriptionStatus.Cancelled, providerStatus: 'CANCELLED' },
    });
  });

  it('a state change with no subscription id is unknown (it cannot be matched to anything)', async () => {
    const body = { event: 'subscription.paused', payload: { state: 'PAUSED' } };
    expect((await eventOf(body)).type).toBe(EventType.Unknown);
  });
});

describe('pre-debit notification events', () => {
  it('subscription.notification.completed [SC-WEBHOOK] is subscription.charge_scheduled, naming the debit by the notification id', async () => {
    const event = await eventOf(WEBHOOK_NOTIFICATION_COMPLETED);
    expect(event).toMatchObject({
      id: 'subscription.notification.completed:MO1708797962855',
      type: EventType.SubscriptionChargeScheduled,
      occurredAt: new Date(1622539751586).toISOString(),
      subscriptionId: 'MS121312',
      charge: {
        id: 'MO1708797962855',
        reference: 'MO1708797962855',
        subscriptionId: 'MS121312',
        kind: ChargeKind.Recurring,
        status: ChargeStatus.Scheduled,
        providerStatus: 'NOTIFIED',
        amount: 100,
      },
    });
  });

  it('subscription.notification.failed (no page shows its payload) is unknown, not a failed charge: no debit was tried', async () => {
    const body = {
      event: 'subscription.notification.failed',
      payload: { ...WEBHOOK_NOTIFICATION_COMPLETED.payload, state: 'FAILED' },
    };
    const event = await eventOf(body);
    expect(event).toMatchObject({ type: EventType.Unknown, providerEventType: 'subscription.notification.failed', subscriptionId: 'MS121312' });
    expect(event.charge).toBeUndefined();
  });
});

describe('redemption events', () => {
  it('subscription.redemption.order.completed is subscription.charged: the merchant order id on charge.id and charge.reference, the subscription id on the event', async () => {
    const event = await eventOf(WEBHOOK_REDEMPTION_ORDER_COMPLETED);
    expect(event).toMatchObject({
      id: 'subscription.redemption.order.completed:MO1708797962855',
      type: EventType.SubscriptionCharged,
      providerEventType: 'subscription.redemption.order.completed',
      occurredAt: new Date(1628300000000).toISOString(),
      subscriptionId: 'MS121312',
      charge: {
        id: 'MO1708797962855',
        reference: 'MO1708797962855',
        subscriptionId: 'MS121312',
        kind: ChargeKind.Recurring,
        status: ChargeStatus.Succeeded,
        amount: 100,
        paidAt: new Date(1628300000000).toISOString(),
      },
    });
  });

  it('subscription.redemption.transaction.completed (one attempt; the order is still PENDING) is also subscription.charged, with the SAME id so a consumer sees one charge', async () => {
    const order = await eventOf(WEBHOOK_REDEMPTION_ORDER_COMPLETED);
    const attempt = await eventOf(WEBHOOK_REDEMPTION_TRANSACTION_COMPLETED);
    expect(attempt).toMatchObject({
      type: EventType.SubscriptionCharged,
      providerEventType: 'subscription.redemption.transaction.completed',
      subscriptionId: 'MS121312',
      charge: { id: 'MO1708797962855', status: ChargeStatus.Succeeded },
    });
    expect(attempt.id).toBe(order.id);
  });

  it('subscription.redemption.order.failed is subscription.charge_failed with the failure kept', async () => {
    const event = await eventOf(WEBHOOK_REDEMPTION_ORDER_FAILED);
    expect(event).toMatchObject({
      id: 'subscription.redemption.order.failed:MO1708797962855',
      type: EventType.SubscriptionChargeFailed,
      subscriptionId: 'MS121312',
      charge: {
        id: 'MO1708797962855',
        reference: 'MO1708797962855',
        status: ChargeStatus.Failed,
        failureCode: 'INSUFFICIENT_BALANCE',
        failureReason: 'INSUFFICIENT_BALANCE (detailed error code Z9)',
      },
    });
  });

  it('subscription.redemption.transaction.failed is ONE attempt (PhonePe retries inside its window): unknown, never a failed charge', async () => {
    const event = await eventOf(WEBHOOK_REDEMPTION_TRANSACTION_FAILED);
    expect(event).toMatchObject({ type: EventType.Unknown, providerEventType: 'subscription.redemption.transaction.failed', subscriptionId: 'MS121312' });
    expect(event.charge).toBeUndefined();
    expect(event.id).toBe('subscription.redemption.transaction.failed:MO1708797962855:OM124');
  });

  it('events whose payload contradicts their name are unknown: money events are never guessed', async () => {
    const completedButPending = { ...WEBHOOK_REDEMPTION_ORDER_COMPLETED, payload: { ...WEBHOOK_REDEMPTION_ORDER_COMPLETED.payload, state: 'PENDING' } };
    expect((await eventOf(completedButPending)).type).toBe(EventType.Unknown);
    const failedButCompleted = { ...WEBHOOK_REDEMPTION_ORDER_FAILED, payload: { ...WEBHOOK_REDEMPTION_ORDER_FAILED.payload, state: 'COMPLETED' } };
    expect((await eventOf(failedButCompleted)).type).toBe(EventType.Unknown);
    const attemptCompletedWithoutAttempt = {
      ...WEBHOOK_REDEMPTION_TRANSACTION_COMPLETED,
      payload: { ...WEBHOOK_REDEMPTION_TRANSACTION_COMPLETED.payload, paymentDetails: [] },
    };
    expect((await eventOf(attemptCompletedWithoutAttempt)).type).toBe(EventType.Unknown);
  });

  it('a debit event without an amount cannot be a charge: unknown (the webhook is still acknowledged), never an error PhonePe would redeliver forever', async () => {
    const body = { ...WEBHOOK_REDEMPTION_ORDER_COMPLETED, payload: { ...WEBHOOK_REDEMPTION_ORDER_COMPLETED.payload, amount: undefined, paymentDetails: [] } };
    expect(await eventOf(body)).toMatchObject({ type: EventType.Unknown, providerEventType: 'subscription.redemption.order.completed' });
  });
});

describe('refund events', () => {
  it('pg.refund.completed [A-WEBHOOK] is refund.succeeded', async () => {
    expect(await refundEventOf(WEBHOOK_REFUND_COMPLETED)).toMatchObject({
      id: 'pg.refund.completed:Refund-id-1231003121201223',
      type: EventType.RefundSucceeded,
      providerEventType: 'pg.refund.completed',
      occurredAt: new Date(1779269301012).toISOString(),
      refund: {
        provider: Provider.PhonePe,
        id: 'OMR2605201458210091350254V',
        reference: 'Refund-id-1231003121201223',
        chargeId: 'TX1103221212123',
        status: RefundStatus.Succeeded,
        providerStatus: 'COMPLETED',
        amount: 100,
        currency: Currency.INR,
      },
    });
  });

  it('pg.refund.failed is refund.failed', async () => {
    expect(await refundEventOf(WEBHOOK_REFUND_FAILED)).toMatchObject({
      type: EventType.RefundFailed,
      refund: { status: RefundStatus.Failed, chargeId: 'TX1103221212123', amount: 100 },
    });
  });

  it('a refund of a setup order carries the subscription id derived from the order id', async () => {
    const body = { ...WEBHOOK_REFUND_COMPLETED, payload: { ...WEBHOOK_REFUND_COMPLETED.payload, originalMerchantOrderId: 'ST_sub_ref_1' } };
    expect(await eventOf(body)).toMatchObject({ subscriptionId: 'sub_ref_1', refund: { subscriptionId: 'sub_ref_1' } });
  });

  it('pg.refund.accepted (a legacy event) is unknown', async () => {
    const body = { type: 'PG_REFUND_ACCEPTED', event: 'pg.refund.accepted', payload: { ...WEBHOOK_REFUND_COMPLETED.payload, state: 'ACCEPTED' } };
    expect(await eventOf(body)).toMatchObject({ type: EventType.Unknown, providerEventType: 'pg.refund.accepted' });
  });
});

describe('unknown events and event ids', () => {
  it('an event this library does not normalise is a verified `unknown` with its name and payload', async () => {
    const body = { event: 'checkout.transaction.attempt.failed', payload: { merchantOrderId: 'ORD_1', state: 'FAILED' } };
    const event = await eventOf(body);
    expect(event).toMatchObject({ type: EventType.Unknown, providerEventType: 'checkout.transaction.attempt.failed', id: 'checkout.transaction.attempt.failed:ORD_1' });
    expect(event.raw).toMatchObject({ event: 'checkout.transaction.attempt.failed' });
  });

  it('an event with nothing to identify it gets an id from a hash of the body: stable across redeliveries', async () => {
    const body = { event: 'something.new', payload: { x: 1 } };
    const first = await eventOf(body);
    const second = await eventOf(body);
    expect(first.id).toBe(second.id);
    expect(first.id).toBe(`something.new:${sha256Hex(JSON.stringify(body))}`);
    expect((await eventOf({ event: 'something.new', payload: { x: 2 } })).id).not.toBe(first.id);
  });

  it('the same webhook delivered twice has the same id; the paused events of two different pauses do not', async () => {
    expect((await eventOf(WEBHOOK_PAUSED)).id).toBe((await eventOf(WEBHOOK_PAUSED)).id);
    const later = { ...WEBHOOK_PAUSED, payload: { ...WEBHOOK_PAUSED.payload, pauseStartDate: 1709999999999, pauseEndDate: 1710999999999 } };
    expect((await eventOf(later)).id).not.toBe((await eventOf(WEBHOOK_PAUSED)).id);
  });

  it('a `type` field is ignored: PhonePe deprecates it, the event name decides', async () => {
    const body = { ...WEBHOOK_REFUND_COMPLETED, type: 'SOMETHING_ELSE' };
    expect((await refundEventOf(body)).type).toBe(EventType.RefundSucceeded);
  });

  it('reads the exact raw body, whitespace and all', async () => {
    const rawBody = `\n  ${JSON.stringify(WEBHOOK_PAUSED, null, 4)}\n`;
    expect((await provider.parseWebhook({ rawBody, headers: { authorization: WEBHOOK_AUTHORIZATION } }))[0]?.type).toBe(EventType.SubscriptionPaused);
  });
});
