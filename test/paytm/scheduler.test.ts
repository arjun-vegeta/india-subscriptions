import { describe, expect, it } from 'vitest';
import { ChargeStatus, Environment, EventType, IntervalUnit, Provider } from '../../src/constants.js';
import { paytm } from '../../src/providers/paytm/index.js';
import { BillingScheduler, CycleStatus, MemorySchedulerStore, ScheduleStatus } from '../../src/scheduler/index.js';
import { FakePaytm } from './fake-gateway.js';
import { CUSTOMER, KEY, MID, SALT } from './helpers.js';

/**
 * End to end through the real billing scheduler: createSubscription (a trial) -> verifyCheckout -> activate -> pre-notify ->
 * renew -> confirmation by Transaction Status and by the payment webhook; a renew whose answer is lost (reconciled without a
 * second debit); a debit that fails and is retried under new ids. The fake keeps state the way Paytm does (it refuses a repeated
 * renew order id, wants the pre-notify named and 24 hours old) and verifies the signature of every request.
 */
const T0 = '2026-01-01T05:00:00.000Z';
const HOUR = 3_600_000;

function world() {
  let now = new Date(T0);
  const fake = new FakePaytm(() => now.getTime());
  const provider = paytm(
    { mid: MID, merchantKey: KEY, website: 'WEBSTAGING', environment: Environment.Test },
    { fetch: fake.fetch, now: () => now, maxRetries: 0, generateSalt: () => SALT },
  );
  const scheduler = new BillingScheduler({ store: new MemorySchedulerStore({ now: () => now.getTime() }), resolveProvider: () => provider, now: () => now });
  const at = (iso: string) => {
    now = new Date(iso);
  };
  const tickAt = (iso: string) => {
    at(iso);
    return scheduler.tick();
  };
  /** Ticks hourly from the current instant until `done()` or `maxHours` pass. */
  const tickHourly = async (maxHours: number, done: () => boolean = () => false) => {
    for (let hour = 0; hour < maxHours && !done(); hour += 1) {
      now = new Date(now.getTime() + HOUR);
      await scheduler.tick();
    }
  };
  return { fake, provider, scheduler, at, tickAt, tickHourly, now: () => now };
}

async function startTrial(w: ReturnType<typeof world>) {
  // Create with a 14-day trial (first debit 15 Jan, 10:30 IST), then authorise as the customer would.
  const subscription = await w.provider.createSubscription({
    reference: 'order_100',
    plan: { name: 'Pro monthly', amount: 49900, interval: { unit: IntervalUnit.Month, count: 1 } },
    customer: CUSTOMER,
    trial: { days: 14 },
  });
  const schedule = await w.scheduler.register({
    provider: Provider.Paytm,
    subscriptionId: subscription.id,
    reference: subscription.reference,
    amount: subscription.amount as number,
    interval: subscription.interval as never,
    firstChargeAt: subscription.startAt as string,
    customer: CUSTOMER,
    awaitingAuthorization: true,
  });
  const verification = await w.provider.verifyCheckout(w.fake.authorise(subscription));
  expect(verification).toMatchObject({ authorized: true, subscriptionId: subscription.id });
  await w.scheduler.activate(schedule.id, { subscriptionId: verification.subscriptionId, firstChargeAt: subscription.startAt as string });
  return { subscription, schedule };
}

