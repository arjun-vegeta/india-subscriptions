import { describe, expect, it } from 'vitest';
import { ChargeStatus, Environment, ErrorCode, EventType, Provider, SubscriptionStatus } from '../../src/constants.js';
import { phonepe } from '../../src/providers/phonepe/index.js';
import {
  BillingScheduler,
  CycleStatus,
  MemorySchedulerStore,
  ScheduleStatus,
  chargeIdFor,
  notificationIdFor,
  type ScheduleRecord,
} from '../../src/scheduler/index.js';
import { FakePhonePe } from './fake-gateway.js';
import { CLIENT_ID, CLIENT_SECRET, CLIENT_VERSION, CUSTOMER, HOUR, MONTHLY_PLAN, RETURN_URL, WEBHOOK_PASSWORD, WEBHOOK_USERNAME } from './helpers.js';

/**
 * The real BillingScheduler and MemorySchedulerStore driving the real PhonePe adapter against a stateful PhonePe fake:
 * a trial, the pre-debit notification, the redemption exactly 24 hours later, a lost answer reconciled without a second
 * debit, a failed debit retried with a fresh notification.
 */
const T0 = '2026-01-01T00:00:00.000Z';
/** The end of a 14 day trial. */
const DUE = '2026-01-15T00:00:00.000Z';
const at = (iso: string, hours: number): string => new Date(Date.parse(iso) + hours * HOUR).toISOString();

async function world(options: { phonepeAheadMs?: number } = {}) {
  let nowMs = Date.parse(T0);
  const clock = { now: (): Date => new Date(nowMs), set: (iso: string) => void (nowMs = Date.parse(iso)) };
  // PhonePe's own clock may differ from ours.
  const fake = new FakePhonePe(() => nowMs + (options.phonepeAheadMs ?? 0));
  const provider = phonepe(
    {
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      clientVersion: CLIENT_VERSION,
      environment: Environment.Test,
      redirectUrl: RETURN_URL,
      webhookUsername: WEBHOOK_USERNAME,
      webhookPassword: WEBHOOK_PASSWORD,
    },
    { fetch: fake.fetch, now: clock.now, maxRetries: 0 },
  );
  const store = new MemorySchedulerStore({ now: () => nowMs });
  const scheduler = new BillingScheduler({ store, resolveProvider: () => provider, now: clock.now });

  const subscription = await provider.createSubscription({
    reference: 'order_100',
    plan: { ...MONTHLY_PLAN },
    customer: CUSTOMER,
    returnUrl: RETURN_URL,
    trial: { days: 14 },
  });
  const schedule = await scheduler.register({
    provider: Provider.PhonePe,
    subscriptionId: subscription.id,
    reference: subscription.reference,
    amount: subscription.amount as number,
    interval: subscription.interval as { unit: 'month'; count: number },
    firstChargeAt: subscription.startAt as string,
    customer: CUSTOMER,
    awaitingAuthorization: true,
    // Notify exactly 24 hours before the due date: PhonePe's minimum notice.
    notifyLeadHours: 24,
    minNoticeHours: 24,
  });
  const tickAt = (iso: string) => {
    clock.set(iso);
    return scheduler.tick();
  };
  const activate = async (): Promise<ScheduleRecord> => {
    fake.authorise(subscription.id);
    const verification = await provider.verifyCheckout({ merchantSubscriptionId: subscription.id });
    expect(verification).toMatchObject({ authorized: true, status: SubscriptionStatus.Active });
    return scheduler.activate(schedule.id, { subscriptionId: verification.subscriptionId });
  };
  const cycle = async (index = 0) => (await scheduler.listCycles(schedule.id)).find((candidate) => candidate.index === index);
  return { clock, fake, provider, scheduler, subscription, schedule, tickAt, activate, cycle };
}

