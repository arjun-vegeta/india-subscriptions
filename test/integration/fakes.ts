import { expect } from 'vitest';
import type { WebhookRequest } from '../../src/schemas.js';
import { ChargeStatus, Environment, ErrorCode, IntervalUnit, PaymentMethod, Provider, SchedulingMode } from '../../src/constants.js';
import {
  CashfreePath,
  CashfreePaymentStatus,
  CashfreePaymentType,
  CashfreeSubscriptionStatus,
  ManageAction,
} from '../../src/providers/cashfree/constants.js';
import { PAYU_API_URLS, PAYU_NO_ERROR_CODE, PAYU_NO_ERROR_MESSAGE, PayUCommand, PayUPaymentMode, PayUPaymentSource, PayUPgType, PayUPaymentStatus, PayUTransactionState } from '../../src/providers/payu/constants.js';
import { chargeIdFor, scheduleIdFor, type SchedulerEvent } from '../../src/scheduler/index.js';
import {
  CASHFREE_ACCOUNT,
  CASHFREE_ADAPTER_TEST,
  CASHFREE_BASE_PATH,
  CASHFREE_WEBHOOK_TEST,
  CUSTOMER,
  Clock,
  PAYU_ACCOUNT,
  cashfreeProvider,
  cashfreeWebhookRequest,
  fixtureObject,
  fixtureText,
  pathOf,
  payuProvider,
  scriptedFetch,
  sha512Hex,
  signedPayuForm,
  wire,
  type Reply,
} from './helpers.js';
import type { RecordedCall } from '../helpers/mock-fetch.js';

/**
 * Stateful fake gateways shared by the scenario tests: they answer the real adapters' HTTP calls with
 * documentation-shaped payloads and remember what they were asked (charges, debits, statuses), the way a gateway does.
 */


/** 2026-01-01 10:30 IST. */
export const CF_T0 = '2026-01-01T05:00:00.000Z';
/** 2026-01-20 10:00 IST: the first charge. */
export const CF_FIRST_DUE = '2026-01-20T04:30:00.000Z';
export const CF_SECOND_DUE = '2026-02-20T04:30:00.000Z';
export const CF_AMOUNT = 49900;

const onDemandCreated = fixtureObject(CASHFREE_ADAPTER_TEST, 'SUBSCRIPTION_CREATE_ON_DEMAND');
const chargeSample = fixtureObject(CASHFREE_ADAPTER_TEST, 'CHARGE_RESPONSE');
const refundSample = fixtureObject(CASHFREE_ADAPTER_TEST, 'REFUND_ENTITY_EXAMPLE');
const paymentSample = fixtureObject(CASHFREE_ADAPTER_TEST, 'PAYMENT_ENTITY_EXAMPLE');

interface Payment {
  paymentId: string;
  status: string;
  amountRupees: number;
  scheduleDate: string;
  requestedAt: string;
}

/** A stateful Cashfree: remembers the subscription's status and every charge it was asked to raise. */
export class FakeCashfree {
  status: string = CashfreeSubscriptionStatus.Initialized;
  readonly payments = new Map<string, Payment>();
  /** The requests of `POST /subscriptions/pay`, in order. */
  readonly chargeCalls: RecordedCall[] = [];
  /** `answer`: Cashfree records the charge but the answer is lost. `request`: it never arrives. */
  loseNextChargeAnswer: 'answer' | 'request' | undefined;
  /** Called when `POST .../manage` arrives, to observe what the scheduler had already done. */
  onManage?: (action: string) => void | Promise<void>;
  planMax = 499;
  /** Cashfree's payment lookup does not see a payment it already holds until this instant (eventual consistency). */
  lookupLagUntil: string | undefined;
  /** How Cashfree answers `GET .../payments/{id}` for a payment it does not hold. The spec declares 404. */
  missingPayment: Reply = { status: 404, json: { message: 'something is not found', code: 'something_not_found', type: 'invalid_request_error' } };

  constructor(private readonly clock: { iso(): string; nowMs(): number }) {}

  private entity(id: string) {
    return {
      ...onDemandCreated,
      subscription_id: id,
      subscription_status: this.status,
      plan_details: { ...onDemandCreated.plan_details, plan_max_amount: this.planMax },
    };
  }

