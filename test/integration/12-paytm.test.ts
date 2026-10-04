/**
 * Seam 12: the real Paytm adapter + the real facade + the real BillingScheduler + the HTTP handler. Paytm's own stateful fake
 * (test/paytm/fake-gateway.ts) plays the gateway: it verifies the checksum of every request with an independent implementation,
 * wants a pre-notify that the renew names, at least 24 hours ahead, refuses a repeated renew order id (325) and answers
 * NO_RECORD_FOUND for an order it never saw. Webhooks are form-encoded with Paytm's CHECKSUMHASH, built independently.
 *
 * Two modes: MERCHANT (the default: this library notifies and debits) and GATEWAY (`plan.scheduling: 'gateway'`: Paytm collects,
 * no schedule is registered and the facade delegates everything to Paytm's APIs).
 */
import { describe, expect, it } from 'vitest';
import { ChargeStatus, CheckoutKind, ContentType, ErrorCode, EventType, HeaderName, HttpMethod, IntervalUnit, Provider, RefundStatus, SchedulingMode, SubscriptionStatus } from '../../src/constants.js';
import { PaytmPath, PaytmPaymentMode } from '../../src/providers/paytm/constants.js';
import { CycleStatus, SchedulePauser, ScheduleStatus, ScheduleStatusReason, SchedulerEventType, chargeIdFor, notificationIdFor } from '../../src/scheduler/index.js';
import type { SchedulerEvent } from '../../src/scheduler/index.js';
import { HttpStatus, OperationId } from '../../src/server/index.js';
import { MID as PAYTM_MID, formBody, signForm, webhookRequest } from '../paytm/helpers.js';
import { PT_AMOUNT, PT_DUE, PT_REFERENCE, PT_SECOND_DUE, PT_T0, setupPaytm } from './fakes.js';
import { CUSTOMER, httpApi, httpExchange, plusHours, rejection } from './helpers.js';

type Setup = ReturnType<typeof setupPaytm>;

/** The customer authorises (the signed callback goes through `verifyCheckout`); returns the created subscription. */
async function authorised(t: Setup) {
  const subscription = await t.create();
  const verified = await t.authoriseAndVerify(subscription);
  expect(verified.authorized).toBe(true);
  return subscription;
}

/** One debit raised: notified 48 hours ahead, renewed on the due date. */
async function renewFirstCycle(t: Setup) {
  const subscription = await authorised(t);
  await t.tickAt(plusHours(PT_DUE, -48));
  await t.tickAt(PT_DUE);
  return subscription;
}

const modifyCalls = (t: Setup) => t.fake.requests.filter((request) => request.path === PaytmPath.ModifyStatus);

