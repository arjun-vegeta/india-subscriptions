import { describe, expect, it, vi } from 'vitest';
import { GATEWAY_ID_PATTERN, MAX_GATEWAY_ID_LENGTH, CheckoutKind, ChannelPolicy, SalesChannel } from '../../src/constants.js';
import { RouteOutcomeKind, RouteOutcomeResult } from '../../src/routing/index.js';
import { SessionStatus } from '../../src/purchase/index.js';
import {
  BOOK,
  COINS,
  CUSTOMER,
  CUSTOMER_REF,
  ErrorCode,
  FAKE_CAPABILITIES,
  LIFETIME,
  MONTHLY,
  Platform,
  Provider,
  TRIAL_MONTHLY,
  harness,
  rejection,
  type Harness,
} from './helpers.js';

const start = (h: Harness, fields: Record<string, unknown> = {}) =>
  h.purchases.start({ platform: Platform.Web, product: MONTHLY.key, customer: CUSTOMER, customerRef: CUSTOMER_REF, ...fields } as never);

describe('start: where a purchase goes', () => {
  it('web goes to the best gateway and records why', async () => {
    const h = harness();
    const session = await start(h);
    expect(session.policy).toBe(ChannelPolicy.Gateways);
    expect(session.status).toBe(SessionStatus.Open);
    expect(session.options).toHaveLength(1);
    const option = session.options[0]!;
    expect(option.channel).toBe(SalesChannel.Gateway);
    expect(option.provider).toBe(Provider.Razorpay);
    expect(option.handle).toMatch(/^sub_razorpay_/);
    expect(option.routing?.ranked[0]).toBe(Provider.Razorpay);
    expect(session.id).toMatch(/^ps_[A-Za-z0-9_-]{32}$/);
    expect(session.expiresAt).toBe(h.clock.iso(24 * 3_600_000));
    expect(session.attempts).toEqual([{ provider: Provider.Razorpay, outcome: 'created', at: h.clock.iso() }]);
  });

  it('iOS goes to the App Store with the account token as handle', async () => {
    const h = harness();
    const session = await start(h, { platform: Platform.Ios });
    expect(session.policy).toBe(ChannelPolicy.Store);
    const option = session.options[0]!;
    expect(option.provider).toBe(Provider.AppStore);
    expect(option.channel).toBe(SalesChannel.Store);
    expect(option.checkout.kind).toBe(CheckoutKind.AppleStoreKit);
    expect(option.handle).toBe((option.checkout as { appAccountToken: string }).appAccountToken);
    const [call] = h.host.callsOf('create', Provider.AppStore);
    expect((call?.input as { storeProduct: unknown }).storeProduct).toEqual(MONTHLY.appStore);
  });

  it('Android with the store policy goes to Google Play without the choice screen', async () => {
    const h = harness({ policy: { android: ChannelPolicy.Store }, reporter: null });
    const session = await start(h, { platform: Platform.Android });
    const checkout = session.options[0]!.checkout;
    expect(checkout.kind).toBe(CheckoutKind.GooglePlayBilling);
    expect((checkout as { userChoiceBilling: boolean }).userChoiceBilling).toBe(false);
    expect(h.host.callsOf('create', Provider.Razorpay)).toHaveLength(0);
  });

  it('Android with user choice returns the Google Play option with the choice screen and creates no gateway order', async () => {
    const h = harness();
    const session = await start(h, { platform: Platform.Android });
    expect(session.policy).toBe(ChannelPolicy.UserChoice);
    expect(session.options).toHaveLength(1);
    const checkout = session.options[0]!.checkout;
    expect((checkout as { userChoiceBilling: boolean }).userChoiceBilling).toBe(true);
    for (const gateway of [Provider.Razorpay, Provider.Cashfree, Provider.PhonePe]) {
      expect(h.host.callsOf('create', gateway)).toHaveLength(0);
      expect(h.host.callsOf('payments.create', gateway)).toHaveLength(0);
    }
  });

  it('Android with the gateways policy goes to a gateway', async () => {
    const h = harness({ policy: { android: ChannelPolicy.Gateways } });
    const session = await start(h, { platform: Platform.Android });
    expect(session.options[0]!.channel).toBe(SalesChannel.Gateway);
  });

  it('physical goods go to a gateway on every platform', async () => {
    const h = harness();
    for (const platform of [Platform.Ios, Platform.Android, Platform.Web]) {
      const session = await start(h, { platform, product: BOOK.key, customerRef: `c_${platform}` });
      expect(session.options[0]!.channel).toBe(SalesChannel.Gateway);
      expect(session.policy).toBe(ChannelPolicy.Gateways);
    }
  });

  it('a one-time product is created as a payment', async () => {
    const h = harness();
    const session = await start(h, { product: LIFETIME.key });
    expect(h.host.callsOf('payments.create', Provider.Razorpay)).toHaveLength(1);
    expect(h.host.callsOf('create')).toHaveLength(0);
    expect(session.options[0]!.handle).toMatch(/^order_razorpay_/);
  });

  it('refuses a product that is not sold on the platform', async () => {
    const h = harness({ catalog: [{ ...MONTHLY, platforms: [Platform.Web] }] });
    const error = await rejection(start(h, { platform: Platform.Ios }));
    expect(error.code).toBe(ErrorCode.Validation);
  });

  it('refuses an unknown product with NOT_FOUND', async () => {
    const h = harness();
    expect((await rejection(start(h, { product: 'nope' }))).code).toBe(ErrorCode.NotFound);
  });

  it('user choice needs the customer state, and says so before creating anything', async () => {
    const h = harness();
    const error = await rejection(start(h, { platform: Platform.Android, customer: { name: 'Asha' } }));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(error.message).toMatch(/state/);
    expect(h.host.calls).toHaveLength(0);
  });

  it('an ios purchase without the app_store provider is a CONFIG error', async () => {
    const h = harness({ capabilities: [FAKE_CAPABILITIES.razorpay!], catalog: [MONTHLY], policy: {}, reporter: null });
    const error = await rejection(start(h, { platform: Platform.Ios }));
    expect(error.code).toBe(ErrorCode.Config);
  });
});

