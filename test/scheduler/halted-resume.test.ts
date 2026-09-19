import { describe, expect, it } from 'vitest';
import { ErrorCode, EventType } from '../../src/constants.js';
import {
  CycleStatus,
  ScheduleStatus,
  ScheduleStatusReason,
  SchedulerEventType,
} from '../../src/scheduler/index.js';
import {
  CreateBehaviour,
  DUE,
  Style,
  makeEvent,
  makeHarness,
  plusHours,
  registration,
  type Harness,
} from './helpers.js';

const CHARGE_SUFFIX = /_(\d+)_(\d+)$/;
const attemptOf = (chargeId: string) => Number(CHARGE_SUFFIX.exec(chargeId)?.[2]);

/** Notify-style schedule whose first cycle fails three times and halts (at D + 48h). */
async function haltedSchedule(h: Harness) {
  h.provider.createScript = [CreateBehaviour.Fail, CreateBehaviour.Fail, CreateBehaviour.Fail];
  await h.scheduler.register(registration());
  await h.tickAt(plusHours(DUE, -48));
  await h.tickAt(DUE);
  await h.tickAt(plusHours(DUE, 24));
  await h.tickAt(plusHours(DUE, 48));
  expect((await h.scheduler.get('sub_1'))?.status).toBe(ScheduleStatus.Halted);
}

