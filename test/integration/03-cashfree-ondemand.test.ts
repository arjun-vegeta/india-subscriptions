/**
 * Seam 3: Cashfree ON_DEMAND (merchant-scheduled) through the real facade, the real BillingScheduler and the real
 * Cashfree adapter. A stateful fake Cashfree answers the adapter's HTTP calls with documentation-shaped payloads and
 * records what it was asked, so the scheduler's choices (when it raises a charge, which payment id and schedule date it
 * sends, what it does with the answer) are observed at the wire.
 *
 * Fixtures: test/cashfree/adapter.test.ts and test/cashfree/webhooks.test.ts, verbatim, edited only to carry the ids of
 * the subscription / charge under test.
 */
import { describe, expect, it } from 'vitest';
import { ChargeStatus, Environment, ErrorCode, EventType, IntervalUnit, Provider, SchedulingMode, SubscriptionStatus } from '../../src/constants.js';
import {
  CashfreePath,
  CashfreePaymentStatus,
  CashfreePaymentType,
  CashfreeSubscriptionStatus,
  CashfreeWebhookEvent,
  MERCHANT_CHARGE_LEAD_HOURS,
  MERCHANT_CHARGE_MAX_AHEAD_HOURS,
  ManageAction,
  RETURN_URL_SUBSCRIPTION_ID_PARAM,
} from '../../src/providers/cashfree/constants.js';
import { ChargeMetadataKey, CycleStatus, ScheduleStatus, ScheduleStatusReason, SchedulerEventType, chargeIdFor, type SchedulerEvent } from '../../src/scheduler/index.js';
import { toIstDateString } from '../../src/time.js';
import { CF_AMOUNT as AMOUNT, CF_FIRST_DUE as FIRST_DUE, CF_SECOND_DUE as SECOND_DUE, setupCashfree as setup } from './fakes.js';
import { CASHFREE_ACCOUNT, CASHFREE_BASE_PATH, DAY_MS, HOUR_MS, plusHours, rejection, sequence } from './helpers.js';

describe('Cashfree on-demand: registration', () => {
  it('the adapter returns the amount, interval and startAt the facade needs, and the schedule waits for the customer', async () => {
    const t = setup();
    const subscription = await t.create();
    // The three fields the facade insists on (client.ts: "without amount, interval or startAt").
    expect(subscription).toMatchObject({
      id: t.reference,
      scheduling: SchedulingMode.Merchant,
      amount: AMOUNT,
      interval: { unit: IntervalUnit.Month, count: 1 },
      startAt: FIRST_DUE,
    });
    expect(sequence(t.calls, CASHFREE_BASE_PATH)).toEqual([`POST ${CashfreePath.Subscriptions}`]);
    expect(t.calls[0]?.json).toMatchObject({ plan_details: { plan_type: 'ON_DEMAND', plan_max_amount: 499 } });

    const schedule = await t.scheduler.get(t.scheduleId);
    expect(schedule).toMatchObject({ status: ScheduleStatus.PendingAuthorization, subscriptionId: t.reference, amount: AMOUNT, firstChargeAt: FIRST_DUE });
    // Nothing is billed while the customer has not authorised, however late it gets.
    const result = await t.tickAt(plusHours(FIRST_DUE, 24 * 5));
    expect(result.charged + result.reconciled + result.notified).toBe(0);
    expect(t.fake.chargeCalls).toHaveLength(0);
  });
});

