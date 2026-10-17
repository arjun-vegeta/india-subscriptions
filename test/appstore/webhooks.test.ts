import { X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Environment, ErrorCode, EventType, SubscriptionStatus } from '../../src/constants.js';
import { NOTIFICATION_EVENT_MAP, NotificationSubtype, NotificationType, eventTypeFor, notificationKey } from '../../src/providers/appstore/index.js';
import { SubscriptionEventSchema } from '../../src/schemas.js';
import {
  APP_ACCOUNT_TOKEN,
  APP_APPLE_ID,
  DAY,
  NOW_MS,
  ONE_TIME_ID,
  ORIGINAL_ID,
  TRANSACTION_ID,
  appleBytes,
  appleText,
  decodeJws,
  harness,
  notificationPayload,
  oneTimePayload,
  pki,
  signJws,
  signedRenewal,
  signedTransaction,
  thrown,
  webhook,
  withPayload,
} from './helpers.js';

const UUID = '002e14d5-51f5-4503-b5a8-c3a1af68eb20';

function parse(payload: Record<string, unknown>, options: { data?: Record<string, unknown> | null; overrides?: Record<string, unknown> } = {}) {
  const { provider } = harness();
  const signed = signJws(notificationPayload({ ...payload }, options.data));
  return provider.parseWebhook(webhook(signed));
}

function one(payload: Record<string, unknown>, data?: Record<string, unknown> | null) {
  const events = parse(payload, { data });
  expect(events).toHaveLength(1);
  return events[0] as NonNullable<(typeof events)[number]>;
}

