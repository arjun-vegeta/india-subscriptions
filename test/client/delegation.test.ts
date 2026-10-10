import { describe, expect, it } from 'vitest';
import { Subscriptions } from '../../src/client.js';
import { CancelMode, ChangeTiming, EventType, IntervalUnit, Provider, SchedulingMode } from '../../src/constants.js';
import type {
  CancelSubscriptionOptions,
  CheckoutResult,
  CreateChargeInput,
  CreatePlanInput,
  NotifyChargeInput,
  PauseSubscriptionOptions,
  RefundInput,
  ResumeSubscriptionOptions,
  UpdateSubscriptionInput,
  WebhookRequest,
} from '../../src/schemas.js';
import { BillingScheduler } from '../../src/scheduler/index.js';
import { FakeClock, GatewayMethod, InstrumentedStore, StubProvider, TRIAL_END, gatewayInput } from './helpers.js';

interface Rig {
  subs: Subscriptions;
  stub: StubProvider;
  store: InstrumentedStore;
}

/** A gateway-scheduled provider behind the facade, with and without a billing scheduler configured. */
function rigs(): Array<[string, () => Rig]> {
  const build = (withScheduler: boolean) => (): Rig => {
    const stub = new StubProvider();
    const store = new InstrumentedStore();
    const scheduler = withScheduler
      ? new BillingScheduler({ store, resolveProvider: () => stub, now: new FakeClock().now })
      : undefined;
    return { subs: new Subscriptions({ providers: [stub], scheduler }), stub, store };
  };
  return [
    ['with a scheduler configured', build(true)],
    ['without a scheduler', build(false)],
  ];
}

