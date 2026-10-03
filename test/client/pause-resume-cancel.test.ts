import { describe, expect, it } from 'vitest';
import { CancelMode, ErrorCode, Provider, SubscriptionStatus } from '../../src/constants.js';
import { CycleStatus, ScheduleStatus, ScheduleStatusReason } from '../../src/scheduler/index.js';
import {
  CYCLE_2,
  CYCLE_3,
  GatewayMethod,
  Style,
  T0,
  TRIAL_END,
  createAndAuthorize,
  cyclesOf,
  makeWorld,
  plusHours,
  scheduleOf,
  trialInput,
  type GatewayOptions,
  type World,
} from './helpers.js';

const PAYU = Provider.PayU;
const notifyAt = (due: string): string => plusHours(due, -48);
/** A moment well after the second cycle's due date, used for resuming. */
const LATE = '2026-03-20T00:00:00.000Z';
const APRIL_20 = '2026-04-20T00:00:00.000Z';

type Spec = Omit<GatewayOptions, 'clock' | 'log'>;

/** Authorised, trial over, first cycle paid at TRIAL_END; the clock stands at TRIAL_END. */
async function afterFirstCharge(spec: Spec = { style: Style.Notify }) {
  const world = makeWorld({ gateways: [spec] });
  const created = await world.subs.create(PAYU, trialInput());
  world.setClock(plusHours(T0, 1));
  await world.subs.verifyCheckout(PAYU, world.gateway.authorize(created.id));
  await world.at(notifyAt(TRIAL_END));
  await world.at(TRIAL_END);
  expect(world.gateway.callsTo(GatewayMethod.CreateCharge)).toHaveLength(1);
  return { world, id: created.id };
}

const debits = (world: World): number => world.gateway.callsTo(GatewayMethod.CreateCharge).length;
const notices = (world: World): number => world.gateway.callsTo(GatewayMethod.NotifyCharge).length;

