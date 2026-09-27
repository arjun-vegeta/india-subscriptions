import { describe, expect, it } from 'vitest';
import { ChargeMetadataKey, CycleStatus, ScheduleStatus, ScheduleStatusReason, SchedulerEventType } from '../../src/scheduler/index.js';
import { ErrorCode, EventType, Provider, SchedulingMode, SubscriptionStatus } from '../../src/constants.js';
import {
  AMOUNT,
  CYCLE_2,
  CYCLE_3,
  GatewayMethod,
  HOUR,
  REFERENCE,
  T0,
  TRIAL_END,
  createAndAuthorize,
  cyclesOf,
  makeWorld,
  plusHours,
  scheduleIdOf,
  scheduleOf,
  trialInput,
} from './helpers.js';

const PAYU = Provider.PayU;
/** Pre-debit notification goes out 48h before the due date (scheduler default). */
const notifyAt = (due: string): string => plusHours(due, -48);

describe('merchant-scheduled (notify style): create', () => {
  it('registers a pending schedule that mirrors the gateway subscription and returns the overlaid subscription', async () => {
    const world = makeWorld();
    const created = await world.subs.create(PAYU, trialInput());
    const gatewaySub = world.gateway.last();

    expect(world.gateway.callsTo(GatewayMethod.CreateSubscription)).toHaveLength(1);
    expect(created.id).toBe(gatewaySub.id);
    expect(created.reference).toBe(REFERENCE);
    expect(created.scheduling).toBe(SchedulingMode.Merchant);
    // Not authorised yet: the gateway's own status stands, nothing is "trialing" or "active".
    expect(created.status).toBe(SubscriptionStatus.Created);
    expect(created.startAt).toBe(TRIAL_END);
    expect(created.amount).toBe(AMOUNT);
    expect(created.totalCycles).toBe(3);
    expect(created.paidCycles).toBe(0);
    expect(created.remainingCycles).toBe(3);
    expect(created.nextChargeAt).toBeUndefined();
    expect(created.trialEndsAt).toBeUndefined();
    expect(created.checkout).toBeDefined();

    const schedule = await scheduleOf(world);
    expect(schedule).toMatchObject({
      id: scheduleIdOf(),
      provider: PAYU,
      subscriptionId: gatewaySub.id,
      reference: REFERENCE,
      status: ScheduleStatus.PendingAuthorization,
      amount: AMOUNT,
      totalCycles: 3,
      anchorAt: TRIAL_END,
      paidCycles: 0,
      customer: trialInput().customer,
      metadata: trialInput().metadata,
    });
    // The only thing tick() has to do for it: ask the gateway about the mandate, one authorisation-poll interval after registration.
    expect(schedule.nextActionAt).toBe(plusHours(T0, 1));
    expect(await cyclesOf(world)).toHaveLength(0);
  });

  it('keys the schedule by the subscription id when the caller gave no reference', async () => {
    const world = makeWorld();
    const created = await world.subs.create(PAYU, trialInput({ reference: undefined }));
    const schedule = await world.scheduler?.get(scheduleIdOf(created.id));
    expect(schedule?.status).toBe(ScheduleStatus.PendingAuthorization);
    expect(schedule?.reference).toBeUndefined();

    await world.subs.verifyCheckout(PAYU, world.gateway.authorize(created.id));
    expect((await world.scheduler?.get(scheduleIdOf(created.id)))?.status).toBe(ScheduleStatus.Active);
  });

  it('is idempotent when the same gateway subscription is created again (retry with an idempotency key)', async () => {
    const world = makeWorld();
    const input = trialInput({ idempotencyKey: 'idem-1' });
    const first = await world.subs.create(PAYU, input);
    await createAndAuthorize(world, trialInput({ reference: 'other', idempotencyKey: 'idem-2' }));
    const second = await world.subs.create(PAYU, input);
    expect(second.id).toBe(first.id);
    expect(world.gateway.subscriptions.size).toBe(2);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.PendingAuthorization);
  });
});

