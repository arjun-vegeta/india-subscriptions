import { describe, expect, it } from 'vitest';
import { ErrorCode, EventType, Provider } from '../../src/constants.js';
import {
  CycleStatus,
  ScheduleStatus,
  ScheduleStatusReason,
  SchedulerEventType,
  scheduleIdFor,
} from '../../src/scheduler/index.js';
import { CreateBehaviour, DUE, SID, Style, T0, makeEvent, makeHarness, plusHours, registration } from './helpers.js';

const DAY = 24;
const FEB = '2026-02-15T04:30:00.000Z';
const MAR = '2026-03-15T04:30:00.000Z';
const onDue = (options: Parameters<typeof makeHarness>[0] = {}) => makeHarness({ style: Style.OnDue, ...options });

describe('find: one provider-scoped lookup', () => {
  it('finds by reference, by gateway subscription id, in any order, and only for the schedule\'s own provider', async () => {
    const h = makeHarness();
    const schedule = await h.scheduler.register(registration({ subscriptionId: 'sub_9', reference: 'ref_9' }));
    expect(schedule.id).toBe(scheduleIdFor(Provider.PayU, 'ref_9'));
    expect((await h.scheduler.find(Provider.PayU, 'ref_9'))?.id).toBe(schedule.id);
    expect((await h.scheduler.find(Provider.PayU, 'sub_9'))?.id).toBe(schedule.id);
    expect((await h.scheduler.find(Provider.PayU, undefined, 'nope', 'sub_9'))?.id).toBe(schedule.id);
    expect(await h.scheduler.find(Provider.PayU)).toBeUndefined();
    expect(await h.scheduler.find(Provider.Cashfree, 'ref_9')).toBeUndefined();
    expect(await h.scheduler.find(Provider.Cashfree, 'sub_9')).toBeUndefined();
    // Even the schedule's raw id, as a bare key, is only found for its own provider.
    expect(await h.scheduler.find(Provider.Cashfree, schedule.id)).toBeUndefined();
    expect((await h.scheduler.find(Provider.PayU, schedule.id))?.id).toBe(schedule.id);
  });

  it('two providers can use the same reference without colliding', async () => {
    const h = makeHarness();
    await h.scheduler.register(registration({ reference: 'shared' }));
    const other = makeHarness({ store: h.store });
    // Same store, a second gateway name: the ids differ because the provider is part of them.
    expect(scheduleIdFor(Provider.Cashfree, 'shared')).not.toBe(scheduleIdFor(Provider.PayU, 'shared'));
    expect(other.store).toBe(h.store);
  });

  it('webhook events only reach the schedule of their own provider', async () => {
    const h = makeHarness();
    await h.scheduler.register(registration({ awaitingAuthorization: true }));
    const foreign = { ...makeEvent({ type: EventType.SubscriptionAuthorized, subscriptionId: 'sub_1' }), provider: Provider.Cashfree };
    await h.scheduler.handleEvent(foreign);
    expect((await h.scheduler.get(SID))?.status).toBe(ScheduleStatus.PendingAuthorization);
  });
});

