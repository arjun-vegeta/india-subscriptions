import { describe, expect, it } from 'vitest';
import { EventType, Provider, SubscriptionStatus } from '../../src/constants.js';
import { ScheduleStatus } from '../../src/scheduler/index.js';
import {
  AMOUNT,
  CYCLE_2,
  GatewayMethod,
  REFERENCE,
  T0,
  TRIAL_END,
  Style,
  cyclesOf,
  makeWorld,
  plusHours,
  scheduleOf,
  trialInput,
  type World,
} from './helpers.js';

const PAYU = Provider.PayU;
const notifyAt = (due: string): string => plusHours(due, -48);

/** PayU-like: the subscription is the merchant reference before authorisation and a gateway mandate id after. */
function idChangingWorld(options: { echoReference?: boolean; pause?: boolean } = {}): World {
  return makeWorld({
    gateways: [
      {
        style: Style.Notify,
        idChanges: true,
        echoReferenceAfterAuth: options.echoReference ?? false,
        pause: options.pause ?? false,
        resume: options.pause ?? false,
      },
    ],
  });
}

async function authorizedWorld(options: { echoReference?: boolean; pause?: boolean } = {}) {
  const world = idChangingWorld(options);
  const created = await world.subs.create(PAYU, trialInput());
  world.setClock(plusHours(T0, 1));
  const verification = await world.subs.verifyCheckout(PAYU, world.gateway.authorize(created.id));
  return { world, created, verification, newId: verification.subscriptionId };
}