describe('pause / resume: provider WITHOUT a gateway pause operation', () => {
  it('pause stops the scheduler only: status paused, gateway pause not attempted, no debits or notices while paused', async () => {
    const { world, id } = await afterFirstCharge();
    const paused = await world.subs.pause(PAYU, id);

    expect(paused.status).toBe(SubscriptionStatus.Paused);
    expect(paused.paidCycles).toBe(1);
    expect(paused.nextChargeAt).toBeUndefined();
    expect(world.gateway.callsTo(GatewayMethod.PauseSubscription)).toHaveLength(0);
    expect(world.gateway.callsTo(GatewayMethod.GetSubscription)).toHaveLength(1);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Paused);
    expect((await world.subs.get(PAYU, id)).status).toBe(SubscriptionStatus.Paused);

    for (const probe of [notifyAt(CYCLE_2), CYCLE_2, notifyAt(CYCLE_3), CYCLE_3, LATE]) {
      expect(await world.at(probe)).toMatchObject({ notified: 0, charged: 0 });
    }
    expect(debits(world)).toBe(1);
    expect(notices(world)).toBe(1);
  });

  it('pausing twice is harmless', async () => {
    const { world, id } = await afterFirstCharge();
    await world.subs.pause(PAYU, id);
    expect((await world.subs.pause(PAYU, id)).status).toBe(SubscriptionStatus.Paused);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Paused);
  });

  it('resume continues billing from the next cycle and never bills the cycles that fell due while paused', async () => {
    const { world, id } = await afterFirstCharge();
    world.setClock(plusHours(TRIAL_END, 24));
    await world.subs.pause(PAYU, id);
    await world.at(CYCLE_2); // the second cycle's due date passes while paused
    await world.at(CYCLE_3);
    world.setClock(LATE);
    const resumed = await world.subs.resume(PAYU, id);

    expect(resumed.status).toBe(SubscriptionStatus.Active);
    expect(world.gateway.callsTo(GatewayMethod.ResumeSubscription)).toHaveLength(0);
    expect(debits(world)).toBe(1); // nothing retroactive at the moment of resuming

    // Notice at once, debit 24h later: ONE debit for the swallowed cycle ...
    expect(await world.at(LATE)).toMatchObject({ notified: 1, charged: 0 });
    expect(await world.at(plusHours(LATE, 24))).toMatchObject({ charged: 1, succeeded: 1 });
    expect(debits(world)).toBe(2);
    let sub = await world.subs.get(PAYU, id);
    expect(sub.status).toBe(SubscriptionStatus.Active);
    expect(sub.paidCycles).toBe(2);
    expect(sub.nextChargeAt).toBe(APRIL_20);

    // ... and the last cycle a month after the resume date, not immediately.
    expect(await world.at(plusHours(LATE, 48))).toMatchObject({ charged: 0 });
    await world.at(notifyAt(APRIL_20));
    await world.at(APRIL_20);
    sub = await world.subs.get(PAYU, id);
    expect(debits(world)).toBe(3);
    expect(sub.status).toBe(SubscriptionStatus.Completed);
    expect(sub.paidCycles).toBe(3);
  });

  it('resume({ nextChargeAt }) re-anchors the next debit to that date', async () => {
    const { world, id } = await afterFirstCharge();
    await world.subs.pause(PAYU, id);
    world.setClock(LATE);
    const nextChargeAt = '2026-04-01T00:00:00.000Z';
    const resumed = await world.subs.resume(PAYU, id, { nextChargeAt });
    expect(resumed.nextChargeAt).toBe(nextChargeAt);
    expect(await world.at(plusHours(nextChargeAt, -49))).toMatchObject({ notified: 0 });
    expect(await world.at(notifyAt(nextChargeAt))).toMatchObject({ notified: 1 });
    expect(await world.at(nextChargeAt)).toMatchObject({ charged: 1, succeeded: 1 });
    expect(world.gateway.callsTo(GatewayMethod.CreateCharge)[1]?.at).toBe(nextChargeAt);
  });

  it('resume of a subscription that was not paused is a no-op for billing', async () => {
    const { world, id } = await afterFirstCharge();
    const before = await scheduleOf(world);
    const resumed = await world.subs.resume(PAYU, id);
    expect(resumed.status).toBe(SubscriptionStatus.Active);
    expect(await scheduleOf(world)).toStrictEqual(before);
  });

  it('pause before the customer has authorised is refused with CONFLICT and the gateway is never asked', async () => {
    const world = makeWorld();
    const created = await world.subs.create(PAYU, trialInput());
    await expect(world.subs.pause(PAYU, created.id)).rejects.toMatchObject({ code: ErrorCode.Conflict });
    expect(world.gateway.callsTo(GatewayMethod.PauseSubscription)).toHaveLength(0);
    expect(world.gateway.callsTo(GatewayMethod.GetSubscription)).toHaveLength(0);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.PendingAuthorization);
  });

  it('pausing during the trial keeps the trial date; resuming before it needs no re-anchoring', async () => {
    const world = makeWorld();
    const { created } = await createAndAuthorize(world);
    const paused = await world.subs.pause(PAYU, created.id);
    expect(paused.status).toBe(SubscriptionStatus.Paused);
    const resumed = await world.subs.resume(PAYU, created.id);
    expect(resumed.status).toBe(SubscriptionStatus.Trialing);
    expect(resumed.trialEndsAt).toBe(TRIAL_END);
    await world.at(notifyAt(TRIAL_END));
    await world.at(TRIAL_END);
    expect(debits(world)).toBe(1);
  });
});

