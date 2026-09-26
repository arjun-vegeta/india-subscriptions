/**
 * Seam 5: the fine print between the BillingScheduler and the merchant-scheduled adapters (PayU, Cashfree on-demand):
 * are the ids it generates legal for each gateway, is `customer` passed where an adapter can use it, does `getCharge`
 * answer NOT_FOUND the way the scheduler relies on, does a scheduled / pending charge land the cycle in the right state.
 */
import { describe, expect, it } from 'vitest';
import { ChargeStatus, ErrorCode, EventType, Provider, SchedulingMode } from '../../src/constants.js';
import { CashfreeChargeRequestSchema } from '../../src/providers/cashfree/schemas.js';
import { TXNID_MAX_LENGTH, TXNID_PATTERN, PayUCommand, INVOICE_NUMBER_PREFIX } from '../../src/providers/payu/constants.js';
import { PayUPreDebitVar1Schema, PayUSiTransactionVar1Schema } from '../../src/providers/payu/schemas.js';
import { CashfreePath, CashfreePaymentStatus } from '../../src/providers/cashfree/constants.js';
import {
  BillingScheduler,
  CycleStatus,
  MAX_GATEWAY_ID_LENGTH,
  MemorySchedulerStore,
  ScheduleStatus,
  SchedulerEventType,
  SchedulerIdPrefix,
  chargeIdFor,
  notificationIdFor,
} from '../../src/scheduler/index.js';
import { CreateChargeInputSchema, NotifyChargeInputSchema } from '../../src/schemas.js';
import type { SchedulerEvent } from '../../src/scheduler/index.js';
import { CF_FIRST_DUE, PAYU_DUE, setupCashfree, setupPayu } from './fakes.js';
import { Clock, CUSTOMER, cashfreeProvider, plusHours, razorpayProvider, rejection, scriptedFetch } from './helpers.js';

describe('ids the scheduler generates versus the gateways\' own id rules', () => {
  const scheduleIds = ['payu:order_100', 'cashfree:od_ref_1', 'cashfree:' + 'x'.repeat(250), 'payu:ünï cödé with spaces/and|pipes', 'custom id', 'razorpay:sub_1'];
  const extremes: Array<[number, number, number]> = [
    [0, 1, 1],
    [1, 2, 1],
    [35, 3, 36],
    [99_999, 999, 1_295],
  ];

  it('every charge id is at most 25 characters of [A-Za-z0-9_]: valid as a PayU txnid and as a Cashfree payment_id, for any schedule id', () => {
    for (const scheduleId of scheduleIds) {
      for (const [cycle, attempt] of extremes.map(([c, a]) => [c, a] as const)) {
        const id = chargeIdFor(scheduleId, cycle, attempt);
        expect(id.length).toBeLessThanOrEqual(TXNID_MAX_LENGTH);
        expect(id).toMatch(TXNID_PATTERN);
        expect(id.startsWith(SchedulerIdPrefix.Charge)).toBe(true);
        // The request each adapter builds from it validates.
        expect(PayUSiTransactionVar1Schema.safeParse({ authpayuid: '1', amount: '1.00', txnid: id }).success).toBe(true);
        expect(
          CashfreeChargeRequestSchema.safeParse({ subscription_id: 's', payment_id: id, payment_type: 'CHARGE', payment_amount: 1, payment_schedule_date: '2026-01-01T00:00:00+05:30' }).success,
        ).toBe(true);
        expect(CreateChargeInputSchema.safeParse({ subscriptionId: 's', chargeId: id, amount: 100 }).success).toBe(true);
      }
    }
  });

  it('every notification id (the PayU requestId) is at most 25 characters of [A-Za-z0-9_], and so is the invoice number derived from it when it fits the 50 of the contract', () => {
    for (const scheduleId of scheduleIds) {
      for (const [cycle, attempt, round] of extremes) {
        const id = notificationIdFor(scheduleId, cycle, attempt, round);
        expect(id.length).toBeLessThanOrEqual(MAX_GATEWAY_ID_LENGTH);
        expect(id).toMatch(TXNID_PATTERN);
        expect(PayUPreDebitVar1Schema.safeParse({ authpayuid: '1', requestId: id, amount: '1.00', debitDate: '2026-01-01', invoiceDisplayNumber: `${INVOICE_NUMBER_PREFIX}_${id}` }).success).toBe(true);
        expect(NotifyChargeInputSchema.safeParse({ subscriptionId: 's', notificationId: id, amount: 100, debitAt: '2026-01-01T00:00:00Z', invoiceNumber: `${INVOICE_NUMBER_PREFIX}_${id}` }).success).toBe(true);
      }
    }
  });

  it('different schedules, cycles and attempts never share an id', () => {
    const ids = new Set<string>();
    for (const scheduleId of scheduleIds) for (const [cycle, attempt] of [[0, 1], [0, 2], [1, 1], [1, 2]] as const) ids.add(chargeIdFor(scheduleId, cycle, attempt));
    expect(ids.size).toBe(scheduleIds.length * 4);
  });

  // Two modules agree here by value only: the scheduler's constant is commented "PayU's transaction id limit" but does not import it.
  it('MAX_GATEWAY_ID_LENGTH (scheduler) and TXNID_MAX_LENGTH (PayU adapter) are the same number, by coincidence of two separate constants', () => {
    expect(MAX_GATEWAY_ID_LENGTH).toBe(TXNID_MAX_LENGTH);
  });
});

