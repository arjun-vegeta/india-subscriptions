import { describe, expect, it, vi } from 'vitest';
import { RouteOutcomeKind, RouteOutcomeResult } from '../../src/routing/index.js';
import type { Payment, Subscription } from '../../src/schemas.js';
import { EntitlementStatus, SessionStatus, PurchaseIssue } from '../../src/purchase/index.js';
import {
  CUSTOMER,
  CUSTOMER_REF,
  DAY,
  ErrorCode,
  EventType,
  HOUR,
  LIFETIME,
  MONTHLY,
  Outcome,
  PaymentStatus,
  Platform,
  Provider,
  SubscriptionStatus,
  charge,
  event,
  harness,
  refundOf,
  rejection,
  result,
  type Harness,
} from './helpers.js';

const start = (h: Harness, fields: Record<string, unknown> = {}) =>
  h.purchases.start({ platform: Platform.Web, product: MONTHLY.key, customer: CUSTOMER, customerRef: CUSTOMER_REF, ...fields } as never);

/** A completed gateway subscription; returns the subscription id. */
async function subscribed(h: Harness, fields: Record<string, unknown> = {}): Promise<string> {
  const session = await start(h, fields);
  const handle = session.options[0]!.handle;
  await h.purchases.complete(session.id, { provider: session.options[0]!.provider, result: result(handle) });
  return handle;
}

async function purchased(h: Harness, fields: Record<string, unknown> = {}): Promise<string> {
  const session = await start(h, { product: LIFETIME.key, ...fields });
  const handle = session.options[0]!.handle;
  h.host.setPayment(handle, session.options[0]!.provider, { amount: LIFETIME.amount });
  await h.purchases.complete(session.id, { provider: session.options[0]!.provider, result: result(handle) });
  return handle;
}

const sub = (id: string, fields: Partial<Subscription> = {}): Subscription => ({
  provider: Provider.Razorpay,
  id,
  status: SubscriptionStatus.Active,
  providerStatus: 'active',
  scheduling: 'gateway',
  ...fields,
});

const item = async (h: Harness) => (await h.purchases.entitlements(CUSTOMER_REF)).items[0]!;

