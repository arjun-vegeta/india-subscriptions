import { describe, expect, it } from 'vitest';
import { ChargeStatus, ErrorCode, Provider } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import {
  BillingScheduler,
  CycleStatus,
  MemorySchedulerStore,
  ScheduleStatus,
  ScheduleStatusReason,
  SchedulerEventType,
  scheduleIdFor,
} from '../../src/scheduler/index.js';
import {
  CreateBehaviour,
  DUE,
  FakeProvider,
  NotifyBehaviour,
  Style,
  T0,
  makeHarness,
  plusHours,
  registration,
  sleep,
  SID,
} from './helpers.js';

const CHARGE_ID = /^chg_[0-9a-f]{16}_(\d+)_(\d+)$/;

async function cycleOf(h: ReturnType<typeof makeHarness>, index = 0) {
  const cycle = await h.store.getCycle(SID, index);
  if (!cycle) throw new Error(`no cycle ${index}`);
  return cycle;
}

/** Runs one whole cycle of a notify-style schedule: notification 48h ahead, debit on the due date. */
async function runCycle(h: ReturnType<typeof makeHarness>, due: string) {
  await h.tickAt(plusHours(due, -48));
  await h.tickAt(due);
}

describe('free trial and first charge', () => {
  it('charges nothing before the trial ends, notifies 48h ahead, debits on the trial end', async () => {
    const h = makeHarness();
    await h.scheduler.register(registration());

    // Nothing is due until 48h before the trial end.
    const early = await h.tickAt(plusHours(DUE, -48.001));
    expect(early.due).toBe(0);
    expect(h.provider.notifyCalls).toHaveLength(0);

    // Notification goes out exactly notifyLeadHours before.
    const notified = await h.tickAt(plusHours(DUE, -48));
    expect(notified.notified).toBe(1);
    expect(h.provider.notifyCalls).toHaveLength(1);
    expect(h.provider.notifyCalls[0]).toMatchObject({
      subscriptionId: 'sub_1',
      amount: 49900,
      debitAt: DUE,
    });
    expect(h.provider.createCalls).toHaveLength(0);

    // The notice period has passed one day later, but the trial has not ended.
    await h.tickAt(plusHours(DUE, -24));
    await h.tickAt(plusHours(DUE, -0.001));
    expect(h.provider.createCalls).toHaveLength(0);

    // The debit happens on the trial end, with the invoice number from the notification.
    const charged = await h.tickAt(DUE);
    expect(charged.charged).toBe(1);
    expect(charged.succeeded).toBe(1);
    expect(h.provider.createCalls).toHaveLength(1);
    const call = h.provider.createCalls[0]!;
    expect(call.chargeId).toMatch(CHARGE_ID);
    expect(call.amount).toBe(49900);
    expect(call.subscriptionId).toBe('sub_1');
    expect(call.invoiceNumber).toBe(`INV-${h.provider.notifyCalls[0]!.notificationId}`);

    const schedule = await h.scheduler.get(SID);
    expect(schedule).toMatchObject({ status: ScheduleStatus.Active, paidCycles: 1, cycleIndex: 1 });
    // The next cycle is a month later.
    expect(schedule?.nextChargeAt).toBe('2026-02-15T04:30:00.000Z');
    expect((await cycleOf(h)).status).toBe(CycleStatus.Succeeded);
  });

  it('is a no-op when called repeatedly with nothing due', async () => {
    const h = makeHarness();
    await h.scheduler.register(registration());
    for (let i = 0; i < 3; i++) {
      const result = await h.tickAt(plusHours(T0, i + 1));
      expect(result).toMatchObject({ due: 0, notified: 0, charged: 0, reconciled: 0, errors: [] });
    }
    expect(h.provider.notifyCalls).toHaveLength(0);
    expect(h.provider.createCalls).toHaveLength(0);
    expect(h.provider.getCalls).toHaveLength(0);
  });

  it('does not notify or charge twice when ticked again right after finishing', async () => {
    const h = makeHarness();
    await h.scheduler.register(registration());
    await runCycle(h, DUE);
    const calls = [h.provider.notifyCalls.length, h.provider.createCalls.length];
    for (let i = 0; i < 3; i++) await h.tickAt(plusHours(DUE, i));
    expect([h.provider.notifyCalls.length, h.provider.createCalls.length]).toEqual(calls);
  });
});

