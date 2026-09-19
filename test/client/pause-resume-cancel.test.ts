import { describe, expect, it } from 'vitest';
import { CancelMode, ErrorCode, Provider, SubscriptionStatus } from '../../src/constants.js';
import { CycleStatus, ScheduleStatus, ScheduleStatusReason } from '../../src/scheduler/index.js';
import {
  CYCLE_2,
  CYCLE_3,
  GatewayMethod,
  Style,
  T0,
  TRIAL_END,
  createAndAuthorize,
  cyclesOf,
  makeWorld,
  plusHours,
  scheduleOf,
  trialInput,
  type GatewayOptions,
  type World,
} from './helpers.js';

const PAYU = Provider.PayU;
const notifyAt = (due: string): string => plusHours(due, -48);
/** A moment well after the second cycle's due date, used for resuming. */
const LATE = '2026-03-20T00:00:00.000Z';
const APRIL_20 = '2026-04-20T00:00:00.000Z';

type Spec = Omit<GatewayOptions, 'clock' | 'log'>;

/** Authorised, trial over, first cycle paid at TRIAL_END; the clock stands at TRIAL_END. */
async function afterFirstCharge(spec: Spec = { style: Style.Notify }) {
  const world = makeWorld({ gateways: [spec] });
  const created = await world.subs.create(PAYU, trialInput());
  world.setClock(plusHours(T0, 1));
  await world.subs.verifyCheckout(PAYU, world.gateway.authorize(created.id));
  await world.at(notifyAt(TRIAL_END));
  await world.at(TRIAL_END);
  expect(world.gateway.callsTo(GatewayMethod.CreateCharge)).toHaveLength(1);
  return { world, id: created.id };
}

const debits = (world: World): number => world.gateway.callsTo(GatewayMethod.CreateCharge).length;
const notices = (world: World): number => world.gateway.callsTo(GatewayMethod.NotifyCharge).length;

