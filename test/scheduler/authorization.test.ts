import { describe, expect, it } from 'vitest';
import { ChargeStatus, ErrorCode, EventType, Provider } from '../../src/constants.js';
import { CycleStatus, ScheduleStatus, ScheduleStatusReason, SchedulerEventType } from '../../src/scheduler/index.js';
import {
  CreateBehaviour,
  DUE,
  Style,
  T0,
  makeEvent,
  makeHarness,
  plusHours,
  registration,
  SID,
} from './helpers.js';

describe('schedules awaiting authorisation', () => {
  it('stores the schedule as pending_authorization and tick ignores it entirely', async () => {
    const h = makeHarness();
    const schedule = await h.scheduler.register(registration({ awaitingAuthorization: true }));
    expect(schedule.status).toBe(ScheduleStatus.PendingAuthorization);
    expect(schedule.nextActionAt).toBeUndefined();
    expect(schedule.nextChargeAt).toBeUndefined();
    expect(await h.scheduler.listCycles(SID)).toHaveLength(0);

    // Long past the due date, and past the notification time.
    for (const at of [plusHours(DUE, -48), DUE, plusHours(DUE, 24 * 60)]) {
      const result = await h.tickAt(at);
      expect(result.due).toBe(0);
    }
    expect(h.provider.notifyCalls).toHaveLength(0);
    expect(h.provider.createCalls).toHaveLength(0);
    expect(h.provider.getCalls).toHaveLength(0);
    expect((await h.scheduler.get(SID))?.status).toBe(ScheduleStatus.PendingAuthorization);
  });

  it('registering the same pending schedule twice is a no-op', async () => {
    const h = makeHarness();
    const first = await h.scheduler.register(registration({ awaitingAuthorization: true }));
    expect(await h.scheduler.register(registration({ awaitingAuthorization: true }))).toEqual(first);
    await expect(h.scheduler.register(registration())).rejects.toMatchObject({ code: ErrorCode.Conflict });
  });

  it('activate adopts a new subscription id and charges against it, keeping the schedule id', async () => {
    const h = makeHarness();
    h.provider.createScript = [CreateBehaviour.Pending];
    await h.scheduler.register(registration({ id: 'order_42', subscriptionId: 'ref_42', awaitingAuthorization: true }));

    const activated = await h.scheduler.activate('order_42', { subscriptionId: 'mandate_9' });
    expect(activated).toMatchObject({ id: 'order_42', subscriptionId: 'mandate_9', status: ScheduleStatus.Active });
    expect(activated.nextChargeAt).toBe(DUE);
    expect(await h.scheduler.findBySubscriptionId(Provider.PayU, 'mandate_9')).toEqual(activated);
    expect(await h.scheduler.findBySubscriptionId(Provider.PayU, 'ref_42')).toBeUndefined();
    expect(h.events.some((e) => e.type === SchedulerEventType.ScheduleActivated && e.subscriptionId === 'mandate_9')).toBe(true);

    await h.tickAt(plusHours(DUE, -48));
    await h.tickAt(DUE);
    await h.tickAt(plusHours(DUE, 1));
    expect(h.provider.notifyCalls.map((n) => n.subscriptionId)).toEqual(['mandate_9']);
    expect(h.provider.createCalls.map((c) => c.subscriptionId)).toEqual(['mandate_9']);
    expect(h.provider.getCalls.map((c) => c.subscriptionId)).toEqual(['mandate_9']);
  });

  it('anchors at the activation instant when the stored anchor is already past', async () => {
    const h = makeHarness({ startAt: T0 });
    await h.scheduler.register(registration({ awaitingAuthorization: true, firstChargeAt: plusHours(T0, 1) }));
    h.clock.set(plusHours(T0, 5));
    const activated = await h.scheduler.activate(SID);
    expect(activated.anchorAt).toBe(plusHours(T0, 5));
    expect(activated.nextChargeAt).toBe(plusHours(T0, 5));
    expect((await h.store.getCycle(SID, 0))?.dueAt).toBe(plusHours(T0, 5));
  });

  it('keeps a future anchor, and replaces it when firstChargeAt is given', async () => {
    const h = makeHarness();
    await h.scheduler.register(registration({ id: 'a', subscriptionId: 'a', awaitingAuthorization: true }));
    expect((await h.scheduler.activate('a')).anchorAt).toBe(DUE);

    await h.scheduler.register(registration({ id: 'b', subscriptionId: 'b', awaitingAuthorization: true }));
    const moved = await h.scheduler.activate('b', { firstChargeAt: '2026-03-01T10:00:00+05:30' });
    expect(moved.anchorAt).toBe('2026-03-01T04:30:00.000Z');
    expect((await h.store.getCycle('b', 0))?.dueAt).toBe('2026-03-01T04:30:00.000Z');
  });

  it('activating an active schedule with the same data is a no-op; different data or other statuses conflict', async () => {
    const h = makeHarness();
    await h.scheduler.register(registration({ awaitingAuthorization: true }));
    const first = await h.scheduler.activate(SID, { subscriptionId: 'mandate_1' });
    expect(await h.scheduler.activate(SID, { subscriptionId: 'mandate_1' })).toEqual(first);
    expect(await h.scheduler.activate(SID)).toEqual(first);
    await expect(h.scheduler.activate(SID, { subscriptionId: 'mandate_2' })).rejects.toMatchObject({
      code: ErrorCode.Conflict,
    });

    await h.scheduler.cancel(SID);
    await expect(h.scheduler.activate(SID)).rejects.toMatchObject({ code: ErrorCode.Conflict });
    await expect(h.scheduler.activate('missing')).rejects.toMatchObject({ code: ErrorCode.NotFound });
  });

  it('cancel works on a pending schedule', async () => {
    const h = makeHarness();
    await h.scheduler.register(registration({ awaitingAuthorization: true }));
    const cancelled = await h.scheduler.cancel(SID);
    expect(cancelled).toMatchObject({ status: ScheduleStatus.Cancelled, statusReason: ScheduleStatusReason.CancelledByMerchant });
    await expect(h.scheduler.activate(SID)).rejects.toMatchObject({ code: ErrorCode.Conflict });
    await expect(h.scheduler.pause(SID)).rejects.toMatchObject({ code: ErrorCode.Conflict });
  });

  it('pausing a pending schedule is a conflict', async () => {
    const h = makeHarness();
    await h.scheduler.register(registration({ awaitingAuthorization: true }));
    await expect(h.scheduler.pause(SID)).rejects.toMatchObject({ code: ErrorCode.Conflict });
  });
});

