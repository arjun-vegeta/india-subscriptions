import { describe, expect, it } from 'vitest';
import { ErrorCode, EventType, Provider, SubscriptionStatus, ChangeTiming } from '../../src/constants.js';
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

  it('an update without an amount reaches the gateway and leaves the schedule alone', async () => {
    const { world, id } = await afterFirstCharge();
    const before = await scheduleOf(world);
    const updated = await world.subs.update(PAYU, id, { quantity: 2 });
    expect(world.gateway.callsTo(GatewayMethod.UpdateSubscription)).toHaveLength(1);
    expect(updated.amount).toBe(AMOUNT);
    expect(updated.paidCycles).toBe(1);
    expect(await scheduleOf(world)).toStrictEqual(before);
  });

  // DEFECT: update({ nextChargeAt }) is accepted and silently dropped for merchant-scheduled subscriptions. Only
  // `amount` is mirrored into the scheduler, so the customer is still billed on the old date.
  it.fails('update({ nextChargeAt }) moves the next debit', async () => {
    const { world, id } = await afterFirstCharge();
    const moved = '2026-02-25T00:00:00.000Z';
    const updated = await world.subs.update(PAYU, id, { nextChargeAt: moved });
    expect(updated.nextChargeAt).toBe(moved);
    await world.at(notifyAt(CYCLE_2));
    await world.at(CYCLE_2);
    expect(world.gateway.callsTo(GatewayMethod.CreateCharge)).toHaveLength(1);
  });

  // DEFECT: update({ remainingCycles }) is silently dropped as well: the customer keeps being billed for the
  // cycles the merchant just removed (or stops early if it was increased).
  it.fails('update({ remainingCycles }) changes how many more debits are raised', async () => {
    const { world, id } = await afterFirstCharge();
    const updated = await world.subs.update(PAYU, id, { remainingCycles: 1 });
    expect(updated.remainingCycles).toBe(1);
    for (const due of [CYCLE_2, CYCLE_3]) {
      await world.at(notifyAt(due));
      await world.at(due);
    }
    expect(world.gateway.callsTo(GatewayMethod.CreateCharge)).toHaveLength(2);
  });

  it('an amount update on a cancelled subscription reaches the gateway first and is then refused with CONFLICT', async () => {
    const { world, id } = await afterFirstCharge();
    await world.subs.cancel(PAYU, id);
    await expect(world.subs.update(PAYU, id, { amount: NEW_AMOUNT })).rejects.toMatchObject({ code: ErrorCode.Conflict });
    // Documented behaviour: the gateway already holds the new amount.
    expect(world.gateway.sub(id).amount).toBe(NEW_AMOUNT);
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

  // DEFECT: SubscriptionStatus.PastDue ("a charge failed and is being retried; the subscription is still alive") is
  // never produced for merchant-scheduled subscriptions. A failed FIRST debit reads `trialing` (with trialEndsAt
  // moved to the retry time); a failed later debit reads `active`. The application cannot tell a paying customer
  // from one whose card is bouncing, so it keeps granting full access and never nudges them to fix the mandate.
  it.fails('a failed first debit that is being retried reads past_due', async () => {
    const { world, id } = await authorised();
    world.gateway.chargeScript = [ChargeOutcome.Fail];
    await world.at(notifyAt(TRIAL_END));
    await world.at(TRIAL_END);
    expect((await world.subs.get(PAYU, id)).status).toBe(SubscriptionStatus.PastDue);
  });

  it.fails('a failed later debit that is being retried reads past_due', async () => {
    const { world, id } = await afterFirstCharge();
    world.gateway.chargeScript = [ChargeOutcome.Fail];
    await world.at(notifyAt(CYCLE_2));
    await world.at(CYCLE_2);
    expect((await world.subs.get(PAYU, id)).status).toBe(SubscriptionStatus.PastDue);
  });

  it('documents the current reading of a first debit that failed: trialing, with trialEndsAt moved to the retry', async () => {
    const { world, id } = await authorised();
    world.gateway.chargeScript = [ChargeOutcome.Fail];
    await world.at(notifyAt(TRIAL_END));
    await world.at(TRIAL_END);
    const sub = await world.subs.get(PAYU, id);
    expect(sub.status).toBe(SubscriptionStatus.Trialing);
    expect(sub.trialEndsAt).toBe(plusHours(TRIAL_END, 24));
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
  it.each([SubscriptionStatus.Cancelled, SubscriptionStatus.Expired, SubscriptionStatus.Failed])(
    'get() follows the gateway when it reports %s even though the schedule still says active',
    async (status) => {
      const { world, id } = await afterFirstCharge();
      world.gateway.setStatus(id, status);
      const sub = await world.subs.get(PAYU, id);
      expect(sub.status).toBe(status);
      expect(sub.providerStatus).toBe(status);
      // The schedule's own figures are still reported.
      expect(sub.paidCycles).toBe(1);
      expect(sub.amount).toBe(AMOUNT);
      expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Active);
    },
  );

  it('documents that nothing stops the scheduler when only get() has seen the dead mandate: every tick keeps trying', async () => {
    const { world, id } = await afterFirstCharge();
    world.gateway.setStatus(id, SubscriptionStatus.Cancelled);
    expect((await world.subs.get(PAYU, id)).status).toBe(SubscriptionStatus.Cancelled);

    const first = await world.at(notifyAt(CYCLE_2));
    const second = await world.at(plusHours(notifyAt(CYCLE_2), 1));
    expect(first.errors.map((error) => error.code)).toStrictEqual([ErrorCode.ProviderError]);
    expect(second.errors.map((error) => error.code)).toStrictEqual([ErrorCode.ProviderError]);
    expect(world.gateway.callsTo(GatewayMethod.NotifyCharge)).toHaveLength(3);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Active);
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