describe('Paytm merchant mode through the facade and the scheduler', () => {
  it('create registers a schedule that waits; a checksum-signed callback activates it by the subscription id Paytm gave', async () => {
    const t = setupPaytm();
    const subscription = await t.create();
    expect(subscription).toMatchObject({
      reference: PT_REFERENCE,
      scheduling: SchedulingMode.Merchant,
      amount: PT_AMOUNT,
      interval: { unit: IntervalUnit.Month, count: 1 },
      startAt: PT_DUE,
      checkout: { kind: CheckoutKind.FormPost },
    });
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ status: ScheduleStatus.PendingAuthorization, subscriptionId: subscription.id });
    expect((await t.tickAt(plusHours(PT_DUE, -48))).notified).toBe(0);
    expect(t.fake.notifications).toHaveLength(0);

    // A callback whose checksum does not verify (or that is for another subscription) starts nothing.
    const callback = t.fake.authorise(subscription);
    const forged = await rejection(() => t.subs.verifyCheckout(Provider.Paytm, { ...callback, TXNAMOUNT: '3.00' }, { expectedSubscriptionId: subscription.id }));
    expect(forged.code).toBe(ErrorCode.SignatureInvalid);
    expect((await t.scheduler.get(t.scheduleId))?.status).toBe(ScheduleStatus.PendingAuthorization);
    const wrongOne = await rejection(() => t.subs.verifyCheckout(Provider.Paytm, callback, { expectedSubscriptionId: 'somebody_else' }));
    expect(wrongOne.code).toBe(ErrorCode.SignatureInvalid);

    const verified = await t.subs.verifyCheckout(Provider.Paytm, callback, { expectedSubscriptionId: subscription.id });
    expect(verified).toMatchObject({ authorized: true, subscriptionId: subscription.id, reference: PT_REFERENCE, status: SubscriptionStatus.Active });
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ status: ScheduleStatus.Active });
  });

  it('the merchant may pass its own reference as expectedSubscriptionId; a FAILED callback (a declined first payment) is not an authorisation and starts nothing', async () => {
    const t = setupPaytm();
    const subscription = await t.create();
    const failed = signForm({
      MID: PAYTM_MID,
      TXNID: 'AUTH_FAILED',
      ORDERID: PT_REFERENCE,
      TXNAMOUNT: '1.00',
      CURRENCY: 'INR',
      STATUS: 'TXN_FAILURE',
      RESPCODE: '227',
      RESPMSG: 'Your payment has been declined by your bank.',
      TXNDATE: '2026-01-01 10:32:00.0',
      PAYMENTMODE: 'UPI',
      SUBS_ID: subscription.id,
    });
    const declined = await t.subs.verifyCheckout(Provider.Paytm, failed, { expectedSubscriptionId: PT_REFERENCE });
    expect(declined).toMatchObject({ authorized: false, status: SubscriptionStatus.Failed });
    expect((await t.scheduler.get(t.scheduleId))?.status).toBe(ScheduleStatus.PendingAuthorization);
    const retry = await t.subs.verifyCheckout(Provider.Paytm, t.fake.authorise(subscription), { expectedSubscriptionId: PT_REFERENCE });
    expect(retry.authorized).toBe(true);
    expect((await t.scheduler.get(t.scheduleId))?.status).toBe(ScheduleStatus.Active);
  });

  it('pre-notifies 48 hours ahead with the scheduler\'s notification id, renews on the due date naming that pre-notify, and the debit stays pending until Paytm says', async () => {
    const t = setupPaytm();
    await authorised(t);
    expect((await t.tickAt(plusHours(PT_DUE, -49))).notified).toBe(0);
    expect((await t.tickAt(plusHours(PT_DUE, -48))).notified).toBe(1);
    const notificationId = notificationIdFor(t.scheduleId, 0, 1, 1);
    expect(t.fake.notifications.map((entry) => entry.referenceId)).toEqual([notificationId]);

    expect((await t.tickAt(plusHours(PT_DUE, -1))).charged).toBe(0);
    expect(await t.tickAt(PT_DUE)).toMatchObject({ charged: 1, errors: [] });
    const chargeId = chargeIdFor(t.scheduleId, 0, 1);
    expect(t.fake.renewRequestIds).toEqual([chargeId]);
    expect(chargeId).toMatch(/^[A-Za-z0-9_-]{1,25}$/);
    const renew = t.fake.requests.find((request) => request.path === PaytmPath.RenewSubscription);
    expect(renew?.body).toMatchObject({ orderId: chargeId, prenotifyReferenceId: notificationId });
    // Paytm does not tie the debit's order id to the notification: the scheduler derived it, and keeps it.
    expect(await t.cycle(0)).toMatchObject({ status: CycleStatus.AwaitingConfirmation, chargeId, notificationId });
    expect(t.fake.debits.get(chargeId)?.status).toBe('PENDING');
  });

  it('settles by the payment webhook that carries only the order id: matched through findScheduleByChargeId, redelivery harmless', async () => {
    const t = setupPaytm();
    await renewFirstCycle(t);
    const chargeId = chargeIdFor(t.scheduleId, 0, 1);
    t.fake.settle(chargeId, ChargeStatus.Succeeded);
    t.store.calls.length = 0;
    const events = await t.subs.webhooks.handle(Provider.Paytm, t.fake.paymentWebhook(chargeId, ChargeStatus.Succeeded));
    expect(events[0]).toMatchObject({ type: EventType.SubscriptionCharged, charge: { reference: chargeId } });
    // The event names no subscription: the schedule was found by the debit's id.
    expect(events[0]?.subscriptionId).toBeUndefined();
    expect(t.store.calls).toContain('findScheduleByChargeId');
    expect(await t.cycle(0)).toMatchObject({ status: CycleStatus.Succeeded });
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ paidCycles: 1 });
    await t.subs.webhooks.handle(Provider.Paytm, t.fake.paymentWebhook(chargeId, ChargeStatus.Succeeded));
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ paidCycles: 1 });
    // The second cycle is billed a month later.
    await t.tickAt(plusHours(PT_SECOND_DUE, -48));
    await t.tickAt(PT_SECOND_DUE);
    expect(t.fake.renewRequestIds).toEqual([chargeId, chargeIdFor(t.scheduleId, 1, 1)]);
  });

  it('a payment webhook for an order that is not one of ours (a customer\'s own payment) is ignored', async () => {
    const t = setupPaytm();
    await renewFirstCycle(t);
    const chargeId = chargeIdFor(t.scheduleId, 0, 1);
    const before = await t.scheduler.get(t.scheduleId);
    const foreign = t.fake.paymentWebhook(chargeId, ChargeStatus.Succeeded);
    const body = new URLSearchParams(foreign.rawBody);
    expect(body.get('ORDERID')).toBe(chargeId);
    t.fake.debits.set('unrelated_order', { ...t.fake.debits.get(chargeId)!, orderId: 'unrelated_order' });
    await t.subs.webhooks.handle(Provider.Paytm, t.fake.paymentWebhook('unrelated_order', ChargeStatus.Succeeded));
    expect(await t.scheduler.get(t.scheduleId)).toEqual(before);
    expect((await t.cycle(0))?.status).toBe(CycleStatus.AwaitingConfirmation);
  });

  it('settles by polling when no webhook arrives; a failed debit counts one attempt and attempt 2 is pre-notified again under a new reference and renewed under a new order id', async () => {
    const t = setupPaytm();
    await renewFirstCycle(t);
    const first = chargeIdFor(t.scheduleId, 0, 1);
    t.fake.settle(first, ChargeStatus.Failed);
    expect(await t.tickAt(plusHours(PT_DUE, 1))).toMatchObject({ reconciled: 1 });
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ retrying: true });
    await t.tickAt(plusHours(PT_DUE, 25));
    expect(t.fake.notifications.map((entry) => entry.referenceId)).toEqual([notificationIdFor(t.scheduleId, 0, 1, 1), notificationIdFor(t.scheduleId, 0, 2, 1)]);
    await t.tickAt(plusHours(PT_DUE, 49));
    const second = chargeIdFor(t.scheduleId, 0, 2);
    expect(t.fake.renewRequestIds).toEqual([first, second]);
    expect(second).not.toBe(first);
    t.fake.settle(second, ChargeStatus.Succeeded);
    await t.subs.webhooks.handle(Provider.Paytm, t.fake.paymentWebhook(second, ChargeStatus.Succeeded));
    expect(await t.cycle(0)).toMatchObject({ status: CycleStatus.Succeeded, attempt: 2 });
  });
});