describe('merchant-scheduled (notify style): nothing happens before the customer authorises', () => {
  it('never notifies or charges, however often tick() runs and however late', async () => {
    const world = makeWorld();
    await world.subs.create(PAYU, trialInput());
    const probes = [
      T0,
      plusHours(T0, 1),
      notifyAt(TRIAL_END),
      plusHours(notifyAt(TRIAL_END), 1),
      TRIAL_END,
      plusHours(TRIAL_END, 1),
      CYCLE_2,
      CYCLE_3,
      plusHours(CYCLE_3, 24 * 90),
    ];
    for (const probe of probes) {
      const tick = await world.at(probe);
      expect(tick).toMatchObject({ notified: 0, charged: 0, reconciled: 0, succeeded: 0, errors: [] });
    }
    expect(world.gateway.callsTo(GatewayMethod.NotifyCharge)).toHaveLength(0);
    expect(world.gateway.callsTo(GatewayMethod.CreateCharge)).toHaveLength(0);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.PendingAuthorization);
    // The pending subscription still reads as created, not as trialing.
    const read = await world.subs.get(PAYU, world.gateway.last().id);
    expect(read.status).toBe(SubscriptionStatus.Created);
  });

  it('a customer who never authorised and then cancels leaves nothing billable', async () => {
    const world = makeWorld();
    const created = await world.subs.create(PAYU, trialInput());
    await world.subs.cancel(PAYU, created.id);
    await world.at(CYCLE_3);
    expect(world.gateway.callsTo(GatewayMethod.NotifyCharge)).toHaveLength(0);
    expect(world.gateway.callsTo(GatewayMethod.CreateCharge)).toHaveLength(0);
  });
});

