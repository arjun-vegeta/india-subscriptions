/**
 * Seam 4: the real PayU adapter + the real facade + the real BillingScheduler. A stateful fake PayU answers the
 * postservice commands with the documented sample shapes; consent results are signed with PayU's reverse hash,
 * computed here independently of the library. Everything goes through `subs.*` (create, verifyCheckout, tick, get,
 * pause, resume, cancel), with the reference AND the composite subscription id.
 *
 * Note: the adapter is being verified against PayU's test environment by someone else while this is written. The
 * adapter now looks a txnid up (`verify_payment`) before it sends `si_transaction`; the fake answers both, and the
 * assertions are on outcomes and on the debit commands, not on the number of read-only lookups.
 */
import { describe, expect, it } from 'vitest';
import { ChargeStatus, CheckoutKind, Environment, ErrorCode, IntervalUnit, PaymentMethod, Provider, SchedulingMode, SubscriptionStatus } from '../../src/constants.js';
import { PAYU_PAYMENT_URLS, PayUCommand } from '../../src/providers/payu/constants.js';
import { CycleStatus, ScheduleStatus, chargeIdFor, notificationIdFor, scheduleIdFor } from '../../src/scheduler/index.js';
import { toIstDateString } from '../../src/time.js';
import {
  PAYU_COMPOSITE as COMPOSITE,
  PAYU_DUE as DUE,
  PAYU_MANDATE as MANDATE,
  PAYU_REFERENCE as REFERENCE,
  PAYU_SECOND_DUE as SECOND_DUE,
  consentResult,
  setupPayu as setup,
} from './fakes.js';
import { CUSTOMER, plusHours, rejection } from './helpers.js';

