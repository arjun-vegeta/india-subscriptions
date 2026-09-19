import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ErrorCode } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import { CheckoutVerificationSchema } from '../../src/schemas.js';
import { RAZORPAY_EXPECTED_SUBSCRIPTION_ID_KEY } from '../../src/providers/razorpay/constants.js';
import { razorpay } from '../../src/providers/razorpay/index.js';
import { mockFetch } from '../helpers/mock-fetch.js';

/*
 * verifyCheckout tests. The formula is from the Razorpay integration guide
 * (payments__subscriptions__integration-guide.md, "Verify payment signature"):
 *   generated_signature = hmac_sha256(razorpay_payment_id + "|" + subscription_id, secret)
 * with the API key secret, hex digest. The expected values below are computed
 * here with node:crypto, independently of the adapter. The ids are the
 * placeholder ids used throughout the docs.
 */

const KEY_ID = 'test_key_id';
const KEY_SECRET = 'test_key_secret_value';
const WEBHOOK_SECRET = 'test_webhook_secret_value';
const PAYMENT_ID = 'pay_29QQoUBi66xm2f';
const SUBSCRIPTION_ID = 'sub_00000000000001';

const hmac = (message: string, secret = KEY_SECRET) => createHmac('sha256', secret).update(message, 'utf8').digest('hex');
const validSignature = () => hmac(`${PAYMENT_ID}|${SUBSCRIPTION_ID}`);

const provider = () =>
  razorpay({ keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET }, { fetch: mockFetch([]).fetch });

const handlerResponse = (overrides: Record<string, unknown> = {}) => ({
  razorpay_payment_id: PAYMENT_ID,
  razorpay_subscription_id: SUBSCRIPTION_ID,
  razorpay_signature: validSignature(),
  ...overrides,
});

async function failure(run: () => Promise<unknown>): Promise<SubscriptionError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(SubscriptionError);
    return error as SubscriptionError;
  }
  throw new Error('expected the call to reject');
}

describe('verifyCheckout', () => {
  it('accepts a correctly signed checkout response', async () => {
    const result = handlerResponse();
    const verification = await provider().verifyCheckout(result);
    expect(verification).toMatchObject({ provider: 'razorpay', subscriptionId: SUBSCRIPTION_ID, authorized: true });
    expect(verification.raw).toEqual(result);
    expect(CheckoutVerificationSchema.safeParse(verification).success).toBe(true);
  });

  it('uses payment id first, then subscription id, joined by a pipe (the reverse of the order formula)', async () => {
    expect(validSignature()).toBe(hmac(`${PAYMENT_ID}|${SUBSCRIPTION_ID}`));
    const reversed = handlerResponse({ razorpay_signature: hmac(`${SUBSCRIPTION_ID}|${PAYMENT_ID}`) });
    expect((await failure(() => provider().verifyCheckout(reversed))).code).toBe(ErrorCode.SignatureInvalid);
  });

  it('is SIGNATURE_INVALID for a wrong signature, one changed character, a signature in upper case, or the wrong secret', async () => {
    const real = validSignature();
    const flipped = `${real.slice(0, -1)}${real.endsWith('0') ? '1' : '0'}`;
    for (const razorpay_signature of ['deadbeef', flipped, real.toUpperCase(), hmac(`${PAYMENT_ID}|${SUBSCRIPTION_ID}`, WEBHOOK_SECRET)]) {
      const error = await failure(() => provider().verifyCheckout(handlerResponse({ razorpay_signature })));
      expect(error.code).toBe(ErrorCode.SignatureInvalid);
    }
  });

  it('is SIGNATURE_INVALID when the payment id or the subscription id was altered after signing', async () => {
    const swappedPayment = handlerResponse({ razorpay_payment_id: 'pay_attacker000001' });
    const swappedSubscription = handlerResponse({ razorpay_subscription_id: 'sub_attacker000001' });
    for (const result of [swappedPayment, swappedSubscription]) {
      expect((await failure(() => provider().verifyCheckout(result))).code).toBe(ErrorCode.SignatureInvalid);
    }
  });

  it.each(['razorpay_payment_id', 'razorpay_subscription_id', 'razorpay_signature'])('is VALIDATION when %s is missing, empty or not a string', async (field) => {
    for (const bad of [undefined, '', 12345, null]) {
      const result = handlerResponse({ [field]: bad });
      const error = await failure(() => provider().verifyCheckout(result));
      expect(error.code).toBe(ErrorCode.Validation);
      expect(error.message).toContain(field);
    }
    const missing: Record<string, unknown> = handlerResponse();
    delete missing[field];
    expect((await failure(() => provider().verifyCheckout(missing))).code).toBe(ErrorCode.Validation);
  });

  it('is VALIDATION for an empty result object', async () => {
    expect((await failure(() => provider().verifyCheckout({}))).code).toBe(ErrorCode.Validation);
  });

  it('ignores extra fields the checkout adds', async () => {
    const verification = await provider().verifyCheckout(handlerResponse({ razorpay_order_id: 'order_x', other: 1 }));
    expect(verification.authorized).toBe(true);
  });

  describe('expected_subscription_id (the id from your own storage)', () => {
    it('verifies against the stored id and returns it', async () => {
      const verification = await provider().verifyCheckout(handlerResponse({ [RAZORPAY_EXPECTED_SUBSCRIPTION_ID_KEY]: SUBSCRIPTION_ID }));
      expect(verification.subscriptionId).toBe(SUBSCRIPTION_ID);
    });

    it('rejects a genuine payment for a different subscription than the one you stored', async () => {
      // Razorpay signed pay_x|sub_other for another customer's subscription; the merchant expects sub_1.
      const otherSubscription = 'sub_other0000001';
      const result = {
        razorpay_payment_id: PAYMENT_ID,
        razorpay_subscription_id: otherSubscription,
        razorpay_signature: hmac(`${PAYMENT_ID}|${otherSubscription}`),
        [RAZORPAY_EXPECTED_SUBSCRIPTION_ID_KEY]: SUBSCRIPTION_ID,
      };
      expect((await failure(() => provider().verifyCheckout(result))).code).toBe(ErrorCode.SignatureInvalid);
      // Without the stored id the same response verifies: the caller must then compare subscriptionId itself.
      const { [RAZORPAY_EXPECTED_SUBSCRIPTION_ID_KEY]: _dropped, ...withoutExpected } = result;
      expect((await provider().verifyCheckout(withoutExpected)).subscriptionId).toBe(otherSubscription);
    });

    it('is VALIDATION when it is not a non-empty string', async () => {
      for (const bad of [123, '', null]) {
        const error = await failure(() => provider().verifyCheckout(handlerResponse({ [RAZORPAY_EXPECTED_SUBSCRIPTION_ID_KEY]: bad })));
        expect(error.code).toBe(ErrorCode.Validation);
      }
    });
  });

  it('never puts a secret or the expected signature in an error', async () => {
    const errors = [
      await failure(() => provider().verifyCheckout(handlerResponse({ razorpay_signature: 'deadbeef' }))),
      await failure(() => provider().verifyCheckout(handlerResponse({ razorpay_signature: undefined }))),
      await failure(() => provider().verifyCheckout({})),
    ];
    for (const error of errors) {
      const everything = JSON.stringify({ message: error.message, json: error.toJSON(), raw: error.raw, stack: error.stack });
      expect(everything).not.toContain(KEY_SECRET);
      expect(everything).not.toContain(WEBHOOK_SECRET);
      expect(everything).not.toContain(validSignature());
    }
  });
});
