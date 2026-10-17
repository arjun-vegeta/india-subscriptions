import { describe, expect, it } from 'vitest';
import { ErrorCode, HttpMethod, SubscriptionStatus } from '../../src/constants.js';
import { SubscriptionSchema } from '../../src/schemas.js';
import { moneyToPaise, paiseToMicros } from '../../src/providers/googleplay/index.js';
import { ORDER_PROCESSED, SUBSCRIPTION_GET_SAMPLE, SUBSCRIPTION_INR, SUBSCRIPTION_NEW, SUBSCRIPTION_ORDER, withState } from './fixtures.js';
import { P, route, makeProvider } from './helpers.js';

const TOKEN = 'sub-token-1';
const GET = `${P}/purchases/subscriptionsv2/tokens/${TOKEN}`;
const ACK = `${P}/purchases/subscriptions/premium_monthly_v2/tokens/${TOKEN}:acknowledge`;
const CANCEL = `${P}/purchases/subscriptionsv2/tokens/${TOKEN}:cancel`;
const get = (json: unknown) => route(HttpMethod.Get, GET, { json: json as Record<string, unknown> });

const FUTURE = '2026-12-22T06:00:00Z';
const PAST = '2026-11-01T06:00:00Z';
const lineItem = (overrides: Record<string, unknown>) => ({ ...SUBSCRIPTION_INR.lineItems[0], ...overrides });
const purchase = (state: string, overrides: Record<string, unknown> = {}, expiryTime = FUTURE) =>
  withState({ ...SUBSCRIPTION_INR, lineItems: [lineItem({ expiryTime })] }, state, overrides);