describe.each(rigs())('pure delegation to a gateway-scheduled provider (%s)', (_label, build) => {
  const rzp = Provider.Razorpay;

  it('plans.create passes the input through and returns the plan unchanged', async () => {
    const { subs, stub, store } = build();
    const input: CreatePlanInput = { name: 'Pro', amount: 49900, interval: { unit: IntervalUnit.Month, count: 1 } };
    const result = await subs.plans.create(rzp, input);
    expect(result).toBe(stub.results.plan);
    expect(stub.calls).toStrictEqual([{ method: GatewayMethod.CreatePlan, args: [input] }]);
    expect(stub.calls[0]?.args[0]).toBe(input);
    expect(store.calls).toStrictEqual([]);
  });

  it('plans.get', async () => {
    const { subs, stub, store } = build();
    expect(await subs.plans.get(rzp, 'plan_1')).toBe(stub.results.fetchedPlan);
    expect(stub.calls).toStrictEqual([{ method: GatewayMethod.GetPlan, args: ['plan_1'] }]);
    expect(store.calls).toStrictEqual([]);
  });

  it('create passes the input object through untouched and returns the subscription as is', async () => {
    const { subs, stub, store } = build();
    const input = gatewayInput({ trial: { days: 7 } });
    const snapshot = structuredClone(input);
    const result = await subs.create(rzp, input);
    expect(result).toBe(stub.results.created);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.args[0]).toBe(input);
    expect(input).toStrictEqual(snapshot);
    expect(store.writes()).toStrictEqual([]);
    expect(store.calls).toStrictEqual([]);
  });

  it('get', async () => {
    const { subs, stub, store } = build();
    expect(await subs.get(rzp, 'sub_1')).toBe(stub.results.fetched);
    expect(stub.calls).toStrictEqual([{ method: GatewayMethod.GetSubscription, args: ['sub_1'] }]);
    expect(store.writes()).toStrictEqual([]);
  });

  it('cancel forwards id and options and returns the gateway result unchanged', async () => {
    const { subs, stub, store } = build();
    const options: CancelSubscriptionOptions = { mode: CancelMode.AtPeriodEnd };
    expect(await subs.cancel(rzp, 'sub_1', options)).toBe(stub.results.cancelled);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.method).toBe(GatewayMethod.CancelSubscription);
    expect(stub.calls[0]?.args[0]).toBe('sub_1');
    expect(stub.calls[0]?.args[1]).toBe(options);
    expect(store.writes()).toStrictEqual([]);
  });

  it('cancel without options forwards no options', async () => {
    const { subs, stub } = build();
    await subs.cancel(rzp, 'sub_1');
    expect(stub.calls[0]?.args[1]).toBeUndefined();
  });

  it('pause forwards id and options and returns the gateway result unchanged', async () => {
    const { subs, stub, store } = build();
    const options: PauseSubscriptionOptions = { resumeAt: TRIAL_END };
    expect(await subs.pause(rzp, 'sub_1', options)).toBe(stub.results.paused);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.method).toBe(GatewayMethod.PauseSubscription);
    expect(stub.calls[0]?.args[1]).toBe(options);
    expect(store.writes()).toStrictEqual([]);
  });

  it('resume forwards id and options and returns the gateway result unchanged', async () => {
    const { subs, stub, store } = build();
    const options: ResumeSubscriptionOptions = { nextChargeAt: TRIAL_END };
    expect(await subs.resume(rzp, 'sub_1', options)).toBe(stub.results.resumed);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.method).toBe(GatewayMethod.ResumeSubscription);
    expect(stub.calls[0]?.args[1]).toBe(options);
    expect(store.writes()).toStrictEqual([]);
  });

  it('update forwards the input untouched (amount included) and returns the gateway result unchanged', async () => {
    const { subs, stub, store } = build();
    const input: UpdateSubscriptionInput = { amount: 59900, quantity: 2, timing: ChangeTiming.AtPeriodEnd };
    expect(await subs.update(rzp, 'sub_1', input)).toBe(stub.results.updated);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.args[1]).toBe(input);
    expect(store.writes()).toStrictEqual([]);
  });

  it('verifyCheckout returns the gateway verification unchanged and activates nothing', async () => {
    const { subs, stub, store } = build();
    const result: CheckoutResult = { razorpay_payment_id: 'pay_1' };
    expect(await subs.verifyCheckout(rzp, result)).toBe(stub.results.verification);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.args[0]).toBe(result);
    expect(store.writes()).toStrictEqual([]);
  });

  it('charges.list / get / create / notify / refund delegate argument for argument', async () => {
    const { subs, stub, store } = build();
    const create: CreateChargeInput = { subscriptionId: 'sub_1', chargeId: 'chg_1', amount: 100 };
    const notify: NotifyChargeInput = { subscriptionId: 'sub_1', notificationId: 'ntf_1', amount: 100, debitAt: TRIAL_END };
    const refund: RefundInput = { chargeId: 'pay_1', refundId: 'rf_1' };
    expect(await subs.charges.list(rzp, 'sub_1', { limit: 5 })).toBe(stub.results.charges);
    expect(await subs.charges.get(rzp, 'sub_1', 'pay_1')).toBe(stub.results.charge);
    expect(await subs.charges.create(rzp, create)).toBe(stub.results.raised);
    expect(await subs.charges.notify(rzp, notify)).toBe(stub.results.notification);
    expect(await subs.charges.refund(rzp, refund)).toBe(stub.results.refund);
    expect(stub.calls.map((call) => call.method)).toStrictEqual([
      GatewayMethod.ListCharges,
      GatewayMethod.GetCharge,
      GatewayMethod.CreateCharge,
      GatewayMethod.NotifyCharge,
      GatewayMethod.RefundCharge,
    ]);
    expect(stub.calls[0]?.args).toStrictEqual(['sub_1', { limit: 5 }]);
    expect(stub.calls[1]?.args).toStrictEqual(['sub_1', 'pay_1']);
    expect(stub.calls[2]?.args[0]).toBe(create);
    expect(stub.calls[3]?.args[0]).toBe(notify);
    expect(stub.calls[4]?.args[0]).toBe(refund);
    expect(store.calls).toStrictEqual([]);
  });

  it('webhooks.parse and webhooks.handle return the adapter events unchanged and write nothing', async () => {
    const { subs, stub, store } = build();
    const request: WebhookRequest = { rawBody: '{}', headers: {} };
    expect(await subs.webhooks.parse(rzp, request)).toBe(stub.results.events);
    expect(await subs.webhooks.handle(rzp, request)).toBe(stub.results.events);
    expect(stub.calls.map((call) => call.method)).toStrictEqual([GatewayMethod.ParseWebhook, GatewayMethod.ParseWebhook]);
    expect(stub.calls[0]?.args[0]).toBe(request);
    expect(store.writes()).toStrictEqual([]);
  });

  it('exposes capabilities and the adapter itself', () => {
    const { subs, stub } = build();
    expect(subs.capabilities(rzp)).toBe(stub.capabilities);
    expect(subs.provider(rzp)).toBe(stub);
    expect(stub.capabilities.merchantCharges).toBe(false);
    expect(stub.results.created.scheduling).toBe(SchedulingMode.Gateway);
  });

  it('propagates a gateway error untouched', async () => {
    const { subs, stub } = build();
    const failure = new Error('gateway exploded');
    stub.cancelSubscription = () => Promise.reject(failure);
    await expect(subs.cancel(rzp, 'sub_1')).rejects.toBe(failure);
  });

  it('webhook events of any type leave a gateway-scheduled provider alone', async () => {
    const { subs, stub, store } = build();
    stub.results.events.push({
      id: 'evt_cancel',
      provider: rzp,
      type: EventType.SubscriptionCancelled,
      providerEventType: 'subscription.cancelled',
      subscriptionId: 'sub_1',
      raw: null,
    });
    await subs.webhooks.handle(rzp, { rawBody: '{}', headers: {} });
    expect(store.writes()).toStrictEqual([]);
  });
});
