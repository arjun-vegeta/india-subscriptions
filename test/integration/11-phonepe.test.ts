/**
 * Seam 11: the real PhonePe adapter + the real facade + the real BillingScheduler + the HTTP handler. PhonePe's own stateful
 * fake (test/phonepe/fake-gateway.ts) plays the gateway: it refuses a redeem outside the 24-72 hour window of a notification and
 * a second redeem of an order, and signs its webhooks with the Authorization header (sha256 of username:password).
 *
 * PhonePe is the gateway whose pre-debit notification DICTATES the charge id: the order created by the notify is the order that
 * is redeemed 24 hours later, so the scheduler must adopt `ChargeNotification.chargeId` instead of deriving its own.
 */
import { describe, expect, it } from 'vitest';
import {
  ChargeStatus,
  CheckoutKind,
  ContentType,
  ErrorCode,
  EventType,
  HeaderName,
  HttpMethod,
  IntervalUnit,
  Provider,
  RefundStatus,
  SchedulingMode,
  SubscriptionStatus,
} from '../../src/constants.js';
import {
  PENNY_DROP_AMOUNT_PAISE,
  PhonePeAuthWorkflowType,
  PhonePeOrderState,
  PhonePePath,
  PhonePeSubscriptionState,
  setupOrderIdFor,
} from '../../src/providers/phonepe/index.js';
import { CycleStatus, SchedulePauser, ScheduleStatus, ScheduleStatusReason, SchedulerEventType, chargeIdFor, notificationIdFor } from '../../src/scheduler/index.js';
import { HttpStatus, OperationId } from '../../src/server/index.js';
import { PP_AMOUNT, PP_DUE, PP_REFERENCE, PP_SECOND_DUE, PP_T0, phonepeProvider, setupPhonePe } from './fakes.js';
import { WEBHOOK_AUTHORIZATION } from '../phonepe/helpers.js';
import { CUSTOMER, Clock, httpApi, httpExchange, plusHours, rejection, type Wired } from './helpers.js';
import type { SchedulerEvent } from '../../src/scheduler/index.js';
import { createSubscriptions } from '../../src/client.js';
import { FakePhonePe } from '../phonepe/fake-gateway.js';
import { MemorySchedulerStore } from '../../src/scheduler/index.js';

type Setup = ReturnType<typeof setupPhonePe>;

/** Walks one cycle to the point where PhonePe holds a debit: authorised, notified 48 hours ahead, redeemed on the due date. */
async function redeemFirstCycle(t: Setup) {
  await t.create();
  await t.authoriseAndVerify();
  await t.tickAt(plusHours(PP_DUE, -48));
  return t.tickAt(PP_DUE);
}

describe('PhonePe through the facade and the scheduler: setup', () => {
  it('a penny-drop setup: the INR 2 order, a redirect checkout, the schedule waits for the customer', async () => {
    const t = setupPhonePe();
    const subscription = await t.create();
    const [pay] = t.fake.requests.filter((request) => request.path === PhonePePath.Pay);
    expect(pay?.body).toMatchObject({
      merchantOrderId: setupOrderIdFor(PP_REFERENCE),
      amount: PENNY_DROP_AMOUNT_PAISE,
      paymentFlow: { subscriptionDetails: { merchantSubscriptionId: PP_REFERENCE, authWorkflowType: PhonePeAuthWorkflowType.PennyDrop } },
    });
    expect(subscription).toMatchObject({
      id: PP_REFERENCE,
      reference: PP_REFERENCE,
      scheduling: SchedulingMode.Merchant,
      amount: PP_AMOUNT,
      interval: { unit: IntervalUnit.Month, count: 1 },
      startAt: PP_DUE,
      status: SubscriptionStatus.Created,
      checkout: { kind: CheckoutKind.Redirect },
    });
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ status: ScheduleStatus.PendingAuthorization, subscriptionId: PP_REFERENCE });

    // Until the customer authorises nothing is notified, and polling PhonePe leaves the schedule waiting.
    expect(await t.tickAt(plusHours(PP_DUE, -48))).toMatchObject({ notified: 0, charged: 0 });
    expect(t.fake.notifyRequests).toEqual([]);
    expect((await t.scheduler.get(t.scheduleId))?.status).toBe(ScheduleStatus.PendingAuthorization);
  });

  it('an upfront amount makes the setup a TRANSACTION of that amount', async () => {
    const t = setupPhonePe({ upfrontAmount: 9900 });
    await t.create();
    const [pay] = t.fake.requests.filter((request) => request.path === PhonePePath.Pay);
    expect(pay?.body).toMatchObject({ amount: 9900, paymentFlow: { subscriptionDetails: { authWorkflowType: PhonePeAuthWorkflowType.Transaction } } });
  });

  it('verifyCheckout before the customer finished is not authorised and starts nothing; after it, it activates the schedule', async () => {
    const t = setupPhonePe();
    await t.create();
    const early = await t.subs.verifyCheckout(Provider.PhonePe, { merchantSubscriptionId: PP_REFERENCE }, { expectedSubscriptionId: PP_REFERENCE });
    expect(early.authorized).toBe(false);
    expect((await t.scheduler.get(t.scheduleId))?.status).toBe(ScheduleStatus.PendingAuthorization);

    // The browser supplies the id: the result of someone else's subscription is refused when the caller says what it expected.
    // (A genuinely authorised mandate of ANOTHER subscription: its return is real but not the one expected.)
    await t.subs.create(Provider.PhonePe, { reference: 'pp_other', plan: { name: 'Other', amount: PP_AMOUNT, interval: { unit: IntervalUnit.Month, count: 1 } }, customer: CUSTOMER, startAt: PP_DUE });
    t.fake.authorise('pp_other');
    const other = await rejection(() => t.subs.verifyCheckout(Provider.PhonePe, { merchantSubscriptionId: 'pp_other' }, { expectedSubscriptionId: PP_REFERENCE }));
    expect(other.code).toBe(ErrorCode.SignatureInvalid);
    expect((await t.scheduler.get(t.scheduleId))?.status).toBe(ScheduleStatus.PendingAuthorization);

    const verified = await t.authoriseAndVerify();
    expect(verified).toMatchObject({ authorized: true, subscriptionId: PP_REFERENCE, status: SubscriptionStatus.Active });
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ status: ScheduleStatus.Active, subscriptionId: PP_REFERENCE });
  });
});