  private paymentEntity(subscriptionId: string, payment: Payment) {
    return {
      ...paymentSample,
      subscription_id: subscriptionId,
      payment_id: payment.paymentId,
      payment_type: CashfreePaymentType.Charge,
      payment_status: payment.status,
      payment_amount: payment.amountRupees,
      payment_schedule_date: payment.scheduleDate,
    };
  }

  readonly gateway = scriptedFetch(async (call): Promise<Reply> => {
    const path = pathOf(call.url, CASHFREE_BASE_PATH);
    const subscriptionId = (call.json as { subscription_id?: string } | undefined)?.subscription_id ?? this.lastSubscriptionId;
    if (call.method === 'POST' && path === CashfreePath.Subscriptions) {
      this.lastSubscriptionId = subscriptionId;
      return { json: this.entity(subscriptionId as string) };
    }
    if (call.method === 'GET' && path === CashfreePath.subscription(this.lastSubscriptionId as string)) {
      return { json: this.entity(this.lastSubscriptionId as string) };
    }
    if (call.method === 'POST' && path === CashfreePath.Pay) {
      this.chargeCalls.push(call);
      const body = call.json as { payment_id: string; payment_amount: number; payment_schedule_date: string; subscription_id: string };
      if (this.loseNextChargeAnswer === 'request') {
        this.loseNextChargeAnswer = undefined;
        return { networkError: true };
      }
      if (this.payments.has(body.payment_id)) return { status: 400, json: { message: 'payment_id already exists', code: 'payment_id_duplicate', type: 'invalid_request_error' } };
      const payment: Payment = {
        paymentId: body.payment_id,
        status: CashfreePaymentStatus.Initialized,
        amountRupees: body.payment_amount,
        scheduleDate: body.payment_schedule_date,
        requestedAt: this.clock.iso(),
      };
      this.payments.set(body.payment_id, payment);
      if (this.loseNextChargeAnswer === 'answer') {
        this.loseNextChargeAnswer = undefined;
        return { networkError: true };
      }
      return { json: { ...chargeSample, subscription_id: body.subscription_id, payment_id: body.payment_id, payment_amount: body.payment_amount } };
    }
    if (call.method === 'GET' && /^\/subscriptions\/[^/]+\/payments$/.test(path)) {
      return { json: [...this.payments.values()].map((payment) => this.paymentEntity(this.lastSubscriptionId as string, payment)) };
    }
    if (call.method === 'POST' && /^\/subscriptions\/[^/]+\/refunds$/.test(path)) {
      const refund = call.json as { payment_id: string; refund_id: string; refund_amount: number };
      return { json: { ...refundSample, payment_id: refund.payment_id, refund_id: refund.refund_id, refund_amount: refund.refund_amount } };
    }
    const lookup = /^\/subscriptions\/[^/]+\/payments\/([^/?]+)$/.exec(path);
    if (call.method === 'GET' && lookup) {
      const payment = this.payments.get(decodeURIComponent(lookup[1] as string));
      const visible = payment !== undefined && (this.lookupLagUntil === undefined || this.clock.nowMs() >= Date.parse(this.lookupLagUntil));
      if (!payment || !visible) return this.missingPayment;
      return { json: this.paymentEntity(this.lastSubscriptionId as string, payment) };
    }
    if (call.method === 'POST' && path === CashfreePath.manageSubscription(this.lastSubscriptionId as string)) {
      const action = (call.json as { action: string }).action;
      await this.onManage?.(action);
      if (action === ManageAction.Cancel) this.status = CashfreeSubscriptionStatus.Cancelled;
      return { json: this.entity(this.lastSubscriptionId as string) };
    }
    throw new Error(`unexpected Cashfree call ${call.method} ${path}`);
  });

  lastSubscriptionId: string | undefined;
}