describe('Paytm: a debit whose outcome is unknown (Paytm relies on its duplicate rejection)', () => {
  it('a lost ANSWER: Transaction Status finds the order, nothing is renewed twice', async () => {
    const t = setupPaytm();
    await authorised(t);
    await t.tickAt(plusHours(PT_DUE, -48));
    t.fake.loseNextRenew = 'answer';
    const lost = await t.tickAt(PT_DUE);
    expect(lost.errors[0]?.code).toBe(ErrorCode.OutcomeUnknown);
    expect((await t.cycle(0))?.status).toBe(CycleStatus.Charging);
    expect(await t.tickAt(plusHours(PT_DUE, 0.1))).toMatchObject({ reconciled: 1 });
    expect((await t.cycle(0))?.status).toBe(CycleStatus.AwaitingConfirmation);
    expect(t.fake.renewRequestIds).toHaveLength(1);
    expect(t.fake.debits.size).toBe(1);
  });

  it('the payment webhook arrives while the cycle is still `charging` (the answer was lost): it settles the cycle, with no second renew', async () => {
    const t = setupPaytm();
    await authorised(t);
    await t.tickAt(plusHours(PT_DUE, -48));
    const id = chargeIdFor(t.scheduleId, 0, 1);
    t.fake.loseNextRenew = 'answer';
    await t.tickAt(PT_DUE);
    expect((await t.cycle(0))?.status).toBe(CycleStatus.Charging);
    t.fake.settle(id, ChargeStatus.Succeeded);
    await t.subs.webhooks.handle(Provider.Paytm, t.fake.paymentWebhook(id, ChargeStatus.Succeeded));
    expect(await t.cycle(0)).toMatchObject({ status: CycleStatus.Succeeded });
    await t.tickAt(plusHours(PT_DUE, 2));
    expect(t.fake.renewRequestIds).toEqual([id]);
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ paidCycles: 1 });
  });

  it('a lost REQUEST: NO_RECORD_FOUND is NOT_FOUND, the SAME order id is renewed again after the grace period, once, and no attempt is burnt', async () => {
    const events: SchedulerEvent[] = [];
    const t = setupPaytm({ onEvent: (event) => events.push(event) });
    await authorised(t);
    await t.tickAt(plusHours(PT_DUE, -48));
    t.fake.loseNextRenew = 'request';
    await t.tickAt(PT_DUE);
    const id = chargeIdFor(t.scheduleId, 0, 1);
    expect(await t.tickAt(plusHours(PT_DUE, 0.1))).toMatchObject({ reconciled: 1, charged: 0 });
    expect(t.fake.renewRequestIds).toEqual([id]);
    expect(await t.tickAt(plusHours(PT_DUE, 1))).toMatchObject({ charged: 1 });
    expect(t.fake.renewRequestIds).toEqual([id, id]);
    expect(t.fake.debits.size).toBe(1);
    expect(await t.cycle(0)).toMatchObject({ attempt: 1, status: CycleStatus.AwaitingConfirmation });
    expect(events.map((event) => event.type)).toContain(SchedulerEventType.ChargeOutcomeOverdue);
  });

  it('an answer that was lost AND a status that lags: the re-sent order id is refused as a duplicate (325), which proves nothing; the debit is found once the status catches up, and is never repeated', async () => {
    const t = setupPaytm();
    await authorised(t);
    await t.tickAt(plusHours(PT_DUE, -48));
    t.fake.loseNextRenew = 'answer';
    await t.tickAt(PT_DUE);
    t.fake.hideDebitsUntilMs = Date.parse(plusHours(PT_DUE, 3));
    await t.tickAt(plusHours(PT_DUE, 1));
    expect(t.fake.debits.size).toBe(1);
    expect((await t.cycle(0))?.attempt).toBe(1);
    await t.tickAt(plusHours(PT_DUE, 4));
    expect(t.fake.debits.size).toBe(1);
    expect(await t.cycle(0)).toMatchObject({ attempt: 1, status: CycleStatus.AwaitingConfirmation });
  });
});