describe('authorisation via webhook events', () => {
  it('subscription.authorized activates a pending schedule and adopts the event subscription id', async () => {
    const h = makeHarness();
    await h.scheduler.register(registration({ id: 'order_42', subscriptionId: 'ref_42', awaitingAuthorization: true }));

    // PayU: the event carries the mandate id plus our reference.
    await h.scheduler.handleEvent(
      makeEvent({ type: EventType.SubscriptionAuthorized, subscriptionId: 'mandate_9', reference: 'order_42' }),
    );
    expect(await h.scheduler.get('order_42')).toMatchObject({
      status: ScheduleStatus.Active,
      subscriptionId: 'mandate_9',
      id: 'order_42',
    });

    // A duplicate delivery changes nothing.
    const before = await h.scheduler.get('order_42');
    await h.scheduler.handleEvent(
      makeEvent({ type: EventType.SubscriptionAuthorized, subscriptionId: 'mandate_9', reference: 'order_42' }),
    );
    expect(await h.scheduler.get('order_42')).toEqual(before);
    expect(h.events.filter((e) => e.type === SchedulerEventType.ScheduleActivated)).toHaveLength(1);
  });

  it('subscription.activated matches by the stored subscription id or by schedule id', async () => {
    const h = makeHarness();
    await h.scheduler.register(registration({ id: 'a', subscriptionId: 'sub_a', awaitingAuthorization: true }));
    await h.scheduler.handleEvent(makeEvent({ type: EventType.SubscriptionActivated, subscriptionId: 'sub_a' }));
    expect((await h.scheduler.get('a'))?.status).toBe(ScheduleStatus.Active);

    await h.scheduler.register(registration({ id: 'b', subscriptionId: 'sub_b', awaitingAuthorization: true }));
    await h.scheduler.handleEvent(makeEvent({ type: EventType.SubscriptionActivated, subscriptionId: 'b' }));
    expect(await h.scheduler.get('b')).toMatchObject({ status: ScheduleStatus.Active, subscriptionId: 'b' });
  });

  it('then bills normally against the adopted id', async () => {
    const h = makeHarness({ style: Style.OnDue });
    await h.scheduler.register(registration({ id: 'order_42', subscriptionId: 'ref_42', awaitingAuthorization: true }));
    await h.scheduler.handleEvent(
      makeEvent({ type: EventType.SubscriptionAuthorized, subscriptionId: 'mandate_9', reference: 'order_42' }),
    );
    await h.tickAt(DUE);
    expect(h.provider.createCalls.map((c) => c.subscriptionId)).toEqual(['mandate_9']);
    expect((await h.store.getCycle('order_42', 0))?.status).toBe(CycleStatus.Succeeded);
  });

  it('authorization_failed and expired cancel a pending schedule', async () => {
    const h = makeHarness();
    await h.scheduler.register(registration({ id: 'a', subscriptionId: 'a', awaitingAuthorization: true }));
    await h.scheduler.handleEvent(makeEvent({ type: EventType.SubscriptionAuthorizationFailed, subscriptionId: 'a' }));
    expect(await h.scheduler.get('a')).toMatchObject({
      status: ScheduleStatus.Cancelled,
      statusReason: ScheduleStatusReason.AuthorizationFailed,
    });

    await h.scheduler.register(registration({ id: 'b', subscriptionId: 'b', awaitingAuthorization: true }));
    await h.scheduler.handleEvent(makeEvent({ type: EventType.SubscriptionExpired, subscriptionId: 'b' }));
    expect((await h.scheduler.get('b'))?.status).toBe(ScheduleStatus.Cancelled);
  });

  it('a charge event never activates a pending schedule', async () => {
    const h = makeHarness();
    await h.scheduler.register(registration({ awaitingAuthorization: true }));
    await h.scheduler.handleEvent(
      makeEvent({ type: EventType.SubscriptionCharged, subscriptionId: 'sub_1', charge: { chargeId: 'x', status: ChargeStatus.Succeeded } }),
    );
    expect((await h.scheduler.get(SID))?.status).toBe(ScheduleStatus.PendingAuthorization);
  });
});

