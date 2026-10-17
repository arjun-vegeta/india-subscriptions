import { describe, expect, it } from 'vitest';
import { ErrorCode, PaymentStatus, SubscriptionStatus } from '../../src/constants.js';
import { CheckoutVerificationSchema, PaymentSchema, PaymentVerificationSchema } from '../../src/schemas.js';
import { AppStoreResultKey } from '../../src/providers/appstore/index.js';
import {
  APP_ACCOUNT_TOKEN,
  DAY,
  NOW_MS,
  ONE_TIME_ID,
  ORIGINAL_ID,
  TRANSACTION_ID,
  decodeJws,
  get,
  harness,
  oneTimePayload,
  rejection,
  signJws,
  signedTransaction,
  statusItem,
  statusResponse,
  withPayload,
} from './helpers.js';

const KEY = AppStoreResultKey.SignedTransaction;
const SUBSCRIPTION_PATH = `/inApps/v1/subscriptions/${TRANSACTION_ID}`;
const TRANSACTION_PATH = `/inApps/v1/transactions/${ONE_TIME_ID}`;

describe('verifyCheckout', () => {
  it('uses the documented result key', () => {
    expect(KEY).toBe('signedTransaction');
  });

  it('verifies the device transaction, reads the status from the Server API and returns the store id and the token', async () => {
    const h = harness([get(SUBSCRIPTION_PATH, statusResponse([statusItem(1)]))]);
    const result = await h.provider.verifyCheckout({ [KEY]: signedTransaction() });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.url).toBe(`https://api.storekit-sandbox.apple.com${SUBSCRIPTION_PATH}`);
    expect(result).toMatchObject({
      provider: 'app_store',
      subscriptionId: ORIGINAL_ID,
      reference: APP_ACCOUNT_TOKEN,
      authorized: true,
      status: SubscriptionStatus.Active,
      charge: { id: TRANSACTION_ID, subscriptionId: ORIGINAL_ID, amount: 49900, status: 'succeeded' },
    });
    expect(CheckoutVerificationSchema.safeParse(result).success).toBe(true);
  });

  it('is authorised while trialing and not once the subscription is no longer active', async () => {
    const trial = harness([get(SUBSCRIPTION_PATH, statusResponse([statusItem(1, { offerType: 1, offerDiscountType: 'FREE_TRIAL' })]))]);
    const trialing = await trial.provider.verifyCheckout({ [KEY]: signedTransaction() });
    expect([trialing.status, trialing.authorized]).toEqual([SubscriptionStatus.Trialing, true]);
    const refunded = harness([get(SUBSCRIPTION_PATH, statusResponse([statusItem(5, { revocationDate: NOW_MS - DAY, revocationType: 'REFUND_FULL' })]))]);
    const revoked = await refunded.provider.verifyCheckout({ [KEY]: signedTransaction() });
    expect([revoked.status, revoked.authorized]).toEqual([SubscriptionStatus.Cancelled, false]);
    const retry = harness([get(SUBSCRIPTION_PATH, statusResponse([statusItem(3)]))]);
    expect((await retry.provider.verifyCheckout({ [KEY]: signedTransaction() })).authorized).toBe(false);
  });

  it('answers with the server state, not with what the device sent', async () => {
    const h = harness([get(SUBSCRIPTION_PATH, statusResponse([statusItem(2, {}, { expirationIntent: 1 })]))]);
    const result = await h.provider.verifyCheckout({ [KEY]: signedTransaction() });
    expect(result.status).toBe(SubscriptionStatus.Cancelled);
    expect(result.authorized).toBe(false);
  });

  it('returns no reference when the purchase carried no app account token', async () => {
    const h = harness([get(SUBSCRIPTION_PATH, statusResponse([statusItem(1, { appAccountToken: undefined }, { appAccountToken: undefined })]))]);
    const result = await h.provider.verifyCheckout({ [KEY]: signedTransaction({ appAccountToken: undefined }) });
    expect(result.reference).toBeUndefined();
  });

  it('is SIGNATURE_INVALID, with no call to Apple, for a transaction that does not verify', async () => {
    const good = signedTransaction();
    const bad = [
      withPayload(good, { ...decodeJws(good).payload, productId: 'com.example.free' }),
      signedTransaction({ bundleId: 'com.other' }),
      signedTransaction({ environment: 'Production' }),
      signedTransaction({}, { chain: ['other-leaf', 'other-intermediate', 'other-root'] }),
      signedTransaction({}, { chain: ['expired-leaf', 'intermediate', 'root'] }),
      'garbage',
    ];
    for (const signedTransactionText of bad) {
      const h = harness();
      expect((await rejection(h.provider.verifyCheckout({ [KEY]: signedTransactionText }))).code).toBe(ErrorCode.SignatureInvalid);
      expect(h.calls).toHaveLength(0);
    }
  });

  it('needs the signedTransaction key', async () => {
    const h = harness();
    for (const result of [{}, { [KEY]: '' }, { [KEY]: 5 }, { transaction: signedTransaction() }]) {
      const error = await rejection(h.provider.verifyCheckout(result));
      expect(error.code).toBe(ErrorCode.Validation);
      expect(error.message).toContain(KEY);
    }
  });

  it('sends one-time purchases to verifyPayment', async () => {
    const h = harness();
    const error = await rejection(h.provider.verifyCheckout({ [KEY]: signJws(oneTimePayload()) }));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(error.message).toContain('verifyPayment');
    expect(h.calls).toHaveLength(0);
  });

  it('is NOT_FOUND when Apple does not know the transaction, and PROVIDER_UNAVAILABLE for its "try again" errors', async () => {
    const notFound = harness([get(SUBSCRIPTION_PATH, { errorCode: 4040010, errorMessage: 'Transaction id not found.' }, 404)]);
    const error = await rejection(notFound.provider.verifyCheckout({ [KEY]: signedTransaction() }));
    expect([error.code, error.providerCode, error.httpStatus]).toEqual([ErrorCode.NotFound, '4040010', 404]);
    const retry = harness([get(SUBSCRIPTION_PATH, { errorCode: 4040002, errorMessage: 'Account not found. Please try again.' }, 404)]);
    const retryable = await rejection(retry.provider.verifyCheckout({ [KEY]: signedTransaction() }));
    expect(retryable.code).toBe(ErrorCode.ProviderUnavailable);
  });

  it("returns the purchase's own token as the reference, so the facade can compare it with the order's", async () => {
    const other = '11111111-1111-4111-8111-111111111111';
    const h = harness([get(SUBSCRIPTION_PATH, statusResponse([statusItem(1)]))]);
    const result = await h.provider.verifyCheckout({ [KEY]: signedTransaction({ appAccountToken: other }) });
    expect(result.reference).toBe(other);
    expect(result.reference).not.toBe(APP_ACCOUNT_TOKEN);
  });
});