describe('getSubscription [purchases.subscriptionsv2.get]', () => {
  it('sends the documented request and normalises the sample', async () => {
    const t = makeProvider([get(SUBSCRIPTION_INR)]);
    const subscription = await t.provider.getSubscription(TOKEN);
    expect(t.apiCalls()).toHaveLength(1);
    expect(t.apiCalls()[0]).toMatchObject({
      method: 'GET',
      url: `https://androidpublisher.googleapis.com/androidpublisher/v3${GET}`,
    });
    expect(t.apiCalls()[0]?.body).toBeUndefined();
    expect(SubscriptionSchema.parse(subscription)).toBeTruthy();
    expect(subscription).toMatchObject({
      provider: 'google_play',
      id: TOKEN,
      // The sample prints the account id with a leading space; it is trimmed.
      reference: 'obfuscated-acc-id-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789',
      planId: 'premium_monthly_v2:premium-monthly',
      status: SubscriptionStatus.Active,
      providerStatus: 'SUBSCRIPTION_STATE_ACTIVE',
      scheduling: 'gateway',
      amount: 49950,
      currency: 'INR',
      createdAt: '2024-01-15T10:00:00.000Z',
      currentPeriodEnd: '2025-01-15T10:00:00.000Z',
      nextChargeAt: '2025-01-15T10:00:00.000Z',
      cancelAtPeriodEnd: false,
      metadata: {
        productId: 'premium_monthly_v2',
        basePlanId: 'premium-monthly',
        offerId: 'intro-offer-7day',
        regionCode: 'IN',
        latestOrderId: 'GPA.3345-1234-5678-90123',
        etag: '74798db94d8dc4c76ad1df9f77fd9693',
        acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
      },
    });
    expect(subscription.raw).toMatchObject({ subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE' });
  });

  it('a purchase priced in another currency has no amount and says which currency in metadata', async () => {
    const t = makeProvider([get(SUBSCRIPTION_GET_SAMPLE)]);
    const subscription = await t.provider.getSubscription(TOKEN);
    expect(subscription.amount).toBeUndefined();
    expect(subscription.currency).toBeUndefined();
    expect(subscription.metadata?.currencyCode).toBe('USD');
  });

  it('adds the prices of the add-on items of one purchase', async () => {
    const extra = lineItem({ productId: 'addon', autoRenewingPlan: { autoRenewEnabled: true, recurringPrice: { currencyCode: 'INR', units: '50', nanos: 0 } } });
    const t = makeProvider([get({ ...SUBSCRIPTION_INR, lineItems: [SUBSCRIPTION_INR.lineItems[0], extra] })]);
    expect((await t.provider.getSubscription(TOKEN)).amount).toBe(49950 + 5000);
  });

  it('a token Google no longer holds is NOT_FOUND (404 and 410)', async () => {
    for (const status of [404, 410]) {
      const t = makeProvider([route(HttpMethod.Get, GET, { status, json: { error: { code: status, message: 'gone', status: 'NOT_FOUND', errors: [{ reason: 'subscriptionNoLongerAvailable' }] } } })]);
      await expect(t.provider.getSubscription(TOKEN)).rejects.toMatchObject({ code: ErrorCode.NotFound, httpStatus: status, providerCode: 'subscriptionNoLongerAvailable' });
    }
  });

  it('a malformed token is VALIDATION, with Google\'s reason', async () => {
    const t = makeProvider([route(HttpMethod.Get, GET, { status: 400, json: { error: { code: 400, message: 'Invalid value', errors: [{ reason: 'invalidValue' }] } } })]);
    await expect(t.provider.getSubscription(TOKEN)).rejects.toMatchObject({ code: ErrorCode.Validation, providerCode: 'invalidValue' });
  });

  it('a body without subscriptionState is UNEXPECTED_RESPONSE', async () => {
    const t = makeProvider([get({ lineItems: [] })]);
    await expect(t.provider.getSubscription(TOKEN)).rejects.toMatchObject({ code: ErrorCode.UnexpectedResponse });
  });
});

describe('subscriptionState -> status table [purchases.subscriptionsv2, SubscriptionState]', () => {
  const cases: Array<[string, Record<string, unknown>, string | undefined, SubscriptionStatus, boolean]> = [
    ['SUBSCRIPTION_STATE_PENDING', {}, undefined, SubscriptionStatus.PendingAuthorization, false],
    ['SUBSCRIPTION_STATE_ACTIVE', {}, undefined, SubscriptionStatus.Active, false],
    ['SUBSCRIPTION_STATE_PAUSED', { pausedStateContext: { autoResumeTime: '2026-12-25T00:00:00Z' } }, undefined, SubscriptionStatus.Paused, false],
    ['SUBSCRIPTION_STATE_IN_GRACE_PERIOD', { inGracePeriodStateContext: { renewalDeclined: { pendingOrderId: 'o' } } }, undefined, SubscriptionStatus.PastDue, false],
    ['SUBSCRIPTION_STATE_ON_HOLD', { onHoldStateContext: { renewalDeclined: { pendingOrderId: 'o' } } }, PAST, SubscriptionStatus.Halted, false],
    ['SUBSCRIPTION_STATE_CANCELED', { canceledStateContext: { userInitiatedCancellation: { cancelTime: '2026-11-20T00:00:00Z' } } }, FUTURE, SubscriptionStatus.Active, true],
    ['SUBSCRIPTION_STATE_CANCELED', { canceledStateContext: { systemInitiatedCancellation: {} } }, PAST, SubscriptionStatus.Cancelled, false],
    ['SUBSCRIPTION_STATE_EXPIRED', {}, PAST, SubscriptionStatus.Expired, false],
    ['SUBSCRIPTION_STATE_EXPIRED', { canceledStateContext: { userInitiatedCancellation: {} } }, PAST, SubscriptionStatus.Cancelled, false],
    ['SUBSCRIPTION_STATE_EXPIRED', { canceledStateContext: { developerInitiatedCancellation: {} } }, PAST, SubscriptionStatus.Cancelled, false],
    ['SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED', {}, undefined, SubscriptionStatus.Failed, false],
    ['SUBSCRIPTION_STATE_UNSPECIFIED', {}, undefined, SubscriptionStatus.PendingAuthorization, false],
    ['SUBSCRIPTION_STATE_SOMETHING_NEW', {}, undefined, SubscriptionStatus.PendingAuthorization, false],
  ];
  it.each(cases)('%s %j -> %s', async (state, overrides, expiry, status, cancelAtPeriodEnd) => {
    const t = makeProvider([get(purchase(state, overrides, expiry))]);
    const subscription = await t.provider.getSubscription(TOKEN);
    expect(subscription.status).toBe(status);
    expect(subscription.providerStatus).toBe(state);
    expect(subscription.cancelAtPeriodEnd).toBe(cancelAtPeriodEnd);
  });

  it('a prototype key as the state is the fallback, not a crash', async () => {
    const t = makeProvider([get(purchase('constructor'))]);
    expect((await t.provider.getSubscription(TOKEN)).status).toBe(SubscriptionStatus.PendingAuthorization);
  });

  it('ACTIVE in a free trial phase is trialing, with the trial end', async () => {
    const t = makeProvider([get(SUBSCRIPTION_NEW)]);
    const subscription = await t.provider.getSubscription(TOKEN);
    expect(subscription.status).toBe(SubscriptionStatus.Trialing);
    expect(subscription.trialEndsAt).toBe('2022-04-29T18:39:58.270Z');
  });

  it('terminal states carry endedAt', async () => {
    const t = makeProvider([get(purchase('SUBSCRIPTION_STATE_EXPIRED', {}, PAST))]);
    expect((await t.provider.getSubscription(TOKEN)).endedAt).toBe('2026-11-01T06:00:00.000Z');
  });

  it('an installment plan with a pending cancellation is active and cancels at the period end', async () => {
    const installment = lineItem({
      autoRenewingPlan: {
        autoRenewEnabled: true,
        recurringPrice: { currencyCode: 'INR', units: '100', nanos: 0 },
        installmentDetails: { initialCommittedPaymentsCount: 6, remainingCommittedPaymentsCount: 5, pendingCancellation: {} },
      },
    });
    const t = makeProvider([get({ ...SUBSCRIPTION_INR, lineItems: [installment] })]);
    const subscription = await t.provider.getSubscription(TOKEN);
    expect(subscription).toMatchObject({ status: 'active', cancelAtPeriodEnd: true, totalCycles: 6, remainingCycles: 5 });
  });

  it('a prepaid plan has no next charge', async () => {
    const prepaid = lineItem({ autoRenewingPlan: null, prepaidPlan: { allowExtendAfterTime: '2026-12-15T00:00:00Z' } });
    const t = makeProvider([get({ ...SUBSCRIPTION_INR, lineItems: [prepaid] })]);
    const subscription = await t.provider.getSubscription(TOKEN);
    expect(subscription.status).toBe('active');
    expect(subscription.nextChargeAt).toBeUndefined();
  });

  it('a replaced purchase names the old token in metadata and raw [lifecycle: Upgrades, downgrades, and resubscribe]', async () => {
    const t = makeProvider([get(purchase('SUBSCRIPTION_STATE_ACTIVE', { linkedPurchaseToken: 'old-token' }))]);
    const subscription = await t.provider.getSubscription(TOKEN);
    expect(subscription.metadata?.linkedPurchaseToken).toBe('old-token');
  });

  it('a test purchase is marked', async () => {
    const t = makeProvider([get(purchase('SUBSCRIPTION_STATE_ACTIVE', { testPurchase: {} }))]);
    expect((await t.provider.getSubscription(TOKEN)).metadata?.testPurchase).toBe('true');
  });
});

describe('money: units and nanos to paise without float maths', () => {
  const inr = (units: string, nanos = 0) => ({ currencyCode: 'INR', units, nanos });
  it('converts exactly', () => {
    expect(moneyToPaise(inr('499', 500000000))).toBe(49950);
    expect(moneyToPaise(inr('0', 10000000))).toBe(1);
    expect(moneyToPaise(inr('0', 0))).toBe(0);
    expect(moneyToPaise(inr('1', 990000000))).toBe(199);
    expect(moneyToPaise({ currencyCode: 'INR', units: '12' })).toBe(1200);
    // 0.29 is 28.999999999999996 in floats.
    expect(moneyToPaise(inr('0', 290000000))).toBe(29);
    expect(moneyToPaise(inr('90071992547409', 910000000))).toBe(9007199254740991);
  });
  it('rounds a fraction of a paise half up', () => {
    expect(moneyToPaise(inr('0', 4999999))).toBe(0);
    expect(moneyToPaise(inr('0', 5000000))).toBe(1);
  });
  it('is undefined for another currency, and refuses negatives and unsafe sizes', () => {
    expect(moneyToPaise({ currencyCode: 'USD', units: '12', nanos: 990000000 })).toBeUndefined();
    expect(moneyToPaise(undefined)).toBeUndefined();
    expect(() => moneyToPaise(inr('-1'))).toThrowError(/valid INR amount/);
    expect(() => moneyToPaise(inr('1', -5))).toThrowError(/valid INR amount/);
    expect(() => moneyToPaise(inr('90071992547409999'))).toThrowError(/valid INR amount/);
  });
  it('converts paise to micros for the external transactions API', () => {
    expect(paiseToMicros(49950)).toBe('499500000');
    expect(paiseToMicros(0)).toBe('0');
    expect(paiseToMicros(1)).toBe('10000');
  });
});

describe('verifyCheckout: read, then acknowledge once', () => {
  const result = { purchaseToken: TOKEN, productId: 'premium_monthly_v2' };

  it('acknowledges an unacknowledged active purchase and returns the token as subscriptionId, the account id as reference', async () => {
    const t = makeProvider([
      get({ ...SUBSCRIPTION_NEW, lineItems: [{ ...SUBSCRIPTION_NEW.lineItems[0], productId: 'premium_monthly_v2' }] }),
      route(HttpMethod.Post, ACK, { json: {} }),
    ]);
    const verification = await t.provider.verifyCheckout(result);
    expect(verification).toMatchObject({
      provider: 'google_play',
      subscriptionId: TOKEN,
      reference: '6f1c2d0e-3a41-4d7c-9e3b-0a5c1e2f7b11',
      authorized: true,
      status: 'trialing',
    });
    const [read, ack] = t.apiCalls();
    expect(read).toMatchObject({ method: 'GET', url: `https://androidpublisher.googleapis.com/androidpublisher/v3${GET}` });
    expect(ack).toMatchObject({ method: 'POST', url: `https://androidpublisher.googleapis.com/androidpublisher/v3${ACK}` });
    expect(ack?.json).toEqual({});
    expect(ack?.headers['content-type']).toBe('application/json');
  });

  it('does not acknowledge a purchase that is acknowledged already', async () => {
    const t = makeProvider([get({ ...SUBSCRIPTION_INR, lineItems: [lineItem({})] })]);
    const verification = await t.provider.verifyCheckout(result);
    expect(verification.authorized).toBe(true);
    expect(t.apiCalls()).toHaveLength(1);
  });

  it('leaves a pending purchase alone: unauthorised, not acknowledged', async () => {
    const t = makeProvider([get({ ...SUBSCRIPTION_NEW, subscriptionState: 'SUBSCRIPTION_STATE_PENDING', lineItems: [{ ...SUBSCRIPTION_NEW.lineItems[0], productId: 'premium_monthly_v2' }] })]);
    const verification = await t.provider.verifyCheckout(result);
    expect(verification).toMatchObject({ authorized: false, status: 'pending_authorization' });
    expect(t.apiCalls()).toHaveLength(1);
  });

  it('an expired purchase is not authorised and not acknowledged', async () => {
    const t = makeProvider([get({ ...purchase('SUBSCRIPTION_STATE_EXPIRED', { acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING' }, PAST) })]);
    const verification = await t.provider.verifyCheckout(result);
    expect(verification.authorized).toBe(false);
    expect(t.apiCalls()).toHaveLength(1);
  });

  it('works without a productId, taking it from the purchase', async () => {
    const t = makeProvider([get({ ...SUBSCRIPTION_NEW, lineItems: [{ ...SUBSCRIPTION_NEW.lineItems[0], productId: 'premium_monthly_v2' }] }), route(HttpMethod.Post, ACK, { json: {} })]);
    await t.provider.verifyCheckout({ purchaseToken: TOKEN });
    expect(t.apiCalls()[1]?.url).toContain('/subscriptions/premium_monthly_v2/tokens/');
  });

  it('a result naming a product the purchase is not of is SIGNATURE_INVALID, and nothing is acknowledged', async () => {
    const t = makeProvider([get(SUBSCRIPTION_NEW)]);
    await expect(t.provider.verifyCheckout({ purchaseToken: TOKEN, productId: 'other_product' })).rejects.toMatchObject({ code: ErrorCode.SignatureInvalid });
    expect(t.apiCalls()).toHaveLength(1);
  });

  it('needs a purchase token', async () => {
    const t = makeProvider([], { tokens: 0 });
    await expect(t.provider.verifyCheckout({ productId: 'x' })).rejects.toMatchObject({ code: ErrorCode.Validation });
    await expect(t.provider.verifyCheckout({ purchaseToken: '' })).rejects.toMatchObject({ code: ErrorCode.Validation });
    expect(t.calls).toHaveLength(0);
  });

  it('a failed acknowledgement is an error, and repeating verifyCheckout acknowledges again', async () => {
    const t = makeProvider([
      get({ ...SUBSCRIPTION_NEW, lineItems: [{ ...SUBSCRIPTION_NEW.lineItems[0], productId: 'premium_monthly_v2' }] }),
      route(HttpMethod.Post, ACK, { status: 503, json: { error: { message: 'unavailable' } } }),
      get({ ...SUBSCRIPTION_NEW, lineItems: [{ ...SUBSCRIPTION_NEW.lineItems[0], productId: 'premium_monthly_v2' }] }),
      route(HttpMethod.Post, ACK, { json: {} }),
    ]);
    await expect(t.provider.verifyCheckout(result)).rejects.toMatchObject({ code: ErrorCode.OutcomeUnknown });
    await expect(t.provider.verifyCheckout(result)).resolves.toMatchObject({ authorized: true });
  });

  it('refuses a test purchase in live and accepts it in test', async () => {
    const testPurchase = { ...SUBSCRIPTION_INR, testPurchase: {}, lineItems: [lineItem({})] };
    const live = makeProvider([get(testPurchase)], { config: { environment: 'live' } });
    await expect(live.provider.verifyCheckout(result)).rejects.toMatchObject({ code: ErrorCode.Validation });
    const test = makeProvider([get(testPurchase)]);
    await expect(test.provider.verifyCheckout(result)).resolves.toMatchObject({ authorized: true });
  });

  it('the replaced token reaches the caller in raw', async () => {
    const t = makeProvider([get(purchase('SUBSCRIPTION_STATE_ACTIVE', { linkedPurchaseToken: 'old-token' }))]);
    const verification = await t.provider.verifyCheckout(result);
    expect(verification.raw).toMatchObject({ linkedPurchaseToken: 'old-token' });
  });
});

describe('cancelSubscription [purchases.subscriptionsv2.cancel]', () => {
  it('at_period_end stops the payments for good and returns the fresh subscription', async () => {
    const t = makeProvider([
      get(purchase('SUBSCRIPTION_STATE_ACTIVE')),
      route(HttpMethod.Post, CANCEL, { json: {} }),
      get(purchase('SUBSCRIPTION_STATE_CANCELED', { canceledStateContext: { developerInitiatedCancellation: {} } })),
    ]);
    const subscription = await t.provider.cancelSubscription(TOKEN, { mode: 'at_period_end' });
    const cancel = t.apiCalls()[1];
    expect(cancel).toMatchObject({ method: 'POST', url: `https://androidpublisher.googleapis.com/androidpublisher/v3${CANCEL}` });
    expect(cancel?.json).toEqual({
      cancellationContext: { etag: '74798db94d8dc4c76ad1df9f77fd9693', cancellationType: 'DEVELOPER_REQUESTED_STOP_PAYMENTS' },
    });
    expect(subscription).toMatchObject({ status: 'active', cancelAtPeriodEnd: true });
  });

  it('is a no-op for a subscription that is cancelled or ended already', async () => {
    const t = makeProvider([get(purchase('SUBSCRIPTION_STATE_CANCELED', { canceledStateContext: { userInitiatedCancellation: {} } }))]);
    const subscription = await t.provider.cancelSubscription(TOKEN, { mode: 'at_period_end' });
    expect(subscription.cancelAtPeriodEnd).toBe(true);
    expect(t.apiCalls()).toHaveLength(1);
  });

  it('refuses immediate cancellation, which Google only offers as a refunding revoke', async () => {
    const t = makeProvider([], { tokens: 0 });
    const error = await t.provider.cancelSubscription(TOKEN).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: ErrorCode.Unsupported });
    expect((error as Error).message).toMatch(/refunds the customer|revoke/);
    expect(t.calls).toHaveLength(0);
    await expect(t.provider.cancelSubscription(TOKEN, { mode: 'immediately' })).rejects.toMatchObject({ code: ErrorCode.Unsupported });
  });

  it('a prepaid subscription cannot be cancelled: Google\'s refusal surfaces', async () => {
    const t = makeProvider([
      get(purchase('SUBSCRIPTION_STATE_ACTIVE')),
      route(HttpMethod.Post, CANCEL, { status: 400, json: { error: { message: 'prepaid', errors: [{ reason: 'prepaidSubscriptionNotSupported' }] } } }),
    ]);
    await expect(t.provider.cancelSubscription(TOKEN, { mode: 'at_period_end' })).rejects.toMatchObject({
      code: ErrorCode.Validation,
      providerCode: 'prepaidSubscriptionNotSupported',
    });
  });

  it('an unanswered cancel is OUTCOME_UNKNOWN', async () => {
    const t = makeProvider([get(purchase('SUBSCRIPTION_STATE_ACTIVE')), { method: HttpMethod.Post, url: `https://androidpublisher.googleapis.com/androidpublisher/v3${CANCEL}`, networkError: true }]);
    await expect(t.provider.cancelSubscription(TOKEN, { mode: 'at_period_end' })).rejects.toMatchObject({ code: ErrorCode.OutcomeUnknown });
  });
});

describe('getCharge and refundCharge [orders.get, orders.refund]', () => {
  const ORDER_ID = 'GPA.3345-1234-5678-90123..0';
  const ORDER_PATH = `${P}/orders/${ORDER_ID}`;
  const order = (json: unknown) => route(HttpMethod.Get, ORDER_PATH, { json: json as Record<string, unknown> });
  const REFUND = `${P}/orders/${ORDER_ID}:refund`;

  it('reads one order as a charge: id, subscription, amount from Order.total', async () => {
    const t = makeProvider([order({ ...SUBSCRIPTION_ORDER, purchaseToken: TOKEN })]);
    const charge = await t.provider.getCharge(TOKEN, ORDER_ID);
    expect(t.apiCalls()[0]?.url).toBe(`https://androidpublisher.googleapis.com/androidpublisher/v3${ORDER_PATH}`);
    expect(charge).toMatchObject({
      provider: 'google_play',
      id: ORDER_ID,
      subscriptionId: TOKEN,
      kind: 'recurring',
      status: 'succeeded',
      providerStatus: 'PROCESSED',
      amount: 49950,
      currency: 'INR',
      paidAt: '2026-11-22T06:00:00.000Z',
    });
  });

  it('the order of a free trial is the authorisation', async () => {
    const trial = { ...SUBSCRIPTION_ORDER, purchaseToken: TOKEN, total: { currencyCode: 'INR', units: '0', nanos: 0 }, lineItems: [{ productId: 'p', subscriptionDetails: { offerPhaseDetails: { freeTrialDetails: {} } } }] };
    const t = makeProvider([order(trial)]);
    expect(await t.provider.getCharge(TOKEN, ORDER_ID)).toMatchObject({ kind: 'authorization', amount: 0 });
  });

  it.each([
    ['PENDING', 'pending'],
    ['PROCESSED', 'succeeded'],
    ['CANCELED', 'cancelled'],
    ['PENDING_REFUND', 'succeeded'],
    ['PARTIALLY_REFUNDED', 'partially_refunded'],
    ['REFUNDED', 'refunded'],
    ['STATE_UNSPECIFIED', 'pending'],
    ['SOMETHING_NEW', 'pending'],
  ])('order state %s is charge status %s', async (state, status) => {
    const t = makeProvider([order({ ...SUBSCRIPTION_ORDER, purchaseToken: TOKEN, state })]);
    expect((await t.provider.getCharge(TOKEN, ORDER_ID)).status).toBe(status);
  });

  it('an order of another subscription is NOT_FOUND', async () => {
    const t = makeProvider([order({ ...SUBSCRIPTION_ORDER, purchaseToken: 'someone-elses' })]);
    await expect(t.provider.getCharge(TOKEN, ORDER_ID)).rejects.toMatchObject({ code: ErrorCode.NotFound });
  });

  it('an order in another currency is UNSUPPORTED: the unified model is INR only', async () => {
    const t = makeProvider([order({ ...SUBSCRIPTION_ORDER, purchaseToken: TOKEN, total: { currencyCode: 'USD', units: '5', nanos: 0 } })]);
    await expect(t.provider.getCharge(TOKEN, ORDER_ID)).rejects.toThrowError(/INR only/);
  });

  it('refundCharge reads the order, refunds it with revoke=true, and reports what the order shows then', async () => {
    const t = makeProvider([
      order({ ...SUBSCRIPTION_ORDER, purchaseToken: TOKEN }),
      route(HttpMethod.Post, REFUND, { json: {} }, '?revoke=true'),
      order({ ...SUBSCRIPTION_ORDER, purchaseToken: TOKEN, state: 'REFUNDED', orderHistory: { refundEvent: { eventTime: '2026-11-22T07:00:00Z', refundDetails: { total: { currencyCode: 'INR', units: '499', nanos: 500000000 } } } } }),
    ]);
    const refund = await t.provider.refundCharge({ subscriptionId: TOKEN, chargeId: ORDER_ID, refundId: 'refund-1' });
    const post = t.apiCalls()[1];
    expect(post).toMatchObject({ method: 'POST', url: `https://androidpublisher.googleapis.com/androidpublisher/v3${REFUND}?revoke=true` });
    expect(post?.body).toBeUndefined();
    expect(refund).toMatchObject({
      id: 'refund-1',
      reference: 'refund-1',
      chargeId: ORDER_ID,
      subscriptionId: TOKEN,
      status: 'succeeded',
      providerStatus: 'REFUNDED',
      amount: 49950,
      currency: 'INR',
    });
  });

  it('revokeOnRefund false refunds the money only', async () => {
    const t = makeProvider(
      [order({ ...SUBSCRIPTION_ORDER, purchaseToken: TOKEN }), route(HttpMethod.Post, REFUND, { json: {} }), order({ ...SUBSCRIPTION_ORDER, purchaseToken: TOKEN, state: 'PENDING_REFUND' })],
      { config: { revokeOnRefund: false } },
    );
    const refund = await t.provider.refundCharge({ chargeId: ORDER_ID, refundId: 'refund-1' });
    expect(t.apiCalls()[1]?.url).not.toContain('revoke');
    expect(refund.status).toBe('pending');
  });

  it('refuses a partial refund: orders.refund refunds the whole order', async () => {
    const t = makeProvider([order({ ...SUBSCRIPTION_ORDER, purchaseToken: TOKEN })]);
    await expect(t.provider.refundCharge({ chargeId: ORDER_ID, refundId: 'r', amount: 100 })).rejects.toThrowError(/whole order \(49950 paise\)/);
    expect(t.apiCalls()).toHaveLength(1);
  });

  it('accepts the full amount, and an order that is refunded already is returned without a second refund', async () => {
    const refunded = { ...SUBSCRIPTION_ORDER, purchaseToken: TOKEN, state: 'REFUNDED' };
    const t = makeProvider([order(refunded)]);
    const refund = await t.provider.refundCharge({ chargeId: ORDER_ID, refundId: 'r', amount: 49950 });
    expect(refund.status).toBe('succeeded');
    expect(t.apiCalls()).toHaveLength(1);
  });

  it('keeps the refund as pending when only the follow-up read fails', async () => {
    const t = makeProvider([order({ ...SUBSCRIPTION_ORDER, purchaseToken: TOKEN }), route(HttpMethod.Post, REFUND, { json: {} }, '?revoke=true'), { method: HttpMethod.Get, url: `https://androidpublisher.googleapis.com/androidpublisher/v3${ORDER_PATH}`, status: 503, json: {} }]);
    const refund = await t.provider.refundCharge({ chargeId: ORDER_ID, refundId: 'r' });
    expect(refund).toMatchObject({ status: 'pending', providerStatus: 'PENDING_REFUND', amount: 49950 });
  });

  it('a refund of an unanswered POST is OUTCOME_UNKNOWN', async () => {
    const t = makeProvider([order({ ...SUBSCRIPTION_ORDER, purchaseToken: TOKEN }), { method: HttpMethod.Post, url: `https://androidpublisher.googleapis.com/androidpublisher/v3${REFUND}?revoke=true`, networkError: true }]);
    await expect(t.provider.refundCharge({ chargeId: ORDER_ID, refundId: 'r' })).rejects.toMatchObject({ code: ErrorCode.OutcomeUnknown });
  });

  it('an order of another subscription is not refunded', async () => {
    const t = makeProvider([order({ ...ORDER_PROCESSED, orderId: ORDER_ID, purchaseToken: 'someone-elses' })]);
    await expect(t.provider.refundCharge({ subscriptionId: TOKEN, chargeId: ORDER_ID, refundId: 'r' })).rejects.toMatchObject({ code: ErrorCode.Validation });
    expect(t.apiCalls()).toHaveLength(1);
  });

  it('listCharges says why it is unsupported', async () => {
    const { provider } = makeProvider([], { tokens: 0 });
    await expect(provider.listCharges(TOKEN)).rejects.toThrowError(/latestOrderId/);
  });
});