describe('resume of a halted schedule', () => {
  it('re-opens the failed cycle under a new attempt number, with a fresh notification, and carries on', async () => {
    const h = makeHarness();
    await haltedSchedule(h);
    const resumeAt = plusHours(DUE, 60);
    h.clock.set(resumeAt);

    const resumed = await h.scheduler.resume('sub_1');
    expect(resumed.status).toBe(ScheduleStatus.Active);
    expect(resumed.statusReason).toBeUndefined();
    expect(resumed.endedAt).toBeUndefined();
    const cycle = await h.store.getCycle('sub_1', 0);
    expect(cycle).toMatchObject({ status: CycleStatus.Pending, attempt: 4, attemptDueAt: resumeAt });
    expect(cycle?.attempts).toHaveLength(3); // history kept
    expect(resumed.nextChargeAt).toBe(resumeAt);

    // Notified at once, debited once the 24h notice has passed.
    const callsBefore = h.provider.notifyCalls.length;
    await h.tickAt(resumeAt);
    expect(h.provider.notifyCalls).toHaveLength(callsBefore + 1);
    expect(h.provider.notifyCalls.at(-1)!.debitAt).toBe(plusHours(resumeAt, 24));
    expect(h.provider.createCalls).toHaveLength(3);

    await h.tickAt(plusHours(resumeAt, 24));
    expect(h.provider.createCalls).toHaveLength(4);
    expect(attemptOf(h.provider.createCalls[3]!.chargeId)).toBe(4);
    expect(new Set(h.provider.createCalls.map((c) => c.chargeId)).size).toBe(4);

    expect(await h.scheduler.get('sub_1')).toMatchObject({ status: ScheduleStatus.Active, paidCycles: 1, cycleIndex: 1 });
    // The following cycle keeps its original date: nothing was swallowed.
    expect((await h.store.getCycle('sub_1', 1))?.dueAt).toBe('2026-02-15T04:30:00.000Z');
    expect(h.events.some((e) => e.type === SchedulerEventType.ScheduleResumed)).toBe(true);
  });

  it('gives the re-opened cycle a fresh round of maxAttempts', async () => {
    const h = makeHarness({ style: Style.OnDue, scheduler: { maxAttempts: 2 } });
    h.provider.createScript = [CreateBehaviour.Fail, CreateBehaviour.Fail, CreateBehaviour.Fail, CreateBehaviour.Fail];
    await h.scheduler.register(registration());
    await h.tickAt(DUE);
    await h.tickAt(plusHours(DUE, 24));
    expect((await h.scheduler.get('sub_1'))?.status).toBe(ScheduleStatus.Halted);

    h.clock.set(plusHours(DUE, 25));
    await h.scheduler.resume('sub_1');
    // Style C: due now, so the next tick debits straight away.
    await h.tickAt(plusHours(DUE, 25));
    expect((await h.scheduler.get('sub_1'))?.status).toBe(ScheduleStatus.Active);
    await h.tickAt(plusHours(DUE, 49));
    expect((await h.scheduler.get('sub_1'))?.status).toBe(ScheduleStatus.Halted);

    expect(h.provider.createCalls.map((c) => attemptOf(c.chargeId))).toEqual([1, 2, 3, 4]);
    expect(new Set(h.provider.createCalls.map((c) => c.chargeId)).size).toBe(4);
    expect(await h.store.getCycle('sub_1', 0)).toMatchObject({ status: CycleStatus.Failed, roundStartAttempt: 3 });
  });

  it('re-opens the cycle at nextChargeAt when given, and re-anchors later cycles from it', async () => {
    const h = makeHarness();
    await haltedSchedule(h);
    const target = '2026-02-20T04:30:00.000Z';
    h.clock.set(plusHours(DUE, 60));
    const resumed = await h.scheduler.resume('sub_1', { nextChargeAt: target });
    expect(resumed).toMatchObject({ anchorAt: target, anchorIndex: 0, nextChargeAt: target });
    expect(await h.store.getCycle('sub_1', 0)).toMatchObject({ status: CycleStatus.Pending, dueAt: target, attemptDueAt: target });

    await h.tickAt(plusHours(target, -48));
    await h.tickAt(target);
    expect(h.provider.createCalls).toHaveLength(4);
    expect((await h.store.getCycle('sub_1', 1))?.dueAt).toBe('2026-03-20T04:30:00.000Z');
  });

  it('re-anchors later cycles from now when the halt lasted past the next cycle date', async () => {
    const h = makeHarness();
    await haltedSchedule(h);
    const resumeAt = '2026-03-10T04:30:00.000Z'; // the Feb 15 cycle date has passed
    h.clock.set(resumeAt);
    const resumed = await h.scheduler.resume('sub_1');
    expect(resumed.anchorAt).toBe(resumeAt);
    await h.tickAt(resumeAt);
    await h.tickAt(plusHours(resumeAt, 24));
    // The missed February cycle is not billed on top of the re-opened one.
    expect(await h.store.getCycle('sub_1', 1)).toMatchObject({ dueAt: '2026-04-10T04:30:00.000Z', status: CycleStatus.Pending });
    expect(await h.scheduler.listCycles('sub_1')).toHaveLength(2);
  });

  it('skipFailedCycle skips the failed cycle and continues from the next cycle date', async () => {
    const h = makeHarness();
    await haltedSchedule(h);
    h.clock.set(plusHours(DUE, 60));
    const resumed = await h.scheduler.resume('sub_1', { skipFailedCycle: true });

    expect(resumed).toMatchObject({ status: ScheduleStatus.Active, cycleIndex: 1, paidCycles: 0, nextChargeAt: '2026-02-15T04:30:00.000Z' });
    expect((await h.store.getCycle('sub_1', 0))?.status).toBe(CycleStatus.Skipped);
    expect((await h.store.getCycle('sub_1', 1))).toMatchObject({ status: CycleStatus.Pending, dueAt: '2026-02-15T04:30:00.000Z' });
    expect(h.events.some((e) => e.type === SchedulerEventType.CycleSkipped)).toBe(true);

    const callsBefore = h.provider.createCalls.length;
    await h.tickAt('2026-02-13T04:30:00.000Z');
    await h.tickAt('2026-02-15T04:30:00.000Z');
    expect(h.provider.createCalls).toHaveLength(callsBefore + 1);
    expect(attemptOf(h.provider.createCalls.at(-1)!.chargeId)).toBe(1);
    expect(h.provider.createCalls.at(-1)!.chargeId).toMatch(/_1_1$/);
  });

  it('skipFailedCycle re-anchors from now when the next cycle date has passed, and honours nextChargeAt', async () => {
    const late = makeHarness();
    await haltedSchedule(late);
    const resumeAt = '2026-03-10T04:30:00.000Z';
    late.clock.set(resumeAt);
    expect(await late.scheduler.resume('sub_1', { skipFailedCycle: true })).toMatchObject({
      anchorAt: resumeAt,
      anchorIndex: 1,
      nextChargeAt: resumeAt,
    });

    const dated = makeHarness();
    await haltedSchedule(dated);
    dated.clock.set(plusHours(DUE, 60));
    const resumed = await dated.scheduler.resume('sub_1', { skipFailedCycle: true, nextChargeAt: '2026-02-20T04:30:00.000Z' });
    expect(resumed.nextChargeAt).toBe('2026-02-20T04:30:00.000Z');
  });

  it('skipping the last cycle completes the schedule', async () => {
    const h = makeHarness({ style: Style.OnDue, scheduler: { maxAttempts: 1 } });
    h.provider.createScript = [CreateBehaviour.Fail];
    await h.scheduler.register(registration({ totalCycles: 1 }));
    await h.tickAt(DUE);
    expect((await h.scheduler.get('sub_1'))?.status).toBe(ScheduleStatus.Halted);

    const resumed = await h.scheduler.resume('sub_1', { skipFailedCycle: true });
    expect(resumed).toMatchObject({ status: ScheduleStatus.Completed, statusReason: ScheduleStatusReason.FinalCycleSkipped });
    expect(resumed.nextActionAt).toBeUndefined();
  });

  it('for a charge-in-advance gateway the re-opened cycle is raised with scheduledAt = now + lead', async () => {
    const h = makeHarness({ style: Style.Advance, leadHours: 24, scheduler: { maxAttempts: 1 } });
    h.provider.createScript = [CreateBehaviour.Fail, CreateBehaviour.Scheduled];
    await h.scheduler.register(registration());
    await h.tickAt(plusHours(DUE, -24));
    expect((await h.scheduler.get('sub_1'))?.status).toBe(ScheduleStatus.Halted);

    const resumeAt = plusHours(DUE, 5);
    h.clock.set(resumeAt);
    await h.scheduler.resume('sub_1');
    await h.tickAt(resumeAt);
    expect(h.provider.createCalls).toHaveLength(2);
    expect(h.provider.notifyCalls).toHaveLength(0);
    expect(h.provider.createCalls[1]!.scheduledAt).toBe(plusHours(resumeAt, 24));
    expect(attemptOf(h.provider.createCalls[1]!.chargeId)).toBe(2);
  });

  it('works after the gateway halted the mandate with no failed cycle', async () => {
    const h = makeHarness();
    await h.scheduler.register(registration());
    await h.scheduler.handleEvent(makeEvent({ type: EventType.SubscriptionHalted, subscriptionId: 'sub_1' }));
    expect((await h.scheduler.get('sub_1'))?.status).toBe(ScheduleStatus.Halted);

    const resumed = await h.scheduler.resume('sub_1');
    expect(resumed).toMatchObject({ status: ScheduleStatus.Active, cycleIndex: 0 });
    expect((await h.store.getCycle('sub_1', 0))?.attempt).toBe(1);
    await h.tickAt(plusHours(DUE, -48));
    await h.tickAt(DUE);
    expect(h.provider.createCalls).toHaveLength(1);
  });

  it('is idempotent on an active schedule and still rejects cancelled and completed schedules', async () => {
    const h = makeHarness({ style: Style.OnDue });
    await h.scheduler.register(registration({ id: 'a', subscriptionId: 'a' }));
    expect((await h.scheduler.resume('a', { skipFailedCycle: true })).status).toBe(ScheduleStatus.Active);

    await h.scheduler.cancel('a');
    await expect(h.scheduler.resume('a')).rejects.toMatchObject({ code: ErrorCode.Conflict });

    await h.scheduler.register(registration({ id: 'b', subscriptionId: 'b', totalCycles: 1 }));
    await h.tickAt(DUE);
    expect((await h.scheduler.get('b'))?.status).toBe(ScheduleStatus.Completed);
    await expect(h.scheduler.resume('b')).rejects.toMatchObject({ code: ErrorCode.Conflict });
  });
});
