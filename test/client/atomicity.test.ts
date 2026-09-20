import { describe, expect, it } from 'vitest';
import { ErrorCode, EventType, Provider, SubscriptionStatus } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import { CycleStatus, ScheduleStatus, type CycleRecord, type ScheduleRecord } from '../../src/scheduler/index.js';
import {
  AMOUNT,
  CYCLE_2,
  GatewayMethod,
  STORE_DOWN,
  StoreMethod,
  Style,
  T0,
  TRIAL_END,
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
type Spec = Omit<GatewayOptions, 'clock' | 'log'>;

const scheduleIs = (status: ScheduleStatus) => (argument: unknown) => (argument as ScheduleRecord).status === status;
const cycleIs = (status: CycleStatus) => (argument: unknown) => (argument as CycleRecord).status === status;

async function authorised(spec: Spec = { style: Style.Notify }, scheduler: { lockWaitMs?: number } = {}) {
  const world = makeWorld({ gateways: [spec], scheduler });
  const created = await world.subs.create(PAYU, trialInput());
  world.setClock(plusHours(T0, 1));
  await world.subs.verifyCheckout(PAYU, world.gateway.authorize(created.id));
  return { world, id: created.id };
}

const debits = (world: World): number => world.gateway.callsTo(GatewayMethod.CreateCharge).length;

describe('failure atomicity: create when the scheduler store throws', () => {
  it('rejects with the store error after the gateway subscription was created: nothing is scheduled', async () => {
    const world = makeWorld();
    world.store.fail(StoreMethod.SaveSchedule);
    await expect(world.subs.create(PAYU, trialInput())).rejects.toThrow(STORE_DOWN);
    // Documented state: a subscription exists at the gateway, the caller never saw its id, no schedule is stored.
    expect(world.gateway.callsTo(GatewayMethod.CreateSubscription)).toHaveLength(1);
    expect(world.gateway.subscriptions.size).toBe(1);
    expect(await world.scheduler?.get(trialInput().reference as string)).toBeUndefined();
  });

  it('retrying with the same idempotency key reuses the gateway subscription and registers the schedule', async () => {
    const world = makeWorld();
    const input = trialInput({ idempotencyKey: 'idem-1' });
    world.store.fail(StoreMethod.SaveSchedule);
    await expect(world.subs.create(PAYU, input)).rejects.toThrow(STORE_DOWN);
    const created = await world.subs.create(PAYU, input);
    expect(world.gateway.subscriptions.size).toBe(1);
    expect((await scheduleOf(world)).subscriptionId).toBe(created.id);
  });

  it('retrying WITHOUT an idempotency key leaves the first gateway subscription orphaned and creates a second', async () => {
    const world = makeWorld();
    world.store.fail(StoreMethod.SaveSchedule);
    await expect(world.subs.create(PAYU, trialInput())).rejects.toThrow(STORE_DOWN);
    const second = await world.subs.create(PAYU, trialInput());
    expect(world.gateway.subscriptions.size).toBe(2);
    expect((await scheduleOf(world)).subscriptionId).toBe(second.id);
    const [first] = [...world.gateway.subscriptions.values()];
    expect(first?.id).not.toBe(second.id);
    expect(first?.status).toBe(SubscriptionStatus.Created);
  });

  // DEFECT (low): the failure is not compensated. The gateway subscription (with a live authorisation link) is left
  // behind and its id is in no error or log, so the only way to find it is the gateway dashboard.
  it.fails('cancels the gateway subscription it just created when it cannot schedule it', async () => {
    const world = makeWorld();
    world.store.fail(StoreMethod.SaveSchedule);
    await world.subs.create(PAYU, trialInput()).catch(() => undefined);
    expect(world.gateway.callsTo(GatewayMethod.CancelSubscription)).toHaveLength(1);
  });

  // DEFECT (rule 7, "throw only SubscriptionError"): a storage failure escapes the facade as whatever the store threw.
  it.fails('surfaces a store failure as a SubscriptionError', async () => {
    const world = makeWorld();
    world.store.fail(StoreMethod.SaveSchedule);
    const error = await world.subs.create(PAYU, trialInput()).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(SubscriptionError);
  });
});

describe('failure atomicity: verifyCheckout when the scheduler store throws', () => {
  it('the customer has authorised at the gateway but nothing bills; the verification (new id) is lost to the caller; a retry recovers', async () => {
    const world = makeWorld({ gateways: [{ style: Style.Notify, idChanges: true }] });
    const created = await world.subs.create(PAYU, trialInput());
    const checkout = world.gateway.authorize(created.id);
    world.store.fail(StoreMethod.SaveSchedule, { when: scheduleIs(ScheduleStatus.Active) });

    await expect(world.subs.verifyCheckout(PAYU, checkout)).rejects.toThrow(STORE_DOWN);
    // The mandate is live at the gateway under its new id ...
    const mandateId = world.gateway.last().id;
    expect(mandateId).not.toBe(created.id);
    expect(world.gateway.last().authorized).toBe(true);
    // ... but the schedule is still waiting for authorisation, so no notice and no debit will ever go out.
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.PendingAuthorization);
    expect((await scheduleOf(world)).subscriptionId).toBe(created.id);
    for (const probe of [notifyAt(TRIAL_END), TRIAL_END, CYCLE_2]) await world.at(probe);
    expect(debits(world)).toBe(0);

    // A retry (or the authorisation webhook, redelivered) repairs it.
    world.setClock(plusHours(CYCLE_2, 1));
    const verification = await world.subs.verifyCheckout(PAYU, checkout);
    expect(verification.subscriptionId).toBe(mandateId);
    const schedule = await scheduleOf(world);
    expect(schedule.status).toBe(ScheduleStatus.Active);
    expect(schedule.subscriptionId).toBe(mandateId);
  });

  it('a webhook whose application fails rejects, so the gateway redelivers it; the redelivery activates', async () => {
    const world = makeWorld();
    const created = await world.subs.create(PAYU, trialInput());
    world.gateway.authorize(created.id);
    const request = world.gateway.webhook(EventType.SubscriptionAuthorized, created.id);
    world.store.fail(StoreMethod.SaveSchedule, { when: scheduleIs(ScheduleStatus.Active) });
    await expect(world.subs.webhooks.handle(PAYU, request)).rejects.toThrow(STORE_DOWN);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.PendingAuthorization);
    await world.subs.webhooks.handle(PAYU, request);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Active);
  });
});