describe('pause with resumeAt', () => {
  it('resumes by itself on the first tick at or after resumeAt, then bills; nothing is billed before', async () => {
    const h = onDue();
    await h.scheduler.register(registration());
    const resumeAt = plusHours(DUE, 2 * DAY);
    await h.scheduler.pause(SID, { resumeAt });
    expect((await h.scheduler.get(SID))?.resumeAt).toBe(resumeAt);

    expect(await h.tickAt(DUE)).toMatchObject({ charged: 0 });
    expect(await h.tickAt(plusHours(DUE, DAY))).toMatchObject({ charged: 0 });
    expect((await h.scheduler.get(SID))?.status).toBe(ScheduleStatus.Paused);

    const resumed = await h.tickAt(resumeAt);
    expect(resumed).toMatchObject({ charged: 1, succeeded: 1 });
    const schedule = await h.scheduler.get(SID);
    expect(schedule?.status).toBe(ScheduleStatus.Active);
    expect(schedule?.resumeAt).toBeUndefined();
    expect(h.events.filter((e) => e.type === SchedulerEventType.ScheduleResumed)).toHaveLength(1);
  });

  it('does not bill the cycles that fell due while paused (one debit, not several)', async () => {
    const h = onDue();
    await h.scheduler.register(registration());
    const resumeAt = plusHours(FEB, 3 * DAY);
    await h.scheduler.pause(SID, { resumeAt });
    await h.tickAt(plusHours(FEB, DAY));
    await h.tickAt(resumeAt);
    expect(h.provider.createCalls).toHaveLength(1);
  });

  it('refuses a resumeAt in the past, and a manual resume clears it', async () => {
    const h = onDue();
    await h.scheduler.register(registration());
    await expect(h.scheduler.pause(SID, { resumeAt: plusHours(T0, -1) })).rejects.toMatchObject({ code: ErrorCode.Validation });
    expect((await h.scheduler.get(SID))?.status).toBe(ScheduleStatus.Active);
    await h.scheduler.pause(SID, { resumeAt: plusHours(DUE, 5 * DAY) });
    await h.scheduler.resume(SID);
    expect((await h.scheduler.get(SID))?.resumeAt).toBeUndefined();
  });

  it('pausing an already paused schedule replaces resumeAt', async () => {
    const h = onDue();
    await h.scheduler.register(registration());
    await h.scheduler.pause(SID);
    expect((await h.scheduler.get(SID))?.resumeAt).toBeUndefined();
    const resumeAt = plusHours(DUE, DAY);
    await h.scheduler.pause(SID, { resumeAt });
    expect((await h.scheduler.get(SID))?.resumeAt).toBe(resumeAt);
    expect((await h.scheduler.get(SID))?.nextActionAt).toBe(resumeAt);
  });
});