describe('parseWebhook: every notification type and subtype Apple documents (App Store Server Notifications V2: notificationType, subtype)', () => {
  const consumable = { signedTransactionInfo: signJws(oneTimePayload()), signedRenewalInfo: undefined, status: undefined };

  const table: [type: string, subtype: string | undefined, event: EventType][] = [
    ['SUBSCRIBED', 'INITIAL_BUY', EventType.SubscriptionActivated],
    ['SUBSCRIBED', 'RESUBSCRIBE', EventType.SubscriptionActivated],
    ['DID_RENEW', undefined, EventType.SubscriptionCharged],
    ['DID_RENEW', 'BILLING_RECOVERY', EventType.SubscriptionCharged],
    ['DID_FAIL_TO_RENEW', undefined, EventType.SubscriptionPastDue],
    ['DID_FAIL_TO_RENEW', 'GRACE_PERIOD', EventType.SubscriptionPastDue],
    ['GRACE_PERIOD_EXPIRED', undefined, EventType.SubscriptionPastDue],
    ['EXPIRED', 'VOLUNTARY', EventType.SubscriptionCancelled],
    ['EXPIRED', 'BILLING_RETRY', EventType.SubscriptionHalted],
    ['EXPIRED', 'PRICE_INCREASE', EventType.SubscriptionExpired],
    ['EXPIRED', 'PRODUCT_NOT_FOR_SALE', EventType.SubscriptionExpired],
    ['EXPIRED', undefined, EventType.SubscriptionExpired],
    ['DID_CHANGE_RENEWAL_STATUS', 'AUTO_RENEW_DISABLED', EventType.SubscriptionUpdated],
    ['DID_CHANGE_RENEWAL_STATUS', 'AUTO_RENEW_ENABLED', EventType.SubscriptionUpdated],
    ['DID_CHANGE_RENEWAL_STATUS', undefined, EventType.SubscriptionUpdated],
    ['DID_CHANGE_RENEWAL_PREF', 'UPGRADE', EventType.SubscriptionUpdated],
    ['DID_CHANGE_RENEWAL_PREF', 'DOWNGRADE', EventType.SubscriptionUpdated],
    ['DID_CHANGE_RENEWAL_PREF', 'INCREASE_QUANTITY', EventType.SubscriptionUpdated],
    ['DID_CHANGE_RENEWAL_PREF', 'DECREASE_QUANTITY', EventType.SubscriptionUpdated],
    ['DID_CHANGE_RENEWAL_PREF', undefined, EventType.SubscriptionUpdated],
    ['OFFER_REDEEMED', undefined, EventType.SubscriptionUpdated],
    ['OFFER_REDEEMED', 'UPGRADE', EventType.SubscriptionUpdated],
    ['OFFER_REDEEMED', 'DOWNGRADE', EventType.SubscriptionUpdated],
    ['PRICE_INCREASE', 'PENDING', EventType.SubscriptionUpdated],
    ['PRICE_INCREASE', 'ACCEPTED', EventType.SubscriptionUpdated],
    ['RENEWAL_EXTENDED', undefined, EventType.SubscriptionUpdated],
    ['REVOKE', undefined, EventType.SubscriptionCancelled],
    ['REFUND', undefined, EventType.RefundSucceeded],
    ['REFUND', 'SEATS', EventType.Unknown],
    ['REFUND_DECLINED', undefined, EventType.Unknown],
    ['REFUND_REVERSED', undefined, EventType.Unknown],
    ['CONSUMPTION_REQUEST', undefined, EventType.Unknown],
    ['RENEWAL_EXTENSION', 'SUMMARY', EventType.Unknown],
    ['RENEWAL_EXTENSION', 'FAILURE', EventType.Unknown],
    ['EXTERNAL_PURCHASE_TOKEN', 'CREATED', EventType.Unknown],
    ['EXTERNAL_PURCHASE_TOKEN', 'ACTIVE_TOKEN_REMINDER', EventType.Unknown],
    ['EXTERNAL_PURCHASE_TOKEN', 'UNREPORTED', EventType.Unknown],
    ['METADATA_UPDATE', undefined, EventType.Unknown],
    ['MIGRATION', undefined, EventType.Unknown],
    ['PRICE_CHANGE', undefined, EventType.Unknown],
    ['RESCIND_CONSENT', undefined, EventType.Unknown],
    ['TEST', undefined, EventType.Unknown],
    ['UNCLAIM_SEATS', undefined, EventType.Unknown],
  ];

  it.each(table)('%s / %s -> %s', (type, subtype, expected) => {
    const event = one({ notificationType: type, subtype, notificationUUID: UUID });
    expect(event.type).toBe(expected);
    expect(event.id).toBe(UUID);
    expect(event.provider).toBe('app_store');
    expect(event.providerEventType).toBe(subtype ? `${type}:${subtype}` : type);
    expect(event.occurredAt).toBe(new Date(1698148900000).toISOString());
    expect(SubscriptionEventSchema.safeParse(event).success).toBe(true);
    expect(eventTypeFor(type, subtype)).toBe(expected);
  });

  it('has an entry for every notification type Apple documents', () => {
    for (const type of Object.values(NotificationType)) {
      expect(Object.keys(NOTIFICATION_EVENT_MAP).some((key) => key === type || key.startsWith(`${type}:`)), type).toBe(true);
    }
    // And every key of the table names a documented type and subtype.
    const types = new Set<string>(Object.values(NotificationType));
    const subtypes = new Set<string>(Object.values(NotificationSubtype));
    for (const key of Object.keys(NOTIFICATION_EVENT_MAP)) {
      const [type, subtype] = key.split(':') as [string, string | undefined];
      expect(types.has(type), key).toBe(true);
      if (subtype) expect(subtypes.has(subtype), key).toBe(true);
    }
  });

  it('answers unknown, never an error, for a type or subtype Apple adds later', () => {
    expect(one({ notificationType: 'SOMETHING_NEW', subtype: 'WHATEVER', notificationUUID: UUID }).type).toBe(EventType.Unknown);
    const event = one({ notificationType: 'SOMETHING_NEW', notificationUUID: UUID });
    expect(event.type).toBe(EventType.Unknown);
    expect(event.providerEventType).toBe('SOMETHING_NEW');
    expect(event.raw).toMatchObject({ notification: { notificationType: 'SOMETHING_NEW' } });
    // A new subtype of a known type behaves as the bare type.
    expect(one({ notificationType: 'DID_RENEW', subtype: 'NEW_SUBTYPE', notificationUUID: UUID }).type).toBe(EventType.SubscriptionCharged);
    expect(notificationKey('A')).toBe('A');
  });

  it('degrades a subscription event about a one-time product to unknown, and says what it is about', () => {
    const event = one({ notificationType: 'REVOKE', notificationUUID: UUID }, consumable);
    expect(event.type).toBe(EventType.Unknown);
    expect(event.paymentId).toBe(ONE_TIME_ID);
    expect(event.subscriptionId).toBeUndefined();
  });

  it('is unknown, still carrying the verified payload, when a subscription event has no transaction', () => {
    const event = one({ notificationType: 'DID_RENEW', notificationUUID: UUID }, { signedTransactionInfo: undefined, signedRenewalInfo: undefined, status: undefined });
    expect(event.type).toBe(EventType.Unknown);
    expect(event.subscriptionId).toBeUndefined();
  });
});

