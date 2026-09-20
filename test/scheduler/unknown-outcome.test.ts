import { describe, expect, it } from 'vitest';
import { ChargeKind, ChargeStatus, Currency, ErrorCode, Provider } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import { CycleStatus, ScheduleStatus, SchedulerEventType } from '../../src/scheduler/index.js';
import { CreateBehaviour, DUE, SID, Style, makeHarness, registration, type Harness } from './helpers.js';

const MINUTE = 60 * 1000;
const at = (iso: string, minutes: number): string => new Date(Date.parse(iso) + minutes * MINUTE).toISOString();

/** A gateway with no lead and no notification: the debit is sent at DUE and its answer is lost. */
async function lostAtDue(options: Parameters<typeof makeHarness>[0] = {}, overrides = {}): Promise<Harness> {
  const h = makeHarness({ style: Style.OnDue, ...options });
  h.provider.createScript = [CreateBehaviour.UnknownLost];
  await h.scheduler.register(registration(overrides));
  await h.tickAt(DUE);
  expect(h.provider.createCalls).toHaveLength(1);
  return h;
}

const cycle = async (h: Harness) => h.store.getCycle(SID, 0);
const overdue = (h: Harness) => h.events.filter((event) => event.type === SchedulerEventType.ChargeOutcomeOverdue);

