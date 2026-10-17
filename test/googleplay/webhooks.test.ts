import { describe, expect, it } from 'vitest';
import { ErrorCode, EventType, HttpMethod } from '../../src/constants.js';
import { SubscriptionEventSchema } from '../../src/schemas.js';
import {
  ORDER_PROCESSED,
  PRODUCT_PURCHASED,
  PUSH_MINIMUM,
  RTDN_ONE_TIME,
  RTDN_PENDING_REFUND,
  RTDN_SUBSCRIPTION,
  RTDN_TEST,
  RTDN_VOIDED,
  SUBSCRIPTION_INR,
  withState,
} from './fixtures.js';
import { P, authenticatedConfig, makeProvider, pushBody, pushRequest, route } from './helpers.js';

const BASE = 'https://androidpublisher.googleapis.com/androidpublisher/v3';
const open = { config: { acceptUnauthenticatedWebhooks: true, packageName: 'com.some.thing' } };

const sub = (type: number, token = 'PURCHASE_TOKEN') => ({
  ...RTDN_SUBSCRIPTION,
  subscriptionNotification: { version: '1.0', notificationType: type, purchaseToken: token },
});
const subscriptionRoute = (json: unknown, token = 'PURCHASE_TOKEN', status = 200) =>
  route(HttpMethod.Get, `/applications/com.some.thing/purchases/subscriptionsv2/tokens/${token}`, { json: json as Record<string, unknown>, status });
const FUTURE = '2026-12-22T06:00:00Z';
const PAST = '2026-11-01T06:00:00Z';
const withExpiry = (state: string, expiryTime: string, extra: Record<string, unknown> = {}) =>
  withState({ ...SUBSCRIPTION_INR, lineItems: [{ ...SUBSCRIPTION_INR.lineItems[0], expiryTime }] }, state, extra);

describe('the Pub/Sub push envelope [https://cloud.google.com/pubsub/docs/push, rtdn-reference "Encoding"]', () => {
  it('uses the Pub/Sub message id as the stable event id, and the notification time as occurredAt', async () => {
    const t = makeProvider([subscriptionRoute(withExpiry('SUBSCRIPTION_STATE_ACTIVE', FUTURE))], open);
    const [event] = await t.provider.parseWebhook(pushRequest(RTDN_SUBSCRIPTION, { token: null, messageId: '136969346945' }));
    expect(event).toMatchObject({
      id: '136969346945',
      provider: 'google_play',
      type: EventType.SubscriptionActivated,
      providerEventType: 'SUBSCRIPTION_PURCHASED',
      subscriptionId: 'PURCHASE_TOKEN',
      occurredAt: '2017-08-21T21:06:06.168Z',
    });
    expect(SubscriptionEventSchema.parse(event)).toBeTruthy();
    expect(event?.raw).toMatchObject({ messageId: '136969346945', notification: { packageName: 'com.some.thing' } });
  });

  it('reads message_id when messageId is absent', async () => {
    const t = makeProvider([], open);
    const body = JSON.stringify({ message: { data: Buffer.from(JSON.stringify(RTDN_TEST)).toString('base64'), message_id: '2070443601311540' } });
    const [event] = await t.provider.parseWebhook({ rawBody: body, headers: {} });
    expect(event?.id).toBe('2070443601311540');
  });

  it.each([
    ['a body that is not JSON', 'not json'],
    ['a body without a message', JSON.stringify({ subscription: 's' })],
    ['a message without an id', JSON.stringify({ message: { data: Buffer.from('{}').toString('base64') } })],
    ['data that is not JSON', JSON.stringify({ message: { data: Buffer.from('hello').toString('base64'), messageId: '1' } })],
    ['the documentation\'s example data ("Hello Cloud Pub/Sub!")', JSON.stringify(PUSH_MINIMUM)],
    ['a notification without a package name', JSON.stringify({ message: { data: Buffer.from('{"version":"1.0"}').toString('base64'), messageId: '1' } })],
  ])('%s is VALIDATION, never an event', async (_what, rawBody) => {
    const t = makeProvider([], open);
    await expect(t.provider.parseWebhook({ rawBody, headers: {} })).rejects.toMatchObject({ code: ErrorCode.Validation });
  });
});