export function setupCashfree(reference = 'od_ref_1', totalCycles?: number, onEvent?: (event: SchedulerEvent) => void) {
  const clock = new Clock(CF_T0);
  const fake = new FakeCashfree(clock);
  const wired = wire(cashfreeProvider(fake.gateway.fetch, clock), clock, fake.gateway.calls, onEvent);
  const scheduleId = scheduleIdFor(Provider.Cashfree, reference);
  const create = () =>
    wired.subs.create(Provider.Cashfree, {
      reference,
      plan: { name: 'On demand monthly', amount: CF_AMOUNT, interval: { unit: IntervalUnit.Month, count: 1 }, scheduling: SchedulingMode.Merchant },
      customer: { ...CUSTOMER, email: 'sushane.yadav@abc.com' },
      startAt: CF_FIRST_DUE,
      ...(totalCycles !== undefined ? { totalCycles } : {}),
      returnUrl: 'https://merchant.example/return',
    });
  const scheduler = wired.subs.scheduler!;
  const tickAt = (iso: string) => {
    clock.set(iso);
    return wired.subs.tick();
  };
  const cycle = async (index: number) => (await scheduler.listCycles(scheduleId))[index];
  /** A documentation webhook body with the ids of this test's subscription and charge patched in, signed for real. */
  const webhook = (name: string, patch: (data: Record<string, any>) => void) => {
    const body = JSON.parse(fixtureText(CASHFREE_WEBHOOK_TEST, name));
    patch(body.data);
    return cashfreeWebhookRequest(JSON.stringify(body), CASHFREE_ACCOUNT.webhookSecret);
  };
  const activate = () => {
    fake.status = CashfreeSubscriptionStatus.Active;
    return wired.subs.webhooks.handle(
      Provider.Cashfree,
      webhook('STATUS_CHANGED_2023', (data) => {
        data.subscription_details.subscription_id = reference;
        data.subscription_details.subscription_status = CashfreeSubscriptionStatus.Active;
      }),
    );
  };
  const paymentWebhook = (name: 'PAYMENT_SUCCESS_2026' | 'PAYMENT_FAILED_2026', paymentId: string, status: string) =>
    wired.subs.webhooks.handle(
      Provider.Cashfree,
      webhook(name, (data) => {
        data.subscription_id = reference;
        data.subscription_details.subscription_id = reference;
        data.payment_id = paymentId;
        data.payment_type = CashfreePaymentType.Charge;
        data.payment_status = status;
        data.payment_amount = CF_AMOUNT / 100;
      }),
    );
  return { fake, ...wired, scheduler, scheduleId, create, tickAt, cycle, activate, paymentWebhook, webhook, reference };
}



export const PAYU_T0 = '2026-01-01T00:00:00.000Z';
/** 15 Jan 2026, 10:00 IST. */
export const PAYU_DUE = '2026-01-15T04:30:00.000Z';
export const PAYU_SECOND_DUE = '2026-02-15T04:30:00.000Z';
export const PAYU_REFERENCE = 'order_100';
export const PAYU_MANDATE = '25511473084';
export const PAYU_COMPOSITE = `${PaymentMethod.Card}:${PAYU_MANDATE}`;
export const PAYU_API_URL = PAYU_API_URLS[Environment.Test];

export interface Debit {
  txnid: string;
  mihpayid: string;
  status: PayUPaymentStatus | typeof PayUTransactionState.Pending;
}

export class FakePayU {
  /** Mandate status as `check_mandate_status` reports it. */
  mandateStatus = 'active';
  /** `mandate_revoke` is answered with a body-level failure. */
  revokeFails = false;
  readonly debits = new Map<string, Debit>();
  readonly commands: Array<{ command: string; var1: Record<string, string> | string }> = [];
  /** The next `si_transaction` is answered with a failed debit. */
  failDebits = 0;
  /** The next `si_transaction` is answered with a debit still in progress (`pending`). */
  pendingDebits = 0;
  /** How many `si_transaction` requests PayU executed (a re-sent txnid executes again: PayU does not refuse duplicates). */
  executedDebits = 0;
  dropNext: 'request' | 'answer' | undefined;
  private payuId = 30141596990;

  commandsNamed(name: string) {
    return this.commands.filter((entry) => entry.command === name).map((entry) => entry.var1 as Record<string, string>);
  }

  /** Called when `mandate_revoke` arrives, to observe what the scheduler had already done. */
  onRevoke?: () => void | Promise<void>;