describe('pause / resume: provider WITHOUT a gateway pause operation', () => {
  it('pause stops the scheduler only: status paused, gateway pause not attempted, no debits or notices while paused', async () => {
    const { world, id } = await afterFirstCharge();
    const paused = await world.subs.pause(PAYU, id);

    expect(paused.status).toBe(SubscriptionStatus.Paused);
    expect(paused.paidCycles).toBe(1);
    expect(paused.nextChargeAt).toBeUndefined();
    expect(world.gateway.callsTo(GatewayMethod.PauseSubscription)).toHaveLength(0);
    expect(world.gateway.callsTo(GatewayMethod.GetSubscription)).toHaveLength(1);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Paused);
    expect((await world.subs.get(PAYU, id)).status).toBe(SubscriptionStatus.Paused);

    for (const probe of [notifyAt(CYCLE_2), CYCLE_2, notifyAt(CYCLE_3), CYCLE_3, LATE]) {
      expect(await world.at(probe)).toMatchObject({ notified: 0, charged: 0 });
    }
    expect(debits(world)).toBe(1);
    expect(notices(world)).toBe(1);
  });

  it('pausing twice is harmless', async () => {
    const { world, id } = await afterFirstCharge();
    await world.subs.pause(PAYU, id);
    expect((await world.subs.pause(PAYU, id)).status).toBe(SubscriptionStatus.Paused);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Paused);
  });

  it('resume continues billing from the next cycle and never bills the cycles that fell due while paused', async () => {
    const { world, id } = await afterFirstCharge();
    world.setClock(plusHours(TRIAL_END, 24));
    await world.subs.pause(PAYU, id);
    await world.at(CYCLE_2); // the second cycle's due date passes while paused
    await world.at(CYCLE_3);
    world.setClock(LATE);
    const resumed = await world.subs.resume(PAYU, id);

    expect(resumed.status).toBe(SubscriptionStatus.Active);
    expect(world.gateway.callsTo(GatewayMethod.ResumeSubscription)).toHaveLength(0);
    expect(debits(world)).toBe(1); // nothing retroactive at the moment of resuming

    // Notice at once, debit 24h later: ONE debit for the swallowed cycle ...
    expect(await world.at(LATE)).toMatchObject({ notified: 1, charged: 0 });
    expect(await world.at(plusHours(LATE, 24))).toMatchObject({ charged: 1, succeeded: 1 });
    expect(debits(world)).toBe(2);
    let sub = await world.subs.get(PAYU, id);
    expect(sub.status).toBe(SubscriptionStatus.Active);
    expect(sub.paidCycles).toBe(2);
    expect(sub.nextChargeAt).toBe(APRIL_20);

    // ... and the last cycle a month after the resume date, not immediately.
    expect(await world.at(plusHours(LATE, 48))).toMatchObject({ charged: 0 });
    await world.at(notifyAt(APRIL_20));
    await world.at(APRIL_20);
    sub = await world.subs.get(PAYU, id);
    expect(debits(world)).toBe(3);
    expect(sub.status).toBe(SubscriptionStatus.Completed);
    expect(sub.paidCycles).toBe(3);
  });

  it('resume({ nextChargeAt }) re-anchors the next debit to that date', async () => {
    const { world, id } = await afterFirstCharge();
    await world.subs.pause(PAYU, id);
    world.setClock(LATE);
    const nextChargeAt = '2026-04-01T00:00:00.000Z';
    const resumed = await world.subs.resume(PAYU, id, { nextChargeAt });
    expect(resumed.nextChargeAt).toBe(nextChargeAt);
    expect(await world.at(plusHours(nextChargeAt, -49))).toMatchObject({ notified: 0 });
    expect(await world.at(notifyAt(nextChargeAt))).toMatchObject({ notified: 1 });
    expect(await world.at(nextChargeAt)).toMatchObject({ charged: 1, succeeded: 1 });
    expect(world.gateway.callsTo(GatewayMethod.CreateCharge)[1]?.at).toBe(nextChargeAt);
  });

  it('resume of a subscription that was not paused is a no-op for billing', async () => {
    const { world, id } = await afterFirstCharge();
    const before = await scheduleOf(world);
    const resumed = await world.subs.resume(PAYU, id);
    expect(resumed.status).toBe(SubscriptionStatus.Active);
    expect(await scheduleOf(world)).toStrictEqual(before);
  });

  it('pause before the customer has authorised is refused with CONFLICT and the gateway is never asked', async () => {
    const world = makeWorld();
    const created = await world.subs.create(PAYU, trialInput());
    await expect(world.subs.pause(PAYU, created.id)).rejects.toMatchObject({ code: ErrorCode.Conflict });
    expect(world.gateway.callsTo(GatewayMethod.PauseSubscription)).toHaveLength(0);
    expect(world.gateway.callsTo(GatewayMethod.GetSubscription)).toHaveLength(0);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.PendingAuthorization);
  });

  it('pausing during the trial keeps the trial date; resuming before it needs no re-anchoring', async () => {
    const world = makeWorld();
    const { created } = await createAndAuthorize(world);
    const paused = await world.subs.pause(PAYU, created.id);
    expect(paused.status).toBe(SubscriptionStatus.Paused);
    const resumed = await world.subs.resume(PAYU, created.id);
    expect(resumed.status).toBe(SubscriptionStatus.Trialing);
    expect(resumed.trialEndsAt).toBe(TRIAL_END);
    await world.at(notifyAt(TRIAL_END));
    await world.at(TRIAL_END);
    expect(debits(world)).toBe(1);
  });
});

