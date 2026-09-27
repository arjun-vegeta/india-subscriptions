import { describe, expect, it } from 'vitest';
import { ChargeStatus, EventType, Provider, SubscriptionStatus } from '../../src/constants.js';
import { CycleStatus, ScheduleStatus } from '../../src/scheduler/index.js';
import {
  AMOUNT,
  CYCLE_2,
  CYCLE_3,
  ChargeOutcome,
  GatewayMethod,
  REFERENCE,
  T0,
  TRIAL_END,
  Style,
  createAndAuthorize,
  cyclesOf,
  makeWorld,
  plusHours,
  scheduleOf,
  trialInput,
} from './helpers.js';

const CASHFREE = Provider.Cashfree;
/** The gateway wants the charge raised 24h before the debit date and notifies the customer itself. */
const raiseAt = (due: string): string => plusHours(due, -24);

function chargeAheadWorld() {
  return makeWorld({ gateways: [{ style: Style.Advance, leadHours: 24 }] });
}

describe('merchant-scheduled, charge-ahead (merchantChargeLeadHours): lifecycle through the facade', () => {
  it('declares itself merchant-scheduled with a lead time and no merchant pre-debit notification', () => {
    const world = chargeAheadWorld();
    expect(world.subs.capabilities(CASHFREE)).toMatchObject({
      merchantCharges: true,
      merchantPreDebitNotification: false,
      merchantChargeLeadHours: 24,
    });
  });

  it('nothing is raised before authorisation, however often tick() runs', async () => {
    const world = chargeAheadWorld();
    await world.subs.create(CASHFREE, trialInput());
    for (const probe of [raiseAt(TRIAL_END), TRIAL_END, CYCLE_2]) {
      expect(await world.at(probe)).toMatchObject({ charged: 0, reconciled: 0, notified: 0, errors: [] });
    }
    expect(world.gateway.callsTo(GatewayMethod.CreateCharge)).toHaveLength(0);
    expect(world.gateway.callsTo(GatewayMethod.NotifyCharge)).toHaveLength(0);
    expect((await scheduleOf(world, REFERENCE, CASHFREE)).status).toBe(ScheduleStatus.PendingAuthorization);
  });

  it('trial -> charge raised 24h ahead -> status active once the debit date has passed -> completed after three cycles', async () => {
    const world = chargeAheadWorld();
    world.setClock(T0);
    const { created } = await createAndAuthorize(world);
    const id = created.id;

    let sub = await world.subs.get(CASHFREE, id);
    expect(sub.status).toBe(SubscriptionStatus.Trialing);
    expect(sub.trialEndsAt).toBe(TRIAL_END);

    // Too early: no charge, no notification (this gateway notifies the customer itself).
    expect(await world.at(plusHours(raiseAt(TRIAL_END), -1))).toMatchObject({ charged: 0 });
    expect(world.gateway.callsTo(GatewayMethod.NotifyCharge)).toHaveLength(0);

    // 24h before the due date the charge is created, scheduled for the due date.
    expect(await world.at(raiseAt(TRIAL_END))).toMatchObject({ charged: 1, awaiting: 1, succeeded: 0, errors: [] });
    const first = world.gateway.callsTo(GatewayMethod.CreateCharge);
    expect(first).toHaveLength(1);
    expect(first[0]?.at).toBe(raiseAt(TRIAL_END));
    expect(first[0]?.args[0]).toMatchObject({ subscriptionId: id, amount: AMOUNT, scheduledAt: TRIAL_END });

    // Debit not yet made: still a trial, nothing paid, and no polling before the debit date.
    sub = await world.subs.get(CASHFREE, id);
    expect(sub.status).toBe(SubscriptionStatus.Trialing);
    expect(sub.paidCycles).toBe(0);
    expect(sub.nextChargeAt).toBe(TRIAL_END);
    const pollsBefore = world.gateway.callsTo(GatewayMethod.GetCharge).length;
    await world.at(plusHours(TRIAL_END, -1));
    expect(world.gateway.callsTo(GatewayMethod.GetCharge)).toHaveLength(pollsBefore);
    expect(world.gateway.callsTo(GatewayMethod.CreateCharge)).toHaveLength(1);

    // On the debit date the gateway has taken the money; the next tick confirms it.
    expect(await world.at(TRIAL_END)).toMatchObject({ succeeded: 1, errors: [] });
    sub = await world.subs.get(CASHFREE, id);
    expect(sub.status).toBe(SubscriptionStatus.Active);
    expect(sub.paidCycles).toBe(1);
    expect(sub.remainingCycles).toBe(2);
    expect(sub.nextChargeAt).toBe(CYCLE_2);

    // Cycles 2 and 3.
    for (const due of [CYCLE_2, CYCLE_3]) {
      await world.at(raiseAt(due));
      await world.at(due);
    }
    sub = await world.subs.get(CASHFREE, id);
    expect(sub.status).toBe(SubscriptionStatus.Completed);
    expect(sub.paidCycles).toBe(3);
    expect(sub.remainingCycles).toBe(0);
    expect(sub.nextChargeAt).toBeUndefined();

    const created3 = world.gateway.callsTo(GatewayMethod.CreateCharge);
    expect(created3.map((call) => call.at)).toStrictEqual([raiseAt(TRIAL_END), raiseAt(CYCLE_2), raiseAt(CYCLE_3)]);
    expect(created3.map((call) => (call.args[0] as { scheduledAt: string }).scheduledAt)).toStrictEqual([TRIAL_END, CYCLE_2, CYCLE_3]);
    expect(world.gateway.callsTo(GatewayMethod.NotifyCharge)).toHaveLength(0);
    expect(await world.at(plusHours(CYCLE_3, 24 * 365))).toMatchObject({ due: 0, charged: 0 });
  });

  it('authorising less than the lead time before the due date pushes the debit to now + lead (never an illegal date)', async () => {
    const world = chargeAheadWorld();
    const created = await world.subs.create(CASHFREE, trialInput());
    const lateAt = plusHours(TRIAL_END, -12);
    world.setClock(lateAt);
    await world.subs.verifyCheckout(CASHFREE, world.gateway.authorize(created.id));

    expect(await world.at(lateAt)).toMatchObject({ charged: 1, errors: [] });
    const call = world.gateway.callsTo(GatewayMethod.CreateCharge)[0];
    expect(call?.args[0]).toMatchObject({ scheduledAt: plusHours(lateAt, 24) });
    // The contractual due date is unchanged; only the debit moved.
    const cycle = (await cyclesOf(world, REFERENCE, CASHFREE))[0];
    expect(cycle?.dueAt).toBe(TRIAL_END);
    expect(cycle?.scheduledAt).toBe(plusHours(lateAt, 24));
  });

  it('a webhook "charged" event settles the awaiting cycle without waiting for tick', async () => {
    const world = chargeAheadWorld();
    const { created } = await createAndAuthorize(world);
    await world.at(raiseAt(TRIAL_END));
    const chargeId = (world.gateway.callsTo(GatewayMethod.CreateCharge)[0]?.args[0] as { chargeId: string }).chargeId;
    expect((await cyclesOf(world, REFERENCE, CASHFREE))[0]?.status).toBe(CycleStatus.AwaitingConfirmation);

    world.gateway.settle(chargeId, ChargeStatus.Succeeded);
    world.setClock(TRIAL_END);
    await world.subs.webhooks.handle(
      CASHFREE,
      world.gateway.webhook(EventType.SubscriptionCharged, created.id, { chargeId }),
    );
    const sub = await world.subs.get(CASHFREE, created.id);
    expect(sub.paidCycles).toBe(1);
    expect(sub.status).toBe(SubscriptionStatus.Active);
    // A duplicate delivery does not count the cycle twice.
    await world.subs.webhooks.handle(
      CASHFREE,
      world.gateway.webhook(EventType.SubscriptionCharged, created.id, { chargeId }),
    );
    expect((await world.subs.get(CASHFREE, created.id)).paidCycles).toBe(1);
  });

  it('cancel while the charge is scheduled: no further charges are raised for later cycles', async () => {
    const world = chargeAheadWorld();
    const { created } = await createAndAuthorize(world);
    await world.at(raiseAt(TRIAL_END));
    expect(world.gateway.callsTo(GatewayMethod.CreateCharge)).toHaveLength(1);
    await world.subs.cancel(CASHFREE, created.id);
    await world.at(raiseAt(CYCLE_2));
    await world.at(CYCLE_3);
    expect(world.gateway.callsTo(GatewayMethod.CreateCharge)).toHaveLength(1);
    expect(world.gateway.callsTo(GatewayMethod.CancelSubscription)).toHaveLength(1);
  });

  it('a gateway that refuses the charge ahead of time is reported in tick().errors without halting the schedule immediately', async () => {
    const world = chargeAheadWorld();
    const { created } = await createAndAuthorize(world);
    world.gateway.chargeScript = [ChargeOutcome.Reject];
    const tick = await world.at(raiseAt(TRIAL_END));
    expect(tick.failed).toBe(1);
    expect(tick.errors).toStrictEqual([]);
    const sub = await world.subs.get(CASHFREE, created.id);
    expect(sub.status).not.toBe(SubscriptionStatus.Completed);
  });
});
