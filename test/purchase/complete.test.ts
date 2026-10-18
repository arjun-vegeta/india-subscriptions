import { describe, expect, it, vi } from 'vitest';
import { RouteOutcomeKind, RouteOutcomeResult } from '../../src/routing/index.js';
import { EntitlementStatus, SessionStatus } from '../../src/purchase/index.js';
import {
  COINS,
  CUSTOMER,
  CUSTOMER_REF,
  ErrorCode,
  LIFETIME,
  MONTHLY,
  Outcome,
  Platform,
  Provider,
  SubscriptionStatus,
  TRIAL_MONTHLY,
  harness,
  rejection,
  result,
  type Harness,
} from './helpers.js';

const start = (h: Harness, fields: Record<string, unknown> = {}) =>
  h.purchases.start({ platform: Platform.Web, product: MONTHLY.key, customer: CUSTOMER, customerRef: CUSTOMER_REF, ...fields } as never);

const pay = (h: Harness, session: { id: string; options: { provider: Provider; handle: string }[] }, outcome: Outcome = Outcome.Paid) =>
  h.purchases.complete(session.id, { provider: session.options[0]!.provider, result: result(session.options[0]!.handle, outcome) });

describe('complete', () => {
  it('verifies against the option handle, writes the entitlement and completes the session', async () => {
    const h = harness();
    const session = await start(h);
    const handle = session.options[0]!.handle;
    h.host.setSubscription(handle, Provider.Razorpay, { currentPeriodEnd: '2026-12-22T10:30:00.000Z' });
    const done = await pay(h, session);

    expect(done.status).toBe(SessionStatus.Completed);
    expect(done.subscriptionId).toBe(handle);
    expect(done.provider).toBe(Provider.Razorpay);
    expect(done.completedAt).toBe(h.clock.iso());
    const [verify] = h.host.callsOf('verifyCheckout');
    expect((verify?.input as { options: unknown }).options).toEqual({ expectedSubscriptionId: handle });

    const entitlements = await h.purchases.entitlements(CUSTOMER_REF);
    expect(entitlements.active).toBe(true);
    expect(entitlements.items).toEqual([
      {
        product: MONTHLY.key,
        kind: 'subscription',
        provider: Provider.Razorpay,
        channel: 'gateway',
        platform: 'web',
        subscriptionId: handle,
        status: EntitlementStatus.Active,
        active: true,
        currentPeriodEnd: '2026-12-22T10:30:00.000Z',
        updatedAt: h.clock.iso(),
      },
    ]);
  });

  it('takes the status from the provider when it can be read, and falls back to the verification when it cannot', async () => {
    const h = harness();
    const a = await start(h, { customerRef: 'a' });
    h.host.setSubscription(a.options[0]!.handle, Provider.Razorpay, { status: SubscriptionStatus.Trialing });
    await pay(h, a);
    expect((await h.purchases.entitlements('a')).items[0]!.status).toBe(EntitlementStatus.Trialing);

    const b = await start(h, { customerRef: 'b' });
    h.host.getFails = true;
    await pay(h, b);
    expect((await h.purchases.entitlements('b')).items[0]!.status).toBe(EntitlementStatus.Active);
  });

  it('a one-time purchase writes a payment entitlement', async () => {
    const h = harness();
    const session = await start(h, { product: LIFETIME.key });
    h.host.setPayment(session.options[0]!.handle, Provider.Razorpay, { amount: 118_000 });
    const done = await pay(h, session);
    expect(done.paymentId).toBe(session.options[0]!.handle);
    const [item] = (await h.purchases.entitlements(CUSTOMER_REF)).items;
    expect(item).toMatchObject({ kind: 'one_time', status: EntitlementStatus.Active, active: true, paymentId: session.options[0]!.handle });
  });

  it('a store purchase is verified against the account token and recorded under the store id', async () => {
    const h = harness();
    const session = await start(h, { platform: Platform.Ios });
    const done = await pay(h, session);
    expect(done.subscriptionId).toMatch(/^store_sub_/);
    expect(done.subscriptionId).not.toBe(session.options[0]!.handle);
    const [item] = (await h.purchases.entitlements(CUSTOMER_REF)).items;
    expect(item).toMatchObject({ provider: Provider.AppStore, channel: 'store', platform: 'ios', subscriptionId: done.subscriptionId });
  });

  it('records the routing outcome of a gateway purchase, and not of a store purchase', async () => {
    const h = harness();
    const record = vi.spyOn(h.router, 'record');
    const web = await start(h);
    record.mockClear();
    await pay(h, web);
    expect(record).toHaveBeenCalledWith({ provider: Provider.Razorpay, kind: RouteOutcomeKind.Authorization, result: RouteOutcomeResult.Success });

    record.mockClear();
    const ios = await start(h, { platform: Platform.Ios, customerRef: 'ios_customer' });
    await pay(h, ios);
    expect(record).not.toHaveBeenCalled();
  });

  it('a payment records a payment outcome', async () => {
    const h = harness();
    const record = vi.spyOn(h.router, 'record');
    const session = await start(h, { product: LIFETIME.key });
    record.mockClear();
    await pay(h, session);
    expect(record).toHaveBeenCalledWith({ provider: Provider.Razorpay, kind: RouteOutcomeKind.Payment, result: RouteOutcomeResult.Success });
  });

  it('refuses a provider the session has no option at', async () => {
    const h = harness();
    const session = await start(h);
    const error = await rejection(h.purchases.complete(session.id, { provider: Provider.Cashfree, result: result('x') }));
    expect(error.code).toBe(ErrorCode.Validation);
  });

  it('rejects with NOT_FOUND for an unknown session', async () => {
    const h = harness();
    expect((await rejection(h.purchases.complete('ps_nope', { provider: Provider.Razorpay, result: result('x') }))).code).toBe(ErrorCode.NotFound);
  });
});