describe('Cashfree on-demand: activation', () => {
  it('by Cashfree status webhook (SUBSCRIPTION_STATUS_CHANGED -> ACTIVE)', async () => {
    const t = setup();
    await t.create();
    const events = await t.activate();
    expect(events[0]).toMatchObject({ type: EventType.SubscriptionActivated, subscriptionId: t.reference });
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ status: ScheduleStatus.Active, subscriptionId: t.reference });
  });

  it('by verifyCheckout (return URL -> GET subscription -> ACTIVE)', async () => {
    const t = setup();
    await t.create();
    t.fake.status = CashfreeSubscriptionStatus.Active;
    t.calls.length = 0;
    const verification = await t.subs.verifyCheckout(Provider.Cashfree, { [RETURN_URL_SUBSCRIPTION_ID_PARAM]: t.reference }, { expectedSubscriptionId: t.reference });
    expect(verification).toMatchObject({ authorized: true, status: SubscriptionStatus.Active });
    expect(sequence(t.calls, CASHFREE_BASE_PATH)).toEqual([`GET ${CashfreePath.subscription(t.reference)}`]);
    expect((await t.scheduler.get(t.scheduleId))?.status).toBe(ScheduleStatus.Active);
  });

  it('eNACH: BANK_APPROVAL_PENDING keeps the schedule pending (verifyCheckout says authorized: false); the later ACTIVE webhook starts it', async () => {
    const t = setup();
    await t.create();
    t.fake.status = CashfreeSubscriptionStatus.BankApprovalPending;
    const verification = await t.subs.verifyCheckout(Provider.Cashfree, { [RETURN_URL_SUBSCRIPTION_ID_PARAM]: t.reference });
    expect(verification).toMatchObject({ authorized: false, status: SubscriptionStatus.PendingAuthorization });
    expect((await t.scheduler.get(t.scheduleId))?.status).toBe(ScheduleStatus.PendingAuthorization);
    await t.activate();
    expect((await t.scheduler.get(t.scheduleId))?.status).toBe(ScheduleStatus.Active);
  });

  it('by polling: subs.get() on an ACTIVE mandate activates a schedule that no webhook reached', async () => {
    const t = setup();
    await t.create();
    t.fake.status = CashfreeSubscriptionStatus.Active;
    const subscription = await t.subs.get(Provider.Cashfree, t.reference);
    expect(subscription.status).toBe(SubscriptionStatus.Trialing); // live mandate, first charge date still ahead
    expect((await t.scheduler.get(t.scheduleId))?.status).toBe(ScheduleStatus.Active);
  });
});

describe('Cashfree on-demand: raising the charge ahead of the due date', () => {
  it('uses the adapter\'s merchantChargeLeadHours, sends a legal schedule date and a payment id the scheduler can recognise later', async () => {
    const t = setup();
    await t.create();
    await t.activate();
    expect(t.provider.capabilities.merchantChargeLeadHours).toBe(MERCHANT_CHARGE_LEAD_HOURS);

    // One minute before due - lead: nothing. At due - lead: the charge.
    const early = await t.tickAt(plusHours(FIRST_DUE, -MERCHANT_CHARGE_LEAD_HOURS - 1 / 60));
    expect(early.charged).toBe(0);
    expect(t.fake.chargeCalls).toHaveLength(0);
    const at = plusHours(FIRST_DUE, -MERCHANT_CHARGE_LEAD_HOURS);
    const raised = await t.tickAt(at);
    expect(raised).toMatchObject({ charged: 1, awaiting: 1 });

    const call = t.fake.chargeCalls[0]!;
    const chargeId = chargeIdFor(t.scheduleId, 0, 1);
    expect(call.json).toMatchObject({
      subscription_id: t.reference,
      payment_id: chargeId,
      payment_type: CashfreePaymentType.Charge,
      payment_amount: 499,
    });
    // Legal per the adapter's own rules: a date at least T+2 (so legal for UPI and cards at any hour) and at most 13 days out.
    const sent = (call.json as { payment_schedule_date: string }).payment_schedule_date;
    expect(sent.slice(0, 10)).toBe(toIstDateString(new Date(FIRST_DUE)));
    const daysAhead = (Date.parse(`${sent.slice(0, 10)}T00:00:00+05:30`) - Date.parse(`${toIstDateString(new Date(at))}T00:00:00+05:30`)) / DAY_MS;
    expect(daysAhead).toBeGreaterThanOrEqual(MERCHANT_CHARGE_LEAD_HOURS / 24);
    expect(daysAhead).toBeLessThanOrEqual(MERCHANT_CHARGE_MAX_AHEAD_HOURS / 24);
    expect(call.json).not.toHaveProperty('metadata');

    // The cycle remembers the id it sent and what Cashfree answered (INITIALIZED = charge scheduled).
    expect(await t.cycle(0)).toMatchObject({ status: CycleStatus.AwaitingConfirmation, chargeId, providerChargeId: chargeId, scheduledAt: FIRST_DUE });
  });

  it('a charge scheduled for the future is not polled before its date', async () => {
    const t = setup();
    await t.create();
    await t.activate();
    await t.tickAt(plusHours(FIRST_DUE, -MERCHANT_CHARGE_LEAD_HOURS));
    t.calls.length = 0;
    const result = await t.tickAt(plusHours(FIRST_DUE, -12));
    expect(result.reconciled).toBe(0);
    expect(t.calls).toHaveLength(0);
  });

  it('a late activation (after the first due date) debits no earlier than the adapter\'s lead time allows', async () => {
    const t = setup();
    await t.create();
    t.clock.set(plusHours(FIRST_DUE, 30));
    await t.activate();
    const result = await t.tickAt(plusHours(FIRST_DUE, 30));
    expect(result.charged).toBe(1);
    const sent = (t.fake.chargeCalls[0]!.json as { payment_schedule_date: string }).payment_schedule_date.slice(0, 10);
    expect(sent).toBe(toIstDateString(new Date(Date.parse(plusHours(FIRST_DUE, 30)) + MERCHANT_CHARGE_LEAD_HOURS * HOUR_MS)));
  });
});

