/**
 * Seam 1: the real Razorpay adapter through the real `Subscriptions` facade, with scripted HTTP in place of
 * api.razorpay.com. A billing scheduler IS configured on the facade (on a counting store), so "no scheduler is
 * involved" is a measurement: Razorpay raises its own debits, the facade must never touch the store for it.
 *
 * Fixtures are the documentation samples of test/razorpay/adapter.test.ts and test/razorpay/webhook.test.ts, read
 * from those files verbatim.
 */
import { describe, expect, it } from 'vitest';
import { CancelMode, CheckoutKind, ErrorCode, IntervalUnit, EventType, HttpMethod, Provider, RefundStatus, SchedulingMode, SubscriptionStatus, ChangeTiming } from '../../src/constants.js';
import { RAZORPAY_BASE_URL, RazorpayEndpoint, RazorpayNoteKey, RazorpayRefundStatus, RazorpayScheduleChangeAt, RazorpaySubscriptionStatus } from '../../src/providers/razorpay/constants.js';
import { SubscriptionEventSchema, SubscriptionSchema, ChargeSchema, RefundSchema } from '../../src/schemas.js';
import {
  CUSTOMER,
  Clock,
  RAZORPAY_ACCOUNT,
  RAZORPAY_ADAPTER_TEST,
  RAZORPAY_WEBHOOK_TEST,
  fixtureJson,
  fixtureText,
  hmacHex,
  pathOf,
  razorpayProvider,
  razorpayWebhookRequest,
  rejection,
  scriptedFetch,
  sequence,
  wire,
} from './helpers.js';

const NOW = '2026-03-13T10:00:00.000Z';
const NOW_UNIX = Date.parse(NOW) / 1000;
const SUB_ID = 'sub_00000000000001';
const REFERENCE = 'order_1042';

const planDoc = fixtureJson(RAZORPAY_ADAPTER_TEST, 'CREATE_PLAN_RESPONSE');
/** The documented plan sample, edited to the monthly plan the test asks for. */
const monthlyPlan = { ...planDoc, id: 'plan_00000000000001', period: 'monthly', interval: 1, item: { ...planDoc.item, name: 'Pro monthly', amount: 49900, unit_amount: 49900 } };
const createdSubscription = {
  ...fixtureJson(RAZORPAY_ADAPTER_TEST, 'CREATE_SUBSCRIPTION_RESPONSE'),
  notes: { [RazorpayNoteKey.Reference]: REFERENCE },
  total_count: 12,
  remaining_count: 12,
  start_at: NOW_UNIX + 14 * 86_400,
  charge_at: NOW_UNIX + 14 * 86_400,
};
const fetched = fixtureJson(RAZORPAY_ADAPTER_TEST, 'FETCH_SUBSCRIPTION_RESPONSE');
const refundEntity = {
  // No refund sample exists in the subscription docs; this follows the SDK's refund type (see the adapter test).
  id: 'rfnd_FP8QHiV938haTz',
  entity: 'refund',
  amount: 5000,
  currency: 'INR',
  payment_id: 'pay_00000000000002',
  receipt: 'refund-1',
  notes: [],
  status: RazorpayRefundStatus.Processed,
  created_at: NOW_UNIX,
};

