import { describe, expect, it } from 'vitest';
import { ErrorCode, EventType, Provider, SubscriptionStatus } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import { CycleStatus, ScheduleStatus, type ScheduleRecord } from '../../src/scheduler/index.js';
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
  scheduleIdOf,
  scheduleOf,
  trialInput,
  type GatewayOptions,
  type World,
} from './helpers.js';

const PAYU = Provider.PayU;
const notifyAt = (due: string): string => plusHours(due, -48);
type Spec = Omit<GatewayOptions, 'clock' | 'log'>;

const scheduleIs = (status: ScheduleStatus) => (argument: unknown) => (argument as ScheduleRecord).status === status;

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
    expect(await world.scheduler?.get(scheduleIdOf())).toBeUndefined();
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

  it('retrying WITHOUT an idempotency key finds the first gateway subscription already cancelled and creates a second', async () => {
    const world = makeWorld();
    world.store.fail(StoreMethod.SaveSchedule);
    await expect(world.subs.create(PAYU, trialInput())).rejects.toThrow(STORE_DOWN);
    const second = await world.subs.create(PAYU, trialInput());
    expect(world.gateway.subscriptions.size).toBe(2);
    expect((await scheduleOf(world)).subscriptionId).toBe(second.id);
    const [first] = [...world.gateway.subscriptions.values()];
    expect(first?.id).not.toBe(second.id);
    expect(first?.status).toBe(SubscriptionStatus.Cancelled);
    expect(world.gateway.sub(second.id).status).toBe(SubscriptionStatus.Created);
  });

  it('cancels the gateway subscription it just created when it cannot schedule it', async () => {
    const world = makeWorld();
    world.store.fail(StoreMethod.SaveSchedule);
    await world.subs.create(PAYU, trialInput()).catch(() => undefined);
    expect(world.gateway.callsTo(GatewayMethod.CancelSubscription)).toHaveLength(1);
  });

  it('surfaces a store failure as INTERNAL_ERROR carrying the created subscription, never as a raw Error', async () => {
    const world = makeWorld();
    world.store.fail(StoreMethod.SaveSchedule);
    const error = await world.subs.create(PAYU, trialInput()).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(SubscriptionError);
    expect(error).toMatchObject({ code: ErrorCode.Internal, provider: PAYU });
    const created = world.gateway.last();
    expect((error as SubscriptionError).raw).toMatchObject({ id: created.id, provider: PAYU });
    expect((error as Error).message).toContain(created.id);
  });

  it('does not cancel a gateway subscription that a schedule already tracks (an idempotent retry returns a live one)', async () => {
    const world = makeWorld();
    const input = trialInput({ idempotencyKey: 'idem-live' });
    const created = await world.subs.create(PAYU, input);
    // The gateway now reports different terms for the same subscription: re-registering conflicts with the stored schedule.
    world.gateway.sub(created.id).amount = 12345;
    await expect(world.subs.create(PAYU, input)).rejects.toMatchObject({ code: ErrorCode.Internal });
    expect(world.gateway.callsTo(GatewayMethod.CancelSubscription)).toHaveLength(0);
    expect(world.gateway.sub(created.id).status).toBe(SubscriptionStatus.Created);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.PendingAuthorization);
  });
});

