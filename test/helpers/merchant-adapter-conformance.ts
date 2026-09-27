/**
 * Conformance suite for adapters of MERCHANT-SCHEDULED gateways (`capabilities.merchantCharges: true`): the contract written
 * down in the `SubscriptionProvider` doc comment of `src/provider.ts`, run through the REAL facade (`Subscriptions`) and the
 * REAL `BillingScheduler` against the adapter, with a scripted gateway standing in for the network.
 *
 * To put a new adapter (PhonePe, Paytm, ...) under test, write a {@link MerchantAdapterHarness}: a function that builds a fresh
 * adapter plus a {@link ConformanceGateway} (a scripted fake of the gateway's HTTP API that the suite drives through a small,
 * gateway-neutral interface), then call `describeMerchantAdapterConformance(harness)` inside a test file:
 *
 * ```ts
 * describeMerchantAdapterConformance({
 *   name: 'PhonePe',
 *   startAt: '2026-01-01T05:00:00.000Z',
 *   firstChargeAt: '2026-01-20T04:30:00.000Z',
 *   flags: { rejectsDuplicateIds: true, notificationDictatesChargeId: true },
 *   setup: (clock) => ({ adapter, gateway, createInput }),
 * });
 * ```
 */
import { describe, expect, it } from 'vitest';
import { createSubscriptions, type Subscriptions } from '../../src/client.js';
import { ChargeStatus, ErrorCode, EventType, GATEWAY_ID_PATTERN, MAX_GATEWAY_ID_LENGTH, SchedulingMode, SubscriptionStatus } from '../../src/constants.js';
import type { SubscriptionProvider } from '../../src/provider.js';
import { MemorySchedulerStore, ScheduleStatus, type ScheduleRecord } from '../../src/scheduler/index.js';
import type {
  CheckoutResult,
  CreatePlanInput,
  CreateSubscriptionInput,
  Subscription,
  WebhookRequest,
} from '../../src/schemas.js';

const HOUR_MS = 3_600_000;
/** Hours the suite lets a settled debit reach its date (a gateway that takes the charge days ahead debits then). */
const SETTLE_HOURS = 80;

/** The clock the suite drives. Hand `clock.now` to the adapter (`ProviderOptions.now`) and to the gateway fake. */
export class ConformanceClock {
  private ms: number;
  constructor(iso: string) {
    this.ms = Date.parse(iso);
  }
  readonly now = (): Date => new Date(this.ms);
  readonly nowMs = (): number => this.ms;
  set(iso: string): void {
    this.ms = Date.parse(iso);
  }
  advanceHours(hours: number): void {
    this.ms += hours * HOUR_MS;
  }
  iso(): string {
    return new Date(this.ms).toISOString();
  }
}

/** How a debit ends at the gateway. */
export type DebitOutcome = typeof ChargeStatus.Succeeded | typeof ChargeStatus.Failed;

/** What the customer's authorisation hands back to the merchant: a checkout result, a webhook, or both (the suite uses the first present). */
export interface AuthorisationProof {
  /** The result the gateway returns to the browser / return URL; passed to `subs.verifyCheckout`. */
  checkoutResult?: CheckoutResult;
  /** The gateway's webhook announcing the live mandate; passed to `subs.webhooks.handle`. */
  webhook?: WebhookRequest;
}

/**
 * A scripted fake of the gateway's API, driven by the suite. Everything it reports is what the gateway would actually hold or
 * have received; the suite never looks inside the adapter.
 */
