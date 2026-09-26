/**
 * Seam 2: the real Cashfree adapter, PERIODIC plan (Cashfree raises each charge), through the real facade, with
 * Cashfree's real webhook signature scheme (base64 HMAC-SHA256 of timestamp + raw body). A scheduler is configured:
 * Cashfree advertises `merchantCharges`, so the facade does consult the store for pause / resume / cancel, but it must
 * never WRITE a schedule for a gateway-scheduled subscription.
 *
 * Fixtures: test/cashfree/adapter.test.ts and test/cashfree/webhooks.test.ts (documentation samples, verbatim), with
 * the plan edited to PERIODIC exactly as that test's own `periodicResponse` does.
 */
import { describe, expect, it } from 'vitest';
import { CancelMode, ChangeTiming, ChargeKind, CheckoutKind, Environment, ErrorCode, EventType, IntervalUnit, Provider, RefundStatus, SchedulingMode, SubscriptionStatus } from '../../src/constants.js';
import { CASHFREE_BASE_URLS, CashfreePath, CashfreeSubscriptionStatus, ManageAction, RETURN_URL_SUBSCRIPTION_ID_PARAM } from '../../src/providers/cashfree/constants.js';
import { ChargeSchema, RefundSchema, SubscriptionEventSchema, SubscriptionSchema } from '../../src/schemas.js';
import {
  CASHFREE_ACCOUNT,
  CASHFREE_BASE_PATH,
  CASHFREE_ADAPTER_TEST,
  CASHFREE_WEBHOOK_TEST,
  CUSTOMER,
  Clock,
  cashfreeProvider,
  cashfreeWebhookRequest,
  fixtureObject,
  fixtureText,
  pathOf,
  rejection,
  scriptedFetch,
  sequence,
  wire,
  plusDays,
} from './helpers.js';

const NOW = '2026-11-17T05:00:00.000Z';
const REFERENCE = 'cf_sub_1';
const BASE = CASHFREE_BASE_URLS[Environment.Test];
const STORE_WRITES = ['saveSchedule', 'saveCycle', 'acquireLock'];

const onDemand = fixtureObject(CASHFREE_ADAPTER_TEST, 'SUBSCRIPTION_CREATE_ON_DEMAND');
const fetchedActive = fixtureObject(CASHFREE_ADAPTER_TEST, 'SUBSCRIPTION_FETCH_ACTIVE');
const paymentSample = fixtureObject(CASHFREE_ADAPTER_TEST, 'PAYMENT_ENTITY_EXAMPLE');
const refundSample = fixtureObject(CASHFREE_ADAPTER_TEST, 'REFUND_ENTITY_EXAMPLE');

const periodicPlan = {
  plan_id: 'plan_inline_1',
  plan_name: 'Premium Monthly',
  plan_type: 'PERIODIC',
  plan_max_cycles: 6,
  plan_recurring_amount: 499,
  plan_max_amount: 499,
  plan_interval_type: 'MONTH',
  plan_intervals: 1,
  plan_currency: 'INR',
  plan_note: null,
  plan_status: null,
};

function entity(status: string, over: Record<string, unknown> = {}) {
  return { ...fetchedActive, subscription_id: REFERENCE, subscription_status: status, plan_details: periodicPlan, ...over };
}

function gateway(clock: Clock) {
  return scriptedFetch((call) => {
    const path = pathOf(call.url, CASHFREE_BASE_PATH);
    if (call.method === 'POST' && path === CashfreePath.Subscriptions) {
      return { json: { ...onDemand, subscription_id: REFERENCE, plan_details: periodicPlan, subscription_first_charge_time: plusDays(clock.iso(), 14) } };
    }
    if (call.method === 'GET' && path === CashfreePath.subscription(REFERENCE)) return { json: entity(CashfreeSubscriptionStatus.Active) };
    if (call.method === 'POST' && path === CashfreePath.manageSubscription(REFERENCE)) {
      const action = (call.json as { action: ManageAction }).action;
      const status =
        action === ManageAction.Pause ? CashfreeSubscriptionStatus.Paused : action === ManageAction.Cancel ? CashfreeSubscriptionStatus.Cancelled : CashfreeSubscriptionStatus.Active;
      return { json: entity(status) };
    }
    if (call.method === 'GET' && path === CashfreePath.payments(REFERENCE)) return { json: [paymentSample] };
    if (call.method === 'POST' && path === CashfreePath.refunds(REFERENCE)) return { json: refundSample };
    throw new Error(`unexpected Cashfree call ${call.method} ${path}`);
  });
}

