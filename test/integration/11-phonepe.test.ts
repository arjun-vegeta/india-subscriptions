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
import { PP_AMOUNT, PP_DUE, PP_REFERENCE, PP_SECOND_DUE, setupPhonePe } from './fakes.js';
import { WEBHOOK_AUTHORIZATION } from '../phonepe/helpers.js';
import { CUSTOMER, httpApi, httpExchange, plusHours, rejection, type Wired } from './helpers.js';
import type { SchedulerEvent } from '../../src/scheduler/index.js';

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