describe('merchant-scheduled (notify style): full lifecycle through the facade, authorised by verifyCheckout', () => {
  it('trial -> notification -> first debit -> active -> three cycles -> completed', async () => {
    const world = makeWorld();
    const created = await world.subs.create(PAYU, trialInput());
    // The customer authorises an hour after the subscription was created.
    world.setClock(plusHours(T0, 1));
    const verification = await world.subs.verifyCheckout(PAYU, world.gateway.authorize(created.id));
    const id = created.id;
    expect(verification.authorized).toBe(true);

    // --- activated, in trial ---
    let sub = await world.subs.get(PAYU, id);
    expect(sub.status).toBe(SubscriptionStatus.Trialing);
    expect(sub.trialEndsAt).toBe(TRIAL_END);
    expect(sub.nextChargeAt).toBe(TRIAL_END);
    expect(sub.paidCycles).toBe(0);
    expect(sub.remainingCycles).toBe(3);
    expect(sub.totalCycles).toBe(3);
    expect(sub.amount).toBe(AMOUNT);
    expect(sub.providerStatus).toBe(SubscriptionStatus.Active);
    const schedule = await scheduleOf(world);
    expect(schedule.status).toBe(ScheduleStatus.Active);
    expect(schedule.anchorAt).toBe(TRIAL_END);
    expect(schedule.subscriptionId).toBe(id);

    // --- before the notification time: nothing, and no gateway traffic at all ---
    const callsBefore = world.gateway.calls.length;
    const early = await world.at(plusHours(notifyAt(TRIAL_END), -1));
    expect(early).toMatchObject({ notified: 0, charged: 0 });
    expect(world.gateway.callsTo(GatewayMethod.NotifyCharge)).toHaveLength(0);
    expect(world.gateway.calls.length).toBe(callsBefore);

    // --- pre-debit notification, exactly 48h before the trial ends ---
    const notified = await world.at(notifyAt(TRIAL_END));
    expect(notified).toMatchObject({ notified: 1, charged: 0, errors: [] });
    const notifyCalls = world.gateway.callsTo(GatewayMethod.NotifyCharge);
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]?.at).toBe(notifyAt(TRIAL_END));
    expect(notifyCalls[0]?.args[0]).toMatchObject({ subscriptionId: id, amount: AMOUNT, debitAt: TRIAL_END });
    sub = await world.subs.get(PAYU, id);
    expect(sub.status).toBe(SubscriptionStatus.Trialing);
    expect(sub.trialEndsAt).toBe(TRIAL_END);

    // --- more ticks before the due instant: still nothing (no duplicate notice, no early debit) ---
    for (const probe of [plusHours(notifyAt(TRIAL_END), 1), plusHours(TRIAL_END, -24), new Date(Date.parse(TRIAL_END) - 1).toISOString()]) {
      expect(await world.at(probe)).toMatchObject({ notified: 0, charged: 0 });
    }
    expect(world.gateway.callsTo(GatewayMethod.NotifyCharge)).toHaveLength(1);
    expect(world.gateway.callsTo(GatewayMethod.CreateCharge)).toHaveLength(0);

    // --- first debit exactly when the trial ends ---
    const charged = await world.at(TRIAL_END);
    expect(charged).toMatchObject({ charged: 1, succeeded: 1, errors: [] });
    const createCalls = world.gateway.callsTo(GatewayMethod.CreateCharge);
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.at).toBe(TRIAL_END);
    expect(createCalls[0]?.args[0]).toMatchObject({
      subscriptionId: id,
      amount: AMOUNT,
      invoiceNumber: expect.stringContaining('INV-'),
      customer: trialInput().customer,
      metadata: {
        ...trialInput().metadata,
        [ChargeMetadataKey.ScheduleId]: scheduleIdOf(),
        [ChargeMetadataKey.Cycle]: '1',
        [ChargeMetadataKey.Attempt]: '1',
      },
    });

    // --- active after the first cycle ---
    sub = await world.subs.get(PAYU, id);
    expect(sub.status).toBe(SubscriptionStatus.Active);
    expect(sub.trialEndsAt).toBeUndefined();
    expect(sub.paidCycles).toBe(1);
    expect(sub.remainingCycles).toBe(2);
    expect(sub.nextChargeAt).toBe(CYCLE_2);

    // --- cycle 2 ---
    expect(await world.at(notifyAt(CYCLE_2))).toMatchObject({ notified: 1, charged: 0 });
    expect(await world.at(CYCLE_2)).toMatchObject({ charged: 1, succeeded: 1 });
    sub = await world.subs.get(PAYU, id);
    expect(sub.status).toBe(SubscriptionStatus.Active);
    expect(sub.paidCycles).toBe(2);
    expect(sub.remainingCycles).toBe(1);
    expect(sub.nextChargeAt).toBe(CYCLE_3);

    // --- cycle 3 completes the subscription ---
    expect(await world.at(notifyAt(CYCLE_3))).toMatchObject({ notified: 1 });
    expect(await world.at(CYCLE_3)).toMatchObject({ charged: 1, succeeded: 1, completed: 1 });
    sub = await world.subs.get(PAYU, id);
    expect(sub.status).toBe(SubscriptionStatus.Completed);
    expect(sub.paidCycles).toBe(3);
    expect(sub.remainingCycles).toBe(0);
    expect(sub.nextChargeAt).toBeUndefined();
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Completed);

    // --- and nothing more, ever ---
    expect(await world.at(plusHours(CYCLE_3, 24 * 400))).toMatchObject({ due: 0, notified: 0, charged: 0 });
    expect(world.gateway.callsTo(GatewayMethod.NotifyCharge)).toHaveLength(3);
    expect(world.gateway.callsTo(GatewayMethod.CreateCharge)).toHaveLength(3);
    const dates = world.gateway.callsTo(GatewayMethod.CreateCharge).map((call) => call.at);
    expect(dates).toStrictEqual([TRIAL_END, CYCLE_2, CYCLE_3]);
    const chargeIds = world.gateway.callsTo(GatewayMethod.CreateCharge).map((call) => (call.args[0] as { chargeId: string }).chargeId);
    expect(new Set(chargeIds).size).toBe(3);
    // Every notification preceded its debit by the legally required 24h or more.
    const notices = world.gateway.callsTo(GatewayMethod.NotifyCharge).map((call) => Date.parse(call.at));
    const debits = world.gateway.callsTo(GatewayMethod.CreateCharge).map((call) => Date.parse(call.at));
    notices.forEach((notice, index) => expect((debits[index] ?? 0) - notice).toBeGreaterThanOrEqual(24 * HOUR));
  });

  it('records every cycle as succeeded in the stored schedule', async () => {
    const world = makeWorld();
    await createAndAuthorize(world);
    for (const due of [TRIAL_END, CYCLE_2, CYCLE_3]) {
      await world.at(notifyAt(due));
      await world.at(due);
    }
    const cycles = await cyclesOf(world);
    expect(cycles.map((cycle) => cycle.status)).toStrictEqual([CycleStatus.Succeeded, CycleStatus.Succeeded, CycleStatus.Succeeded]);
    expect(cycles.map((cycle) => cycle.dueAt)).toStrictEqual([TRIAL_END, CYCLE_2, CYCLE_3]);
    expect(cycles.every((cycle) => cycle.amount === AMOUNT)).toBe(true);
  });

  it('an open-ended subscription (no totalCycles) keeps billing and never completes', async () => {
    const world = makeWorld();
    const { created } = await createAndAuthorize(world, trialInput({ totalCycles: undefined }));
    for (const due of [TRIAL_END, CYCLE_2, CYCLE_3]) {
      await world.at(notifyAt(due));
      await world.at(due);
    }
    const sub = await world.subs.get(PAYU, created.id);
    expect(sub.status).toBe(SubscriptionStatus.Active);
    expect(sub.paidCycles).toBe(3);
    expect(sub.totalCycles).toBeUndefined();
    expect(sub.remainingCycles).toBeUndefined();
    expect(sub.nextChargeAt).toBe('2026-04-15T00:00:00.000Z');
  });

  it('authorising late (after the trial would have ended) moves the first debit to the earliest legal instant', async () => {
    const world = makeWorld();
    const created = await world.subs.create(PAYU, trialInput());
    const lateAt = plusHours(TRIAL_END, 6);
    world.setClock(lateAt);
    await world.subs.verifyCheckout(PAYU, world.gateway.authorize(created.id));
    const sub = await world.subs.get(PAYU, created.id);
    expect(sub.nextChargeAt).toBe(lateAt);

    expect(await world.at(lateAt)).toMatchObject({ notified: 1, charged: 0 });
    expect(await world.at(plusHours(lateAt, 23))).toMatchObject({ charged: 0 });
    expect(await world.at(plusHours(lateAt, 24))).toMatchObject({ charged: 1, succeeded: 1 });
    expect(world.gateway.callsTo(GatewayMethod.CreateCharge)[0]?.at).toBe(plusHours(lateAt, 24));
  });

  it('tick({ limit }) is passed to the scheduler', async () => {
    const world = makeWorld();
    await createAndAuthorize(world, trialInput({ reference: 'a' }));
    await createAndAuthorize(world, trialInput({ reference: 'b' }));
    world.setClock(notifyAt(TRIAL_END));
    const limited = await world.subs.tick({ limit: 1 });
    expect(limited.due).toBe(1);
    expect(limited.notified).toBe(1);
    const rest = await world.subs.tick({ limit: 5 });
    expect(rest.notified).toBe(1);
  });
});