function gateway() {
  return scriptedFetch((call) => {
    const path = pathOf(call.url);
    const key = `${call.method} ${path.split('?')[0]}`;
    switch (key) {
      case `POST ${RazorpayEndpoint.plans}`:
        return { json: monthlyPlan };
      case `POST ${RazorpayEndpoint.subscriptions}`:
        return { json: createdSubscription };
      case `GET ${RazorpayEndpoint.subscription(SUB_ID)}`:
        return { json: { ...fetched, notes: { [RazorpayNoteKey.Reference]: REFERENCE } } };
      case `POST ${RazorpayEndpoint.pauseSubscription(SUB_ID)}`:
        return { json: fixtureJson(RAZORPAY_ADAPTER_TEST, 'PAUSE_RESPONSE') };
      case `POST ${RazorpayEndpoint.resumeSubscription(SUB_ID)}`:
        return { json: fixtureJson(RAZORPAY_ADAPTER_TEST, 'RESUME_RESPONSE') };
      case `PATCH ${RazorpayEndpoint.subscription(SUB_ID)}`:
        return { json: fixtureJson(RAZORPAY_ADAPTER_TEST, 'UPDATE_RESPONSE') };
      case `POST ${RazorpayEndpoint.cancelSubscription(SUB_ID)}`:
        return { json: fixtureJson(RAZORPAY_ADAPTER_TEST, 'CANCEL_RESPONSE') };
      case `GET ${RazorpayEndpoint.invoices}`:
        return { json: fixtureJson(RAZORPAY_ADAPTER_TEST, 'INVOICES_RESPONSE') };
      case `POST ${RazorpayEndpoint.refundPayment('pay_00000000000002')}`:
        return { json: refundEntity };
      default:
        throw new Error(`unexpected Razorpay call ${key}`);
    }
  });
}