describe('billing cycles', () => {
  it('bills a month-end anchor on 31 Jan, 28 Feb, 31 Mar', async () => {
    const h = makeHarness();
    // 31 Jan 2026, 10:00 IST.
    await h.scheduler.register(registration({ firstChargeAt: '2026-01-31T10:00:00+05:30' }));
    const due0 = '2026-01-31T04:30:00.000Z';
    const due1 = '2026-02-28T04:30:00.000Z';
    const due2 = '2026-03-31T04:30:00.000Z';

    await runCycle(h, due0);
    await runCycle(h, due1);
    await runCycle(h, due2);

    const cycles = await h.scheduler.listCycles(SID);
    expect(cycles.map((c) => c.dueAt)).toEqual([due0, due1, due2, '2026-04-30T04:30:00.000Z']);
    expect(cycles.slice(0, 3).every((c) => c.status === CycleStatus.Succeeded)).toBe(true);
    expect(h.provider.createCalls).toHaveLength(3);
    // Each debit carries its own deterministic id.
    expect(new Set(h.provider.createCalls.map((c) => c.chargeId)).size).toBe(3);
    expect(h.provider.createCalls.map((c) => CHARGE_ID.exec(c.chargeId)?.[1])).toEqual(['0', '1', '2']);
  });

  it('completes after totalCycles and stops', async () => {
    const h = makeHarness();
    await h.scheduler.register(registration({ totalCycles: 2 }));
    await runCycle(h, DUE);
    expect((await h.scheduler.get(SID))?.status).toBe(ScheduleStatus.Active);
    const second = '2026-02-15T04:30:00.000Z';
    await runCycle(h, second);

    const schedule = await h.scheduler.get(SID);
    expect(schedule).toMatchObject({
      status: ScheduleStatus.Completed,
      statusReason: ScheduleStatusReason.AllCyclesCollected,
      paidCycles: 2,
    });
    expect(schedule?.nextActionAt).toBeUndefined();
    expect(schedule?.nextChargeAt).toBeUndefined();
    expect(h.events.some((e) => e.type === SchedulerEventType.ScheduleCompleted)).toBe(true);

    const later = await h.tickAt('2026-06-01T00:00:00.000Z');
    expect(later.due).toBe(0);
    expect(h.provider.createCalls).toHaveLength(2);
    expect(await h.scheduler.listCycles(SID)).toHaveLength(2);
  });

  it('uses per-schedule policy overrides', async () => {
    const h = makeHarness();
    await h.scheduler.register(registration({ notifyLeadHours: 72, minNoticeHours: 12 }));
    expect((await h.tickAt(plusHours(DUE, -72.5))).notified).toBe(0);
    expect((await h.tickAt(plusHours(DUE, -72))).notified).toBe(1);
    await h.tickAt(DUE);
    expect(h.provider.createCalls).toHaveLength(1);
  });
});

describe('pre-debit notification rules', () => {
  it('enforces the minimum notice when the schedule is registered late', async () => {
    const h = makeHarness({ startAt: plusHours(DUE, -10) });
    await h.scheduler.register(registration());

    // Already inside the lead window: notify now. The debit date told to the customer is now + 24h, not the due date.
    const notified = await h.tickAt(plusHours(DUE, -10));
    expect(notified.notified).toBe(1);
    expect(h.provider.notifyCalls[0]!.debitAt).toBe(plusHours(DUE, 14));

    // The due date passes without a debit: the notice period has not.
    await h.tickAt(DUE);
    await h.tickAt(plusHours(DUE, 13.99));
    expect(h.provider.createCalls).toHaveLength(0);

    await h.tickAt(plusHours(DUE, 14));
    expect(h.provider.createCalls).toHaveLength(1);
  });

  it('retries a rejected notification on a later tick and never debits un-notified', async () => {
    const h = makeHarness();
    h.provider.notifyScript = [NotifyBehaviour.Reject, NotifyBehaviour.Throw];
    await h.scheduler.register(registration());

    const first = await h.tickAt(plusHours(DUE, -48));
    expect(first.notified).toBe(0);
    expect(first.errors).toHaveLength(1);
    expect(h.provider.notifyCalls).toHaveLength(1);
    expect((await cycleOf(h)).lastError?.code).toBe(ErrorCode.ProviderError);

    const second = await h.tickAt(plusHours(DUE, -47));
    expect(second.errors[0]?.code).toBe(ErrorCode.ProviderUnavailable);

    const third = await h.tickAt(plusHours(DUE, -46));
    expect(third.notified).toBe(1);
    expect(h.provider.notifyCalls).toHaveLength(3);
    // Same deterministic notification id every time.
    expect(new Set(h.provider.notifyCalls.map((n) => n.notificationId)).size).toBe(1);
    expect(h.events.filter((e) => e.type === SchedulerEventType.NotificationFailed)).toHaveLength(2);

    await h.tickAt(DUE);
    expect(h.provider.createCalls).toHaveLength(1);
  });

  it('does not charge a notification-less provider early, and sends no notification', async () => {
    const h = makeHarness({ style: Style.OnDue });
    await h.scheduler.register(registration());
    await h.tickAt(plusHours(DUE, -48));
    await h.tickAt(plusHours(DUE, -1));
    expect(h.provider.createCalls).toHaveLength(0);

    await h.tickAt(DUE);
    expect(h.provider.notifyCalls).toHaveLength(0);
    expect(h.provider.createCalls).toHaveLength(1);
    expect(h.provider.createCalls[0]!.invoiceNumber).toBeUndefined();
    expect(h.provider.createCalls[0]!.scheduledAt).toBeUndefined();
  });
});