describe('Paytm: a pre-notify whose answer was lost, and a bank mandate', () => {
  it('the same reference is sent again; Paytm answers "duplicate reference id", which means the first one got through: accepted, and the renew names it', async () => {
    let lose = false;
    const t = setupPaytm({
      wrap: (inner) => async (url, init) => {
        const response = await inner(url, init);
        if (lose && new URL(url).pathname === PaytmPath.PreNotify) {
          lose = false;
          throw new TypeError('fetch failed');
        }
        return response;
      },
    });
    await authorised(t);
    lose = true;
    const first = await t.tickAt(plusHours(PT_DUE, -48));
    expect(first.notified).toBe(0);
    expect(first.errors).toHaveLength(1);
    expect((await t.tickAt(plusHours(PT_DUE, -47))).notified).toBe(1);
    const id = notificationIdFor(t.scheduleId, 0, 1, 1);
    expect(t.fake.notifications.map((entry) => entry.referenceId)).toEqual([id]);
    await t.tickAt(PT_DUE);
    const renew = t.fake.requests.find((request) => request.path === PaytmPath.RenewSubscription);
    expect(renew?.body).toMatchObject({ prenotifyReferenceId: id });
    expect(t.fake.debits.size).toBe(1);
    expect((await t.cycle(0))?.status).toBe(CycleStatus.AwaitingConfirmation);
  });

  it('a bank (eNACH) mandate needs no pre-notify: none is sent, and the renew names none', async () => {
    const t = setupPaytm();
    t.fake.paymentMode = PaytmPaymentMode.BankMandate;
    await authorised(t);
    expect((await t.tickAt(plusHours(PT_DUE, -48))).notified).toBe(1);
    expect(t.fake.notifications).toHaveLength(0);
    await t.tickAt(PT_DUE);
    const renew = t.fake.requests.find((request) => request.path === PaytmPath.RenewSubscription);
    expect(renew?.body).not.toHaveProperty('prenotifyReferenceId');
    expect(t.fake.debits.size).toBe(1);
  });
});

describe('Paytm: a renew that fails after Paytm accepted it', () => {
  const failures: [string, () => Response][] = [
    ['a 500 with an error body', () => new Response(JSON.stringify({ head: {}, body: { resultInfo: { resultStatus: 'F', resultCode: '501', resultMsg: 'System Error' } } }), { status: 500 })],
    ['a 502 with an HTML page', () => new Response('<html>Bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } })],
    ['a 429 rate limit', () => new Response('{}', { status: 429 })],
    ['a failure code Paytm does not list', () => new Response(JSON.stringify({ head: {}, body: { resultInfo: { resultStatus: 'F', resultCode: '9999', resultMsg: 'Something new' } } }), { status: 200 })],
    ['the documented "System Error" (501)', () => new Response(JSON.stringify({ head: {}, body: { resultInfo: { resultStatus: 'F', resultCode: '501', resultMsg: 'System Error' } } }), { status: 200 })],
  ];
  it.each(failures)('%s is an unknown outcome: the SAME order id is reconciled, no attempt is burnt, nothing is debited twice', async (_name, failure) => {
    let armed = false;
    const t = setupPaytm({
      wrap: (inner) => async (url, init) => {
        const response = await inner(url, init);
        if (armed && new URL(url).pathname === PaytmPath.RenewSubscription) {
          armed = false;
          return failure();
        }
        return response;
      },
    });
    await authorised(t);
    await t.tickAt(plusHours(PT_DUE, -48));
    armed = true;
    await t.tickAt(PT_DUE);
    expect(await t.cycle(0)).toMatchObject({ attempt: 1, status: CycleStatus.Charging });
    await t.tickAt(plusHours(PT_DUE, 0.1));
    await t.tickAt(plusHours(PT_DUE, 1));
    expect(t.fake.debits.size).toBe(1);
    expect(await t.cycle(0)).toMatchObject({ attempt: 1, status: CycleStatus.AwaitingConfirmation });
  });
});

describe('Paytm merchant mode: pause, resume and cancel keep the scheduler in step', () => {
  it('the facade pauses and resumes through the scheduler alone (Paytm\'s modify API is not called) and billing follows', async () => {
    const t = setupPaytm();
    const subscription = await authorised(t);
    const paused = await t.subs.pause(Provider.Paytm, subscription.id);
    expect(paused.status).toBe(SubscriptionStatus.Paused);
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ status: ScheduleStatus.Paused, pausedBy: SchedulePauser.Merchant });
    expect(modifyCalls(t)).toHaveLength(0);
    expect(await t.tickAt(plusHours(PT_DUE, -48))).toMatchObject({ notified: 0 });
    const resumed = await t.subs.resume(Provider.Paytm, subscription.id);
    expect(resumed.status).not.toBe(SubscriptionStatus.Paused);
    expect((await t.tickAt(plusHours(PT_DUE, -47))).notified).toBe(1);
    expect(modifyCalls(t)).toHaveLength(0);
  });

  it('a pause at Paytm (the merchant\'s raw API, or the customer) reaches the schedule through the webhook, and Paytm\'s resume undoes it; a MERCHANT pause stands against it', async () => {
    const t = setupPaytm();
    const subscription = await authorised(t);
    // The raw adapter API: Paytm pauses the mandate, then tells the merchant.
    const raw = await t.subs.provider(Provider.Paytm).pauseSubscription(subscription.id);
    expect(raw.status).toBe(SubscriptionStatus.Paused);
    expect(t.fake.subscriptions.get(subscription.id)?.status).toBe('SUSPENDED');
    await t.subs.webhooks.handle(Provider.Paytm, t.fake.mandateWebhook(EventType.SubscriptionPaused));
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ status: ScheduleStatus.Paused, pausedBy: SchedulePauser.Gateway });
    expect(await t.tickAt(plusHours(PT_DUE, -48))).toMatchObject({ notified: 0 });

    await t.subs.provider(Provider.Paytm).resumeSubscription(subscription.id);
    await t.subs.webhooks.handle(Provider.Paytm, t.fake.mandateWebhook(EventType.SubscriptionResumed));
    expect((await t.scheduler.get(t.scheduleId))?.status).toBe(ScheduleStatus.Active);

    await t.subs.pause(Provider.Paytm, subscription.id);
    await t.subs.webhooks.handle(Provider.Paytm, t.fake.mandateWebhook(EventType.SubscriptionResumed));
    expect((await t.scheduler.get(t.scheduleId))?.status).toBe(ScheduleStatus.Paused);
  });

  it('cancel through the facade stops billing, cancels the mandate at Paytm, and a later cancel webhook is harmless', async () => {
    const t = setupPaytm();
    const subscription = await authorised(t);
    await t.tickAt(plusHours(PT_DUE, -48));
    const cancelled = await t.subs.cancel(Provider.Paytm, subscription.id);
    expect(cancelled.status).toBe(SubscriptionStatus.Cancelled);
    expect(t.fake.subscriptions.get(subscription.id)?.status).toBe('REJECT');
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ status: ScheduleStatus.Cancelled });
    await t.tickAt(PT_DUE);
    expect(t.fake.renewRequestIds).toEqual([]);
    await t.subs.webhooks.handle(Provider.Paytm, t.fake.mandateWebhook(EventType.SubscriptionCancelled));
    expect((await t.scheduler.get(t.scheduleId))?.status).toBe(ScheduleStatus.Cancelled);
    expect((await t.subs.cancel(Provider.Paytm, subscription.id)).status).toBe(SubscriptionStatus.Cancelled);
  });

  it('the customer cancelling at Paytm cancels the schedule (by the gateway)', async () => {
    const t = setupPaytm();
    await authorised(t);
    await t.subs.webhooks.handle(Provider.Paytm, t.fake.mandateWebhook(EventType.SubscriptionCancelled));
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ status: ScheduleStatus.Cancelled, statusReason: ScheduleStatusReason.CancelledByGateway });
  });
});