describe('Cashfree on-demand: the webhook that closes the loop', () => {
  it('SUBSCRIPTION_PAYMENT_SUCCESS, as the adapter normalises it, matches the in-flight cycle by charge.id (the merchant payment_id)', async () => {
    const t = setup();
    await t.create();
    await t.activate();
    await t.tickAt(plusHours(FIRST_DUE, -MERCHANT_CHARGE_LEAD_HOURS));
    const chargeId = chargeIdFor(t.scheduleId, 0, 1);

    // The notification Cashfree sends once it has scheduled the debit: harmless, the cycle stays in flight.
    const [notice] = await t.subs.webhooks.handle(
      Provider.Cashfree,
      t.webhook('NOTIFICATION_2026', (data) => {
        data.subscription_id = t.reference;
        data.subscription_details.subscription_id = t.reference;
        data.payment_id = chargeId;
      }),
    );
    expect(notice).toMatchObject({ type: EventType.SubscriptionChargeScheduled, providerEventType: CashfreeWebhookEvent.PaymentNotificationInitiated });
    expect((await t.cycle(0))?.status).toBe(CycleStatus.AwaitingConfirmation);

    // The adapter puts the merchant payment_id on event.charge.id and the merchant subscription id on event.subscriptionId.
    const [success] = await t.paymentWebhook('PAYMENT_SUCCESS_2026', chargeId, CashfreePaymentStatus.Success);
    expect(success).toMatchObject({ type: EventType.SubscriptionCharged, subscriptionId: t.reference });
    expect(success?.charge).toMatchObject({ id: chargeId, status: ChargeStatus.Succeeded });

    expect(await t.cycle(0)).toMatchObject({ status: CycleStatus.Succeeded, providerChargeId: chargeId });
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ paidCycles: 1, cycleIndex: 1 });
    // A redelivery changes nothing.
    await t.paymentWebhook('PAYMENT_SUCCESS_2026', chargeId, CashfreePaymentStatus.Success);
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ paidCycles: 1, cycleIndex: 1 });
  });

  it('SUBSCRIPTION_PAYMENT_FAILED matches too: the cycle is retried under a NEW payment id, and the old id is never reused', async () => {
    const t = setup();
    await t.create();
    await t.activate();
    await t.tickAt(plusHours(FIRST_DUE, -MERCHANT_CHARGE_LEAD_HOURS));
    const first = chargeIdFor(t.scheduleId, 0, 1);
    const [failed] = await t.paymentWebhook('PAYMENT_FAILED_2026', first, CashfreePaymentStatus.Failed);
    expect(failed).toMatchObject({ type: EventType.SubscriptionChargeFailed });
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ retrying: true });
    expect(await t.cycle(0)).toMatchObject({ attempt: 2, status: CycleStatus.Pending });

    // Raise the retry: a new payment id, and again a legal date.
    const result = await t.tickAt(plusHours(FIRST_DUE, -MERCHANT_CHARGE_LEAD_HOURS + 1));
    expect(result.charged).toBe(1);
    const second = chargeIdFor(t.scheduleId, 0, 2);
    expect(second).not.toBe(first);
    expect(t.fake.chargeCalls.map((call) => (call.json as { payment_id: string }).payment_id)).toEqual([first, second]);
  });

  it('a payment webhook of the AUTH payment (the mandate set-up debit) matches no cycle and changes nothing', async () => {
    const t = setup();
    await t.create();
    await t.activate();
    await t.tickAt(plusHours(FIRST_DUE, -MERCHANT_CHARGE_LEAD_HOURS));
    const [authPayment] = await t.subs.webhooks.handle(
      Provider.Cashfree,
      t.webhook('PAYMENT_SUCCESS_2026', (data) => {
        data.subscription_id = t.reference;
        data.subscription_details.subscription_id = t.reference;
      }),
    );
    expect(authPayment?.type).toBe(EventType.SubscriptionCharged);
    expect(await t.cycle(0)).toMatchObject({ status: CycleStatus.AwaitingConfirmation });
  });
});