describe('id-changing gateway: schedule keyed by reference', () => {
  it('the pre-authorisation subscription id is the merchant reference and the schedule is keyed by it', async () => {
    const world = idChangingWorld();
    const created = await world.subs.create(PAYU, trialInput());
    expect(created.id).toBe(REFERENCE);
    const schedule = await scheduleOf(world);
    expect(schedule.id).toBe(REFERENCE);
    expect(schedule.subscriptionId).toBe(REFERENCE);
    expect(schedule.status).toBe(ScheduleStatus.PendingAuthorization);
  });

  it('verifyCheckout hands back the NEW id and re-points the schedule at it, keeping the schedule id', async () => {
    const { world, verification, newId } = await authorizedWorld();
    expect(verification.authorized).toBe(true);
    expect(newId).not.toBe(REFERENCE);
    expect(verification.reference).toBe(REFERENCE);
    const schedule = await scheduleOf(world);
    expect(schedule.id).toBe(REFERENCE);
    expect(schedule.subscriptionId).toBe(newId);
    expect(schedule.status).toBe(ScheduleStatus.Active);
    expect((await world.scheduler?.findBySubscriptionId(PAYU, newId))?.id).toBe(REFERENCE);
    expect(await world.scheduler?.findBySubscriptionId(PAYU, REFERENCE)).toBeUndefined();
  });

  it('get works with the new id, and with the old reference, and shows the trial from the schedule', async () => {
    const { world, newId } = await authorizedWorld();
    for (const key of [newId, REFERENCE]) {
      const sub = await world.subs.get(PAYU, key);
      expect(sub.id).toBe(newId);
      expect(sub.status).toBe(SubscriptionStatus.Trialing);
      expect(sub.trialEndsAt).toBe(TRIAL_END);
      expect(sub.paidCycles).toBe(0);
      expect(sub.remainingCycles).toBe(3);
    }
  });

  it('notifications and charges go out against the NEW id (the gateway refuses the old one)', async () => {
    const { world, newId } = await authorizedWorld();
    expect(await world.at(notifyAt(TRIAL_END))).toMatchObject({ notified: 1, errors: [] });
    expect(await world.at(TRIAL_END)).toMatchObject({ charged: 1, succeeded: 1, errors: [] });
    expect(world.gateway.callsTo(GatewayMethod.NotifyCharge)[0]?.args[0]).toMatchObject({ subscriptionId: newId });
    expect(world.gateway.callsTo(GatewayMethod.CreateCharge)[0]?.args[0]).toMatchObject({ subscriptionId: newId, amount: AMOUNT });
    const sub = await world.subs.get(PAYU, newId);
    expect(sub.status).toBe(SubscriptionStatus.Active);
    expect(sub.paidCycles).toBe(1);
    expect(sub.nextChargeAt).toBe(CYCLE_2);
  });

  it('a webhook carrying the new id and the reference activates the schedule and re-points it', async () => {
    const world = idChangingWorld();
    const created = await world.subs.create(PAYU, trialInput());
    world.gateway.authorize(created.id);
    const newId = world.gateway.last().id;
    await world.subs.webhooks.handle(PAYU, world.gateway.webhook(EventType.SubscriptionAuthorized, newId));
    const schedule = await scheduleOf(world);
    expect(schedule.status).toBe(ScheduleStatus.Active);
    expect(schedule.subscriptionId).toBe(newId);
    // verifyCheckout afterwards neither throws nor changes anything.
    const before = schedule;
    await world.subs.verifyCheckout(PAYU, world.gateway.checkoutResult(created.id));
    expect(await scheduleOf(world)).toStrictEqual(before);
  });

  it('verifyCheckout first, then a webhook carrying the new id: one cycle, one bill', async () => {
    const { world, newId } = await authorizedWorld();
    await world.subs.webhooks.handle(PAYU, world.gateway.webhook(EventType.SubscriptionActivated, newId));
    expect(await cyclesOf(world)).toHaveLength(1);
    await world.at(notifyAt(TRIAL_END));
    await world.at(TRIAL_END);
    expect(world.gateway.callsTo(GatewayMethod.CreateCharge)).toHaveLength(1);
  });

  describe('pause / resume by the NEW id', () => {
    it('pause: status paused, no debits while paused; resume: billing continues without retroactive debits', async () => {
      const { world, newId } = await authorizedWorld();
      await world.at(notifyAt(TRIAL_END));
      await world.at(TRIAL_END);
      expect(world.gateway.callsTo(GatewayMethod.CreateCharge)).toHaveLength(1);

      world.setClock(plusHours(TRIAL_END, 24));
      const paused = await world.subs.pause(PAYU, newId);
      expect(paused.status).toBe(SubscriptionStatus.Paused);
      expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Paused);

      // Two due dates pass while paused.
      const resumeAt = plusHours(CYCLE_2, 24 * 40);
      await world.at(notifyAt(CYCLE_2));
      await world.at(CYCLE_2);
      await world.at(resumeAt);
      expect(world.gateway.callsTo(GatewayMethod.NotifyCharge)).toHaveLength(1);
      expect(world.gateway.callsTo(GatewayMethod.CreateCharge)).toHaveLength(1);

      const resumed = await world.subs.resume(PAYU, newId);
      expect(resumed.status).toBe(SubscriptionStatus.Active);
      await world.at(resumeAt);
      await world.at(plusHours(resumeAt, 24));
      // Exactly one more debit for the swallowed cycle, none for the cycle after it yet.
      expect(world.gateway.callsTo(GatewayMethod.CreateCharge)).toHaveLength(2);
      expect(world.gateway.callsTo(GatewayMethod.CreateCharge)[1]?.args[0]).toMatchObject({ subscriptionId: newId });
      expect((await world.subs.get(PAYU, newId)).paidCycles).toBe(2);
    });

    it('pause also works when the gateway has its own pause: the gateway is told the new id', async () => {
      const { world, newId } = await authorizedWorld({ pause: true });
      await world.subs.pause(PAYU, newId);
      expect(world.gateway.callsTo(GatewayMethod.PauseSubscription)[0]?.args[0]).toBe(newId);
      await world.subs.resume(PAYU, newId);
      expect(world.gateway.callsTo(GatewayMethod.ResumeSubscription)[0]?.args[0]).toBe(newId);
      expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Active);
    });

    it('pause and resume also work with the old reference', async () => {
      const { world } = await authorizedWorld();
      expect((await world.subs.pause(PAYU, REFERENCE)).status).toBe(SubscriptionStatus.Paused);
      expect((await world.subs.resume(PAYU, REFERENCE)).status).toBe(SubscriptionStatus.Trialing);
    });
  });

  describe('cancel by the new id', () => {
    it('when the gateway still echoes the reference on the mandate, the schedule is cancelled (control)', async () => {
      const { world, newId } = await authorizedWorld({ echoReference: true });
      const cancelled = await world.subs.cancel(PAYU, newId);
      expect(cancelled.status).toBe(SubscriptionStatus.Cancelled);
      expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Cancelled);
    });

    // DEFECT: Subscriptions.cancel() finds the schedule with findSchedule(subscription), i.e. by the reference
    // the GATEWAY echoes on its response, or by the subscription id used as a schedule id. After an id change the
    // schedule is keyed by the merchant reference and the mandate id is only known to findBySubscriptionId, which
    // get()/pause()/resume() use (findScheduleById) but cancel()/update() do not. A gateway that does not repeat the
    // reference on the mandate (PayU's mandate id) leaves the schedule Active after the mandate is cancelled.
    it.fails('cancel(newId) cancels the schedule when the gateway does not echo the reference', async () => {
      const { world, newId } = await authorizedWorld();
      const cancelled = await world.subs.cancel(PAYU, newId);
      expect(cancelled.status).toBe(SubscriptionStatus.Cancelled);
      expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Cancelled);
    });

    // DEFECT (same cause): cancelling with the old reference after authorisation has the same problem.
    it.fails('cancel(reference) after authorisation cancels the schedule when the gateway does not echo the reference', async () => {
      const { world } = await authorizedWorld();
      await world.subs.cancel(PAYU, REFERENCE);
      expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Cancelled);
    });

    it('cancel before authorisation works with the reference (the id is still the reference)', async () => {
      const world = idChangingWorld();
      await world.subs.create(PAYU, trialInput());
      await world.subs.cancel(PAYU, REFERENCE);
      expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Cancelled);
    });
  });

  describe('update by the new id', () => {
    const NEW_AMOUNT = 59900;

    // DEFECT (same cause as cancel): the gateway is told the new amount and the caller is shown it, but the schedule,
    // which decides what is actually debited, is not found and keeps the old amount.
    it.fails('update(newId, { amount }) changes what is debited for future cycles', async () => {
      const { world, newId } = await authorizedWorld();
      const updated = await world.subs.update(PAYU, newId, { amount: NEW_AMOUNT });
      expect(updated.amount).toBe(NEW_AMOUNT);
      expect((await scheduleOf(world)).amount).toBe(NEW_AMOUNT);
      await world.at(notifyAt(TRIAL_END));
      await world.at(TRIAL_END);
      expect(world.gateway.callsTo(GatewayMethod.CreateCharge)[0]?.args[0]).toMatchObject({ amount: NEW_AMOUNT });
    });

    it('with the reference echoed on the mandate the same update reaches the schedule (control)', async () => {
      const { world, newId } = await authorizedWorld({ echoReference: true });
      await world.subs.update(PAYU, newId, { amount: NEW_AMOUNT });
      await world.at(notifyAt(TRIAL_END));
      await world.at(TRIAL_END);
      expect(world.gateway.callsTo(GatewayMethod.CreateCharge)[0]?.args[0]).toMatchObject({ amount: NEW_AMOUNT });
    });
  });
});