describe('Paytm merchant mode: the caller holds the reference, not Paytm\'s subscription id', () => {
  it('get, pause, resume and cancel by the reference find the schedule and act on Paytm\'s own id', async () => {
    const t = setupPaytm();
    const subscription = await t.create();
    // Before the customer authorises Paytm may not know the mandate: the schedule answers for it.
    expect(await t.subs.get(Provider.Paytm, PT_REFERENCE)).toMatchObject({ reference: PT_REFERENCE });
    await t.authoriseAndVerify(subscription);
    expect(await t.subs.get(Provider.Paytm, PT_REFERENCE)).toMatchObject({ id: subscription.id, status: expect.stringMatching(/^(trialing|active)$/) });
    expect((await t.subs.pause(Provider.Paytm, PT_REFERENCE)).status).toBe(SubscriptionStatus.Paused);
    expect((await t.subs.resume(Provider.Paytm, PT_REFERENCE)).status).not.toBe(SubscriptionStatus.Paused);
    expect((await t.subs.cancel(Provider.Paytm, PT_REFERENCE)).status).toBe(SubscriptionStatus.Cancelled);
    expect(t.fake.subscriptions.get(subscription.id)?.status).toBe('REJECT');
  });

  it('a mandate cancelled at Paytm whose webhook was lost: a lookup by Paytm\'s id reads the live status and stops the schedule', async () => {
    const t = setupPaytm();
    const subscription = await t.create();
    await t.authoriseAndVerify(subscription);
    const mandate = t.fake.subscriptions.get(subscription.id);
    if (!mandate) throw new Error('no mandate');
    mandate.status = 'REJECT';
    expect((await t.subs.get(Provider.Paytm, subscription.id)).status).toBe(SubscriptionStatus.Cancelled);
    expect((await t.scheduler.get(t.scheduleId))?.status).toBe(ScheduleStatus.Cancelled);
  });

  // `Subscriptions.get` resolves the schedule first for every gateway that can be merchant-scheduled, so a lookup by the
  // merchant's reference reads the live mandate by the id the schedule holds, exactly like a lookup by Paytm's id.
  it('a lookup by the REFERENCE reads the live mandate too: a mandate cancelled or paused at Paytm shows so', async () => {
    const t = setupPaytm();
    const subscription = await t.create();
    await t.authoriseAndVerify(subscription);
    const mandate = t.fake.subscriptions.get(subscription.id);
    if (!mandate) throw new Error('no mandate');
    mandate.status = 'SUSPENDED';
    const paused = await t.subs.get(Provider.Paytm, PT_REFERENCE);
    expect(paused.providerStatus).toBe('SUSPENDED');
    expect(paused.id).toBe(subscription.id);
    mandate.status = 'REJECT';
    expect((await t.subs.get(Provider.Paytm, PT_REFERENCE)).status).toBe(SubscriptionStatus.Cancelled);
  });

  it('in gateway mode the same lookup by reference is NOT_FOUND (there is no schedule to find it by)', async () => {
    const t = setupPaytm({ scheduling: SchedulingMode.Gateway, startAt: '2026-02-01T05:00:00.000Z' });
    await t.create();
    expect((await rejection(() => t.subs.get(Provider.Paytm, PT_REFERENCE))).code).toBe(ErrorCode.NotFound);
  });
});