describe('entitlements follow subscription events', () => {
  it('activation, renewal (with the new period), past due and back', async () => {
    const h = harness();
    const id = await subscribed(h);
    const periodEnd = new Date(Date.parse(h.clock.iso()) + 30 * DAY).toISOString();

    await h.purchases.handleEvents([
      event(Provider.Razorpay, EventType.SubscriptionCharged, {
        subscriptionId: id,
        subscription: sub(id, { currentPeriodEnd: periodEnd }),
        charge: charge(Provider.Razorpay, 'pay_1', id, 59_000),
      }),
    ]);
    expect(await item(h)).toMatchObject({ status: EntitlementStatus.Active, currentPeriodEnd: periodEnd, active: true });

    await h.purchases.handleEvents([event(Provider.Razorpay, EventType.SubscriptionChargeFailed, { subscriptionId: id })]);
    expect(await item(h)).toMatchObject({ status: EntitlementStatus.PastDue, active: true });

    await h.purchases.handleEvents([event(Provider.Razorpay, EventType.SubscriptionPastDue, { subscriptionId: id })]);
    expect((await item(h)).status).toBe(EntitlementStatus.PastDue);

    await h.purchases.handleEvents([
      event(Provider.Razorpay, EventType.SubscriptionCharged, { subscriptionId: id, charge: charge(Provider.Razorpay, 'pay_2', id, 59_000) }),
    ]);
    expect(await item(h)).toMatchObject({ status: EntitlementStatus.Active, active: true });
  });

  it('a trial is a trialing entitlement, active, until the first charge', async () => {
    const h = harness();
    const session = await start(h, { product: 'pro_trial' });
    const id = session.options[0]!.handle;
    h.host.setSubscription(id, Provider.Razorpay, { status: SubscriptionStatus.Trialing });
    await h.purchases.complete(session.id, { provider: Provider.Razorpay, result: result(id) });
    expect(await item(h)).toMatchObject({ status: EntitlementStatus.Trialing, active: true });
    await h.purchases.handleEvents([
      event(Provider.Razorpay, EventType.SubscriptionCharged, {
        subscriptionId: id,
        subscription: sub(id),
        charge: charge(Provider.Razorpay, 'pay_1', id, 59_000),
      }),
    ]);
    expect((await item(h)).status).toBe(EntitlementStatus.Active);
  });

  it('pause stops access but still blocks a second purchase; resume restores access', async () => {
    const h = harness();
    const id = await subscribed(h);
    await h.purchases.handleEvents([event(Provider.Razorpay, EventType.SubscriptionPaused, { subscriptionId: id })]);
    expect(await item(h)).toMatchObject({ status: EntitlementStatus.Paused, active: false });
    expect((await h.purchases.entitlements(CUSTOMER_REF)).active).toBe(false);
    expect((await rejection(start(h))).code).toBe(ErrorCode.Conflict);
    await h.purchases.handleEvents([event(Provider.Razorpay, EventType.SubscriptionResumed, { subscriptionId: id })]);
    expect(await item(h)).toMatchObject({ status: EntitlementStatus.Active, active: true });
  });

  it('cancel at period end keeps access until the period ends, then neither gives access nor blocks', async () => {
    const h = harness();
    const id = await subscribed(h);
    const end = new Date(Date.parse(h.clock.iso()) + 10 * DAY).toISOString();
    await h.purchases.handleEvents([
      event(Provider.Razorpay, EventType.SubscriptionUpdated, {
        subscriptionId: id,
        subscription: sub(id, { cancelAtPeriodEnd: true, currentPeriodEnd: end }),
      }),
    ]);
    expect(await item(h)).toMatchObject({ status: EntitlementStatus.Active, cancelAtPeriodEnd: true, currentPeriodEnd: end, active: true });
    expect((await rejection(start(h))).code).toBe(ErrorCode.Conflict);

    h.clock.advance(10 * DAY);
    expect((await h.purchases.entitlements(CUSTOMER_REF)).active).toBe(false);
    await expect(start(h)).resolves.toBeDefined();
  });

  it.each([
    [EventType.SubscriptionCancelled, EntitlementStatus.Cancelled],
    [EventType.SubscriptionExpired, EntitlementStatus.Expired],
    [EventType.SubscriptionCompleted, EntitlementStatus.Expired],
    [EventType.SubscriptionHalted, EntitlementStatus.Halted],
  ])('%s ends the entitlement as %s and lets the customer buy again', async (type, status) => {
    const h = harness();
    const id = await subscribed(h);
    await h.purchases.handleEvents([event(Provider.Razorpay, type, { subscriptionId: id })]);
    expect(await item(h)).toMatchObject({ status, active: false });
    expect((await h.purchases.entitlements(CUSTOMER_REF)).active).toBe(false);
    await expect(start(h)).resolves.toBeDefined();
  });

  it('an event older than the newest one applied changes nothing', async () => {
    const h = harness();
    const id = await subscribed(h);
    const t = (hours: number) => new Date(Date.parse(h.clock.iso()) + hours * HOUR).toISOString();
    await h.purchases.handleEvents([event(Provider.Razorpay, EventType.SubscriptionPaused, { subscriptionId: id, occurredAt: t(2) })]);
    await h.purchases.handleEvents([event(Provider.Razorpay, EventType.SubscriptionResumed, { subscriptionId: id, occurredAt: t(1) })]);
    expect((await item(h)).status).toBe(EntitlementStatus.Paused);
    await h.purchases.handleEvents([event(Provider.Razorpay, EventType.SubscriptionResumed, { subscriptionId: id, occurredAt: t(3) })]);
    expect((await item(h)).status).toBe(EntitlementStatus.Active);
  });

  it('an ended subscription is not revived by an event with no timestamp, but is by a newer one', async () => {
    const h = harness();
    const id = await subscribed(h);
    const later = new Date(Date.parse(h.clock.iso()) + HOUR).toISOString();
    await h.purchases.handleEvents([event(Provider.Razorpay, EventType.SubscriptionCancelled, { subscriptionId: id, occurredAt: later })]);
    await h.purchases.handleEvents([event(Provider.Razorpay, EventType.SubscriptionActivated, { subscriptionId: id })]);
    expect((await item(h)).status).toBe(EntitlementStatus.Cancelled);
    await h.purchases.handleEvents([
      event(Provider.Razorpay, EventType.SubscriptionActivated, { subscriptionId: id, occurredAt: new Date(Date.parse(later) + HOUR).toISOString() }),
    ]);
    expect((await item(h)).status).toBe(EntitlementStatus.Active);
  });

  it('a redelivered event does not change anything again', async () => {
    const h = harness();
    const id = await subscribed(h);
    const paused = event(Provider.Razorpay, EventType.SubscriptionPaused, { subscriptionId: id });
    await h.purchases.handleEvents([paused]);
    h.clock.advance(HOUR);
    const before = await item(h);
    const save = vi.spyOn(h.store, 'saveEntitlement');
    await h.purchases.handleEvents([paused]);
    expect(save).not.toHaveBeenCalled();
    expect(await item(h)).toEqual(before);
  });

  it('finds the purchase by the reference an event carries (PayU style: the real id exists only after authorisation)', async () => {
    const h = harness();
    const id = await subscribed(h);
    const session = (await h.store.findSessionByHandle(Provider.Razorpay, id))!;
    await h.purchases.handleEvents([
      event(Provider.Razorpay, EventType.SubscriptionPaused, { subscription: sub('real_9', { reference: id }) }),
    ]);
    expect(session.reference).toBeDefined();
    expect((await item(h)).status).toBe(EntitlementStatus.Paused);
  });

  it('keeps a store subscription current from the store\'s own events', async () => {
    const h = harness();
    const session = await start(h, { platform: Platform.Ios });
    const done = await h.purchases.complete(session.id, { provider: Provider.AppStore, result: result(session.options[0]!.handle) });
    const id = done.subscriptionId!;
    await h.purchases.handleEvents([event(Provider.AppStore, EventType.SubscriptionExpired, { subscriptionId: id })]);
    expect(await item(h)).toMatchObject({ provider: Provider.AppStore, status: EntitlementStatus.Expired, active: false });
  });
});