describe('complete: idempotency and concurrency', () => {
  it('twice with the same result returns the same session and writes nothing more', async () => {
    const h = harness();
    const session = await start(h);
    const first = await pay(h, session);
    const saveEntitlement = vi.spyOn(h.store, 'saveEntitlement');
    const saveSession = vi.spyOn(h.store, 'saveSession');
    const enqueue = vi.spyOn(h.store, 'enqueueReport');
    const verifies = h.host.callsOf('verifyCheckout').length;
    const second = await pay(h, session);
    expect(second).toEqual(first);
    expect(saveEntitlement).not.toHaveBeenCalled();
    expect(saveSession).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(h.host.callsOf('verifyCheckout')).toHaveLength(verifies);
    expect((await h.purchases.entitlements(CUSTOMER_REF)).items).toHaveLength(1);
  });

  it('two calls racing on one session write one entitlement and one report', async () => {
    const h = harness();
    const session = await h.purchases.start({ platform: Platform.Android, product: MONTHLY.key, customer: CUSTOMER, customerRef: CUSTOMER_REF });
    const chosen = await h.purchases.chooseAlternative(session.id, { externalTransactionToken: 'tok' });
    const gateway = chosen.options[1]!;
    const saveEntitlement = vi.spyOn(h.store, 'saveEntitlement');
    const enqueue = vi.spyOn(h.store, 'enqueueReport');
    const completes = await Promise.all(
      Array.from({ length: 5 }, () => h.purchases.complete(session.id, { provider: gateway.provider, result: result(gateway.handle) })),
    );
    expect(new Set(completes.map((c) => c.status))).toEqual(new Set([SessionStatus.Completed]));
    expect(saveEntitlement).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect((await h.purchases.entitlements(CUSTOMER_REF)).items).toHaveLength(1);
    expect(h.host.callsOf('verifyCheckout')).toHaveLength(1);
  });

  it('even if the lock is lost (expired), the same ids make a repeated settle write one entitlement and one report', async () => {
    const h = harness();
    const session = await h.purchases.start({ platform: Platform.Android, product: MONTHLY.key, customer: CUSTOMER, customerRef: CUSTOMER_REF });
    const chosen = await h.purchases.chooseAlternative(session.id, { externalTransactionToken: 'tok' });
    const gateway = chosen.options[1]!;
    // A store whose locks never hold: every caller proceeds at once.
    vi.spyOn(h.store, 'acquireLock').mockImplementation(async () => 'always');
    await Promise.all([
      h.purchases.complete(session.id, { provider: gateway.provider, result: result(gateway.handle) }),
      h.purchases.complete(session.id, { provider: gateway.provider, result: result(gateway.handle) }),
    ]);
    expect((await h.purchases.entitlements(CUSTOMER_REF)).items).toHaveLength(1);
    const flushed = await h.purchases.flush();
    expect(flushed.sent).toBe(1);
    expect(h.reporter.reports).toHaveLength(1);
  });

  it('a request that cannot get the lock in time fails with CONFLICT', async () => {
    const h = harness({ purchases: { lock: { waitMs: 30, pollMs: 5 } } });
    const session = await start(h);
    const token = await h.store.acquireLock(`session:${session.id}`, 60_000);
    expect(token).toBeDefined();
    const error = await rejection(pay(h, session));
    expect(error.code).toBe(ErrorCode.Conflict);
    await h.store.releaseLock(`session:${session.id}`, token as string);
    expect((await pay(h, session)).status).toBe(SessionStatus.Completed);
  });
});