describe('update', () => {
  it('nextChargeAt moves the first debit and the first-charge instant', async () => {
    const h = onDue();
    await h.scheduler.register(registration());
    const moved = plusHours(DUE, 10 * DAY);
    const updated = await h.scheduler.update(SID, { nextChargeAt: moved });
    expect(updated).toMatchObject({ firstChargeAt: moved, anchorAt: moved, nextChargeAt: moved });
    expect(await h.tickAt(DUE)).toMatchObject({ charged: 0 });
    expect(await h.tickAt(moved)).toMatchObject({ charged: 1, succeeded: 1 });
  });

  it('nextChargeAt after a pre-debit notice redoes the notice for the new date', async () => {
    const h = makeHarness();
    await h.scheduler.register(registration());
    await h.tickAt(plusHours(DUE, -48));
    expect(h.provider.notifyCalls).toHaveLength(1);
    const moved = plusHours(DUE, 5 * DAY);
    await h.scheduler.update(SID, { nextChargeAt: moved });
    expect((await h.store.getCycle(SID, 0))?.status).toBe(CycleStatus.Pending);
    await h.tickAt(plusHours(DUE, 3 * DAY));
    expect(h.provider.notifyCalls).toHaveLength(2);
    expect(h.provider.notifyCalls[1]?.debitAt).toBe(moved);
    await h.tickAt(plusHours(moved, -1));
    expect(h.provider.createCalls).toHaveLength(0);
    await h.tickAt(moved);
    expect(h.provider.createCalls).toHaveLength(1);
  });

  it('nextChargeAt while a debit is in flight moves the cycle after it', async () => {
    const h = onDue();
    h.provider.createScript = [CreateBehaviour.Pending];
    await h.scheduler.register(registration({ totalCycles: 3 }));
    await h.tickAt(DUE);
    expect((await h.store.getCycle(SID, 0))?.status).toBe(CycleStatus.AwaitingConfirmation);
    const moved = plusHours(FEB, 7 * DAY);
    await h.scheduler.update(SID, { nextChargeAt: moved });
    const schedule = await h.scheduler.get(SID);
    expect(schedule).toMatchObject({ anchorAt: moved, anchorIndex: 1, firstChargeAt: DUE });
    h.provider.settle((await h.store.getCycle(SID, 0))!.chargeId!, 'succeeded');
    await h.tickAt(plusHours(DUE, 1));
    expect((await h.store.getCycle(SID, 1))?.dueAt).toBe(moved);
  });

  it('remainingCycles counts the current cycle: the schedule completes after exactly that many more debits', async () => {
    const h = onDue();
    await h.scheduler.register(registration({ totalCycles: 6 }));
    await h.tickAt(DUE);
    expect((await h.scheduler.get(SID))?.paidCycles).toBe(1);
    const updated = await h.scheduler.update(SID, { remainingCycles: 2 });
    expect(updated.totalCycles).toBe(3);
    await h.tickAt(FEB);
    const last = await h.tickAt(MAR);
    expect(last.completed).toBe(1);
    expect((await h.scheduler.get(SID))).toMatchObject({ status: ScheduleStatus.Completed, paidCycles: 3 });
    expect(h.provider.createCalls).toHaveLength(3);
  });

  it('mandateEndsAt before the next due date completes the schedule at once, with a named reason', async () => {
    const h = onDue();
    await h.scheduler.register(registration());
    await h.tickAt(DUE);
    const updated = await h.scheduler.update(SID, { mandateEndsAt: plusHours(FEB, -DAY) });
    expect(updated).toMatchObject({ status: ScheduleStatus.Completed, statusReason: ScheduleStatusReason.MandateEnded });
    expect((await h.store.getCycle(SID, 1))?.status).toBe(CycleStatus.Skipped);
    await h.tickAt(FEB);
    expect(h.provider.createCalls).toHaveLength(1);
  });

  it('amount, with updateAmount as an alias', async () => {
    const h = onDue();
    await h.scheduler.register(registration());
    expect((await h.scheduler.update(SID, { amount: 59900 })).amount).toBe(59900);
    expect((await h.scheduler.updateAmount(SID, 69900)).amount).toBe(69900);
    await h.tickAt(DUE);
    expect(h.provider.createCalls[0]?.amount).toBe(69900);
  });

  it('applies several fields together or fails without applying any', async () => {
    const h = onDue();
    await h.scheduler.register(registration({ totalCycles: 5 }));
    const moved = plusHours(DUE, 3 * DAY);
    const updated = await h.scheduler.update(SID, { amount: 1000, nextChargeAt: moved, remainingCycles: 2 });
    expect(updated).toMatchObject({ amount: 1000, anchorAt: moved, totalCycles: 2 });
    await expect(h.scheduler.update(SID, {})).rejects.toMatchObject({ code: ErrorCode.Validation });
    await expect(h.scheduler.update(SID, { amount: 0 })).rejects.toMatchObject({ code: ErrorCode.Validation });
  });

  it('refuses a cancelled or completed schedule with CONFLICT', async () => {
    const h = onDue();
    await h.scheduler.register(registration());
    await h.scheduler.cancel(SID);
    await expect(h.scheduler.update(SID, { amount: 100 })).rejects.toMatchObject({ code: ErrorCode.Conflict });
    await expect(h.scheduler.update(SID, { nextChargeAt: DUE })).rejects.toMatchObject({ code: ErrorCode.Conflict });
  });

  it('works on a schedule that still awaits authorisation', async () => {
    const h = onDue();
    await h.scheduler.register(registration({ awaitingAuthorization: true }));
    const moved = plusHours(DUE, DAY);
    const updated = await h.scheduler.update(SID, { amount: 1234, nextChargeAt: moved });
    expect(updated).toMatchObject({ status: ScheduleStatus.PendingAuthorization, amount: 1234, firstChargeAt: moved });
    await h.scheduler.activate(SID);
    await h.tickAt(moved);
    expect(h.provider.createCalls[0]?.amount).toBe(1234);
  });
});

