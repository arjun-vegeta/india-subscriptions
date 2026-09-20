import { describe, expect, it } from 'vitest';
import { Provider, SubscriptionStatus } from '../../src/constants.js';
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

  it('a customer who authorises after the schedule expired: get() reads cancelled, and nothing is ever billed', async () => {
    const world = makeWorld({ scheduler: { authorizationTimeoutHours: 24 } });
    const created = await world.subs.create(PAYU, trialInput());
    await world.at(plusHours(T0, 25));
    world.setClock(plusHours(T0, 30));
    await world.subs.verifyCheckout(PAYU, world.gateway.authorize(created.id));
    expect((await world.subs.get(PAYU, created.id)).status).toBe(SubscriptionStatus.Cancelled);
    await world.at(notifyAt(TRIAL_END));
    await world.at(TRIAL_END);
    expect(world.gateway.callsTo(GatewayMethod.CreateCharge)).toHaveLength(0);
  });

  // DEFECT: the late customer's mandate is live at the gateway and verifyCheckout answers `authorized: true` as if all
  // were well, while the billing schedule was cancelled by its timeout and will never debit. An application that
  // grants access on `authorized` hands out the service for free; the facade neither refuses, nor says "not
  // billable", nor cancels the orphaned mandate.
  it.fails('verifyCheckout does not report a late authorisation as success when the schedule can no longer bill', async () => {
    const world = makeWorld({ scheduler: { authorizationTimeoutHours: 24 } });
    const created = await world.subs.create(PAYU, trialInput());
    await world.at(plusHours(T0, 25));
    world.setClock(plusHours(T0, 30));
    let acceptable = false;
    try {
      const verification = await world.subs.verifyCheckout(PAYU, world.gateway.authorize(created.id));
      const mandateClosed = world.gateway.callsTo(GatewayMethod.CancelSubscription).length > 0;
      acceptable = !verification.authorized || mandateClosed;
    } catch {
      acceptable = true;
    }
    expect(acceptable).toBe(true);
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

  // DEFECT: the facade registers the schedule without the mandate's end date. An open-ended subscription whose
  // mandate lapses between two cycles keeps being scheduled: the scheduler sends the customer a pre-debit notice and
  // tries to debit a mandate that no longer exists, every tick, until a webhook happens to arrive.
  it.fails('does not notify or debit after the mandate end date', async () => {
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