export interface ConformanceGateway {
  /** The customer authorises the mandate that `subscription` (as returned by `create`) asks for. Returns what the merchant receives. */
  authorise(subscription: Subscription): Promise<AuthorisationProof> | AuthorisationProof;
  /** The merchant debit ids of every `createCharge` request that reached the gateway, in order, repeats included. */
  chargeRequestIds(): readonly string[];
  /** The ids of every pre-debit notification request that reached the gateway (empty for gateways that need none). */
  notificationIds(): readonly string[];
  /** How many debits the gateway holds, i.e. how many times the customer would be debited. Must count a duplicate that the gateway executes. */
  debitCount(): number;
  /** The next debit stays in flight (pending / scheduled) until `settle`. Gateways whose debits always are in flight make this a no-op. */
  holdNextCharge(): void;
  /** The gateway's final answer for a debit it holds. */
  settle(chargeId: string, outcome: DebitOutcome): void;
  /** The next `createCharge` is executed by the gateway but its answer never reaches the merchant (`OUTCOME_UNKNOWN`). */
  loseNextChargeAnswer(): void;
  /** The next `createCharge` never reaches the gateway (`OUTCOME_UNKNOWN`). */
  loseNextChargeRequest(): void;
  /** Optional: the gateway's status lookup does not see debits it holds until this instant (eventual consistency). */
  hideDebitsUntil?(iso: string): void;
  /** The webhook the gateway sends for the end of a debit, signed as the adapter requires. */
  debitWebhook(chargeId: string, outcome: DebitOutcome): WebhookRequest;
  /** Optional: a mandate webhook (the customer paused / resumed / cancelled the mandate in their app). */
  mandateWebhook?(event: typeof EventType.SubscriptionPaused | typeof EventType.SubscriptionResumed | typeof EventType.SubscriptionCancelled): WebhookRequest;
  /** For gateways with `notificationDictatesChargeId`: the debit ids the notifications dictated, in order. */
  dictatedChargeIds?(): readonly string[];
}

/** Everything the suite needs to know about one adapter. */
export interface MerchantAdapterHarness {
  /** Names the suite in the test report. */
  name: string;
  /** The instant the clock starts at (the subscription is created then). */
  startAt: string;
  /** When the first debit is due; the suite drives the clock around it. Must be at least four days after `startAt`. */
  firstChargeAt: string;
  flags: {
    /** The gateway refuses a debit id it already holds (so a re-sent id cannot debit twice). False: it executes duplicates, and the adapter must protect itself. */
    rejectsDuplicateIds: boolean;
    /** The notification dictates the id of the debit that follows it (`ChargeNotification.chargeId`). */
    notificationDictatesChargeId?: boolean;
  };
  /** Builds a fresh adapter and gateway on `clock`. `createInput` is a valid `CreateSubscriptionInput` with an inline plan and `startAt: firstChargeAt` (or the equivalent trial). */
  setup(clock: ConformanceClock): {
    adapter: SubscriptionProvider;
    gateway: ConformanceGateway;
    createInput: CreateSubscriptionInput;
  };
}

interface World {
  clock: ConformanceClock;
  subs: Subscriptions;
  adapter: SubscriptionProvider;
  gateway: ConformanceGateway;
  createInput: CreateSubscriptionInput;
  scheduleOf(subscription: Subscription): Promise<ScheduleRecord>;
  authorised(): Promise<{ subscription: Subscription; schedule: ScheduleRecord }>;
  /** Ticks hourly from the current instant until `until()` holds or `maxHours` passed; returns the ticks' summed failures. */
  tickHourly(maxHours: number, until?: () => boolean): Promise<{ failed: number; errors: number }>;
  /** Moves the clock to four days before the due date and ticks hourly until the gateway has received a debit request. */
  raiseFirstDebit(): Promise<string>;
}