describe('subscription notifications -> events [rtdn-reference, SubscriptionNotification]', () => {
  const state = (name: string, expiry = FUTURE, extra: Record<string, unknown> = {}) => withExpiry(`SUBSCRIPTION_STATE_${name}`, expiry, extra);
  const table: Array<[number, string, EventType, Record<string, unknown>]> = [
    [1, 'SUBSCRIPTION_RECOVERED', EventType.SubscriptionResumed, state('ACTIVE')],
    [2, 'SUBSCRIPTION_RENEWED', EventType.SubscriptionCharged, state('ACTIVE')],
    [3, 'SUBSCRIPTION_CANCELED', EventType.SubscriptionUpdated, state('CANCELED', FUTURE, { canceledStateContext: { userInitiatedCancellation: {} } })],
    [4, 'SUBSCRIPTION_PURCHASED', EventType.SubscriptionActivated, state('ACTIVE')],
    [5, 'SUBSCRIPTION_ON_HOLD', EventType.SubscriptionHalted, state('ON_HOLD', PAST)],
    [6, 'SUBSCRIPTION_IN_GRACE_PERIOD', EventType.SubscriptionPastDue, state('IN_GRACE_PERIOD')],
    [7, 'SUBSCRIPTION_RESTARTED', EventType.SubscriptionUpdated, state('ACTIVE')],
    [8, 'SUBSCRIPTION_PRICE_CHANGE_CONFIRMED', EventType.SubscriptionUpdated, state('ACTIVE')],
    [9, 'SUBSCRIPTION_DEFERRED', EventType.SubscriptionUpdated, state('ACTIVE')],
    [10, 'SUBSCRIPTION_PAUSED', EventType.SubscriptionPaused, state('PAUSED')],
    [11, 'SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED', EventType.SubscriptionUpdated, state('ACTIVE')],
    [12, 'SUBSCRIPTION_REVOKED', EventType.SubscriptionCancelled, state('EXPIRED', PAST)],
    [13, 'SUBSCRIPTION_EXPIRED', EventType.SubscriptionExpired, state('EXPIRED', PAST)],
    [17, 'SUBSCRIPTION_ITEMS_CHANGED', EventType.SubscriptionUpdated, state('ACTIVE')],
    [18, 'SUBSCRIPTION_CANCELLATION_SCHEDULED', EventType.SubscriptionUpdated, state('ACTIVE')],
    [19, 'SUBSCRIPTION_PRICE_CHANGE_UPDATED', EventType.SubscriptionUpdated, state('ACTIVE')],
    [20, 'SUBSCRIPTION_PENDING_PURCHASE_CANCELED', EventType.SubscriptionAuthorizationFailed, state('PENDING_PURCHASE_CANCELED')],
    [21, 'SUBSCRIPTION_PLAN_TRANSITION_UPDATED', EventType.SubscriptionUpdated, state('ACTIVE')],
    [22, 'SUBSCRIPTION_PRICE_STEP_UP_CONSENT_UPDATED', EventType.SubscriptionUpdated, state('ACTIVE')],
  ];

  it.each(table)('type %i %s -> %s, with the current subscription read from Google', async (type, name, eventType, purchase) => {
    const t = makeProvider([subscriptionRoute(purchase)], open);
    const [event, ...more] = await t.provider.parseWebhook(pushRequest(sub(type), { token: null }));
    expect(more).toHaveLength(0);
    expect(event).toMatchObject({ type: eventType, providerEventType: name, subscriptionId: 'PURCHASE_TOKEN' });
    expect(event?.subscription).toMatchObject({ id: 'PURCHASE_TOKEN' });
    expect(t.apiCalls()).toHaveLength(1);
    expect(t.apiCalls()[0]?.url).toBe(`${BASE}/applications/com.some.thing/purchases/subscriptionsv2/tokens/PURCHASE_TOKEN`);
  });

  it('covers every notification type the documentation lists', () => {
    expect(table.map(([type]) => type)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 17, 18, 19, 20, 21, 22]);
  });

  it('a cancellation that has taken effect (expiry passed) is subscription.cancelled', async () => {
    const t = makeProvider([subscriptionRoute(state('CANCELED', PAST, { canceledStateContext: { systemInitiatedCancellation: {} } }))], open);
    const [event] = await t.provider.parseWebhook(pushRequest(sub(3), { token: null }));
    expect(event).toMatchObject({ type: EventType.SubscriptionCancelled, subscription: { status: 'cancelled' } });
  });

  it('a notification type this library does not know is an unknown event and makes no call', async () => {
    const t = makeProvider([], open);
    const [event] = await t.provider.parseWebhook(pushRequest(sub(99), { token: null }));
    expect(event).toMatchObject({ type: EventType.Unknown, providerEventType: 'SUBSCRIPTION_NOTIFICATION_99', subscriptionId: 'PURCHASE_TOKEN' });
    expect(t.calls).toHaveLength(0);
  });

  it('a purchase that replaces another also ends the old token\'s subscription [lifecycle: linkedPurchaseToken]', async () => {
    const t = makeProvider([subscriptionRoute(state('ACTIVE', FUTURE, { linkedPurchaseToken: 'OLD_TOKEN' }))], open);
    const events = await t.provider.parseWebhook(pushRequest(sub(4), { token: null, messageId: '777' }));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ id: '777', type: EventType.SubscriptionActivated, subscriptionId: 'PURCHASE_TOKEN' });
    expect(events[1]).toMatchObject({ id: '777:replaced', type: EventType.SubscriptionCancelled, providerEventType: 'LINKED_PURCHASE_REPLACED', subscriptionId: 'OLD_TOKEN' });
    expect(events[1]?.subscription).toBeUndefined();
    expect(new Set(events.map((event) => event.id)).size).toBe(2);
  });

  it('a purchase Google no longer holds (410) still yields the event, without a subscription', async () => {
    const t = makeProvider([subscriptionRoute({ error: { code: 410, message: 'gone', errors: [{ reason: 'subscriptionNoLongerAvailable' }] } }, 'PURCHASE_TOKEN', 410)], open);
    const [event] = await t.provider.parseWebhook(pushRequest(sub(13), { token: null }));
    expect(event).toMatchObject({ type: EventType.SubscriptionExpired, subscriptionId: 'PURCHASE_TOKEN' });
    expect(event?.subscription).toBeUndefined();
  });

  it('any other failure to read the purchase fails the webhook, so Pub/Sub delivers it again', async () => {
    const t = makeProvider([subscriptionRoute({ error: { message: 'down' } }, 'PURCHASE_TOKEN', 503)], open);
    await expect(t.provider.parseWebhook(pushRequest(sub(2), { token: null }))).rejects.toMatchObject({ code: ErrorCode.ProviderUnavailable });
  });
});