describe('failure atomicity: cancel when the scheduler store throws', () => {
  it('a lock that cannot be taken: the gateway mandate is already cancelled when the error surfaces', async () => {
    const { world, id } = await authorised();
    world.store.fail(StoreMethod.AcquireLock);
    await expect(world.subs.cancel(PAYU, id)).rejects.toThrow(STORE_DOWN);
    expect(world.gateway.sub(id).status).toBe(SubscriptionStatus.Cancelled);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Active);
  });

  it('retrying a cancel that failed half-way finishes it (the gateway is asked twice)', async () => {
    const { world, id } = await authorised();
    world.store.fail(StoreMethod.AcquireLock);
    await expect(world.subs.cancel(PAYU, id)).rejects.toThrow(STORE_DOWN);
    const again = await world.subs.cancel(PAYU, id);
    expect(again.status).toBe(SubscriptionStatus.Cancelled);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Cancelled);
    expect(world.gateway.callsTo(GatewayMethod.CancelSubscription)).toHaveLength(2);
    await world.at(CYCLE_2);
    expect(debits(world)).toBe(0);
  });

  const failurePoints: Array<[string, () => (world: World) => void]> = [
    ['the lock cannot be taken', () => (world) => world.store.fail(StoreMethod.AcquireLock)],
    ['the skipped cycle cannot be saved', () => (world) => world.store.fail(StoreMethod.SaveCycle)],
  ];

  // (A save that fails after the cycle was skipped is covered separately below: there the skipped cycle, by accident,
  // keeps the schedule from billing.)
  // DEFECT: cancel() cancels the gateway mandate FIRST and the schedule second. If the second step fails, the caller
  // is told the cancel failed, the mandate is dead at the gateway, and the schedule is left "active": ticks go on
  // sending pre-debit notices (and debit attempts) for a subscription the merchant cancelled. Stopping the scheduler
  // first (as pause() does) would make a failure leave the customer un-billed rather than billed-at-a-dead-mandate.
  it.fails.each(failurePoints)('a cancelled mandate never leaves the schedule billable (%s)', async (_label, arm) => {
    const { world, id } = await authorised();
    arm()(world);
    await world.subs.cancel(PAYU, id).catch(() => undefined);
    expect(world.gateway.sub(id).status).toBe(SubscriptionStatus.Cancelled);
    // Whatever else happens, the next ticks must not try to bill the customer.
    const noticesBefore = world.gateway.callsTo(GatewayMethod.NotifyCharge).length;
    await world.at(notifyAt(CYCLE_2));
    await world.at(CYCLE_2);
    expect(world.gateway.callsTo(GatewayMethod.NotifyCharge).length).toBe(noticesBefore);
    expect(debits(world)).toBe(0);
  });

  it('a schedule save that fails after the cycle was skipped leaves an active schedule whose current cycle is skipped: it never bills again', async () => {
    const { world, id } = await authorised();
    world.store.fail(StoreMethod.SaveSchedule, { when: scheduleIs(ScheduleStatus.Cancelled) });
    await expect(world.subs.cancel(PAYU, id)).rejects.toThrow(STORE_DOWN);
    // Documented state: status says active, the cycle says skipped.
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Active);
    expect((await cyclesOf(world))[0]?.status).toBe(CycleStatus.Skipped);
    for (const probe of [notifyAt(TRIAL_END), TRIAL_END, CYCLE_2]) {
      expect(await world.at(probe)).toMatchObject({ notified: 0, charged: 0 });
    }
    expect(debits(world)).toBe(0);
    expect((await world.subs.get(PAYU, id)).status).toBe(SubscriptionStatus.Cancelled);
  });

  it('a lock held by a long-running tick: cancel reaches the gateway, then times out with CONFLICT', async () => {
    const { world, id } = await authorised({ style: Style.Notify }, { lockWaitMs: 0 });
    const token = await world.store.inner.acquireLock(trialInput().reference as string, 60_000);
    expect(token).toBeDefined();
    await expect(world.subs.cancel(PAYU, id)).rejects.toMatchObject({ code: ErrorCode.Conflict });
    expect(world.gateway.sub(id).status).toBe(SubscriptionStatus.Cancelled);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Active);
  });
});

