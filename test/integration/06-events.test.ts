/**
 * Seam 6: what each REAL adapter puts on a normalised event (`subscriptionId`, `subscription.reference`, `charge.id`,
 * `charge.reference`), and whether `BillingScheduler.handleEvent` (reached through `subs.webhooks.handle`) finds its
 * schedule and reacts. Bodies are the documented samples (Razorpay, Cashfree: read verbatim from the adapters' tests;
 * PayU: built in the documented field sets and signed with the documented hash layouts, computed independently).
 */
import { describe, expect, it } from 'vitest';
import { ChargeStatus, ErrorCode, EventType, Provider, SubscriptionStatus } from '../../src/constants.js';
import { CashfreeSubscriptionStatus, CashfreePaymentStatus, CashfreePaymentType, CashfreeWebhookEvent } from '../../src/providers/cashfree/constants.js';
import { PayUCommand, PayUMandateNotification, PayUPaymentMode, PayUPaymentSource, PayUPgType, PayUUpiMandateAction } from '../../src/providers/payu/constants.js';
import { CycleStatus, ScheduleStatus, ScheduleStatusReason, chargeIdFor } from '../../src/scheduler/index.js';
import type { SubscriptionEvent, WebhookRequest } from '../../src/schemas.js';
import { CF_FIRST_DUE, PAYU_COMPOSITE, PAYU_DUE, PAYU_MANDATE, PAYU_REFERENCE, consentResult, setupCashfree, setupPayu } from './fakes.js';
import {
  CASHFREE_ACCOUNT,
  CASHFREE_WEBHOOK_TEST,
  Clock,
  PAYU_ACCOUNT,
  RAZORPAY_ACCOUNT,
  RAZORPAY_WEBHOOK_TEST,
  cashfreeProvider,
  cashfreeWebhookRequest,
  fixtureText,
  payuProvider,
  plusHours,
  razorpayProvider,
  razorpayWebhookRequest,
  scriptedFetch,
  sha512Hex,
} from './helpers.js';

const CLOCK_START = '2026-11-17T05:00:00.000Z';
const noNetwork = () => scriptedFetch(() => ({ status: 500 })).fetch;

// ---------------------------------------------------------------------------
// PayU webhook builders: the documented field sets, signed with the documented layouts
// ---------------------------------------------------------------------------

const form = (fields: Record<string, string>): WebhookRequest => ({ rawBody: new URLSearchParams(fields).toString(), headers: {} });
const jsonRequest = (body: unknown): WebhookRequest => ({ rawBody: JSON.stringify(body), headers: {} });

function upiMandateWebhook(action: string, status: string, mandate = PAYU_MANDATE): WebhookRequest {
  const fields = { status, authpayuid: mandate, action, dateTime: '2026-01-10 11:00:00', amount: '499.00', endDate: '2026-04-22 00:00:00', mandateNumber: 'UMN1@paytm', key: PAYU_ACCOUNT.key, udf1: '', udf2: '', udf3: '', udf5: '' };
  const hash = sha512Hex(`${fields.status}|${fields.action}|${fields.authpayuid}|${fields.dateTime}|${fields.amount}|${fields.endDate}|${PAYU_ACCOUNT.salt}`);
  return jsonRequest({ ...fields, hash });
}

function cardMandateWebhook(notificationType: string, status: string, mandate = PAYU_MANDATE): WebhookRequest {
  const base = {
    status,
    authPayuId: mandate,
    si_details: { billingAmount: 499, paymentStartDate: '2026-01-15', paymentEndDate: '2026-04-22' },
    message: 'Mandate event',
    eventDate: '2026-01-10',
    notificationType,
    key: PAYU_ACCOUNT.key,
    udf1: '', udf2: '', udf3: '', udf4: '', udf5: '',
  };
  const hash = sha512Hex(
    [base.status, base.authPayuId, base.notificationType, '499', '2026-01-15', '2026-04-22', base.message, base.eventDate, base.key, '', '', '', '', '', PAYU_ACCOUNT.salt].join('|'),
  );
  return jsonRequest({ ...base, hash });
}