describe('one-time product notifications [rtdn-reference, OneTimeProductNotification]', () => {
  const productRoute = (json: unknown, status = 200) =>
    route(HttpMethod.Get, '/applications/com.some.thing/purchases/productsv2/tokens/PURCHASE_TOKEN', { json: json as Record<string, unknown>, status });
  const orderRoute = (json: unknown) => route(HttpMethod.Get, '/applications/com.some.thing/orders/GPA.3375-1111-2222-33333', { json: json as Record<string, unknown> });

  it('type 1 is payment.succeeded with the payment', async () => {
    const t = makeProvider([productRoute(PRODUCT_PURCHASED), orderRoute(ORDER_PROCESSED)], open);
    const [event] = await t.provider.parseWebhook(pushRequest(RTDN_ONE_TIME, { token: null }));
    expect(event).toMatchObject({
      type: EventType.PaymentSucceeded,
      providerEventType: 'ONE_TIME_PRODUCT_PURCHASED',
      paymentId: 'PURCHASE_TOKEN',
      payment: { id: 'PURCHASE_TOKEN', amount: 9900, status: 'succeeded' },
    });
    expect(SubscriptionEventSchema.parse(event)).toBeTruthy();
  });

  it('type 2 is payment.failed with the cancelled payment', async () => {
    const note = { ...RTDN_ONE_TIME, oneTimeProductNotification: { ...RTDN_ONE_TIME.oneTimeProductNotification, notificationType: 2 } };
    const t = makeProvider([productRoute({ ...PRODUCT_PURCHASED, purchaseStateContext: { purchaseState: 'CANCELLED' }, orderId: null })], open);
    const [event] = await t.provider.parseWebhook(pushRequest(note, { token: null }));
    expect(event).toMatchObject({ type: EventType.PaymentFailed, providerEventType: 'ONE_TIME_PRODUCT_CANCELED', payment: { status: 'cancelled' } });
  });

  it('an unknown type is an unknown event without calls', async () => {
    const note = { ...RTDN_ONE_TIME, oneTimeProductNotification: { ...RTDN_ONE_TIME.oneTimeProductNotification, notificationType: 7 } };
    const t = makeProvider([], open);
    const [event] = await t.provider.parseWebhook(pushRequest(note, { token: null }));
    expect(event).toMatchObject({ type: EventType.Unknown, paymentId: 'PURCHASE_TOKEN' });
    expect(t.calls).toHaveLength(0);
  });

  it('an order in another currency leaves the payment out and keeps the event', async () => {
    const t = makeProvider([productRoute(PRODUCT_PURCHASED), orderRoute({ ...ORDER_PROCESSED, total: { currencyCode: 'USD', units: '1', nanos: 0 } })], open);
    const [event] = await t.provider.parseWebhook(pushRequest(RTDN_ONE_TIME, { token: null }));
    expect(event).toMatchObject({ type: EventType.PaymentSucceeded, paymentId: 'PURCHASE_TOKEN' });
    expect(event?.payment).toBeUndefined();
  });
});