describe('authorisation timeout', () => {
  it('cancels a schedule still pending after authorizationTimeoutHours, and emits an event', async () => {
    const h = makeHarness();
    const schedule = await h.scheduler.register(registration({ awaitingAuthorization: true, authorizationTimeoutHours: 24 }));
    expect(schedule.nextActionAt).toBe(plusHours(T0, 24));

    const early = await h.tickAt(plusHours(T0, 23.99));
    expect(early.due).toBe(0);
    expect((await h.scheduler.get(SID))?.status).toBe(ScheduleStatus.PendingAuthorization);

    const expired = await h.tickAt(plusHours(T0, 24));
    expect(expired.expired).toBe(1);
    expect(await h.scheduler.get(SID)).toMatchObject({
      status: ScheduleStatus.Cancelled,
      statusReason: ScheduleStatusReason.AuthorizationTimeout,
    });
    expect(
      h.events.some(
        (e) => e.type === SchedulerEventType.ScheduleCancelled && e.reason === ScheduleStatusReason.AuthorizationTimeout,
      ),
    ).toBe(true);
    expect(h.provider.createCalls).toHaveLength(0);
    // A cancelled schedule is not touched again.
    expect((await h.tickAt(plusHours(T0, 48))).due).toBe(0);
  });

  it('can be set for every schedule on the scheduler', async () => {
    const h = makeHarness({ scheduler: { authorizationTimeoutHours: 1 } });
    await h.scheduler.register(registration({ awaitingAuthorization: true }));
    await h.tickAt(plusHours(T0, 1));
    expect((await h.scheduler.get(SID))?.status).toBe(ScheduleStatus.Cancelled);
  });

  it('does not expire a schedule that was activated in time', async () => {
    const h = makeHarness();
    await h.scheduler.register(registration({ awaitingAuthorization: true, authorizationTimeoutHours: 24 }));
    h.clock.set(plusHours(T0, 2));
    await h.scheduler.activate(SID);
    await h.tickAt(plusHours(T0, 30));
    expect((await h.scheduler.get(SID))?.status).toBe(ScheduleStatus.Active);
  });

  it('has no timeout by default', async () => {
    const h = makeHarness();
    await h.scheduler.register(registration({ awaitingAuthorization: true }));
    await h.tickAt(plusHours(T0, 24 * 365));
    expect((await h.scheduler.get(SID))?.status).toBe(ScheduleStatus.PendingAuthorization);
  });
});