describe('failed charges', () => {
  it('retries with new attempt ids and fresh notifications, then halts', async () => {
    const h = makeHarness();
    h.provider.createScript = [CreateBehaviour.Fail, CreateBehaviour.Fail, CreateBehaviour.Fail];
    await h.scheduler.register(registration());

    await h.tickAt(plusHours(DUE, -48));
    // Attempt 1 fails on the due date; attempt 2 is notified straight away and due 24h later.
    const first = await h.tickAt(DUE);
    expect(first.failed).toBe(1);
    expect(h.provider.notifyCalls).toHaveLength(2);
    expect((await cycleOf(h)).attempt).toBe(2);
    expect((await cycleOf(h)).attemptDueAt).toBe(plusHours(DUE, 24));
    expect((await cycleOf(h)).status).toBe(CycleStatus.Notified);

    await h.tickAt(plusHours(DUE, 23));
    expect(h.provider.createCalls).toHaveLength(1);

    await h.tickAt(plusHours(DUE, 24));
    expect(h.provider.createCalls).toHaveLength(2);
    expect((await cycleOf(h)).attempt).toBe(3);

    const last = await h.tickAt(plusHours(DUE, 48));
    expect(last.failed).toBe(1);
    expect(last.halted).toBe(1);

    const cycle = await cycleOf(h);
    expect(cycle.status).toBe(CycleStatus.Failed);
    expect(cycle.attempts.map((a) => a.attempt)).toEqual([1, 2, 3]);
    expect(cycle.attempts[0]).toMatchObject({ status: ChargeStatus.Failed, failureCode: 'INSUFFICIENT_FUNDS' });
    expect(h.provider.createCalls.map((c) => CHARGE_ID.exec(c.chargeId)?.slice(1, 3).join('/'))).toEqual(['0/1', '0/2', '0/3']);
    expect(new Set(h.provider.notifyCalls.map((n) => n.notificationId)).size).toBe(3);
    // Each retry debit carries the invoice of its own notification.
    expect(h.provider.createCalls[1]!.invoiceNumber).toBe(`INV-${h.provider.notifyCalls[1]!.notificationId}`);

    const schedule = await h.scheduler.get(SID);
    expect(schedule).toMatchObject({ status: ScheduleStatus.Halted, statusReason: ScheduleStatusReason.RetriesExhausted });
    expect(schedule?.nextActionAt).toBeUndefined();
    expect(h.events.map((e) => e.type)).toEqual(
      expect.arrayContaining([SchedulerEventType.ChargeFailed, SchedulerEventType.CycleFailed, SchedulerEventType.ScheduleHalted]),
    );

    await h.tickAt(plusHours(DUE, 24 * 30));
    expect(h.provider.createCalls).toHaveLength(3);
  });

  it('recovers when a retry succeeds and continues with the next cycle', async () => {
    const h = makeHarness();
    h.provider.createScript = [CreateBehaviour.Fail];
    await h.scheduler.register(registration());
    await runCycle(h, DUE);
    await h.tickAt(plusHours(DUE, 24));

    const schedule = await h.scheduler.get(SID);
    expect(schedule).toMatchObject({ status: ScheduleStatus.Active, paidCycles: 1, cycleIndex: 1 });
    expect((await h.scheduler.listCycles(SID))[1]?.dueAt).toBe('2026-02-15T04:30:00.000Z');
  });

  it('counts a gateway refusal as a failed attempt', async () => {
    const h = makeHarness({ style: Style.OnDue });
    h.provider.createScript = [CreateBehaviour.Reject];
    await h.scheduler.register(registration());
    const result = await h.tickAt(DUE);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(0);
    const cycle = await cycleOf(h);
    expect(cycle.attempts[0]).toMatchObject({ failureCode: 'MANDATE_INACTIVE' });
    expect(cycle.attempt).toBe(2);
  });
});