  readonly gateway = scriptedFetch(async (call): Promise<Reply> => {
    expect(call.url).toBe(PAYU_API_URL);
    const command = call.form?.command ?? '';
    const raw = call.form?.var1 ?? '';
    const var1 = raw.startsWith('{') ? (JSON.parse(raw) as Record<string, string>) : raw;
    this.commands.push({ command, var1 });
    switch (command) {
      case PayUCommand.CheckMandateStatus:
      case PayUCommand.NbMandateStatus:
      case PayUCommand.UpiMandateStatus:
        return { json: { status: this.mandateStatus, action: PayUCommand.CheckMandateStatus, authpayuid: PAYU_MANDATE, amount: '499.00', mandateStartDate: '2026-01-15', mandateEndDate: '2026-04-22' } };
      case PayUCommand.PreDebit:
        return { json: { invoiceid: '76323425', approvedStatus: 'na', invoiceStatus: 'unpaid', amount: (var1 as Record<string, string>).amount, status: 1, message: 'Invoice Created Successfully', action: 'MANDATE_PRE_DEBIT' } };
      case PayUCommand.SiTransaction: {
        const debit = var1 as Record<string, string>;
        if (this.dropNext === 'request') {
          this.dropNext = undefined;
          return { networkError: true };
        }
        const failed = this.failDebits > 0;
        if (failed) this.failDebits -= 1;
        const pending = !failed && this.pendingDebits > 0;
        if (pending) this.pendingDebits -= 1;
        this.executedDebits += 1;
        this.debits.set(debit.txnid as string, { txnid: debit.txnid as string, mihpayid: String(++this.payuId), status: failed ? 'failure' : pending ? 'pending' : 'success' });
        if (this.dropNext === 'answer') {
          this.dropNext = undefined;
          return { networkError: true };
        }
        return {
          json: {
            status: 1,
            message: 'Transaction Processed successfully',
            details: { [debit.txnid as string]: { authpayuid: debit.authpayuid, transactionid: debit.txnid, amount: debit.amount, payuid: '', status: failed ? 'failed' : pending ? 'pending' : 'captured', field9: failed ? 'Insufficient funds' : 'Transaction Completed Successfully' } },
          },
        };
      }
      case PayUCommand.VerifyPayment: {
        const txnid = String(var1);
        const debit = this.debits.get(txnid);
        if (!debit) {
          return { json: { status: 0, msg: '0 out of 1 Transactions Fetched Successfully', transaction_details: { [txnid]: { mihpayid: 'Not Found', status: 'Not Found' } } } };
        }
        return {
          json: {
            status: 1,
            msg: '1 out of 1 Transactions Fetched Successfully',
            transaction_details: {
              [txnid]: { mihpayid: debit.mihpayid, txnid, transaction_amount: '499.00', status: debit.status, unmappedstatus: debit.status === 'success' ? 'captured' : debit.status === 'pending' ? 'pending' : 'failed', payment_source: PayUPaymentSource.RecurringDebit, error_code: debit.status === 'success' ? 'E000' : 'E308', error_Message: debit.status === 'success' ? 'No Error' : 'Insufficient funds' },
            },
          },
        };
      }
      case PayUCommand.RefundTransaction:
        return { json: { status: 1, msg: 'Refund Request Queued', request_id: '17265314530', bank_ref_num: '100142082006', mihpayid: String(var1) } };
      case PayUCommand.MandateRevoke:
      case PayUCommand.UpiMandateRevoke:
        await this.onRevoke?.();
        if (this.revokeFails) return { json: { status: 0, action: 'MANDATE_REVOKE', message: 'Mandate is not active' } };
        return { json: { status: 1, message: 'Mandate Revoked Successfully', action: 'MANDATE_REVOKE' } };
      default:
        throw new Error(`unexpected PayU command ${command}`);
    }
  });
}

/** What PayU posts to `surl` after a card consent that registered a mandate. */
export function consentResult(txnid: string, over: Record<string, string> = {}) {
  return signedPayuForm(
    {
      mihpayid: PAYU_MANDATE,
      mode: PayUPaymentMode.CreditCard,
      status: PayUPaymentStatus.Success,
      unmappedstatus: 'captured',
      key: PAYU_ACCOUNT.key,
      txnid,
      amount: '2.00',
      addedon: '2026-01-01 05:30:00',
      productinfo: 'Pro monthly',
      firstname: 'Asha Rao',
      email: CUSTOMER.email,
      udf1: '',
      udf2: '',
      udf3: '',
      udf4: '',
      udf5: '',
      payment_source: PayUPaymentSource.MandateRegistered,
      PG_TYPE: PayUPgType.CreditCard,
      cardToken: 'tok_1',
      error: 'E000',
      error_Message: 'No Error',
      ...over,
    },
    PAYU_ACCOUNT.key,
    PAYU_ACCOUNT.salt,
  );
}