describe('mandate end date', () => {
  it('never notifies or debits for a due date on or after it, and completes with MandateEnded', async () => {
    const h = makeHarness();
    await h.scheduler.register(registration({ mandateEndsAt: plusHours(FEB, 10 * DAY) }));
    for (const due of [DUE, FEB]) {
      await h.tickAt(plusHours(due, -48));
      await h.tickAt(due);
    }
    expect(h.provider.createCalls).toHaveLength(2);
    // The moment the second debit lands the next due date (15 Mar) is known to be beyond the mandate.
    expect(await h.scheduler.get(SID)).toMatchObject({
      status: ScheduleStatus.Completed,
      statusReason: ScheduleStatusReason.MandateEnded,
      paidCycles: 2,
    });
    expect((await h.scheduler.get(SID))?.nextActionAt).toBeUndefined();
    expect((await h.tickAt(plusHours(MAR, -48))).notified).toBe(0);
    await h.tickAt(MAR);
    expect(h.provider.notifyCalls).toHaveLength(2);
    expect(h.provider.createCalls).toHaveLength(2);
  });

  it('a due date exactly on the end date is not billed', async () => {
    const h = onDue();
    await h.scheduler.register(registration({ mandateEndsAt: FEB }));
    await h.tickAt(DUE);
    expect(h.events.some((e) => e.type === SchedulerEventType.ScheduleCompleted && e.reason === ScheduleStatusReason.MandateEnded)).toBe(true);
    await h.tickAt(FEB);
    expect(h.provider.createCalls).toHaveLength(1);
  });

  it('must be after the first charge', async () => {
    const h = onDue();
    await expect(h.scheduler.register(registration({ mandateEndsAt: DUE }))).rejects.toMatchObject({ code: ErrorCode.Validation });
  });

  it('a customer who authorises after the mandate would already have ended is not billed', async () => {
    const h = onDue();
    await h.scheduler.register(registration({ awaitingAuthorization: true, mandateEndsAt: plusHours(DUE, DAY) }));
    h.clock.set(plusHours(DUE, 2 * DAY));
    const schedule = await h.scheduler.activate(SID);
    expect(schedule).toMatchObject({ status: ScheduleStatus.Completed, statusReason: ScheduleStatusReason.MandateEnded });
    await h.tickAt(plusHours(DUE, 3 * DAY));
    expect(h.provider.createCalls).toHaveLength(0);
  });

  it('is part of what registering the same schedule again must match', async () => {
    const h = onDue();
    await h.scheduler.register(registration({ mandateEndsAt: plusHours(DUE, 60 * DAY) }));
    await expect(h.scheduler.register(registration({ mandateEndsAt: plusHours(DUE, 90 * DAY) }))).rejects.toMatchObject({
      code: ErrorCode.Conflict,
    });
  });
});