describe('Paytm gateway mode (Paytm collects)', () => {
  const GATEWAY_START = '2026-02-01T05:00:00.000Z';

  it('no schedule is registered and no store write happens; the facade delegates get, pause, resume and cancel to Paytm\'s APIs', async () => {
    const t = setupPaytm({ scheduling: SchedulingMode.Gateway, startAt: GATEWAY_START });
    const subscription = await t.create();
    expect(subscription.scheduling).toBe(SchedulingMode.Gateway);
    const writes = ['saveSchedule', 'saveCycle', 'acquireLock'];
    expect(t.store.calls.filter((name) => writes.includes(name))).toEqual([]);
    expect(await t.scheduler.find(Provider.Paytm, PT_REFERENCE)).toBeUndefined();

    const verified = await t.authoriseAndVerify(subscription);
    expect(verified.authorized).toBe(true);
    expect(await t.scheduler.find(Provider.Paytm, PT_REFERENCE, subscription.id)).toBeUndefined();

    const got = await t.subs.get(Provider.Paytm, subscription.id);
    expect(got).toMatchObject({ scheduling: SchedulingMode.Gateway, status: SubscriptionStatus.Active });
    // The scheduler has nothing to do for it, however long it runs.
    expect(await t.tickAt(plusHours(GATEWAY_START, -48))).toMatchObject({ notified: 0, charged: 0 });
    expect(t.fake.notifications).toHaveLength(0);
    expect(t.fake.renewRequestIds).toEqual([]);

    const paused = await t.subs.pause(Provider.Paytm, subscription.id);
    expect(paused.status).toBe(SubscriptionStatus.Paused);
    expect(modifyCalls(t).map((request) => request.body.status)).toEqual(['SUSPENDED']);
    const resumed = await t.subs.resume(Provider.Paytm, subscription.id);
    expect(resumed.status).toBe(SubscriptionStatus.Active);
    expect(modifyCalls(t).map((request) => request.body.status)).toEqual(['SUSPENDED', 'ACTIVE']);
    const cancelled = await t.subs.cancel(Provider.Paytm, subscription.id);
    expect(cancelled.status).toBe(SubscriptionStatus.Cancelled);
    expect(t.fake.subscriptions.get(subscription.id)?.status).toBe('REJECT');
    expect(t.store.calls.filter((name) => writes.includes(name))).toEqual([]);
  });

  it('a gateway-mode payment webhook changes no schedule (there is none)', async () => {
    const t = setupPaytm({ scheduling: SchedulingMode.Gateway, startAt: GATEWAY_START });
    const subscription = await t.create();
    await t.authoriseAndVerify(subscription);
    t.fake.debits.set('PTM_GW_ORDER_1', { orderId: 'PTM_GW_ORDER_1', subsId: subscription.id, amount: '499.00', txnId: 'TXN_GW_1', status: 'TXN_SUCCESS', code: '01', message: '', createdAt: 0 });
    const events = await t.subs.webhooks.handle(Provider.Paytm, t.fake.paymentWebhook('PTM_GW_ORDER_1', ChargeStatus.Succeeded));
    expect(events[0]?.type).toBe(EventType.SubscriptionCharged);
    expect(t.store.calls.filter((name) => ['saveSchedule', 'saveCycle'].includes(name))).toEqual([]);
  });
});

describe('Paytm: authorisation without a return visit, and the setup payment', () => {
  it('the scheduler polls Paytm: a live mandate activates the schedule without the callback', async () => {
    const t = setupPaytm();
    const subscription = await t.create();
    t.fake.authorise(subscription);
    await t.tickAt(plusHours(PT_DUE, -24 * 18));
    expect((await t.scheduler.get(t.scheduleId))?.status).toBe(ScheduleStatus.Active);
  });

  it('the payment webhook of the SETUP order (the reference itself, a trial\'s token debit) is not a debit of any cycle', async () => {
    const t = setupPaytm();
    const subscription = await authorised(t);
    const before = await t.scheduler.get(t.scheduleId);
    const form = signForm({
      ORDERID: PT_REFERENCE,
      MID: PAYTM_MID,
      TXNID: 'SETUP_TXN_1',
      TXNAMOUNT: '1.00',
      PAYMENTMODE: 'UPI',
      CURRENCY: 'INR',
      TXNDATE: '2026-01-01 10:32:00.0',
      STATUS: 'TXN_SUCCESS',
      RESPCODE: '01',
      RESPMSG: 'Txn Success',
      GATEWAYNAME: 'PPBLC',
      BANKTXNID: 'BANK_SETUP_1',
    });
    await t.subs.webhooks.handle(Provider.Paytm, webhookRequest(formBody(form)));
    expect(await t.scheduler.get(t.scheduleId)).toEqual(before);
    expect((await t.cycle(0))?.status).toBe(CycleStatus.Pending);
    expect(subscription.id).toBeDefined();
  });

  it('the pre-notify names the debit day on the IST calendar, the day the scheduler then renews on', async () => {
    const t = setupPaytm();
    await renewFirstCycle(t);
    // PT_DUE is 10:00 on 20 January in India.
    expect(t.fake.notifications[0]?.txnDate).toBe('20-01-2026');
  });
});