describe('PhonePe through the facade and the scheduler: one order id from notification to debit', () => {
  it('notifies 48 hours ahead, redeems on the due date with the SAME order id, and the scheduler adopted the dictated id', async () => {
    const t = setupPhonePe();
    await t.create();
    await t.authoriseAndVerify();

    expect((await t.tickAt(plusHours(PP_DUE, -49))).notified).toBe(0);
    expect((await t.tickAt(plusHours(PP_DUE, -48))).notified).toBe(1);
    const notificationId = notificationIdFor(t.scheduleId, 0, 1, 1);
    expect(t.fake.notifyRequests).toEqual([notificationId]);
    // The id is persisted with the notification, before any charge call.
    expect(await t.cycle(0)).toMatchObject({ status: CycleStatus.Notified, notificationId, chargeId: notificationId });
    expect(t.fake.redeemRequests).toEqual([]);
    expect(t.fake.orders.get(notificationId)).toMatchObject({ kind: 'redemption', state: PhonePeOrderState.Notified, amount: PP_AMOUNT });

    // Before the due date: nothing. (PhonePe would also refuse before notifiedAt + 24 hours.)
    expect((await t.tickAt(plusHours(PP_DUE, -1))).charged).toBe(0);
    const due = await t.tickAt(PP_DUE);
    expect(due).toMatchObject({ charged: 1, errors: [] });
    expect(t.fake.redeemRequests).toEqual([notificationId]);
    expect(t.fake.debits.size).toBe(1);
    // The id the scheduler would have derived itself is never sent.
    expect(t.fake.redeemRequests).not.toContain(chargeIdFor(t.scheduleId, 0, 1));
    expect(await t.cycle(0)).toMatchObject({ status: CycleStatus.AwaitingConfirmation, chargeId: notificationId });
  });

  it('webhook-driven settlement: charged -> succeeded, a redelivery changes nothing, and the next cycle uses a new order id', async () => {
    const t = setupPhonePe();
    await redeemFirstCycle(t);
    const first = notificationIdFor(t.scheduleId, 0, 1, 1);
    t.fake.settle(first, 'succeeded');
    const events = await t.subs.webhooks.handle(Provider.PhonePe, t.fake.debitWebhook(first, 'succeeded'));
    expect(events[0]).toMatchObject({ type: EventType.SubscriptionCharged, subscriptionId: PP_REFERENCE, charge: { reference: first } });
    expect(await t.cycle(0)).toMatchObject({ status: CycleStatus.Succeeded, chargeId: first });
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ paidCycles: 1 });
    await t.subs.webhooks.handle(Provider.PhonePe, t.fake.debitWebhook(first, 'succeeded'));
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ paidCycles: 1 });

    // Cycle 2: its own notification and its own order, a month later.
    await t.tickAt(plusHours(PP_SECOND_DUE, -48));
    const second = notificationIdFor(t.scheduleId, 1, 1, 1);
    expect(second).not.toBe(first);
    await t.tickAt(PP_SECOND_DUE);
    expect(t.fake.redeemRequests).toEqual([first, second]);
    expect(t.fake.debits.size).toBe(2);
  });

  it('settles by polling when no webhook arrives (getCharge reads the redeemed order)', async () => {
    const t = setupPhonePe();
    await redeemFirstCycle(t);
    const id = notificationIdFor(t.scheduleId, 0, 1, 1);
    t.fake.settle(id, 'succeeded');
    expect(await t.tickAt(plusHours(PP_DUE, 1))).toMatchObject({ reconciled: 1, succeeded: 1 });
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ paidCycles: 1 });
    const charge = await t.subs.charges.get(Provider.PhonePe, PP_REFERENCE, id);
    expect(charge).toMatchObject({ status: ChargeStatus.Succeeded, amount: PP_AMOUNT });
  });

  it('a failed debit counts one attempt; attempt 2 is notified again under a NEW order id and redeemed 24 hours later with it', async () => {
    const t = setupPhonePe();
    await redeemFirstCycle(t);
    const first = notificationIdFor(t.scheduleId, 0, 1, 1);
    t.fake.settle(first, 'failed');
    await t.subs.webhooks.handle(Provider.PhonePe, t.fake.debitWebhook(first, 'failed'));
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ retrying: true });

    // The retry: 24 hours after the failure the scheduler notifies again (attempt 2), and debits once the notice has passed.
    await t.tickAt(plusHours(PP_DUE, 24));
    const second = notificationIdFor(t.scheduleId, 0, 2, 1);
    expect(t.fake.notifyRequests).toEqual([first, second]);
    expect(await t.cycle(0)).toMatchObject({ attempt: 2, chargeId: second });
    await t.tickAt(plusHours(PP_DUE, 48));
    expect(t.fake.redeemRequests).toEqual([first, second]);
    t.fake.settle(second, 'succeeded');
    await t.subs.webhooks.handle(Provider.PhonePe, t.fake.debitWebhook(second, 'succeeded'));
    expect(await t.cycle(0)).toMatchObject({ status: CycleStatus.Succeeded, chargeId: second });
  });
});