describe('start: what a gateway is sent', () => {
  it('a subscription gets the plan, the customer, the reference and the trial', async () => {
    const h = harness();
    await start(h, { product: TRIAL_MONTHLY.key, returnUrl: 'https://app.example/return' });
    const [call] = h.host.callsOf('create', Provider.Razorpay);
    const input = call?.input as Record<string, unknown>;
    expect(input).toMatchObject({
      plan: { name: 'Pro monthly', amount: 59_000, interval: { unit: 'month', count: 1 } },
      customer: CUSTOMER,
      trial: { days: 7 },
      returnUrl: 'https://app.example/return',
    });
    expect(input.reference).toMatch(GATEWAY_ID_PATTERN);
    expect(input).not.toHaveProperty('metadata');
    expect(input).not.toHaveProperty('storeProduct');
  });

  it('a one-time payment gets only what every gateway takes', async () => {
    const h = harness();
    await start(h, { product: LIFETIME.key, returnUrl: 'https://app.example/return' });
    const [call] = h.host.callsOf('payments.create', Provider.Razorpay);
    const input = call?.input as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual(['amount', 'customer', 'description', 'reference', 'returnUrl']);
    expect(input).toMatchObject({ amount: 118_000, description: 'Lifetime' });
  });

  it('payment methods and plan extras are sent only when the product configures them', async () => {
    const h = harness({
      catalog: [
        { ...MONTHLY, key: 'capped', plan: { maxAmount: 100_000 }, paymentMethods: ['upi'] },
        { ...LIFETIME, key: 'upi_only', paymentMethods: ['upi'] },
      ],
    });
    await start(h, { product: 'capped' });
    await start(h, { product: 'upi_only' });
    const sub = h.host.callsOf('create', Provider.Razorpay)[0]?.input as Record<string, unknown>;
    expect(sub).toMatchObject({ plan: { maxAmount: 100_000 }, paymentMethods: ['upi'] });
    const pay = h.host.callsOf('payments.create', Provider.Razorpay)[0]?.input as Record<string, unknown>;
    expect(pay.paymentMethods).toEqual(['upi']);
  });

  it('a generated reference fits every gateway', async () => {
    const h = harness();
    for (let i = 0; i < 50; i += 1) {
      const session = await start(h, { customerRef: `c_${i}` });
      expect(session.reference.length).toBeLessThanOrEqual(MAX_GATEWAY_ID_LENGTH);
      expect(session.reference).toMatch(GATEWAY_ID_PATTERN);
    }
  });

  it('refuses a reference no gateway could take', async () => {
    const h = harness();
    expect((await rejection(start(h, { reference: 'x'.repeat(MAX_GATEWAY_ID_LENGTH + 1) }))).code).toBe(ErrorCode.Validation);
    expect((await rejection(start(h, { reference: 'has space' }))).code).toBe(ErrorCode.Validation);
  });

  it('a trial product is only routed to gateways that support trials', async () => {
    const h = harness({ priority: [Provider.Cashfree, Provider.Razorpay] });
    const session = await start(h, { product: TRIAL_MONTHLY.key });
    expect(session.options[0]!.provider).toBe(Provider.Razorpay);
    expect(session.options[0]!.routing?.ranked).not.toContain(Provider.Cashfree);
  });

  it('a one-time product is never routed to a gateway without one-time payments', async () => {
    const h = harness({ priority: [Provider.PhonePe, Provider.Cashfree] });
    const session = await start(h, { product: LIFETIME.key });
    expect(session.options[0]!.provider).toBe(Provider.Cashfree);
  });

  it('rejects with NO_ROUTE when no gateway can take the purchase', async () => {
    const h = harness({ capabilities: [FAKE_CAPABILITIES.phonepe!], catalog: [LIFETIME], policy: {}, reporter: null });
    expect((await rejection(start(h, { product: LIFETIME.key }))).code).toBe(ErrorCode.NoRoute);
  });
});