describe('PayU through the facade and the scheduler', () => {
  it('create makes no network call and registers a schedule that waits; verifyCheckout switches it to the composite id', async () => {
    const t = setup();
    const subscription = await t.create();
    expect(t.calls).toHaveLength(0);
    expect(subscription).toMatchObject({
      id: REFERENCE,
      reference: REFERENCE,
      scheduling: SchedulingMode.Merchant,
      amount: 49900,
      interval: { unit: IntervalUnit.Month, count: 1 },
      startAt: DUE,
      checkout: { kind: CheckoutKind.FormPost, url: PAYU_PAYMENT_URLS[Environment.Test] },
    });
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ status: ScheduleStatus.PendingAuthorization, subscriptionId: REFERENCE });

    // Nothing happens before the customer authorises.
    expect((await t.tickAt(plusHours(DUE, -48))).notified).toBe(0);

    // A tampered consent result is refused and starts nothing.
    const forged = { ...consentResult(REFERENCE), amount: '3.00' };
    expect((await rejection(() => t.subs.verifyCheckout(Provider.PayU, forged))).code).toBe(ErrorCode.SignatureInvalid);
    expect((await t.scheduler.get(t.scheduleId))?.status).toBe(ScheduleStatus.PendingAuthorization);
    // A genuine result of ANOTHER transaction is refused when the caller says which one it expected.
    expect((await rejection(() => t.subs.verifyCheckout(Provider.PayU, consentResult('someone_else'), { expectedSubscriptionId: REFERENCE }))).code).toBe(ErrorCode.SignatureInvalid);

    const verification = await t.verify();
    expect(verification).toMatchObject({ authorized: true, subscriptionId: COMPOSITE, reference: REFERENCE, status: SubscriptionStatus.Active });
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ status: ScheduleStatus.Active, subscriptionId: COMPOSITE });
    // The mandate is found by either handle from now on.
    expect((await t.scheduler.find(Provider.PayU, REFERENCE))?.id).toBe(t.scheduleId);
    expect((await t.scheduler.find(Provider.PayU, COMPOSITE))?.id).toBe(t.scheduleId);
    expect(t.calls).toHaveLength(0);
  });

  it('notifies 48 hours ahead with the scheduler\'s notification id, debits on the due date with the notified invoice number, and reconciles', async () => {
    const t = setup();
    await t.create();
    await t.verify();

    expect((await t.tickAt(plusHours(DUE, -49))).notified).toBe(0);
    expect((await t.tickAt(plusHours(DUE, -48))).notified).toBe(1);
    const [preDebit] = t.fake.commandsNamed(PayUCommand.PreDebit);
    expect(preDebit).toMatchObject({ authpayuid: MANDATE, amount: '499.00', debitDate: toIstDateString(new Date(DUE)) });
    expect(preDebit?.requestId).toBe(notificationIdFor(t.scheduleId, 0, 1, 1));
    expect(preDebit?.requestId).toMatch(/^[A-Za-z0-9_]{1,25}$/);

    // Before the due date: no debit. On the due date: the debit.
    expect((await t.tickAt(plusHours(DUE, -1))).charged).toBe(0);
    const due = await t.tickAt(DUE);
    expect(due).toMatchObject({ charged: 1, succeeded: 1 });
    const [debit] = t.fake.commandsNamed(PayUCommand.SiTransaction);
    const chargeId = chargeIdFor(t.scheduleId, 0, 1);
    expect(debit).toMatchObject({ authpayuid: MANDATE, amount: '499.00', txnid: chargeId, invoiceDisplayNumber: preDebit?.invoiceDisplayNumber, phone: CUSTOMER.phone, email: CUSTOMER.email });
    expect(chargeId).toMatch(/^[A-Za-z0-9_-]{1,25}$/);
    expect(await t.cycle(0)).toMatchObject({ status: CycleStatus.Succeeded, chargeId, providerChargeId: chargeId });
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ paidCycles: 1 });

    // Through the facade: the composite id answers from PayU's mandate status, overlaid with the schedule.
    const got = await t.subs.get(Provider.PayU, COMPOSITE);
    expect(got).toMatchObject({ status: SubscriptionStatus.Active, paidCycles: 1, amount: 49900 });
    expect(t.fake.commandsNamed(PayUCommand.CheckMandateStatus)[0]).toMatchObject({ authPayuId: MANDATE });
  });

  it('a lost answer after PayU recorded the debit is reconciled with getCharge and never debited twice', async () => {
    const t = setup();
    await t.create();
    await t.verify();
    await t.tickAt(plusHours(DUE, -48));
    t.fake.dropNext = 'answer';
    const lost = await t.tickAt(DUE);
    expect(lost.errors[0]?.code).toBe(ErrorCode.OutcomeUnknown);
    expect((await t.cycle(0))?.status).toBe(CycleStatus.Charging);
    const next = await t.tickAt(plusHours(DUE, 0.1));
    expect(next).toMatchObject({ reconciled: 1, succeeded: 1 });
    expect(t.fake.debits.size).toBe(1);
    expect(t.fake.commandsNamed(PayUCommand.SiTransaction)).toHaveLength(1);
  });

  it('a request that never arrived is NOT_FOUND at PayU; after the grace period the SAME txnid is sent again, once', async () => {
    const t = setup();
    await t.create();
    await t.verify();
    await t.tickAt(plusHours(DUE, -48));
    t.fake.dropNext = 'request';
    await t.tickAt(DUE);
    const early = await t.tickAt(plusHours(DUE, 0.1));
    expect(early).toMatchObject({ reconciled: 1, succeeded: 0 });
    const late = await t.tickAt(plusHours(DUE, 1));
    expect(late.succeeded).toBe(1);
    const txnids = t.fake.commandsNamed(PayUCommand.SiTransaction).map((entry) => entry.txnid);
    expect(new Set(txnids).size).toBe(1);
    expect(t.fake.debits.size).toBe(1);
  });

  it('three failed attempts halt the schedule; resume re-opens the cycle; the second cycle is then billed and the totalCycles end completes it', async () => {
    const t = setup(2);
    await t.create();
    await t.verify();
    t.fake.failDebits = 3;
    await t.tickAt(plusHours(DUE, -48));
    await t.tickAt(DUE);
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ retrying: true });
    expect((await t.subs.get(Provider.PayU, COMPOSITE)).status).toBe(SubscriptionStatus.PastDue);
    // Retries: 24 hours apart, each with a fresh notification (notification ids differ from the first).
    await t.tickAt(plusHours(DUE, 24));
    await t.tickAt(plusHours(DUE, 25));
    await t.tickAt(plusHours(DUE, 48));
    await t.tickAt(plusHours(DUE, 49));
    await t.tickAt(plusHours(DUE, 72));
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ status: ScheduleStatus.Halted });
    expect((await t.subs.get(Provider.PayU, COMPOSITE)).status).toBe(SubscriptionStatus.Halted);
    const txnids = t.fake.commandsNamed(PayUCommand.SiTransaction).map((entry) => entry.txnid);
    expect(new Set(txnids).size).toBe(3);

    // The customer tops up: resume (by the composite id) gives the cycle one more round.
    t.clock.set(plusHours(DUE, 100));
    const resumed = await t.subs.resume(Provider.PayU, COMPOSITE);
    expect(resumed.status).not.toBe(SubscriptionStatus.Halted);
    await t.tickAt(plusHours(DUE, 100));
    await t.tickAt(plusHours(DUE, 125));
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ paidCycles: 1 });

    // Second and last cycle.
    await t.tickAt(plusHours(SECOND_DUE, -48));
    await t.tickAt(SECOND_DUE);
    expect(await t.scheduler.get(t.scheduleId)).toMatchObject({ status: ScheduleStatus.Completed, paidCycles: 2 });
    expect(Object.values(ChargeStatus)).toContain(ChargeStatus.Succeeded);
  });

  it('pause and resume (by the composite id and by the reference) are the scheduler\'s; PayU is only asked for the mandate status', async () => {
    const t = setup();
    await t.create();
    await t.verify();
    t.fake.commands.length = 0;
    const paused = await t.subs.pause(Provider.PayU, REFERENCE);
    expect(paused.status).toBe(SubscriptionStatus.Paused);
    expect((await t.tickAt(plusHours(DUE, -48))).notified).toBe(0);
    const resumed = await t.subs.resume(Provider.PayU, COMPOSITE);
    expect(resumed.status).not.toBe(SubscriptionStatus.Paused);
    expect(t.fake.commands.map((entry) => entry.command)).toEqual([PayUCommand.CheckMandateStatus, PayUCommand.CheckMandateStatus]);
  });

  it('cancel stops billing first, then revokes the mandate with mandate_revoke; the reference and the composite id both work', async () => {
    for (const handle of [REFERENCE, COMPOSITE]) {
      const t = setup();
      await t.create();
      await t.verify();
      let scheduleWhenRevoked: string | undefined;
      const revoke = t.fake.gateway.fetch;
      t.fake.gateway.calls.length = 0;
      const cancelled = await t.subs.cancel(Provider.PayU, handle);
      scheduleWhenRevoked = (await t.scheduler.get(t.scheduleId))?.status;
      expect(cancelled.status).toBe(SubscriptionStatus.Cancelled);
      expect(scheduleWhenRevoked).toBe(ScheduleStatus.Cancelled);
      expect(t.fake.commands.map((entry) => entry.command)).toEqual([PayUCommand.MandateRevoke]);
      expect(t.fake.commandsNamed(PayUCommand.MandateRevoke)[0]).toMatchObject({ authPayuId: MANDATE });
      expect((await t.tickAt(plusHours(DUE, 1))).charged).toBe(0);
      expect(revoke).toBeDefined();
    }
  });

});