export function describeMerchantAdapterConformance(harness: MerchantAdapterHarness): void {
  async function build(): Promise<World> {
    const clock = new ConformanceClock(harness.startAt);
    const { adapter, gateway, createInput } = harness.setup(clock);
    const store = new MemorySchedulerStore({ now: clock.nowMs });
    const subs = createSubscriptions({ providers: [adapter], scheduler: { store, now: clock.now } });
    const scheduleOf = async (subscription: Subscription): Promise<ScheduleRecord> => {
      const found = await subs.scheduler?.find(adapter.name, subscription.reference, subscription.id);
      if (!found) throw new Error('the facade registered no schedule for the subscription it created');
      return found;
    };
    const tickHourly: World['tickHourly'] = async (maxHours, until) => {
      let failed = 0;
      let errors = 0;
      for (let hour = 0; hour < maxHours; hour += 1) {
        if (until?.()) break;
        clock.advanceHours(1);
        const result = await subs.tick();
        failed += result.failed;
        errors += result.errors.length;
      }
      return { failed, errors };
    };
    const authorised: World['authorised'] = async () => {
      const subscription = await subs.create(adapter.name, createInput);
      const proof = await gateway.authorise(subscription);
      if (proof.checkoutResult) await subs.verifyCheckout(adapter.name, proof.checkoutResult, { expectedSubscriptionId: subscription.id });
      else if (proof.webhook) await subs.webhooks.handle(adapter.name, proof.webhook);
      else throw new Error('the gateway harness returned neither a checkout result nor a webhook for the authorisation');
      const schedule = await scheduleOf(subscription);
      return { subscription, schedule };
    };
    const raiseFirstDebit: World['raiseFirstDebit'] = async () => {
      clock.set(new Date(Date.parse(harness.firstChargeAt) - 100 * HOUR_MS).toISOString());
      await tickHourly(130, () => gateway.chargeRequestIds().length > 0);
      const first = gateway.chargeRequestIds()[0];
      if (first === undefined) throw new Error('the scheduler raised no debit between four days before and one day after the due date');
      return first;
    };
    return { clock, subs, adapter, gateway, createInput, scheduleOf, authorised, tickHourly, raiseFirstDebit };
  }

  const plan = (input: CreateSubscriptionInput): CreatePlanInput => {
    if (typeof input.plan === 'string') throw new Error('the harness must create the subscription with an inline plan');
    return input.plan;
  };

  describe(`merchant-scheduled adapter conformance: ${harness.name}`, () => {
    it('createSubscription returns amount, interval and startAt; the facade registers a schedule that waits; get answers by reference and by id', async () => {
      const w = await build();
      const subscription = await w.subs.create(w.adapter.name, w.createInput);
      expect(subscription.scheduling).toBe(SchedulingMode.Merchant);
      expect(subscription.amount).toBe(plan(w.createInput).amount);
      expect(subscription.interval).toEqual(plan(w.createInput).interval);
      expect(subscription.startAt).toBeDefined();
      const schedule = await w.scheduleOf(subscription);
      expect(schedule.status).toBe(ScheduleStatus.PendingAuthorization);
      expect(await w.tickHourly(2)).toEqual({ failed: 0, errors: 0 });
      expect(w.gateway.chargeRequestIds()).toHaveLength(0);
      for (const handle of new Set([subscription.id, subscription.reference].filter((value): value is string => value !== undefined))) {
        const got = await w.subs.get(w.adapter.name, handle);
        expect(got.scheduling).toBe(SchedulingMode.Merchant);
        expect(got.amount).toBe(plan(w.createInput).amount);
      }
    });

    it('authorisation (checkout result or webhook) activates the schedule, and the facade then answers for the mandate', async () => {
      const w = await build();
      const { subscription, schedule } = await w.authorised();
      expect(schedule.status).toBe(ScheduleStatus.Active);
      const got = await w.subs.get(w.adapter.name, schedule.subscriptionId);
      expect(got.scheduling).toBe(SchedulingMode.Merchant);
      expect([SubscriptionStatus.Active, SubscriptionStatus.Trialing]).toContain(got.status);
      expect((await w.subs.get(w.adapter.name, subscription.reference ?? subscription.id)).id).toBe(got.id);
    });

    it('one debit per cycle: exactly one request, one debit, settled once; nothing more is raised for that cycle', async () => {
      const w = await build();
      const { schedule } = await w.authorised();
      const id = await w.raiseFirstDebit();
      w.gateway.settle(id, ChargeStatus.Succeeded);
      // Long enough for a debit scheduled days ahead to reach its date; far short of the next cycle.
      await w.tickHourly(SETTLE_HOURS);
      expect(w.gateway.chargeRequestIds()).toEqual([id]);
      expect(w.gateway.debitCount()).toBe(1);
      expect((await w.subs.scheduler?.get(schedule.id))?.paidCycles).toBe(1);
    });

    it('every id sent to the gateway is at most MAX_GATEWAY_ID_LENGTH characters of GATEWAY_ID_PATTERN (ids a notification dictated are the gateway\'s own)', async () => {
      const w = await build();
      await w.authorised();
      await w.raiseFirstDebit();
      const ids = [...w.gateway.notificationIds(), ...(harness.flags.notificationDictatesChargeId ? [] : w.gateway.chargeRequestIds())];
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        expect(id.length, id).toBeLessThanOrEqual(MAX_GATEWAY_ID_LENGTH);
        expect(id, id).toMatch(GATEWAY_ID_PATTERN);
      }
    });

    it('a lost answer after the gateway executed the debit is reconciled with getCharge: one debit, the same id, settled', async () => {
      const w = await build();
      const { schedule } = await w.authorised();
      w.gateway.loseNextChargeAnswer();
      const id = await w.raiseFirstDebit();
      await w.tickHourly(3);
      w.gateway.settle(id, ChargeStatus.Succeeded);
      await w.tickHourly(SETTLE_HOURS);
      expect(new Set(w.gateway.chargeRequestIds())).toEqual(new Set([id]));
      expect(w.gateway.debitCount()).toBe(1);
      expect((await w.subs.scheduler?.get(schedule.id))?.paidCycles).toBe(1);
    });

    it('a request that never reached the gateway is NOT_FOUND there; after the grace period the SAME id is sent again, and exactly one debit results', async () => {
      const w = await build();
      const { schedule } = await w.authorised();
      w.gateway.loseNextChargeRequest();
      const id = await w.raiseFirstDebit();
      await w.tickHourly(3);
      expect(w.gateway.chargeRequestIds().length).toBeGreaterThanOrEqual(2);
      expect(new Set(w.gateway.chargeRequestIds())).toEqual(new Set([id]));
      expect(w.gateway.debitCount()).toBe(1);
      w.gateway.settle(id, ChargeStatus.Succeeded);
      await w.tickHourly(SETTLE_HOURS);
      expect((await w.subs.scheduler?.get(schedule.id))?.paidCycles).toBe(1);
    });

    if (harness.flags.rejectsDuplicateIds) {
      it('a gateway that lags in showing a debit it holds never ends in a second debit: the re-sent id is refused and the cycle stays unresolved until getCharge sees it', async () => {
        const w = await build();
        if (!w.gateway.hideDebitsUntil) throw new Error('a gateway that rejects duplicate ids must provide hideDebitsUntil');
        const { schedule } = await w.authorised();
        w.gateway.loseNextChargeAnswer();
        const id = await w.raiseFirstDebit();
        w.gateway.hideDebitsUntil(new Date(w.clock.nowMs() + 2 * HOUR_MS).toISOString());
        const ticks = await w.tickHourly(2);
        expect(ticks.failed).toBe(0);
        expect(new Set(w.gateway.chargeRequestIds())).toEqual(new Set([id]));
        expect(w.gateway.debitCount()).toBe(1);
        w.gateway.settle(id, ChargeStatus.Succeeded);
        await w.tickHourly(SETTLE_HOURS);
        expect((await w.subs.scheduler?.get(schedule.id))?.paidCycles).toBe(1);
        expect(w.gateway.debitCount()).toBe(1);
      });
    }

    it('getCharge answers NOT_FOUND for a debit the gateway has no trace of, and nothing else for it', async () => {
      const w = await build();
      const { schedule } = await w.authorised();
      const error = await w.adapter.getCharge(schedule.subscriptionId, 'conformance_unknown_0_1').then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toMatchObject({ code: ErrorCode.NotFound });
    });

    it('the gateway\'s webhook for a debit carries the merchant debit id; handled through the facade it settles the cycle, and a redelivery changes nothing', async () => {
      const w = await build();
      const { schedule } = await w.authorised();
      w.gateway.holdNextCharge();
      const id = await w.raiseFirstDebit();
      w.gateway.settle(id, ChargeStatus.Succeeded);
      const request = w.gateway.debitWebhook(id, ChargeStatus.Succeeded);
      const events = await w.subs.webhooks.handle(w.adapter.name, request);
      const charged = events.find((event) => event.type === EventType.SubscriptionCharged);
      expect(charged).toBeDefined();
      expect([charged?.charge?.id, charged?.charge?.reference]).toContain(id);
      expect(await w.subs.scheduler?.get(schedule.id)).toMatchObject({ paidCycles: 1 });
      await w.subs.webhooks.handle(w.adapter.name, request);
      expect(await w.subs.scheduler?.get(schedule.id)).toMatchObject({ paidCycles: 1 });
      expect(w.gateway.debitCount()).toBe(1);
    });

    it('a failed debit is retried under a NEW id; the failed id is never reused; the retry settles the cycle', async () => {
      const w = await build();
      const { schedule } = await w.authorised();
      w.gateway.holdNextCharge();
      const first = await w.raiseFirstDebit();
      w.gateway.settle(first, ChargeStatus.Failed);
      await w.subs.webhooks.handle(w.adapter.name, w.gateway.debitWebhook(first, ChargeStatus.Failed));
      w.gateway.holdNextCharge();
      await w.tickHourly(80, () => w.gateway.chargeRequestIds().length >= 2);
      const ids = w.gateway.chargeRequestIds();
      expect(ids.length).toBeGreaterThanOrEqual(2);
      const second = ids[ids.length - 1] as string;
      expect(second).not.toBe(first);
      expect(ids.filter((id) => id === first)).toHaveLength(1);
      w.gateway.settle(second, ChargeStatus.Succeeded);
      await w.tickHourly(SETTLE_HOURS);
      expect((await w.subs.scheduler?.get(schedule.id))?.paidCycles).toBe(1);
    });

    if (harness.flags.notificationDictatesChargeId) {
      it('the notification dictates the debit id: the debit uses it, a lost answer is reconciled under it, a retry uses the next notification\'s id; never two debits for one cycle', async () => {
        const w = await build();
        const { schedule } = await w.authorised();
        w.gateway.loseNextChargeAnswer();
        const first = await w.raiseFirstDebit();
        await w.tickHourly(3);
        expect(w.gateway.dictatedChargeIds?.()).toContain(first);
        expect(new Set(w.gateway.chargeRequestIds())).toEqual(new Set([first]));
        expect(w.gateway.debitCount()).toBe(1);
        w.gateway.settle(first, ChargeStatus.Failed);
        w.gateway.holdNextCharge();
        await w.tickHourly(80, () => w.gateway.chargeRequestIds().includes(w.gateway.dictatedChargeIds?.().at(-1) ?? '') && w.gateway.chargeRequestIds().length >= 2);
        const second = w.gateway.chargeRequestIds().at(-1) as string;
        expect(second).not.toBe(first);
        expect(w.gateway.dictatedChargeIds?.()).toContain(second);
        w.gateway.settle(second, ChargeStatus.Succeeded);
        await w.tickHourly(SETTLE_HOURS);
        expect((await w.subs.scheduler?.get(schedule.id))?.paidCycles).toBe(1);
      });
    }

    it('a gateway-side pause and resume (the customer in their app) pauses and resumes the schedule; a cancellation cancels it', async () => {
      const w = await build();
      if (!w.gateway.mandateWebhook) return;
      const { schedule } = await w.authorised();
      await w.subs.webhooks.handle(w.adapter.name, w.gateway.mandateWebhook(EventType.SubscriptionPaused));
      expect((await w.subs.scheduler?.get(schedule.id))?.status).toBe(ScheduleStatus.Paused);
      await w.subs.webhooks.handle(w.adapter.name, w.gateway.mandateWebhook(EventType.SubscriptionResumed));
      expect((await w.subs.scheduler?.get(schedule.id))?.status).toBe(ScheduleStatus.Active);
      await w.subs.webhooks.handle(w.adapter.name, w.gateway.mandateWebhook(EventType.SubscriptionCancelled));
      expect((await w.subs.scheduler?.get(schedule.id))?.status).toBe(ScheduleStatus.Cancelled);
    });

    it('cancel stops billing and can be repeated; nothing is raised afterwards', async () => {
      const w = await build();
      const { subscription, schedule } = await w.authorised();
      const handle = subscription.reference ?? subscription.id;
      expect((await w.subs.cancel(w.adapter.name, handle)).status).toBe(SubscriptionStatus.Cancelled);
      expect((await w.subs.scheduler?.get(schedule.id))?.status).toBe(ScheduleStatus.Cancelled);
      await w.subs.cancel(w.adapter.name, handle);
      clockTo(w, Date.parse(harness.firstChargeAt) - 100 * HOUR_MS);
      await w.tickHourly(130);
      expect(w.gateway.chargeRequestIds()).toHaveLength(0);
    });
  });
}

function clockTo(world: World, ms: number): void {
  world.clock.set(new Date(ms).toISOString());
}
