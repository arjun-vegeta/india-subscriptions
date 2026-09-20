import { describe, expect, it } from 'vitest';
import { ChangeTiming, ErrorCode, EventType, Provider, SubscriptionStatus } from '../../src/constants.js';
import { CycleStatus, ScheduleStatus, ScheduleStatusReason } from '../../src/scheduler/index.js';
import {
  AMOUNT,
  CYCLE_2,
  CYCLE_3,
  ChargeOutcome,
  GatewayMethod,
  Style,
  T0,
  TRIAL_END,
  cyclesOf,
  makeWorld,
  plusHours,
  scheduleOf,
  trialInput,
  type World,
} from './helpers.js';

const PAYU = Provider.PayU;
const notifyAt = (due: string): string => plusHours(due, -48);
const NEW_AMOUNT = 59900;

async function authorised(): Promise<{ world: World; id: string }> {
  const world = makeWorld();
  const created = await world.subs.create(PAYU, trialInput());
  world.setClock(plusHours(T0, 1));
  await world.subs.verifyCheckout(PAYU, world.gateway.authorize(created.id));
  return { world, id: created.id };
}

async function afterFirstCharge(): Promise<{ world: World; id: string }> {
  const { world, id } = await authorised();
  await world.at(notifyAt(TRIAL_END));
  await world.at(TRIAL_END);
  return { world, id };
}

const chargeAmounts = (world: World): unknown[] =>
  world.gateway.callsTo(GatewayMethod.CreateCharge).map((call) => (call.args[0] as { amount: number }).amount);
const noticeAmounts = (world: World): unknown[] =>
  world.gateway.callsTo(GatewayMethod.NotifyCharge).map((call) => (call.args[0] as { amount: number }).amount);