describe('never double-debit', () => {
  it('reconciles a pending charge on later ticks without charging again', async () => {
    const h = makeHarness();
    h.provider.createScript = [CreateBehaviour.Pending];
    await h.scheduler.register(registration());
    await h.tickAt(plusHours(DUE, -48));
    const charged = await h.tickAt(DUE);
    expect(charged.awaiting).toBe(1);
    expect((await cycleOf(h)).status).toBe(CycleStatus.AwaitingConfirmation);

    // Still pending at the bank: asked again, never re-charged.
    const still = await h.tickAt(plusHours(DUE, 1));
    expect(still.reconciled).toBe(1);
    expect(h.provider.getCalls).toHaveLength(1);
    expect(h.provider.getCalls[0]!.chargeId).toBe(h.provider.createCalls[0]!.chargeId);
    expect((await cycleOf(h)).status).toBe(CycleStatus.AwaitingConfirmation);

    h.provider.settle(h.provider.createCalls[0]!.chargeId, ChargeStatus.Succeeded);
    const done = await h.tickAt(plusHours(DUE, 2));
    expect(done.succeeded).toBe(1);
    expect(h.provider.createCalls).toHaveLength(1);
    expect(await h.scheduler.get(SID)).toMatchObject({ paidCycles: 1, cycleIndex: 1 });
  });

  it('reconciles a pending charge that the bank then fails, and retries under a new id', async () => {
    const h = makeHarness();
    h.provider.createScript = [CreateBehaviour.Pending];
    await h.scheduler.register(registration());
    await runCycle(h, DUE);
    h.provider.settle(h.provider.createCalls[0]!.chargeId, ChargeStatus.Failed);
    const result = await h.tickAt(plusHours(DUE, 1));
    expect(result.failed).toBe(1);
    expect((await cycleOf(h)).attempt).toBe(2);
    expect(h.provider.createCalls).toHaveLength(1);
  });

  it('reconciles OUTCOME_UNKNOWN with getCharge instead of charging again', async () => {
    const h = makeHarness();
    h.provider.createScript = [CreateBehaviour.UnknownCreated];
    await h.scheduler.register(registration());
    await h.tickAt(plusHours(DUE, -48));

    const unknown = await h.tickAt(DUE);
    expect(unknown.errors).toHaveLength(1);
    expect(unknown.errors[0]?.code).toBe(ErrorCode.OutcomeUnknown);
    expect((await cycleOf(h)).status).toBe(CycleStatus.Charging);

    const next = await h.tickAt(plusHours(DUE, 1));
    expect(next.errors).toHaveLength(0);
    expect(next.succeeded).toBe(1);
    expect(h.provider.createCalls).toHaveLength(1);
    expect(h.provider.getCalls).toHaveLength(1);
    expect(h.provider.gateway.size).toBe(1);
    expect(h.events.some((e) => e.type === SchedulerEventType.ChargeOutcomeUnknown)).toBe(true);
  });

  it('OUTCOME_UNKNOWN where the debit is still pending at the bank waits instead of re-charging', async () => {
    const h = makeHarness();
    h.provider.createScript = [CreateBehaviour.UnknownPendingCreated];
    await h.scheduler.register(registration());
    await runCycle(h, DUE);
    await h.tickAt(plusHours(DUE, 1));
    await h.tickAt(plusHours(DUE, 2));
    expect(h.provider.createCalls).toHaveLength(1);
    expect((await cycleOf(h)).status).toBe(CycleStatus.AwaitingConfirmation);
  });

  it('after an unknown outcome the gateway never saw, re-creates with the SAME charge id', async () => {
    const h = makeHarness();
    h.provider.createScript = [CreateBehaviour.UnknownLost];
    await h.scheduler.register(registration());
    await runCycle(h, DUE);
    await h.tickAt(plusHours(DUE, 1));

    expect(h.provider.getCalls).toHaveLength(1);
    expect(h.provider.createCalls).toHaveLength(2);
    expect(h.provider.createCalls[1]!.chargeId).toBe(h.provider.createCalls[0]!.chargeId);
    expect(h.provider.gateway.size).toBe(1);
    expect((await cycleOf(h)).status).toBe(CycleStatus.Succeeded);
  });

  it('does not re-charge while the gateway cannot be asked', async () => {
    const h = makeHarness();
    h.provider.createScript = [CreateBehaviour.UnknownLost];
    await h.scheduler.register(registration());
    await runCycle(h, DUE);
    h.provider.getChargeError = new SubscriptionError(ErrorCode.Timeout, 'timed out', { provider: Provider.PayU });
    const result = await h.tickAt(plusHours(DUE, 1));
    expect(result.errors[0]?.code).toBe(ErrorCode.Timeout);
    expect(h.provider.createCalls).toHaveLength(1);
    expect((await cycleOf(h)).status).toBe(CycleStatus.Charging);
  });

  it('persists `charging` with the charge id before the gateway is called, and recovers from a crash there', async () => {
    const h = makeHarness();
    await h.scheduler.register(registration());
    await h.tickAt(plusHours(DUE, -48));

    let persistedBeforeCall: { status: string; chargeId?: string } | undefined;
    h.provider.onCreate = async (input) => {
      const cycle = await h.store.getCycle(SID, 0);
      persistedBeforeCall = { status: cycle?.status ?? 'missing', ...(cycle?.chargeId ? { chargeId: cycle.chargeId } : {}) };
      expect(input.chargeId).toBe(cycle?.chargeId);
      throw new Error('process crashed before reaching the gateway');
    };
    const crashed = await h.tickAt(DUE);
    expect(persistedBeforeCall).toMatchObject({ status: CycleStatus.Charging });
    expect(crashed.errors).toHaveLength(1);
    expect(h.provider.gateway.size).toBe(0);

    // A new process on the same store, with a healthy gateway connection, picks up the `charging` cycle.
    const restarted = new FakeProvider();
    const worker = h.another(restarted);
    h.clock.set(plusHours(DUE, 1));
    const result = await worker.tick();
    expect(result.reconciled).toBe(1);
    expect(restarted.getCalls).toHaveLength(1);
    expect(restarted.createCalls).toHaveLength(1);
    expect(restarted.createCalls[0]!.chargeId).toBe(persistedBeforeCall?.chargeId);
    expect((await cycleOf(h)).status).toBe(CycleStatus.Succeeded);
  });

  it('heals a crash between saving a succeeded cycle and moving the schedule on', async () => {
    const h = makeHarness({ style: Style.OnDue });
    await h.scheduler.register(registration());
    // Simulate: cycle saved as succeeded, schedule not advanced.
    await h.tickAt(DUE);
    const schedule = (await h.scheduler.get(SID))!;
    const cycle = (await h.store.getCycle(SID, 0))!;
    await h.store.saveSchedule({ ...schedule, cycleIndex: 0, paidCycles: 0, nextActionAt: DUE });
    await h.store.saveCycle(cycle);
    await h.tickAt(plusHours(DUE, 1));
    expect(await h.scheduler.get(SID)).toMatchObject({ cycleIndex: 1, paidCycles: 1 });
    expect(h.provider.createCalls).toHaveLength(1);
  });

  it('two concurrent ticks on one store debit once', async () => {
    const h = makeHarness({ style: Style.OnDue });
    h.provider.createDelayMs = 30;
    await h.scheduler.register(registration());
    h.clock.set(DUE);

    const [a, b] = await Promise.all([h.scheduler.tick(), h.scheduler.tick()]);
    expect(h.provider.createCalls).toHaveLength(1);
    expect(h.provider.gateway.size).toBe(1);
    expect(a.locked + b.locked).toBe(1);
    expect(a.succeeded + b.succeeded).toBe(1);
    expect(await h.scheduler.get(SID)).toMatchObject({ paidCycles: 1 });
  });

  it('two workers (separate scheduler instances) debit once', async () => {
    const h = makeHarness({ style: Style.OnDue });
    h.provider.createDelayMs = 30;
    await h.scheduler.register(registration());
    h.clock.set(DUE);
    const other = h.another();
    await Promise.all([h.scheduler.tick(), other.tick(), h.scheduler.tick(), other.tick()]);
    expect(h.provider.createCalls).toHaveLength(1);
  });

  it('re-reads the schedule after taking the lock, so a stale due list cannot cause a second debit', async () => {
    class GatedStore extends MemorySchedulerStore {
      gate: Promise<void> | undefined;
      override async listDueSchedules(at: string, limit: number) {
        const listed = await super.listDueSchedules(at, limit);
        if (this.gate) await this.gate;
        return listed;
      }
    }
    const store = new GatedStore();
    const h = makeHarness({ style: Style.OnDue, store });
    await h.scheduler.register(registration());
    h.clock.set(DUE);

    let release!: () => void;
    store.gate = new Promise<void>((resolve) => (release = resolve));
    const stale = h.scheduler.tick(); // lists the schedule as due, then waits
    await sleep(5);
    store.gate = undefined;
    await h.scheduler.tick(); // does the debit
    expect(h.provider.createCalls).toHaveLength(1);

    release();
    const result = await stale;
    expect(result.due).toBe(1);
    expect(result.charged).toBe(0);
    expect(h.provider.createCalls).toHaveLength(1);
  });

  it('one failing schedule does not stop the others', async () => {
    const h = makeHarness({ style: Style.OnDue });
    await h.scheduler.register(registration({ subscriptionId: 'bad' }));
    await h.scheduler.register(registration({ subscriptionId: 'good' }));
    h.provider.getChargeError = undefined;
    h.provider.onCreate = (input) => {
      if (input.subscriptionId === 'bad') throw new Error('boom');
    };
    const result = await h.tickAt(DUE);
    expect(result.due).toBe(2);
    expect(result.errors.map((e) => e.scheduleId)).toEqual([scheduleIdFor(Provider.PayU, 'bad')]);
    expect(result.succeeded).toBe(1);
    expect(await h.scheduler.get(scheduleIdFor(Provider.PayU, 'good'))).toMatchObject({ paidCycles: 1 });
  });

  it('respects the tick limit', async () => {
    const h = makeHarness({ style: Style.OnDue });
    for (const id of ['a', 'b', 'c']) await h.scheduler.register(registration({ subscriptionId: id }));
    h.clock.set(DUE);
    const first = await h.scheduler.tick({ limit: 2 });
    expect(first.due).toBe(2);
    const second = await h.scheduler.tick({ limit: 2 });
    expect(second.charged).toBe(1);
    expect(h.provider.createCalls).toHaveLength(3);
  });
});

