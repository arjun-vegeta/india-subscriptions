import { describe, expect, it } from 'vitest';
import { ErrorCode, EventType, Provider, SchedulingMode, SubscriptionStatus } from '../../src/constants.js';
import {
  GatewayMethod,
  REFERENCE,
  Style,
  gatewayInput,
  makeWorld,
  scheduleIdOf,
  scheduleOf,
  trialInput,
  type GatewayOptions,
  type World,
} from './helpers.js';
import { ScheduleStatus } from '../../src/scheduler/index.js';
import { CancelMode } from '../../src/constants.js';

const PAYU = Provider.PayU;
const CASHFREE = Provider.Cashfree;

type Spec = Omit<GatewayOptions, 'clock' | 'log'>;
const noScheduler = (spec: Spec): World => makeWorld({ gateways: [spec], scheduler: false });

describe('creating a merchant-scheduled subscription with no scheduler configured', () => {
  it('fails with CONFIG and says how to fix it', async () => {
    const world = noScheduler({ style: Style.Notify });
    const error = await world.subs.create(PAYU, trialInput()).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: ErrorCode.Config, provider: PAYU });
    expect((error as Error).message).toContain('scheduler');
  });

  // Regression guard for a fixed defect: the facade calls the gateway first and only then discovers there is nowhere to schedule the debits, so
  // CONFIG is thrown AFTER a real subscription (and its authorisation link) exists at the gateway, with its id lost
  // to the caller. For a gateway whose only scheduling mode is merchant, this is knowable up front from
  // capabilities, and nothing at the gateway should happen.
  it('does not call the gateway at all when the provider can only be merchant-scheduled', async () => {
    const world = noScheduler({ style: Style.Notify });
    await world.subs.create(PAYU, trialInput()).catch(() => undefined);
    expect(world.gateway.callsTo(GatewayMethod.CreateSubscription)).toHaveLength(0);
  });

  // Regression guard (fixed; same cause): the caller asked explicitly for a merchant-scheduled plan on a gateway that also offers
  // gateway scheduling, and the input says so, yet the gateway is called before the facade refuses.
  it('does not call the gateway when the input explicitly asks for a merchant-scheduled plan', async () => {
    const world = noScheduler({ style: Style.Dual });
    await world.subs.create(CASHFREE, trialInput()).catch(() => undefined);
    expect(world.gateway.callsTo(GatewayMethod.CreateSubscription)).toHaveLength(0);
  });

  it('still refuses with CONFIG on a dual-mode gateway (the error is raised, even if late)', async () => {
    const world = noScheduler({ style: Style.Dual });
    await expect(world.subs.create(CASHFREE, trialInput())).rejects.toMatchObject({ code: ErrorCode.Config });
  });

  it('a dual-mode gateway used gateway-scheduled needs no scheduler and is plain delegation', async () => {
    const world = noScheduler({ style: Style.Dual });
    const created = await world.subs.create(CASHFREE, gatewayInput());
    expect(created.scheduling).toBe(SchedulingMode.Gateway);
    expect(created.paidCycles).toBeUndefined();
    expect(created.status).toBe(SubscriptionStatus.Created);
  });

  it('with a scheduler, a dual-mode gateway-scheduled subscription never touches it; a merchant plan registers a schedule', async () => {
    const world = makeWorld({ gateways: [{ style: Style.Dual }] });
    const plain = await world.subs.create(CASHFREE, gatewayInput());
    expect(plain.scheduling).toBe(SchedulingMode.Gateway);
    expect(world.store.writes()).toStrictEqual([]);
    expect(world.store.calls).toStrictEqual([]);

    const merchant = await world.subs.create(CASHFREE, trialInput());
    expect(merchant.scheduling).toBe(SchedulingMode.Merchant);
    expect((await scheduleOf(world, REFERENCE, CASHFREE)).status).toBe(ScheduleStatus.PendingAuthorization);
  });

  it('other operations on a merchant-scheduled provider do not need a scheduler: they go straight to the gateway', async () => {
    const world = noScheduler({ style: Style.Notify });
    // Created straight at the adapter, as a subscription from before the scheduler was introduced would be.
    const existing = await world.gateway.createSubscription(trialInput());
    world.gateway.authorize(existing.id);
    expect((await world.subs.get(PAYU, existing.id)).status).toBe(SubscriptionStatus.Active);
    expect((await world.subs.cancel(PAYU, existing.id, { mode: CancelMode.Immediately })).status).toBe(SubscriptionStatus.Cancelled);
  });
});

