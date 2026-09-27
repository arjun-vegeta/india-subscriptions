/**
 * The merchant-scheduled adapter conformance suite (`test/helpers/merchant-adapter-conformance.ts`) applied to the two
 * adapters that exist: Cashfree on-demand (charge raised ahead, the gateway notifies) and PayU (merchant notifies, then debits),
 * each on the scripted fakes of `fakes.ts`. PhonePe and Paytm get the same one-call treatment.
 */
import { ChargeStatus, EventType, IntervalUnit, SchedulingMode } from '../../src/constants.js';
import { CashfreePaymentStatus, CashfreePaymentType, CashfreeSubscriptionStatus } from '../../src/providers/cashfree/constants.js';
import { PayUCommand, PayUMandateNotification, PayUPaymentMode, PayUPaymentStatus, PayUPgType, PayUUpiMandateAction, PayUUpiMandateStatus } from '../../src/providers/payu/constants.js';
import {
  describeMerchantAdapterConformance,
  type ConformanceGateway,
  type DebitOutcome,
} from '../helpers/merchant-adapter-conformance.js';
import { FakeCashfree, FakePayU, PAYU_MANDATE, consentResult, recurringDebitWebhook, upiMandateWebhook } from './fakes.js';
import {
  CASHFREE_ACCOUNT,
  CASHFREE_WEBHOOK_TEST,
  CUSTOMER,
  cashfreeProvider,
  cashfreeWebhookRequest,
  fixtureText,
  payuProvider,
} from './helpers.js';

const START = '2026-01-01T05:00:00.000Z';
const FIRST_CHARGE = '2026-01-20T04:30:00.000Z';
const PLAN = { name: 'Conformance monthly', amount: 49900, interval: { unit: IntervalUnit.Month, count: 1 } } as const;

describeMerchantAdapterConformance({
  name: 'Cashfree on-demand',
  startAt: START,
  firstChargeAt: FIRST_CHARGE,
  flags: { rejectsDuplicateIds: true },
  setup(clock) {
    const fake = new FakeCashfree(clock);
    const reference = 'conf_cf_1';
    const webhook = (name: string, patch: (data: Record<string, any>) => void) => {
      const body = JSON.parse(fixtureText(CASHFREE_WEBHOOK_TEST, name));
      patch(body.data);
      return cashfreeWebhookRequest(JSON.stringify(body), CASHFREE_ACCOUNT.webhookSecret);
    };
    const status = (value: string) =>
      webhook('STATUS_CHANGED_2023', (data) => {
        data.subscription_details.subscription_id = reference;
        data.subscription_details.subscription_status = value;
      });
    const gateway: ConformanceGateway = {
      authorise: () => {
        fake.status = CashfreeSubscriptionStatus.Active;
        return { checkoutResult: { cf_subscriptionId: reference } };
      },
      chargeRequestIds: () => fake.chargeCalls.map((call) => (call.json as { payment_id: string }).payment_id),
      notificationIds: () => [],
      debitCount: () => fake.payments.size,
      holdNextCharge: () => undefined,
      settle: (chargeId, outcome: DebitOutcome) => {
        const payment = fake.payments.get(chargeId);
        if (!payment) throw new Error(`Cashfree holds no payment ${chargeId}`);
        payment.status = outcome === ChargeStatus.Succeeded ? CashfreePaymentStatus.Success : CashfreePaymentStatus.Failed;
      },
      loseNextChargeAnswer: () => void (fake.loseNextChargeAnswer = 'answer'),
      loseNextChargeRequest: () => void (fake.loseNextChargeAnswer = 'request'),
      hideDebitsUntil: (iso) => void (fake.lookupLagUntil = iso),
      debitWebhook: (chargeId, outcome) =>
        webhook(outcome === ChargeStatus.Succeeded ? 'PAYMENT_SUCCESS_2026' : 'PAYMENT_FAILED_2026', (data) => {
          data.subscription_id = reference;
          data.subscription_details.subscription_id = reference;
          data.payment_id = chargeId;
          data.payment_type = CashfreePaymentType.Charge;
          data.payment_status = outcome === ChargeStatus.Succeeded ? CashfreePaymentStatus.Success : CashfreePaymentStatus.Failed;
          data.payment_amount = PLAN.amount / 100;
        }),
      mandateWebhook: (event) =>
        status(
          event === EventType.SubscriptionPaused
            ? CashfreeSubscriptionStatus.CustomerPaused
            : event === EventType.SubscriptionResumed
              ? CashfreeSubscriptionStatus.Active
              : CashfreeSubscriptionStatus.CustomerCancelled,
        ),
    };
    return {
      adapter: cashfreeProvider(fake.gateway.fetch, clock),
      gateway,
      createInput: {
        reference,
        plan: { ...PLAN, scheduling: SchedulingMode.Merchant },
        customer: { ...CUSTOMER, email: 'sushane.yadav@abc.com' },
        startAt: FIRST_CHARGE,
      },
    };
  },
});

describeMerchantAdapterConformance({
  name: 'PayU (UPI mandate)',
  startAt: START,
  firstChargeAt: FIRST_CHARGE,
  // PayU does not refuse a txnid it already holds: the adapter looks the id up before it debits.
  flags: { rejectsDuplicateIds: false },
  setup(clock) {
    const fake = new FakePayU();
    const reference = 'conf_payu_1';
    const upi = (txnid: string) => consentResult(txnid, { mode: PayUPaymentMode.Upi, PG_TYPE: PayUPgType.Upi });
    const gateway: ConformanceGateway = {
      authorise: () => ({ checkoutResult: upi(reference) }),
      chargeRequestIds: () => fake.commandsNamed(PayUCommand.SiTransaction).map((request) => request.txnid as string),
      notificationIds: () => fake.commandsNamed(PayUCommand.PreDebit).map((request) => request.requestId as string),
      debitCount: () => fake.executedDebits,
      holdNextCharge: () => void (fake.pendingDebits += 1),
      settle: (chargeId, outcome: DebitOutcome) => {
        const debit = fake.debits.get(chargeId);
        if (!debit) throw new Error(`PayU holds no debit ${chargeId}`);
        debit.status = outcome === ChargeStatus.Succeeded ? PayUPaymentStatus.Success : PayUPaymentStatus.Failure;
      },
      loseNextChargeAnswer: () => void (fake.dropNext = 'answer'),
      loseNextChargeRequest: () => void (fake.dropNext = 'request'),
      debitWebhook: (chargeId, outcome) =>
        recurringDebitWebhook(chargeId, outcome === ChargeStatus.Succeeded ? PayUPaymentStatus.Success : PayUPaymentStatus.Failure),
      mandateWebhook: (event) =>
        event === EventType.SubscriptionPaused
          ? upiMandateWebhook(PayUUpiMandateAction.Pause, PayUUpiMandateStatus.Pause, PAYU_MANDATE)
          : event === EventType.SubscriptionResumed
            ? upiMandateWebhook(PayUUpiMandateAction.Unpause, PayUUpiMandateStatus.Active, PAYU_MANDATE)
            : upiMandateWebhook(PayUUpiMandateAction.Revoke, PayUUpiMandateStatus.Revoked, PAYU_MANDATE),
    };
    return {
      adapter: payuProvider(fake.gateway.fetch, clock),
      gateway,
      createInput: { reference, plan: { ...PLAN }, customer: CUSTOMER, startAt: FIRST_CHARGE },
    };
  },
});

void PayUMandateNotification;