describe('what the scheduler passes to the adapter, observed on the wire', () => {
  it('PayU: the customer\'s phone and e-mail reach si_transaction; the notification id is the pre-debit requestId; the invoice number is carried from notice to debit', async () => {
    const t = setupPayu();
    await t.create();
    await t.verify();
    await t.tickAt(plusHours(PAYU_DUE, -48));
    await t.tickAt(PAYU_DUE);
    const [notice] = t.fake.commandsNamed(PayUCommand.PreDebit);
    const [debit] = t.fake.commandsNamed(PayUCommand.SiTransaction);
    expect(debit).toMatchObject({ phone: CUSTOMER.phone, email: CUSTOMER.email });
    expect(notice?.invoiceDisplayNumber).toBe(debit?.invoiceDisplayNumber);
    expect(notice?.requestId).toBe(notificationIdFor(t.scheduleId, 0, 1, 1));
  });

  it('Cashfree: no pre-debit notification call exists for it (the gateway notifies once the charge is scheduled): notifyCharge is UNSUPPORTED and the scheduler never calls it', async () => {
    const t = setupCashfree();
    await t.create();
    await t.activate();
    expect(t.provider.capabilities).toMatchObject({ merchantPreDebitNotification: false, merchantCharges: true });
    expect((await rejection(() => t.provider.notifyCharge({ subscriptionId: t.reference, notificationId: 'n', amount: 100, debitAt: CF_FIRST_DUE }))).code).toBe(ErrorCode.Unsupported);
    const result = await t.tickAt(plusHours(CF_FIRST_DUE, -48));
    expect(result).toMatchObject({ notified: 0, charged: 1 });
  });

  it('the scheduler refuses a gateway that raises its own debits (Razorpay): nothing to schedule', async () => {
    const clock = new Clock('2026-01-01T00:00:00.000Z');
    const razorpay = razorpayProvider(scriptedFetch(() => ({ status: 500 })).fetch, clock);
    const scheduler = new BillingScheduler({ store: new MemorySchedulerStore(), resolveProvider: () => razorpay, now: clock.now });
    const error = await rejection(() =>
      scheduler.register({ provider: Provider.Razorpay, subscriptionId: 'sub_1', amount: 49900, interval: { unit: 'month', count: 1 }, firstChargeAt: '2026-02-01T00:00:00Z' }),
    );
    expect(error.code).toBe(ErrorCode.Unsupported);
  });
});