describe('complete: binding', () => {
  it('refuses a result for a different order and the session stays open', async () => {
    const h = harness();
    const mine = await start(h, { customerRef: 'mine' });
    const other = await start(h, { customerRef: 'other' });
    const error = await rejection(
      h.purchases.complete(mine.id, { provider: Provider.Razorpay, result: result(other.options[0]!.handle) }),
    );
    expect(error.code).toBe(ErrorCode.SignatureInvalid);
    expect((await h.purchases.get(mine.id)).status).toBe(SessionStatus.Open);
    expect((await h.purchases.entitlements('mine')).items).toEqual([]);
    expect((await h.purchases.entitlements('other')).items).toEqual([]);
  });

  it('refuses a store result for another account token', async () => {
    const h = harness();
    const a = await start(h, { platform: Platform.Ios, customerRef: 'a' });
    const b = await start(h, { platform: Platform.Ios, customerRef: 'b' });
    const error = await rejection(h.purchases.complete(a.id, { provider: Provider.AppStore, result: result(b.options[0]!.handle) }));
    expect(error.code).toBe(ErrorCode.SignatureInvalid);
    expect((await h.purchases.get(a.id)).status).toBe(SessionStatus.Open);
  });

  it('refuses it even when the host does not check the expected id', async () => {
    const h = harness();
    const mine = await start(h, { customerRef: 'mine' });
    const other = await start(h, { customerRef: 'other' });
    // A host that ignores `expectedSubscriptionId`.
    const verifyCheckout = h.host.verifyCheckout.bind(h.host);
    h.host.verifyCheckout = (provider, fields) => verifyCheckout(provider, fields);
    const error = await rejection(
      h.purchases.complete(mine.id, { provider: Provider.Razorpay, result: result(other.options[0]!.handle) }),
    );
    expect(error.code).toBe(ErrorCode.SignatureInvalid);
    expect((await h.purchases.get(mine.id)).status).toBe(SessionStatus.Open);
  });

  it('accepts a result the facade matched through the purchase\'s reference', async () => {
    const h = harness();
    const session = await start(h);
    const handle = session.options[0]!.handle;
    // The provider's own id differs from the handle, but the purchase it names carries the session's reference.
    h.host.verifyCheckout = async (provider) => ({ provider, subscriptionId: 'real_id', authorized: true, status: SubscriptionStatus.Active });
    h.host.setSubscription('real_id', Provider.Razorpay, { reference: session.reference });
    const done = await h.purchases.complete(session.id, { provider: Provider.Razorpay, result: result(handle) });
    expect(done.subscriptionId).toBe('real_id');
  });
});

