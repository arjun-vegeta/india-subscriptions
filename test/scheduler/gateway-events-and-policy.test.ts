import { describe, expect, it } from 'vitest';
import { ErrorCode, EventType } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import { ChargeStatus } from '../../src/constants.js';
import { CycleStatus, SchedulePauser, ScheduleStatus, ScheduleStatusReason, SchedulerEventType } from '../../src/scheduler/index.js';
import { CreateBehaviour, DUE, SID, Style, makeEvent, makeHarness, plusHours, registration } from './helpers.js';

describe('who paused the schedule', () => {
  it('a gateway pause is undone by the gateway\'s resume (Resumed, or Activated while paused); the cycle is re-anchored, never billed retroactively', async () => {
    for (const resume of [EventType.SubscriptionResumed, EventType.SubscriptionActivated]) {
      const h = makeHarness();
      await h.scheduler.register(registration());
      await h.scheduler.handleEvent(makeEvent({ type: EventType.SubscriptionPaused, subscriptionId: 'sub_1' }));
      expect(await h.scheduler.get(SID)).toMatchObject({ status: ScheduleStatus.Paused, statusReason: ScheduleStatusReason.PausedByGateway, pausedBy: SchedulePauser.Gateway });

      h.clock.set(plusHours(DUE, 24 * 20));
      await h.scheduler.handleEvent(makeEvent({ type: resume, subscriptionId: 'sub_1' }));
      const resumed = await h.scheduler.get(SID);
      expect(resumed).toMatchObject({ status: ScheduleStatus.Active, paidCycles: 0 });
      expect(resumed?.pausedBy).toBeUndefined();
      // The due date passed while paused: the cycle is due now, once; nothing was billed in the meantime.
      expect(h.provider.createCalls).toHaveLength(0);
      expect((await h.store.getCycle(SID, 0))?.attemptDueAt).toBe(plusHours(DUE, 24 * 20));
    }
  });

  it('a merchant pause is never undone by a gateway event', async () => {
    const h = makeHarness();
    await h.scheduler.register(registration());
    await h.scheduler.pause(SID);
    expect((await h.scheduler.get(SID))?.pausedBy).toBe(SchedulePauser.Merchant);
    for (const type of [EventType.SubscriptionResumed, EventType.SubscriptionActivated, EventType.SubscriptionAuthorized]) {
      await h.scheduler.handleEvent(makeEvent({ type, subscriptionId: 'sub_1' }));
      expect((await h.scheduler.get(SID))?.status).toBe(ScheduleStatus.Paused);
    }
  });

  it('a schedule stored before pausedBy existed is read from its status reason', async () => {
    const h = makeHarness();
    await h.scheduler.register(registration());
    await h.scheduler.handleEvent(makeEvent({ type: EventType.SubscriptionPaused, subscriptionId: 'sub_1' }));
    const stored = (await h.scheduler.get(SID))!;
    delete stored.pausedBy;
    await h.store.saveSchedule(stored);
    await h.scheduler.handleEvent(makeEvent({ type: EventType.SubscriptionResumed, subscriptionId: 'sub_1' }));
    expect((await h.scheduler.get(SID))?.status).toBe(ScheduleStatus.Active);
  });

  it('a resume event on a schedule that is not paused changes nothing', async () => {
    const h = makeHarness();
    await h.scheduler.register(registration());
    await h.scheduler.handleEvent(makeEvent({ type: EventType.SubscriptionResumed, subscriptionId: 'sub_1' }));
    expect((await h.scheduler.get(SID))?.status).toBe(ScheduleStatus.Active);
  });
});