describe('parseWebhook: what the events carry', () => {
  it('SUBSCRIBED: the subscription with its status and the token as reference', () => {
    const event = one({ notificationType: 'SUBSCRIBED', subtype: 'INITIAL_BUY', notificationUUID: UUID });
    expect(event).toMatchObject({
      type: EventType.SubscriptionActivated,
      subscriptionId: ORIGINAL_ID,
      subscription: { id: ORIGINAL_ID, status: SubscriptionStatus.Active, reference: APP_ACCOUNT_TOKEN, amount: 49900, providerStatus: '1' },
    });
    expect(event.charge).toBeUndefined();
    expect(event.paymentId).toBeUndefined();
    expect(event.raw).toMatchObject({
      notification: { notificationType: 'SUBSCRIBED', notificationUUID: UUID },
      transactionInfo: { transactionId: TRANSACTION_ID },
      renewalInfo: { originalTransactionId: ORIGINAL_ID },
    });
  });

  it('DID_RENEW: the charge of the renewal', () => {
    const event = one({ notificationType: 'DID_RENEW', notificationUUID: UUID });
    expect(event.type).toBe(EventType.SubscriptionCharged);
    expect(event.charge).toMatchObject({ id: TRANSACTION_ID, subscriptionId: ORIGINAL_ID, amount: 49900, status: 'succeeded', kind: 'recurring' });
  });

  it('the status in the notification is the subscription status of the event', () => {
    const grace = one({ notificationType: 'DID_FAIL_TO_RENEW', subtype: 'GRACE_PERIOD', notificationUUID: UUID }, { status: 4 });
    expect(grace.subscription?.status).toBe(SubscriptionStatus.PastDue);
    expect(grace.subscription?.providerStatus).toBe('4');
    const off = one({ notificationType: 'DID_CHANGE_RENEWAL_STATUS', subtype: 'AUTO_RENEW_DISABLED', notificationUUID: UUID }, { signedRenewalInfo: signedRenewal({ autoRenewStatus: 0 }) });
    expect(off.subscription?.cancelAtPeriodEnd).toBe(true);
    expect(off.subscription?.status).toBe(SubscriptionStatus.Active);
    const expired = one({ notificationType: 'EXPIRED', subtype: 'VOLUNTARY', notificationUUID: UUID }, { status: 2, signedRenewalInfo: signedRenewal({ expirationIntent: 1, autoRenewStatus: 0 }) });
    expect(expired.subscription?.status).toBe(SubscriptionStatus.Cancelled);
    const halted = one({ notificationType: 'EXPIRED', subtype: 'BILLING_RETRY', notificationUUID: UUID }, { status: 2, signedRenewalInfo: signedRenewal({ expirationIntent: 2 }) });
    expect(halted.subscription?.status).toBe(SubscriptionStatus.Halted);
  });

  it('has no subscription when the notification gives no status, but still names it', () => {
    const event = one({ notificationType: 'DID_RENEW', notificationUUID: UUID }, { status: undefined, signedRenewalInfo: undefined });
    expect(event.subscription).toBeUndefined();
    expect(event.subscriptionId).toBe(ORIGINAL_ID);
    expect(event.charge?.id).toBe(TRANSACTION_ID);
  });

  it('ONE_TIME_CHARGE: payment.succeeded with the payment', () => {
    const data = { signedTransactionInfo: signJws(oneTimePayload()), signedRenewalInfo: undefined, status: undefined };
    const event = one({ notificationType: 'ONE_TIME_CHARGE', notificationUUID: UUID }, data);
    expect(event.type).toBe(EventType.PaymentSucceeded);
    expect(event.paymentId).toBe(ONE_TIME_ID);
    expect(event.payment).toMatchObject({ id: ONE_TIME_ID, amount: 9900, status: 'succeeded', reference: APP_ACCOUNT_TOKEN });
    expect(event.subscriptionId).toBeUndefined();
  });

  it('REFUND of a one-time purchase: a refund with both ids, and the refunded payment', () => {
    const revoked = oneTimePayload({ revocationDate: NOW_MS - DAY, revocationType: 'REFUND_FULL', revocationReason: 0 });
    const data = { signedTransactionInfo: signJws(revoked), signedRenewalInfo: undefined, status: undefined };
    const event = one({ notificationType: 'REFUND', notificationUUID: UUID }, data);
    expect(event.type).toBe(EventType.RefundSucceeded);
    expect(event.refund).toMatchObject({
      id: ONE_TIME_ID,
      chargeId: ONE_TIME_ID,
      paymentId: ONE_TIME_ID,
      status: 'succeeded',
      amount: 9900,
      currency: 'INR',
      createdAt: new Date(NOW_MS - DAY).toISOString(),
      providerStatus: 'REFUND_FULL',
    });
    expect(event.refund?.subscriptionId).toBeUndefined();
    expect(event.payment).toMatchObject({ status: 'refunded', refundedAmount: 9900 });
    expect(event.paymentId).toBe(ONE_TIME_ID);
  });

  it('REFUND of a subscription transaction: a refund with the subscription, prorated by the percentage', () => {
    const revoked = { revocationDate: NOW_MS - DAY, revocationType: 'REFUND_PRORATED', revocationPercentage: 50_000 };
    const data = { signedTransactionInfo: signedTransaction(revoked), status: 5 };
    const event = one({ notificationType: 'REFUND', notificationUUID: UUID }, data);
    expect(event.type).toBe(EventType.RefundSucceeded);
    expect(event.refund).toMatchObject({ id: TRANSACTION_ID, chargeId: TRANSACTION_ID, subscriptionId: ORIGINAL_ID, amount: 24950 });
    expect(event.refund?.paymentId).toBeUndefined();
    expect(event.charge).toMatchObject({ id: TRANSACTION_ID, status: 'partially_refunded', refundedAmount: 24950 });
    expect(event.subscription?.status).toBe(SubscriptionStatus.Cancelled);
  });

  it('a transaction priced in another currency still gives the event, without the amounts', () => {
    const usd = { currency: 'USD', price: 9_990, storefront: 'USA' };
    const renew = one({ notificationType: 'DID_RENEW', notificationUUID: UUID }, { signedTransactionInfo: signedTransaction(usd), signedRenewalInfo: signedRenewal({ currency: 'USD', renewalPrice: 9_990 }) });
    expect(renew.type).toBe(EventType.SubscriptionCharged);
    expect(renew.charge).toBeUndefined();
    expect(renew.subscription?.status).toBe(SubscriptionStatus.Active);
    expect(renew.subscription?.amount).toBeUndefined();
    const paid = one({ notificationType: 'ONE_TIME_CHARGE', notificationUUID: UUID }, { signedTransactionInfo: signJws(oneTimePayload(usd)), signedRenewalInfo: undefined, status: undefined });
    expect(paid.type).toBe(EventType.PaymentSucceeded);
    expect(paid.paymentId).toBe(ONE_TIME_ID);
    expect(paid.payment).toBeUndefined();
    const refund = one({ notificationType: 'REFUND', notificationUUID: UUID }, { signedTransactionInfo: signJws(oneTimePayload({ ...usd, revocationDate: NOW_MS, revocationType: 'REFUND_FULL' })), signedRenewalInfo: undefined, status: undefined });
    expect(refund.type).toBe(EventType.RefundSucceeded);
    expect(refund.refund).toBeUndefined();
  });

  it('uses the notification UUID as the id, so a redelivery has the same id', () => {
    const request = webhook(signJws(notificationPayload()));
    const { provider } = harness();
    const first = provider.parseWebhook(request);
    const second = provider.parseWebhook(request);
    expect(first[0]?.id).toBe(UUID);
    expect(second[0]?.id).toBe(first[0]?.id);
  });
});