describe('update on a merchant-scheduled subscription', () => {
  it('a new amount is sent to the gateway, shown by the facade, and used for every future cycle', async () => {
    const { world, id } = await afterFirstCharge();
    const input = { amount: NEW_AMOUNT, timing: ChangeTiming.AtPeriodEnd };
    const updated = await world.subs.update(PAYU, id, input);

    expect(world.gateway.callsTo(GatewayMethod.UpdateSubscription)).toHaveLength(1);
    expect(world.gateway.callsTo(GatewayMethod.UpdateSubscription)[0]?.args[1]).toBe(input);
    expect(updated.amount).toBe(NEW_AMOUNT);
    expect(updated.status).toBe(SubscriptionStatus.Active);
    expect(updated.paidCycles).toBe(1);
    expect((await scheduleOf(world)).amount).toBe(NEW_AMOUNT);

    for (const due of [CYCLE_2, CYCLE_3]) {
      await world.at(notifyAt(due));
      await world.at(due);
    }
    expect(noticeAmounts(world)).toStrictEqual([AMOUNT, NEW_AMOUNT, NEW_AMOUNT]);
    expect(chargeAmounts(world)).toStrictEqual([AMOUNT, NEW_AMOUNT, NEW_AMOUNT]);
    expect((await world.subs.get(PAYU, id)).amount).toBe(NEW_AMOUNT);
  });

  it('a cycle the customer was already notified about keeps the notified amount; the next cycle uses the new one', async () => {
    const { world, id } = await afterFirstCharge();
    await world.at(notifyAt(CYCLE_2));
    await world.subs.update(PAYU, id, { amount: NEW_AMOUNT });
    await world.at(CYCLE_2);
    await world.at(notifyAt(CYCLE_3));
    await world.at(CYCLE_3);
    expect(chargeAmounts(world)).toStrictEqual([AMOUNT, AMOUNT, NEW_AMOUNT]);
    expect(noticeAmounts(world)).toStrictEqual([AMOUNT, AMOUNT, NEW_AMOUNT]);
  });

  it('an update made before authorisation applies to the first debit', async () => {
    const world = makeWorld();
    const created = await world.subs.create(PAYU, trialInput());
    await world.subs.update(PAYU, created.id, { amount: NEW_AMOUNT });
    await world.subs.verifyCheckout(PAYU, world.gateway.authorize(created.id));
    await world.at(notifyAt(TRIAL_END));
    await world.at(TRIAL_END);
    expect(chargeAmounts(world)).toStrictEqual([NEW_AMOUNT]);
  });

  it('planId and quantity are refused as unsupported before anything is changed anywhere', async () => {
    const { world, id } = await afterFirstCharge();
    const before = await scheduleOf(world);
    await expect(world.subs.update(PAYU, id, { quantity: 2 })).rejects.toMatchObject({ code: ErrorCode.Unsupported });
    await expect(world.subs.update(PAYU, id, { planId: 'plan_2', amount: 1000 })).rejects.toMatchObject({ code: ErrorCode.Unsupported });
    expect(world.gateway.callsTo(GatewayMethod.UpdateSubscription)).toHaveLength(0);
    expect(await scheduleOf(world)).toStrictEqual(before);
  });

  it('schedule-only fields never reach the gateway; the gateway only gets what it holds', async () => {
    const { world, id } = await afterFirstCharge();
    await world.subs.update(PAYU, id, { amount: 59900, nextChargeAt: '2026-02-25T00:00:00.000Z', remainingCycles: 1 });
    const sent = world.gateway.callsTo(GatewayMethod.UpdateSubscription);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.args[1]).toStrictEqual({ amount: 59900 });
    // Nothing for the gateway to do: it is not called at all.
    await world.subs.update(PAYU, id, { nextChargeAt: '2026-02-26T00:00:00.000Z' });
    expect(world.gateway.callsTo(GatewayMethod.UpdateSubscription)).toHaveLength(1);
  });

  it('update(nextChargeAt) moves the next debit and the facade shows it', async () => {
    const { world, id } = await afterFirstCharge();
    const moved = '2026-02-25T00:00:00.000Z';
    const updated = await world.subs.update(PAYU, id, { nextChargeAt: moved });
    expect(updated.nextChargeAt).toBe(moved);
    await world.at(notifyAt(CYCLE_2));
    await world.at(CYCLE_2);
    expect(world.gateway.callsTo(GatewayMethod.CreateCharge)).toHaveLength(1);
    await world.at(notifyAt(moved));
    await world.at(moved);
    expect(world.gateway.callsTo(GatewayMethod.CreateCharge)).toHaveLength(2);
    expect(world.gateway.callsTo(GatewayMethod.CreateCharge)[1]?.at).toBe(moved);
  });

  it('update(remainingCycles) changes how many more debits are raised', async () => {
    const { world, id } = await afterFirstCharge();
    const updated = await world.subs.update(PAYU, id, { remainingCycles: 1 });
    expect(updated.remainingCycles).toBe(1);
    expect(updated.totalCycles).toBe(2);
    for (const due of [CYCLE_2, CYCLE_3]) {
      await world.at(notifyAt(due));
      await world.at(due);
    }
    expect(world.gateway.callsTo(GatewayMethod.CreateCharge)).toHaveLength(2);
    expect((await world.subs.get(PAYU, id)).status).toBe(SubscriptionStatus.Completed);
  });

  it('update(mandateEndsAt) is mirrored: no debit on or after the new end date', async () => {
    const { world, id } = await afterFirstCharge();
    const updated = await world.subs.update(PAYU, id, { mandateEndsAt: '2026-03-01T00:00:00.000Z' });
    expect(updated.mandateEndsAt).toBeDefined();
    expect(world.gateway.sub(id).mandateEndsAt).toBe('2026-03-01T00:00:00.000Z');
    for (const due of [CYCLE_2, CYCLE_3]) {
      await world.at(notifyAt(due));
      await world.at(due);
    }
    expect(world.gateway.callsTo(GatewayMethod.CreateCharge)).toHaveLength(2);
    const schedule = await scheduleOf(world);
    expect(schedule).toMatchObject({ status: ScheduleStatus.Completed, statusReason: ScheduleStatusReason.MandateEnded });
  });

  it('an update on a cancelled subscription is refused with CONFLICT before the gateway is touched', async () => {
    const { world, id } = await afterFirstCharge();
    await world.subs.cancel(PAYU, id);
    await expect(world.subs.update(PAYU, id, { amount: NEW_AMOUNT })).rejects.toMatchObject({ code: ErrorCode.Conflict });
    expect(world.gateway.callsTo(GatewayMethod.UpdateSubscription)).toHaveLength(0);
    expect(world.gateway.sub(id).amount).toBe(AMOUNT);
    expect((await scheduleOf(world)).amount).toBe(AMOUNT);
  });
});