describe('pause / resume: provider WITH a gateway pause operation', () => {
  const spec: Spec = { style: Style.Notify, pause: true, resume: true };

  it('pause tells the scheduler and the gateway; options reach the gateway; status paused; no debits', async () => {
    const { world, id } = await afterFirstCharge(spec);
    const options = { resumeAt: '2026-06-01T00:00:00.000Z' };
    const paused = await world.subs.pause(PAYU, id, options);
    expect(paused.status).toBe(SubscriptionStatus.Paused);
    expect(world.gateway.callsTo(GatewayMethod.PauseSubscription)).toHaveLength(1);
    expect(world.gateway.callsTo(GatewayMethod.PauseSubscription)[0]?.args).toStrictEqual([id, options]);
    expect(world.gateway.callsTo(GatewayMethod.GetSubscription)).toHaveLength(0);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Paused);
    for (const probe of [notifyAt(CYCLE_2), CYCLE_2, CYCLE_3]) await world.at(probe);
    expect(debits(world)).toBe(1);
    expect(notices(world)).toBe(1);
  });

  it('resume tells the gateway and the scheduler and billing continues', async () => {
    const { world, id } = await afterFirstCharge(spec);
    await world.subs.pause(PAYU, id);
    world.setClock(LATE);
    const resumed = await world.subs.resume(PAYU, id, { nextChargeAt: '2026-04-01T00:00:00.000Z' });
    expect(resumed.status).toBe(SubscriptionStatus.Active);
    expect(world.gateway.callsTo(GatewayMethod.ResumeSubscription)).toHaveLength(1);
    expect(world.gateway.callsTo(GatewayMethod.ResumeSubscription)[0]?.args).toStrictEqual([
      id,
      { nextChargeAt: '2026-04-01T00:00:00.000Z' },
    ]);
    expect(world.gateway.sub(id).status).toBe(SubscriptionStatus.Active);
    await world.at(notifyAt('2026-04-01T00:00:00.000Z'));
    await world.at('2026-04-01T00:00:00.000Z');
    expect(debits(world)).toBe(2);
  });

  it('stops the scheduler before telling the gateway to pause (the safe order), and the reverse on resume', async () => {
    const { world, id } = await afterFirstCharge(spec);
    world.log.length = 0;
    await world.subs.pause(PAYU, id);
    const pauseLog = world.log.filter((entry) => entry.startsWith('store.saveSchedule') || entry.includes(GatewayMethod.PauseSubscription));
    expect(pauseLog[0]).toBe('store.saveSchedule');
    expect(pauseLog.at(-1)).toBe(`${PAYU}.${GatewayMethod.PauseSubscription}`);

    world.log.length = 0;
    await world.subs.resume(PAYU, id);
    const resumeLog = world.log.filter((entry) => entry.startsWith('store.saveSchedule') || entry.includes(GatewayMethod.ResumeSubscription));
    expect(resumeLog[0]).toBe(`${PAYU}.${GatewayMethod.ResumeSubscription}`);
    expect(resumeLog.at(-1)).toBe('store.saveSchedule');
  });

  // DEFECT: pause({ resumeAt }) is forwarded to the gateway, which resumes the mandate by itself at that instant, but
  // the billing scheduler has no auto-resume and stays paused for ever. The caller asked for "pause until X" and
  // gets "pause until someone remembers": no debit is ever raised again, and get() keeps saying paused.
  it.fails('pause({ resumeAt }) on a provider with gateway pause resumes billing at resumeAt', async () => {
    const { world, id } = await afterFirstCharge(spec);
    const resumeAt = '2026-02-20T00:00:00.000Z';
    await world.subs.pause(PAYU, id, { resumeAt });
    for (const probe of [CYCLE_2, resumeAt, plusHours(resumeAt, 24), notifyAt(CYCLE_3), CYCLE_3, plusHours(CYCLE_3, 24)]) {
      await world.at(probe);
    }
    expect(debits(world)).toBeGreaterThan(1);
  });

  // DEFECT (same cause, silent variant): without a gateway pause the option is dropped without a word.
  it.fails('pause({ resumeAt }) without a gateway pause resumes billing at resumeAt (or is refused)', async () => {
    const { world, id } = await afterFirstCharge();
    const resumeAt = '2026-02-20T00:00:00.000Z';
    let refused = false;
    try {
      await world.subs.pause(PAYU, id, { resumeAt });
    } catch {
      refused = true;
    }
    if (!refused) {
      // Accepted: then it has to honour it.
      for (const probe of [CYCLE_2, resumeAt, plusHours(resumeAt, 24), notifyAt(CYCLE_3), CYCLE_3, plusHours(CYCLE_3, 24)]) {
        await world.at(probe);
      }
      expect(debits(world)).toBeGreaterThan(1);
    }
    expect(refused || debits(world) > 1).toBe(true);
  });

  it('a gateway pause that fails after the scheduler was paused leaves billing stopped and surfaces the error', async () => {
    const { world, id } = await afterFirstCharge(spec);
    world.gateway.failOnce(GatewayMethod.PauseSubscription);
    await expect(world.subs.pause(PAYU, id)).rejects.toMatchObject({ code: ErrorCode.ProviderUnavailable });
    // Documented behaviour: the scheduler is already paused (safe direction: no debits), the gateway is not.
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Paused);
    expect(world.gateway.sub(id).status).toBe(SubscriptionStatus.Active);
    expect(await world.at(CYCLE_2)).toMatchObject({ charged: 0 });
    // Retrying finishes the job.
    expect((await world.subs.pause(PAYU, id)).status).toBe(SubscriptionStatus.Paused);
    expect(world.gateway.sub(id).status).toBe(SubscriptionStatus.Paused);
  });
});

