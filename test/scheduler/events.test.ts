import { describe, expect, it } from 'vitest';
import { ChargeStatus, EventType, Provider } from '../../src/constants.js';
import { CycleStatus, ScheduleStatus, ScheduleStatusReason, SchedulerEventType } from '../../src/scheduler/index.js';
import {
  CreateBehaviour,
  DUE,
  Style,
  makeEvent,
  makeHarness,
  plusHours,
  registration,
  sleep,
  type Harness,
  SID,
} from './helpers.js';

/** A schedule whose first debit was raised and is awaiting the bank's answer. */
async function awaiting(h: Harness): Promise<string> {
  h.provider.createScript = [CreateBehaviour.Pending];
  await h.scheduler.register(registration());
  await h.tickAt(plusHours(DUE, -48));
  await h.tickAt(DUE);
  const cycle = await h.store.getCycle(SID, 0);
  expect(cycle?.status).toBe(CycleStatus.AwaitingConfirmation);
  return cycle?.chargeId as string;
}

describe('handleEvent: charges', () => {
  it('settles an awaiting charge on subscription.charged, matched by charge.reference, idempotently', async () => {
    const h = makeHarness();
    const chargeId = await awaiting(h);
    const event = makeEvent({
      type: EventType.SubscriptionCharged,
      subscriptionId: 'sub_1',
      charge: { chargeId, status: ChargeStatus.Succeeded },
    });

    await h.scheduler.handleEvent(event);
    expect(await h.scheduler.get(SID)).toMatchObject({ paidCycles: 1, cycleIndex: 1 });
    expect((await h.store.getCycle(SID, 0))?.status).toBe(CycleStatus.Succeeded);
    expect((await h.store.getCycle(SID, 1))?.status).toBe(CycleStatus.Pending);

    // The gateway delivers it again: nothing changes.
    await h.scheduler.handleEvent(event);
    await h.scheduler.handleEvent(event);
    expect(await h.scheduler.get(SID)).toMatchObject({ paidCycles: 1, cycleIndex: 1 });
    expect(h.events.filter((e) => e.type === SchedulerEventType.ChargeSucceeded)).toHaveLength(1);
    expect(h.provider.createCalls).toHaveLength(1);
  });

  it('matches by the gateway charge id, and by the schedule id when the event has no subscription id', async () => {
    const h = makeHarness();
    const chargeId = await awaiting(h);
    // Learn the gateway id by reconciling once, then match on it alone.
    await h.tickAt(plusHours(DUE, 1));
    const cycle = await h.store.getCycle(SID, 0);
    expect(cycle?.providerChargeId).toBe(`pay_${chargeId}`);

    await h.scheduler.handleEvent(
      makeEvent({
        type: EventType.SubscriptionCharged,
        subscriptionId: 'sub_1',
        charge: { id: `pay_${chargeId}`, status: ChargeStatus.Succeeded },
      }),
    );
    expect((await h.store.getCycle(SID, 0))?.status).toBe(CycleStatus.Succeeded);
  });

  it('treats "charged" as collected even when the charge status still reads pending', async () => {
    const h = makeHarness();
    const chargeId = await awaiting(h);
    await h.scheduler.handleEvent(
      makeEvent({
        type: EventType.SubscriptionCharged,
        subscriptionId: 'sub_1',
        charge: { chargeId, status: ChargeStatus.Pending },
      }),
    );
    expect((await h.store.getCycle(SID, 0))?.status).toBe(CycleStatus.Succeeded);
  });

  it('subscription.charge_failed starts the next attempt under a new charge id', async () => {
    const h = makeHarness();
    const chargeId = await awaiting(h);
    h.clock.set(plusHours(DUE, 2));
    await h.scheduler.handleEvent(
      makeEvent({
        type: EventType.SubscriptionChargeFailed,
        subscriptionId: 'sub_1',
        charge: { chargeId, status: ChargeStatus.Failed },
      }),
    );
    const cycle = await h.store.getCycle(SID, 0);
    expect(cycle).toMatchObject({ status: CycleStatus.Pending, attempt: 2, attemptDueAt: plusHours(DUE, 26) });
    expect(cycle?.attempts[0]).toMatchObject({ attempt: 1, chargeId, status: ChargeStatus.Failed });

    // The next tick notifies for attempt 2 and, a day later, debits under a different id.
    await h.tickAt(plusHours(DUE, 2));
    await h.tickAt(plusHours(DUE, 26));
    expect(h.provider.createCalls).toHaveLength(2);
    expect(h.provider.createCalls[1]!.chargeId).not.toBe(chargeId);
  });

  it('ignores events for debits that are already settled or are not ours', async () => {
    const h = makeHarness();
    const chargeId = await awaiting(h);
    await h.scheduler.handleEvent(
      makeEvent({
        type: EventType.SubscriptionCharged,
        subscriptionId: 'sub_1',
        charge: { chargeId: 'chg_someone_else', status: ChargeStatus.Succeeded },
      }),
    );
    expect((await h.store.getCycle(SID, 0))?.status).toBe(CycleStatus.AwaitingConfirmation);

    await h.scheduler.handleEvent(makeEvent({ type: EventType.SubscriptionCharged, subscriptionId: 'unknown_sub', charge: { chargeId, status: ChargeStatus.Succeeded } }));
    await h.scheduler.handleEvent(makeEvent({ type: EventType.SubscriptionChargeScheduled, subscriptionId: 'sub_1' }));
    expect((await h.store.getCycle(SID, 0))?.status).toBe(CycleStatus.AwaitingConfirmation);
  });

  it('is safe to race with a tick that is in the middle of the debit', async () => {
    const h = makeHarness({ style: Style.OnDue });
    h.provider.createScript = [CreateBehaviour.Pending];
    h.provider.createDelayMs = 40;
    await h.scheduler.register(registration());
    h.clock.set(DUE);

    const tick = h.scheduler.tick();
    await sleep(10); // the tick now holds the lock, inside createCharge
    expect(h.provider.createCalls).toHaveLength(1);
    const chargeId = h.provider.createCalls[0]!.chargeId;
    const handled = h.scheduler.handleEvent(
      makeEvent({
        type: EventType.SubscriptionCharged,
        subscriptionId: 'sub_1',
        charge: { chargeId, status: ChargeStatus.Succeeded },
      }),
    );
    const [result] = await Promise.all([tick, handled]);

    expect(result.errors).toHaveLength(0);
    expect(h.provider.createCalls).toHaveLength(1);
    expect(await h.scheduler.get(SID)).toMatchObject({ paidCycles: 1, cycleIndex: 1 });
    expect((await h.store.getCycle(SID, 0))?.status).toBe(CycleStatus.Succeeded);
  });
});