describe('PaytmProvider driven by the BillingScheduler (merchant mode)', () => {
  it('a trial: nothing is debited before the trial ends; the subscription was created merchant-collected with a zero first amount', async () => {
    const w = world();
    const { subscription } = await startTrial(w);
    const create = w.fake.requests.find((request) => request.path === '/subscription/create');
    expect(create?.body).toMatchObject({ autoRenewal: false, subscriptionAmountType: 'VARIABLE', txnAmount: { value: '0', currency: 'INR' }, subscriptionStartDate: '2026-01-01' });
    expect(subscription.startAt).toBe('2026-01-15T05:00:00.000Z');
    expect((await w.tickAt('2026-01-05T00:00:00.000Z')).notified).toBe(0);
    expect(w.fake.renewRequestIds).toHaveLength(0);
    expect(w.fake.notifications).toHaveLength(0);
  });

  it('pre-notifies 48 hours ahead, renews on the due date naming the pre-notify, and a Transaction Status of TXN_SUCCESS settles the cycle', async () => {
    const w = world();
    const { schedule } = await startTrial(w);

    expect((await w.tickAt('2026-01-13T05:00:00.000Z')).notified).toBe(1);
    const [notification] = w.fake.notifications;
    expect(notification).toMatchObject({ subsId: '130001', txnDate: '15-01-2026', amount: '499.00' });
    expect(notification?.referenceId).toMatch(/^n_/);
    // The pre-notify went out with a status read for the payment mode first.
    expect(w.fake.requests.filter((request) => request.path === '/subscription/preNotify')).toHaveLength(1);

    const due = await w.tickAt('2026-01-15T05:00:00.000Z');
    expect(due.charged).toBe(1);
    expect(w.fake.renewRequestIds).toHaveLength(1);
    const renew = w.fake.requests.find((request) => request.path === '/subscription/renew');
    expect(renew?.body).toMatchObject({ subscriptionId: '130001', txnAmount: { value: '499.00', currency: 'INR' }, prenotifyReferenceId: notification?.referenceId });
    expect(renew?.query.get('orderId')).toBe(renew?.body.orderId);
    expect(renew?.body.orderId).toMatch(/^c_/);
    // Accepted is not collected: the cycle waits for the bank.
    expect((await w.scheduler.listCycles(schedule.id))[0]?.status).toBe(CycleStatus.AwaitingConfirmation);

    const orderId = w.fake.renewRequestIds[0] as string;
    w.fake.settle(orderId, ChargeStatus.Succeeded);
    const confirmed = await w.tickAt('2026-01-15T06:00:00.000Z');
    expect(confirmed.succeeded).toBe(1);
    expect(w.fake.statusLookups).toContain(orderId);
    expect((await w.scheduler.get(schedule.id))?.paidCycles).toBe(1);
    expect(w.fake.debits.size).toBe(1);
  });

  it('a payment webhook settles the next cycle without a status lookup, and a redelivery changes nothing', async () => {
    const w = world();
    const { schedule } = await startTrial(w);
    await w.tickAt('2026-01-13T05:00:00.000Z');
    await w.tickAt('2026-01-15T05:00:00.000Z');
    w.fake.settle(w.fake.renewRequestIds[0] as string, ChargeStatus.Succeeded);
    await w.tickAt('2026-01-15T06:00:00.000Z');

    // Cycle 2: due 15 Feb.
    await w.tickAt('2026-02-13T05:00:00.000Z');
    await w.tickAt('2026-02-15T05:00:00.000Z');
    expect(w.fake.renewRequestIds).toHaveLength(2);
    const orderId = w.fake.renewRequestIds[1] as string;
    w.fake.settle(orderId, ChargeStatus.Succeeded);
    const lookupsBefore = w.fake.statusLookups.filter((id) => id === orderId).length;

    const events = w.provider.parseWebhook(w.fake.paymentWebhook(orderId, ChargeStatus.Succeeded));
    expect(events[0]).toMatchObject({ type: EventType.SubscriptionCharged, charge: { id: orderId, reference: orderId } });
    expect(events[0]?.subscriptionId).toBeUndefined();
    await w.scheduler.handleEvent(events[0] as never);
    expect((await w.scheduler.get(schedule.id))?.paidCycles).toBe(2);
    await w.scheduler.handleEvent(events[0] as never);
    expect((await w.scheduler.get(schedule.id))?.paidCycles).toBe(2);
    await w.tickAt('2026-02-15T06:00:00.000Z');
    expect(w.fake.statusLookups.filter((id) => id === orderId).length).toBe(lookupsBefore);
    expect(w.fake.debits.size).toBe(2);
  });

  it('a renew whose answer is lost is reconciled with Transaction Status: one debit, one order id, then settled', async () => {
    const w = world();
    const { schedule } = await startTrial(w);
    await w.tickAt('2026-01-13T05:00:00.000Z');
    w.fake.loseNextRenew = 'answer';
    const lost = await w.tickAt('2026-01-15T05:00:00.000Z');
    expect(lost.succeeded).toBe(0);
    expect(lost.errors[0]?.code).toBe('OUTCOME_UNKNOWN');
    expect(w.fake.debits.size).toBe(1);

    await w.tickAt('2026-01-15T05:30:00.000Z');
    expect(new Set(w.fake.renewRequestIds).size).toBe(1);
    expect(w.fake.renewRequestIds).toHaveLength(1);
    expect(w.fake.statusLookups).toContain(w.fake.renewRequestIds[0]);
    w.fake.settle(w.fake.renewRequestIds[0] as string, ChargeStatus.Succeeded);
    await w.tickAt('2026-01-15T07:00:00.000Z');
    expect((await w.scheduler.get(schedule.id))?.paidCycles).toBe(1);
    expect(w.fake.debits.size).toBe(1);
  });

  it('a renew that never reached Paytm is NOT_FOUND there; after the grace period the SAME order id is sent again: one debit', async () => {
    const w = world();
    await startTrial(w);
    await w.tickAt('2026-01-13T05:00:00.000Z');
    w.fake.loseNextRenew = 'request';
    await w.tickAt('2026-01-15T05:00:00.000Z');
    expect(w.fake.debits.size).toBe(0);
    await w.tickAt('2026-01-15T06:00:00.000Z');
    expect(w.fake.renewRequestIds).toHaveLength(2);
    expect(w.fake.renewRequestIds[0]).toBe(w.fake.renewRequestIds[1]);
    expect(w.fake.debits.size).toBe(1);
  });

  it('a failed debit is retried under a NEW notification and a NEW order id, and the retry settles the cycle', async () => {
    const w = world();
    const { schedule } = await startTrial(w);
    await w.tickAt('2026-01-13T05:00:00.000Z');
    await w.tickAt('2026-01-15T05:00:00.000Z');
    const first = w.fake.renewRequestIds[0] as string;
    w.fake.settle(first, ChargeStatus.Failed);
    await w.tickAt('2026-01-15T06:00:00.000Z');
    expect((await w.scheduler.get(schedule.id))?.paidCycles).toBe(0);

    await w.tickHourly(120, () => w.fake.renewRequestIds.length >= 2);
    const second = w.fake.renewRequestIds[1] as string;
    expect(second).not.toBe(first);
    expect(w.fake.renewRequestIds.filter((id) => id === first)).toHaveLength(1);
    // A fresh notification for the retry, named by the retry's renew; it was at least 24 hours old (else Paytm fails it with 267).
    expect(w.fake.notifications).toHaveLength(2);
    expect(w.fake.requests.filter((request) => request.path === '/subscription/renew').at(-1)?.body.prenotifyReferenceId).toBe(w.fake.notifications[1]?.referenceId);
    expect(w.fake.debits.get(second)?.status).toBe('PENDING');

    w.fake.settle(second, ChargeStatus.Succeeded);
    await w.tickHourly(3);
    expect((await w.scheduler.get(schedule.id))?.paidCycles).toBe(1);
    expect(w.fake.debits.size).toBe(2);
  });

  it('a bank mandate (eNACH) is debited with no pre-notify and no prenotifyReferenceId', async () => {
    const w = world();
    w.fake.paymentMode = 'BANK_MANDATE';
    const { schedule } = await startTrial(w);
    await w.tickAt('2026-01-13T05:00:00.000Z');
    expect(w.fake.notifications).toHaveLength(0);
    expect(w.fake.requests.filter((request) => request.path === '/subscription/preNotify')).toHaveLength(0);
    await w.tickAt('2026-01-15T05:00:00.000Z');
    const renew = w.fake.requests.find((request) => request.path === '/subscription/renew');
    expect(renew?.body).not.toHaveProperty('prenotifyReferenceId');
    expect(w.fake.debits.size).toBe(1);
    expect((await w.scheduler.listCycles(schedule.id))[0]?.status).toBe(CycleStatus.AwaitingConfirmation);
  });

  it('the schedule stays pending until the mandate is ACTIVE: a bank mandate Paytm still reports AUTHORISED does not bill', async () => {
    const w = world();
    const subscription = await w.provider.createSubscription({
      reference: 'order_200',
      plan: { name: 'Pro monthly', amount: 49900, interval: { unit: IntervalUnit.Month, count: 1 } },
      customer: CUSTOMER,
      startAt: '2026-01-15T05:00:00.000Z',
    });
    const schedule = await w.scheduler.register({
      provider: Provider.Paytm,
      subscriptionId: subscription.id,
      reference: subscription.reference,
      amount: 49900,
      interval: { unit: IntervalUnit.Month, count: 1 },
      firstChargeAt: subscription.startAt as string,
      awaitingAuthorization: true,
    });
    const sub = w.fake.subscriptions.get(subscription.id);
    if (!sub) throw new Error('missing');
    sub.status = 'AUTHORISED';
    await w.tickAt('2026-01-02T00:00:00.000Z');
    expect((await w.scheduler.get(schedule.id))?.status).toBe(ScheduleStatus.PendingAuthorization);
    // The bank confirms: the scheduler's authorisation poll sees ACTIVE and starts billing.
    sub.status = 'ACTIVE';
    await w.tickAt('2026-01-03T00:00:00.000Z');
    expect((await w.scheduler.get(schedule.id))?.status).toBe(ScheduleStatus.Active);
  });
});
