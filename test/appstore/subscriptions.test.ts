import { describe, expect, it } from 'vitest';
import { ChargeStatus, ErrorCode, SchedulingMode, SubscriptionStatus } from '../../src/constants.js';
import { SubscriptionSchema, ChargeSchema } from '../../src/schemas.js';
import {
  APP_ACCOUNT_TOKEN,
  DAY,
  NOW_MS,
  ORIGINAL_ID,
  TRANSACTION_ID,
  appleFixture,
  get,
  harness,
  rejection,
  signJws,
  signedRenewal,
  signedTransaction,
  statusItem,
  statusResponse,
  withPayload,
  decodeJws,
} from './helpers.js';

const PATH = `/inApps/v1/subscriptions/${ORIGINAL_ID}`;

async function read(status: number, transaction = {}, renewal: Record<string, unknown> | null = {}) {
  const h = harness([get(PATH, statusResponse([statusItem(status, transaction, renewal)]))]);
  return { subscription: await h.provider.getSubscription(ORIGINAL_ID), h };
}

describe('getSubscription: the request', () => {
  it('is a GET of the subscription statuses with a bearer token and no body', async () => {
    const { h } = await read(1);
    expect(h.calls).toHaveLength(1);
    const call = h.calls[0];
    expect(call?.method).toBe('GET');
    expect(call?.url).toBe(`https://api.storekit-sandbox.apple.com/inApps/v1/subscriptions/${ORIGINAL_ID}`);
    expect(call?.headers.accept).toBe('application/json');
    expect(call?.headers.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(call?.body).toBeUndefined();
  });

  it('encodes the id into the path', async () => {
    const h = harness([get('/inApps/v1/subscriptions/a%2Fb%20c', statusResponse([]))]);
    await rejection(h.provider.getSubscription('a/b c'));
    expect(h.calls[0]?.url).toContain('/inApps/v1/subscriptions/a%2Fb%20c');
  });

  it('refuses the app account token that createSubscription returned: it names no store purchase', async () => {
    const h = harness();
    const error = await rejection(h.provider.getSubscription(APP_ACCOUNT_TOKEN));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(error.message).toContain('originalTransactionId');
    expect(h.calls).toHaveLength(0);
    expect((await rejection(h.provider.getSubscription(' '))).code).toBe(ErrorCode.Validation);
  });
});

describe('getSubscription: statuses (App Store Server API: status)', () => {
  const cases: { name: string; status: number; transaction?: Record<string, unknown>; renewal?: Record<string, unknown> | null; unified: SubscriptionStatus }[] = [
    { name: '1 active', status: 1, unified: SubscriptionStatus.Active },
    { name: '1 active, free trial', status: 1, transaction: { offerType: 1, offerDiscountType: 'FREE_TRIAL', offerIdentifier: undefined }, unified: SubscriptionStatus.Trialing },
    { name: '1 active, pay as you go offer (not a trial)', status: 1, transaction: { offerType: 1, offerDiscountType: 'PAY_AS_YOU_GO' }, unified: SubscriptionStatus.Active },
    { name: '2 expired, the customer cancelled (intent 1)', status: 2, renewal: { expirationIntent: 1 }, unified: SubscriptionStatus.Cancelled },
    { name: '2 expired, billing error (intent 2)', status: 2, renewal: { expirationIntent: 2 }, unified: SubscriptionStatus.Halted },
    { name: '2 expired, price increase not consented (intent 3)', status: 2, renewal: { expirationIntent: 3 }, unified: SubscriptionStatus.Expired },
    { name: '2 expired, product unavailable (intent 4)', status: 2, renewal: { expirationIntent: 4 }, unified: SubscriptionStatus.Expired },
    { name: '2 expired, other (intent 5)', status: 2, renewal: { expirationIntent: 5 }, unified: SubscriptionStatus.Expired },
    { name: '2 expired, no intent', status: 2, unified: SubscriptionStatus.Expired },
    { name: '2 expired, no renewal information', status: 2, renewal: null, unified: SubscriptionStatus.Expired },
    { name: '2 expired, an intent Apple adds later', status: 2, renewal: { expirationIntent: 9 }, unified: SubscriptionStatus.Expired },
    { name: '3 billing retry', status: 3, renewal: { isInBillingRetryPeriod: true }, unified: SubscriptionStatus.PastDue },
    { name: '4 billing grace period', status: 4, renewal: { isInBillingRetryPeriod: true, gracePeriodExpiresDate: NOW_MS + 3 * DAY }, unified: SubscriptionStatus.PastDue },
    { name: '5 revoked', status: 5, transaction: { revocationDate: NOW_MS - DAY, revocationType: 'REFUND_FULL' }, unified: SubscriptionStatus.Cancelled },
    { name: 'a status Apple adds later falls back to expired (no access)', status: 9, unified: SubscriptionStatus.Expired },
    { name: 'status 0 falls back to expired', status: 0, unified: SubscriptionStatus.Expired },
  ];

  it.each(cases)('$name -> $unified', async ({ status, transaction, renewal, unified }) => {
    const { subscription } = await read(status, transaction, renewal);
    expect(subscription.status).toBe(unified);
    // providerStatus keeps Apple's number verbatim.
    expect(subscription.providerStatus).toBe(String(status));
    expect(SubscriptionSchema.safeParse(subscription).success).toBe(true);
  });
});

describe('getSubscription: the mapped subscription', () => {
  it('maps an active subscription field by field', async () => {
    const { subscription } = await read(1);
    expect(subscription).toMatchObject({
      provider: 'app_store',
      id: ORIGINAL_ID,
      reference: APP_ACCOUNT_TOKEN,
      planId: 'com.example.product',
      status: 'active',
      providerStatus: '1',
      scheduling: SchedulingMode.Gateway,
      quantity: 1,
      // INR 499 is 499000 milliunits is 49900 paise.
      amount: 49900,
      currency: 'INR',
      createdAt: new Date(NOW_MS - 100 * DAY).toISOString(),
      startAt: new Date(NOW_MS - 100 * DAY).toISOString(),
      currentPeriodStart: new Date(NOW_MS - 10 * DAY).toISOString(),
      currentPeriodEnd: new Date(NOW_MS + 20 * DAY).toISOString(),
      nextChargeAt: new Date(NOW_MS + 20 * DAY).toISOString(),
      cancelAtPeriodEnd: false,
    });
    expect(subscription.endedAt).toBeUndefined();
    expect(subscription.trialEndsAt).toBeUndefined();
    // Apple's payloads do not carry the billing duration.
    expect(subscription.interval).toBeUndefined();
  });

  it('sets cancelAtPeriodEnd, and no next charge, when auto-renew is off', async () => {
    const { subscription } = await read(1, {}, { autoRenewStatus: 0 });
    expect(subscription.status).toBe(SubscriptionStatus.Active);
    expect(subscription.cancelAtPeriodEnd).toBe(true);
    expect(subscription.nextChargeAt).toBeUndefined();
    expect(subscription.currentPeriodEnd).toBeDefined();
  });

  it('leaves cancelAtPeriodEnd out without renewal information, and for a subscription that has ended', async () => {
    expect((await read(1, {}, null)).subscription.cancelAtPeriodEnd).toBeUndefined();
    expect((await read(2, {}, { autoRenewStatus: 0, expirationIntent: 1 })).subscription.cancelAtPeriodEnd).toBeUndefined();
  });

  it('reports a trial with its end', async () => {
    const { subscription } = await read(1, { offerType: 1, offerDiscountType: 'FREE_TRIAL' });
    expect(subscription.status).toBe(SubscriptionStatus.Trialing);
    expect(subscription.trialEndsAt).toBe(new Date(NOW_MS + 20 * DAY).toISOString());
  });

  it('keeps access-less billing retry from showing a next charge, while grace and retry stay past_due', async () => {
    const { subscription } = await read(3, { expiresDate: NOW_MS - DAY }, { isInBillingRetryPeriod: true });
    expect(subscription.status).toBe(SubscriptionStatus.PastDue);
    expect(subscription.nextChargeAt).toBeUndefined();
    expect(subscription.cancelAtPeriodEnd).toBe(false);
  });

  it('dates the end of a cancelled, expired or revoked subscription', async () => {
    const expiredAt = NOW_MS - 2 * DAY;
    const cancelled = (await read(2, { expiresDate: expiredAt }, { expirationIntent: 1 })).subscription;
    expect(cancelled.endedAt).toBe(new Date(expiredAt).toISOString());
    expect(cancelled.nextChargeAt).toBeUndefined();
    const revoked = (await read(5, { revocationDate: NOW_MS - DAY, revocationType: 'REFUND_FULL' })).subscription;
    expect(revoked.endedAt).toBe(new Date(NOW_MS - DAY).toISOString());
  });

  it('uses the renewal price, which reflects the next period offer, and falls back to the price of an offer-free transaction', async () => {
    expect((await read(1, {}, { renewalPrice: 299_000 })).subscription.amount).toBe(29900);
    expect((await read(1, { price: 399_000 }, { renewalPrice: undefined })).subscription.amount).toBe(39900);
    // A transaction with an offer has a discounted price, which is not the recurring amount.
    expect((await read(1, { offerType: 2, offerIdentifier: 'p', price: 100_000 }, { renewalPrice: undefined })).subscription.amount).toBeUndefined();
    expect((await read(1, {}, null)).subscription.amount).toBe(49900);
  });

  it('has no amount and no currency for a subscription priced in another currency, and still reports the status', async () => {
    const usd = (await read(1, { currency: 'USD', price: 9_990, storefront: 'USA' }, { currency: 'USD', renewalPrice: 9_990 })).subscription;
    expect(usd.status).toBe(SubscriptionStatus.Active);
    expect(usd.amount).toBeUndefined();
    expect(usd.currency).toBeUndefined();
    expect(SubscriptionSchema.safeParse(usd).success).toBe(true);
  });

  it('exposes the verified payloads in raw', async () => {
    const { subscription } = await read(1);
    expect(subscription.raw).toMatchObject({ status: 1, transactionInfo: { transactionId: TRANSACTION_ID }, renewalInfo: { originalTransactionId: ORIGINAL_ID } });
  });
});

describe('getSubscription: which subscription of the answer', () => {
  it('picks the entry whose originalTransactionId is asked for, across subscription groups', async () => {
    const other = statusItem(1, { originalTransactionId: '999', transactionId: '1000', productId: 'com.example.other' });
    const response = { ...statusResponse([other]), data: [...statusResponse([other]).data as object[], ...statusResponse([statusItem(2, {}, { expirationIntent: 1 })], 'g2').data as object[]] };
    const h = harness([get(PATH, response)]);
    const subscription = await h.provider.getSubscription(ORIGINAL_ID);
    expect(subscription.id).toBe(ORIGINAL_ID);
    expect(subscription.status).toBe(SubscriptionStatus.Cancelled);
  });

  it("accepts the transactionId of the latest transaction, as Apple's anyTransactionId allows", async () => {
    const id = `/inApps/v1/subscriptions/${TRANSACTION_ID}`;
    const h = harness([get(id, statusResponse([statusItem(1)]))]);
    expect((await h.provider.getSubscription(TRANSACTION_ID)).id).toBe(ORIGINAL_ID);
  });

  it('is UNEXPECTED_RESPONSE when an entry names one subscription and its signed transaction another', async () => {
    const item = { ...statusItem(1, { originalTransactionId: '999', transactionId: '1000' }), originalTransactionId: ORIGINAL_ID };
    const h = harness([get(PATH, statusResponse([item]))]);
    expect((await rejection(h.provider.getSubscription(ORIGINAL_ID))).code).toBe(ErrorCode.UnexpectedResponse);
  });

  it('is NOT_FOUND when the answer holds no such subscription', async () => {
    const h = harness([get(PATH, statusResponse([statusItem(1, { originalTransactionId: '999', transactionId: '1000' })]))]);
    const error = await rejection(h.provider.getSubscription(ORIGINAL_ID));
    expect(error.code).toBe(ErrorCode.NotFound);
    const empty = harness([get(PATH, { environment: 'Sandbox', bundleId: 'com.example', data: [] })]);
    expect((await rejection(empty.provider.getSubscription(ORIGINAL_ID))).code).toBe(ErrorCode.NotFound);
  });
});

describe('getSubscription: nothing is read from data that does not verify', () => {
  it('refuses an entry whose transaction was changed', async () => {
    const item = statusItem(1);
    const tampered = withPayload(item.signedTransactionInfo as string, { ...decodeJws(item.signedTransactionInfo as string).payload, productId: 'com.example.free' });
    const h = harness([get(PATH, statusResponse([{ ...item, signedTransactionInfo: tampered }]))]);
    expect((await rejection(h.provider.getSubscription(ORIGINAL_ID))).code).toBe(ErrorCode.SignatureInvalid);
  });

  it('refuses an entry whose renewal information was changed', async () => {
    const item = statusItem(1);
    const tampered = withPayload(item.signedRenewalInfo as string, { ...decodeJws(item.signedRenewalInfo as string).payload, autoRenewStatus: 0 });
    const h = harness([get(PATH, statusResponse([{ ...item, signedRenewalInfo: tampered }]))]);
    expect((await rejection(h.provider.getSubscription(ORIGINAL_ID))).code).toBe(ErrorCode.SignatureInvalid);
  });

  it('refuses a transaction of another app and one signed by another authority', async () => {
    for (const item of [
      { ...statusItem(1), signedTransactionInfo: signedTransaction({ bundleId: 'com.other' }) },
      { ...statusItem(1), signedTransactionInfo: signedTransaction({}, { chain: ['other-leaf', 'other-intermediate', 'other-root'] }) },
      { ...statusItem(1), signedRenewalInfo: signedRenewal({ environment: 'Production' }) },
    ]) {
      const h = harness([get(PATH, statusResponse([item]))]);
      expect((await rejection(h.provider.getSubscription(ORIGINAL_ID))).code).toBe(ErrorCode.SignatureInvalid);
    }
  });

  it('is UNEXPECTED_RESPONSE for an answer that is not the documented shape', async () => {
    const h = harness([get(PATH, { data: [{ lastTransactions: [{ status: 1 }] }] })]);
    expect((await rejection(h.provider.getSubscription(ORIGINAL_ID))).code).toBe(ErrorCode.UnexpectedResponse);
    const text = harness([{ method: 'GET', url: `https://api.storekit-sandbox.apple.com${PATH}`, text: '<html>', status: 200 }]);
    expect((await rejection(text.provider.getSubscription(ORIGINAL_ID))).code).toBe(ErrorCode.UnexpectedResponse);
  });
});

describe("Apple's sample payloads (apple-library fixtures)", () => {
  it('reads the library sample renewal information and transaction, signed with the generated chain', async () => {
    const transaction = appleFixture('models/signedTransaction.json');
    const renewal = appleFixture('models/signedRenewalInfo.json');
    const item = {
      originalTransactionId: '12345',
      status: 1,
      signedTransactionInfo: signJws({ ...transaction, environment: 'Sandbox' }),
      signedRenewalInfo: signJws({ ...renewal, environment: 'Sandbox' }),
    };
    const h = harness([get(PATH, statusResponse([item]))]);
    const subscription = await h.provider.getSubscription(ORIGINAL_ID);
    // The sample is a USD purchase of 10.99 with a revocation: the status Apple says is what counts, and USD has no INR amount.
    expect(subscription.status).toBe(SubscriptionStatus.Active);
    expect(subscription.amount).toBeUndefined();
    expect(subscription.reference).toBe('7e3fb20b-4cdb-47cc-936d-99d65f608138');
  });
});

describe('charges of a subscription', () => {
  const charge = (overrides = {}) => signedTransaction({ transactionId: '23457', purchaseDate: NOW_MS - 40 * DAY, ...overrides });

  it('getCharge reads one transaction and maps it to a succeeded charge', async () => {
    const h = harness([get(`/inApps/v1/transactions/${TRANSACTION_ID}`, { signedTransactionInfo: signedTransaction() })]);
    const result = await h.provider.getCharge(ORIGINAL_ID, TRANSACTION_ID);
    expect(h.calls[0]?.url).toBe(`https://api.storekit-sandbox.apple.com/inApps/v1/transactions/${TRANSACTION_ID}`);
    expect(result).toMatchObject({
      provider: 'app_store',
      id: TRANSACTION_ID,
      reference: APP_ACCOUNT_TOKEN,
      subscriptionId: ORIGINAL_ID,
      kind: 'recurring',
      status: ChargeStatus.Succeeded,
      providerStatus: 'PURCHASED',
      amount: 49900,
      currency: 'INR',
      paidAt: new Date(NOW_MS - 10 * DAY).toISOString(),
    });
    expect(result.refundedAmount).toBeUndefined();
    expect(ChargeSchema.safeParse(result).success).toBe(true);
  });

  it.each([
    ['REFUND_FULL', undefined, ChargeStatus.Refunded, 49900],
    ['REFUND_PRORATED', 50_000, ChargeStatus.PartiallyRefunded, 24950],
    ['REFUND_PRORATED', 33_333, ChargeStatus.PartiallyRefunded, 16633],
    ['REFUND_PRORATED', undefined, ChargeStatus.PartiallyRefunded, 49900],
    [undefined, undefined, ChargeStatus.Refunded, 49900],
    ['FAMILY_REVOKE', undefined, ChargeStatus.Cancelled, undefined],
    ['ASSIGNMENT_REVOKE', undefined, ChargeStatus.Cancelled, undefined],
  ])('a transaction revoked with %s (%s) is %s with %s refunded', async (revocationType, revocationPercentage, status, refunded) => {
    const signed = signedTransaction({ revocationDate: NOW_MS - DAY, revocationType, revocationPercentage });
    const h = harness([get(`/inApps/v1/transactions/${TRANSACTION_ID}`, { signedTransactionInfo: signed })]);
    const result = await h.provider.getCharge(ORIGINAL_ID, TRANSACTION_ID);
    expect(result.status).toBe(status);
    expect(result.refundedAmount).toBe(refunded);
    expect(result.providerStatus).toBe(revocationType ?? 'REVOKED');
  });

  it('a free transaction is a charge of 0', async () => {
    const h = harness([get(`/inApps/v1/transactions/${TRANSACTION_ID}`, { signedTransactionInfo: signedTransaction({ price: 0, offerType: 1, offerDiscountType: 'FREE_TRIAL' }) })]);
    expect((await h.provider.getCharge(ORIGINAL_ID, TRANSACTION_ID)).amount).toBe(0);
    const none = harness([get(`/inApps/v1/transactions/${TRANSACTION_ID}`, { signedTransactionInfo: signedTransaction({ price: undefined, currency: undefined }) })]);
    expect((await none.provider.getCharge(ORIGINAL_ID, TRANSACTION_ID)).amount).toBe(0);
  });

  it('getCharge is NOT_FOUND for a transaction of another subscription or of a one-time product', async () => {
    const other = harness([get(`/inApps/v1/transactions/${TRANSACTION_ID}`, { signedTransactionInfo: signedTransaction({ originalTransactionId: '999' }) })]);
    expect((await rejection(other.provider.getCharge(ORIGINAL_ID, TRANSACTION_ID))).code).toBe(ErrorCode.NotFound);
    const coins = harness([get(`/inApps/v1/transactions/${TRANSACTION_ID}`, { signedTransactionInfo: signedTransaction({ type: 'Consumable' }) })]);
    expect((await rejection(coins.provider.getCharge(ORIGINAL_ID, TRANSACTION_ID))).code).toBe(ErrorCode.NotFound);
  });

  it('getCharge refuses an answer for another transaction than the one asked for', async () => {
    const h = harness([get(`/inApps/v1/transactions/${TRANSACTION_ID}`, { signedTransactionInfo: signedTransaction({ transactionId: '77777' }) })]);
    expect((await rejection(h.provider.getCharge(ORIGINAL_ID, TRANSACTION_ID))).code).toBe(ErrorCode.UnexpectedResponse);
  });

  it('getCharge refuses a transaction priced in another currency, naming it', async () => {
    const h = harness([get(`/inApps/v1/transactions/${TRANSACTION_ID}`, { signedTransactionInfo: signedTransaction({ currency: 'USD', price: 9990, storefront: 'USA' }) })]);
    const error = await rejection(h.provider.getCharge(ORIGINAL_ID, TRANSACTION_ID));
    expect(error.code).toBe(ErrorCode.Unsupported);
    expect(error.message).toContain('USD');
    expect(error.message).toContain('USA');
  });

  it('listCharges reads the history of auto-renewable subscriptions, filters to the subscription and answers newest first', async () => {
    const history = `/inApps/v2/history/${ORIGINAL_ID}`;
    const query = 'productType=AUTO_RENEWABLE&sort=DESCENDING';
    const h = harness([
      {
        method: 'GET',
        url: `https://api.storekit-sandbox.apple.com${history}?${query}`,
        json: {
          environment: 'Sandbox',
          bundleId: 'com.example',
          hasMore: true,
          revision: 'rev-1',
          signedTransactions: [charge({ transactionId: '1', purchaseDate: NOW_MS - 70 * DAY }), signedTransaction({ originalTransactionId: '999', transactionId: '555' })],
        },
      },
      {
        method: 'GET',
        url: `https://api.storekit-sandbox.apple.com${history}?${query}&revision=rev-1`,
        json: { hasMore: false, revision: 'rev-2', signedTransactions: [charge({ transactionId: '3', purchaseDate: NOW_MS - 10 * DAY }), charge({ transactionId: '2', purchaseDate: NOW_MS - 40 * DAY })] },
      },
    ]);
    const charges = await h.provider.listCharges(ORIGINAL_ID);
    expect(charges.map((c) => c.id)).toEqual(['3', '2', '1']);
    expect(h.remaining()).toBe(0);
    expect(h.calls.map((c) => c.method)).toEqual(['GET', 'GET']);
    expect(charges.every((c) => c.subscriptionId === ORIGINAL_ID)).toBe(true);
  });

  it('listCharges honours the limit', async () => {
    const history = `/inApps/v2/history/${ORIGINAL_ID}?productType=AUTO_RENEWABLE&sort=DESCENDING`;
    const h = harness([
      { method: 'GET', url: `https://api.storekit-sandbox.apple.com${history}`, json: { hasMore: false, signedTransactions: [charge({ transactionId: '1', purchaseDate: 1 }), charge({ transactionId: '2', purchaseDate: 2 }), charge({ transactionId: '3', purchaseDate: 3 })] } },
    ]);
    expect((await h.provider.listCharges(ORIGINAL_ID, { limit: 2 })).map((c) => c.id)).toEqual(['3', '2']);
  });

  it('listCharges finds the subscription of a transactionId, and answers nothing for an unknown one', async () => {
    const history = `/inApps/v2/history/${TRANSACTION_ID}?productType=AUTO_RENEWABLE&sort=DESCENDING`;
    const answer = { hasMore: false, signedTransactions: [signedTransaction(), charge({ transactionId: '99' })] };
    const h = harness([{ method: 'GET', url: `https://api.storekit-sandbox.apple.com${history}`, json: answer }]);
    expect((await h.provider.listCharges(TRANSACTION_ID)).map((c) => c.id).sort()).toEqual([TRANSACTION_ID, '99'].sort());
    const none = harness([{ method: 'GET', url: `https://api.storekit-sandbox.apple.com${history}`, json: { hasMore: false, signedTransactions: [] } }]);
    expect(await none.provider.listCharges(TRANSACTION_ID)).toEqual([]);
  });

  it('listCharges stops after the page limit instead of following hasMore for ever', async () => {
    const page = (n: number) => ({ method: 'GET' as const, url: /\/inApps\/v2\/history\//, json: { hasMore: true, revision: `r${n}`, signedTransactions: [] } });
    const h = harness(Array.from({ length: 12 }, (_, n) => page(n)));
    expect(await h.provider.listCharges(ORIGINAL_ID)).toEqual([]);
    expect(h.calls).toHaveLength(10);
  });

  it('listCharges refuses data that does not verify', async () => {
    const history = `/inApps/v2/history/${ORIGINAL_ID}?productType=AUTO_RENEWABLE&sort=DESCENDING`;
    const h = harness([{ method: 'GET', url: `https://api.storekit-sandbox.apple.com${history}`, json: { hasMore: false, signedTransactions: [signedTransaction({}, { signWith: 'other-leaf' })] } }]);
    expect((await rejection(h.provider.listCharges(ORIGINAL_ID))).code).toBe(ErrorCode.SignatureInvalid);
    expect((await rejection(harness().provider.listCharges(APP_ACCOUNT_TOKEN))).code).toBe(ErrorCode.Validation);
  });
});
