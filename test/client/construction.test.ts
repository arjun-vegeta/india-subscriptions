import { describe, expect, it } from 'vitest';
import { Subscriptions, createSubscriptions } from '../../src/client.js';
import { ErrorCode, Provider } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import { BillingScheduler } from '../../src/scheduler/index.js';
import { FakeClock, FakeGateway, InstrumentedStore, Style, gatewayInput, makeWorld, trialInput } from './helpers.js';

function gateway(style: Style = Style.Gateway, name?: Provider): FakeGateway {
  return new FakeGateway({ style, name, clock: new FakeClock().now });
}

function configError(build: () => unknown): SubscriptionError {
  try {
    build();
  } catch (error) {
    expect(error).toBeInstanceOf(SubscriptionError);
    return error as SubscriptionError;
  }
  throw new Error('expected a SubscriptionError');
}

describe('Subscriptions: construction', () => {
  it('refuses an empty provider list with CONFIG', () => {
    expect(configError(() => new Subscriptions({ providers: [] })).code).toBe(ErrorCode.Config);
    expect(configError(() => createSubscriptions({ providers: [] })).code).toBe(ErrorCode.Config);
  });

  it('refuses a missing provider list with CONFIG', () => {
    expect(configError(() => new Subscriptions({ providers: undefined as never })).code).toBe(ErrorCode.Config);
  });

  it('refuses the same gateway configured twice and names it', () => {
    const error = configError(() => new Subscriptions({ providers: [gateway(Style.Gateway), gateway(Style.Gateway)] }));
    expect(error.code).toBe(ErrorCode.Config);
    expect(error.provider).toBe(Provider.Razorpay);
    expect(error.message).toContain(Provider.Razorpay);
  });

  it('accepts several different gateways and lists them in configuration order', () => {
    const subs = createSubscriptions({
      providers: [gateway(Style.Notify), gateway(Style.Gateway), gateway(Style.Advance)],
    });
    expect(subs.providers).toStrictEqual([Provider.PayU, Provider.Razorpay, Provider.Cashfree]);
  });

  it('returns a copy of the provider list: editing it cannot unconfigure a gateway', () => {
    const subs = createSubscriptions({ providers: [gateway(Style.Gateway)] });
    subs.providers.pop();
    expect(subs.providers).toStrictEqual([Provider.Razorpay]);
  });

  it('exposes the adapter and its capabilities by name', () => {
    const razorpay = gateway(Style.Gateway);
    const payu = gateway(Style.Notify);
    const subs = createSubscriptions({ providers: [razorpay, payu] });
    expect(subs.provider(Provider.Razorpay)).toBe(razorpay);
    expect(subs.provider(Provider.PayU)).toBe(payu);
    expect(subs.capabilities(Provider.Razorpay)).toBe(razorpay.capabilities);
    expect(subs.capabilities(Provider.PayU)).toBe(payu.capabilities);
  });

  it('throws CONFIG for a gateway that is not configured, from provider() and capabilities()', () => {
    const subs = createSubscriptions({ providers: [gateway(Style.Gateway)] });
    const fromProvider = configError(() => subs.provider(Provider.PayU));
    expect(fromProvider.code).toBe(ErrorCode.Config);
    expect(fromProvider.message).toContain(Provider.PayU);
    expect(configError(() => subs.capabilities(Provider.Cashfree)).code).toBe(ErrorCode.Config);
    expect(configError(() => subs.provider('bogus' as Provider)).message).toContain('bogus');
  });

  it('rejects (rather than throws) an unknown gateway on the async methods', async () => {
    const subs = createSubscriptions({ providers: [gateway(Style.Gateway)] });
    await expect(subs.create(Provider.PayU, trialInput())).rejects.toMatchObject({ code: ErrorCode.Config });
    await expect(subs.get(Provider.PayU, 'x')).rejects.toMatchObject({ code: ErrorCode.Config });
    await expect(subs.cancel(Provider.PayU, 'x')).rejects.toMatchObject({ code: ErrorCode.Config });
    await expect(subs.pause(Provider.PayU, 'x')).rejects.toMatchObject({ code: ErrorCode.Config });
    await expect(subs.resume(Provider.PayU, 'x')).rejects.toMatchObject({ code: ErrorCode.Config });
    await expect(subs.update(Provider.PayU, 'x', { amount: 1 })).rejects.toMatchObject({ code: ErrorCode.Config });
    await expect(subs.verifyCheckout(Provider.PayU, {})).rejects.toMatchObject({ code: ErrorCode.Config });
    await expect(subs.webhooks.handle(Provider.PayU, { rawBody: '', headers: {} })).rejects.toMatchObject({
      code: ErrorCode.Config,
    });
  });

  // Regression guard for a fixed defect: plans.* and charges.* are typed `Promise<...>` but resolve the adapter eagerly, so an unknown
  // gateway makes them THROW SYNCHRONOUSLY. `subs.charges.list(...).catch(handler)` never reaches the handler.
  // Every other async method (create/get/cancel/...) rejects instead.
  it('plans.* and charges.* reject instead of throwing synchronously for an unknown gateway', async () => {
    const subs = createSubscriptions({ providers: [gateway(Style.Gateway)] });
    const calls: Array<() => Promise<unknown>> = [
      () => subs.plans.get(Provider.PayU, 'plan_1'),
      () => subs.charges.list(Provider.PayU, 'sub_1'),
      () => subs.charges.get(Provider.PayU, 'sub_1', 'pay_1'),
    ];
    for (const call of calls) {
      let promise: Promise<unknown>;
      try {
        promise = call();
      } catch {
        throw new Error('threw synchronously instead of returning a rejected promise');
      }
      await expect(promise).rejects.toMatchObject({ code: ErrorCode.Config });
    }
  });

  it('exposes the scheduler it was given, and none otherwise', () => {
    const store = new InstrumentedStore();
    const scheduler = new BillingScheduler({ store, resolveProvider: () => gateway(Style.Notify) });
    expect(createSubscriptions({ providers: [gateway(Style.Notify)], scheduler }).scheduler).toBe(scheduler);
    expect(createSubscriptions({ providers: [gateway(Style.Notify)] }).scheduler).toBeUndefined();
  });

  it('keeps unrelated gateways independent: a world with three gateways resolves each by name', () => {
    const world = makeWorld({ gateways: [{ style: Style.Gateway }, { style: Style.Notify }, { style: Style.Advance }] });
    expect(world.subs.providers).toStrictEqual([Provider.Razorpay, Provider.PayU, Provider.Cashfree]);
    expect(world.subs.capabilities(Provider.Razorpay).merchantCharges).toBe(false);
    expect(world.subs.capabilities(Provider.PayU).merchantPreDebitNotification).toBe(true);
    expect(world.subs.capabilities(Provider.Cashfree).merchantChargeLeadHours).toBe(24);
  });

  it('builds without any scheduler call: constructing and listing touches no store', () => {
    const world = makeWorld({ gateways: [{ style: Style.Gateway }] });
    expect(world.subs.providers).toStrictEqual([Provider.Razorpay]);
    expect(world.store.calls).toStrictEqual([]);
    // gatewayInput is only used to prove the fixtures type-check against the facade.
    expect(gatewayInput().reference).toBeDefined();
  });
});
