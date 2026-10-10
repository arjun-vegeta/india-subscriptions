import { describe, expect, it } from 'vitest';
import { ErrorCode, PaymentMethod, Provider, ProductKind } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import { RouteExclusion, RouteOutcomeKind, RouteOutcomeResult } from '../../src/routing/index.js';
import { ALL_GATEWAYS, GATEWAYS, PAYMENT, STORES, SUBSCRIPTION, caps, makeRouter } from './helpers.js';

const MANDATE_CEILING = 1_500_000; // Rs 15,000 in paise: the usual per-debit ceiling without extra authentication

async function exclusionsOf(router: ReturnType<typeof makeRouter>['router'], request: Parameters<typeof router.route>[0]) {
  const decision = await router.route(request);
  return Object.fromEntries(decision.candidates.map((candidate) => [candidate.provider, candidate.exclusions]));
}

describe('hard filters, one at a time', () => {
  it('excludes a gateway without one-time payments for a one-time request', async () => {
    const { router } = makeRouter();
    const exclusions = await exclusionsOf(router, PAYMENT);
    expect(exclusions[Provider.PhonePe]).toEqual([RouteExclusion.WrongProductKind]);
    expect(exclusions[Provider.Razorpay]).toEqual([]);
  });

  it('does not apply the product kind filter to subscriptions', async () => {
    const { router } = makeRouter();
    const exclusions = await exclusionsOf(router, SUBSCRIPTION);
    expect(exclusions[Provider.PhonePe]).toEqual([]);
  });

  it('excludes gateways that lack a needed capability', async () => {
    const { router } = makeRouter();
    const decision = await router.route({ ...SUBSCRIPTION, needs: { cancelAtPeriodEnd: true } });
    expect(decision.ranked).toEqual([Provider.Razorpay]);
    const cashfree = decision.candidates.find((c) => c.provider === Provider.Cashfree);
    expect(cashfree).toMatchObject({ eligible: false, exclusions: [RouteExclusion.MissingCapability] });
    expect(cashfree?.details?.[0]).toContain('cancelAtPeriodEnd');
  });

  it.each([
    ['trial', 'trial'],
    ['upfrontAmount', 'upfrontAmount'],
    ['quantity', 'quantity'],
    ['pause', 'pause'],
    ['cancelAtPeriodEnd', 'cancelAtPeriodEnd'],
    ['changePlan', 'changePlan'],
    ['refunds', 'refunds'],
  ] as const)('checks the %s capability', async (need, field) => {
    const { router } = makeRouter({
      capabilities: [caps(Provider.Razorpay, { [field]: true }), caps(Provider.Cashfree, { [field]: false })],
    });
    const decision = await router.route({ ...SUBSCRIPTION, needs: { [need]: true } });
    expect(decision.ranked).toEqual([Provider.Razorpay]);
  });

  it('treats a needs flag set to false as not needed', async () => {
    const { router } = makeRouter();
    const decision = await router.route({ ...SUBSCRIPTION, needs: { pause: false, quantity: false } });
    expect(decision.ranked).toHaveLength(ALL_GATEWAYS.length);
  });

  it('lists every missing capability in one exclusion', async () => {
    const { router } = makeRouter();
    const decision = await router.route({ ...SUBSCRIPTION, needs: { quantity: true, pause: true } });
    const paytm = decision.candidates.find((c) => c.provider === Provider.Paytm);
    expect(paytm?.exclusions).toEqual([RouteExclusion.MissingCapability]);
    expect(paytm?.details?.[0]).toMatch(/quantity/);
    expect(paytm?.details?.[0]).not.toMatch(/pause/);
  });

  it('requires an overlap between the customer\'s methods and the gateway\'s mandate methods', async () => {
    const { router } = makeRouter();
    const decision = await router.route({ ...SUBSCRIPTION, paymentMethods: [PaymentMethod.ENach] });
    expect(decision.ranked.sort()).toEqual([Provider.Cashfree, Provider.PayU, Provider.Paytm, Provider.Razorpay].sort());
    const phonepe = decision.candidates.find((c) => c.provider === Provider.PhonePe);
    expect(phonepe?.exclusions).toEqual([RouteExclusion.PaymentMethodUnsupported]);
  });

  it('uses the one-time method list for one-time payments, not the mandate list', async () => {
    const { router } = makeRouter({
      capabilities: [
        caps(Provider.Razorpay, { paymentMethods: [PaymentMethod.Upi], oneTimePaymentMethods: [PaymentMethod.Wallet] }),
        caps(Provider.Cashfree, { paymentMethods: [PaymentMethod.Wallet], oneTimePaymentMethods: [PaymentMethod.Upi] }),
      ],
    });
    expect((await router.route({ ...PAYMENT, paymentMethods: [PaymentMethod.Wallet] })).ranked).toEqual([Provider.Razorpay]);
    expect((await router.route({ ...SUBSCRIPTION, paymentMethods: [PaymentMethod.Wallet] })).ranked).toEqual([Provider.Cashfree]);
  });

  it('accepts a gateway that offers any one of several requested methods', async () => {
    const { router } = makeRouter();
    const decision = await router.route({ ...SUBSCRIPTION, paymentMethods: [PaymentMethod.PhysicalNach, PaymentMethod.Upi] });
    expect(decision.ranked).toHaveLength(ALL_GATEWAYS.length);
  });

  it('excludes the providers the merchant lists', async () => {
    const { router } = makeRouter();
    const decision = await router.route({ ...SUBSCRIPTION, exclude: [Provider.Razorpay, Provider.PayU] });
    expect(decision.ranked).not.toContain(Provider.Razorpay);
    expect(decision.ranked).not.toContain(Provider.PayU);
    expect(decision.candidates.find((c) => c.provider === Provider.PayU)?.exclusions).toEqual([RouteExclusion.ExcludedByMerchant]);
  });

  it('excludes a gateway above its maximum amount and keeps it at the maximum', async () => {
    const { router } = makeRouter({ strategy: { limits: { [Provider.PhonePe]: { maxAmount: MANDATE_CEILING } } } });
    const above = await exclusionsOf(router, { ...SUBSCRIPTION, amount: MANDATE_CEILING + 1 });
    expect(above[Provider.PhonePe]).toEqual([RouteExclusion.AboveMaxAmount]);
    const at = await exclusionsOf(router, { ...SUBSCRIPTION, amount: MANDATE_CEILING });
    expect(at[Provider.PhonePe]).toEqual([]);
  });

  it('excludes a gateway below its minimum amount and keeps it at the minimum', async () => {
    const { router } = makeRouter({ strategy: { limits: { [Provider.Paytm]: { minAmount: 10_000 } } } });
    const below = await exclusionsOf(router, { ...SUBSCRIPTION, amount: 9_999 });
    expect(below[Provider.Paytm]).toEqual([RouteExclusion.BelowMinAmount]);
    const at = await exclusionsOf(router, { ...SUBSCRIPTION, amount: 10_000 });
    expect(at[Provider.Paytm]).toEqual([]);
  });

  it('applies amount bounds to one-time payments too', async () => {
    const { router } = makeRouter({ strategy: { limits: { [Provider.Razorpay]: { maxAmount: 1_000 } } } });
    expect((await exclusionsOf(router, PAYMENT))[Provider.Razorpay]).toEqual([RouteExclusion.AboveMaxAmount]);
  });

  it('never makes an app store a candidate', async () => {
    const { router } = makeRouter({ capabilities: [...STORES, GATEWAYS.razorpay] });
    const decision = await router.route(SUBSCRIPTION);
    expect(decision.ranked).toEqual([Provider.Razorpay]);
    expect(decision.candidates.map((c) => c.provider)).toEqual([Provider.Razorpay]);
  });

  it('ignores a store provider even when the merchant prefers it', async () => {
    const { router } = makeRouter({ capabilities: [...STORES, GATEWAYS.razorpay] });
    const decision = await router.route({ ...SUBSCRIPTION, prefer: Provider.AppStore });
    expect(decision.provider).toBe(Provider.Razorpay);
  });

  it('uses the first capability set when a provider is listed twice', async () => {
    const { router } = makeRouter({
      capabilities: [caps(Provider.Razorpay, { pause: true }), caps(Provider.Razorpay, { pause: false })],
    });
    const decision = await router.route({ ...SUBSCRIPTION, needs: { pause: true } });
    expect(decision.candidates).toHaveLength(1);
    expect(decision.provider).toBe(Provider.Razorpay);
  });
});