describe('merchant-scheduled (notify style): activation by webhook', () => {
  it('webhooks.handle activates the schedule exactly like verifyCheckout', async () => {
    const world = makeWorld();
    const created = await world.subs.create(PAYU, trialInput());
    world.gateway.authorize(created.id);

    const events = await world.subs.webhooks.handle(PAYU, world.gateway.webhook(EventType.SubscriptionAuthorized, created.id));
    expect(events.map((event) => event.type)).toStrictEqual([EventType.SubscriptionAuthorized]);

    const sub = await world.subs.get(PAYU, created.id);
    expect(sub.status).toBe(SubscriptionStatus.Trialing);
    expect(sub.trialEndsAt).toBe(TRIAL_END);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Active);

    expect(await world.at(notifyAt(TRIAL_END))).toMatchObject({ notified: 1 });
    expect(await world.at(TRIAL_END)).toMatchObject({ charged: 1, succeeded: 1 });
    expect((await world.subs.get(PAYU, created.id)).status).toBe(SubscriptionStatus.Active);
  });

  it('an "activated" event activates too', async () => {
    const world = makeWorld();
    const created = await world.subs.create(PAYU, trialInput());
    world.gateway.authorize(created.id);
    await world.subs.webhooks.handle(PAYU, world.gateway.webhook(EventType.SubscriptionActivated, created.id));
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Active);
  });

  it('both arriving (verifyCheckout then webhook) activates once and bills once', async () => {
    const world = makeWorld();
    const { created } = await createAndAuthorize(world);
    await world.subs.webhooks.handle(PAYU, world.gateway.webhook(EventType.SubscriptionAuthorized, created.id));
    await world.subs.webhooks.handle(PAYU, world.gateway.webhook(EventType.SubscriptionActivated, created.id));

    expect(world.events.filter((event) => event.type === SchedulerEventType.ScheduleActivated)).toHaveLength(1);
    expect(await cyclesOf(world)).toHaveLength(1);

    await world.at(notifyAt(TRIAL_END));
    await world.at(TRIAL_END);
    expect(world.gateway.callsTo(GatewayMethod.NotifyCharge)).toHaveLength(1);
    expect(world.gateway.callsTo(GatewayMethod.CreateCharge)).toHaveLength(1);
    expect((await scheduleOf(world)).paidCycles).toBe(1);
  });

  it('the webhook arriving BEFORE verifyCheckout: verifyCheckout then does nothing to the live schedule', async () => {
    const world = makeWorld();
    const created = await world.subs.create(PAYU, trialInput());
    const checkout = world.gateway.authorize(created.id);
    await world.subs.webhooks.handle(PAYU, world.gateway.webhook(EventType.SubscriptionAuthorized, created.id));
    // Time passes and a notification goes out before the browser comes back.
    await world.at(notifyAt(TRIAL_END));
    const before = await scheduleOf(world);

    const verification = await world.subs.verifyCheckout(PAYU, checkout);
    expect(verification.authorized).toBe(true);
    expect(await scheduleOf(world)).toStrictEqual(before);
    expect(world.events.filter((event) => event.type === SchedulerEventType.ScheduleActivated)).toHaveLength(1);

    await world.at(TRIAL_END);
    expect(world.gateway.callsTo(GatewayMethod.NotifyCharge)).toHaveLength(1);
    expect(world.gateway.callsTo(GatewayMethod.CreateCharge)).toHaveLength(1);
  });

  it('concurrent verifyCheckout and webhook activate once', async () => {
    const world = makeWorld();
    const created = await world.subs.create(PAYU, trialInput());
    const checkout = world.gateway.authorize(created.id);
    await Promise.all([
      world.subs.verifyCheckout(PAYU, checkout),
      world.subs.webhooks.handle(PAYU, world.gateway.webhook(EventType.SubscriptionAuthorized, created.id)),
      world.subs.verifyCheckout(PAYU, checkout),
    ]);
    expect(world.events.filter((event) => event.type === SchedulerEventType.ScheduleActivated)).toHaveLength(1);
    expect(await cyclesOf(world)).toHaveLength(1);
    await world.at(notifyAt(TRIAL_END));
    await world.at(TRIAL_END);
    expect(world.gateway.callsTo(GatewayMethod.CreateCharge)).toHaveLength(1);
  });

  it('a redelivered webhook changes nothing', async () => {
    const world = makeWorld();
    const created = await world.subs.create(PAYU, trialInput());
    world.gateway.authorize(created.id);
    const request = world.gateway.webhook(EventType.SubscriptionAuthorized, created.id, { eventId: 'evt_same' });
    await world.subs.webhooks.handle(PAYU, request);
    const once = await scheduleOf(world);
    await world.subs.webhooks.handle(PAYU, request);
    expect(await scheduleOf(world)).toStrictEqual(once);
  });

  it('an authorisation-failed webhook cancels the pending schedule: nothing is ever billed', async () => {
    const world = makeWorld();
    const created = await world.subs.create(PAYU, trialInput());
    await world.subs.webhooks.handle(PAYU, world.gateway.webhook(EventType.SubscriptionAuthorizationFailed, created.id));
    const schedule = await scheduleOf(world);
    expect(schedule.status).toBe(ScheduleStatus.Cancelled);
    expect(schedule.statusReason).toBe(ScheduleStatusReason.AuthorizationFailed);
    await world.at(CYCLE_3);
    expect(world.gateway.callsTo(GatewayMethod.NotifyCharge)).toHaveLength(0);
    expect(world.gateway.callsTo(GatewayMethod.CreateCharge)).toHaveLength(0);
  });

  it('verifyCheckout for a customer who did NOT authorise leaves the schedule pending and unbilled', async () => {
    const world = makeWorld();
    const created = await world.subs.create(PAYU, trialInput());
    // The customer abandons the bank page: the gateway reports authorized = false.
    const verification = await world.subs.verifyCheckout(PAYU, world.gateway.checkoutResult(created.id));
    expect(verification.authorized).toBe(false);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.PendingAuthorization);
    await world.at(CYCLE_3);
    expect(world.gateway.callsTo(GatewayMethod.CreateCharge)).toHaveLength(0);
  });

  it('a late authorisation webhook cannot revive a subscription cancelled before authorisation', async () => {
    const world = makeWorld();
    const created = await world.subs.create(PAYU, trialInput());
    await world.subs.cancel(PAYU, created.id);
    await world.subs.webhooks.handle(PAYU, world.gateway.webhook(EventType.SubscriptionAuthorized, created.id));
    await world.subs.verifyCheckout(PAYU, world.gateway.authorize(created.id));
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Cancelled);
    await world.at(CYCLE_3);
    expect(world.gateway.callsTo(GatewayMethod.CreateCharge)).toHaveLength(0);
  });
});