describe('start: idempotency and the duplicate-purchase guard', () => {
  it('a start retried with the same reference and customer returns the open session', async () => {
    const h = harness();
    const first = await start(h, { reference: 'order-1' });
    const second = await start(h, { reference: 'order-1' });
    expect(second).toEqual(first);
    expect(h.host.callsOf('create')).toHaveLength(1);
  });

  it('two starts racing with the same reference create one purchase', async () => {
    const h = harness();
    const [a, b] = await Promise.all([start(h, { reference: 'order-1' }), start(h, { reference: 'order-1' })]);
    expect(a.id).toBe(b.id);
    expect(h.host.callsOf('create')).toHaveLength(1);
  });

  it('the same reference for another customer is another session', async () => {
    const h = harness();
    const a = await start(h, { reference: 'order-1' });
    const b = await start(h, { reference: 'order-1', customerRef: 'cust_2' });
    expect(a.id).not.toBe(b.id);
  });

  it('the same reference for another product is refused', async () => {
    const h = harness();
    await start(h, { reference: 'order-1' });
    expect((await rejection(start(h, { reference: 'order-1', product: LIFETIME.key }))).code).toBe(ErrorCode.Conflict);
  });

  it('a start without a reference creates a new session every time', async () => {
    const h = harness();
    const a = await start(h);
    const b = await start(h);
    expect(a.id).not.toBe(b.id);
    expect(a.reference).not.toBe(b.reference);
  });

  it('an expired session is not returned: the retry starts over', async () => {
    const h = harness();
    const first = await start(h, { reference: 'order-1' });
    h.clock.advance(25 * 3_600_000);
    const second = await start(h, { reference: 'order-1' });
    expect(second.id).not.toBe(first.id);
    expect((await h.purchases.get(first.id)).status).toBe(SessionStatus.Expired);
  });

  it('passes every gateway attempt to the router', async () => {
    const h = harness();
    const record = vi.spyOn(h.router, 'record');
    await start(h);
    expect(record).toHaveBeenCalledWith({ provider: Provider.Razorpay, kind: RouteOutcomeKind.Request, result: RouteOutcomeResult.Success });
  });

  it('a failing statistics store does not fail the purchase', async () => {
    const h = harness();
    vi.spyOn(h.router, 'record').mockRejectedValue(new Error('stats down'));
    await expect(start(h)).resolves.toMatchObject({ status: SessionStatus.Open });
    expect(h.issues).toHaveLength(1);
  });

  it('a consumable can be bought again', async () => {
    const h = harness();
    const first = await start(h, { platform: Platform.Ios, product: COINS.key });
    const second = await start(h, { platform: Platform.Ios, product: COINS.key });
    expect(second.id).not.toBe(first.id);
  });
});