describe('pause / resume: provider WITH a gateway pause operation', () => {
  const spec: Spec = { style: Style.Notify, pause: true, resume: true };

  it('the scheduler alone pauses: the gateway pause is never used, so the mandate stays usable', async () => {
    const { world, id } = await afterFirstCharge(spec);
    const paused = await world.subs.pause(PAYU, id);
    expect(paused.status).toBe(SubscriptionStatus.Paused);
    expect(world.gateway.callsTo(GatewayMethod.PauseSubscription)).toHaveLength(0);
    expect(world.gateway.sub(id).status).toBe(SubscriptionStatus.Active);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Paused);
    for (const probe of [notifyAt(CYCLE_2), CYCLE_2, CYCLE_3]) await world.at(probe);
    expect(debits(world)).toBe(1);
    expect(notices(world)).toBe(1);
  });

  it('the scheduler alone resumes, and billing continues', async () => {
    const { world, id } = await afterFirstCharge(spec);
    await world.subs.pause(PAYU, id);
    world.setClock(LATE);
    const nextChargeAt = '2026-04-01T00:00:00.000Z';
    const resumed = await world.subs.resume(PAYU, id, { nextChargeAt });
    expect(resumed.status).toBe(SubscriptionStatus.Active);
    expect(resumed.nextChargeAt).toBe(nextChargeAt);
    expect(world.gateway.callsTo(GatewayMethod.ResumeSubscription)).toHaveLength(0);
    await world.at(notifyAt(nextChargeAt));
    await world.at(nextChargeAt);
    expect(debits(world)).toBe(2);
  });

  it('a gateway that has paused the mandate itself is never asked to resume it either', async () => {
    const { world, id } = await afterFirstCharge(spec);
    await world.subs.pause(PAYU, id);
    world.gateway.failOnce(GatewayMethod.PauseSubscription);
    world.gateway.failOnce(GatewayMethod.ResumeSubscription);
    await world.subs.resume(PAYU, id);
    expect(world.gateway.callsTo(GatewayMethod.PauseSubscription)).toHaveLength(0);
    expect(world.gateway.callsTo(GatewayMethod.ResumeSubscription)).toHaveLength(0);
  });

  it('pause({ resumeAt }) is honoured by the scheduler: no debits before it, billing continues at it', async () => {
    const { world, id } = await afterFirstCharge(spec);
    const resumeAt = '2026-02-20T00:00:00.000Z';
    const paused = await world.subs.pause(PAYU, id, { resumeAt });
    expect(paused.status).toBe(SubscriptionStatus.Paused);
    expect((await scheduleOf(world)).resumeAt).toBe(resumeAt);
    for (const probe of [CYCLE_2, plusHours(resumeAt, -1)]) await world.at(probe);
    expect(debits(world)).toBe(1);
    expect(world.gateway.callsTo(GatewayMethod.PauseSubscription)).toHaveLength(0);

    await world.at(resumeAt);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Active);
    await world.at(plusHours(resumeAt, 24));
    expect(debits(world)).toBe(2);
    expect((await world.subs.get(PAYU, id)).paidCycles).toBe(2);
  });

  it('pause({ resumeAt }) works the same on a provider without a gateway pause', async () => {
    const { world, id } = await afterFirstCharge();
    const resumeAt = '2026-02-20T00:00:00.000Z';
    await world.subs.pause(PAYU, id, { resumeAt });
    for (const probe of [CYCLE_2, resumeAt, plusHours(resumeAt, 24)]) await world.at(probe);
    expect(debits(world)).toBe(2);
  });

  it('a resumeAt in the past is refused and nothing is paused', async () => {
    const { world, id } = await afterFirstCharge();
    await expect(world.subs.pause(PAYU, id, { resumeAt: plusHours(TRIAL_END, -1) })).rejects.toMatchObject({ code: ErrorCode.Validation });
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Active);
  });

  it('a gateway outage does not affect a pause: pause and resume are the scheduler\'s alone and do not depend on a gateway read', async () => {
    const { world, id } = await afterFirstCharge(spec);
    world.gateway.failOnce(GatewayMethod.GetSubscription);
    const paused = await world.subs.pause(PAYU, id);
    expect(paused.status).toBe(SubscriptionStatus.Paused);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Paused);
    expect(await world.at(CYCLE_2)).toMatchObject({ charged: 0 });
    world.gateway.failOnce(GatewayMethod.GetSubscription);
    expect((await world.subs.resume(PAYU, id)).status).not.toBe(SubscriptionStatus.Paused);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Active);
  });
});