describe('a merchant-scheduled subscription the gateway returns without amount, interval or startAt', () => {
  it.each(['amount', 'interval', 'startAt'] as const)(
    'missing %s: UNEXPECTED_RESPONSE, and no schedule is registered',
    async (field) => {
      const world = makeWorld({ gateways: [{ style: Style.Notify, omit: [field] }] });
      await expect(world.subs.create(PAYU, trialInput())).rejects.toMatchObject({
        code: ErrorCode.UnexpectedResponse,
        provider: PAYU,
      });
      expect(await world.scheduler?.get(scheduleIdOf())).toBeUndefined();
      expect(world.store.writes()).toStrictEqual([]);
    },
  );

  it('all three missing is still one UNEXPECTED_RESPONSE', async () => {
    const world = makeWorld({ gateways: [{ style: Style.Notify, omit: ['amount', 'interval', 'startAt'] }] });
    await expect(world.subs.create(PAYU, trialInput())).rejects.toMatchObject({ code: ErrorCode.UnexpectedResponse });
  });

  it('the same gateway-scheduled subscription with those fields missing is fine: they are only needed to schedule debits', async () => {
    const world = makeWorld({ gateways: [{ style: Style.Gateway, omit: ['amount', 'interval', 'startAt'] }] });
    const created = await world.subs.create(Provider.Razorpay, gatewayInput());
    expect(created.scheduling).toBe(SchedulingMode.Gateway);
  });

  // Regression guard (fixed): same shape as the missing-scheduler case. The gateway subscription exists and is neither
  // cancelled nor reported to the caller: the thrown error does not carry its id.
  it('does not leave a live, untracked subscription at the gateway', async () => {
    const world = makeWorld({ gateways: [{ style: Style.Notify, omit: ['startAt'] }] });
    await world.subs.create(PAYU, trialInput()).catch(() => undefined);
    const orphan = world.gateway.last();
    const cancelled = world.gateway.callsTo(GatewayMethod.CancelSubscription).some((call) => call.args[0] === orphan.id);
    expect(cancelled).toBe(true);
  });
});

describe('without a scheduler', () => {
  it('tick() rejects with CONFIG (it does not throw synchronously)', async () => {
    const world = noScheduler({ style: Style.Notify });
    let promise: Promise<unknown> | undefined;
    expect(() => {
      promise = world.subs.tick();
    }).not.toThrow();
    await expect(promise).rejects.toMatchObject({ code: ErrorCode.Config });
    await expect(world.subs.tick({ limit: 5 })).rejects.toMatchObject({ code: ErrorCode.Config });
  });

  it('webhooks.handle returns the verified events and there is simply nothing to apply them to', async () => {
    const world = noScheduler({ style: Style.Notify });
    const events = await world.subs.webhooks.handle(PAYU, world.gateway.webhook(EventType.SubscriptionAuthorized, 'sub_1'));
    expect(events.map((event) => event.type)).toStrictEqual([EventType.SubscriptionAuthorized]);
    expect(world.store.calls).toStrictEqual([]);
  });

  it('webhooks.handle still refuses a forged signature', async () => {
    const world = noScheduler({ style: Style.Notify });
    await expect(
      world.subs.webhooks.handle(PAYU, world.gateway.webhook(EventType.SubscriptionAuthorized, 'sub_1', { signature: 'forged' })),
    ).rejects.toMatchObject({ code: ErrorCode.SignatureInvalid });
  });

  it('verifyCheckout returns the gateway verification and activates nothing', async () => {
    const world = noScheduler({ style: Style.Notify });
    const existing = await world.gateway.createSubscription(trialInput());
    const verification = await world.subs.verifyCheckout(PAYU, world.gateway.authorize(existing.id));
    expect(verification).toMatchObject({ authorized: true, subscriptionId: existing.id });
  });
});