describe('PhonePe: a debit whose outcome is unknown (PhonePe reads before it writes)', () => {
  it('a lost ANSWER: the debit exists, getCharge finds the redeemed order, and PhonePe is never asked to redeem twice', async () => {
    const t = setupPhonePe();
    await t.create();
    await t.authoriseAndVerify();
    await t.tickAt(plusHours(PP_DUE, -48));
    t.fake.dropNextRedeem = 'answer';
    const lost = await t.tickAt(PP_DUE);
    expect(lost.errors[0]?.code).toBe(ErrorCode.OutcomeUnknown);
    expect((await t.cycle(0))?.status).toBe(CycleStatus.Charging);
    const later = await t.tickAt(plusHours(PP_DUE, 0.1));
    expect(later.reconciled).toBe(1);
    expect((await t.cycle(0))?.status).toBe(CycleStatus.AwaitingConfirmation);
    expect(t.fake.redeemRequests).toHaveLength(1);
    expect(t.fake.debits.size).toBe(1);
  });

  it('a lost REQUEST: getCharge answers NOT_FOUND (a notification-only order), the scheduler waits out the grace period, sends the SAME id again, once, and no attempt is burnt', async () => {
    const events: SchedulerEvent[] = [];
    const t = setupPhonePe({ onEvent: (event) => events.push(event) });
    await t.create();
    await t.authoriseAndVerify();
    await t.tickAt(plusHours(PP_DUE, -48));
    const id = notificationIdFor(t.scheduleId, 0, 1, 1);
    t.fake.dropNextRedeem = 'request';
    await t.tickAt(PP_DUE);
    // Inside the grace period NOT_FOUND proves nothing: no second redeem.
    expect(await t.tickAt(plusHours(PP_DUE, 0.1))).toMatchObject({ reconciled: 1, charged: 0 });
    expect(t.fake.redeemRequests).toEqual([id]);
    // After it, the same order is redeemed (PhonePe still holds it as NOTIFIED).
    expect(await t.tickAt(plusHours(PP_DUE, 1))).toMatchObject({ charged: 1 });
    expect(t.fake.redeemRequests).toEqual([id, id]);
    expect(t.fake.debits.size).toBe(1);
    expect(await t.cycle(0)).toMatchObject({ attempt: 1, status: CycleStatus.AwaitingConfirmation, chargeId: id });
    expect(events.map((event) => event.type)).toContain(SchedulerEventType.ChargeOutcomeOverdue);
  });

  it('the debit webhook arrives while the cycle is still `charging` (the answer was lost): it settles the cycle, with no second redeem', async () => {
    const t = setupPhonePe();
    await t.create();
    await t.authoriseAndVerify();
    await t.tickAt(plusHours(PP_DUE, -48));
    const id = notificationIdFor(t.scheduleId, 0, 1, 1);
    t.fake.dropNextRedeem = 'answer';
    await t.tickAt(PP_DUE);
    expect((await t.cycle(0))?.status).toBe(CycleStatus.Charging);
    t.fake.settle(id, 'succeeded');
    await t.subs.webhooks.handle(Provider.PhonePe, t.fake.debitWebhook(id, 'succeeded'));
    expect(await t.cycle(0)).toMatchObject({ status: CycleStatus.Succeeded });
    await t.tickAt(plusHours(PP_DUE, 2));
    expect(t.fake.redeemRequests).toEqual([id]);
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ paidCycles: 1 });
  });

  it('a lost request that is re-sent after the notification expired: the refusal proves nothing, getCharge reports the expired notification as a failed debit, and attempt 2 starts with a fresh notification', async () => {
    const t = setupPhonePe();
    await t.create();
    await t.authoriseAndVerify();
    await t.tickAt(plusHours(PP_DUE, -48));
    t.fake.dropNextRedeem = 'request';
    await t.tickAt(plusHours(PP_DUE, 47));
    expect((await t.cycle(0))?.status).toBe(CycleStatus.Charging);
    // The window closes at due + 48h; the grace period ends at due + 47.5h.
    await t.tickAt(plusHours(PP_DUE, 49));
    await t.tickAt(plusHours(PP_DUE, 50));
    expect(t.fake.debits.size).toBe(0);
    expect(await t.cycle(0)).toMatchObject({ attempt: 2 });
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ retrying: true });
  });

  it('a status API that lags behind the debit (the order still reads NOTIFIED) never leads to a second debit', async () => {
    const t = setupPhonePe();
    await t.create();
    await t.authoriseAndVerify();
    await t.tickAt(plusHours(PP_DUE, -48));
    t.fake.dropNextRedeem = 'answer';
    await t.tickAt(PP_DUE);
    t.fake.hideUntilMs = Date.parse(plusHours(PP_DUE, 3));
    // Past the grace period, but PhonePe's status still says NOTIFIED: the redeem is sent again and PhonePe refuses the duplicate.
    await t.tickAt(plusHours(PP_DUE, 1));
    expect(t.fake.debits.size).toBe(1);
    // The refusal of a re-sent id proves nothing; once the status catches up the debit is simply found.
    expect((await t.cycle(0))?.attempt).toBe(1);
    await t.tickAt(plusHours(PP_DUE, 4));
    expect(t.fake.debits.size).toBe(1);
    expect((await t.cycle(0))?.attempt).toBe(1);
    expect((await t.cycle(0))?.status).toBe(CycleStatus.AwaitingConfirmation);
  });

  it('a scheduler that was down past the notification window: the debit is refused for good (nothing is sent), counts as a failed attempt, and a fresh notification follows', async () => {
    const t = setupPhonePe();
    await t.create();
    await t.authoriseAndVerify();
    await t.tickAt(plusHours(PP_DUE, -48));
    const first = notificationIdFor(t.scheduleId, 0, 1, 1);
    // The fake's window closes 72 hours after it opens (notifiedAt + 96h = due + 48h): this tick is 54 hours past the due date.
    await t.tickAt(plusHours(PP_DUE, 54));
    expect(t.fake.redeemRequests).toEqual([]);
    expect(t.fake.debits.size).toBe(0);
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ retrying: true });
    expect(await t.cycle(0)).toMatchObject({ attempt: 2 });
    expect(first).not.toBe(notificationIdFor(t.scheduleId, 0, 2, 1));
  });
});