describe('verifyPayment', () => {
  const device = () => signJws(oneTimePayload());

  it('verifies the device transaction, reads it from the Server API and returns the transaction id and the token', async () => {
    const h = harness([get(TRANSACTION_PATH, { signedTransactionInfo: device() })]);
    const result = await h.provider.verifyPayment({ [KEY]: device() });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.url).toBe(`https://api.storekit-sandbox.apple.com${TRANSACTION_PATH}`);
    expect(result).toMatchObject({
      provider: 'app_store',
      paymentId: ONE_TIME_ID,
      reference: APP_ACCOUNT_TOKEN,
      paid: true,
      status: PaymentStatus.Succeeded,
      payment: { id: ONE_TIME_ID, amount: 9900, currency: 'INR', status: 'succeeded', providerStatus: 'PURCHASED' },
    });
    expect(PaymentVerificationSchema.safeParse(result).success).toBe(true);
    expect(PaymentSchema.safeParse(result.payment).success).toBe(true);
  });

  it('is not paid when the server says the transaction was refunded', async () => {
    const refunded = signJws(oneTimePayload({ revocationDate: NOW_MS - DAY, revocationType: 'REFUND_FULL' }));
    const h = harness([get(TRANSACTION_PATH, { signedTransactionInfo: refunded })]);
    const result = await h.provider.verifyPayment({ [KEY]: device() });
    expect([result.paid, result.status, result.payment?.refundedAmount]).toEqual([false, PaymentStatus.Refunded, 9900]);
  });

  it('is SIGNATURE_INVALID, with no call to Apple, for data that does not verify', async () => {
    const h = harness();
    const tampered = withPayload(device(), { ...decodeJws(device()).payload, price: 1 });
    expect((await rejection(h.provider.verifyPayment({ [KEY]: tampered }))).code).toBe(ErrorCode.SignatureInvalid);
    expect((await rejection(h.provider.verifyPayment({ [KEY]: signJws(oneTimePayload({ bundleId: 'com.other' })) }))).code).toBe(ErrorCode.SignatureInvalid);
    expect(h.calls).toHaveLength(0);
  });

  it('is SIGNATURE_INVALID when the server answer does not verify', async () => {
    const h = harness([get(TRANSACTION_PATH, { signedTransactionInfo: signJws(oneTimePayload(), { signWith: 'other-leaf' }) })]);
    expect((await rejection(h.provider.verifyPayment({ [KEY]: device() }))).code).toBe(ErrorCode.SignatureInvalid);
  });

  it('sends subscriptions to verifyCheckout', async () => {
    const h = harness();
    const error = await rejection(h.provider.verifyPayment({ [KEY]: signedTransaction() }));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(error.message).toContain('verifyCheckout');
  });

  it('refuses a purchase priced in another currency instead of stating a wrong amount', async () => {
    const usd = signJws(oneTimePayload({ currency: 'USD', price: 990, storefront: 'USA' }));
    const h = harness([get(TRANSACTION_PATH, { signedTransactionInfo: usd })]);
    const error = await rejection(h.provider.verifyPayment({ [KEY]: usd }));
    expect(error.code).toBe(ErrorCode.Unsupported);
    expect(error.message).toContain('USD');
  });

  it('needs the signedTransaction key', async () => {
    expect((await rejection(harness().provider.verifyPayment({}))).code).toBe(ErrorCode.Validation);
  });
});

