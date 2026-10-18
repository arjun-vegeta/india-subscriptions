/**
 * Seam 20: what `createSubscriptions` adds around the explicit-provider API: `subs.router` over the configured providers'
 * capabilities, `subs.purchases` over the client itself, and webhook events reaching the purchase module and the billing
 * scheduler without one failing consumer hiding the events or starving the other.
 */
import { describe, expect, it, vi } from 'vitest';
import { ErrorCode, EventType, Provider, ProviderKind } from '../../src/constants.js';
import { createSubscriptions } from '../../src/client.js';
import { SubscriptionError } from '../../src/errors.js';
import { MemoryPurchaseStore, Purchases } from '../../src/purchase/index.js';
import { MemoryRoutingStatsStore, Router } from '../../src/routing/index.js';
import type { SubscriptionEvent } from '../../src/schemas.js';
import { SIGNATURE_HEADER, VALID_SIGNATURE, COINS, MONTHLY, ScriptedGateway, capabilities } from '../server/support.js';

const event = (id: string, fields: Partial<SubscriptionEvent> = {}): SubscriptionEvent => ({
  id,
  provider: Provider.Razorpay,
  type: EventType.PaymentSucceeded,
  providerEventType: 'x',
  paymentId: 'order_none',
  raw: {},
  ...fields,
});
const request = (events: SubscriptionEvent[]) => ({ rawBody: JSON.stringify({ events }), headers: { [SIGNATURE_HEADER]: VALID_SIGNATURE } });

describe('subs.router', () => {
  it('always exists, over the configured providers, and never offers a store as a candidate', async () => {
    const store = new ScriptedGateway(Provider.AppStore, { kind: ProviderKind.Store, oneTimePayments: true });
    const subs = createSubscriptions({ providers: [new ScriptedGateway(Provider.Razorpay), store] });
    expect(subs.router).toBeInstanceOf(Router);
    const decision = await subs.router.route({ kind: 'one_time', amount: 9900 });
    expect(decision.ranked).toEqual([Provider.Razorpay]);
    expect(decision.candidates.map((candidate) => candidate.provider)).toEqual([Provider.Razorpay]);
    expect(subs.purchases).toBeUndefined();
  });

  it('is built with the strategy and the statistics store of the routing option', async () => {
    const stats = new MemoryRoutingStatsStore();
    const subs = createSubscriptions({
      providers: [new ScriptedGateway(Provider.Razorpay), new ScriptedGateway(Provider.Cashfree)],
      routing: { stats, strategy: { priority: [Provider.Cashfree, Provider.Razorpay] } },
    });
    expect((await subs.router.route({ kind: 'one_time', amount: 100 })).provider).toBe(Provider.Cashfree);
    await subs.router.record({ provider: Provider.Cashfree, kind: 'payment', result: 'failure' });
    expect(await stats.read({ provider: Provider.Cashfree, kind: 'payment' }, '2000-01-01T00:00:00.000Z')).toMatchObject({ failure: 1 });
  });

  it('sees the capabilities the facade reports, read at each decision', async () => {
    const subs = createSubscriptions({ providers: [new ScriptedGateway(Provider.PhonePe, { oneTimePayments: false, oneTimePaymentMethods: [] })] });
    await expect(subs.router.route({ kind: 'one_time', amount: 100 })).rejects.toMatchObject({ code: ErrorCode.NoRoute });
    expect(capabilities(Provider.Razorpay).kind).toBe(ProviderKind.Gateway);
  });
});

describe('the explicit-provider API does not route or record', () => {
  it('create, payments.create and verify go to the named provider only, and nothing is counted', async () => {
    const stats = new MemoryRoutingStatsStore();
    const razorpay = new ScriptedGateway(Provider.Razorpay);
    const cashfree = new ScriptedGateway(Provider.Cashfree);
    const subs = createSubscriptions({ providers: [razorpay, cashfree], routing: { stats } });
    const route = vi.spyOn(subs.router, 'route');
    const record = vi.spyOn(subs.router, 'record');
    await subs.payments.create(Provider.Cashfree, { amount: 100, customer: { name: 'A' } });
    await subs.create(Provider.Cashfree, { plan: { name: 'P', amount: 100, interval: { unit: 'month', count: 1 } }, customer: { name: 'A' } });
    expect(route).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(razorpay.created).toHaveLength(0);
    expect(cashfree.created).toHaveLength(2);
  });
});