describe('PhonePe: a notification whose answer was lost', () => {
  it('the same notification id is sent again, PhonePe is asked about the order first, and only one notification exists', async () => {
    let lose = false;
    const t = setupPhonePe({
      wrap: (inner) => async (url, init) => {
        const response = await inner(url, init);
        if (lose && new URL(url).pathname.endsWith(PhonePePath.Notify)) {
          lose = false;
          throw new TypeError('fetch failed');
        }
        return response;
      },
    });
    await t.create();
    await t.authoriseAndVerify();
    lose = true;
    const first = await t.tickAt(plusHours(PP_DUE, -48));
    expect(first.notified).toBe(0);
    expect(first.errors).toHaveLength(1);
    expect(await t.cycle(0)).toMatchObject({ status: CycleStatus.Pending });
    expect((await t.tickAt(plusHours(PP_DUE, -47))).notified).toBe(1);
    const id = notificationIdFor(t.scheduleId, 0, 1, 1);
    expect(t.fake.notifyRequests).toEqual([id]);
    expect(await t.cycle(0)).toMatchObject({ status: CycleStatus.Notified, chargeId: id });
    // The window is counted from the FIRST notification (the one whose answer was lost), 47 hours ago: the debit is still on time.
    await t.tickAt(PP_DUE);
    expect(t.fake.redeemRequests).toEqual([id]);
  });
});