describe('pause, resume, cancel', () => {
  it('does nothing while paused, and re-anchors from now if the pause swallowed the due date', async () => {
    const h = makeHarness();
    await h.scheduler.register(registration());
    const paused = await h.scheduler.pause(SID);
    expect(paused.status).toBe(ScheduleStatus.Paused);
    expect(paused.nextActionAt).toBeUndefined();
    expect(paused.nextChargeAt).toBeUndefined();

    await h.tickAt(plusHours(DUE, -48));
    await h.tickAt(DUE);
    const swallowedUntil = plusHours(DUE, 72);
    await h.tickAt(swallowedUntil);
    expect(h.provider.notifyCalls).toHaveLength(0);
    expect(h.provider.createCalls).toHaveLength(0);

    h.clock.set(swallowedUntil);
    const resumed = await h.scheduler.resume(SID);
    expect(resumed).toMatchObject({ status: ScheduleStatus.Active, anchorAt: swallowedUntil, nextChargeAt: swallowedUntil });

    // Notified straight away, debited once the 24h notice has passed.
    await h.tickAt(swallowedUntil);
    expect(h.provider.notifyCalls[0]!.debitAt).toBe(plusHours(swallowedUntil, 24));
    await h.tickAt(plusHours(swallowedUntil, 24));
    expect(h.provider.createCalls).toHaveLength(1);

    // The missed cycle is not billed again; later cycles follow from the new anchor.
    const cycles = await h.scheduler.listCycles(SID);
    expect(cycles).toHaveLength(2);
    expect(cycles[1]!.dueAt).toBe('2026-02-18T04:30:00.000Z');
  });

  it('resumes at a given nextChargeAt', async () => {
    const h = makeHarness();
    await h.scheduler.register(registration());
    await h.scheduler.pause(SID);
    const resumed = await h.scheduler.resume(SID, { nextChargeAt: '2026-02-01T00:00:00.000Z' });
    expect(resumed.nextChargeAt).toBe('2026-02-01T00:00:00.000Z');
    expect((await cycleOf(h)).dueAt).toBe('2026-02-01T00:00:00.000Z');

    expect((await h.tickAt('2026-01-30T00:00:00.000Z')).notified).toBe(1);
    await h.tickAt('2026-02-01T00:00:00.000Z');
    expect(h.provider.createCalls).toHaveLength(1);
  });

  it('keeps the schedule unchanged when the pause did not swallow a due date', async () => {
    const h = makeHarness();
    await h.scheduler.register(registration());
    await h.tickAt('2026-01-02T00:00:00.000Z');
    await h.scheduler.pause(SID);
    h.clock.set('2026-01-03T00:00:00.000Z');
    const resumed = await h.scheduler.resume(SID);
    expect(resumed.anchorAt).toBe(DUE);
    expect((await cycleOf(h)).dueAt).toBe(DUE);
  });

  it('re-notifies after a resume changes the debit date', async () => {
    const h = makeHarness();
    await h.scheduler.register(registration());
    await h.tickAt(plusHours(DUE, -48));
    expect(h.provider.notifyCalls).toHaveLength(1);

    await h.scheduler.pause(SID);
    const newDue = plusHours(DUE, 24 * 30);
    await h.scheduler.resume(SID, { nextChargeAt: newDue });
    expect((await cycleOf(h)).status).toBe(CycleStatus.Pending);

    // The old due date passes: no debit on the stale notice.
    await h.tickAt(plusHours(DUE, 1));
    expect(h.provider.createCalls).toHaveLength(0);

    await h.tickAt(plusHours(newDue, -48));
    expect(h.provider.notifyCalls).toHaveLength(2);
    expect(h.provider.notifyCalls[1]!.notificationId).not.toBe(h.provider.notifyCalls[0]!.notificationId);
    expect(h.provider.notifyCalls[1]!.debitAt).toBe(newDue);
    await h.tickAt(newDue);
    expect(h.provider.createCalls).toHaveLength(1);
  });

  it('is idempotent for pause/resume and rejects invalid transitions', async () => {
    const h = makeHarness();
    await h.scheduler.register(registration());
    expect((await h.scheduler.resume(SID)).status).toBe(ScheduleStatus.Active);
    await h.scheduler.pause(SID);
    expect((await h.scheduler.pause(SID)).status).toBe(ScheduleStatus.Paused);
    await h.scheduler.cancel(SID);
    await expect(h.scheduler.resume(SID)).rejects.toMatchObject({ code: ErrorCode.Conflict });
    await expect(h.scheduler.pause(SID)).rejects.toMatchObject({ code: ErrorCode.Conflict });
    await expect(h.scheduler.pause('missing')).rejects.toMatchObject({ code: ErrorCode.NotFound });
  });

  it('cancel stops notifications and debits, marks the cycle skipped, and is idempotent', async () => {
    const h = makeHarness();
    await h.scheduler.register(registration());
    await h.tickAt(plusHours(DUE, -48));
    const cancelled = await h.scheduler.cancel(SID);
    expect(cancelled).toMatchObject({
      status: ScheduleStatus.Cancelled,
      statusReason: ScheduleStatusReason.CancelledByMerchant,
    });
    expect(cancelled.nextActionAt).toBeUndefined();
    expect((await cycleOf(h)).status).toBe(CycleStatus.Skipped);

    await h.tickAt(DUE);
    await h.tickAt(plusHours(DUE, 24 * 40));
    expect(h.provider.createCalls).toHaveLength(0);
    expect((await h.scheduler.cancel(SID)).status).toBe(ScheduleStatus.Cancelled);
    expect(h.events.filter((e) => e.type === SchedulerEventType.ScheduleCancelled)).toHaveLength(1);
  });

  it('cancel does not forget a debit of unknown outcome, and never re-sends one the gateway never saw', async () => {
    const h = makeHarness();
    h.provider.createScript = [CreateBehaviour.UnknownLost];
    await h.scheduler.register(registration());
    await runCycle(h, DUE);
    expect((await cycleOf(h)).status).toBe(CycleStatus.Charging);

    await h.scheduler.cancel(SID);
    const inFlight = h.events.find((e) => e.type === SchedulerEventType.ChargeInFlight);
    expect(inFlight).toMatchObject({ scheduleId: SID, chargeId: h.provider.createCalls[0]!.chargeId });

    await h.tickAt(plusHours(DUE, 1));
    expect(h.provider.getCalls).toHaveLength(1);
    expect(h.provider.createCalls).toHaveLength(1);
    expect((await cycleOf(h)).status).toBe(CycleStatus.Skipped);
    expect(h.events.some((e) => e.type === SchedulerEventType.CycleSkipped)).toBe(true);
  });

  it('cancel keeps reconciling a charge the gateway holds and records its outcome', async () => {
    const h = makeHarness();
    h.provider.createScript = [CreateBehaviour.Pending];
    await h.scheduler.register(registration());
    await runCycle(h, DUE);
    await h.scheduler.cancel(SID);
    expect(h.events.some((e) => e.type === SchedulerEventType.ChargeInFlight)).toBe(true);

    h.provider.settle(h.provider.createCalls[0]!.chargeId, ChargeStatus.Succeeded);
    await h.tickAt(plusHours(DUE, 1));
    const schedule = await h.scheduler.get(SID);
    expect(schedule).toMatchObject({ status: ScheduleStatus.Cancelled, paidCycles: 1 });
    expect((await cycleOf(h)).status).toBe(CycleStatus.Succeeded);
    expect(h.events.some((e) => e.type === SchedulerEventType.ChargeSucceeded)).toBe(true);
    expect(await h.scheduler.listCycles(SID)).toHaveLength(1);
  });

  it('cancel on a completed schedule throws CONFLICT', async () => {
    const h = makeHarness({ style: Style.OnDue });
    await h.scheduler.register(registration({ totalCycles: 1 }));
    await h.tickAt(DUE);
    expect((await h.scheduler.get(SID))?.status).toBe(ScheduleStatus.Completed);
    await expect(h.scheduler.cancel(SID)).rejects.toMatchObject({ code: ErrorCode.Conflict });
  });
});

