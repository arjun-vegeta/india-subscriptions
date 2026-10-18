import { describe, expect, it } from 'vitest';
import { PurchaseIssue, SessionStatus } from '../../src/purchase/index.js';
import { COINS, CUSTOMER, CUSTOMER_REF, LIFETIME, MONTHLY, Outcome, Platform, Provider, harness, result, type Harness } from './helpers.js';

const start = (h: Harness, fields: Record<string, unknown> = {}) =>
  h.purchases.start({ platform: Platform.Web, product: MONTHLY.key, customer: CUSTOMER, customerRef: CUSTOMER_REF, ...fields } as never);

const pay = (h: Harness, session: { id: string; options: { provider: Provider; handle: string }[] }, index = 0) =>
  h.purchases.complete(session.id, { provider: session.options[index]!.provider, result: result(session.options[index]!.handle, Outcome.Paid) });

describe('a duplicate purchase detected when it is paid', () => {
  it('keeps both entitlements and raises onIssue naming both sessions', async () => {
    const h = harness();
    const web = await start(h);
    const ios = await start(h, { platform: Platform.Ios });
    await pay(h, web);
    expect(h.issues).toEqual([]);
    const second = await pay(h, ios);
    expect(second.status).toBe(SessionStatus.Completed);

    const entitlements = await h.purchases.entitlements(CUSTOMER_REF);
    expect(entitlements.items).toHaveLength(2);
    expect(entitlements.items.every((item) => item.active)).toBe(true);
    expect(h.issues).toHaveLength(1);
    expect(h.issues[0]).toMatchObject({ issue: PurchaseIssue.DuplicatePurchase, sessionId: ios.id, otherSessionId: web.id });
    expect(h.issues[0]?.message).toContain(web.id);
    expect(h.issues[0]?.message).toContain(ios.id);
  });

  it('is also raised when a webhook completes the second session', async () => {
    const h = harness();
    const first = await start(h, { product: LIFETIME.key });
    const second = await start(h, { product: LIFETIME.key, platform: Platform.Ios });
    await pay(h, first);
    await h.purchases.handleEvents([
      {
        id: 'evt_x',
        provider: Provider.AppStore,
        type: 'payment.succeeded',
        providerEventType: 'x',
        paymentId: second.options[0]!.handle,
      },
    ]);
    expect(h.issues.map((i) => i.issue)).toEqual([PurchaseIssue.DuplicatePurchase]);
  });

  it('is not raised for another product, another customer, an ended entitlement or a consumable', async () => {
    const h = harness();
    await pay(h, await start(h));
    await pay(h, await start(h, { product: LIFETIME.key }));
    await pay(h, await start(h, { customerRef: 'other' }));
    const coins = () => start(h, { platform: Platform.Ios, product: COINS.key });
    await pay(h, await coins());
    const again = await coins();
    await pay(h, again);
    expect(h.issues).toEqual([]);
  });

  it('is not raised when the same session is settled again', async () => {
    const h = harness();
    const session = await start(h);
    await pay(h, session);
    await pay(h, session);
    expect(h.issues).toEqual([]);
  });
});

describe('gatewayReturnUrl', () => {
  const hooks = { gatewayReturnUrl: (id: string) => `https://svc.example/checkout/${id}/return` };

  it('gives the gateway the hook\'s URL and keeps the caller\'s on the session', async () => {
    const h = harness({ purchases: hooks });
    const session = await start(h, { returnUrl: 'myapp://done' });
    expect(session.returnUrl).toBe('myapp://done');
    const sent = h.host.callsOf('create', Provider.Razorpay)[0]?.input as { returnUrl: string };
    expect(sent.returnUrl).toBe(`https://svc.example/checkout/${session.id}/return`);
  });

  it('applies to one-time payments and to chooseAlternative', async () => {
    const h = harness({ purchases: hooks });
    const pay1 = await start(h, { product: LIFETIME.key, returnUrl: 'https://app.example/done' });
    const sent = h.host.callsOf('payments.create', Provider.Razorpay)[0]?.input as { returnUrl: string };
    expect(sent.returnUrl).toBe(`https://svc.example/checkout/${pay1.id}/return`);

    const android = await start(h, { platform: Platform.Android, customerRef: 'a', returnUrl: 'https://app.example/done' });
    const chosen = await h.purchases.chooseAlternative(android.id, { externalTransactionToken: 'tok' });
    const call = h.host.callsOf('create', Provider.Razorpay).at(-1)?.input as { returnUrl: string };
    expect(call.returnUrl).toBe(`https://svc.example/checkout/${android.id}/return`);
    expect(chosen.returnUrl).toBe('https://app.example/done');
  });

  it('is set even when the caller gave no return URL, and store options keep the caller\'s', async () => {
    const h = harness({ purchases: hooks });
    const web = await start(h);
    expect(web.returnUrl).toBeUndefined();
    expect((h.host.callsOf('create', Provider.Razorpay)[0]?.input as { returnUrl: string }).returnUrl).toBe(`https://svc.example/checkout/${web.id}/return`);

    await start(h, { platform: Platform.Ios, customerRef: 'i', returnUrl: 'https://app.example/done' });
    expect((h.host.callsOf('create', Provider.AppStore)[0]?.input as { returnUrl: string }).returnUrl).toBe('https://app.example/done');
  });

  it('without the hook the gateway gets the caller\'s URL', async () => {
    const h = harness();
    await start(h, { returnUrl: 'https://app.example/done' });
    expect((h.host.callsOf('create', Provider.Razorpay)[0]?.input as { returnUrl: string }).returnUrl).toBe('https://app.example/done');
  });
});

describe('hostedCheckoutUrl', () => {
  const hooks = { hostedCheckoutUrl: (id: string) => `https://svc.example/checkout/${id}` };

  it('puts hostedUrl on every gateway option and on no store option', async () => {
    const h = harness({ purchases: hooks });
    const web = await start(h);
    expect(web.options[0]?.hostedUrl).toBe(`https://svc.example/checkout/${web.id}`);

    const ios = await start(h, { platform: Platform.Ios, customerRef: 'i' });
    expect(ios.options[0]).not.toHaveProperty('hostedUrl');

    const android = await start(h, { platform: Platform.Android, customerRef: 'a' });
    expect(android.options[0]).not.toHaveProperty('hostedUrl');
    const chosen = await h.purchases.chooseAlternative(android.id, { externalTransactionToken: 'tok' });
    expect(chosen.options[0]).not.toHaveProperty('hostedUrl');
    expect(chosen.options[1]?.hostedUrl).toBe(`https://svc.example/checkout/${android.id}`);
    expect((await h.purchases.get(android.id)).options[1]?.hostedUrl).toBe(`https://svc.example/checkout/${android.id}`);
  });

  it('is absent without the hook', async () => {
    const h = harness();
    expect((await start(h)).options[0]).not.toHaveProperty('hostedUrl');
  });
});