describe('Cashfree on-demand: reconciliation through the real getCharge', () => {
  it('without any webhook, the tick after the debit date asks Cashfree and settles the cycle; then the next cycle is raised', async () => {
    const t = setup();
    await t.create();
    await t.activate();
    await t.tickAt(plusHours(FIRST_DUE, -MERCHANT_CHARGE_LEAD_HOURS));
    const chargeId = chargeIdFor(t.scheduleId, 0, 1);
    t.fake.payments.get(chargeId)!.status = CashfreePaymentStatus.Success;
    t.calls.length = 0;
    const result = await t.tickAt(plusHours(FIRST_DUE, 1));
    expect(result).toMatchObject({ reconciled: 1, succeeded: 1 });
    expect(sequence(t.calls, CASHFREE_BASE_PATH)).toEqual([`GET ${CashfreePath.payment(t.reference, chargeId)}`]);
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ paidCycles: 1 });
  });

  it('a pending Cashfree payment keeps the cycle awaiting; a failed one is retried', async () => {
    const t = setup();
    await t.create();
    await t.activate();
    await t.tickAt(plusHours(FIRST_DUE, -MERCHANT_CHARGE_LEAD_HOURS));
    const chargeId = chargeIdFor(t.scheduleId, 0, 1);
    t.fake.payments.get(chargeId)!.status = CashfreePaymentStatus.Pending;
    await t.tickAt(plusHours(FIRST_DUE, 1));
    expect((await t.cycle(0))?.status).toBe(CycleStatus.AwaitingConfirmation);
    t.fake.payments.get(chargeId)!.status = CashfreePaymentStatus.Failed;
    await t.tickAt(plusHours(FIRST_DUE, 2));
    // The failed attempt is settled and attempt 2 is raised at once (its date is >= 48 hours out), under a new payment id.
    expect(await t.cycle(0)).toMatchObject({ attempt: 2, status: CycleStatus.AwaitingConfirmation, chargeId: chargeIdFor(t.scheduleId, 0, 2) });
    expect(t.fake.chargeCalls).toHaveLength(2);
  });

  it('a lost answer after Cashfree recorded the charge is reconciled by payment id and never raised twice', async () => {
    const t = setup();
    await t.create();
    await t.activate();
    t.fake.loseNextChargeAnswer = 'answer';
    const lost = await t.tickAt(plusHours(FIRST_DUE, -MERCHANT_CHARGE_LEAD_HOURS));
    expect(lost.errors[0]?.code).toBe(ErrorCode.OutcomeUnknown);
    expect((await t.cycle(0))?.status).toBe(CycleStatus.Charging);
    const next = await t.tickAt(plusHours(FIRST_DUE, -MERCHANT_CHARGE_LEAD_HOURS + 0.1));
    expect(next).toMatchObject({ reconciled: 1, awaiting: 1 });
    expect(t.fake.chargeCalls).toHaveLength(1);
    expect(t.fake.payments.size).toBe(1);
  });

  it('a lost request is NOT_FOUND at Cashfree (404); only after the grace period is the SAME payment id sent again', async () => {
    const t = setup();
    await t.create();
    await t.activate();
    t.fake.loseNextChargeAnswer = 'request';
    const at = plusHours(FIRST_DUE, -MERCHANT_CHARGE_LEAD_HOURS);
    await t.tickAt(at);
    const early = await t.tickAt(plusHours(at, 0.1));
    expect(early.reconciled).toBe(1);
    expect(t.fake.chargeCalls).toHaveLength(1); // not before the grace period: Cashfree's status API may lag
    const late = await t.tickAt(plusHours(at, 1));
    expect(late.charged).toBe(1);
    const ids = t.fake.chargeCalls.map((call) => (call.json as { payment_id: string }).payment_id);
    expect(new Set(ids).size).toBe(1);
    expect(t.fake.payments.size).toBe(1);
  });
});