describe('updateAmount', () => {
  it('applies to cycles that are not notified yet, and to later cycles', async () => {
    const h = makeHarness();
    await h.scheduler.register(registration());
    await h.scheduler.updateAmount(SID, 59900);
    await h.tickAt(plusHours(DUE, -48));
    expect(h.provider.notifyCalls[0]!.amount).toBe(59900);

    // Already notified at 59,900: a later change must not alter this cycle.
    await h.scheduler.updateAmount(SID, 69900);
    await h.tickAt(DUE);
    expect(h.provider.createCalls[0]!.amount).toBe(59900);

    await h.tickAt('2026-02-13T04:30:00.000Z');
    expect(h.provider.notifyCalls[1]!.amount).toBe(69900);
  });

  it('validates the amount and rejects terminal schedules', async () => {
    const h = makeHarness();
    await h.scheduler.register(registration());
    await expect(h.scheduler.updateAmount(SID, 0)).rejects.toMatchObject({ code: ErrorCode.Validation });
    await expect(h.scheduler.updateAmount(SID, 99.5)).rejects.toMatchObject({ code: ErrorCode.Validation });
    await h.scheduler.cancel(SID);
    await expect(h.scheduler.updateAmount(SID, 100)).rejects.toMatchObject({ code: ErrorCode.Conflict });
    await expect(h.scheduler.updateAmount('missing', 100)).rejects.toMatchObject({ code: ErrorCode.NotFound });
  });
});