describe('complete: what the customer\'s attempt showed', () => {
  it('not paid fails the session, and the customer can still pay afterwards (a retry on the same order)', async () => {
    const h = harness();
    const session = await start(h, { product: LIFETIME.key });
    const failed = await pay(h, session, Outcome.Failed);
    expect(failed.status).toBe(SessionStatus.Failed);
    expect((await h.purchases.entitlements(CUSTOMER_REF)).items).toEqual([]);
    const done = await pay(h, session, Outcome.Paid);
    expect(done.status).toBe(SessionStatus.Completed);
    expect((await h.purchases.entitlements(CUSTOMER_REF)).active).toBe(true);
  });

  it('records a failure outcome with the router', async () => {
    const h = harness();
    const session = await start(h, { product: LIFETIME.key });
    const record = vi.spyOn(h.router, 'record');
    await pay(h, session, Outcome.Failed);
    expect(record).toHaveBeenCalledWith({ provider: Provider.Razorpay, kind: RouteOutcomeKind.Payment, result: RouteOutcomeResult.Failure });
  });

  it('a mandate still pending at the bank leaves the session awaiting payment and writes no entitlement', async () => {
    const h = harness();
    const session = await start(h);
    const pending = await pay(h, session, Outcome.Pending);
    expect(pending.status).toBe(SessionStatus.AwaitingPayment);
    expect((await h.purchases.entitlements(CUSTOMER_REF)).items).toEqual([]);
    expect((await pay(h, session, Outcome.Paid)).status).toBe(SessionStatus.Completed);
  });

  it('a payment still pending leaves the session awaiting payment', async () => {
    const h = harness();
    const session = await start(h, { product: LIFETIME.key });
    expect((await pay(h, session, Outcome.Pending)).status).toBe(SessionStatus.AwaitingPayment);
  });

  it('a failed attempt on an expired session leaves it expired', async () => {
    const h = harness();
    const session = await start(h);
    h.clock.advance(25 * 3_600_000);
    expect((await pay(h, session, Outcome.Failed)).status).toBe(SessionStatus.Expired);
  });
});

describe('complete: Google Play consumables', () => {
  it('marks the result consumable for a consumable Google Play product, and only then', async () => {
    const h = harness();
    const consumable = await h.purchases.start({ platform: Platform.Android, product: COINS.key, customer: CUSTOMER, customerRef: CUSTOMER_REF });
    await h.purchases.complete(consumable.id, {
      provider: Provider.GooglePlay,
      result: { ...result(consumable.options[0]!.handle), purchaseToken: 'pt', productId: 'coins' },
    });
    const sent = h.host.callsOf('payments.verify', Provider.GooglePlay)[0]?.input as { result: Record<string, unknown> };
    expect(sent.result).toMatchObject({ purchaseToken: 'pt', productId: 'coins', consumable: true });

    const lifetime = await h.purchases.start({ platform: Platform.Android, product: LIFETIME.key, customer: CUSTOMER, customerRef: 'other' });
    await h.purchases.complete(lifetime.id, {
      provider: Provider.GooglePlay,
      result: { ...result(lifetime.options[0]!.handle), purchaseToken: 'pt2', productId: 'lifetime' },
    });
    const second = h.host.callsOf('payments.verify', Provider.GooglePlay)[1]?.input as { result: Record<string, unknown> };
    expect(second.result).not.toHaveProperty('consumable');
  });

  it('does not touch the result of a consumable on the App Store', async () => {
    const h = harness();
    const session = await h.purchases.start({ platform: Platform.Ios, product: COINS.key, customer: CUSTOMER, customerRef: CUSTOMER_REF });
    await h.purchases.complete(session.id, { provider: Provider.AppStore, result: result(session.options[0]!.handle) });
    const sent = h.host.callsOf('payments.verify', Provider.AppStore)[0]?.input as { result: Record<string, unknown> };
    expect(sent.result).not.toHaveProperty('consumable');
  });
});