describe('Cashfree on-demand: lifecycle', () => {
  it('pause and resume are the scheduler\'s alone: Cashfree is only READ, never told', async () => {
    const t = setup();
    await t.create();
    await t.activate();
    t.calls.length = 0;
    const paused = await t.subs.pause(Provider.Cashfree, t.reference);
    expect(paused.status).toBe(SubscriptionStatus.Paused);
    const quiet = await t.tickAt(plusHours(FIRST_DUE, -MERCHANT_CHARGE_LEAD_HOURS));
    expect(quiet.charged).toBe(0);
    const resumed = await t.subs.resume(Provider.Cashfree, t.reference);
    expect(resumed.status).not.toBe(SubscriptionStatus.Paused);
    expect(t.calls.filter((call) => call.method !== 'GET')).toEqual([]);
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ status: ScheduleStatus.Active });
  });

  it('cancel stops billing FIRST, then cancels the mandate at Cashfree', async () => {
    const t = setup();
    await t.create();
    await t.activate();
    let scheduleWhenCashfreeWasTold: string | undefined;
    t.fake.onManage = async (action) => {
      expect(action).toBe(ManageAction.Cancel);
      scheduleWhenCashfreeWasTold = (await t.scheduler.get(t.scheduleId))?.status;
    };
    const cancelled = await t.subs.cancel(Provider.Cashfree, t.reference);
    expect(scheduleWhenCashfreeWasTold).toBe(ScheduleStatus.Cancelled);
    expect(cancelled.status).toBe(SubscriptionStatus.Cancelled);
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ status: ScheduleStatus.Cancelled, statusReason: ScheduleStatusReason.CancelledByMerchant });
    const after = await t.tickAt(plusHours(FIRST_DUE, 1));
    expect(after.charged).toBe(0);
  });

  it('totalCycles: the schedule completes after the last collected cycle and nothing more is raised', async () => {
    const t = setup('od_ref_cycles', 2);
    await t.create();
    await t.activate();
    for (const [index, due] of [FIRST_DUE, SECOND_DUE].entries()) {
      await t.tickAt(plusHours(due, -MERCHANT_CHARGE_LEAD_HOURS));
      t.fake.payments.get(chargeIdFor(t.scheduleId, index, 1))!.status = CashfreePaymentStatus.Success;
      await t.tickAt(plusHours(due, 1));
    }
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ status: ScheduleStatus.Completed, statusReason: ScheduleStatusReason.AllCyclesCollected, paidCycles: 2 });
    const quiet = await t.tickAt('2026-06-01T00:00:00.000Z');
    expect(quiet.charged).toBe(0);
    expect(t.fake.chargeCalls).toHaveLength(2);
    expect((await t.subs.get(Provider.Cashfree, t.reference)).status).toBe(SubscriptionStatus.Completed);
  });

  it('update(amount) above the mandate ceiling is refused by the adapter before the schedule changes', async () => {
    const t = setup();
    await t.create();
    await t.activate();
    const error = await rejection(() => t.subs.update(Provider.Cashfree, t.reference, { amount: 60000 }));
    expect(error.code).toBe(ErrorCode.Validation);
    expect((await t.scheduler.get(t.scheduleId))?.amount).toBe(AMOUNT);
    const ok = await t.subs.update(Provider.Cashfree, t.reference, { amount: 45000 });
    expect(ok.amount).toBe(45000);
    expect(Environment.Test).toBe(CASHFREE_ACCOUNT.environment);
  });
});