describe('register', () => {
  it('is idempotent for the same data and conflicts for different data', async () => {
    const h = makeHarness();
    const first = await h.scheduler.register(registration());
    const again = await h.scheduler.register(registration());
    expect(again).toEqual(first);
    // The same instant written with another offset is the same data.
    const sameInstant = await h.scheduler.register(registration({ firstChargeAt: '2026-01-15T10:00:00+05:30' }));
    expect(sameInstant).toEqual(first);
    expect(h.events.filter((e) => e.type === SchedulerEventType.ScheduleRegistered)).toHaveLength(1);

    await expect(h.scheduler.register(registration({ amount: 100 }))).rejects.toMatchObject({ code: ErrorCode.Conflict });
    await expect(h.scheduler.register(registration({ maxAttempts: 5 }))).rejects.toMatchObject({ code: ErrorCode.Conflict });
  });

  it('handles concurrent identical registrations', async () => {
    const h = makeHarness();
    const results = await Promise.all([h.scheduler.register(registration()), h.scheduler.register(registration())]);
    expect(results[0]).toEqual(results[1]);
    expect(await h.scheduler.listCycles(SID)).toHaveLength(1);
  });

  it('defaults the id to the provider-scoped reference or subscription id, accepts an explicit one, and stores plain JSON', async () => {
    const h = makeHarness();
    const byDefault = await h.scheduler.register(registration());
    expect(byDefault.id).toBe(scheduleIdFor(Provider.PayU, 'sub_1'));
    expect(byDefault.id).toBe(SID);
    const byReference = await h.scheduler.register(registration({ subscriptionId: 'sub_9', reference: 'ref_9' }));
    expect(byReference.id).toBe(scheduleIdFor(Provider.PayU, 'ref_9'));
    const explicit = await h.scheduler.register(registration({ id: 'order_7', subscriptionId: 'sub_2', reference: 'order_7' }));
    expect(explicit).toMatchObject({ id: 'order_7', subscriptionId: 'sub_2', reference: 'order_7', currency: 'INR' });
    expect(JSON.parse(JSON.stringify(explicit))).toEqual(explicit);
    expect(await h.scheduler.findBySubscriptionId(Provider.PayU, 'sub_2')).toEqual(explicit);
    expect(await h.scheduler.get('nope')).toBeUndefined();
  });

  it('applies defaults and per-schedule policy overrides to the stored policy', async () => {
    const h = makeHarness({ scheduler: { maxAttempts: 4 } });
    const schedule = await h.scheduler.register(registration({ retryIntervalHours: 6 }));
    expect(schedule.policy).toEqual({ notifyLeadHours: 48, minNoticeHours: 24, maxAttempts: 4, retryIntervalHours: 6 });
  });

  it('rejects invalid input and gateways that raise their own debits', async () => {
    const h = makeHarness();
    await expect(h.scheduler.register(registration({ amount: 12.5 }))).rejects.toMatchObject({ code: ErrorCode.Validation });
    await expect(h.scheduler.register(registration({ firstChargeAt: 'tomorrow' }))).rejects.toMatchObject({
      code: ErrorCode.Validation,
    });

    const gatewayScheduled = makeHarness({ merchantCharges: false });
    await expect(gatewayScheduled.scheduler.register(registration())).rejects.toMatchObject({ code: ErrorCode.Unsupported });
  });

  it('throws only SubscriptionError', async () => {
    const h = makeHarness();
    const failure = await h.scheduler.register(registration({ amount: -1 })).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SubscriptionError);
  });
});

describe('events', () => {
  it('a throwing onEvent listener never affects billing', async () => {
    const store = new MemorySchedulerStore();
    const provider = new FakeProvider({ style: Style.OnDue });
    const scheduler = new BillingScheduler({
      store,
      resolveProvider: () => provider,
      now: () => new Date(DUE),
      onEvent: () => {
        throw new Error('listener bug');
      },
    });
    await scheduler.register(registration());
    const result = await scheduler.tick();
    expect(result.succeeded).toBe(1);
    expect(result.errors).toHaveLength(0);
  });
});