describe('failure atomicity: pause / resume / update when the scheduler store throws', () => {
  const withGatewayPause: Spec = { style: Style.Notify, pause: true, resume: true };

  it('pause: a failing store leaves BOTH sides untouched (the scheduler is stopped first, the gateway never asked)', async () => {
    const { world, id } = await authorised(withGatewayPause);
    world.store.fail(StoreMethod.SaveSchedule, { when: scheduleIs(ScheduleStatus.Paused) });
    await expect(world.subs.pause(PAYU, id)).rejects.toThrow(STORE_DOWN);
    expect(world.gateway.callsTo(GatewayMethod.PauseSubscription)).toHaveLength(0);
    expect(world.gateway.sub(id).status).toBe(SubscriptionStatus.Active);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Active);
    // And the retry works.
    expect((await world.subs.pause(PAYU, id)).status).toBe(SubscriptionStatus.Paused);
  });

  it('resume: the gateway is resumed first, so a failing store leaves a resumed mandate that is not billed until the retry', async () => {
    const { world, id } = await authorised(withGatewayPause);
    await world.subs.pause(PAYU, id);
    world.store.fail(StoreMethod.SaveSchedule, { when: scheduleIs(ScheduleStatus.Active) });
    await expect(world.subs.resume(PAYU, id)).rejects.toThrow(STORE_DOWN);
    expect(world.gateway.sub(id).status).toBe(SubscriptionStatus.Active);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Paused);
    await world.at(notifyAt(TRIAL_END));
    await world.at(TRIAL_END);
    expect(debits(world)).toBe(0);

    expect((await world.subs.resume(PAYU, id)).status).toBe(SubscriptionStatus.Trialing);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Active);
  });

  it('update: the gateway holds the new amount while the schedule still bills the old one until the update is retried', async () => {
    const { world, id } = await authorised();
    world.store.fail(StoreMethod.SaveSchedule);
    await expect(world.subs.update(PAYU, id, { amount: 59900 })).rejects.toThrow(STORE_DOWN);
    expect(world.gateway.sub(id).amount).toBe(59900);
    expect((await scheduleOf(world)).amount).toBe(AMOUNT);

    await world.subs.update(PAYU, id, { amount: 59900 });
    expect((await scheduleOf(world)).amount).toBe(59900);
  });

  it('a read-side store failure in get() surfaces as an error and changes nothing', async () => {
    const { world, id } = await authorised();
    const before = await scheduleOf(world);
    world.store.fail(StoreMethod.GetSchedule);
    await expect(world.subs.get(PAYU, id)).rejects.toThrow(STORE_DOWN);
    expect(await scheduleOf(world)).toStrictEqual(before);
  });
});