describe('voided purchase notifications [rtdn-reference, VoidedPurchaseNotification]', () => {
  const orderRoute = (json: unknown, status = 200) =>
    route(HttpMethod.Get, '/applications/com.some.app/orders/GS.0000-0000-0000', { json: json as Record<string, unknown>, status });
  const config = { acceptUnauthenticatedWebhooks: true, packageName: 'com.some.app' };
  const voided = (extra: Record<string, unknown>) => ({ ...RTDN_VOIDED, voidedPurchaseNotification: { ...RTDN_VOIDED.voidedPurchaseNotification, ...extra } });
  const refundedOrder = { ...ORDER_PROCESSED, orderId: 'GS.0000-0000-0000', state: 'REFUNDED', orderHistory: { refundEvent: { refundDetails: { total: { currencyCode: 'INR', units: '99', nanos: 0 } } } } };

  it('a voided subscription order is refund.succeeded with the subscription id', async () => {
    const t = makeProvider([orderRoute(refundedOrder)], { config });
    const [event] = await t.provider.parseWebhook(pushRequest(RTDN_VOIDED, { token: null }));
    expect(event).toMatchObject({
      type: EventType.RefundSucceeded,
      providerEventType: 'VOIDED_PURCHASE:REFUND_TYPE_FULL_REFUND',
      subscriptionId: 'PURCHASE_TOKEN',
      refund: { id: 'GS.0000-0000-0000', chargeId: 'GS.0000-0000-0000', subscriptionId: 'PURCHASE_TOKEN', status: 'succeeded', amount: 9900 },
    });
    expect(event?.paymentId).toBeUndefined();
  });

  it('a voided one-time purchase carries paymentId, and chargeId = paymentId = the token', async () => {
    const t = makeProvider([orderRoute(refundedOrder)], { config });
    const [event] = await t.provider.parseWebhook(pushRequest(voided({ productType: 2, refundType: 2 }), { token: null }));
    expect(event).toMatchObject({
      type: EventType.RefundSucceeded,
      providerEventType: 'VOIDED_PURCHASE:REFUND_TYPE_QUANTITY_BASED_PARTIAL_REFUND',
      paymentId: 'PURCHASE_TOKEN',
      refund: { chargeId: 'PURCHASE_TOKEN', paymentId: 'PURCHASE_TOKEN' },
    });
    expect(event?.subscriptionId).toBeUndefined();
  });

  it('still yields the event when the order cannot be read', async () => {
    const t = makeProvider([orderRoute({ error: { message: 'no' } }, 404)], { config });
    const [event] = await t.provider.parseWebhook(pushRequest(RTDN_VOIDED, { token: null }));
    expect(event).toMatchObject({ type: EventType.RefundSucceeded, subscriptionId: 'PURCHASE_TOKEN' });
    expect(event?.refund).toBeUndefined();
  });
});