describe('parseWebhook: what does not verify is SIGNATURE_INVALID and nothing is read', () => {
  const run = (rawBody: string) => thrown(() => harness().provider.parseWebhook({ rawBody, headers: {} }));
  const body = (signedPayload: string) => JSON.stringify({ signedPayload });

  it('refuses a body that is not JSON or holds no signedPayload', () => {
    for (const rawBody of ['', 'not json', '{}', '[]', 'null', '{"signedPayload":""}', '{"signedPayload":5}']) {
      expect(run(rawBody).code, rawBody).toBe(ErrorCode.SignatureInvalid);
    }
  });

  it('refuses a payload that was changed after signing', () => {
    const signed = signJws(notificationPayload());
    const tampered = withPayload(signed, { ...decodeJws(signed).payload, notificationType: 'REFUND_REVERSED' });
    expect(run(body(tampered)).code).toBe(ErrorCode.SignatureInvalid);
  });

  it('refuses a notification signed by another authority, an expired certificate, or a chain missing a certificate', () => {
    for (const options of [
      { chain: ['other-leaf', 'other-intermediate', 'other-root'] },
      { chain: ['expired-leaf', 'intermediate', 'root'] },
      { chain: ['leaf', 'intermediate'] },
    ]) {
      expect(run(body(signJws(notificationPayload(), options))).code).toBe(ErrorCode.SignatureInvalid);
    }
  });

  it('refuses a notification for another app or the other environment', () => {
    expect(run(body(signJws(notificationPayload({}, { bundleId: 'com.other' })))).code).toBe(ErrorCode.SignatureInvalid);
    expect(run(body(signJws(notificationPayload({}, { environment: 'Production' })))).code).toBe(ErrorCode.SignatureInvalid);
  });

  it('refuses a good notification whose nested transaction does not verify', () => {
    const good = signedTransaction();
    const tampered = withPayload(good, { ...decodeJws(good).payload, productId: 'com.example.free' });
    for (const data of [
      { signedTransactionInfo: tampered },
      { signedTransactionInfo: signedTransaction({ bundleId: 'com.other' }) },
      { signedTransactionInfo: signedTransaction({}, { chain: ['other-leaf', 'other-intermediate', 'other-root'] }) },
      { signedRenewalInfo: withPayload(signedRenewal(), { ...decodeJws(signedRenewal()).payload, autoRenewStatus: 0 }) },
      { signedRenewalInfo: signedRenewal({ environment: 'Production' }) },
      { signedTransactionInfo: 'signed_transaction_info_value' },
    ]) {
      expect(run(body(signJws(notificationPayload({}, data)))).code).toBe(ErrorCode.SignatureInvalid);
    }
  });

  it('checks the production app Apple id', () => {
    const production = harness([], { environment: Environment.Live, appAppleId: APP_APPLE_ID }).provider;
    const prod = (data: Record<string, unknown>) =>
      webhook(
        signJws(
          notificationPayload({}, {
            environment: 'Production',
            signedTransactionInfo: signedTransaction({ environment: 'Production' }),
            signedRenewalInfo: signedRenewal({ environment: 'Production' }),
            ...data,
          }),
        ),
      );
    expect(production.parseWebhook(prod({}))[0]?.type).toBe(EventType.SubscriptionActivated);
    expect(thrown(() => production.parseWebhook(prod({ appAppleId: 42 }))).code).toBe(ErrorCode.SignatureInvalid);
    expect(thrown(() => production.parseWebhook(prod({ appAppleId: undefined }))).code).toBe(ErrorCode.SignatureInvalid);
  });

  it('does not put the payload into the error', () => {
    const error = run(body(signJws(notificationPayload({}, { bundleId: 'com.secret.bundle' }))));
    expect(error.message).not.toContain('com.secret.bundle');
  });
});