describe('a debit of unknown outcome is not sent again too soon', () => {
  it('records when the debit was sent', async () => {
    const h = await lostAtDue();
    expect((await cycle(h))?.chargeSentAt).toBe(DUE);
    expect((await cycle(h))?.status).toBe(CycleStatus.Charging);
  });

  it('NOT_FOUND inside the grace window: no resubmission, the cycle stays charging and is asked again later', async () => {
    const h = await lostAtDue();
    const early = await h.tickAt(at(DUE, 10));
    expect(early.errors).toStrictEqual([]);
    expect(h.provider.getCalls).toHaveLength(1);
    expect(h.provider.createCalls).toHaveLength(1);
    expect((await cycle(h))?.status).toBe(CycleStatus.Charging);
    expect(overdue(h)).toHaveLength(0);

    await h.tickAt(at(DUE, 29));
    expect(h.provider.getCalls).toHaveLength(2);
    expect(h.provider.createCalls).toHaveLength(1);
  });

  it('NOT_FOUND after the grace window: exactly one resubmission, with the same charge id', async () => {
    const h = await lostAtDue();
    await h.tickAt(at(DUE, 10));
    const late = await h.tickAt(at(DUE, 31));
    expect(h.provider.createCalls).toHaveLength(2);
    expect(h.provider.createCalls[1]?.chargeId).toBe(h.provider.createCalls[0]?.chargeId);
    expect(late.succeeded).toBe(1);
    expect(h.provider.gateway.size).toBe(1);
    expect((await cycle(h))?.status).toBe(CycleStatus.Succeeded);
    expect(overdue(h)).toHaveLength(1);

    await h.tickAt(at(DUE, 60));
    expect(h.provider.createCalls).toHaveLength(2);
  });

  it('a second lost answer restarts the grace window instead of resubmitting again at once', async () => {
    const h = makeHarness({ style: Style.OnDue });
    h.provider.createScript = [CreateBehaviour.UnknownLost, CreateBehaviour.UnknownLost];
    await h.scheduler.register(registration());
    await h.tickAt(DUE);
    await h.tickAt(at(DUE, 31));
    expect(h.provider.createCalls).toHaveLength(2);
    expect((await cycle(h))?.chargeSentAt).toBe(at(DUE, 31));
    await h.tickAt(at(DUE, 40));
    expect(h.provider.createCalls).toHaveLength(2);
    await h.tickAt(at(DUE, 62));
    expect(h.provider.createCalls).toHaveLength(3);
    expect(new Set(h.provider.createCalls.map((call) => call.chargeId)).size).toBe(1);
  });

  it('a debit that shows up late is honoured and never duplicated', async () => {
    const h = await lostAtDue();
    await h.tickAt(at(DUE, 10));
    const chargeId = h.provider.createCalls[0]!.chargeId;
    // The gateway registers the debit a little later than the merchant asked.
    h.provider.gateway.set(chargeId, {
      provider: Provider.PayU,
      id: `pay_${chargeId}`,
      reference: chargeId,
      subscriptionId: 'sub_1',
      kind: ChargeKind.Recurring,
      status: ChargeStatus.Succeeded,
      amount: 49900,
      currency: Currency.INR,
      raw: null,
    });
    const found = await h.tickAt(at(DUE, 20));
    expect(found.succeeded).toBe(1);
    await h.tickAt(at(DUE, 120));
    expect(h.provider.createCalls).toHaveLength(1);
    expect((await cycle(h))?.status).toBe(CycleStatus.Succeeded);
  });

  it('a debit that shows up after the first NOT_FOUND but before the window ends is never re-created', async () => {
    const h = await lostAtDue();
    await h.tickAt(at(DUE, 29));
    h.provider.gateway.set(h.provider.createCalls[0]!.chargeId, {
      provider: Provider.PayU,
      id: 'pay_late',
      subscriptionId: 'sub_1',
      kind: ChargeKind.Recurring,
      status: ChargeStatus.Failed,
      amount: 49900,
      raw: null,
    });
    await h.tickAt(at(DUE, 45));
    // It failed at the gateway: that is a failed attempt (a retry has a NEW id), not a resubmission of the same one.
    expect(h.provider.createCalls).toHaveLength(1);
    expect((await cycle(h))?.attempt).toBe(2);
  });

  it('an unanswerable gateway past the grace window raises an operator event and nothing is resubmitted', async () => {
    const h = await lostAtDue();
    h.provider.getChargeError = new SubscriptionError(ErrorCode.Timeout, 'timed out', { provider: Provider.PayU });
    await h.tickAt(at(DUE, 10));
    expect(overdue(h)).toHaveLength(0);
    const late = await h.tickAt(at(DUE, 45));
    expect(late.errors[0]?.code).toBe(ErrorCode.Timeout);
    expect(overdue(h)).toHaveLength(1);
    expect(overdue(h)[0]).toMatchObject({ scheduleId: SID, cycleIndex: 0 });
    expect(h.provider.createCalls).toHaveLength(1);
  });

  it('the window is a per-schedule policy', async () => {
    const h = await lostAtDue({}, { unknownOutcomeGraceMinutes: 120 });
    expect((await h.scheduler.get(SID))?.policy.unknownOutcomeGraceMinutes).toBe(120);
    await h.tickAt(at(DUE, 90));
    expect(h.provider.createCalls).toHaveLength(1);
    await h.tickAt(at(DUE, 121));
    expect(h.provider.createCalls).toHaveLength(2);
  });

  it('the window is a scheduler-wide default, and zero means immediately', async () => {
    const quick = await lostAtDue({ scheduler: { unknownOutcomeGraceMinutes: 0 } });
    await quick.tickAt(at(DUE, 1));
    expect(quick.provider.createCalls).toHaveLength(2);

    const slow = await lostAtDue({ scheduler: { unknownOutcomeGraceMinutes: 6 * 60 } });
    await slow.tickAt(at(DUE, 5 * 60));
    expect(slow.provider.createCalls).toHaveLength(1);
    await slow.tickAt(at(DUE, 6 * 60 + 1));
    expect(slow.provider.createCalls).toHaveLength(2);
  });

  it('crash recovery (charging persisted, call never left) follows the same rule', async () => {
    const h = makeHarness({ style: Style.OnDue });
    h.provider.onCreate = () => {
      throw new Error('process crashed');
    };
    await h.scheduler.register(registration());
    await h.tickAt(DUE);
    h.provider.onCreate = undefined;
    expect((await cycle(h))?.status).toBe(CycleStatus.Charging);

    await h.tickAt(at(DUE, 5));
    expect(h.provider.createCalls).toHaveLength(1);
    await h.tickAt(at(DUE, 31));
    expect(h.provider.createCalls).toHaveLength(2);
    expect((await cycle(h))?.status).toBe(CycleStatus.Succeeded);
  });

  it('a paused schedule keeps its unknown debit during the window and drops it only after', async () => {
    const h = await lostAtDue();
    await h.scheduler.pause(SID);
    await h.tickAt(at(DUE, 10));
    expect((await cycle(h))?.status).toBe(CycleStatus.Charging);
    await h.tickAt(at(DUE, 31));
    expect(h.provider.createCalls).toHaveLength(1);
    expect((await cycle(h))?.status).toBe(CycleStatus.Pending);
    expect((await h.scheduler.get(SID))?.status).toBe(ScheduleStatus.Paused);
  });
});