describe('getCharge answers NOT_FOUND the way the scheduler relies on', () => {
  it('PayU: verify_payment "Not Found" is NOT_FOUND; Cashfree: HTTP 404 is NOT_FOUND', async () => {
    const payu = setupPayu();
    await payu.create();
    await payu.verify();
    expect((await rejection(() => payu.provider.getCharge('card:25511473084', 'c_unknown_0_1'))).code).toBe(ErrorCode.NotFound);

    const cashfree = setupCashfree();
    await cashfree.create();
    await cashfree.activate();
    expect((await rejection(() => cashfree.provider.getCharge(cashfree.reference, 'c_unknown_0_1'))).code).toBe(ErrorCode.NotFound);
  });

  // RISK, not a proven defect: Cashfree's spec declares 404 for this endpoint, but its error table also lists
  // `payment_id_missing` ("Payment ID is missing or not found") without a status. Were that a 400, the scheduler could
  // never tell "never reached Cashfree" from "unknown": it would stay `charging`, raise `charge.outcome_overdue` on every
  // tick and never re-send. Safe against double debits, but the customer is not billed until an operator acts.
  it('RISK: if Cashfree answered a missing payment with 400 instead of 404, a lost request is never re-sent; the cycle stays charging and is reported overdue every tick', async () => {
    const events: SchedulerEvent[] = [];
    const t = setupCashfree('od_ref_400', undefined, (event) => void events.push(event));
    t.fake.missingPayment = { status: 400, json: { message: 'Payment ID is missing or not found', code: 'payment_id_missing', type: 'invalid_request_error' } };
    await t.create();
    await t.activate();
    t.fake.loseNextChargeAnswer = 'request';
    const at = plusHours(CF_FIRST_DUE, -48);
    await t.tickAt(at);
    for (const hours of [1, 2, 24]) {
      const result = await t.tickAt(plusHours(at, hours));
      expect(result.charged).toBe(0);
      expect(result.errors[0]?.code).toBe(ErrorCode.Validation);
    }
    expect((await t.cycle(0))?.status).toBe(CycleStatus.Charging);
    expect(t.fake.chargeCalls).toHaveLength(1);
    expect(events.filter((event) => event.type === SchedulerEventType.ChargeOutcomeOverdue).length).toBeGreaterThan(0);
    expect(CashfreePath.Pay).toBeDefined();
  });
});

describe('a Charge with status scheduled / pending lands the cycle in awaiting_confirmation', () => {
  it('Cashfree INITIALIZED (scheduled) and PENDING; PayU pending', async () => {
    const cf = setupCashfree();
    await cf.create();
    await cf.activate();
    await cf.tickAt(plusHours(CF_FIRST_DUE, -48));
    const id = chargeIdFor(cf.scheduleId, 0, 1);
    expect((await cf.cycle(0))?.status).toBe(CycleStatus.AwaitingConfirmation);
    cf.fake.payments.get(id)!.status = CashfreePaymentStatus.Pending;
    await cf.tickAt(plusHours(CF_FIRST_DUE, 1));
    expect((await cf.cycle(0))?.status).toBe(CycleStatus.AwaitingConfirmation);

    const pu = setupPayu();
    await pu.create();
    await pu.verify();
    await pu.tickAt(plusHours(PAYU_DUE, -48));
    pu.fake.pendingDebits = 1;
    const result = await pu.tickAt(PAYU_DUE);
    expect(result).toMatchObject({ charged: 1, awaiting: 1, succeeded: 0 });
    expect((await pu.cycle(0))?.status).toBe(CycleStatus.AwaitingConfirmation);
    expect(ChargeStatus.Pending).toBeDefined();
    expect(EventType.SubscriptionCharged).toBeDefined();
  });
});

describe('update() on a merchant-scheduled subscription', () => {
  it('PayU card mandate: an amount change is refused by the adapter (a card mandate cannot be modified server to server) and the schedule keeps its amount', async () => {
    const t = setupPayu();
    await t.create();
    await t.verify();
    const error = await rejection(() => t.subs.update(Provider.PayU, 'card:25511473084', { amount: 40000 }));
    expect(error.code).toBe(ErrorCode.Unsupported);
    expect((await t.scheduler.get(t.scheduleId))?.amount).toBe(49900);
    expect(t.provider.capabilities.scheduling).toEqual([SchedulingMode.Merchant]);
    expect(ScheduleStatus.Active).toBeDefined();
  });
});