describe('entitlements follow payment events', () => {
  const payment = (id: string, fields: Partial<Payment> = {}): Payment => ({
    provider: Provider.Razorpay,
    id,
    status: PaymentStatus.Succeeded,
    providerStatus: 'captured',
    amount: LIFETIME.amount,
    ...fields,
  });

  it('a full refund of a one-time purchase ends it as refunded, and the customer can buy again', async () => {
    const h = harness();
    const id = await purchased(h);
    expect((await rejection(start(h, { product: LIFETIME.key }))).code).toBe(ErrorCode.Conflict);
    await h.purchases.handleEvents([
      event(Provider.Razorpay, EventType.RefundSucceeded, {
        paymentId: id,
        refund: refundOf(Provider.Razorpay, 'rf_1', id, LIFETIME.amount, { paymentId: id }),
      }),
    ]);
    expect(await item(h)).toMatchObject({ status: EntitlementStatus.Refunded, active: false });
    await expect(start(h, { product: LIFETIME.key })).resolves.toBeDefined();
  });

  it('a partial refund keeps access; two partial refunds that add up to the price end it; a refund is counted once', async () => {
    const h = harness();
    const id = await purchased(h);
    const half = LIFETIME.amount / 2;
    const first = event(Provider.Razorpay, EventType.RefundSucceeded, { paymentId: id, refund: refundOf(Provider.Razorpay, 'rf_1', id, half, { paymentId: id }) });
    await h.purchases.handleEvents([first, first]);
    expect(await item(h)).toMatchObject({ status: EntitlementStatus.Active, active: true });
    await h.purchases.handleEvents([
      event(Provider.Razorpay, EventType.RefundSucceeded, { paymentId: id, refund: refundOf(Provider.Razorpay, 'rf_2', id, half, { paymentId: id }) }),
    ]);
    expect((await item(h)).status).toBe(EntitlementStatus.Refunded);
  });

  it('a refund that reports the cumulative refunded amount is taken as it is', async () => {
    const h = harness();
    const id = await purchased(h);
    await h.purchases.handleEvents([
      event(Provider.Razorpay, EventType.RefundSucceeded, {
        paymentId: id,
        payment: payment(id, { refundedAmount: LIFETIME.amount, status: PaymentStatus.Refunded }),
        refund: refundOf(Provider.Razorpay, 'rf_1', id, 1000, { paymentId: id }),
      }),
    ]);
    expect((await item(h)).status).toBe(EntitlementStatus.Refunded);
  });

  it('a refund of a subscription charge does not end the subscription', async () => {
    const h = harness();
    const id = await subscribed(h);
    await h.purchases.handleEvents([
      event(Provider.Razorpay, EventType.RefundSucceeded, { subscriptionId: id, refund: refundOf(Provider.Razorpay, 'rf_1', 'pay_1', 59_000, { subscriptionId: id }) }),
    ]);
    expect((await item(h)).status).toBe(EntitlementStatus.Active);
  });
});