describe('Paytm: a subscription that starts now (no startAt, no trial)', () => {
  it('the customer authorises two hours later: pre-notified at once, renewed 24 hours after it, never sooner', async () => {
    const t = setupPaytm({ startAt: null });
    const created = await t.create();
    expect(created.startAt).toBe(PT_T0);
    t.clock.set(plusHours(PT_T0, 2));
    await t.authoriseAndVerify(created);
    expect(await t.tickAt(plusHours(PT_T0, 2))).toMatchObject({ notified: 1, charged: 0 });
    expect((await t.tickAt(plusHours(PT_T0, 25))).charged).toBe(0);
    expect(await t.tickAt(plusHours(PT_T0, 26))).toMatchObject({ charged: 1, errors: [] });
    expect(t.fake.debits.size).toBe(1);
    expect(t.fake.debits.get(chargeIdFor(t.scheduleId, 0, 1))?.status).toBe('PENDING');
  });
});

describe('Paytm merchant mode: changing the price', () => {
  // A merchant-collected mandate is VARIABLE (a ceiling only), so a price change within it lives in the schedule.
  it('update({ amount }) within the mandate ceiling re-prices the schedule: the next renew carries the new amount', async () => {
    const t = setupPaytm();
    const subscription = await t.subs.create(Provider.Paytm, {
      reference: PT_REFERENCE,
      plan: { name: 'Pro monthly', amount: PT_AMOUNT, maxAmount: 99900, interval: { unit: IntervalUnit.Month, count: 1 } },
      customer: CUSTOMER,
      startAt: PT_DUE,
    });
    await t.authoriseAndVerify(subscription);
    const updated = await t.subs.update(Provider.Paytm, subscription.id, { amount: 59900 });
    expect(updated.amount).toBe(59900);
    await t.tickAt(plusHours(PT_DUE, -48));
    await t.tickAt(PT_DUE);
    expect(t.fake.debits.get(chargeIdFor(t.scheduleId, 0, 1))?.amount).toBe('599.00');
  });
});

describe('Paytm: the limits of a price change', () => {
  it('above the ceiling is VALIDATION naming the ceiling and nothing changes; other fields stay UNSUPPORTED; gateway mode cannot be re-priced', async () => {
    const t = setupPaytm();
    const subscription = await t.subs.create(Provider.Paytm, {
      reference: PT_REFERENCE,
      plan: { name: 'Pro monthly', amount: PT_AMOUNT, maxAmount: 99900, interval: { unit: IntervalUnit.Month, count: 1 } },
      customer: CUSTOMER,
      startAt: PT_DUE,
    });
    await t.authoriseAndVerify(subscription);
    const above = await rejection(() => t.subs.update(Provider.Paytm, subscription.id, { amount: 100000 }));
    expect(above.code).toBe(ErrorCode.Validation);
    expect(above.message).toContain('99900');
    expect((await t.scheduler.get(t.scheduleId))?.amount).toBe(PT_AMOUNT);
    expect((await rejection(() => t.subs.update(Provider.Paytm, subscription.id, { amount: 59900, mandateEndsAt: '2030-01-01T00:00:00.000Z' }))).code).toBe(ErrorCode.Unsupported);
    expect((await t.subs.update(Provider.Paytm, subscription.id, { amount: 99900 })).amount).toBe(99900);

    const gateway = setupPaytm({ scheduling: SchedulingMode.Gateway, startAt: '2026-02-01T05:00:00.000Z' });
    const fixed = await gateway.create();
    await gateway.authoriseAndVerify(fixed);
    expect((await rejection(() => gateway.subs.update(Provider.Paytm, fixed.id, { amount: 100 }))).code).toBe(ErrorCode.Unsupported);
  });
});

describe('Paytm: refunds', () => {
  it('refunds a successful debit (the amount and the Paytm transaction id read from Transaction Status), and refuses one that has not succeeded', async () => {
    const t = setupPaytm();
    await renewFirstCycle(t);
    const chargeId = chargeIdFor(t.scheduleId, 0, 1);
    const early = await rejection(() => t.subs.charges.refund(Provider.Paytm, { chargeId, refundId: 'rf_early' }));
    expect(early.code).toBe(ErrorCode.Validation);
    t.fake.settle(chargeId, ChargeStatus.Succeeded);
    const refund = await t.subs.charges.refund(Provider.Paytm, { chargeId, refundId: 'rf_1' });
    expect(refund).toMatchObject({ chargeId, amount: PT_AMOUNT, status: RefundStatus.Pending });
    expect(t.refunds[0]).toMatchObject({ orderId: chargeId, refId: 'rf_1', refundAmount: '499.00', txnId: t.fake.debits.get(chargeId)?.txnId });
  });
});