function recurringDebitWebhook(txnid: string, status: 'success' | 'failure'): WebhookRequest {
  const fields = {
    mihpayid: '30141596997',
    mode: PayUPaymentMode.StandingInstruction,
    status,
    unmappedstatus: status === 'success' ? 'captured' : 'failed',
    key: PAYU_ACCOUNT.key,
    txnid,
    amount: '499.00',
    addedon: '2026-01-15 10:00:04',
    productinfo: 'SI',
    firstname: '',
    email: '',
    udf1: '', udf2: '', udf3: '', udf4: '', udf5: '',
    payment_source: PayUPaymentSource.RecurringDebit,
    PG_TYPE: PayUPgType.StandingInstruction,
    error: status === 'success' ? 'E000' : 'E308',
    error_Message: status === 'success' ? 'NO ERROR' : 'Insufficient funds',
  };
  return form({ ...fields, hash: sha512Hex(`${PAYU_ACCOUNT.salt}|${fields.status}||||||${fields.udf5}|${fields.udf4}|${fields.udf3}|${fields.udf2}|${fields.udf1}|${fields.email}|${fields.firstname}|${fields.productinfo}|${fields.amount}|${fields.txnid}|${PAYU_ACCOUNT.key}`) });
}

// ---------------------------------------------------------------------------
// 1. What each adapter puts on its events
// ---------------------------------------------------------------------------

interface Keys {
  type: EventType;
  subscriptionId: boolean;
  reference: boolean;
  chargeId: boolean;
  chargeReference: boolean;
}

function keysOf(event: SubscriptionEvent): Keys {
  return {
    type: event.type,
    subscriptionId: event.subscriptionId !== undefined,
    reference: event.subscription?.reference !== undefined,
    chargeId: event.charge?.id !== undefined,
    chargeReference: event.charge?.reference !== undefined,
  };
}