describe('late authorisation revives a schedule cancelled by the authorisation timeout', () => {
  const timeout = { authorizationTimeoutHours: 24 };

  it('activate revives it and bills normally', async () => {
    const h = onDue({ scheduler: timeout });
    await h.scheduler.register(registration({ awaitingAuthorization: true }));
    expect(await h.tickAt(plusHours(T0, 25))).toMatchObject({ expired: 1 });
    expect((await h.scheduler.get(SID))?.statusReason).toBe(ScheduleStatusReason.AuthorizationTimeout);

    h.clock.set(plusHours(T0, 30));
    const revived = await h.scheduler.activate(SID, { subscriptionId: 'sub_new' });
    expect(revived).toMatchObject({ status: ScheduleStatus.Active, subscriptionId: 'sub_new' });
    expect(revived.statusReason).toBeUndefined();
    expect(revived.endedAt).toBeUndefined();
    await h.tickAt(DUE);
    expect(h.provider.createCalls[0]).toMatchObject({ subscriptionId: 'sub_new' });
    expect((await h.scheduler.get(SID))?.paidCycles).toBe(1);
  });

  it('an authorisation webhook revives it too', async () => {
    const h = onDue({ scheduler: timeout });
    await h.scheduler.register(registration({ awaitingAuthorization: true }));
    await h.tickAt(plusHours(T0, 25));
    await h.scheduler.handleEvent(makeEvent({ type: EventType.SubscriptionActivated, subscriptionId: 'sub_1' }));
    expect((await h.scheduler.get(SID))?.status).toBe(ScheduleStatus.Active);
  });

  it('a schedule cancelled for any other reason is not revived', async () => {
    const h = onDue();
    await h.scheduler.register(registration({ awaitingAuthorization: true }));
    await h.scheduler.cancel(SID);
    await expect(h.scheduler.activate(SID)).rejects.toMatchObject({ code: ErrorCode.Conflict });
    await h.scheduler.handleEvent(makeEvent({ type: EventType.SubscriptionAuthorized, subscriptionId: 'sub_1' }));
    expect((await h.scheduler.get(SID))?.status).toBe(ScheduleStatus.Cancelled);

    const failed = onDue();
    await failed.scheduler.register(registration({ awaitingAuthorization: true }));
    await failed.scheduler.handleEvent(makeEvent({ type: EventType.SubscriptionAuthorizationFailed, subscriptionId: 'sub_1' }));
    await failed.scheduler.handleEvent(makeEvent({ type: EventType.SubscriptionAuthorized, subscriptionId: 'sub_1' }));
    expect((await failed.scheduler.get(SID))?.statusReason).toBe(ScheduleStatusReason.AuthorizationFailed);
    expect((await failed.scheduler.get(SID))?.status).toBe(ScheduleStatus.Cancelled);
  });

  it('cancel can say why', async () => {
    const h = onDue();
    await h.scheduler.register(registration());
    const cancelled = await h.scheduler.cancel(SID, { reason: ScheduleStatusReason.CancelledByGateway });
    expect(cancelled.statusReason).toBe(ScheduleStatusReason.CancelledByGateway);
  });
});

describe('facts the status overlay reads: first charge, retrying, last failure', () => {
  it('records the first-charge instant at registration and moves it with a late activation', async () => {
    const h = onDue();
    const registered = await h.scheduler.register(registration({ awaitingAuthorization: true }));
    expect(registered.firstChargeAt).toBe(DUE);
    h.clock.set(plusHours(DUE, DAY));
    const activated = await h.scheduler.activate(SID);
    expect(activated.firstChargeAt).toBe(plusHours(DUE, DAY));
  });

  it('retrying and lastFailure follow a failed attempt, and clear when the cycle is finally paid', async () => {
    const h = onDue();
    h.provider.createScript = [CreateBehaviour.Fail, CreateBehaviour.Succeed];
    await h.scheduler.register(registration());
    expect(await h.scheduler.get(SID)).toMatchObject({ retrying: false });

    await h.tickAt(DUE);
    const failing = await h.scheduler.get(SID);
    expect(failing?.retrying).toBe(true);
    expect(failing?.lastFailure).toMatchObject({ code: 'INSUFFICIENT_FUNDS', reason: 'Insufficient funds', at: DUE });
    expect(failing?.status).toBe(ScheduleStatus.Active);

    await h.tickAt(plusHours(DUE, 24));
    const paid = await h.scheduler.get(SID);
    expect(paid).toMatchObject({ retrying: false, paidCycles: 1 });
    expect(paid?.lastFailure).toBeUndefined();
  });

  it('a halted schedule keeps its last failure', async () => {
    const h = onDue();
    h.provider.createScript = [CreateBehaviour.Fail, CreateBehaviour.Fail, CreateBehaviour.Fail];
    await h.scheduler.register(registration());
    for (const hours of [0, 24, 48]) await h.tickAt(plusHours(DUE, hours));
    const halted = await h.scheduler.get(SID);
    expect(halted?.status).toBe(ScheduleStatus.Halted);
    expect(halted?.lastFailure?.at).toBe(plusHours(DUE, 48));
  });

  it('re-anchoring the first cycle on resume moves the first-charge instant', async () => {
    const h = onDue();
    await h.scheduler.register(registration());
    await h.scheduler.pause(SID);
    const moved = plusHours(DUE, 4 * DAY);
    const resumed = await h.scheduler.resume(SID, { nextChargeAt: moved });
    expect(resumed.firstChargeAt).toBe(moved);
  });
});