describe('Paytm over the HTTP handler: capabilities', () => {
  it('GET /v1/paytm/capabilities lists both scheduling modes, merchant first, and matches the published schema', async () => {
    const t = setupPaytm();
    const call = httpApi(t.subs);
    const reply = await httpExchange(call, OperationId.GetCapabilities, HttpMethod.Get, '/v1/paytm/capabilities');
    expect(reply.json).toMatchObject({ provider: Provider.Paytm, scheduling: [SchedulingMode.Merchant, SchedulingMode.Gateway], pause: true, resume: true, merchantCharges: true });
    expect((await httpExchange(call, OperationId.ListProviders, HttpMethod.Get, '/v1/providers')).json.map((entry: { provider: string }) => entry.provider)).toEqual([Provider.Paytm]);
  });
});

describe('Paytm over the HTTP handler', () => {
  const FORM = { [HeaderName.ContentType]: ContentType.Form };

  it('create -> verify (callback fields as JSON) -> tick -> form-encoded payment webhook through the raw route with CHECKSUMHASH; a tampered or unsigned form is a 401 and changes nothing', async () => {
    const t = setupPaytm();
    const call = httpApi(t.subs);
    const created = await httpExchange(call, OperationId.CreateSubscription, HttpMethod.Post, '/v1/paytm/subscriptions', {
      reference: PT_REFERENCE,
      plan: { name: 'Pro monthly', amount: PT_AMOUNT, interval: { unit: IntervalUnit.Month, count: 1 } },
      customer: CUSTOMER,
      startAt: PT_DUE,
    });
    expect(created.json.checkout).toMatchObject({ kind: CheckoutKind.FormPost });
    expect(created.json.checkout.fields).not.toHaveProperty('merchantKey');
    expect(JSON.stringify(created.json)).not.toContain('a1B2c3D4e5F6g7H8');

    const callback = t.fake.authorise({ id: created.json.id, reference: PT_REFERENCE });
    const verified = await httpExchange(call, OperationId.VerifyCheckout, HttpMethod.Post, '/v1/paytm/checkout/verify', { result: callback, expectedSubscriptionId: created.json.id });
    expect(verified.json).toMatchObject({ authorized: true, subscriptionId: created.json.id });

    t.clock.set(plusHours(PT_DUE, -48));
    expect((await httpExchange(call, OperationId.RunSchedulerTick, HttpMethod.Post, '/v1/scheduler/tick')).json.notified).toBe(1);
    t.clock.set(PT_DUE);
    expect((await httpExchange(call, OperationId.RunSchedulerTick, HttpMethod.Post, '/v1/scheduler/tick')).json.charged).toBe(1);
    const chargeId = chargeIdFor(t.scheduleId, 0, 1);
    t.fake.settle(chargeId, ChargeStatus.Succeeded);
    const request = t.fake.paymentWebhook(chargeId, ChargeStatus.Succeeded);

    const tampered = new URLSearchParams(request.rawBody);
    tampered.set('TXNAMOUNT', '1.00');
    expect((await call(HttpMethod.Post, '/v1/paytm/webhooks', { auth: false, body: tampered.toString(), headers: FORM })).status).toBe(HttpStatus.Unauthorized);
    tampered.delete('CHECKSUMHASH');
    expect((await call(HttpMethod.Post, '/v1/paytm/webhooks', { auth: false, body: tampered.toString(), headers: FORM })).status).toBe(HttpStatus.Unauthorized);
    expect((await t.scheduler.get(t.scheduleId))?.paidCycles).toBe(0);

    const good = await call(HttpMethod.Post, '/v1/paytm/webhooks', { auth: false, body: request.rawBody, headers: FORM });
    expect(good).toMatchObject({ status: HttpStatus.Ok, json: { received: 1 } });
    expect((await t.scheduler.get(t.scheduleId))?.paidCycles).toBe(1);
    // The same checksum with its base64 "+" sent literally (a decoder reads it as a space): still verified.
    const literalPlus = request.rawBody.replaceAll('%2B', '+');
    expect(await call(HttpMethod.Post, '/v1/paytm/webhooks', { auth: false, body: literalPlus, headers: FORM })).toMatchObject({ status: HttpStatus.Ok });
    const got = await httpExchange(call, OperationId.GetSubscription, HttpMethod.Get, `/v1/paytm/subscriptions/${created.json.id}`);
    expect(got.json).toMatchObject({ paidCycles: 1 });
  });

  it('the subscription-status webhook goes through the raw route and drives the schedule (customer pause)', async () => {
    const t = setupPaytm();
    const call = httpApi(t.subs);
    await authorised(t);
    const hook = t.fake.mandateWebhook(EventType.SubscriptionPaused);
    expect(await call(HttpMethod.Post, '/v1/paytm/webhooks', { auth: false, body: hook.rawBody, headers: FORM })).toMatchObject({ status: HttpStatus.Ok, json: { received: 1 } });
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ status: ScheduleStatus.Paused, pausedBy: SchedulePauser.Gateway });
    // A flat JSON object of the same fields is the same key-value post: verified by the same rule.
    const asJson = JSON.stringify(Object.fromEntries(new URLSearchParams(t.fake.mandateWebhook(EventType.SubscriptionResumed).rawBody)));
    expect(await call(HttpMethod.Post, '/v1/paytm/webhooks', { auth: false, body: asJson, headers: { [HeaderName.ContentType]: ContentType.Json } })).toMatchObject({ status: HttpStatus.Ok });
    expect((await t.scheduler.get(t.scheduleId))?.status).toBe(ScheduleStatus.Active);
  });
});