describe('which identifiers each adapter puts on its normalised events', () => {
  const clock = new Clock(CLOCK_START);
  const razorpayRows: Array<[string, EventType, boolean, boolean]> = [
    // [fixture, type, charge carried, charge.reference (the invoice id) carried]
    ['WEBHOOK_AUTHENTICATED', EventType.SubscriptionAuthorized, false, false],
    ['WEBHOOK_ACTIVATED_FUTURE', EventType.SubscriptionActivated, false, false],
    ['WEBHOOK_ACTIVATED_IMMEDIATE', EventType.SubscriptionActivated, true, true],
    ['WEBHOOK_CHARGED', EventType.SubscriptionCharged, true, true],
    ['WEBHOOK_COMPLETED', EventType.SubscriptionCompleted, true, true],
    ['WEBHOOK_UPDATED', EventType.SubscriptionUpdated, false, false],
    ['WEBHOOK_PENDING', EventType.SubscriptionPastDue, false, false],
    ['WEBHOOK_HALTED', EventType.SubscriptionHalted, false, false],
    ['WEBHOOK_PAUSED', EventType.SubscriptionPaused, false, false],
    ['WEBHOOK_RESUMED', EventType.SubscriptionResumed, false, false],
    ['WEBHOOK_CANCELLED', EventType.SubscriptionCancelled, false, false],
  ];
  it.each(razorpayRows)('Razorpay %s: always the subscription id; the charge (payment id + invoice id) where a payment preceded it', (name, type, charged, invoiced) => {
    const [event] = razorpayProvider(noNetwork(), clock).parseWebhook(razorpayWebhookRequest(fixtureText(RAZORPAY_WEBHOOK_TEST, name), RAZORPAY_ACCOUNT.webhookSecret));
    expect(keysOf(event!)).toEqual({ type, subscriptionId: true, reference: false, chargeId: charged, chargeReference: invoiced });
  });

  const cashfreeRows: Array<[string, EventType, Partial<Keys>]> = [
    // Status webhooks carry the subscription (id == reference). Payment webhooks carry subscriptionId and charge.id
    // (the merchant payment_id) but NO subscription, so `subscription.reference` is absent and `charge.reference` too.
    ['STATUS_CHANGED_2025', EventType.SubscriptionUpdated, { subscriptionId: true, reference: true, chargeId: false }],
    ['STATUS_CHANGED_2023', EventType.SubscriptionActivated, { subscriptionId: true, reference: true, chargeId: false }],
    ['AUTH_STATUS_2026', EventType.SubscriptionAuthorizationFailed, { subscriptionId: true, reference: false, chargeId: true }],
    ['NOTIFICATION_2026', EventType.SubscriptionChargeScheduled, { subscriptionId: true, reference: false, chargeId: true }],
    ['PAYMENT_SUCCESS_2026', EventType.SubscriptionCharged, { subscriptionId: true, reference: false, chargeId: true }],
    ['PAYMENT_FAILED_2026', EventType.SubscriptionChargeFailed, { subscriptionId: true, reference: false, chargeId: true }],
    ['PAYMENT_CANCELLED_2026', EventType.SubscriptionChargeFailed, { subscriptionId: true, reference: false, chargeId: true }],
    ['REFUND_STATUS_2025', EventType.RefundSucceeded, { subscriptionId: false, reference: false, chargeId: false }],
    ['CARD_EXPIRY_2025', EventType.Unknown, { subscriptionId: true, reference: false, chargeId: false }],
  ];
  it.each(cashfreeRows)('Cashfree %s', (name, type, expected) => {
    const [event] = cashfreeProvider(noNetwork(), clock).parseWebhook(cashfreeWebhookRequest(fixtureText(CASHFREE_WEBHOOK_TEST, name), CASHFREE_ACCOUNT.webhookSecret));
    expect(keysOf(event!)).toMatchObject({ type, ...expected, chargeReference: false });
  });

  it('PayU: consent -> subscriptionId (composite) + reference (txnid); recurring debit -> NO subscription id at all, only charge.reference = the merchant txnid; mandate webhooks -> composite id, no reference', () => {
    const payu = payuProvider(noNetwork(), clock);
    const consent = payu.parseWebhook(form(consentResult(PAYU_REFERENCE)))[0]!;
    expect(keysOf(consent)).toEqual({ type: EventType.SubscriptionAuthorized, subscriptionId: true, reference: true, chargeId: true, chargeReference: true });
    expect(consent.subscriptionId).toBe(PAYU_COMPOSITE);

    const success = payu.parseWebhook(recurringDebitWebhook('c_x_0_1', 'success'))[0]!;
    expect(keysOf(success)).toEqual({ type: EventType.SubscriptionCharged, subscriptionId: false, reference: false, chargeId: true, chargeReference: true });
    expect(success.charge).toMatchObject({ reference: 'c_x_0_1', status: ChargeStatus.Succeeded });
    expect(success.charge?.subscriptionId).toBeUndefined();
    const failure = payu.parseWebhook(recurringDebitWebhook('c_x_0_1', 'failure'))[0]!;
    expect(keysOf(failure)).toEqual({ type: EventType.SubscriptionChargeFailed, subscriptionId: false, reference: false, chargeId: true, chargeReference: true });

    for (const [request, type] of [
      [upiMandateWebhook(PayUUpiMandateAction.Pause, 'pause', '25600438037'), EventType.SubscriptionPaused],
      [upiMandateWebhook(PayUUpiMandateAction.Unpause, 'active', '25600438037'), EventType.SubscriptionResumed],
      [upiMandateWebhook(PayUUpiMandateAction.Revoke, 'revoked', '25600438037'), EventType.SubscriptionCancelled],
      [cardMandateWebhook(PayUMandateNotification.Cancellation, 'cancelled'), EventType.SubscriptionCancelled],
      [cardMandateWebhook(PayUMandateNotification.Modification, 'active'), EventType.SubscriptionUpdated],
    ] as const) {
      const [event] = payu.parseWebhook(request);
      expect(keysOf(event!)).toEqual({ type, subscriptionId: true, reference: false, chargeId: false, chargeReference: false });
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Cashfree on-demand: does the scheduler find its schedule and react?
// ---------------------------------------------------------------------------

describe('BillingScheduler reacting to Cashfree webhooks, through subs.webhooks.handle', () => {
  const statusWebhook = (t: ReturnType<typeof setupCashfree>, status: string) =>
    t.subs.webhooks.handle(
      Provider.Cashfree,
      t.webhook('STATUS_CHANGED_2023', (data) => {
        data.subscription_details.subscription_id = t.reference;
        data.subscription_details.subscription_status = status;
      }),
    );

  it.each([
    [CashfreeSubscriptionStatus.CustomerCancelled, ScheduleStatus.Cancelled, ScheduleStatusReason.CancelledByGateway],
    [CashfreeSubscriptionStatus.Cancelled, ScheduleStatus.Cancelled, ScheduleStatusReason.CancelledByGateway],
    [CashfreeSubscriptionStatus.Expired, ScheduleStatus.Cancelled, ScheduleStatusReason.MandateExpired],
    [CashfreeSubscriptionStatus.CardExpired, ScheduleStatus.Cancelled, ScheduleStatusReason.MandateExpired],
    [CashfreeSubscriptionStatus.CustomerPaused, ScheduleStatus.Paused, ScheduleStatusReason.PausedByGateway],
    [CashfreeSubscriptionStatus.OnHold, ScheduleStatus.Halted, ScheduleStatusReason.HaltedByGateway],
  ])('SUBSCRIPTION_STATUS_CHANGED %s moves an active schedule to %s (%s)', async (status, expected, reason) => {
    const t = setupCashfree();
    await t.create();
    await t.activate();
    await statusWebhook(t, status);
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ status: expected, statusReason: reason });
  });

  it('the Cashfree failed-charge webhook of the debit in flight settles that cycle (matched by charge.id), and a failed AUTH webhook of an active schedule changes nothing', async () => {
    const t = setupCashfree();
    await t.create();
    await t.activate();
    await t.tickAt(plusHours(CF_FIRST_DUE, -48));
    const chargeId = chargeIdFor(t.scheduleId, 0, 1);
    await t.paymentWebhook('PAYMENT_FAILED_2026', chargeId, CashfreePaymentStatus.Failed);
    expect(await t.cycle(0)).toMatchObject({ attempt: 2 });
    // PAYMENT_CANCELLED of a (new) debit is a failure as well.
    expect(CashfreeWebhookEvent.PaymentCancelled).toBeDefined();
    expect(CashfreePaymentType.Charge).toBeDefined();
  });

  // DEFECT (see the report): the scheduler handles `subscription.paused` but nothing ever undoes it.
  it.fails('a customer who pauses the UPI mandate and later resumes it (CUSTOMER_PAUSED, then ACTIVE) is billed again', async () => {
    const t = setupCashfree();
    await t.create();
    await t.activate();
    await statusWebhook(t, CashfreeSubscriptionStatus.CustomerPaused);
    expect((await t.scheduler.get(t.scheduleId))?.status).toBe(ScheduleStatus.Paused);
    await statusWebhook(t, CashfreeSubscriptionStatus.Active);
    expect((await t.scheduler.get(t.scheduleId))?.status).toBe(ScheduleStatus.Active);
  });

  it('what actually happens after that ACTIVE webhook: the schedule stays paused by the gateway and nothing is raised', async () => {
    const t = setupCashfree();
    await t.create();
    await t.activate();
    await statusWebhook(t, CashfreeSubscriptionStatus.CustomerPaused);
    const events = await statusWebhook(t, CashfreeSubscriptionStatus.Active);
    expect(events[0]?.type).toBe(EventType.SubscriptionActivated);
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ status: ScheduleStatus.Paused, statusReason: ScheduleStatusReason.PausedByGateway });
    const result = await t.tickAt(plusHours(CF_FIRST_DUE, 24 * 40));
    expect(result.charged).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. PayU
// ---------------------------------------------------------------------------

describe('BillingScheduler reacting to PayU webhooks, through subs.webhooks.handle', () => {
  it('the consent webhook (form-encoded, response hash) activates a pending schedule by reference, adopting the composite id', async () => {
    const t = setupPayu();
    await t.create();
    const events = await t.subs.webhooks.handle(Provider.PayU, form(consentResult(PAYU_REFERENCE)));
    expect(events[0]).toMatchObject({ type: EventType.SubscriptionAuthorized, subscriptionId: PAYU_COMPOSITE });
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ status: ScheduleStatus.Active, subscriptionId: PAYU_COMPOSITE });
    // The browser's return and the webhook both arrive: the second one is a no-op.
    await t.verify();
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ status: ScheduleStatus.Active });
  });

  it('a forged payment webhook is refused with SIGNATURE_INVALID and changes nothing', async () => {
    const t = setupPayu();
    await t.create();
    const forged = form({ ...consentResult(PAYU_REFERENCE), amount: '9.00' });
    await expect(t.subs.webhooks.handle(Provider.PayU, forged)).rejects.toMatchObject({ code: ErrorCode.SignatureInvalid });
    expect((await t.scheduler.get(t.scheduleId))?.status).toBe(ScheduleStatus.PendingAuthorization);
  });

  it('eNACH: the consent webhook is not an authorisation, the schedule stays pending, and neither tick() nor a webhook ever starts it (only subs.get / verifyCheckout polling would)', async () => {
    const t = setupPayu();
    await t.create();
    const enach = consentResult(PAYU_REFERENCE, { mode: PayUPaymentMode.ENach, PG_TYPE: PayUPgType.ENach });
    const [event] = await t.subs.webhooks.handle(Provider.PayU, form(enach));
    expect(event?.type).toBe(EventType.Unknown);
    const verification = await t.subs.verifyCheckout(Provider.PayU, enach, { expectedSubscriptionId: PAYU_REFERENCE });
    expect(verification).toMatchObject({ authorized: false, status: SubscriptionStatus.PendingAuthorization });
    const result = await t.tickAt(plusHours(PAYU_DUE, 24 * 30));
    expect(result.due + result.charged + result.reconciled + result.notified).toBe(0);
    expect((await t.scheduler.get(t.scheduleId))?.status).toBe(ScheduleStatus.PendingAuthorization);
  });

  it('card mandate webhook MANDATE_CANCELLATION cancels the schedule, found by the composite id (it has no reference)', async () => {
    const t = setupPayu();
    await t.create();
    await t.verify();
    const [event] = await t.subs.webhooks.handle(Provider.PayU, cardMandateWebhook(PayUMandateNotification.Cancellation, 'cancelled'));
    expect(event?.type).toBe(EventType.SubscriptionCancelled);
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ status: ScheduleStatus.Cancelled, statusReason: ScheduleStatusReason.CancelledByGateway });
  });

  it('UPI mandate webhooks: MANDATE_REVOKE cancels; MANDATE_PAUSE pauses the schedule', async () => {
    for (const [action, status, expected] of [
      [PayUUpiMandateAction.Revoke, 'revoked', ScheduleStatus.Cancelled],
      [PayUUpiMandateAction.Pause, 'pause', ScheduleStatus.Paused],
    ] as const) {
      const t = setupPayu();
      await t.create();
      await t.subs.verifyCheckout(Provider.PayU, consentResult(PAYU_REFERENCE, { mode: PayUPaymentMode.Upi, PG_TYPE: PayUPgType.Upi }), { expectedSubscriptionId: PAYU_REFERENCE });
      await t.subs.webhooks.handle(Provider.PayU, upiMandateWebhook(action, status));
      expect((await t.scheduler.get(t.scheduleId))?.status).toBe(expected);
    }
  });

  // DEFECT (see the report): same asymmetry as Cashfree; PayU documents MANDATE_UNPAUSE for exactly this.
  it.fails('a customer who pauses a UPI mandate and later unpauses it (MANDATE_PAUSE, then MANDATE_UNPAUSE) is billed again', async () => {
    const t = setupPayu();
    await t.create();
    await t.subs.verifyCheckout(Provider.PayU, consentResult(PAYU_REFERENCE, { mode: PayUPaymentMode.Upi, PG_TYPE: PayUPgType.Upi }), { expectedSubscriptionId: PAYU_REFERENCE });
    await t.subs.webhooks.handle(Provider.PayU, upiMandateWebhook(PayUUpiMandateAction.Pause, 'pause'));
    await t.subs.webhooks.handle(Provider.PayU, upiMandateWebhook(PayUUpiMandateAction.Unpause, 'active'));
    expect((await t.scheduler.get(t.scheduleId))?.status).toBe(ScheduleStatus.Active);
  });

  // DEFECT (low; PayU's debit webhook carries no subscription id): the payment
  // webhook of a recurring debit cannot reach its cycle, so a debit PayU left `pending` waits for the next tick.
  it.fails('the PayU payment webhook of a pending recurring debit settles its cycle without waiting for a tick', async () => {
    const t = setupPayu();
    await t.create();
    await t.verify();
    await t.tickAt(plusHours(PAYU_DUE, -48));
    t.fake.pendingDebits = 1;
    await t.tickAt(PAYU_DUE);
    const chargeId = chargeIdFor(t.scheduleId, 0, 1);
    expect(await t.cycle(0)).toMatchObject({ status: CycleStatus.AwaitingConfirmation, chargeId });
    t.fake.debits.get(chargeId)!.status = 'success';
    await t.subs.webhooks.handle(Provider.PayU, recurringDebitWebhook(chargeId, 'success'));
    expect((await t.cycle(0))?.status).toBe(CycleStatus.Succeeded);
  });

  it('...and the tick does settle it, through the real verify_payment', async () => {
    const t = setupPayu();
    await t.create();
    await t.verify();
    await t.tickAt(plusHours(PAYU_DUE, -48));
    t.fake.pendingDebits = 1;
    await t.tickAt(PAYU_DUE);
    const chargeId = chargeIdFor(t.scheduleId, 0, 1);
    t.fake.debits.get(chargeId)!.status = 'success';
    t.fake.commands.length = 0;
    const result = await t.tickAt(plusHours(PAYU_DUE, 1));
    expect(result).toMatchObject({ reconciled: 1, succeeded: 1 });
    expect(t.fake.commands.map((entry) => entry.command)).toEqual([PayUCommand.VerifyPayment]);
    // Redelivery of the debit webhook afterwards changes nothing.
    await t.subs.webhooks.handle(Provider.PayU, recurringDebitWebhook(chargeId, 'success'));
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ paidCycles: 1 });
  });
});