describe("Apple's own signed TEST notification (apple-library fixtures)", () => {
  const appleRoot = new X509Certificate(appleBytes('certs/testCA.der')).toString();

  it('verifies against its test authority and is an unknown event with the notification UUID as id', () => {
    const { provider } = harness([], { rootCertificates: [appleRoot], appAppleId: 1234 });
    const events = provider.parseWebhook(webhook(appleText('mock_signed_data/testNotification')));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: '9ad56bd2-0bc6-42e0-af24-fd996d87a1e6',
      type: EventType.Unknown,
      providerEventType: 'TEST',
      occurredAt: new Date(1681314324000).toISOString(),
    });
  });

  it('refuses the same data against the generated root', () => {
    const { provider } = harness([], { rootCertificates: [pki('root.pem')] });
    expect(thrown(() => provider.parseWebhook(webhook(appleText('mock_signed_data/testNotification')))).code).toBe(ErrorCode.SignatureInvalid);
  });

  it('refuses the library notification made for another bundle id', () => {
    const { provider } = harness([], { rootCertificates: [appleRoot], appAppleId: 1234 });
    expect(thrown(() => provider.parseWebhook(webhook(appleText('mock_signed_data/wrongBundleId')))).code).toBe(ErrorCode.SignatureInvalid);
  });
});

describe('parseWebhook: notifications without a transaction', () => {
  it('maps the library sample summary, consumption request and consent notifications to unknown events', () => {
    const { provider } = harness();
    const summary = JSON.parse(appleText('models/signedSummaryNotification.json')) as Record<string, unknown>;
    const summarySigned = signJws({ ...summary, summary: { ...(summary.summary as object), environment: 'Sandbox' } });
    expect(provider.parseWebhook(webhook(summarySigned))[0]).toMatchObject({ type: EventType.Unknown, providerEventType: 'RENEWAL_EXTENSION:SUMMARY', id: UUID });
    const consumption = JSON.parse(appleText('models/signedConsumptionRequestNotification.json')) as { data: Record<string, unknown> } & Record<string, unknown>;
    const consumptionSigned = signJws({
      ...consumption,
      data: { ...consumption.data, environment: 'Sandbox', signedTransactionInfo: signedTransaction(), signedRenewalInfo: signedRenewal() },
    });
    const event = provider.parseWebhook(webhook(consumptionSigned))[0];
    expect(event).toMatchObject({ type: EventType.Unknown, providerEventType: 'CONSUMPTION_REQUEST', subscriptionId: ORIGINAL_ID });
  });
});