describe('Razorpay through the facade', () => {
  it('create -> verify -> webhooks -> manage -> charges -> refund, call by call, never touching the scheduler', async () => {
    const clock = new Clock(NOW);
    const { fetch, calls } = gateway();
    const { subs, store } = wire(razorpayProvider(fetch, clock), clock, calls);

    // 1. create: an inline plan, a trial, an upfront amount and a total cycle count.
    const subscription = await subs.create(Provider.Razorpay, {
      reference: REFERENCE,
      plan: { name: 'Pro monthly', amount: 49900, interval: { unit: IntervalUnit.Month, count: 1 } },
      customer: CUSTOMER,
      trial: { days: 14 },
      totalCycles: 12,
      upfrontAmount: 9900,
      upfrontLabel: 'Setup fee',
      returnUrl: 'https://merchant.example/return',
    });
    expect(sequence(calls)).toEqual([`POST ${RazorpayEndpoint.plans}`, `POST ${RazorpayEndpoint.subscriptions}`]);
    expect(calls[0]?.url).toBe(`${RAZORPAY_BASE_URL}${RazorpayEndpoint.plans}`);
    expect(calls[1]?.json).toMatchObject({
      plan_id: 'plan_00000000000001',
      total_count: 12,
      start_at: NOW_UNIX + 14 * 86_400,
      addons: [{ item: { name: 'Setup fee', amount: 9900 } }],
      notes: { [RazorpayNoteKey.Reference]: REFERENCE },
    });
    expect(subscription).toMatchObject({
      id: SUB_ID,
      reference: REFERENCE,
      scheduling: SchedulingMode.Gateway,
      status: SubscriptionStatus.Created,
      amount: 49900,
      totalCycles: 12,
      checkout: { kind: CheckoutKind.RazorpayCheckout, keyId: RAZORPAY_ACCOUNT.keyId, subscriptionId: SUB_ID },
    });
    expect(SubscriptionSchema.safeParse(subscription).success).toBe(true);

    // 2. verifyCheckout with a real signature; no network call.
    const before = calls.length;
    const paymentId = 'pay_AuthorisationOne';
    const result = {
      razorpay_payment_id: paymentId,
      razorpay_subscription_id: SUB_ID,
      razorpay_signature: hmacHex(RAZORPAY_ACCOUNT.keySecret, `${paymentId}|${SUB_ID}`),
    };
    const verification = await subs.verifyCheckout(Provider.Razorpay, result, { expectedSubscriptionId: subscription.id });
    expect(verification).toMatchObject({ authorized: true, subscriptionId: SUB_ID });
    expect((await rejection(() => subs.verifyCheckout(Provider.Razorpay, { ...result, razorpay_signature: 'forged' }))).code).toBe(
      ErrorCode.SignatureInvalid,
    );
    expect(calls).toHaveLength(before);
    // A genuine result of ANOTHER subscription is refused when the caller says which one it expected. The expected value is
    // neither the verified id nor a reference the result carries, so the facade reads the verified subscription ONCE to
    // compare its reference (it may be the merchant's own reference).
    expect(
      (await rejection(() => subs.verifyCheckout(Provider.Razorpay, result, { expectedSubscriptionId: 'sub_someone_else' }))).code,
    ).toBe(ErrorCode.SignatureInvalid);
    expect(sequence(calls.slice(before))).toEqual([`GET ${RazorpayEndpoint.subscription(SUB_ID)}`]);
    calls.length = before;

    // 3. The documented webhooks, in order, each signed with the webhook secret.
    const documented: Array<[string, EventType]> = [
      ['WEBHOOK_AUTHENTICATED', EventType.SubscriptionAuthorized],
      ['WEBHOOK_ACTIVATED_FUTURE', EventType.SubscriptionActivated],
      ['WEBHOOK_CHARGED', EventType.SubscriptionCharged],
      ['WEBHOOK_PENDING', EventType.SubscriptionPastDue],
      ['WEBHOOK_HALTED', EventType.SubscriptionHalted],
      ['WEBHOOK_CANCELLED', EventType.SubscriptionCancelled],
    ];
    const seen: EventType[] = [];
    for (const [name, expected] of documented) {
      const rawBody = fixtureText(RAZORPAY_WEBHOOK_TEST, name);
      const events = await subs.webhooks.handle(Provider.Razorpay, razorpayWebhookRequest(rawBody, RAZORPAY_ACCOUNT.webhookSecret, `evt_${name}`));
      expect(events).toHaveLength(1);
      expect(SubscriptionEventSchema.safeParse(events[0]).success).toBe(true);
      expect(events[0]).toMatchObject({ id: `evt_${name}`, provider: Provider.Razorpay, type: expected });
      expect(events[0]?.subscriptionId).toBeDefined();
      seen.push(events[0]!.type);
    }
    expect(seen).toEqual(documented.map(([, type]) => type));
    const charged = (await subs.webhooks.parse(Provider.Razorpay, razorpayWebhookRequest(fixtureText(RAZORPAY_WEBHOOK_TEST, 'WEBHOOK_CHARGED'), RAZORPAY_ACCOUNT.webhookSecret)))[0];
    expect(charged?.charge).toMatchObject({ id: 'pay_DEXFWroJ6LikKT', reference: 'inv_DEXFWVuM6rPqlK' });
    // A webhook with a wrong signature is refused; a tampered body too.
    const good = razorpayWebhookRequest(fixtureText(RAZORPAY_WEBHOOK_TEST, 'WEBHOOK_HALTED'), RAZORPAY_ACCOUNT.webhookSecret);
    expect((await rejection(() => subs.webhooks.handle(Provider.Razorpay, { ...good, rawBody: `${good.rawBody} ` }))).code).toBe(ErrorCode.SignatureInvalid);
    expect(calls).toHaveLength(before);

    // 4. get, pause, resume, update, cancel now / at period end, charges, refund: the exact sequence of gateway calls.
    calls.length = 0;
    expect((await subs.get(Provider.Razorpay, SUB_ID)).status).toBe(SubscriptionStatus.Active);
    await subs.pause(Provider.Razorpay, SUB_ID);
    await subs.resume(Provider.Razorpay, SUB_ID);
    await subs.update(Provider.Razorpay, SUB_ID, { planId: 'plan_00000000000002', quantity: 3, timing: ChangeTiming.AtPeriodEnd });
    const cancelledNow = await subs.cancel(Provider.Razorpay, SUB_ID);
    const cancelledLater = await subs.cancel(Provider.Razorpay, SUB_ID, { mode: CancelMode.AtPeriodEnd });
    const charges = await subs.charges.list(Provider.Razorpay, SUB_ID);
    const refund = await subs.charges.refund(Provider.Razorpay, {
      subscriptionId: SUB_ID,
      chargeId: 'pay_00000000000002',
      refundId: 'refund-1',
      amount: 5000,
    });

    expect(sequence(calls)).toEqual([
      `GET ${RazorpayEndpoint.subscription(SUB_ID)}`,
      // pause reads the subscription first: pausing an "authenticated" one would cancel it irreversibly.
      `GET ${RazorpayEndpoint.subscription(SUB_ID)}`,
      `POST ${RazorpayEndpoint.pauseSubscription(SUB_ID)}`,
      `POST ${RazorpayEndpoint.resumeSubscription(SUB_ID)}`,
      `PATCH ${RazorpayEndpoint.subscription(SUB_ID)}`,
      `POST ${RazorpayEndpoint.cancelSubscription(SUB_ID)}`,
      `POST ${RazorpayEndpoint.cancelSubscription(SUB_ID)}`,
      `GET ${RazorpayEndpoint.invoices}?subscription_id=${SUB_ID}&count=100&skip=0`,
      `POST ${RazorpayEndpoint.refundPayment('pay_00000000000002')}`,
    ]);
    expect(calls.map((call) => call.method)).not.toContain(HttpMethod.Delete);
    expect(calls[4]?.json).toMatchObject({ plan_id: 'plan_00000000000002', quantity: 3, schedule_change_at: RazorpayScheduleChangeAt.CycleEnd });
    expect(calls[5]?.json).toEqual({ cancel_at_cycle_end: false });
    expect(calls[6]?.json).toEqual({ cancel_at_cycle_end: true });
    expect(cancelledNow.status).toBe(SubscriptionStatus.Cancelled);
    expect(cancelledLater.cancelAtPeriodEnd).toBeUndefined();
    expect(charges.length).toBeGreaterThan(0);
    for (const charge of charges) expect(ChargeSchema.safeParse(charge).success).toBe(true);
    expect(refund).toMatchObject({ status: RefundStatus.Succeeded, amount: 5000, reference: 'refund-1' });
    expect(RefundSchema.safeParse(refund).success).toBe(true);

    // 5. No scheduler involvement: not one store call, and no schedule was created.
    expect(store.calls).toEqual([]);
    expect(subs.capabilities(Provider.Razorpay).merchantCharges).toBe(false);
  });

  it('cancel at period end on a live subscription is reported as a pending cancellation (derived from the request)', async () => {
    const clock = new Clock(NOW);
    const live = { ...fixtureJson(RAZORPAY_ADAPTER_TEST, 'CANCEL_RESPONSE'), status: RazorpaySubscriptionStatus.Active };
    const { fetch, calls } = scriptedFetch(() => ({ json: live }));
    const { subs } = wire(razorpayProvider(fetch, clock), clock, calls);
    const result = await subs.cancel(Provider.Razorpay, SUB_ID, { mode: CancelMode.AtPeriodEnd });
    expect(result).toMatchObject({ status: SubscriptionStatus.Active, cancelAtPeriodEnd: true });
  });

  // `VerifyCheckoutInput.expectedSubscriptionId` is "the subscription id (or your reference)". The Razorpay adapter returns no
  // reference from `verifyCheckout`, so the facade reads the subscription once and compares the reference it holds.
  it('verifyCheckout accepts the stored reference as expectedSubscriptionId for Razorpay, as the schema promises', async () => {
    const clock = new Clock(NOW);
    const { fetch, calls } = gateway();
    const { subs } = wire(razorpayProvider(fetch, clock), clock, calls);
    const subscription = await subs.create(Provider.Razorpay, {
      reference: REFERENCE,
      plan: { name: 'Pro monthly', amount: 49900, interval: { unit: IntervalUnit.Month, count: 1 } },
      customer: CUSTOMER,
      totalCycles: 12,
    });
    const paymentId = 'pay_AuthorisationOne';
    const result = {
      razorpay_payment_id: paymentId,
      razorpay_subscription_id: subscription.id,
      razorpay_signature: hmacHex(RAZORPAY_ACCOUNT.keySecret, `${paymentId}|${subscription.id}`),
    };
    const verification = await subs.verifyCheckout(Provider.Razorpay, result, { expectedSubscriptionId: REFERENCE });
    expect(verification.authorized).toBe(true);
  });
});