describe('subs.purchases', () => {
  it('is a Purchases over the client itself and subs.router, when the option is given', async () => {
    const gateway = new ScriptedGateway(Provider.Razorpay);
    const subs = createSubscriptions({ providers: [gateway], purchases: { catalog: [COINS], store: new MemoryPurchaseStore() } });
    expect(subs.purchases).toBeInstanceOf(Purchases);
    const route = vi.spyOn(subs.router, 'route');
    const session = await subs.purchases!.start({ platform: 'web', product: COINS.key, customer: { name: 'A', email: 'a@example.com', phone: '9876543210' }, customerRef: 'c1' });
    expect(route).toHaveBeenCalledTimes(1);
    expect(session.options[0]).toMatchObject({ provider: Provider.Razorpay, handle: 'order_razorpay_1' });
    // The purchase went through the facade: the gateway saw exactly the facade's create.
    expect(gateway.created.map((call) => call.method)).toEqual(['createPayment']);
  });

  it('refuses a catalog the configured providers cannot serve, listing the problems (CONFIG)', () => {
    expect(() =>
      createSubscriptions({
        providers: [new ScriptedGateway(Provider.Razorpay)],
        purchases: { catalog: [{ ...MONTHLY, googlePlay: { productId: 'p' } }], policy: { android: 'user_choice' }, store: new MemoryPurchaseStore() },
      }),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.Config, message: expect.stringContaining('google_play provider is not configured') }));
  });

  it('uses the google_play provider as its reporter when one is configured', async () => {
    const reports: unknown[] = [];
    const google = new ScriptedGateway(Provider.GooglePlay, { kind: ProviderKind.Store });
    Object.assign(google, {
      reportExternalTransaction: async (input: { externalTransactionId: string }) => {
        reports.push(input);
        return { externalTransactionId: input.externalTransactionId, state: 'TRANSACTION_REPORTED', raw: {} };
      },
      refundExternalTransaction: async (input: { externalTransactionId: string }) => ({ externalTransactionId: input.externalTransactionId, state: 'TRANSACTION_CANCELED', raw: {} }),
    });
    const subs = createSubscriptions({
      providers: [new ScriptedGateway(Provider.Razorpay), google],
      purchases: { catalog: [{ ...MONTHLY, googlePlay: { productId: 'p', basePlanId: 'b' } }], policy: { android: 'user_choice' }, store: new MemoryPurchaseStore() },
    });
    // Construction succeeded, which user_choice only allows with a reporter; an empty flush has nothing to send.
    expect(await subs.purchases!.flush()).toMatchObject({ sent: 0, skipped: 0 });
    expect(reports).toEqual([]);
  });
});

describe('webhooks.handle', () => {
  function wired(options: { failPurchases?: boolean; failScheduler?: boolean } = {}) {
    const gateway = new ScriptedGateway(Provider.Razorpay, { merchantCharges: true, scheduling: ['merchant'] });
    const handleEvent = vi.fn(async () => {
      if (options.failScheduler) throw new SubscriptionError(ErrorCode.Conflict, 'schedule store conflict');
    });
    const scheduler = { tick: async () => ({}), handleEvent, get: async () => undefined, find: async () => undefined, now: () => new Date() } as never;
    const subs = createSubscriptions({ providers: [gateway], scheduler, purchases: { catalog: [COINS], store: new MemoryPurchaseStore() } });
    const handleEvents = vi.spyOn(subs.purchases!, 'handleEvents').mockImplementation(async () => {
      if (options.failPurchases) throw new Error('purchase store down');
    });
    return { subs, handleEvent, handleEvents };
  }

  it('hands the events to the billing scheduler and to the purchase module, and returns them', async () => {
    const t = wired();
    const events = [event('e1'), event('e2')];
    expect(await t.subs.webhooks.handle(Provider.Razorpay, request(events))).toEqual(events);
    expect(t.handleEvent).toHaveBeenCalledTimes(2);
    expect(t.handleEvents).toHaveBeenCalledTimes(1);
    expect(t.handleEvents).toHaveBeenCalledWith(events);
  });

  it('parse stays pure: nothing is handed to any consumer', async () => {
    const t = wired();
    expect(await t.subs.webhooks.parse(Provider.Razorpay, request([event('e1')]))).toHaveLength(1);
    expect(t.handleEvent).not.toHaveBeenCalled();
    expect(t.handleEvents).not.toHaveBeenCalled();
  });

  it('a failing purchase module is an INTERNAL_ERROR that carries the events, and the scheduler still saw them', async () => {
    const t = wired({ failPurchases: true });
    const events = [event('e1')];
    const error = await t.subs.webhooks.handle(Provider.Razorpay, request(events)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SubscriptionError);
    expect((error as SubscriptionError).code).toBe(ErrorCode.Internal);
    expect((error as SubscriptionError).message).toContain('purchase store down');
    expect((error as SubscriptionError).raw).toEqual(events);
    expect(t.handleEvent).toHaveBeenCalledTimes(1);
  });

  it('a failing scheduler keeps its own code and still lets the purchase module see the events', async () => {
    const t = wired({ failScheduler: true });
    const events = [event('e1'), event('e2')];
    const error = await t.subs.webhooks.handle(Provider.Razorpay, request(events)).catch((e: unknown) => e);
    expect((error as SubscriptionError).code).toBe(ErrorCode.Conflict);
    expect((error as SubscriptionError).raw).toEqual(events);
    expect(t.handleEvents).toHaveBeenCalledWith(events);
  });

  it('both failing is one error naming the first and counting the rest', async () => {
    const t = wired({ failScheduler: true, failPurchases: true });
    const error = (await t.subs.webhooks.handle(Provider.Razorpay, request([event('e1')])).catch((e: unknown) => e)) as SubscriptionError;
    expect(error.code).toBe(ErrorCode.Conflict);
    expect(error.message).toContain('and 1 more failure');
  });

  it('a bad signature reaches no consumer', async () => {
    const t = wired();
    await expect(t.subs.webhooks.handle(Provider.Razorpay, { rawBody: '{}', headers: {} })).rejects.toMatchObject({ code: ErrorCode.SignatureInvalid });
    expect(t.handleEvent).not.toHaveBeenCalled();
    expect(t.handleEvents).not.toHaveBeenCalled();
  });

  it('works without purchases or a scheduler, as before', async () => {
    const subs = createSubscriptions({ providers: [new ScriptedGateway(Provider.Razorpay)] });
    expect(await subs.webhooks.handle(Provider.Razorpay, request([event('e1')]))).toHaveLength(1);
  });
});
