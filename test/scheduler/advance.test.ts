import { describe, expect, it } from 'vitest';
import { ChargeStatus, EventType } from '../../src/constants.js';
import { CycleStatus, ScheduleStatus, SchedulerEventType } from '../../src/scheduler/index.js';
import { CreateBehaviour, DUE, Style, T0, makeEvent, makeHarness, plusHours, registration } from './helpers.js';

/**
 * Style B (Cashfree on-demand): the charge must be raised `leadHours` before the
 * debit with a `scheduledAt`; the gateway notifies the customer and debits on that date.
 */
const advance = (overrides: Parameters<typeof makeHarness>[0] = {}) =>
  makeHarness({ style: Style.Advance, leadHours: 24, maxAheadHours: 14 * 24, ...overrides });

describe('charge raised in advance (Cashfree on-demand style)', () => {
  it('creates the charge leadHours before the due date with scheduledAt = dueAt, and sends no notification', async () => {
    const h = advance();
    h.provider.createScript = [CreateBehaviour.Scheduled];
    await h.scheduler.register(registration());

    expect((await h.tickAt(plusHours(DUE, -24.001))).charged).toBe(0);
    expect(h.provider.createCalls).toHaveLength(0);

    const result = await h.tickAt(plusHours(DUE, -24));
    expect(result.charged).toBe(1);
    expect(result.awaiting).toBe(1);
    expect(h.provider.notifyCalls).toHaveLength(0);
    expect(h.provider.createCalls).toHaveLength(1);
    expect(h.provider.createCalls[0]).toMatchObject({ subscriptionId: 'sub_1', amount: 49900, scheduledAt: DUE });

    const cycle = await h.store.getCycle('sub_1', 0);
    expect(cycle).toMatchObject({
      status: CycleStatus.AwaitingConfirmation,
      dueAt: DUE,
      attemptDueAt: DUE,
      scheduledAt: DUE,
    });
    // The next debit date still reads as the due date while the charge waits at the gateway.
    expect((await h.scheduler.get('sub_1'))?.nextChargeAt).toBe(DUE);
  });

  it('pushes scheduledAt to now + lead when activated too late to make the due date', async () => {
    const lateStart = plusHours(DUE, -10);
    const h = advance({ startAt: lateStart });
    h.provider.createScript = [CreateBehaviour.Scheduled];
    await h.scheduler.register(registration());

    await h.tickAt(lateStart);
    expect(h.provider.createCalls).toHaveLength(1);
    expect(h.provider.createCalls[0]!.scheduledAt).toBe(plusHours(lateStart, 24));

    const cycle = await h.store.getCycle('sub_1', 0);
    // The contractual date is unchanged; the actual debit date is recorded separately.
    expect(cycle).toMatchObject({ dueAt: DUE, scheduledAt: plusHours(lateStart, 24) });
  });

  it('honours a larger per-schedule chargeLeadHours', async () => {
    const h = advance();
    await h.scheduler.register(registration({ chargeLeadHours: 48 }));
    expect((await h.tickAt(plusHours(DUE, -48.001))).charged).toBe(0);
    await h.tickAt(plusHours(DUE, -48));
    expect(h.provider.createCalls[0]!.scheduledAt).toBe(DUE);
  });

  it('does not poll getCharge before scheduledAt, then reconciles from the due date on', async () => {
    const h = advance();
    h.provider.createScript = [CreateBehaviour.Scheduled];
    await h.scheduler.register(registration());
    await h.tickAt(plusHours(DUE, -24));

    for (const at of [plusHours(DUE, -23), plusHours(DUE, -1), plusHours(DUE, -0.001)]) {
      const result = await h.tickAt(at);
      expect(result.due).toBe(0);
    }
    expect(h.provider.getCalls).toHaveLength(0);
    expect((await h.scheduler.get('sub_1'))?.nextActionAt).toBe(DUE);

    // On the debit date the gateway still says scheduled: ask again later, never re-charge.
    const onDue = await h.tickAt(DUE);
    expect(onDue.reconciled).toBe(1);
    expect(h.provider.getCalls).toHaveLength(1);

    h.provider.settle(h.provider.createCalls[0]!.chargeId, ChargeStatus.Succeeded);
    const done = await h.tickAt(plusHours(DUE, 1));
    expect(done.succeeded).toBe(1);
    expect(h.provider.createCalls).toHaveLength(1);
    expect(await h.scheduler.get('sub_1')).toMatchObject({ paidCycles: 1, nextChargeAt: '2026-02-15T04:30:00.000Z' });

    // The next cycle is raised a day ahead of its own due date.
    await h.tickAt('2026-02-14T04:30:00.000Z');
    expect(h.provider.createCalls).toHaveLength(2);
    expect(h.provider.createCalls[1]!.scheduledAt).toBe('2026-02-15T04:30:00.000Z');
  });

  it('settles via subscription.charged without any polling', async () => {
    const h = advance();
    h.provider.createScript = [CreateBehaviour.Scheduled];
    await h.scheduler.register(registration());
    await h.tickAt(plusHours(DUE, -24));
    const chargeId = h.provider.createCalls[0]!.chargeId;

    await h.scheduler.handleEvent(
      makeEvent({ type: EventType.SubscriptionCharged, subscriptionId: 'sub_1', charge: { chargeId, status: ChargeStatus.Succeeded } }),
    );
    expect(await h.scheduler.get('sub_1')).toMatchObject({ paidCycles: 1, cycleIndex: 1 });
    expect(h.provider.getCalls).toHaveLength(0);
    expect((await h.store.getCycle('sub_1', 1))?.status).toBe(CycleStatus.Pending);
  });

  it('retries after subscription.charge_failed with a new attempt id and scheduledAt = now + lead', async () => {
    const h = advance();
    h.provider.createScript = [CreateBehaviour.Scheduled];
    await h.scheduler.register(registration());
    await h.tickAt(plusHours(DUE, -24));
    const first = h.provider.createCalls[0]!.chargeId;

    const failedAt = plusHours(DUE, 1);
    h.clock.set(failedAt);
    await h.scheduler.handleEvent(
      makeEvent({ type: EventType.SubscriptionChargeFailed, subscriptionId: 'sub_1', charge: { chargeId: first, status: ChargeStatus.Failed } }),
    );
    expect((await h.store.getCycle('sub_1', 0))).toMatchObject({ status: CycleStatus.Pending, attempt: 2 });

    await h.tickAt(failedAt);
    expect(h.provider.createCalls).toHaveLength(2);
    expect(h.provider.createCalls[1]!.chargeId).not.toBe(first);
    expect(h.provider.createCalls[1]!.scheduledAt).toBe(plusHours(failedAt, 24));
    expect((await h.store.getCycle('sub_1', 0))).toMatchObject({ attempt: 2, dueAt: DUE, scheduledAt: plusHours(failedAt, 24) });
  });

  it('retries a charge the gateway fails when asked, through createCharge again', async () => {
    const h = advance();
    h.provider.createScript = [CreateBehaviour.Scheduled];
    await h.scheduler.register(registration());
    await h.tickAt(plusHours(DUE, -24));
    h.provider.settle(h.provider.createCalls[0]!.chargeId, ChargeStatus.Failed);

    const result = await h.tickAt(DUE);
    expect(result.failed).toBe(1);
    // Failure detected on the due date: attempt 2 goes straight out, scheduled a lead time later.
    expect(h.provider.createCalls).toHaveLength(2);
    expect(h.provider.createCalls[1]!.scheduledAt).toBe(plusHours(DUE, 24));
    expect(h.provider.notifyCalls).toHaveLength(0);
  });

  it('halts after maxAttempts failures', async () => {
    const h = advance({ scheduler: { maxAttempts: 2 } });
    h.provider.createScript = [CreateBehaviour.Fail, CreateBehaviour.Fail];
    await h.scheduler.register(registration());
    await h.tickAt(plusHours(DUE, -24));
    expect(h.provider.createCalls).toHaveLength(2);
    expect((await h.scheduler.get('sub_1'))?.status).toBe(ScheduleStatus.Halted);
  });

  it('keeps the in-flight charge when the schedule is cancelled, announces it, and records its outcome', async () => {
    const h = advance();
    h.provider.createScript = [CreateBehaviour.Scheduled];
    await h.scheduler.register(registration());
    await h.tickAt(plusHours(DUE, -24));
    const chargeId = h.provider.createCalls[0]!.chargeId;

    const cancelled = await h.scheduler.cancel('sub_1');
    expect(cancelled.status).toBe(ScheduleStatus.Cancelled);
    expect(cancelled.nextActionAt).toBe(DUE); // still has a debit to look at
    const inFlight = h.events.find((e) => e.type === SchedulerEventType.ChargeInFlight);
    expect(inFlight).toMatchObject({ scheduleId: 'sub_1', chargeId, cycleIndex: 0 });
    expect((await h.store.getCycle('sub_1', 0))?.status).toBe(CycleStatus.AwaitingConfirmation);

    // Nothing is polled early, nothing new is raised.
    await h.tickAt(plusHours(DUE, -1));
    expect(h.provider.getCalls).toHaveLength(0);

    // The gateway debited anyway: the outcome is recorded, no further cycle is created.
    h.provider.settle(chargeId, ChargeStatus.Succeeded);
    await h.tickAt(DUE);
    expect(h.provider.getCalls).toHaveLength(1);
    expect(await h.scheduler.get('sub_1')).toMatchObject({ status: ScheduleStatus.Cancelled, paidCycles: 1 });
    expect(h.events.some((e) => e.type === SchedulerEventType.ChargeSucceeded)).toBe(true);
    expect(await h.scheduler.listCycles('sub_1')).toHaveLength(1);
    expect(h.provider.createCalls).toHaveLength(1);
  });

  it('keeps the in-flight charge when the schedule is paused', async () => {
    const h = advance();
    h.provider.createScript = [CreateBehaviour.Scheduled];
    await h.scheduler.register(registration());
    await h.tickAt(plusHours(DUE, -24));
    const paused = await h.scheduler.pause('sub_1');
    expect(paused.status).toBe(ScheduleStatus.Paused);
    expect(h.events.some((e) => e.type === SchedulerEventType.ChargeInFlight)).toBe(true);

    h.provider.settle(h.provider.createCalls[0]!.chargeId, ChargeStatus.Succeeded);
    await h.tickAt(DUE);
    // Recorded, and the pointer moved on without creating a new cycle while paused.
    expect(await h.scheduler.get('sub_1')).toMatchObject({ status: ScheduleStatus.Paused, paidCycles: 1, cycleIndex: 1 });
    expect(await h.scheduler.listCycles('sub_1')).toHaveLength(1);
  });

  it('after a lost answer re-creates with the same charge id and never a date that is now too close', async () => {
    const h = advance();
    h.provider.createScript = [CreateBehaviour.UnknownLost];
    await h.scheduler.register(registration());
    await h.tickAt(plusHours(DUE, -24));
    const first = h.provider.createCalls[0]!;
    expect(first.scheduledAt).toBe(DUE);

    await h.tickAt(plusHours(DUE, -23));
    expect(h.provider.getCalls).toHaveLength(1);
    expect(h.provider.createCalls).toHaveLength(2);
    expect(h.provider.createCalls[1]!.chargeId).toBe(first.chargeId);
    // 23h before the due date is closer than the 24h lead: the date moves to the earliest legal instant.
    expect(h.provider.createCalls[1]!.scheduledAt).toBe(plusHours(DUE, 1));
    expect(h.provider.gateway.size).toBe(1);
  });

  it('handles a gateway that answers pending rather than scheduled', async () => {
    const h = advance();
    h.provider.createScript = [CreateBehaviour.Pending];
    await h.scheduler.register(registration());
    await h.tickAt(plusHours(DUE, -24));
    expect((await h.store.getCycle('sub_1', 0))?.status).toBe(CycleStatus.AwaitingConfirmation);
  });

  it('a gateway with no lead raises the charge on the due date (style C), with no scheduledAt', async () => {
    const h = makeHarness({ style: Style.OnDue });
    await h.scheduler.register(registration());
    await h.tickAt(plusHours(DUE, -24));
    expect(h.provider.createCalls).toHaveLength(0);
    await h.tickAt(DUE);
    expect(h.provider.createCalls[0]!.scheduledAt).toBeUndefined();
  });

  it('starts a free trial charge the lead time before the trial ends', async () => {
    const h = advance({ startAt: T0 });
    h.provider.createScript = [CreateBehaviour.Scheduled];
    await h.scheduler.register(registration());
    expect((await h.scheduler.get('sub_1'))?.nextActionAt).toBe(plusHours(DUE, -24));
  });
});