describe('cancel', () => {
  it('cancels the schedule and the gateway mandate (once); nothing is notified or debited afterwards', async () => {
    const { world, id } = await afterFirstCharge();
    const cancelled = await world.subs.cancel(PAYU, id);

    expect(cancelled.status).toBe(SubscriptionStatus.Cancelled);
    expect(world.gateway.callsTo(GatewayMethod.CancelSubscription)).toHaveLength(1);
    expect(world.gateway.callsTo(GatewayMethod.CancelSubscription)[0]?.args[0]).toBe(id);
    const schedule = await scheduleOf(world);
    expect(schedule.status).toBe(ScheduleStatus.Cancelled);
    expect(schedule.statusReason).toBe(ScheduleStatusReason.CancelledByMerchant);
    expect(schedule.nextChargeAt).toBeUndefined();
    expect((await cyclesOf(world))[1]?.status).toBe(CycleStatus.Skipped);

    for (const probe of [notifyAt(CYCLE_2), CYCLE_2, notifyAt(CYCLE_3), CYCLE_3, LATE]) {
      expect(await world.at(probe)).toMatchObject({ notified: 0, charged: 0, errors: [] });
    }
    expect(debits(world)).toBe(1);
    expect(notices(world)).toBe(1);
    const read = await world.subs.get(PAYU, id);
    expect(read.status).toBe(SubscriptionStatus.Cancelled);
    expect(read.paidCycles).toBe(1);
    expect(read.nextChargeAt).toBeUndefined();
  });

  it('cancelling after the pre-debit notice but before the debit means the customer is never debited', async () => {
    const { world, id } = await afterFirstCharge();
    await world.at(notifyAt(CYCLE_2));
    expect(notices(world)).toBe(2);
    await world.subs.cancel(PAYU, id);
    await world.at(CYCLE_2);
    await world.at(plusHours(CYCLE_2, 48));
    expect(debits(world)).toBe(1);
  });

  it('cancelling while paused works', async () => {
    const { world, id } = await afterFirstCharge();
    await world.subs.pause(PAYU, id);
    const cancelled = await world.subs.cancel(PAYU, id);
    expect(cancelled.status).toBe(SubscriptionStatus.Cancelled);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Cancelled);
  });

  it('cancelling twice leaves it cancelled and bills nothing', async () => {
    const { world, id } = await afterFirstCharge();
    await world.subs.cancel(PAYU, id);
    const again = await world.subs.cancel(PAYU, id);
    expect(again.status).toBe(SubscriptionStatus.Cancelled);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Cancelled);
    await world.at(CYCLE_3);
    expect(debits(world)).toBe(1);
  });

  it('cancel BEFORE authorisation: schedule cancelled, gateway cancelled once, later authorisation cannot start billing', async () => {
    const world = makeWorld();
    const created = await world.subs.create(PAYU, trialInput());
    const cancelled = await world.subs.cancel(PAYU, created.id);
    expect(cancelled.status).toBe(SubscriptionStatus.Cancelled);
    expect(world.gateway.callsTo(GatewayMethod.CancelSubscription)).toHaveLength(1);
    const schedule = await scheduleOf(world);
    expect(schedule.status).toBe(ScheduleStatus.Cancelled);
    expect(schedule.statusReason).toBe(ScheduleStatusReason.CancelledByMerchant);
    expect(await cyclesOf(world)).toHaveLength(0);

    const late = await world.subs.verifyCheckout(PAYU, world.gateway.authorize(created.id));
    expect(late.authorized).toBe(false);
    for (const probe of [notifyAt(TRIAL_END), TRIAL_END, CYCLE_3]) await world.at(probe);
    expect(debits(world)).toBe(0);
    expect(notices(world)).toBe(0);
  });

  it('cancel during the trial: no notice, no debit', async () => {
    const world = makeWorld();
    const { created } = await createAndAuthorize(world);
    await world.subs.cancel(PAYU, created.id, { mode: CancelMode.Immediately });
    for (const probe of [notifyAt(TRIAL_END), TRIAL_END, CYCLE_2]) await world.at(probe);
    expect(debits(world)).toBe(0);
    expect(notices(world)).toBe(0);
    expect(world.gateway.callsTo(GatewayMethod.CancelSubscription)[0]?.args).toStrictEqual([created.id, { mode: CancelMode.Immediately }]);
  });

  it('cancel after the subscription completed: the gateway is cancelled first, then the scheduler refuses with CONFLICT', async () => {
    const { world, id } = await afterFirstCharge();
    for (const due of [CYCLE_2, CYCLE_3]) {
      await world.at(notifyAt(due));
      await world.at(due);
    }
    expect((await world.subs.get(PAYU, id)).status).toBe(SubscriptionStatus.Completed);
    // Documented behaviour: the mandate of a completed subscription is still live at the gateway (the facade
    // never closes it), and cancelling it reaches the gateway before the scheduler's refusal is raised.
    expect(world.gateway.callsTo(GatewayMethod.CancelSubscription)).toHaveLength(0);
    expect(world.gateway.sub(id).status).toBe(SubscriptionStatus.Active);
    await expect(world.subs.cancel(PAYU, id)).rejects.toMatchObject({ code: ErrorCode.Conflict });
    expect(world.gateway.callsTo(GatewayMethod.CancelSubscription)).toHaveLength(1);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Completed);
  });
});