describe('notifications that are not purchases are unknown events, never errors', () => {
  it('a test notification (sent from the Play Console)', async () => {
    const t = makeProvider([], open);
    const [event] = await t.provider.parseWebhook(pushRequest(RTDN_TEST, { token: null }));
    expect(event).toMatchObject({ type: EventType.Unknown, providerEventType: 'TEST_NOTIFICATION' });
    expect(SubscriptionEventSchema.parse(event)).toBeTruthy();
    expect(t.calls).toHaveLength(0);
  });

  it('a pending refund review', async () => {
    const t = makeProvider([], open);
    const [event] = await t.provider.parseWebhook(pushRequest(RTDN_PENDING_REFUND, { token: null }));
    expect(event).toMatchObject({ type: EventType.Unknown, providerEventType: 'PENDING_REFUND_REVIEW' });
  });

  it('a notification for another app', async () => {
    const t = makeProvider([], { config: { acceptUnauthenticatedWebhooks: true } });
    const [event] = await t.provider.parseWebhook(pushRequest(RTDN_SUBSCRIPTION, { token: null }));
    expect(event).toMatchObject({ type: EventType.Unknown, providerEventType: 'PACKAGE_NAME_MISMATCH' });
    expect(t.calls).toHaveLength(0);
  });

  it('a notification with none of the documented payloads', async () => {
    const t = makeProvider([], open);
    const [event] = await t.provider.parseWebhook(pushRequest({ version: '1.0', packageName: 'com.some.thing', eventTimeMillis: '1' }, { token: null }));
    expect(event).toMatchObject({ type: EventType.Unknown, providerEventType: 'UNRECOGNISED_NOTIFICATION' });
  });

  it('an event time that is not a number leaves occurredAt out', async () => {
    const t = makeProvider([], open);
    const [event] = await t.provider.parseWebhook(pushRequest({ ...RTDN_TEST, eventTimeMillis: 'soon' }, { token: null }));
    expect(event?.occurredAt).toBeUndefined();
  });
});

describe('without push authentication', () => {
  it('refuses every webhook (SIGNATURE_INVALID) unless acceptUnauthenticatedWebhooks is set, and makes no call', async () => {
    const t = makeProvider([], { config: { packageName: 'com.some.thing' } });
    const error = await t.provider.parseWebhook(pushRequest(RTDN_TEST, { token: null })).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: ErrorCode.SignatureInvalid });
    expect((error as Error).message).toMatch(/pushAudience.*pushServiceAccountEmail.*acceptUnauthenticatedWebhooks/);
    expect(t.calls).toHaveLength(0);
  });

  it('a token on an unauthenticated route is not looked at', async () => {
    const t = makeProvider([], open);
    await expect(t.provider.parseWebhook(pushRequest(RTDN_TEST, { token: 'garbage' }))).resolves.toHaveLength(1);
  });

  it('with push authentication configured, the opt-in does not weaken it', async () => {
    const t = makeProvider([], { config: { ...open.config, ...authenticatedConfig } });
    await expect(t.provider.parseWebhook(pushRequest(RTDN_TEST, { token: null }))).rejects.toMatchObject({ code: ErrorCode.SignatureInvalid });
  });

  it('a malformed request object is VALIDATION', async () => {
    const t = makeProvider([], open);
    await expect(t.provider.parseWebhook({ rawBody: 5 } as never)).rejects.toMatchObject({ code: ErrorCode.Validation });
    expect(pushBody({})).toContain('message');
  });
});