export function setupPayu(totalCycles?: number) {
  const clock = new Clock(PAYU_T0);
  const fake = new FakePayU();
  const wired = wire(payuProvider(fake.gateway.fetch, clock), clock, fake.gateway.calls);
  const scheduleId = scheduleIdFor(Provider.PayU, PAYU_REFERENCE);
  const scheduler = wired.subs.scheduler!;
  const create = () =>
    wired.subs.create(Provider.PayU, {
      reference: PAYU_REFERENCE,
      plan: { name: 'Pro monthly', amount: 49900, interval: { unit: IntervalUnit.Month, count: 1 } },
      customer: CUSTOMER,
      startAt: PAYU_DUE,
      ...(totalCycles !== undefined ? { totalCycles } : {}),
    });
  const verify = () => wired.subs.verifyCheckout(Provider.PayU, consentResult(PAYU_REFERENCE), { expectedSubscriptionId: PAYU_REFERENCE });
  const tickAt = (iso: string) => {
    clock.set(iso);
    return wired.subs.tick();
  };
  const cycle = async (index: number) => (await scheduler.listCycles(scheduleId))[index];
  return { fake, ...wired, scheduler, scheduleId, create, verify, tickAt, cycle };
}

// ---------------------------------------------------------------------------
// PayU webhook builders: the documented field sets, signed with the documented layouts
// ---------------------------------------------------------------------------

/** A bank decline code, as in PayU's own sample of a failed recurring debit. */
export const INSUFFICIENT_FUNDS_CODE = 'E308';

// ---------------------------------------------------------------------------
// PayU webhook builders: the documented field sets, signed with the documented layouts
// ---------------------------------------------------------------------------

export const form = (fields: Record<string, string>): WebhookRequest => ({ rawBody: new URLSearchParams(fields).toString(), headers: {} });
export const jsonRequest = (body: unknown): WebhookRequest => ({ rawBody: JSON.stringify(body), headers: {} });

export function upiMandateWebhook(action: string, status: string, mandate = PAYU_MANDATE): WebhookRequest {
  const fields = { status, authpayuid: mandate, action, dateTime: '2026-01-10 11:00:00', amount: '499.00', endDate: '2026-04-22 00:00:00', mandateNumber: 'UMN1@paytm', key: PAYU_ACCOUNT.key, udf1: '', udf2: '', udf3: '', udf5: '' };
  const hash = sha512Hex(`${fields.status}|${fields.action}|${fields.authpayuid}|${fields.dateTime}|${fields.amount}|${fields.endDate}|${PAYU_ACCOUNT.salt}`);
  return jsonRequest({ ...fields, hash });
}

export function cardMandateWebhook(notificationType: string, status: string, mandate = PAYU_MANDATE): WebhookRequest {
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

export function recurringDebitWebhook(txnid: string, status: PayUPaymentStatus): WebhookRequest {
  const fields = {
    mihpayid: '30141596997',
    mode: PayUPaymentMode.StandingInstruction,
    status,
    unmappedstatus: status === PayUPaymentStatus.Success ? PayUTransactionState.Captured : PayUTransactionState.Failed,
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
    error: status === PayUPaymentStatus.Success ? PAYU_NO_ERROR_CODE : INSUFFICIENT_FUNDS_CODE,
    error_Message: status === PayUPaymentStatus.Success ? PAYU_NO_ERROR_MESSAGE : 'Insufficient funds',
  };
  return form({ ...fields, hash: sha512Hex(`${PAYU_ACCOUNT.salt}|${fields.status}||||||${fields.udf5}|${fields.udf4}|${fields.udf3}|${fields.udf2}|${fields.udf1}|${fields.email}|${fields.firstname}|${fields.productinfo}|${fields.amount}|${fields.txnid}|${PAYU_ACCOUNT.key}`) });
}