describe('Cashfree PERIODIC through the facade', () => {
  it('create -> verify -> webhooks -> manage -> charges -> refund, with no schedule ever written', async () => {
    const clock = new Clock(NOW);
    const { fetch, calls } = gateway(clock);
    const { subs, store } = wire(cashfreeProvider(fetch, clock), clock, calls);

    // create: inline PERIODIC plan, trial, upfront amount, total cycles
    const subscription = await subs.create(Provider.Cashfree, {
      reference: REFERENCE,
      plan: { name: 'Premium Monthly', amount: 49900, interval: { unit: IntervalUnit.Month, count: 1 } },
      customer: { ...CUSTOMER, email: 'sushane.yadav@abc.com' },
      trial: { days: 14 },
      totalCycles: 6,
      upfrontAmount: 5000,
      returnUrl: 'https://merchant.example/return',
    });
    expect(sequence(calls, CASHFREE_BASE_PATH)).toEqual([`POST ${CashfreePath.Subscriptions}`]);
    expect(calls[0]?.url).toBe(`${BASE}${CashfreePath.Subscriptions}`);
    expect(calls[0]?.json).toMatchObject({
      subscription_id: REFERENCE,
      plan_details: { plan_type: 'PERIODIC', plan_amount: 499, plan_max_cycles: 6, plan_intervals: 1 },
      authorization_details: { authorization_amount: 50, authorization_amount_refund: false },
    });
    expect(subscription).toMatchObject({
      id: REFERENCE,
      scheduling: SchedulingMode.Gateway,
      status: SubscriptionStatus.Created,
      amount: 49900,
      interval: { unit: IntervalUnit.Month, count: 1 },
      checkout: { kind: CheckoutKind.CashfreeCheckout, environment: Environment.Test },
    });
    expect(SubscriptionSchema.safeParse(subscription).success).toBe(true);
    expect(store.calls.filter((name) => STORE_WRITES.includes(name))).toEqual([]);

    // verifyCheckout: the return URL carries only the subscription id; the adapter fetches the subscription.
    calls.length = 0;
    const verification = await subs.verifyCheckout(Provider.Cashfree, { [RETURN_URL_SUBSCRIPTION_ID_PARAM]: REFERENCE }, { expectedSubscriptionId: REFERENCE });
    expect(sequence(calls, CASHFREE_BASE_PATH)).toEqual([`GET ${CashfreePath.subscription(REFERENCE)}`]);
    expect(verification).toMatchObject({ authorized: true, subscriptionId: REFERENCE, reference: REFERENCE, status: SubscriptionStatus.Active });
    expect((await rejection(() => subs.verifyCheckout(Provider.Cashfree, { [RETURN_URL_SUBSCRIPTION_ID_PARAM]: REFERENCE }, { expectedSubscriptionId: 'other' }))).code).toBe(ErrorCode.SignatureInvalid);

    // webhooks with Cashfree's signature scheme
    calls.length = 0;
    const documented: Array<[string, EventType]> = [
      ['STATUS_CHANGED_2023', EventType.SubscriptionActivated],
      ['NOTIFICATION_2026', EventType.SubscriptionChargeScheduled],
      ['PAYMENT_SUCCESS_2026', EventType.SubscriptionCharged],
      ['PAYMENT_FAILED_2026', EventType.SubscriptionChargeFailed],
    ];
    for (const [name, type] of documented) {
      const events = await subs.webhooks.handle(Provider.Cashfree, cashfreeWebhookRequest(fixtureText(CASHFREE_WEBHOOK_TEST, name), CASHFREE_ACCOUNT.webhookSecret));
      expect(events).toHaveLength(1);
      expect(SubscriptionEventSchema.safeParse(events[0]).success).toBe(true);
      expect(events[0]).toMatchObject({ provider: Provider.Cashfree, type });
    }
    const forged = cashfreeWebhookRequest(fixtureText(CASHFREE_WEBHOOK_TEST, 'PAYMENT_SUCCESS_2026'), 'not-the-secret');
    expect((await rejection(() => subs.webhooks.handle(Provider.Cashfree, forged))).code).toBe(ErrorCode.SignatureInvalid);
    expect(calls).toEqual([]);

    // manage
    await subs.get(Provider.Cashfree, REFERENCE);
    const paused = await subs.pause(Provider.Cashfree, REFERENCE);
    const resumed = await subs.resume(Provider.Cashfree, REFERENCE, { nextChargeAt: plusDays(NOW, 30) });
    await subs.update(Provider.Cashfree, REFERENCE, { planId: 'plan_other' });
    const cancelled = await subs.cancel(Provider.Cashfree, REFERENCE);
    const atEnd = await rejection(() => subs.cancel(Provider.Cashfree, REFERENCE, { mode: CancelMode.AtPeriodEnd }));
    const charges = await subs.charges.list(Provider.Cashfree, REFERENCE);
    const refund = await subs.charges.refund(Provider.Cashfree, { subscriptionId: REFERENCE, chargeId: 'test-payment-id', refundId: 'refund_1', amount: 100 });

    expect(sequence(calls, CASHFREE_BASE_PATH)).toEqual([
      `GET ${CashfreePath.subscription(REFERENCE)}`,
      `GET ${CashfreePath.subscription(REFERENCE)}`, // pause reads the subscription to see whether it is merchant-scheduled
      `POST ${CashfreePath.manageSubscription(REFERENCE)}`,
      `GET ${CashfreePath.subscription(REFERENCE)}`,
      `POST ${CashfreePath.manageSubscription(REFERENCE)}`,
      `GET ${CashfreePath.subscription(REFERENCE)}`,
      `POST ${CashfreePath.manageSubscription(REFERENCE)}`,
      `POST ${CashfreePath.manageSubscription(REFERENCE)}`,
      `GET ${CashfreePath.payments(REFERENCE)}`,
      `POST ${CashfreePath.refunds(REFERENCE)}`,
    ]);
    expect(calls.filter((call) => call.method === 'POST' && pathOf(call.url, CASHFREE_BASE_PATH).endsWith('/manage')).map((call) => (call.json as { action: string }).action)).toEqual([
      ManageAction.Pause,
      ManageAction.Activate,
      ManageAction.ChangePlan,
      ManageAction.Cancel,
    ]);
    expect(paused.status).toBe(SubscriptionStatus.Paused);
    expect(resumed.status).toBe(SubscriptionStatus.Active);
    expect(cancelled.status).toBe(SubscriptionStatus.Cancelled);
    expect(atEnd.code).toBe(ErrorCode.Unsupported); // capabilities.cancelAtPeriodEnd is false, and says so
    expect(charges[0]).toMatchObject({ id: 'test-payment-id', kind: ChargeKind.Authorization });
    for (const charge of charges) expect(ChargeSchema.safeParse(charge).success).toBe(true);
    // The refund echoes the documented sample's own amount (INR 100); the request carried INR 1.00.
    expect(calls.at(-1)?.json).toMatchObject({ refund_amount: 1, refund_id: 'refund_1', payment_id: 'test-payment-id' });
    expect(refund).toMatchObject({ status: RefundStatus.Pending, amount: 10000 });
    expect(RefundSchema.safeParse(refund).success).toBe(true);

    // a PERIODIC subscription never gets a schedule, even though the facade has a scheduler for this gateway
    expect(store.calls.filter((name) => STORE_WRITES.includes(name))).toEqual([]);
    expect(await subs.scheduler?.find(Provider.Cashfree, REFERENCE)).toBeUndefined();
    expect(ChangeTiming.Immediately).toBeDefined();
  });
});