describe('PhonePe: a redeem that fails after PhonePe executed it', () => {
  it.each([
    ['a 500 with an error body', () => new Response(JSON.stringify({ code: 'INTERNAL_SERVER_ERROR', message: 'Something went wrong' }), { status: 500 })],
    ['a 502 with an HTML page', () => new Response('<html>Bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } })],
    ['a 429 rate limit', () => new Response(JSON.stringify({ code: 'TOO_MANY_REQUESTS' }), { status: 429 })],
  ])('%s is an unknown outcome: the SAME order id is reconciled, no attempt is burnt, nothing is debited twice', async (_name, failure) => {
    let armed = false;
    const t = setupPhonePe({
      wrap: (inner) => async (url, init) => {
        const response = await inner(url, init);
        if (armed && new URL(url).pathname.endsWith(PhonePePath.Redeem)) {
          armed = false;
          return failure();
        }
        return response;
      },
    });
    await t.create();
    await t.authoriseAndVerify();
    await t.tickAt(plusHours(PP_DUE, -48));
    armed = true;
    const result = await t.tickAt(PP_DUE);
    expect(result.errors[0]?.code).not.toBe(ErrorCode.Validation);
    expect(await t.cycle(0)).toMatchObject({ attempt: 1, status: CycleStatus.Charging });
    await t.tickAt(plusHours(PP_DUE, 0.1));
    await t.tickAt(plusHours(PP_DUE, 1));
    expect(t.fake.debits.size).toBe(1);
    expect(t.fake.redeemRequests.length).toBeLessThanOrEqual(2);
    expect(await t.cycle(0)).toMatchObject({ attempt: 1, status: CycleStatus.AwaitingConfirmation });
  });
});

describe('PhonePe: the access token is rejected in the middle of a debit', () => {
  it('a 401 on the redeem refreshes the token and repeats the read-then-write flow: one debit, no failed attempt', async () => {
    let revokeOnRedeem = false;
    const t: Setup = setupPhonePe({
      wrap: (inner) => async (url, init) => {
        if (revokeOnRedeem && new URL(url).pathname.endsWith(PhonePePath.Redeem)) {
          revokeOnRedeem = false;
          t.fake.revokeTokens();
        }
        return inner(url, init);
      },
    });
    await t.create();
    await t.authoriseAndVerify();
    await t.tickAt(plusHours(PP_DUE, -48));
    const issued = t.fake.tokensIssued;
    revokeOnRedeem = true;
    expect(await t.tickAt(PP_DUE)).toMatchObject({ charged: 1, errors: [] });
    expect(t.fake.tokensIssued).toBeGreaterThan(issued);
    expect(t.fake.debits.size).toBe(1);
    expect(await t.cycle(0)).toMatchObject({ attempt: 1, status: CycleStatus.AwaitingConfirmation });
  });
});

describe('PhonePe over the HTTP handler: capabilities', () => {
  it('GET /v1/phonepe/capabilities is the facade\'s view (pause and resume work through the scheduler) and matches the published schema', async () => {
    const t = setupPhonePe();
    const call = httpApi(t.subs);
    const reply = await httpExchange(call, OperationId.GetCapabilities, HttpMethod.Get, '/v1/phonepe/capabilities');
    expect(reply.json).toMatchObject({ provider: Provider.PhonePe, pause: true, resume: true, merchantCharges: true, merchantPreDebitNotification: true });
    expect((await httpExchange(call, OperationId.ListProviders, HttpMethod.Get, '/v1/providers')).json.map((entry: { provider: string }) => entry.provider)).toEqual([Provider.PhonePe]);
  });
});

describe('PhonePe: the customer and the merchant change the mandate', () => {
  it('a customer pause in the UPI app pauses the schedule (by the gateway); an un-pause resumes it; billing continues', async () => {
    const t = setupPhonePe();
    await t.create();
    await t.authoriseAndVerify();
    await t.subs.webhooks.handle(Provider.PhonePe, t.fake.mandateWebhook(PP_REFERENCE, 'paused'));
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ status: ScheduleStatus.Paused, pausedBy: SchedulePauser.Gateway, statusReason: ScheduleStatusReason.PausedByGateway });
    expect((await t.subs.get(Provider.PhonePe, PP_REFERENCE)).status).toBe(SubscriptionStatus.Paused);
    // Paused: no notification goes out.
    expect(await t.tickAt(plusHours(PP_DUE, -48))).toMatchObject({ notified: 0 });
    expect(t.fake.notifyRequests).toEqual([]);

    await t.subs.webhooks.handle(Provider.PhonePe, t.fake.mandateWebhook(PP_REFERENCE, 'unpaused'));
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ status: ScheduleStatus.Active });
    expect((await t.tickAt(plusHours(PP_DUE, -40))).notified + (await t.tickAt(plusHours(PP_DUE, -30))).notified).toBeGreaterThanOrEqual(1);
    expect(t.fake.notifyRequests).toHaveLength(1);
  });

  it('a customer pause that outlasts the notification: on resume the stale notification is dropped and a fresh one is sent (no attempt is burnt, no stale order is redeemed)', async () => {
    const t = setupPhonePe();
    await t.create();
    await t.authoriseAndVerify();
    await t.tickAt(plusHours(PP_DUE, -48));
    const stale = notificationIdFor(t.scheduleId, 0, 1, 1);
    t.clock.set(plusHours(PP_DUE, -30));
    await t.subs.webhooks.handle(Provider.PhonePe, t.fake.mandateWebhook(PP_REFERENCE, 'paused'));
    // Three days later the notification's window (open until due + 48h) has closed.
    t.clock.set(plusHours(PP_DUE, 72));
    await t.subs.webhooks.handle(Provider.PhonePe, t.fake.mandateWebhook(PP_REFERENCE, 'unpaused'));
    await t.tickAt(plusHours(PP_DUE, 72));
    await t.tickAt(plusHours(PP_DUE, 73));
    const fresh = t.fake.notifyRequests.filter((id) => id !== stale);
    expect(fresh).toHaveLength(1);
    expect(t.fake.redeemRequests).not.toContain(stale);
    expect(await t.cycle(0)).toMatchObject({ attempt: 1, chargeId: fresh[0] });
    await t.tickAt(plusHours(PP_DUE, 97));
    expect(t.fake.redeemRequests).toEqual(fresh);
    expect(t.fake.debits.size).toBe(1);
  });

  it('a merchant pause is NOT undone by the customer\'s un-pause event', async () => {
    const t = setupPhonePe();
    await t.create();
    await t.authoriseAndVerify();
    const paused = await t.subs.pause(Provider.PhonePe, PP_REFERENCE);
    expect(paused.status).toBe(SubscriptionStatus.Paused);
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ pausedBy: SchedulePauser.Merchant });
    await t.subs.webhooks.handle(Provider.PhonePe, t.fake.mandateWebhook(PP_REFERENCE, 'unpaused'));
    expect((await t.scheduler.get(t.scheduleId))?.status).toBe(ScheduleStatus.Paused);
    // Only the merchant resumes it, and the gateway is never asked (PhonePe has no pause API).
    const resumed = await t.subs.resume(Provider.PhonePe, PP_REFERENCE);
    expect(resumed.status).not.toBe(SubscriptionStatus.Paused);
    expect((await t.scheduler.get(t.scheduleId))?.status).toBe(ScheduleStatus.Active);
  });

  it('a revoke by the customer cancels the schedule (by the gateway) and nothing is notified or debited afterwards', async () => {
    const t = setupPhonePe();
    await t.create();
    await t.authoriseAndVerify();
    t.fake.setSubscriptionState(PP_REFERENCE, PhonePeSubscriptionState.Revoked);
    await t.subs.webhooks.handle(Provider.PhonePe, t.fake.mandateWebhook(PP_REFERENCE, 'revoked'));
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ status: ScheduleStatus.Cancelled, statusReason: ScheduleStatusReason.CancelledByGateway });
    await t.tickAt(plusHours(PP_DUE, -48));
    await t.tickAt(PP_DUE);
    expect(t.fake.notifyRequests).toEqual([]);
    expect(t.fake.redeemRequests).toEqual([]);
  });

  it('cancel through the facade stops billing first and cancels the mandate at PhonePe; cancelling twice is fine', async () => {
    const t = setupPhonePe();
    await t.create();
    await t.authoriseAndVerify();
    await t.tickAt(plusHours(PP_DUE, -48));
    const cancelled = await t.subs.cancel(Provider.PhonePe, PP_REFERENCE);
    expect(cancelled.status).toBe(SubscriptionStatus.Cancelled);
    expect(t.fake.subscriptions.get(PP_REFERENCE)?.state).toBe(PhonePeSubscriptionState.Cancelled);
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ status: ScheduleStatus.Cancelled });
    await t.tickAt(PP_DUE);
    expect(t.fake.redeemRequests).toEqual([]);
    expect((await t.subs.cancel(Provider.PhonePe, PP_REFERENCE)).status).toBe(SubscriptionStatus.Cancelled);
  });

  it('cancelling before the customer authorised cancels the schedule and needs no mandate', async () => {
    const t = setupPhonePe();
    await t.create();
    const cancelled = await t.subs.cancel(Provider.PhonePe, PP_REFERENCE);
    expect(cancelled.status).toBe(SubscriptionStatus.Cancelled);
    expect((await t.scheduler.get(t.scheduleId))?.status).toBe(ScheduleStatus.Cancelled);
  });
});

