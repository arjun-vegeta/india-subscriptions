import { describe, expect, it } from 'vitest';
import { Subscriptions, createSubscriptions } from '../../src/client.js';
import { ErrorCode, Provider, SubscriptionStatus } from '../../src/constants.js';
import { BillingScheduler, MemorySchedulerStore, ScheduleStatus, type SchedulerEvent, scheduleIdFor } from '../../src/scheduler/index.js';
import {
  FakeClock,
  FakeGateway,
  GatewayMethod,
  REFERENCE,
  T0,
  TRIAL_END,
  Style,
  makeWorld,
  plusHours,
  scheduleIdOf,
  scheduleOf,
  trialInput,
} from './helpers.js';

const PAYU = Provider.PayU;
const notifyAt = (due: string): string => plusHours(due, -48);

describe('verifyCheckout: expectedSubscriptionId', () => {
  it('accepts the id the merchant stored at creation, or the reference, and activates', async () => {
    for (const pick of ['id', 'reference'] as const) {
      const world = makeWorld();
      const created = await world.subs.create(PAYU, trialInput());
      const expected = pick === 'id' ? created.id : REFERENCE;
      const verification = await world.subs.verifyCheckout(PAYU, world.gateway.authorize(created.id), {
        expectedSubscriptionId: expected,
      });
      expect(verification.authorized).toBe(true);
      expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Active);
    }
  });

  it('a genuine result for ANOTHER subscription is refused like a forgery, and nothing is activated', async () => {
    const world = makeWorld();
    const mine = await world.subs.create(PAYU, trialInput({ reference: 'mine' }));
    const theirs = await world.subs.create(PAYU, trialInput({ reference: 'theirs' }));
    const theirResult = world.gateway.authorize(theirs.id);
    await expect(world.subs.verifyCheckout(PAYU, theirResult, { expectedSubscriptionId: mine.id })).rejects.toMatchObject({
      code: ErrorCode.SignatureInvalid,
      provider: PAYU,
    });
    expect((await scheduleOf(world, 'theirs')).status).toBe(ScheduleStatus.PendingAuthorization);
    expect((await scheduleOf(world, 'mine')).status).toBe(ScheduleStatus.PendingAuthorization);
    // Without the expectation the same result would have been accepted.
    await world.subs.verifyCheckout(PAYU, theirResult);
    expect((await scheduleOf(world, 'theirs')).status).toBe(ScheduleStatus.Active);
  });

  it('id-changing provider: the expected value is the reference (the new mandate id is not known yet) or the new id', async () => {
    const world = makeWorld({ gateways: [{ style: Style.Notify, idChanges: true }] });
    const created = await world.subs.create(PAYU, trialInput());
    const checkout = world.gateway.authorize(created.id);
    const newId = world.gateway.last().id;
    expect(newId).not.toBe(REFERENCE);

    await expect(world.subs.verifyCheckout(PAYU, checkout, { expectedSubscriptionId: 'someone-else' })).rejects.toMatchObject({
      code: ErrorCode.SignatureInvalid,
    });
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.PendingAuthorization);

    const byReference = await world.subs.verifyCheckout(PAYU, checkout, { expectedSubscriptionId: REFERENCE });
    expect(byReference.subscriptionId).toBe(newId);
    const schedule = await scheduleOf(world);
    expect(schedule).toMatchObject({ status: ScheduleStatus.Active, subscriptionId: newId });
    const byNewId = await world.subs.verifyCheckout(PAYU, checkout, { expectedSubscriptionId: newId });
    expect(byNewId.subscriptionId).toBe(newId);
  });

  it('a forged signature is still SIGNATURE_INVALID first', async () => {
    const world = makeWorld();
    const created = await world.subs.create(PAYU, trialInput());
    await expect(
      world.subs.verifyCheckout(PAYU, world.gateway.checkoutResult(created.id, 'forged'), { expectedSubscriptionId: created.id }),
    ).rejects.toMatchObject({ code: ErrorCode.SignatureInvalid });
  });
});

describe('verifyCheckout: when billing starts', () => {
  it('does not start billing while the mandate is still pending at the bank; a later webhook does', async () => {
    const world = makeWorld();
    const created = await world.subs.create(PAYU, trialInput());
    const checkout = world.gateway.authorize(created.id);
    world.gateway.verifyStatus = SubscriptionStatus.PendingAuthorization;
    const verification = await world.subs.verifyCheckout(PAYU, checkout);
    expect(verification).toMatchObject({ authorized: true, status: SubscriptionStatus.PendingAuthorization });
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.PendingAuthorization);
    await world.at(TRIAL_END);
    expect(world.gateway.callsTo(GatewayMethod.CreateCharge)).toHaveLength(0);

    world.gateway.verifyStatus = undefined;
    await world.subs.verifyCheckout(PAYU, checkout);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Active);
  });

  it('does not start billing for a customer who did not authorise', async () => {
    const world = makeWorld();
    const created = await world.subs.create(PAYU, trialInput());
    const verification = await world.subs.verifyCheckout(PAYU, world.gateway.checkoutResult(created.id));
    expect(verification.authorized).toBe(false);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.PendingAuthorization);
  });
});