describe('failed charges, retries and halting', () => {
  it('three failed attempts halt the subscription, visible through get; nothing is debited afterwards', async () => {
    const { world, id } = await authorised();
    world.gateway.chargeScript = [ChargeOutcome.Fail, ChargeOutcome.Fail, ChargeOutcome.Fail];
    await world.at(notifyAt(TRIAL_END));

    expect(await world.at(TRIAL_END)).toMatchObject({ charged: 1, failed: 1, succeeded: 0, halted: 0 });
    expect(await world.at(plusHours(TRIAL_END, 24))).toMatchObject({ charged: 1, failed: 1, halted: 0 });
    let sub = await world.subs.get(PAYU, id);
    expect(sub.paidCycles).toBe(0);
    expect(sub.status).not.toBe(SubscriptionStatus.Halted);

    expect(await world.at(plusHours(TRIAL_END, 48))).toMatchObject({ charged: 1, failed: 1, halted: 1 });
    sub = await world.subs.get(PAYU, id);
    expect(sub.status).toBe(SubscriptionStatus.Halted);
    expect(sub.paidCycles).toBe(0);
    expect(sub.remainingCycles).toBe(3);
    expect(sub.nextChargeAt).toBeUndefined();
    const schedule = await scheduleOf(world);
    expect(schedule.status).toBe(ScheduleStatus.Halted);
    expect(schedule.statusReason).toBe(ScheduleStatusReason.RetriesExhausted);
    expect((await cyclesOf(world))[0]?.status).toBe(CycleStatus.Failed);

    const chargeIds = world.gateway.callsTo(GatewayMethod.CreateCharge).map((call) => (call.args[0] as { chargeId: string }).chargeId);
    expect(chargeIds).toHaveLength(3);
    expect(new Set(chargeIds).size).toBe(3); // a retry is a new debit id, never a replay
    for (const probe of [plusHours(TRIAL_END, 72), CYCLE_2, CYCLE_3]) {
      expect(await world.at(probe)).toMatchObject({ charged: 0, notified: 0 });
    }
    expect(world.gateway.callsTo(GatewayMethod.CreateCharge)).toHaveLength(3);
  });

  it('a retry that succeeds bills the cycle once and the schedule carries on', async () => {
    const { world, id } = await authorised();
    world.gateway.chargeScript = [ChargeOutcome.Fail, ChargeOutcome.Succeed];
    await world.at(notifyAt(TRIAL_END));
    await world.at(TRIAL_END);
    await world.at(plusHours(TRIAL_END, 24));
    const sub = await world.subs.get(PAYU, id);
    expect(sub.status).toBe(SubscriptionStatus.Active);
    expect(sub.paidCycles).toBe(1);
    expect(sub.nextChargeAt).toBe(CYCLE_2);
    expect(world.gateway.callsTo(GatewayMethod.CreateCharge)).toHaveLength(2);
  });

  it('a gateway that refuses the debit outright counts as a failed attempt', async () => {
    const { world, id } = await authorised();
    world.gateway.chargeScript = [ChargeOutcome.Reject, ChargeOutcome.Reject, ChargeOutcome.Reject];
    await world.at(notifyAt(TRIAL_END));
    for (const offset of [0, 24, 48]) await world.at(plusHours(TRIAL_END, offset));
    expect((await world.subs.get(PAYU, id)).status).toBe(SubscriptionStatus.Halted);
  });

  it('a failed first debit that is being retried reads past_due', async () => {
    const { world, id } = await authorised();
    world.gateway.chargeScript = [ChargeOutcome.Fail];
    await world.at(notifyAt(TRIAL_END));
    await world.at(TRIAL_END);
    expect((await world.subs.get(PAYU, id)).status).toBe(SubscriptionStatus.PastDue);
  });

  it('a failed later debit that is being retried reads past_due', async () => {
    const { world, id } = await afterFirstCharge();
    world.gateway.chargeScript = [ChargeOutcome.Fail];
    await world.at(notifyAt(CYCLE_2));
    await world.at(CYCLE_2);
    expect((await world.subs.get(PAYU, id)).status).toBe(SubscriptionStatus.PastDue);
  });

  it('past_due ends with the payment: a retry that succeeds reads active again, and a halt reads halted', async () => {
    const { world, id } = await authorised();
    world.gateway.chargeScript = [ChargeOutcome.Fail, ChargeOutcome.Succeed];
    await world.at(notifyAt(TRIAL_END));
    await world.at(TRIAL_END);
    const failing = await world.subs.get(PAYU, id);
    expect(failing.status).toBe(SubscriptionStatus.PastDue);
    expect(failing.trialEndsAt).toBeUndefined();
    expect(failing.nextChargeAt).toBe(plusHours(TRIAL_END, 24));
    await world.at(plusHours(TRIAL_END, 24));
    expect((await world.subs.get(PAYU, id)).status).toBe(SubscriptionStatus.Active);
  });

  it('resuming a halted subscription through the facade makes it bill again (when the scheduler supports it)', async () => {
    const { world, id } = await authorised();
    world.gateway.chargeScript = [ChargeOutcome.Fail, ChargeOutcome.Fail, ChargeOutcome.Fail];
    await world.at(notifyAt(TRIAL_END));
    for (const offset of [0, 24, 48]) await world.at(plusHours(TRIAL_END, offset));
    expect((await world.subs.get(PAYU, id)).status).toBe(SubscriptionStatus.Halted);

    const resumeAt = plusHours(TRIAL_END, 96);
    world.setClock(resumeAt);
    const resumed = await world.subs.resume(PAYU, id);
    expect(resumed.status).not.toBe(SubscriptionStatus.Halted);
    await world.at(resumeAt);
    await world.at(plusHours(resumeAt, 24));
    const sub = await world.subs.get(PAYU, id);
    expect(sub.paidCycles).toBeGreaterThanOrEqual(1);
    expect(world.gateway.callsTo(GatewayMethod.CreateCharge).length).toBe(4);
  });
});