describe('PhonePe: authorisation without a return visit or a webhook', () => {
  it('the scheduler polls PhonePe: a live mandate activates the schedule, a failed setup order cancels it', async () => {
    const live = setupPhonePe();
    await live.create();
    live.fake.authorise(PP_REFERENCE);
    // The poll runs at most hourly.
    expect((await live.scheduler.get(live.scheduleId))?.status).toBe(ScheduleStatus.PendingAuthorization);
    await live.tickAt(plusHours(PP_DUE, -24 * 18));
    expect((await live.scheduler.get(live.scheduleId))?.status).toBe(ScheduleStatus.Active);

    const failed = setupPhonePe();
    await failed.create();
    const setup = failed.fake.orders.get(setupOrderIdFor(PP_REFERENCE));
    if (!setup) throw new Error('no setup order');
    setup.state = PhonePeOrderState.Failed;
    await failed.tickAt(plusHours(PP_DUE, -24 * 18));
    expect(await failed.scheduler.get(failed.scheduleId)).toMatchObject({ status: ScheduleStatus.Cancelled, statusReason: ScheduleStatusReason.AuthorizationFailed });
  });
});

describe('PhonePe: the setup webhook arrives before the mandate is live', () => {
  it('the setup-completed webhook activates the schedule although the mandate is still ACTIVATION_IN_PROGRESS (verifyCheckout would not); the notification is refused and retried, no debit and no attempt is lost, and billing starts once the mandate is ACTIVE', async () => {
    const events: SchedulerEvent[] = [];
    const t = setupPhonePe({ onEvent: (event) => events.push(event) });
    await t.create();
    t.fake.authorise(PP_REFERENCE);
    t.fake.setSubscriptionState(PP_REFERENCE, PhonePeSubscriptionState.ActivationInProgress);
    // The facade's own check refuses to start billing on a mandate that is not live yet ...
    const verified = await t.subs.verifyCheckout(Provider.PhonePe, { merchantSubscriptionId: PP_REFERENCE }, { expectedSubscriptionId: PP_REFERENCE });
    expect(verified.authorized).toBe(false);
    expect((await t.scheduler.get(t.scheduleId))?.status).toBe(ScheduleStatus.PendingAuthorization);
    // ... but the setup webhook starts it.
    const hook = {
      rawBody: JSON.stringify({
        event: 'subscription.setup.order.completed',
        payload: { merchantOrderId: setupOrderIdFor(PP_REFERENCE), state: 'COMPLETED', amount: 200, paymentFlow: { type: 'SUBSCRIPTION_SETUP', merchantSubscriptionId: PP_REFERENCE } },
      }),
      headers: { authorization: WEBHOOK_AUTHORIZATION },
    };
    await t.subs.webhooks.handle(Provider.PhonePe, hook);
    expect((await t.scheduler.get(t.scheduleId))?.status).toBe(ScheduleStatus.Active);

    const early = await t.tickAt(plusHours(PP_DUE, -48));
    expect(early.notified).toBe(0);
    expect(events.map((event) => event.type)).toContain(SchedulerEventType.NotificationFailed);
    expect(t.fake.redeemRequests).toEqual([]);
    expect(await t.cycle(0)).toMatchObject({ attempt: 1, status: CycleStatus.Pending });

    t.fake.setSubscriptionState(PP_REFERENCE, PhonePeSubscriptionState.Active);
    expect((await t.tickAt(plusHours(PP_DUE, -47))).notified).toBe(1);
  });
});