describe('cancel', () => {
  it('cancels the schedule and the gateway mandate (once); nothing is notified or debited afterwards', async () => {
    const { world, id } = await afterFirstCharge();
    const cancelled = await world.subs.cancel(PAYU, id);

    expect(cancelled.status).toBe(SubscriptionStatus.Cancelled);
    expect(world.gateway.callsTo(GatewayMethod.CancelSubscription)).toHaveLength(1);
    expect(world.gateway.callsTo(GatewayMethod.CancelSubscription)[0]?.args[0]).toBe(id);
    const schedule = await scheduleOf(world);
    expect(schedule.status).toBe(ScheduleStatus.Cancelled);
    expect(schedule.statusReason).toBe(ScheduleStatusReason.CancelledByMerchant);
    expect(schedule.nextChargeAt).toBeUndefined();
    expect((await cyclesOf(world))[1]?.status).toBe(CycleStatus.Skipped);

    for (const probe of [notifyAt(CYCLE_2), CYCLE_2, notifyAt(CYCLE_3), CYCLE_3, LATE]) {
      expect(await world.at(probe)).toMatchObject({ notified: 0, charged: 0, errors: [] });
    }
    expect(debits(world)).toBe(1);
    expect(notices(world)).toBe(1);
    const read = await world.subs.get(PAYU, id);
    expect(read.status).toBe(SubscriptionStatus.Cancelled);
    expect(read.paidCycles).toBe(1);
    expect(read.nextChargeAt).toBeUndefined();
  });

  it('cancelling after the pre-debit notice but before the debit means the customer is never debited', async () => {
    const { world, id } = await afterFirstCharge();
    await world.at(notifyAt(CYCLE_2));
    expect(notices(world)).toBe(2);
    await world.subs.cancel(PAYU, id);
    await world.at(CYCLE_2);
    await world.at(plusHours(CYCLE_2, 48));
    expect(debits(world)).toBe(1);
  });

  it('cancelling while paused works', async () => {
    const { world, id } = await afterFirstCharge();
    await world.subs.pause(PAYU, id);
    const cancelled = await world.subs.cancel(PAYU, id);
    expect(cancelled.status).toBe(SubscriptionStatus.Cancelled);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Cancelled);
  });

  it('cancelling twice leaves it cancelled and bills nothing', async () => {
    const { world, id } = await afterFirstCharge();
    await world.subs.cancel(PAYU, id);
    const again = await world.subs.cancel(PAYU, id);
    expect(again.status).toBe(SubscriptionStatus.Cancelled);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Cancelled);
    await world.at(CYCLE_3);
    expect(debits(world)).toBe(1);
  });

  it('cancel BEFORE authorisation: schedule cancelled, gateway cancelled once, later authorisation cannot start billing', async () => {
    const world = makeWorld();
    const created = await world.subs.create(PAYU, trialInput());
    const cancelled = await world.subs.cancel(PAYU, created.id);
    expect(cancelled.status).toBe(SubscriptionStatus.Cancelled);
    expect(world.gateway.callsTo(GatewayMethod.CancelSubscription)).toHaveLength(1);
    const schedule = await scheduleOf(world);
    expect(schedule.status).toBe(ScheduleStatus.Cancelled);
    expect(schedule.statusReason).toBe(ScheduleStatusReason.CancelledByMerchant);
    expect(await cyclesOf(world)).toHaveLength(0);

    const late = await world.subs.verifyCheckout(PAYU, world.gateway.authorize(created.id));
    expect(late.authorized).toBe(false);
    for (const probe of [notifyAt(TRIAL_END), TRIAL_END, CYCLE_3]) await world.at(probe);
    expect(debits(world)).toBe(0);
    expect(notices(world)).toBe(0);
  });

  it('cancel during the trial: no notice, no debit', async () => {
    const world = makeWorld();
    const { created } = await createAndAuthorize(world);
    await world.subs.cancel(PAYU, created.id, { mode: CancelMode.Immediately });
    for (const probe of [notifyAt(TRIAL_END), TRIAL_END, CYCLE_2]) await world.at(probe);
    expect(debits(world)).toBe(0);
    expect(notices(world)).toBe(0);
    expect(world.gateway.callsTo(GatewayMethod.CancelSubscription)[0]?.args).toStrictEqual([created.id, { mode: CancelMode.Immediately }]);
  });

  it('cancel after the subscription completed does not throw: the schedule stays completed and the mandate is cancelled', async () => {
    const { world, id } = await afterFirstCharge();
    for (const due of [CYCLE_2, CYCLE_3]) {
      await world.at(notifyAt(due));
      await world.at(due);
    }
    expect((await world.subs.get(PAYU, id)).status).toBe(SubscriptionStatus.Completed);
    // The mandate of a completed subscription is still live at the gateway (the facade never closes it by itself).
    expect(world.gateway.callsTo(GatewayMethod.CancelSubscription)).toHaveLength(0);
    expect(world.gateway.sub(id).status).toBe(SubscriptionStatus.Active);
    const cancelled = await world.subs.cancel(PAYU, id);
    expect(cancelled.status).toBe(SubscriptionStatus.Cancelled);
    expect(world.gateway.callsTo(GatewayMethod.CancelSubscription)).toHaveLength(1);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Completed);
    expect(cancelled.paidCycles).toBe(3);
  });

  it('cancel stops billing before the gateway is asked (the schedule is already cancelled when the gateway call happens)', async () => {
    const { world, id } = await afterFirstCharge();
    let scheduleWhenGatewayAsked: ScheduleStatus | undefined;
    const original = world.gateway.cancelSubscription.bind(world.gateway);
    world.gateway.cancelSubscription = async (...args) => {
      scheduleWhenGatewayAsked = (await scheduleOf(world)).status;
      return original(...args);
    };
    await world.subs.cancel(PAYU, id);
    expect(scheduleWhenGatewayAsked).toBe(ScheduleStatus.Cancelled);
  });

  it('cancelling at the end of the period is refused up front on a merchant-scheduled subscription, and nothing is stopped', async () => {
    const { world, id } = await afterFirstCharge();
    await expect(world.subs.cancel(PAYU, id, { mode: CancelMode.AtPeriodEnd })).rejects.toMatchObject({ code: ErrorCode.Unsupported });
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Active);
    expect(world.gateway.callsTo(GatewayMethod.CancelSubscription)).toHaveLength(0);
  });
});