describe('Cashfree on-demand: where the adapter\'s error codes meet the scheduler\'s rules', () => {
  // DEFECT (see the report): the scheduler treats a VALIDATION rejection of createCharge as proof that no debit exists
  // (`DEFINITE_REJECTION_CODES`), but the Cashfree adapter maps HTTP 400 and 422 to VALIDATION, and 400 / 422 are the
  // statuses the spec leaves for "reused payment_id". Conditional on Cashfree's payment lookup lagging past the 30-minute
  // grace period after a lost answer: the re-sent id is refused as a duplicate, the scheduler books a failed attempt, and
  // raises a second charge under a new id while the first one still stands.
  it.fails('a reused-payment_id rejection after a lost answer (lookup lagging) never ends in a second charge for the same cycle', async () => {
    const t = setup();
    await t.create();
    await t.activate();
    t.fake.loseNextChargeAnswer = 'answer';
    const at = plusHours(FIRST_DUE, -MERCHANT_CHARGE_LEAD_HOURS);
    await t.tickAt(at);
    t.fake.lookupLagUntil = plusHours(at, 2);
    await t.tickAt(plusHours(at, 0.1));
    await t.tickAt(plusHours(at, 1));
    expect(t.fake.payments.size).toBe(1);
  });

  it('what happens in that scenario, step by step: duplicate -> VALIDATION -> a failed attempt -> a charge under a new id', async () => {
    const t = setup();
    await t.create();
    await t.activate();
    t.fake.loseNextChargeAnswer = 'answer';
    const at = plusHours(FIRST_DUE, -MERCHANT_CHARGE_LEAD_HOURS);
    await t.tickAt(at);
    t.fake.lookupLagUntil = plusHours(at, 2);
    await t.tickAt(plusHours(at, 1));
    expect([...t.fake.payments.keys()]).toEqual([chargeIdFor(t.scheduleId, 0, 1), chargeIdFor(t.scheduleId, 0, 2)]);
    expect(await t.cycle(0)).toMatchObject({ attempt: 2 });
  });

  it('pause within the charge-ahead window cannot stop the debit Cashfree already holds: the facade says paused, no call cancels the payment, and the scheduler emits charge.in_flight', async () => {
    const events: SchedulerEvent[] = [];
    const t = setup('od_ref_inflight', undefined, (event) => void events.push(event));
    await t.create();
    await t.activate();
    await t.tickAt(plusHours(FIRST_DUE, -MERCHANT_CHARGE_LEAD_HOURS));
    t.calls.length = 0;
    const paused = await t.subs.pause(Provider.Cashfree, t.reference);
    expect(paused.status).toBe(SubscriptionStatus.Paused);
    expect(t.calls.filter((call) => call.method !== 'GET')).toEqual([]);
    expect(events.map((event) => event.type)).toContain(SchedulerEventType.ChargeInFlight);
    expect(t.fake.payments.get(chargeIdFor(t.scheduleId, 0, 1))?.status).toBe(CashfreePaymentStatus.Initialized);
  });
});