describe('PhonePe: plans, ids and the end of the mandate', () => {
  it('a trial delays the first debit; totalCycles ends the schedule after the last collected cycle', async () => {
    const t = setupPhonePe({ totalCycles: 1 });
    const trial = await t.subs.create(Provider.PhonePe, {
      reference: 'pp_trial',
      plan: { name: 'Pro monthly', amount: PP_AMOUNT, interval: { unit: IntervalUnit.Month, count: 1 } },
      customer: CUSTOMER,
      trial: { days: 7 },
    });
    expect(trial).toMatchObject({ startAt: plusHours(t.clock.iso(), 24 * 7), trialEndsAt: plusHours(t.clock.iso(), 24 * 7) });

    await t.create();
    await t.authoriseAndVerify();
    await t.tickAt(plusHours(PP_DUE, -48));
    await t.tickAt(PP_DUE);
    const id = notificationIdFor(t.scheduleId, 0, 1, 1);
    t.fake.settle(id, 'succeeded');
    await t.subs.webhooks.handle(Provider.PhonePe, t.fake.debitWebhook(id, 'succeeded'));
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ status: ScheduleStatus.Completed, paidCycles: 1 });
    await t.tickAt(plusHours(PP_SECOND_DUE, -48));
    expect(t.fake.notifyRequests).toEqual([id]);
  });

  it('an id PhonePe would refuse is a VALIDATION error before any gateway call and registers no schedule; a gateway-scheduled plan is UNSUPPORTED', async () => {
    const t = setupPhonePe();
    const plan = { name: 'Pro monthly', amount: PP_AMOUNT, interval: { unit: IntervalUnit.Month, count: 1 } };
    const bad = await rejection(() => t.subs.create(Provider.PhonePe, { reference: 'has a space', plan, customer: CUSTOMER, startAt: PP_DUE }));
    expect(bad.code).toBe(ErrorCode.Validation);
    const gateway = await rejection(() => t.subs.create(Provider.PhonePe, { reference: 'pp_gw', plan: { ...plan, scheduling: SchedulingMode.Gateway }, customer: CUSTOMER, startAt: PP_DUE }));
    expect(gateway.code).toBe(ErrorCode.Unsupported);
    expect(t.fake.requests.filter((request) => request.path === PhonePePath.Pay)).toHaveLength(0);
    expect(await t.scheduler.find(Provider.PhonePe, 'has a space')).toBeUndefined();
  });
});

describe('PhonePe: the scheduler\'s debitAtIstTime keeps the debit inside PhonePe\'s non-peak hours', () => {
  it('with debitAtIstTime 22:00 the notification and the redeem both go out at 22:00 IST, and the redeem is inside the notification\'s window', async () => {
    const clock = new Clock(PP_T0);
    const fake = new FakePhonePe(clock.nowMs);
    const subs = createSubscriptions({
      providers: [phonepeProvider(fake.fetch, clock)],
      scheduler: { store: new MemorySchedulerStore({ now: clock.nowMs }), now: clock.now, debitAtIstTime: '22:00' },
    });
    await subs.create(Provider.PhonePe, {
      reference: PP_REFERENCE,
      plan: { name: 'Pro monthly', amount: PP_AMOUNT, interval: { unit: IntervalUnit.Month, count: 1 } },
      customer: CUSTOMER,
      startAt: PP_DUE,
    });
    fake.authorise(PP_REFERENCE);
    await subs.verifyCheckout(Provider.PhonePe, { merchantSubscriptionId: PP_REFERENCE }, { expectedSubscriptionId: PP_REFERENCE });
    // 22:00 IST on 20 January is 16:30 UTC.
    const dueAt = '2026-01-20T16:30:00.000Z';
    clock.set(plusHours(dueAt, -49));
    expect((await subs.tick()).notified).toBe(0);
    clock.set(plusHours(dueAt, -48));
    expect((await subs.tick()).notified).toBe(1);
    clock.set(plusHours(dueAt, -1));
    expect((await subs.tick()).charged).toBe(0);
    clock.set(dueAt);
    expect(await subs.tick()).toMatchObject({ charged: 1, errors: [] });
    const [id] = fake.redeemRequests;
    expect(new Date(fake.orders.get(id as string)?.redeemedAt ?? 0).toISOString()).toBe(dueAt);
  });
});

describe('PhonePe: a subscription that starts now (no startAt, no trial)', () => {
  it('the customer authorises two hours later: the first notification goes out at once and the debit 24 hours after it, never sooner', async () => {
    const t = setupPhonePe({ startAt: null });
    const created = await t.create();
    expect(created.startAt).toBe(PP_T0);
    t.clock.set(plusHours(PP_T0, 2));
    await t.authoriseAndVerify();
    expect(await t.tickAt(plusHours(PP_T0, 2))).toMatchObject({ notified: 1, charged: 0 });
    expect((await t.tickAt(plusHours(PP_T0, 25))).charged).toBe(0);
    expect(await t.tickAt(plusHours(PP_T0, 26))).toMatchObject({ charged: 1, errors: [] });
    expect(t.fake.debits.size).toBe(1);
    expect(await t.cycle(0)).toMatchObject({ attempt: 1, status: CycleStatus.AwaitingConfirmation });
  });
});

