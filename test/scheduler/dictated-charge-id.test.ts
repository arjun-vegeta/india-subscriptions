import { describe, expect, it } from 'vitest';
import { ChargeStatus, EventType } from '../../src/constants.js';
import { CycleStatus } from '../../src/scheduler/index.js';
import { CreateBehaviour, DUE, SID, makeEvent, makeHarness, plusHours, registration } from './helpers.js';

/** A gateway that ties the debit to its notification (PhonePe): the notification names the id the debit must use. */
function dictating() {
  const h = makeHarness();
  let counter = 0;
  h.provider.dictateChargeId = (input) => `ORDER-${++counter}-${'x'.repeat(40)}-${input.amount}`;
  return h;
}

describe('a notification that dictates the id of the debit that follows it', () => {
  it('the dictated id (as given, even when long) is saved with the notification and used for createCharge and the attempt record', async () => {
    const h = dictating();
    await h.scheduler.register(registration());
    await h.tickAt(plusHours(DUE, -48));
    const notified = await h.store.getCycle(SID, 0);
    expect(notified).toMatchObject({ status: CycleStatus.Notified });
    const dictated = notified?.chargeId as string;
    expect(dictated).toMatch(/^ORDER-1-x{40}-/);
    expect(dictated.length).toBeGreaterThan(25);
    expect(dictated).not.toBe(notified?.notificationId);

    await h.tickAt(DUE);
    expect(h.provider.createCalls.map((call) => call.chargeId)).toEqual([dictated]);
    expect(await h.store.getCycle(SID, 0)).toMatchObject({ status: CycleStatus.Succeeded, chargeId: dictated });
    expect((await h.store.getCycle(SID, 0))?.attempts[0]?.chargeId).toBe(dictated);
  });

  it('a lost answer is reconciled with getCharge under that id and the same id is re-sent, never a new one; never two debits for the cycle', async () => {
    const h = dictating();
    h.provider.createScript = [CreateBehaviour.UnknownLost];
    await h.scheduler.register(registration());
    await h.tickAt(plusHours(DUE, -48));
    const dictated = (await h.store.getCycle(SID, 0))?.chargeId as string;
    await h.tickAt(DUE);
    expect((await h.store.getCycle(SID, 0))?.status).toBe(CycleStatus.Charging);
    await h.tickAt(plusHours(DUE, 0.1));
    expect(h.provider.getCalls.at(-1)?.chargeId).toBe(dictated);
    await h.tickAt(plusHours(DUE, 1));
    expect(h.provider.createCalls.map((call) => call.chargeId)).toEqual([dictated, dictated]);
    expect(h.provider.gateway.size).toBe(1);
    expect(await h.scheduler.get(SID)).toMatchObject({ paidCycles: 1 });
  });

  it('a failed attempt is retried after a fresh notification, which dictates a new id; the old id is never reused', async () => {
    const h = dictating();
    h.provider.createScript = [CreateBehaviour.Fail];
    await h.scheduler.register(registration());
    await h.tickAt(plusHours(DUE, -48));
    const first = (await h.store.getCycle(SID, 0))?.chargeId as string;
    await h.tickAt(DUE);
    // The failed attempt is settled and attempt 2 is notified at once; its notification dictates a NEW id.
    const retry = await h.store.getCycle(SID, 0);
    expect(retry).toMatchObject({ attempt: 2, status: CycleStatus.Notified });
    expect(retry?.chargeId).toMatch(/^ORDER-2-/);
    await h.tickAt(plusHours(DUE, 24));
    await h.tickAt(plusHours(DUE, 49));
    const ids = h.provider.createCalls.map((call) => call.chargeId);
    expect(ids[0]).toBe(first);
    expect(ids).toHaveLength(2);
    expect(ids[1]).not.toBe(first);
    expect(ids[1]).toMatch(/^ORDER-2-/);
    expect(await h.scheduler.get(SID)).toMatchObject({ paidCycles: 1 });
  });

  it('a webhook that carries the dictated id (and no subscription) is matched to the cycle', async () => {
    const h = dictating();
    h.provider.createScript = [CreateBehaviour.Pending];
    await h.scheduler.register(registration());
    await h.tickAt(plusHours(DUE, -48));
    await h.tickAt(DUE);
    const dictated = (await h.store.getCycle(SID, 0))?.chargeId as string;
    expect(await h.store.findScheduleByChargeId(dictated)).toMatchObject({ id: SID });
    await h.scheduler.handleEvent(
      makeEvent({ type: EventType.SubscriptionCharged, subscriptionId: undefined, charge: { chargeId: dictated, status: ChargeStatus.Succeeded } }),
    );
    expect(await h.store.getCycle(SID, 0)).toMatchObject({ status: CycleStatus.Succeeded });
  });
});
