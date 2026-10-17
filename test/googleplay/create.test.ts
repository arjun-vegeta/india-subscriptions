import { describe, expect, it } from 'vitest';
import { ErrorCode, PaymentStatus, Provider, ProviderKind, SchedulingMode, SubscriptionStatus } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import { CheckoutInstructionSchema, CapabilitiesSchema, PaymentSchema, SubscriptionSchema } from '../../src/schemas.js';
import { googlePlay, GooglePlayConfigSchema } from '../../src/providers/googleplay/index.js';
import { SERVICE_PRIVATE_PEM, baseConfig, makeProvider, PUSH_AUDIENCE, PUSH_EMAIL } from './helpers.js';

const ACCOUNT_ID = '11111111-2222-4333-8444-555555555555';
const customer = { email: 'asha@example.com', state: 'Karnataka' };
const subscriptionInput = {
  plan: 'premium',
  customer,
  reference: 'order-77',
  storeProduct: { productId: 'premium_monthly_v2', basePlanId: 'premium-monthly', offerId: 'intro-offer-7day' },
};

describe('config', () => {
  it('requires the package name, service account and environment', () => {
    const result = GooglePlayConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects a package name that is not an Android package name', () => {
    expect(() => googlePlay(baseConfig({ packageName: 'not a package' }))).toThrowError(/packageName/);
  });

  it('rejects a private key that is not PEM, without echoing it', () => {
    let error: unknown;
    try {
      googlePlay(baseConfig({ privateKey: 'super-secret-not-a-pem-key' }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SubscriptionError);
    expect(error).toMatchObject({ code: ErrorCode.Config });
    expect((error as Error).message).not.toContain('super-secret');
  });

  it('push authentication is all or nothing', () => {
    expect(() => googlePlay(baseConfig({ pushAudience: PUSH_AUDIENCE }))).toThrowError(/go together/);
    expect(() => googlePlay(baseConfig({ pushServiceAccountEmail: PUSH_EMAIL }))).toThrowError(/go together/);
    expect(() => googlePlay(baseConfig({ pushAudience: PUSH_AUDIENCE, pushServiceAccountEmail: PUSH_EMAIL }))).not.toThrow();
  });

  it('defaults: unauthenticated webhooks refused, refunds revoke, no consumable ids', () => {
    const parsed = GooglePlayConfigSchema.parse(baseConfig());
    expect(parsed).toMatchObject({ acceptUnauthenticatedWebhooks: false, revokeOnRefund: true, consumableProductIds: [] });
    expect(parsed.privateKey).toBe(SERVICE_PRIVATE_PEM);
  });

  it('building the provider makes no network call', () => {
    const t = makeProvider([], { tokens: 0 });
    expect(t.calls).toHaveLength(0);
  });
});

describe('capabilities', () => {
  const { capabilities } = makeProvider([], { tokens: 0 }).provider;

  it('describe a store that stops renewals, refunds whole orders and cannot do the rest', () => {
    expect(CapabilitiesSchema.parse(capabilities)).toEqual(capabilities);
    expect(capabilities).toMatchObject({
      provider: Provider.GooglePlay,
      kind: ProviderKind.Store,
      scheduling: [SchedulingMode.Gateway],
      cancel: true,
      cancelAtPeriodEnd: true,
      refunds: true,
      listCharges: false,
      trial: false,
      upfrontAmount: false,
      quantity: false,
      pause: false,
      resume: false,
      changePlan: false,
      merchantCharges: false,
      merchantPreDebitNotification: false,
      signedWebhooks: true,
      oneTimePayments: true,
      paymentMethods: [],
      oneTimePaymentMethods: [],
    });
  });

  it('pause, resume, update and merchant charges answer UNSUPPORTED', async () => {
    const { provider } = makeProvider([], { tokens: 0 });
    for (const call of [
      () => provider.pauseSubscription('t'),
      () => provider.resumeSubscription('t'),
      () => provider.updateSubscription('t', { quantity: 2 }),
      () => provider.createCharge({ subscriptionId: 't', chargeId: 'c', amount: 100 }),
      () => provider.notifyCharge({ subscriptionId: 't', notificationId: 'n', amount: 100, debitAt: '2026-12-01T00:00:00Z' }),
      () => provider.createPlan({ name: 'x', amount: 100, interval: { unit: 'month', count: 1 } }),
      () => provider.listCharges('t'),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: ErrorCode.Unsupported });
    }
  });
});

describe('createSubscription: no purchase, no call', () => {
  it('returns status created with the account id and the google_play_billing checkout', async () => {
    const t = makeProvider([], { tokens: 0 });
    const subscription = await t.provider.createSubscription(subscriptionInput);
    expect(t.calls).toHaveLength(0);
    expect(SubscriptionSchema.parse(subscription)).toBeTruthy();
    expect(subscription).toMatchObject({
      provider: 'google_play',
      id: ACCOUNT_ID,
      reference: 'order-77',
      status: SubscriptionStatus.Created,
      providerStatus: 'not_purchased',
      scheduling: 'gateway',
      planId: 'premium_monthly_v2:premium-monthly',
      checkout: {
        kind: 'google_play_billing',
        productKind: 'subscription',
        productId: 'premium_monthly_v2',
        basePlanId: 'premium-monthly',
        offerId: 'intro-offer-7day',
        obfuscatedAccountId: ACCOUNT_ID,
        userChoiceBilling: false,
      },
    });
    expect(CheckoutInstructionSchema.parse(subscription.checkout)).toBeTruthy();
  });

  it('mints a fresh UUID each time by default', async () => {
    const { provider } = makeProvider([], { tokens: 0, options: { generateId: undefined } });
    const a = await provider.createSubscription(subscriptionInput);
    const b = await provider.createSubscription(subscriptionInput);
    expect(a.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a.id).not.toBe(b.id);
    expect((a.checkout as { obfuscatedAccountId: string }).obfuscatedAccountId).toBe(a.id);
  });

  it('needs a store product with a base plan', async () => {
    const { provider } = makeProvider([], { tokens: 0 });
    await expect(provider.createSubscription({ plan: 'p', customer })).rejects.toMatchObject({ code: ErrorCode.Validation });
    await expect(provider.createSubscription({ plan: 'p', customer, storeProduct: { productId: 'x' } })).rejects.toThrowError(/basePlanId/);
  });

  const refused: Array<[string, Record<string, unknown>, RegExp]> = [
    ['a trial', { trial: { days: 7 } }, /offer on the base plan/],
    ['a start date', { startAt: '2026-12-01T00:00:00Z' }, /starts when the customer buys/],
    ['an upfront amount', { upfrontAmount: 100 }, /price of the base plan/],
    ['a quantity', { quantity: 3 }, /one unit/],
    ['a cycle count', { totalCycles: 12 }, /renews until it is cancelled/],
    ['payment methods', { paymentMethods: ['upi'] }, /payment methods on their account/],
    ['a mandate end', { mandateEndsAt: '2027-12-01T00:00:00Z' }, /no mandate/],
    ['an authorisation deadline', { authorizeBy: '2026-12-01T00:00:00Z' }, /pending/],
  ];
  it.each(refused)('refuses %s and says what Google Play does instead', async (_what, extra, instead) => {
    const t = makeProvider([], { tokens: 0 });
    const error = await t.provider.createSubscription({ ...subscriptionInput, ...extra } as never).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: ErrorCode.Unsupported });
    expect((error as Error).message).toMatch(instead);
    expect(t.calls).toHaveLength(0);
  });

  it('accepts a quantity of 1', async () => {
    const { provider } = makeProvider([], { tokens: 0 });
    await expect(provider.createSubscription({ ...subscriptionInput, quantity: 1 })).resolves.toMatchObject({ status: 'created' });
  });
});