describe('hard filters, combined', () => {
  it('reports every filter that applies to a gateway, in a fixed order', async () => {
    const { router } = makeRouter({ strategy: { limits: { [Provider.PhonePe]: { maxAmount: 1_000 } } } });
    const decision = await router.route({
      ...PAYMENT,
      paymentMethods: [PaymentMethod.Wallet],
      needs: { refunds: true },
      exclude: [Provider.PhonePe],
    });
    const phonepe = decision.candidates.find((c) => c.provider === Provider.PhonePe);
    expect(phonepe?.exclusions).toEqual([
      RouteExclusion.ExcludedByMerchant,
      RouteExclusion.WrongProductKind,
      RouteExclusion.AboveMaxAmount,
    ]);
    expect(phonepe?.details).toHaveLength(3);
  });

  it('applies kind, method, capability and amount filters together', async () => {
    const { router } = makeRouter({ strategy: { limits: { [Provider.Cashfree]: { maxAmount: 10_000 } } } });
    const decision = await router.route({
      ...PAYMENT,
      paymentMethods: [PaymentMethod.Wallet],
      needs: { refunds: true },
    });
    const byProvider = Object.fromEntries(decision.candidates.map((c) => [c.provider, c.exclusions]));
    expect(byProvider[Provider.PhonePe]).toEqual([RouteExclusion.WrongProductKind]);
    expect(byProvider[Provider.Cashfree]).toEqual([RouteExclusion.AboveMaxAmount]);
    expect(decision.ranked.sort()).toEqual([Provider.PayU, Provider.Paytm, Provider.Razorpay].sort());
  });

  it('lists the excluded candidates after the ranked ones, by provider name', async () => {
    const { router } = makeRouter();
    const decision = await router.route({ ...PAYMENT, exclude: [Provider.Razorpay, Provider.Cashfree] });
    const names = decision.candidates.map((c) => c.provider);
    expect(names.slice(0, decision.ranked.length)).toEqual(decision.ranked);
    expect(names.slice(decision.ranked.length)).toEqual([Provider.Cashfree, Provider.PhonePe, Provider.Razorpay]);
    for (const candidate of decision.candidates) {
      expect(candidate.eligible).toBe(candidate.exclusions.length === 0);
      expect(candidate.score !== undefined).toBe(candidate.eligible);
      expect(candidate.factors !== undefined).toBe(candidate.eligible);
    }
  });
});