describe('a debit id that is sent again after an unknown outcome', () => {
  it.each([
    [ErrorCode.Validation],
    [ErrorCode.ProviderError],
    [ErrorCode.Conflict],
    [ErrorCode.Auth],
    [ErrorCode.Unsupported],
    [ErrorCode.NotFound],
    [ErrorCode.Config],
  ])('whatever error (%s) the second createCharge gets, the attempt is not failed, no new id is used, and getCharge settles it', async (code) => {
    const h = makeHarness({ style: Style.OnDue });
    h.provider.createScript = [CreateBehaviour.UnknownLost, CreateBehaviour.ThrowConfigured];
    h.provider.createError = new SubscriptionError(code, 'duplicate payment id', { provider: 'payu' });
    await h.scheduler.register(registration());
    await h.tickAt(DUE);
    const chargeId = (await h.store.getCycle(SID, 0))?.chargeId as string;
    expect((await h.store.getCycle(SID, 0))?.status).toBe(CycleStatus.Charging);

    // Grace over: getCharge says NOT_FOUND, the same id is re-sent, and the gateway refuses it.
    const resent = await h.tickAt(plusHours(DUE, 1));
    expect(resent.failed).toBe(0);
    expect(h.provider.createCalls.map((call) => call.chargeId)).toEqual([chargeId, chargeId]);
    expect(await h.store.getCycle(SID, 0)).toMatchObject({ status: CycleStatus.Charging, chargeId, attempt: 1 });
    expect(h.events.some((e) => e.type === SchedulerEventType.ChargeOutcomeOverdue)).toBe(true);

    // Later ticks keep asking; once the gateway shows the debit, it settles, and nothing else was ever raised.
    await h.tickAt(plusHours(DUE, 2));
    expect(h.provider.createCalls.every((call) => call.chargeId === chargeId)).toBe(true);
    h.provider.gateway.set(chargeId, {
      provider: 'payu',
      id: `pay_${chargeId}`,
      reference: chargeId,
      kind: 'recurring',
      status: ChargeStatus.Succeeded,
      amount: 49900,
      raw: null,
    });
    await h.tickAt(plusHours(DUE, 3));
    expect(await h.scheduler.get(SID)).toMatchObject({ paidCycles: 1 });
    expect(h.provider.createCalls.every((call) => call.chargeId === chargeId)).toBe(true);
  });

  it('a FIRST attempt the gateway refuses still counts as a failed attempt', async () => {
    const h = makeHarness({ style: Style.OnDue });
    h.provider.createScript = [CreateBehaviour.Reject];
    await h.scheduler.register(registration());
    const result = await h.tickAt(DUE);
    expect(result.failed).toBe(1);
    expect(await h.store.getCycle(SID, 0)).toMatchObject({ attempt: 2 });
  });
});

describe('debitAtIstTime', () => {
  const at = (hhmm: string) => makeHarness({ scheduler: { debitAtIstTime: hhmm } });

  it('every cycle after the first falls due on its IST date at that clock time; the first is never moved earlier than its contractual instant', async () => {
    // DUE is 15 Jan 10:00 IST. 14:30 IST is later the same day: the first cycle moves to 14:30; later cycles too.
    const h = at('14:30');
    await h.scheduler.register(registration());
    expect((await h.store.getCycle(SID, 0))?.dueAt).toBe('2026-01-15T09:00:00.000Z');
    expect((await h.scheduler.get(SID))?.nextChargeAt).toBe('2026-01-15T09:00:00.000Z');
    await h.tickAt('2026-01-13T09:00:00.000Z');
    await h.tickAt('2026-01-15T09:00:00.000Z');
    expect(await h.scheduler.get(SID)).toMatchObject({ paidCycles: 1 });
    expect((await h.store.getCycle(SID, 1))?.dueAt).toBe('2026-02-15T09:00:00.000Z');
  });

  it('an earlier time moves later cycles earlier but leaves the first cycle at its contractual instant', async () => {
    const h = at('06:15');
    await h.scheduler.register(registration());
    expect((await h.store.getCycle(SID, 0))?.dueAt).toBe(DUE);
    await h.tickAt(plusHours(DUE, -48));
    await h.tickAt(DUE);
    expect((await h.store.getCycle(SID, 1))?.dueAt).toBe('2026-02-15T00:45:00.000Z');
  });

  it('unset: every cycle keeps the time of day of the first charge (today\'s behaviour)', async () => {
    const h = makeHarness();
    await h.scheduler.register(registration());
    await h.tickAt(plusHours(DUE, -48));
    await h.tickAt(DUE);
    expect((await h.store.getCycle(SID, 1))?.dueAt).toBe('2026-02-15T04:30:00.000Z');
  });
});