describe('PhonePe adapter driven by the BillingScheduler', () => {
  it('trial -> notification 24 h before -> redemption exactly 24 h later, with the notification\'s order id, then reconciled to succeeded', async () => {
    const t = await world();
    expect(t.subscription.startAt).toBe(DUE);
    expect(t.subscription.trialEndsAt).toBe(DUE);
    expect(await t.scheduler.get(t.schedule.id)).toMatchObject({ status: ScheduleStatus.PendingAuthorization });

    // The customer authorises; before the due date nothing is raised.
    await t.activate();
    expect((await t.tickAt(at(T0, 24))).notified).toBe(0);
    expect((await t.tickAt(at(DUE, -25))).notified).toBe(0);

    // 24 hours before the due date: the pre-debit notification, whose id becomes the id of the debit.
    expect((await t.tickAt(at(DUE, -24))).notified).toBe(1);
    const notificationId = notificationIdFor(t.schedule.id, 0, 1, 1);
    expect(t.fake.notifyRequests).toEqual([notificationId]);
    expect(await t.cycle()).toMatchObject({ status: CycleStatus.Notified, notificationId, chargeId: notificationId });
    expect(notificationId).toMatch(/^[A-Za-z0-9_-]{1,25}$/);
    expect(t.fake.orders.get(notificationId)).toMatchObject({ kind: 'redemption', state: 'NOTIFIED', amount: 49900, subscriptionId: 'order_100' });

    // One hour before the due date PhonePe would refuse and the scheduler does not even ask.
    expect((await t.tickAt(at(DUE, -1))).charged).toBe(0);
    expect(t.fake.redeemRequests).toEqual([]);

    // On the due date: the debit, under the notification's id.
    const due = await t.tickAt(DUE);
    expect(due).toMatchObject({ charged: 1, errors: [] });
    expect(t.fake.redeemRequests).toEqual([notificationId]);
    const order = t.fake.orders.get(notificationId);
    expect((order?.redeemedAt as number) - (order?.notifiedAt as number)).toBe(24 * HOUR);
    expect(await t.cycle()).toMatchObject({ status: CycleStatus.AwaitingConfirmation, chargeId: notificationId });

    // PhonePe settles it.
    t.fake.settle(notificationId, 'succeeded');
    expect(await t.tickAt(at(DUE, 1))).toMatchObject({ reconciled: 1, succeeded: 1 });
    expect(await t.cycle()).toMatchObject({ status: CycleStatus.Succeeded, providerChargeId: notificationId });
    expect(await t.scheduler.get(t.schedule.id)).toMatchObject({ paidCycles: 1, status: ScheduleStatus.Active });
    expect(t.fake.debits.size).toBe(1);

    // The next cycle is a month on, with its own notification.
    expect((await t.tickAt('2026-02-13T23:59:00.000Z')).notified).toBe(0);
    expect((await t.tickAt('2026-02-14T00:00:00.000Z')).notified).toBe(1);
    expect(t.fake.notifyRequests).toEqual([notificationId, notificationIdFor(t.schedule.id, 1, 1, 1)]);
  });

  it('a lost redeem ANSWER (PhonePe executed it) is reconciled with getCharge: no second debit, the same id', async () => {
    const t = await world();
    await t.activate();
    await t.tickAt(at(DUE, -24));
    const id = notificationIdFor(t.schedule.id, 0, 1, 1);

    t.fake.dropNextRedeem = 'answer';
    const lost = await t.tickAt(DUE);
    expect(lost.errors.map((error) => error.code)).toEqual([ErrorCode.OutcomeUnknown]);
    expect(await t.cycle()).toMatchObject({ status: CycleStatus.Charging, chargeId: id });

    // The next tick asks PhonePe instead of debiting again: the debit exists and is pending.
    const asked = await t.tickAt(at(DUE, 0.2));
    expect(asked).toMatchObject({ reconciled: 1, charged: 0, awaiting: 1 });
    expect(await t.cycle()).toMatchObject({ status: CycleStatus.AwaitingConfirmation });
    t.fake.settle(id, 'succeeded');
    expect(await t.tickAt(at(DUE, 1))).toMatchObject({ succeeded: 1 });
    expect(t.fake.redeemRequests).toEqual([id]);
    expect(t.fake.debits.size).toBe(1);
    expect(await t.scheduler.get(t.schedule.id)).toMatchObject({ paidCycles: 1 });
  });

  it('a lost redeem REQUEST: the notification alone exists (NOT_FOUND for the debit); after the grace period the SAME id is redeemed, once', async () => {
    const t = await world();
    await t.activate();
    await t.tickAt(at(DUE, -24));
    const id = notificationIdFor(t.schedule.id, 0, 1, 1);

    t.fake.dropNextRedeem = 'request';
    expect((await t.tickAt(DUE)).errors[0]?.code).toBe(ErrorCode.OutcomeUnknown);
    // Within the 30 minute grace: PhonePe has only the notification, nothing is re-sent.
    expect(await t.tickAt(at(DUE, 0.2))).toMatchObject({ reconciled: 1, succeeded: 0 });
    expect(t.fake.redeemRequests).toEqual([id]);
    // After it: the same id again; PhonePe executes it now.
    await t.tickAt(at(DUE, 1));
    expect(t.fake.redeemRequests).toEqual([id, id]);
    expect(t.fake.debits.size).toBe(1);
    t.fake.settle(id, 'succeeded');
    await t.tickAt(at(DUE, 2));
    expect(await t.scheduler.get(t.schedule.id)).toMatchObject({ paidCycles: 1 });
    expect(t.fake.debits.size).toBe(1);
  });

  it('a status API that lags (the debit exists but still shows NOTIFIED): the re-sent redeem is refused, never doubled', async () => {
    const t = await world();
    await t.activate();
    await t.tickAt(at(DUE, -24));
    const id = notificationIdFor(t.schedule.id, 0, 1, 1);
    t.fake.dropNextRedeem = 'answer';
    t.fake.hideUntilMs = Date.parse(at(DUE, 3));
    await t.tickAt(DUE);
    // Past the grace period, PhonePe's status still says NOTIFIED: the adapter sends the same redeem again and PhonePe refuses it.
    const retried = await t.tickAt(at(DUE, 1));
    expect(retried.failed).toBe(0);
    expect(t.fake.debits.size).toBe(1);
    expect(t.fake.redeemRequests.every((request) => request === id)).toBe(true);
    // Once the status shows the debit, the cycle settles.
    t.fake.settle(id, 'succeeded');
    await t.tickAt(at(DUE, 4));
    expect(await t.scheduler.get(t.schedule.id)).toMatchObject({ paidCycles: 1 });
    expect(t.fake.debits.size).toBe(1);
  });

  it('a failed debit is retried a day later with a FRESH notification, whose id is the retry\'s debit id; the failed id is never reused', async () => {
    const t = await world();
    await t.activate();
    await t.tickAt(at(DUE, -24));
    const first = notificationIdFor(t.schedule.id, 0, 1, 1);
    await t.tickAt(DUE);
    t.fake.settle(first, 'failed');

    // The failure is read from PhonePe, with its error codes.
    const failed = await t.tickAt(at(DUE, 1));
    expect(failed).toMatchObject({ failed: 1 });
    const attempts = (await t.cycle())?.attempts ?? [];
    expect(attempts[0]).toMatchObject({ attempt: 1, chargeId: first, status: ChargeStatus.Failed, failureCode: 'INSUFFICIENT_BALANCE' });
    expect(await t.scheduler.get(t.schedule.id)).toMatchObject({ retrying: true });

    // The retry: attempt 2 falls due 24 hours after the failure; its notification goes out 24 hours before, i.e. at once.
    const second = notificationIdFor(t.schedule.id, 0, 2, 1);
    expect(second).not.toBe(first);
    await t.tickAt(at(DUE, 1.1));
    expect(t.fake.notifyRequests).toEqual([first, second]);
    expect(await t.cycle()).toMatchObject({ status: CycleStatus.Notified, chargeId: second, attempt: 2 });

    // 24 hours after that notification the debit goes out under the new id.
    expect((await t.tickAt(at(DUE, 24))).charged).toBe(0);
    expect((await t.tickAt(at(DUE, 25.2))).charged).toBe(1);
    expect(t.fake.redeemRequests).toEqual([first, second]);
    t.fake.settle(second, 'succeeded');
    await t.tickAt(at(DUE, 27));
    expect(await t.scheduler.get(t.schedule.id)).toMatchObject({ paidCycles: 1, status: ScheduleStatus.Active });
    expect(t.fake.debits.size).toBe(2);
    expect(first).toMatch(/^n_/);
    expect(chargeIdFor(t.schedule.id, 0, 2)).not.toBe(second);
  });

  it('three failed attempts halt the schedule; every attempt had its own notification and debit', async () => {
    const t = await world();
    await t.activate();
    let when = DUE;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const id = notificationIdFor(t.schedule.id, 0, attempt, 1);
      // Notify when it is due 24 hours ahead, then redeem 24 hours later.
      await t.tickAt(attempt === 1 ? at(DUE, -24) : at(when, 0.1));
      await t.tickAt(attempt === 1 ? DUE : at(when, 25.2));
      t.fake.settle(id, 'failed');
      when = at(when, attempt === 1 ? 1 : 26);
      await t.tickAt(when);
    }
    expect(await t.scheduler.get(t.schedule.id)).toMatchObject({ status: ScheduleStatus.Halted });
    expect(new Set(t.fake.redeemRequests).size).toBe(3);
    expect(t.fake.debits.size).toBe(3);
  });

  it('a notification the scheduler could not use in time (its window closed) is a FAILED attempt, retried with a fresh notification', async () => {
    const t = await world();
    await t.activate();
    await t.tickAt(at(DUE, -24));
    const first = notificationIdFor(t.schedule.id, 0, 1, 1);
    // The worker is down for five days: PhonePe's window (notified + 24 h .. + 96 h) has closed when it comes back.
    const late = await t.tickAt(at(DUE, 4 * 24));
    expect(late.failed).toBe(1);
    expect(t.fake.redeemRequests).toEqual([]);
    expect((await t.cycle())?.attempts[0]).toMatchObject({ chargeId: first, status: ChargeStatus.Failed, failureCode: 'SUBSCRIPTION_DEBIT_EXECUTE_INTERVAL_EXPIRED' });
    await t.tickAt(at(DUE, 4 * 24 + 0.1));
    expect(t.fake.notifyRequests).toEqual([first, notificationIdFor(t.schedule.id, 0, 2, 1)]);
  });

  it('PhonePe\'s clock ahead of ours by two hours: "too early" is not a failed attempt, nothing double-debits, and the debit goes out once the window opens', async () => {
    const t = await world({ phonepeAheadMs: 2 * HOUR });
    await t.activate();
    await t.tickAt(at(DUE, -24));
    const id = notificationIdFor(t.schedule.id, 0, 1, 1);
    // PhonePe notified at its own time (ours + 2 h): its window opens at DUE + 2 h by our clock.
    expect(t.fake.orders.get(id)?.validAfter).toBe(Date.parse(at(DUE, -24)) + 2 * HOUR + 24 * HOUR);

    for (const hours of [0, 0.6, 1.2, 1.8]) {
      const result = await t.tickAt(at(DUE, hours));
      expect(result.failed).toBe(0);
    }
    expect(t.fake.redeemRequests).toEqual([]);
    expect(await t.cycle()).toMatchObject({ status: CycleStatus.Charging, chargeId: id });
    expect((await t.cycle())?.attempts).toEqual([]);

    await t.tickAt(at(DUE, 2.5));
    expect(t.fake.redeemRequests).toEqual([id]);
    t.fake.settle(id, 'succeeded');
    await t.tickAt(at(DUE, 4));
    expect(await t.scheduler.get(t.schedule.id)).toMatchObject({ paidCycles: 1 });
    expect(t.fake.debits.size).toBe(1);
  });

  it('while the customer has not authorised, tick polls getSubscription: `created` keeps it waiting without an error, ACTIVE activates it', async () => {
    const t = await world();
    const first = await t.tickAt(at(T0, 2));
    expect(first.errors).toEqual([]);
    expect(await t.scheduler.get(t.schedule.id)).toMatchObject({ status: ScheduleStatus.PendingAuthorization });
    expect((await t.provider.getSubscription('order_100')).status).toBe(SubscriptionStatus.Created);

    t.fake.authorise('order_100');
    await t.tickAt(at(T0, 4));
    expect(await t.scheduler.get(t.schedule.id)).toMatchObject({ status: ScheduleStatus.Active, subscriptionId: 'order_100' });
  });

  it('a setup that PhonePe failed (the customer never finished) cancels the waiting schedule', async () => {
    const t = await world();
    t.fake.orders.get('ST_order_100')!.state = 'FAILED';
    await t.tickAt(at(T0, 2));
    expect(await t.scheduler.get(t.schedule.id)).toMatchObject({ status: ScheduleStatus.Cancelled });
  });

  it('webhooks: the customer pauses and un-pauses in their app; a debit webhook settles the cycle; revoking cancels', async () => {
    const t = await world();
    await t.activate();
    const handle = async (request: ReturnType<FakePhonePe['mandateWebhook']>) => {
      for (const event of await t.provider.parseWebhook(request)) await t.scheduler.handleEvent(event);
    };
    await handle(t.fake.mandateWebhook('order_100', 'paused'));
    expect((await t.scheduler.get(t.schedule.id))?.status).toBe(ScheduleStatus.Paused);
    expect((await t.tickAt(at(DUE, -24))).notified).toBe(0);
    await handle(t.fake.mandateWebhook('order_100', 'unpaused'));
    expect((await t.scheduler.get(t.schedule.id))?.status).toBe(ScheduleStatus.Active);

    await t.tickAt(at(DUE, -24));
    const id = notificationIdFor(t.schedule.id, 0, 1, 1);
    await t.tickAt(DUE);
    t.fake.settle(id, 'succeeded');
    for (const event of await t.provider.parseWebhook(t.fake.debitWebhook(id, 'succeeded'))) {
      expect(event.type).toBe(EventType.SubscriptionCharged);
      await t.scheduler.handleEvent(event);
    }
    expect(await t.scheduler.get(t.schedule.id)).toMatchObject({ paidCycles: 1 });

    await handle(t.fake.mandateWebhook('order_100', 'revoked'));
    expect((await t.scheduler.get(t.schedule.id))?.status).toBe(ScheduleStatus.Cancelled);
  });

  it('an expired token is replaced on the fly: the notification and the debit still go through, with one new token request', async () => {
    const t = await world();
    await t.activate();
    const issued = t.fake.tokensIssued;
    t.fake.revokeTokens();
    expect((await t.tickAt(at(DUE, -24))).notified).toBe(1);
    expect(t.fake.tokensIssued).toBe(issued + 1);
    expect(t.fake.notifyRequests).toHaveLength(1);
  });

  it('cancelling the mandate through the adapter is repeatable', async () => {
    const t = await world();
    await t.activate();
    expect((await t.provider.cancelSubscription('order_100')).status).toBe(SubscriptionStatus.Cancelled);
    expect((await t.provider.cancelSubscription('order_100')).status).toBe(SubscriptionStatus.Cancelled);
    expect(t.fake.requests.filter((request) => request.path.endsWith('/cancel'))).toHaveLength(1);
  });
});