describe('NO_ROUTE', () => {
  async function failure(promise: Promise<unknown>): Promise<SubscriptionError> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(SubscriptionError);
      return error as SubscriptionError;
    }
    throw new Error('expected route to reject');
  }

  it('rejects with NO_ROUTE and says why each gateway was excluded', async () => {
    const { router } = makeRouter({ strategy: { limits: { [Provider.Razorpay]: { maxAmount: 1_000 } } } });
    const error = await failure(
      router.route({ ...PAYMENT, needs: { quantity: true }, exclude: [Provider.Cashfree], paymentMethods: [PaymentMethod.Wallet] }),
    );
    expect(error.code).toBe(ErrorCode.NoRoute);
    expect(error.message).toContain('one_time of 49900 paise');
    expect(error.message).toContain('cashfree (excluded in the request; lacks quantity)');
    expect(error.message).toContain('phonepe (does not take one-time payments; lacks quantity)');
    expect(error.message).toContain('payu (lacks quantity)');
    expect(error.message).toContain('paytm (lacks quantity)');
    expect(error.message).toContain('razorpay (49900 paise is above its maximum of 1000)');
    expect(error.retryable).toBe(false);
    expect(Array.isArray(error.raw)).toBe(true);
  });

  it('rejects when no gateway is configured, only stores', async () => {
    const { router } = makeRouter({ capabilities: STORES });
    const error = await failure(router.route(SUBSCRIPTION));
    expect(error.code).toBe(ErrorCode.NoRoute);
    expect(error.message).toContain('no gateway provider is configured');
  });

  it('rejects when every gateway is excluded by an open circuit', async () => {
    const { router } = makeRouter({
      capabilities: [GATEWAYS.razorpay],
      strategy: { circuitBreaker: { failureThreshold: 1 } },
    });
    await router.record({ provider: Provider.Razorpay, kind: RouteOutcomeKind.Request, result: RouteOutcomeResult.Unavailable });
    const error = await failure(router.route(SUBSCRIPTION));
    expect(error.code).toBe(ErrorCode.NoRoute);
    expect(error.message).toContain('razorpay (circuit open');
  });

  it('rejects a malformed request with VALIDATION, not NO_ROUTE', async () => {
    const { router } = makeRouter();
    const error = await failure(router.route({ kind: ProductKind.Subscription, amount: 0 }));
    expect(error.code).toBe(ErrorCode.Validation);
    const unknown = await failure(router.route({ kind: ProductKind.Subscription, amount: 100, paymentMethods: [] }));
    expect(unknown.code).toBe(ErrorCode.Validation);
  });
});