describe('createPayment: no purchase, no call', () => {
  const paymentInput = { reference: 'p-1', amount: 9900, customer, storeProduct: { productId: 'coins_100', consumable: true } };

  it('returns status created with the account id and a one_time checkout', async () => {
    const t = makeProvider([], { tokens: 0 });
    const payment = await t.provider.createPayment(paymentInput);
    expect(t.calls).toHaveLength(0);
    expect(PaymentSchema.parse(payment)).toBeTruthy();
    expect(payment).toMatchObject({
      id: ACCOUNT_ID,
      status: PaymentStatus.Created,
      amount: 9900,
      currency: 'INR',
      checkout: { kind: 'google_play_billing', productKind: 'one_time', productId: 'coins_100', obfuscatedAccountId: ACCOUNT_ID, userChoiceBilling: false },
    });
    expect((payment.checkout as Record<string, unknown>).basePlanId).toBeUndefined();
  });

  it('needs a store product, and refuses payment methods and an expiry', async () => {
    const { provider } = makeProvider([], { tokens: 0 });
    await expect(provider.createPayment({ amount: 100, customer })).rejects.toMatchObject({ code: ErrorCode.Validation });
    await expect(provider.createPayment({ ...paymentInput, paymentMethods: ['upi'] })).rejects.toMatchObject({ code: ErrorCode.Unsupported });
    await expect(provider.createPayment({ ...paymentInput, expiresAt: '2026-12-01T00:00:00Z' })).rejects.toMatchObject({ code: ErrorCode.Unsupported });
  });
});