describe('getPayment', () => {
  it('reads the transaction by id', async () => {
    const h = harness([get(TRANSACTION_PATH, { signedTransactionInfo: signJws(oneTimePayload()) })]);
    const payment = await h.provider.getPayment(ONE_TIME_ID);
    expect(h.calls[0]?.method).toBe('GET');
    expect(payment).toMatchObject({ id: ONE_TIME_ID, amount: 9900, currency: 'INR', status: 'succeeded', reference: APP_ACCOUNT_TOKEN });
    expect(payment.paidAt).toBe(new Date(NOW_MS - 10 * DAY).toISOString());
  });

  it.each([
    ['REFUND_FULL', undefined, PaymentStatus.Refunded, 9900],
    ['REFUND_PRORATED', 25_000, PaymentStatus.PartiallyRefunded, 2475],
    ['FAMILY_REVOKE', undefined, PaymentStatus.Cancelled, undefined],
  ])('maps a transaction revoked with %s to %s', async (revocationType, revocationPercentage, status, refunded) => {
    const signed = signJws(oneTimePayload({ revocationDate: NOW_MS - DAY, revocationType, revocationPercentage }));
    const h = harness([get(TRANSACTION_PATH, { signedTransactionInfo: signed })]);
    const payment = await h.provider.getPayment(ONE_TIME_ID);
    expect([payment.status, payment.refundedAmount, payment.providerStatus]).toEqual([status, refunded, revocationType]);
  });

  it('refuses the app account token and subscription transactions', async () => {
    expect((await rejection(harness().provider.getPayment(APP_ACCOUNT_TOKEN))).code).toBe(ErrorCode.Validation);
    const h = harness([get(`/inApps/v1/transactions/${TRANSACTION_ID}`, { signedTransactionInfo: signedTransaction() })]);
    const error = await rejection(h.provider.getPayment(TRANSACTION_ID));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(error.message).toContain('getCharge');
  });

  it('maps Apple HTTP errors, by status and by errorCode, to the library codes', async () => {
    const table: [number, Record<string, unknown> | undefined, string][] = [
      [400, { errorCode: 4000006, errorMessage: 'Invalid transaction id.' }, ErrorCode.Validation],
      [401, undefined, ErrorCode.Auth],
      [404, { errorCode: 4040010, errorMessage: 'Transaction id not found.' }, ErrorCode.NotFound],
      [404, { errorCode: 4040003, errorMessage: 'App not found.' }, ErrorCode.Config],
      [404, { errorCode: 4040004, errorMessage: 'App not found. Please try again.' }, ErrorCode.ProviderUnavailable],
      [404, { errorCode: 4040006, errorMessage: 'Original transaction id not found. Please try again.' }, ErrorCode.ProviderUnavailable],
      [429, { errorCode: 4290000, errorMessage: 'Rate limit exceeded.' }, ErrorCode.RateLimited],
      [500, { errorCode: 5000000, errorMessage: 'An unknown error occurred.' }, ErrorCode.ProviderUnavailable],
      [500, { errorCode: 5000001, errorMessage: 'An unknown error occurred. Please try again.' }, ErrorCode.ProviderUnavailable],
    ];
    for (const [status, body, code] of table) {
      const h = harness([get(TRANSACTION_PATH, body ?? { error: 'x' }, status)]);
      const error = await rejection(h.provider.getPayment(ONE_TIME_ID));
      expect([status, error.code]).toEqual([status, code]);
      if (body) expect(error.providerCode).toBe(String(body.errorCode));
    }
  });

  it("keeps Apple's own message and tells the caller what to check", async () => {
    const h = harness([get(TRANSACTION_PATH, { errorCode: 4040003, errorMessage: 'App not found.' }, 404)]);
    expect((await rejection(h.provider.getPayment(ONE_TIME_ID))).message).toContain('check bundleId');
    const auth = harness([get(TRANSACTION_PATH, {}, 401)]);
    expect((await rejection(auth.provider.getPayment(ONE_TIME_ID))).message).toContain('issuerId');
  });
});