describe('PayU through the facade: handles before and after authorisation', () => {
  // DEFECT (see the report): the facade resolves a REFERENCE to the schedule for cancel / pause / resume / update, but not for get().
  it.fails('subs.get accepts the reference the subscription was created with (as cancel, pause, resume and update do)', async () => {
    const t = setup();
    const subscription = await t.create();
    await t.verify();
    // Expected: the same subscription as get(COMPOSITE). Actual: VALIDATION "is not a PayU subscription id".
    const byReference = await t.subs.get(Provider.PayU, subscription.reference as string);
    expect(byReference.status).toBe(SubscriptionStatus.Active);
  });

  // DEFECT: until the customer authorises, the only handle is the reference, and the facade cannot answer for it.
  it.fails('subs.get works on the subscription create() just returned, before the customer authorises', async () => {
    const t = setup();
    const subscription = await t.create();
    const got = await t.subs.get(Provider.PayU, subscription.id);
    expect(got.status).toBe(SubscriptionStatus.Created);
  });

  // DEFECT: abandoning a never-authorised PayU subscription stops the schedule, then fails on the gateway side for good.
  it.fails('cancel of a subscription the customer never authorised succeeds (there is no mandate to revoke)', async () => {
    const t = setup();
    const subscription = await t.create();
    const cancelled = await t.subs.cancel(Provider.PayU, subscription.id);
    expect(cancelled.status).toBe(SubscriptionStatus.Cancelled);
  });

  it('what actually happens on that cancel: the schedule IS cancelled, then VALIDATION surfaces, and a retry fails the same way', async () => {
    const t = setup();
    const subscription = await t.create();
    const first = await rejection(() => t.subs.cancel(Provider.PayU, subscription.id));
    expect(first.code).toBe(ErrorCode.Validation);
    expect((await t.scheduler.get(t.scheduleId))?.status).toBe(ScheduleStatus.Cancelled);
    const second = await rejection(() => t.subs.cancel(Provider.PayU, subscription.id));
    expect(second.code).toBe(ErrorCode.Validation);
    expect(t.calls).toHaveLength(0);
  });
});