describe('failure atomicity: verifyCheckout when the scheduler store throws', () => {
  it('the customer has authorised at the gateway but nothing bills; the error carries the verification (new id); a retry recovers', async () => {
    const world = makeWorld({ gateways: [{ style: Style.Notify, idChanges: true }], scheduler: { authorizationPollMinutes: 0 } });
    const created = await world.subs.create(PAYU, trialInput());
    const checkout = world.gateway.authorize(created.id);
    world.store.fail(StoreMethod.SaveSchedule, { when: scheduleIs(ScheduleStatus.Active) });

    const failure = await world.subs.verifyCheckout(PAYU, checkout).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    const mandateId = world.gateway.last().id;
    // The caller is told, and the verification (with the new id) is not lost.
    expect(failure).toMatchObject({ code: ErrorCode.Internal, provider: PAYU });
    expect((failure as SubscriptionError).message).toContain('live');
    expect((failure as SubscriptionError).message).toContain(STORE_DOWN);
    expect((failure as SubscriptionError).raw).toMatchObject({ subscriptionId: mandateId, authorized: true, reference: created.id });
    // The mandate is live at the gateway under its new id ...
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

describe('failure atomicity: cancel', () => {
  it('billing is stopped first: a lock that cannot be taken fails the whole cancel and the gateway is never asked', async () => {
    const { world, id } = await authorised();
    world.store.fail(StoreMethod.AcquireLock);
    await expect(world.subs.cancel(PAYU, id)).rejects.toMatchObject({ code: ErrorCode.Internal });
    expect(world.gateway.callsTo(GatewayMethod.CancelSubscription)).toHaveLength(0);
    expect(world.gateway.sub(id).status).toBe(SubscriptionStatus.Active);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Active);
  });

  it('retrying a cancel that failed in the store finishes it, asking the gateway exactly once', async () => {
    const { world, id } = await authorised();
    world.store.fail(StoreMethod.AcquireLock);
    await expect(world.subs.cancel(PAYU, id)).rejects.toThrow(STORE_DOWN);
    const again = await world.subs.cancel(PAYU, id);
    expect(again.status).toBe(SubscriptionStatus.Cancelled);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Cancelled);
    expect(world.gateway.callsTo(GatewayMethod.CancelSubscription)).toHaveLength(1);
    await world.at(CYCLE_2);
    expect(debits(world)).toBe(0);
  });

  it('if the gateway cancel fails the schedule STAYS cancelled (nothing is billed) and the error propagates for a retry', async () => {
    const { world, id } = await authorised();
    world.gateway.failOnce(GatewayMethod.CancelSubscription);
    await expect(world.subs.cancel(PAYU, id)).rejects.toMatchObject({ code: ErrorCode.ProviderUnavailable });
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Cancelled);
    expect(world.gateway.sub(id).status).toBe(SubscriptionStatus.Active);
    for (const probe of [notifyAt(TRIAL_END), TRIAL_END, CYCLE_2]) await world.at(probe);
    expect(debits(world)).toBe(0);
    expect(world.gateway.callsTo(GatewayMethod.NotifyCharge)).toHaveLength(0);

    const retried = await world.subs.cancel(PAYU, id);
    expect(retried.status).toBe(SubscriptionStatus.Cancelled);
    expect(world.gateway.callsTo(GatewayMethod.CancelSubscription)).toHaveLength(2);
  });

  const failurePoints: Array<[string, (world: World) => void]> = [
    ['the lock cannot be taken', (world) => world.store.fail(StoreMethod.AcquireLock)],
    ['the schedule cannot be saved', (world) => world.store.fail(StoreMethod.SaveSchedule, { when: scheduleIs(ScheduleStatus.Cancelled) })],
    ['the skipped cycle cannot be saved', (world) => world.store.fail(StoreMethod.SaveCycle)],
  ];

  it.each(failurePoints)('a cancelled mandate never leaves the schedule billable (%s)', async (_label, arm) => {
    const { world, id } = await authorised();
    arm(world);
    await expect(world.subs.cancel(PAYU, id)).rejects.toMatchObject({ code: ErrorCode.Internal });
    // The gateway is only asked after billing has stopped, so a failure cannot leave "mandate dead, schedule live".
    const mandateCancelled = world.gateway.sub(id).status === SubscriptionStatus.Cancelled;
    const billable = (await scheduleOf(world)).status === ScheduleStatus.Active;
    expect(mandateCancelled && billable).toBe(false);
    expect(mandateCancelled).toBe(false);

    // And the retry always finishes the job.
    const retried = await world.subs.cancel(PAYU, id);
    expect(retried.status).toBe(SubscriptionStatus.Cancelled);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Cancelled);
    for (const probe of [notifyAt(CYCLE_2), CYCLE_2]) await world.at(probe);
    expect(debits(world)).toBe(0);
  });

  it('a schedule save that fails changes nothing: the cycle is not skipped behind a live schedule', async () => {
    const { world, id } = await authorised();
    world.store.fail(StoreMethod.SaveSchedule, { when: scheduleIs(ScheduleStatus.Cancelled) });
    await expect(world.subs.cancel(PAYU, id)).rejects.toThrow(STORE_DOWN);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Active);
    expect((await cyclesOf(world))[0]?.status).toBe(CycleStatus.Pending);
    expect(await world.at(notifyAt(TRIAL_END))).toMatchObject({ notified: 1 });
  });

  it('a lock held by a long-running tick: cancel times out with CONFLICT before the gateway is asked', async () => {
    const { world, id } = await authorised({ style: Style.Notify }, { lockWaitMs: 0 });
    const token = await world.store.inner.acquireLock(scheduleIdOf(), 60_000);
    expect(token).toBeDefined();
    await expect(world.subs.cancel(PAYU, id)).rejects.toMatchObject({ code: ErrorCode.Conflict });
    expect(world.gateway.callsTo(GatewayMethod.CancelSubscription)).toHaveLength(0);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Active);
  });
});