describe('PhonePe: changing the price of a VARIABLE mandate', () => {
  // DEFECT (low): a VARIABLE PhonePe mandate (plan.maxAmount above plan.amount) lets the merchant notify any amount up to the
  // ceiling, so a price change within it lives in the schedule alone. `PhonePeProvider.updateSubscription` refuses every
  // update, and the facade asks the gateway first, so the schedule cannot be re-priced.
  it.fails('update({ amount }) within the ceiling re-prices the schedule: the next notification carries the new amount', async () => {
    const t = setupPhonePe();
    const subscription = await t.subs.create(Provider.PhonePe, {
      reference: PP_REFERENCE,
      plan: { name: 'Pro monthly', amount: PP_AMOUNT, maxAmount: 99900, interval: { unit: IntervalUnit.Month, count: 1 } },
      customer: CUSTOMER,
      startAt: PP_DUE,
    });
    await t.authoriseAndVerify();
    const updated = await t.subs.update(Provider.PhonePe, subscription.id, { amount: 59900 });
    expect(updated.amount).toBe(59900);
    await t.tickAt(plusHours(PP_DUE, -48));
    expect(t.fake.orders.get(notificationIdFor(t.scheduleId, 0, 1, 1))?.amount).toBe(59900);
  });
});

describe('PhonePe: refunds', () => {
  it('refunds a completed debit in full and in part through the facade, and refuses one that has not completed', async () => {
    const t = setupPhonePe();
    await redeemFirstCycle(t);
    const id = notificationIdFor(t.scheduleId, 0, 1, 1);
    const early = await rejection(() => t.subs.charges.refund(Provider.PhonePe, { subscriptionId: PP_REFERENCE, chargeId: id, refundId: 'rf_early' }));
    expect(early.code).toBe(ErrorCode.Validation);

    t.fake.settle(id, 'succeeded');
    const full = await t.subs.charges.refund(Provider.PhonePe, { subscriptionId: PP_REFERENCE, chargeId: id, refundId: 'rf_full' });
    expect(full).toMatchObject({ amount: PP_AMOUNT, chargeId: id, status: RefundStatus.Pending });
    const partial = await t.subs.charges.refund(Provider.PhonePe, { subscriptionId: PP_REFERENCE, chargeId: id, refundId: 'rf_part', amount: 1000 });
    expect(partial.amount).toBe(1000);
    const bodies = t.fake.requests.filter((request) => request.path === PhonePePath.Refund).map((request) => request.body);
    expect(bodies[0]).toMatchObject({ merchantRefundId: 'rf_full', originalMerchantOrderId: id, amount: PP_AMOUNT });
  });
});

describe('PhonePe over the HTTP handler', () => {
  it('create -> verify -> tick -> raw webhook with the Authorization header; a wrong or missing header is a 401 and changes nothing', async () => {
    const t = setupPhonePe();
    const call = httpApi(t.subs);
    const created = await httpExchange(call, OperationId.CreateSubscription, HttpMethod.Post, '/v1/phonepe/subscriptions', {
      reference: PP_REFERENCE,
      plan: { name: 'Pro monthly', amount: PP_AMOUNT, interval: { unit: IntervalUnit.Month, count: 1 } },
      customer: CUSTOMER,
      startAt: PP_DUE,
    });
    expect(created.json.checkout).toMatchObject({ kind: CheckoutKind.Redirect });

    t.fake.authorise(PP_REFERENCE);
    const verified = await httpExchange(call, OperationId.VerifyCheckout, HttpMethod.Post, '/v1/phonepe/checkout/verify', {
      result: { merchantSubscriptionId: PP_REFERENCE },
      expectedSubscriptionId: PP_REFERENCE,
    });
    expect(verified.json).toMatchObject({ authorized: true, subscriptionId: PP_REFERENCE });

    t.clock.set(plusHours(PP_DUE, -48));
    expect((await httpExchange(call, OperationId.RunSchedulerTick, HttpMethod.Post, '/v1/scheduler/tick')).json.notified).toBe(1);
    t.clock.set(PP_DUE);
    expect((await httpExchange(call, OperationId.RunSchedulerTick, HttpMethod.Post, '/v1/scheduler/tick')).json.charged).toBe(1);
    const id = notificationIdFor(t.scheduleId, 0, 1, 1);
    t.fake.settle(id, 'succeeded');
    const request = t.fake.debitWebhook(id, 'succeeded');

    const headers = { [HeaderName.ContentType]: ContentType.Json };
    const wrong = await call(HttpMethod.Post, '/v1/phonepe/webhooks', { auth: false, body: request.rawBody, headers: { ...headers, [HeaderName.Authorization]: 'deadbeef' } });
    expect(wrong.status).toBe(HttpStatus.Unauthorized);
    const missing = await call(HttpMethod.Post, '/v1/phonepe/webhooks', { auth: false, body: request.rawBody, headers });
    expect(missing.status).toBe(HttpStatus.Unauthorized);
    expect((await t.scheduler.get(t.scheduleId))?.paidCycles).toBe(0);

    const good = await call(HttpMethod.Post, '/v1/phonepe/webhooks', { auth: false, body: request.rawBody, headers: { ...headers, [HeaderName.Authorization]: WEBHOOK_AUTHORIZATION } });
    expect(good).toMatchObject({ status: HttpStatus.Ok, json: { received: 1 } });
    expect((await t.scheduler.get(t.scheduleId))?.paidCycles).toBe(1);
    const got = await httpExchange(call, OperationId.GetSubscription, HttpMethod.Get, `/v1/phonepe/subscriptions/${PP_REFERENCE}`);
    expect(got.json).toMatchObject({ paidCycles: 1 });
  });
});

export type { Wired };