describe('errors that must not reach the scheduler', () => {
  it('a webhook with an invalid signature changes nothing and is reported as SIGNATURE_INVALID', async () => {
    const world = makeWorld();
    const created = await world.subs.create(PAYU, trialInput());
    world.gateway.authorize(created.id);
    const callsBefore = world.store.calls.length;
    const forged = world.gateway.webhook(EventType.SubscriptionAuthorized, created.id, { signature: 'forged' });
    await expect(world.subs.webhooks.handle(PAYU, forged)).rejects.toMatchObject({ code: ErrorCode.SignatureInvalid });
    expect(world.store.calls.length).toBe(callsBefore);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.PendingAuthorization);
  });

  it('a checkout result with an invalid signature changes nothing and is reported as SIGNATURE_INVALID', async () => {
    const world = makeWorld();
    const created = await world.subs.create(PAYU, trialInput());
    world.gateway.authorize(created.id);
    const callsBefore = world.store.calls.length;
    const forged = world.gateway.checkoutResult(created.id, 'forged');
    await expect(world.subs.verifyCheckout(PAYU, forged)).rejects.toMatchObject({ code: ErrorCode.SignatureInvalid });
    expect(world.store.calls.length).toBe(callsBefore);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.PendingAuthorization);
  });

  it('webhooks.parse is pure: it verifies and returns events, and the scheduler is not touched', async () => {
    const world = makeWorld();
    const created = await world.subs.create(PAYU, trialInput());
    world.gateway.authorize(created.id);
    const callsBefore = world.store.calls.length;
    const events = world.subs.webhooks.parse(PAYU, world.gateway.webhook(EventType.SubscriptionAuthorized, created.id));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe(EventType.SubscriptionAuthorized);
    expect(world.store.calls.length).toBe(callsBefore);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.PendingAuthorization);
  });

  it('webhooks.parse with a forged signature throws SIGNATURE_INVALID synchronously', () => {
    const world = makeWorld();
    expect(() =>
      world.subs.webhooks.parse(PAYU, world.gateway.webhook(EventType.SubscriptionAuthorized, 'x', { signature: 'forged' })),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.SignatureInvalid }));
  });

  it('webhooks.handle for an event that matches no schedule is ignored', async () => {
    const world = makeWorld();
    await world.subs.create(PAYU, trialInput());
    const stranger = world.gateway.webhook(EventType.SubscriptionCancelled, 'unknown_sub', { withReference: false });
    const events = await world.subs.webhooks.handle(PAYU, stranger);
    expect(events).toHaveLength(1);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.PendingAuthorization);
  });
});