describe('handleEvent: subscription lifecycle', () => {
  it('subscription.cancelled cancels the schedule and stops debits', async () => {
    const h = makeHarness();
    await h.scheduler.register(registration());
    await h.scheduler.handleEvent(makeEvent({ type: EventType.SubscriptionCancelled, subscriptionId: 'sub_1' }));
    expect(await h.scheduler.get(SID)).toMatchObject({
      status: ScheduleStatus.Cancelled,
      statusReason: ScheduleStatusReason.CancelledByGateway,
    });
    await h.tickAt(DUE);
    expect(h.provider.notifyCalls).toHaveLength(0);
    expect(h.provider.createCalls).toHaveLength(0);
    // Redelivery is harmless.
    await h.scheduler.handleEvent(makeEvent({ type: EventType.SubscriptionCancelled, subscriptionId: 'sub_1' }));
  });

  it('subscription.paused pauses and subscription.halted halts', async () => {
    const h = makeHarness();
    await h.scheduler.register(registration());
    await h.scheduler.handleEvent(makeEvent({ type: EventType.SubscriptionPaused, subscriptionId: 'sub_1' }));
    expect(await h.scheduler.get(SID)).toMatchObject({
      status: ScheduleStatus.Paused,
      statusReason: ScheduleStatusReason.PausedByGateway,
    });
    await h.scheduler.handleEvent(makeEvent({ type: EventType.SubscriptionHalted, subscriptionId: 'sub_1' }));
    expect(await h.scheduler.get(SID)).toMatchObject({
      status: ScheduleStatus.Halted,
      statusReason: ScheduleStatusReason.HaltedByGateway,
    });
    await h.tickAt(DUE);
    expect(h.provider.createCalls).toHaveLength(0);
  });

  it('subscription.expired cancels an active schedule', async () => {
    const h = makeHarness();
    await h.scheduler.register(registration());
    await h.scheduler.handleEvent(makeEvent({ type: EventType.SubscriptionExpired, subscriptionId: 'sub_1' }));
    expect(await h.scheduler.get(SID)).toMatchObject({
      status: ScheduleStatus.Cancelled,
      statusReason: ScheduleStatusReason.MandateExpired,
    });
  });

  it('a gateway cancellation with a debit in flight keeps reconciling it', async () => {
    const h = makeHarness();
    const chargeId = await awaiting(h);
    await h.scheduler.handleEvent(makeEvent({ type: EventType.SubscriptionCancelled, subscriptionId: 'sub_1' }));
    expect(h.events.some((e) => e.type === SchedulerEventType.ChargeInFlight && e.chargeId === chargeId)).toBe(true);
    await h.scheduler.handleEvent(
      makeEvent({ type: EventType.SubscriptionCharged, subscriptionId: 'sub_1', charge: { chargeId, status: ChargeStatus.Succeeded } }),
    );
    expect(await h.scheduler.get(SID)).toMatchObject({ status: ScheduleStatus.Cancelled, paidCycles: 1 });
  });

  it('ignores events for schedules it does not know and for other providers', async () => {
    const h = makeHarness();
    await h.scheduler.register(registration());
    await h.scheduler.handleEvent(makeEvent({ type: EventType.SubscriptionCancelled, subscriptionId: 'nobody' }));
    await h.scheduler.handleEvent({
      ...makeEvent({ type: EventType.SubscriptionCancelled, subscriptionId: 'sub_1' }),
      provider: Provider.Razorpay,
    });
    expect((await h.scheduler.get(SID))?.status).toBe(ScheduleStatus.Active);
  });
});
