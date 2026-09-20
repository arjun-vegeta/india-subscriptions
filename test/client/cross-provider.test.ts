import { describe, expect, it } from 'vitest';
import { EventType, Provider, SubscriptionStatus } from '../../src/constants.js';
import { ScheduleStatus } from '../../src/scheduler/index.js';
import {
  AMOUNT,
  GatewayMethod,
  Style,
  T0,
  TRIAL_END,
  gatewayInput,
  makeWorld,
  plusHours,
  scheduleIdOf,
  scheduleOf,
  trialInput,
  type World,
} from './helpers.js';

const PAYU = Provider.PayU;
const CASHFREE = Provider.Cashfree;
const RAZORPAY = Provider.Razorpay;
const SHARED = 'order-7781';
const notifyAt = (due: string): string => plusHours(due, -48);

/** Three gateways behind one client, as a merchant mid-migration would run them. */
function threeGateways(): World {
  return makeWorld({ gateways: [{ style: Style.Gateway }, { style: Style.Notify }, { style: Style.Advance }] });
}

/** A live PayU subscription whose merchant reference is SHARED. */
async function livePayU(world: World) {
  const created = await world.subs.create(PAYU, trialInput({ reference: SHARED }));
  world.setClock(plusHours(T0, 1));
  await world.subs.verifyCheckout(PAYU, world.gw(PAYU).authorize(created.id));
  return created;
}

describe('the merchant reference is a per-gateway name, not a global one', () => {
  it('control: with different references the three gateways are completely independent', async () => {
    const world = threeGateways();
    const payu = await world.subs.create(PAYU, trialInput({ reference: 'a' }));
    const cashfree = await world.subs.create(CASHFREE, trialInput({ reference: 'b' }));
    const razorpay = await world.subs.create(RAZORPAY, gatewayInput({ reference: 'c' }));
    expect((await world.scheduler?.get(scheduleIdOf('a')))?.provider).toBe(PAYU);
    expect((await world.scheduler?.get(scheduleIdOf('b', CASHFREE)))?.provider).toBe(CASHFREE);
    expect(await world.scheduler?.get(scheduleIdOf('c', RAZORPAY))).toBeUndefined();
    await world.subs.cancel(RAZORPAY, razorpay.id);
    expect((await scheduleOf(world, 'a')).status).toBe(ScheduleStatus.PendingAuthorization);
    expect((await scheduleOf(world, 'b', CASHFREE)).status).toBe(ScheduleStatus.PendingAuthorization);
    expect(payu.id).not.toBe(cashfree.id);
  });

  // Regression guard for a fixed defect: schedules are keyed by the bare merchant reference, so two gateways cannot use the same reference.
  // Moving a customer from PayU to Cashfree under the same reference (the obvious migration) creates the Cashfree
  // subscription at the gateway and then fails with CONFLICT because the PayU schedule already owns the id.
  it('the same reference can be used on two different gateways', async () => {
    const world = threeGateways();
    await world.subs.create(PAYU, trialInput({ reference: SHARED }));
    const second = await world.subs.create(CASHFREE, trialInput({ reference: SHARED }));
    expect(second.provider).toBe(CASHFREE);
    expect(world.gw(CASHFREE).callsTo(GatewayMethod.CreateSubscription)).toHaveLength(1);
  });

  // Regression guard for a fixed defect: cancel() looks the schedule up by the subscription's reference WITHOUT checking the provider, for every
  // gateway, merchant-scheduled or not. Cancelling a Razorpay subscription whose reference equals a PayU schedule's
  // id cancels the PayU schedule: the customer's live PayU billing stops, silently.
  it('cancelling a Razorpay subscription leaves a PayU schedule with the same reference alone', async () => {
    const world = threeGateways();
    await livePayU(world);
    const razorpay = await world.subs.create(RAZORPAY, gatewayInput({ reference: SHARED }));
    await world.subs.cancel(RAZORPAY, razorpay.id);
    expect((await scheduleOf(world, SHARED)).status).toBe(ScheduleStatus.Active);
  });

  // Regression guard (fixed; same cause): the same happens for update({ amount }), which also rewrites the foreign schedule's amount.
  it('updating the amount of a Razorpay subscription leaves a PayU schedule with the same reference alone', async () => {
    const world = threeGateways();
    await livePayU(world);
    const razorpay = await world.subs.create(RAZORPAY, gatewayInput({ reference: SHARED }));
    await world.subs.update(RAZORPAY, razorpay.id, { amount: 1 });
    expect((await scheduleOf(world, SHARED)).amount).toBe(AMOUNT);
  });

  // Regression guard (fixed; same cause): verifyCheckout() activates whichever schedule carries the verification's reference, whatever
  // the gateway, and re-points it at the verifying gateway's subscription id: the PayU schedule would then raise its
  // debits against a Razorpay subscription id.
  it('a Razorpay checkout verification does not activate a pending PayU schedule with the same reference', async () => {
    const world = threeGateways();
    await world.subs.create(PAYU, trialInput({ reference: SHARED }));
    const razorpay = await world.subs.create(RAZORPAY, gatewayInput({ reference: SHARED }));
    await world.subs.verifyCheckout(RAZORPAY, world.gw(RAZORPAY).authorize(razorpay.id));
    const schedule = await scheduleOf(world, SHARED);
    expect(schedule.status).toBe(ScheduleStatus.PendingAuthorization);
    expect(schedule.subscriptionId).not.toBe(razorpay.id);
  });

  it('reading a Razorpay subscription never overlays a PayU schedule on it', async () => {
    const world = threeGateways();
    await livePayU(world);
    const razorpay = await world.subs.create(RAZORPAY, gatewayInput({ reference: SHARED }));
    const read = await world.subs.get(RAZORPAY, razorpay.id);
    expect(read.status).toBe(SubscriptionStatus.Created);
    expect(read.paidCycles).toBeUndefined();
    expect(read.amount).toBe(AMOUNT);
  });

  it('pause and resume are provider-safe: a Razorpay pause does not pause the PayU schedule', async () => {
    const world = threeGateways();
    await livePayU(world);
    const razorpay = await world.subs.create(RAZORPAY, gatewayInput({ reference: SHARED }));
    const paused = await world.subs.pause(RAZORPAY, razorpay.id);
    expect(paused.status).toBe(SubscriptionStatus.Paused);
    expect((await scheduleOf(world, SHARED)).status).toBe(ScheduleStatus.Active);
    await world.at(notifyAt(TRIAL_END));
    expect(world.gw(PAYU).callsTo(GatewayMethod.NotifyCharge)).toHaveLength(1);
  });

  it('webhooks for one gateway never touch another gateway\'s schedule', async () => {
    const world = threeGateways();
    await world.subs.create(PAYU, trialInput({ reference: SHARED }));
    const razorpay = await world.subs.create(RAZORPAY, gatewayInput({ reference: SHARED }));
    const request = world.gw(RAZORPAY).webhook(EventType.SubscriptionAuthorized, razorpay.id);
    await world.subs.webhooks.handle(RAZORPAY, request);
    expect((await scheduleOf(world, SHARED)).status).toBe(ScheduleStatus.PendingAuthorization);
  });
});