describe('the gateway is the authority on a dead mandate', () => {
  it.each([
    [SubscriptionStatus.Cancelled, ScheduleStatusReason.CancelledByGateway],
    [SubscriptionStatus.Expired, ScheduleStatusReason.MandateExpired],
    [SubscriptionStatus.Failed, ScheduleStatusReason.CancelledByGateway],
  ] as const)('get() follows the gateway when it reports %s and stops the schedule', async (status, reason) => {
    const { world, id } = await afterFirstCharge();
    world.gateway.setStatus(id, status);
    const sub = await world.subs.get(PAYU, id);
    expect(sub.status).toBe(status);
    expect(sub.providerStatus).toBe(status);
    // The schedule's own figures are still reported.
    expect(sub.paidCycles).toBe(1);
    expect(sub.amount).toBe(AMOUNT);
    const schedule = await scheduleOf(world);
    expect(schedule.status).toBe(ScheduleStatus.Cancelled);
    expect(schedule.statusReason).toBe(reason);
  });

  it('once get() has seen the dead mandate the scheduler stops calling it: no notices, no debits, no errors', async () => {
    const { world, id } = await afterFirstCharge();
    world.gateway.setStatus(id, SubscriptionStatus.Cancelled);
    expect((await world.subs.get(PAYU, id)).status).toBe(SubscriptionStatus.Cancelled);
    for (const probe of [notifyAt(CYCLE_2), plusHours(notifyAt(CYCLE_2), 1), CYCLE_2, CYCLE_3]) {
      expect(await world.at(probe)).toMatchObject({ notified: 0, charged: 0, errors: [] });
    }
    expect(world.gateway.callsTo(GatewayMethod.NotifyCharge)).toHaveLength(1);
    expect(world.gateway.callsTo(GatewayMethod.CreateCharge)).toHaveLength(1);
  });

  it('reading a healthy subscription changes nothing in the scheduler', async () => {
    const { world, id } = await afterFirstCharge();
    world.store.calls.length = 0;
    await world.subs.get(PAYU, id);
    expect(world.store.writes()).toStrictEqual([]);
  });

  it('get() starts billing when the gateway already reports the mandate live (apps without webhooks)', async () => {
    const world = makeWorld();
    const created = await world.subs.create(PAYU, trialInput());
    expect((await world.subs.get(PAYU, created.id)).status).toBe(SubscriptionStatus.Created);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.PendingAuthorization);

    world.gateway.authorize(created.id);
    const sub = await world.subs.get(PAYU, created.id);
    expect(sub.status).toBe(SubscriptionStatus.Trialing);
    expect(sub.trialEndsAt).toBe(TRIAL_END);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Active);
    await world.at(notifyAt(TRIAL_END));
    await world.at(TRIAL_END);
    expect(world.gateway.callsTo(GatewayMethod.CreateCharge)).toHaveLength(1);
  });

  it('get() cancels a pending schedule whose mandate the gateway reports dead', async () => {
    const world = makeWorld();
    const created = await world.subs.create(PAYU, trialInput());
    world.gateway.setStatus(created.id, SubscriptionStatus.Failed);
    expect((await world.subs.get(PAYU, created.id)).status).toBe(SubscriptionStatus.Failed);
    expect((await scheduleOf(world)).statusReason).toBe(ScheduleStatusReason.AuthorizationFailed);
  });

  it('a cancelled webhook stops the scheduler: no more notices or debits, status cancelled', async () => {
    const { world, id } = await afterFirstCharge();
    world.gateway.setStatus(id, SubscriptionStatus.Cancelled);
    await world.subs.webhooks.handle(PAYU, world.gateway.webhook(EventType.SubscriptionCancelled, id));
    const schedule = await scheduleOf(world);
    expect(schedule.status).toBe(ScheduleStatus.Cancelled);
    expect(schedule.statusReason).toBe(ScheduleStatusReason.CancelledByGateway);
    for (const probe of [notifyAt(CYCLE_2), CYCLE_2, CYCLE_3]) {
      expect(await world.at(probe)).toMatchObject({ notified: 0, charged: 0, errors: [] });
    }
    expect((await world.subs.get(PAYU, id)).status).toBe(SubscriptionStatus.Cancelled);
    // The facade did not call the gateway's cancel: it was the gateway that cancelled.
    expect(world.gateway.callsTo(GatewayMethod.CancelSubscription)).toHaveLength(0);
  });

  it('an expired webhook stops billing and a halted webhook halts the schedule', async () => {
    const first = await afterFirstCharge();
    await first.world.subs.webhooks.handle(PAYU, first.world.gateway.webhook(EventType.SubscriptionExpired, first.id));
    expect((await scheduleOf(first.world)).status).toBe(ScheduleStatus.Cancelled);
    expect((await scheduleOf(first.world)).statusReason).toBe(ScheduleStatusReason.MandateExpired);

    const second = await afterFirstCharge();
    await second.world.subs.webhooks.handle(PAYU, second.world.gateway.webhook(EventType.SubscriptionHalted, second.id));
    expect((await second.world.subs.get(PAYU, second.id)).status).toBe(SubscriptionStatus.Halted);
    await second.world.at(CYCLE_3);
    expect(second.world.gateway.callsTo(GatewayMethod.CreateCharge)).toHaveLength(1);
  });

  it('a paused webhook pauses billing', async () => {
    const { world, id } = await afterFirstCharge();
    await world.subs.webhooks.handle(PAYU, world.gateway.webhook(EventType.SubscriptionPaused, id));
    expect((await world.subs.get(PAYU, id)).status).toBe(SubscriptionStatus.Paused);
    await world.at(CYCLE_2);
    expect(world.gateway.callsTo(GatewayMethod.CreateCharge)).toHaveLength(1);
  });
});
