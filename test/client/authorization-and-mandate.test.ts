import { describe, expect, it } from 'vitest';
import { EventType, Provider, SubscriptionStatus } from '../../src/constants.js';
import { ScheduleStatus, ScheduleStatusReason } from '../../src/scheduler/index.js';
import {
  CYCLE_2,
  GatewayMethod,
  Style,
  T0,
  TRIAL_END,
  createAndAuthorize,
  makeWorld,
  plusHours,
  scheduleOf,
  trialInput,
} from './helpers.js';

const PAYU = Provider.PayU;
const notifyAt = (due: string): string => plusHours(due, -48);

describe('authorisation that never happens in time', () => {
  it('a schedule still unauthorised after the configured timeout is cancelled by tick(); the customer is never billed', async () => {
    const world = makeWorld({ scheduler: { authorizationTimeoutHours: 24 } });
    await world.subs.create(PAYU, trialInput());
    expect(await world.at(plusHours(T0, 23))).toMatchObject({ expired: 0 });
    expect(await world.at(plusHours(T0, 25))).toMatchObject({ expired: 1 });
    const schedule = await scheduleOf(world);
    expect(schedule.status).toBe(ScheduleStatus.Cancelled);
    expect(schedule.statusReason).toBe(ScheduleStatusReason.AuthorizationTimeout);
    await world.at(notifyAt(TRIAL_END));
    await world.at(TRIAL_END);
    expect(world.gateway.callsTo(GatewayMethod.CreateCharge)).toHaveLength(0);
  });

  it('a customer who authorises after the schedule expired revives it: billing starts normally (the mandate is live)', async () => {
    const world = makeWorld({ scheduler: { authorizationTimeoutHours: 24 } });
    const created = await world.subs.create(PAYU, trialInput());
    await world.at(plusHours(T0, 25));
    expect((await scheduleOf(world)).statusReason).toBe(ScheduleStatusReason.AuthorizationTimeout);

    world.setClock(plusHours(T0, 30));
    const verification = await world.subs.verifyCheckout(PAYU, world.gateway.authorize(created.id));
    expect(verification.authorized).toBe(true);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Active);
    const sub = await world.subs.get(PAYU, created.id);
    expect(sub.status).toBe(SubscriptionStatus.Trialing);
    expect(sub.trialEndsAt).toBe(TRIAL_END);
    await world.at(notifyAt(TRIAL_END));
    await world.at(TRIAL_END);
    expect(world.gateway.callsTo(GatewayMethod.CreateCharge)).toHaveLength(1);
    expect((await world.subs.get(PAYU, created.id)).paidCycles).toBe(1);
  });

  it('so does the authorisation webhook, and get() when the gateway already reports the mandate live', async () => {
    const world = makeWorld({ scheduler: { authorizationTimeoutHours: 24 } });
    const viaWebhook = await world.subs.create(PAYU, trialInput({ reference: 'w' }));
    const viaRead = await world.subs.create(PAYU, trialInput({ reference: 'r' }));
    await world.at(plusHours(T0, 25));
    world.gateway.authorize(viaWebhook.id);
    world.gateway.authorize(viaRead.id);
    await world.subs.webhooks.handle(PAYU, world.gateway.webhook(EventType.SubscriptionAuthorized, viaWebhook.id));
    expect((await scheduleOf(world, 'w')).status).toBe(ScheduleStatus.Active);
    expect((await world.subs.get(PAYU, viaRead.id)).status).toBe(SubscriptionStatus.Trialing);
    expect((await scheduleOf(world, 'r')).status).toBe(ScheduleStatus.Active);
  });

  it('a customer who authorises after the merchant cancelled is not revived: the verification is returned, nothing is billed', async () => {
    const world = makeWorld({ scheduler: { authorizationTimeoutHours: 24 } });
    const created = await world.subs.create(PAYU, trialInput());
    await world.subs.cancel(PAYU, created.id);
    world.gateway.subscriptions.get(created.id)!.status = SubscriptionStatus.Created; // the customer got in first at the bank
    const verification = await world.subs.verifyCheckout(PAYU, world.gateway.authorize(created.id));
    expect(verification.authorized).toBe(true);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Cancelled);
    await world.at(TRIAL_END);
    expect(world.gateway.callsTo(GatewayMethod.CreateCharge)).toHaveLength(0);
  });
});

describe('mandate end date', () => {
  const MANDATE_ENDS = '2026-03-01T00:00:00.000Z';

  it('control: the gateway expires the mandate at its end date and get() reports it', async () => {
    const world = makeWorld();
    const { created } = await createAndAuthorize(world, trialInput({ totalCycles: undefined, mandateEndsAt: MANDATE_ENDS }));
    expect((await world.subs.get(PAYU, created.id)).mandateEndsAt).toBe(MANDATE_ENDS);
    world.setClock(plusHours(MANDATE_ENDS, 1));
    expect((await world.subs.get(PAYU, created.id)).status).toBe(SubscriptionStatus.Expired);
  });

  // Regression guard for a fixed defect: the facade registers the schedule without the mandate's end date. An open-ended subscription whose
  // mandate lapses between two cycles keeps being scheduled: the scheduler sends the customer a pre-debit notice and
  // tries to debit a mandate that no longer exists, every tick, until a webhook happens to arrive.
  it('does not notify or debit after the mandate end date', async () => {
    const world = makeWorld();
    await createAndAuthorize(world, trialInput({ totalCycles: undefined, mandateEndsAt: MANDATE_ENDS }));
    for (const due of [TRIAL_END, CYCLE_2]) {
      await world.at(notifyAt(due));
      await world.at(due);
    }
    expect(world.gateway.callsTo(GatewayMethod.CreateCharge)).toHaveLength(2);
    await world.at(plusHours(MANDATE_ENDS, 12 * 24));
    await world.at(plusHours(MANDATE_ENDS, 14 * 24));
    const afterEnd = world.gateway.calls.filter(
      (call) =>
        (call.method === GatewayMethod.NotifyCharge || call.method === GatewayMethod.CreateCharge) &&
        Date.parse(call.at) >= Date.parse(MANDATE_ENDS),
    );
    expect(afterEnd).toHaveLength(0);
  });
});