describe('session expiry', () => {
  it('an open session past expiresAt reads as expired and stays expired', async () => {
    const h = harness();
    const session = await start(h);
    h.clock.advance(24 * 3_600_000 - 1);
    expect((await h.purchases.get(session.id)).status).toBe(SessionStatus.Open);
    h.clock.advance(1);
    expect((await h.purchases.get(session.id)).status).toBe(SessionStatus.Expired);
    expect((await h.store.getSession(session.id))?.status).toBe(SessionStatus.Expired);
  });

  it('the lifetime is configurable', async () => {
    const h = harness({ purchases: { sessionTtlMs: 60_000 } });
    const session = await start(h);
    expect(session.expiresAt).toBe(h.clock.iso(60_000));
    h.clock.advance(60_000);
    expect((await h.purchases.get(session.id)).status).toBe(SessionStatus.Expired);
  });

  it('a payment that is confirmed after the session expired still completes it: the money moved', async () => {
    const h = harness();
    const session = await start(h, { product: LIFETIME.key });
    h.clock.advance(30 * 3_600_000);
    const done = await pay(h, session);
    expect(done.status).toBe(SessionStatus.Completed);
    expect((await h.purchases.entitlements(CUSTOMER_REF)).active).toBe(true);
  });

  it('a completed session never expires', async () => {
    const h = harness();
    const session = await start(h);
    await pay(h, session);
    h.clock.advance(48 * 3_600_000);
    expect((await h.purchases.get(session.id)).status).toBe(SessionStatus.Completed);
  });

  it('get on an unknown session is NOT_FOUND', async () => {
    const h = harness();
    expect((await rejection(h.purchases.get('ps_nope'))).code).toBe(ErrorCode.NotFound);
  });

  it('expiry does not clobber a completion that lands at the same moment', async () => {
    const h = harness();
    const session = await start(h);
    h.clock.advance(25 * 3_600_000);
    const [done, read] = await Promise.all([pay(h, session), h.purchases.get(session.id)]);
    expect(done.status).toBe(SessionStatus.Completed);
    expect([SessionStatus.Expired, SessionStatus.Completed]).toContain(read.status);
    expect((await h.purchases.get(session.id)).status).toBe(SessionStatus.Completed);
  });
});

describe('the duplicate-purchase guard', () => {
  it('refuses a second purchase of an owned product, on any channel', async () => {
    const h = harness();
    await pay(h, await start(h));
    const web = await rejection(start(h));
    expect(web.code).toBe(ErrorCode.Conflict);
    const ios = await rejection(start(h, { platform: Platform.Ios }));
    expect(ios.code).toBe(ErrorCode.Conflict);
    const android = await rejection(start(h, { platform: Platform.Android }));
    expect(android.code).toBe(ErrorCode.Conflict);
  });

  it('allows another product and another customer', async () => {
    const h = harness();
    await pay(h, await start(h));
    await expect(start(h, { product: TRIAL_MONTHLY.key })).resolves.toBeDefined();
    await expect(start(h, { customerRef: 'someone_else' })).resolves.toBeDefined();
  });

  it('a retried start returns the completed session instead of a CONFLICT', async () => {
    const h = harness();
    const session = await start(h, { reference: 'order-9' });
    await pay(h, session);
    const again = await start(h, { reference: 'order-9' });
    expect(again.id).toBe(session.id);
    expect(again.status).toBe(SessionStatus.Completed);
  });

  it('a consumable never blocks', async () => {
    const h = harness();
    const first = await h.purchases.start({ platform: Platform.Ios, product: COINS.key, customer: CUSTOMER, customerRef: CUSTOMER_REF });
    await pay(h, first);
    await expect(
      h.purchases.start({ platform: Platform.Ios, product: COINS.key, customer: CUSTOMER, customerRef: CUSTOMER_REF }),
    ).resolves.toBeDefined();
  });
});