describe('scheduler option: a ready BillingScheduler or just its options', () => {
  function gateway(style: Style, clock: FakeClock): FakeGateway {
    return new FakeGateway({ style, clock: clock.now });
  }

  it('accepts a ready scheduler and exposes that very object', () => {
    const clock = new FakeClock();
    const payu = gateway(Style.Notify, clock);
    const scheduler = new BillingScheduler({ store: new MemorySchedulerStore(), resolveProvider: () => payu });
    expect(createSubscriptions({ providers: [payu], scheduler }).scheduler).toBe(scheduler);
  });

  it('builds the scheduler itself from `{ store, ... }`, wired to the facade\'s own providers', async () => {
    const world = makeWorld({ buildSchedulerInFacade: true });
    expect(world.scheduler).toBeInstanceOf(BillingScheduler);
    const created = await world.subs.create(PAYU, trialInput());
    await world.subs.verifyCheckout(PAYU, world.gateway.authorize(created.id));
    // The facade-built scheduler uses the facade's clock-less defaults only where none was given: here `now` was passed through.
    await world.at(notifyAt(TRIAL_END));
    await world.at(TRIAL_END);
    expect(world.gateway.callsTo(GatewayMethod.NotifyCharge)).toHaveLength(1);
    expect(world.gateway.callsTo(GatewayMethod.CreateCharge)).toHaveLength(1);
    expect((await world.subs.get(PAYU, created.id)).paidCycles).toBe(1);
    expect(world.events.length).toBeGreaterThan(0);
  });

  it('passes policy defaults, onEvent and the clock through', async () => {
    const clock = new FakeClock(T0);
    const payu = gateway(Style.Notify, clock);
    const seen: SchedulerEvent[] = [];
    const subs = new Subscriptions({
      providers: [payu],
      scheduler: { store: new MemorySchedulerStore(), now: clock.now, notifyLeadHours: 72, onEvent: (event) => void seen.push(event) },
    });
    const created = await subs.create(PAYU, trialInput());
    const schedule = await subs.scheduler?.find(PAYU, REFERENCE);
    expect(schedule?.id).toBe(scheduleIdFor(PAYU, REFERENCE));
    expect(schedule?.policy.notifyLeadHours).toBe(72);
    expect(seen.map((event) => event.scheduleId)).toContain(scheduleIdOf());
    expect(subs.scheduler?.now().toISOString()).toBe(T0);
    expect(created.id).toBeDefined();
  });

  it('resolves exactly the facade\'s providers: a stored schedule of an unconfigured provider is a per-schedule error, not a crash', async () => {
    const world = makeWorld({ buildSchedulerInFacade: true });
    const created = await world.subs.create(PAYU, trialInput({ reference: 'good' }));
    await world.subs.verifyCheckout(PAYU, world.gateway.authorize(created.id));
    // A schedule left behind by a gateway that is no longer configured.
    const good = await scheduleOf(world, 'good');
    await world.store.saveSchedule({
      ...good,
      id: scheduleIdFor(Provider.Cashfree, 'stale'),
      provider: Provider.Cashfree,
      subscriptionId: 'cf_stale',
      reference: 'stale',
      nextActionAt: notifyAt(TRIAL_END),
    });
    const tick = await world.at(notifyAt(TRIAL_END));
    expect(tick.due).toBe(2);
    expect(tick.notified).toBe(1);
    expect(tick.errors).toHaveLength(1);
    expect(tick.errors[0]).toMatchObject({ scheduleId: scheduleIdFor(Provider.Cashfree, 'stale'), code: ErrorCode.Config });
    expect(tick.errors[0]?.message).toContain(Provider.Cashfree);
    // The healthy schedule carried on.
    expect(world.gateway.callsTo(GatewayMethod.NotifyCharge)).toHaveLength(1);
  });

  it('a facade-built scheduler and a ready one behave the same through a whole lifecycle', async () => {
    const results: number[] = [];
    for (const buildSchedulerInFacade of [false, true]) {
      const world = makeWorld({ buildSchedulerInFacade });
      const created = await world.subs.create(PAYU, trialInput());
      await world.subs.verifyCheckout(PAYU, world.gateway.authorize(created.id));
      await world.at(notifyAt(TRIAL_END));
      await world.at(TRIAL_END);
      results.push((await world.subs.get(PAYU, created.id)).paidCycles ?? -1, world.gateway.callsTo(GatewayMethod.CreateCharge).length);
    }
    expect(results).toStrictEqual([1, 1, 1, 1]);
  });
});
