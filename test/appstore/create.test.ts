import { describe, expect, it } from 'vitest';
import { CheckoutKind, ErrorCode, PaymentStatus, SchedulingMode, SubscriptionStatus } from '../../src/constants.js';
import {
  AppleStoreKitCheckoutSchema,
  PaymentSchema,
  SubscriptionSchema,
} from '../../src/schemas.js';
import {
  FIXED_NONCE,
  FIXED_TOKEN,
  NOW,
  NOW_MS,
  OFFER_KEY_ID,
  OFFER_P8,
  BUNDLE_ID,
  harness,
  rejection,
  verifyDerSignature,
} from './helpers.js';

const CUSTOMER = { name: 'Asha Rao', email: 'asha@example.com' };
const PLAN = 'com.example.pro.monthly';
const SUBSCRIPTION = { plan: PLAN, customer: CUSTOMER, storeProduct: { productId: 'com.example.pro.monthly' } };
const PAYMENT = { amount: 9900, customer: CUSTOMER, storeProduct: { productId: 'com.example.coins', consumable: true } };

describe('createSubscription', () => {
  it('makes no call: it mints the token and returns a created subscription with a StoreKit checkout', async () => {
    const h = harness();
    const subscription = await h.provider.createSubscription({ ...SUBSCRIPTION, reference: 'order_1', metadata: { plan: 'pro' } });
    expect(h.calls).toHaveLength(0);
    expect(subscription).toEqual({
      provider: 'app_store',
      id: FIXED_TOKEN,
      reference: 'order_1',
      planId: 'com.example.pro.monthly',
      status: SubscriptionStatus.Created,
      providerStatus: 'not_purchased',
      scheduling: SchedulingMode.Gateway,
      customer: CUSTOMER,
      createdAt: NOW.toISOString(),
      checkout: { kind: CheckoutKind.AppleStoreKit, productId: 'com.example.pro.monthly', appAccountToken: FIXED_TOKEN },
      metadata: { plan: 'pro' },
    });
    expect(SubscriptionSchema.safeParse(subscription).success).toBe(true);
    expect(AppleStoreKitCheckoutSchema.safeParse(subscription.checkout).success).toBe(true);
  });

  it('mints a new random UUID for each subscription', async () => {
    const h = harness([], {}, { generateToken: undefined });
    const a = await h.provider.createSubscription(SUBSCRIPTION);
    const b = await h.provider.createSubscription(SUBSCRIPTION);
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('needs storeProduct, and refuses a Google Play base plan', async () => {
    const h = harness();
    const missing = await rejection(h.provider.createSubscription({ plan: PLAN, customer: CUSTOMER }));
    expect(missing.code).toBe(ErrorCode.Validation);
    expect(missing.message).toContain('storeProduct');
    const basePlan = await rejection(h.provider.createSubscription({ ...SUBSCRIPTION, storeProduct: { productId: 'p', basePlanId: 'monthly' } }));
    expect(basePlan.code).toBe(ErrorCode.Validation);
    expect(basePlan.message).toContain('Google Play');
    expect((await rejection(h.provider.createSubscription({ ...SUBSCRIPTION, storeProduct: { productId: '' } }))).code).toBe(ErrorCode.Validation);
  });

  it.each([
    ['trial', { trial: { days: 7 } }, 'introductory offer'],
    ['startAt', { startAt: '2027-01-01T00:00:00Z' }, 'introductory offer'],
    ['upfrontAmount', { upfrontAmount: 100 }, 'App Store Connect'],
    ['quantity', { quantity: 2 }, 'one at a time'],
    ['totalCycles', { totalCycles: 12 }, 'until the customer cancels'],
    ['paymentMethods', { paymentMethods: ['upi'] }, 'Apple Account'],
    ['mandateEndsAt', { startAt: undefined, mandateEndsAt: '2027-01-01T00:00:00Z' }, 'no mandate'],
    ['authorizeBy', { authorizeBy: '2027-01-01T00:00:00Z' }, 'no deadline'],
  ])('refuses %s as UNSUPPORTED, saying what the store does instead', async (field, extra, instead) => {
    const h = harness();
    const error = await rejection(h.provider.createSubscription({ ...SUBSCRIPTION, ...extra } as never));
    expect(error.code).toBe(ErrorCode.Unsupported);
    expect(error.message).toContain(field);
    expect(error.message).toContain(instead);
    expect(h.calls).toHaveLength(0);
  });

  it('accepts quantity 1, and the ignorable fields', async () => {
    const h = harness();
    const subscription = await h.provider.createSubscription({
      ...SUBSCRIPTION,
      quantity: 1,
      notifyCustomer: true,
      returnUrl: 'https://merchant.example/back',
      idempotencyKey: 'k1',
    });
    expect(subscription.id).toBe(FIXED_TOKEN);
  });

  it('reads no price from an inline plan, and refuses what its cycles or scheduling ask of the store', async () => {
    const h = harness();
    const inline = { name: 'Pro', amount: 49900, interval: { unit: 'month', count: 1 } } as const;
    const ok = await h.provider.createSubscription({ ...SUBSCRIPTION, plan: inline });
    expect(ok.planId).toBe('com.example.pro.monthly');
    const cycles = await rejection(h.provider.createSubscription({ ...SUBSCRIPTION, plan: { ...inline, maxCycles: 12 } }));
    expect(cycles.code).toBe(ErrorCode.Unsupported);
    const merchant = await rejection(h.provider.createSubscription({ ...SUBSCRIPTION, plan: { ...inline, scheduling: SchedulingMode.Merchant } }));
    expect(merchant.code).toBe(ErrorCode.Unsupported);
  });

  it('validates the input before anything else', async () => {
    const h = harness();
    expect((await rejection(h.provider.createSubscription({ customer: CUSTOMER } as never))).code).toBe(ErrorCode.Validation);
    expect((await rejection(h.provider.createSubscription({ ...SUBSCRIPTION, customer: { email: 'not-an-email' } }))).code).toBe(ErrorCode.Validation);
  });
});

describe('promotional offers', () => {
  const offered = { ...SUBSCRIPTION, storeProduct: { productId: 'com.example.pro.monthly', offerId: 'winback_50' } };
  const withKey = { promotionalOfferKey: { keyId: OFFER_KEY_ID, privateKey: OFFER_P8 } };

  it('signs the offer, as Apple documents: parts joined with U+2063, ECDSA SHA-256, DER, Base64', async () => {
    const h = harness([], withKey);
    const subscription = await h.provider.createSubscription(offered);
    expect(h.calls).toHaveLength(0);
    const checkout = AppleStoreKitCheckoutSchema.parse(subscription.checkout);
    const offer = checkout.promotionalOffer;
    expect(offer).toMatchObject({ offerId: 'winback_50', keyId: OFFER_KEY_ID, nonce: FIXED_NONCE, timestamp: NOW_MS });
    const text = [BUNDLE_ID, OFFER_KEY_ID, 'com.example.pro.monthly', 'winback_50', FIXED_TOKEN, FIXED_NONCE, String(NOW_MS)].join('⁣');
    expect(verifyDerSignature(OFFER_P8, text, offer?.signature as string)).toBe(true);
    // A signature over different parts does not verify: the checker is not vacuous.
    expect(verifyDerSignature(OFFER_P8, text.replace('winback_50', 'other'), offer?.signature as string)).toBe(false);
    // The signature is DER, not the raw r||s of a JWS.
    expect(Buffer.from(offer?.signature as string, 'base64')[0]).toBe(0x30);
  });

  it('writes the token and the nonce in lower case into the signed text', async () => {
    const h = harness([], withKey, { generateToken: () => FIXED_TOKEN.toUpperCase(), generateNonce: () => FIXED_NONCE.toUpperCase() });
    const subscription = await h.provider.createSubscription(offered);
    const offer = AppleStoreKitCheckoutSchema.parse(subscription.checkout).promotionalOffer;
    expect(offer?.nonce).toBe(FIXED_NONCE);
    const text = [BUNDLE_ID, OFFER_KEY_ID, 'com.example.pro.monthly', 'winback_50', FIXED_TOKEN, FIXED_NONCE, String(NOW_MS)].join('⁣');
    expect(verifyDerSignature(OFFER_P8, text, offer?.signature as string)).toBe(true);
  });

  it('makes a new nonce for every signature', async () => {
    const h = harness([], withKey, { generateNonce: undefined });
    const a = AppleStoreKitCheckoutSchema.parse((await h.provider.createSubscription(offered)).checkout).promotionalOffer;
    const b = AppleStoreKitCheckoutSchema.parse((await h.provider.createSubscription(offered)).checkout).promotionalOffer;
    expect(a?.nonce).not.toBe(b?.nonce);
  });

  it('needs the promotional offer key in the config', async () => {
    const error = await rejection(harness().provider.createSubscription(offered));
    expect(error.code).toBe(ErrorCode.Config);
    expect(error.message).toContain('promotionalOfferKey');
  });

  it('refuses an offer on a one-time purchase', async () => {
    const error = await rejection(harness([], withKey).provider.createPayment({ ...PAYMENT, storeProduct: { productId: 'com.example.coins', offerId: 'x' } }));
    expect(error.code).toBe(ErrorCode.Unsupported);
    expect(error.message).toContain('offer code');
  });
});

describe('createPayment', () => {
  it('makes no call: it mints the token and returns a created payment with a StoreKit checkout', async () => {
    const h = harness();
    const payment = await h.provider.createPayment({ ...PAYMENT, reference: 'order_9', description: 'Coins' });
    expect(h.calls).toHaveLength(0);
    expect(payment).toEqual({
      provider: 'app_store',
      id: FIXED_TOKEN,
      reference: 'order_9',
      status: PaymentStatus.Created,
      providerStatus: 'not_purchased',
      amount: 9900,
      customer: CUSTOMER,
      createdAt: NOW.toISOString(),
      checkout: { kind: CheckoutKind.AppleStoreKit, productId: 'com.example.coins', appAccountToken: FIXED_TOKEN },
    });
    expect(PaymentSchema.safeParse(payment).success).toBe(true);
  });

  it('needs storeProduct', async () => {
    const error = await rejection(harness().provider.createPayment({ amount: 100, customer: CUSTOMER }));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(error.message).toContain('storeProduct');
  });

  it.each([
    ['paymentMethods', { paymentMethods: ['wallet'] }],
    ['expiresAt', { expiresAt: '2027-01-01T00:00:00Z' }],
  ])('refuses %s as UNSUPPORTED', async (field, extra) => {
    const error = await rejection(harness().provider.createPayment({ ...PAYMENT, ...extra } as never));
    expect(error.code).toBe(ErrorCode.Unsupported);
    expect(error.message).toContain(field);
  });
});