describe('failure atomicity: pause / resume / update / get when the scheduler store throws', () => {
  it('pause: a failing store fails the call and changes nothing; the retry works', async () => {
    const { world, id } = await authorised();
    world.store.fail(StoreMethod.SaveSchedule, { when: scheduleIs(ScheduleStatus.Paused) });
    await expect(world.subs.pause(PAYU, id)).rejects.toMatchObject({ code: ErrorCode.Internal });
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Active);
    expect((await world.subs.pause(PAYU, id)).status).toBe(SubscriptionStatus.Paused);
  });

  it('resume: a failing store leaves the schedule paused (nothing billed) and the retry works', async () => {
    const { world, id } = await authorised();
    await world.subs.pause(PAYU, id);
    world.store.fail(StoreMethod.SaveSchedule, { when: scheduleIs(ScheduleStatus.Active) });
    await expect(world.subs.resume(PAYU, id)).rejects.toMatchObject({ code: ErrorCode.Internal });
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Paused);
    await world.at(notifyAt(TRIAL_END));
    await world.at(TRIAL_END);
    expect(debits(world)).toBe(0);

    // The pause swallowed the first due date, so billing starts from the resume instant: no longer a trial.
    expect((await world.subs.resume(PAYU, id)).status).toBe(SubscriptionStatus.Active);
    expect((await scheduleOf(world)).status).toBe(ScheduleStatus.Active);
  });

  it('update: the gateway is updated first; a failing store afterwards leaves the old amount billed until the retry, and says so', async () => {
    const { world, id } = await authorised();
    world.store.fail(StoreMethod.AcquireLock);
    await expect(world.subs.update(PAYU, id, { amount: 59900 })).rejects.toMatchObject({ code: ErrorCode.Internal });
    expect(world.gateway.sub(id).amount).toBe(59900);
    expect((await scheduleOf(world)).amount).toBe(AMOUNT);

    await world.subs.update(PAYU, id, { amount: 59900 });
    expect((await scheduleOf(world)).amount).toBe(59900);
  });

  it('a store failure in get() is an INTERNAL_ERROR and changes nothing', async () => {
    const { world, id } = await authorised();
    const before = await scheduleOf(world);
    world.store.fail(StoreMethod.FindBySubscriptionId, { times: 5 });
    world.store.fail(StoreMethod.GetSchedule, { times: 5 });
    await expect(world.subs.get(PAYU, id)).rejects.toMatchObject({ code: ErrorCode.Internal });
    world.store.clearFaults();
    expect(await scheduleOf(world)).toStrictEqual(before);
  });

  it('a store failure never escapes as a raw Error from any facade method', async () => {
    const { world, id } = await authorised();
    const calls: Array<[string, () => Promise<unknown>]> = [
      ['get', () => world.subs.get(PAYU, id)],
      ['cancel', () => world.subs.cancel(PAYU, id)],
      ['pause', () => world.subs.pause(PAYU, id)],
      ['resume', () => world.subs.resume(PAYU, id)],
      ['update', () => world.subs.update(PAYU, id, { amount: 1000 })],
      ['webhooks.handle', () => world.subs.webhooks.handle(PAYU, world.gateway.webhook(EventType.SubscriptionPaused, id))],
      ['tick', () => world.subs.tick()],
    ];
    for (const [name, call] of calls) {
      world.store.fail(StoreMethod.AcquireLock, { times: 5 });
      world.store.fail(StoreMethod.GetSchedule, { times: 5 });
      world.store.fail(StoreMethod.FindBySubscriptionId, { times: 5 });
      world.store.fail(StoreMethod.ListDueSchedules, { times: 5 });
      let caught: unknown;
      try {
        await call();
      } catch (error) {
        caught = error;
      }
      // tick reports per-schedule errors in its result and rejects only when the store cannot even list.
      expect(caught, name).toBeInstanceOf(SubscriptionError);
      world.store.clearFaults();
    }
  });
});