describe('events and sessions that nobody completed', () => {
  it('payment.succeeded completes a session whose customer never came back', async () => {
    const h = harness();
    const session = await start(h, { product: LIFETIME.key });
    const id = session.options[0]!.handle;
    await h.purchases.handleEvents([
      event(Provider.Razorpay, EventType.PaymentSucceeded, {
        paymentId: id,
        payment: { provider: Provider.Razorpay, id, status: PaymentStatus.Succeeded, providerStatus: 'captured', amount: LIFETIME.amount },
      }),
    ]);
    expect((await h.purchases.get(session.id)).status).toBe(SessionStatus.Completed);
    expect(await item(h)).toMatchObject({ kind: 'one_time', status: EntitlementStatus.Active, paymentId: id });
  });

  it('subscription.activated completes a session left awaiting payment (a mandate that was pending at the bank)', async () => {
    const h = harness();
    const session = await start(h);
    const id = session.options[0]!.handle;
    await h.purchases.complete(session.id, { provider: Provider.Razorpay, result: result(id, Outcome.Pending) });
    expect((await h.purchases.get(session.id)).status).toBe(SessionStatus.AwaitingPayment);
    await h.purchases.handleEvents([event(Provider.Razorpay, EventType.SubscriptionActivated, { subscriptionId: id, subscription: sub(id) })]);
    expect((await h.purchases.get(session.id)).status).toBe(SessionStatus.Completed);
    expect(await item(h)).toMatchObject({ status: EntitlementStatus.Active, active: true });
  });

  it('a success event completes an expired session: the money moved', async () => {
    const h = harness();
    const session = await start(h, { product: LIFETIME.key });
    h.clock.advance(30 * HOUR);
    await h.purchases.handleEvents([event(Provider.Razorpay, EventType.PaymentSucceeded, { paymentId: session.options[0]!.handle })]);
    expect((await h.purchases.get(session.id)).status).toBe(SessionStatus.Completed);
  });

  it('a pending subscription event does not complete the session', async () => {
    const h = harness();
    const session = await start(h);
    const id = session.options[0]!.handle;
    await h.purchases.handleEvents([
      event(Provider.Razorpay, EventType.SubscriptionAuthorized, { subscriptionId: id, subscription: sub(id, { status: SubscriptionStatus.PendingAuthorization }) }),
    ]);
    expect((await h.purchases.get(session.id)).status).toBe(SessionStatus.Open);
    expect((await h.purchases.entitlements(CUSTOMER_REF)).items).toEqual([]);
  });

  it('one failure event never fails the session (the customer can retry on the same order)', async () => {
    const h = harness();
    const session = await start(h, { product: LIFETIME.key });
    const record = vi.spyOn(h.router, 'record');
    await h.purchases.handleEvents([event(Provider.Razorpay, EventType.PaymentFailed, { paymentId: session.options[0]!.handle })]);
    expect((await h.purchases.get(session.id)).status).toBe(SessionStatus.Open);
    expect(record).toHaveBeenCalledWith({ provider: Provider.Razorpay, kind: RouteOutcomeKind.Payment, result: RouteOutcomeResult.Failure });
    // ... and the retry that succeeds completes it.
    await h.purchases.handleEvents([event(Provider.Razorpay, EventType.PaymentSucceeded, { paymentId: session.options[0]!.handle })]);
    expect((await h.purchases.get(session.id)).status).toBe(SessionStatus.Completed);
  });

  it('ignores events that match no session and no entitlement', async () => {
    const h = harness();
    await subscribed(h);
    const save = vi.spyOn(h.store, 'saveEntitlement');
    const saveSession = vi.spyOn(h.store, 'saveSession');
    await h.purchases.handleEvents([
      event(Provider.Razorpay, EventType.SubscriptionCancelled, { subscriptionId: 'sub_not_ours' }),
      event(Provider.Razorpay, EventType.PaymentSucceeded, { paymentId: 'order_not_ours' }),
      event(Provider.Razorpay, EventType.RefundSucceeded, { refund: refundOf(Provider.Razorpay, 'rf', 'pay_x', 100) }),
      event(Provider.Cashfree, EventType.Unknown),
    ]);
    expect(save).not.toHaveBeenCalled();
    expect(saveSession).not.toHaveBeenCalled();
    expect(h.issues).toEqual([]);
  });

  it('an event of another provider with the same id is not ours', async () => {
    const h = harness();
    const id = await subscribed(h);
    await h.purchases.handleEvents([event(Provider.Cashfree, EventType.SubscriptionCancelled, { subscriptionId: id })]);
    expect((await item(h)).status).toBe(EntitlementStatus.Active);
  });

  it('records charge outcomes with the router: a charge once, however often it is delivered, and a failed charge', async () => {
    const h = harness();
    const id = await subscribed(h);
    const record = vi.spyOn(h.router, 'record');
    const charged = event(Provider.Razorpay, EventType.SubscriptionCharged, { subscriptionId: id, charge: charge(Provider.Razorpay, 'pay_1', id, 59_000) });
    await h.purchases.handleEvents([charged, charged]);
    await h.purchases.handleEvents([event(Provider.Razorpay, EventType.SubscriptionChargeFailed, { subscriptionId: id })]);
    expect(record.mock.calls.map(([o]) => [o.kind, o.result])).toEqual([
      [RouteOutcomeKind.Charge, RouteOutcomeResult.Success],
      [RouteOutcomeKind.Charge, RouteOutcomeResult.Failure],
    ]);
  });

  it('tries every event of a batch, then throws the first failure', async () => {
    const h = harness();
    const id = await subscribed(h);
    const boom = new Error('store down');
    const find = vi.spyOn(h.store, 'findEntitlement').mockRejectedValueOnce(boom);
    const events = [
      event(Provider.Razorpay, EventType.SubscriptionCharged, { subscriptionId: id }),
      event(Provider.Razorpay, EventType.SubscriptionPaused, { subscriptionId: id }),
    ];
    await expect(h.purchases.handleEvents(events)).rejects.toBe(boom);
    find.mockRestore();
    expect((await item(h)).status).toBe(EntitlementStatus.Paused);
    expect(h.issues.map((i) => i.issue)).toEqual([PurchaseIssue.EventFailed]);
  });
});
