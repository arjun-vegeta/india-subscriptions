import { CancelMode, ErrorCode, GATEWAY_STATUS_UNAVAILABLE, SchedulingMode, SubscriptionStatus, type Provider } from './constants.js';
import { SubscriptionError, unsupported } from './errors.js';
import type { SubscriptionProvider } from './provider.js';
import type {
  CancelSubscriptionOptions,
  Capabilities,
  Charge,
  ChargeNotification,
  CheckoutResult,
  CheckoutVerification,
  CreateChargeInput,
  CreatePlanInput,
  CreateSubscriptionInput,
  ListChargesOptions,
  NotifyChargeInput,
  PauseSubscriptionOptions,
  Plan,
  Refund,
  RefundInput,
  ResumeSubscriptionOptions,
  Subscription,
  SubscriptionEvent,
  UpdateSubscriptionInput,
  WebhookRequest,
} from './schemas.js';
import { ScheduleStatus, ScheduleStatusReason } from './scheduler/constants.js';
import type { ScheduleRecord, TickResult, UpdateScheduleInput } from './scheduler/schemas.js';
import { BillingScheduler, awaitsActivation, type SchedulerSettings } from './scheduler/scheduler.js';

export interface SubscriptionsOptions {
  /** Gateway adapters, built with `razorpay(...)`, `cashfree(...)`, `payu(...)`. */
  providers: SubscriptionProvider[];
  /**
   * Billing engine for merchant-scheduled mandates (gateways that hold the
   * mandate but expect you to raise each debit). Required to create such
   * subscriptions through this client; call `tick()` from a cron job.
   *
   * Pass either a ready `BillingScheduler`, or just its options (a `store`, and
   * optionally `onEvent`, `now` and policy defaults): the client then builds the
   * scheduler itself, wired to exactly the `providers` above.
   */
  scheduler?: BillingScheduler | SchedulerSettings;
}

/**
 * One entry point over every configured gateway. Each method takes the
 * gateway as its first argument and otherwise speaks only the unified model.
 *
 * For merchant-scheduled subscriptions the client also keeps the billing
 * scheduler in step: it registers a schedule on create, activates it once the
 * customer authorises, mirrors pause / resume / cancel, and overlays the
 * schedule's state (trialing, next charge, paid cycles) on what it returns.
 */
export class Subscriptions {
  readonly scheduler?: BillingScheduler;
  private readonly registry = new Map<Provider, SubscriptionProvider>();

  // Every method that returns a promise rejects: none of them throws synchronously, even for an unknown gateway.
  readonly plans = {
    create: async (provider: Provider, input: CreatePlanInput): Promise<Plan> =>
      this.provider(provider).createPlan(input),
    get: async (provider: Provider, planId: string): Promise<Plan> => this.provider(provider).getPlan(planId),
  };

  readonly charges = {
    list: async (provider: Provider, subscriptionId: string, options?: ListChargesOptions): Promise<Charge[]> =>
      this.provider(provider).listCharges(subscriptionId, options),
    get: async (provider: Provider, subscriptionId: string, chargeId: string): Promise<Charge> =>
      this.provider(provider).getCharge(subscriptionId, chargeId),
    /** Raises a debit yourself. With a scheduler configured you normally never call this. */
    create: async (provider: Provider, input: CreateChargeInput): Promise<Charge> =>
      this.provider(provider).createCharge(input),
    notify: async (provider: Provider, input: NotifyChargeInput): Promise<ChargeNotification> =>
      this.provider(provider).notifyCharge(input),
    refund: async (provider: Provider, input: RefundInput): Promise<Refund> =>
      this.provider(provider).refundCharge(input),
  };

  readonly webhooks = {
    /** Verifies the signature and returns normalised events. Pure: nothing is stored. */
    parse: (provider: Provider, request: WebhookRequest): SubscriptionEvent[] =>
      this.provider(provider).parseWebhook(request),
    /** `parse`, then applies each event to the billing scheduler. Use this in your webhook route. */
    handle: async (provider: Provider, request: WebhookRequest): Promise<SubscriptionEvent[]> => {
      const events = this.provider(provider).parseWebhook(request);
      const scheduler = this.schedulerFor(provider);
      if (scheduler) {
        for (const event of events) {
          await guarded(provider, 'applying a webhook event to the billing schedule', () => scheduler.handleEvent(event));
        }
      }
      return events;
    },
  };

  constructor(options: SubscriptionsOptions) {
    if (!options.providers?.length) {
      throw new SubscriptionError(ErrorCode.Config, 'createSubscriptions needs at least one provider');
    }
    for (const provider of options.providers) {
      if (this.registry.has(provider.name)) {
        throw new SubscriptionError(ErrorCode.Config, `Provider ${provider.name} is configured twice`, {
          provider: provider.name,
        });
      }
      this.registry.set(provider.name, provider);
    }
    const scheduler = options.scheduler;
    this.scheduler = !scheduler
      ? undefined
      : isScheduler(scheduler)
        ? scheduler
        : new BillingScheduler({ ...scheduler, resolveProvider: (name) => this.provider(name) });
  }

  /** The configured gateways. */
  get providers(): Provider[] {
    return [...this.registry.keys()];
  }

  /** The adapter for a gateway, for anything this client does not wrap. */
  provider(name: Provider): SubscriptionProvider {
    const provider = this.registry.get(name);
    if (!provider) {
      throw new SubscriptionError(ErrorCode.Config, `Provider ${String(name)} is not configured`);
    }
    return provider;
  }

  /**
   * What `provider` can do through THIS client: the adapter's own capabilities (`provider(name).capabilities`), plus what
   * the facade and the billing scheduler add. For a gateway whose debits the merchant raises, with a scheduler configured,
   * pause and resume work (the scheduler simply stops raising debits), whatever the gateway's own API offers.
   */
  capabilities(name: Provider): Capabilities {
    const raw = this.provider(name).capabilities;
    if (!this.scheduler || merchantSchedulingOf(raw) === MerchantScheduling.Never) return raw;
    return { ...raw, pause: true, resume: true };
  }

  async create(provider: Provider, input: CreateSubscriptionInput): Promise<Subscription> {
    const adapter = this.provider(provider);
    // Decide BEFORE touching the gateway whether this can only work with a scheduler.
    if (!this.scheduler && mustBeMerchantScheduled(adapter, input)) throw missingScheduler(provider);

    const subscription = await adapter.createSubscription(input);
    if (subscription.scheduling !== SchedulingMode.Merchant) return subscription;

    const scheduler = this.scheduler;
    if (!scheduler) {
      const cancelled = await this.abandon(provider, subscription);
      throw missingScheduler(provider, subscription, cancelled);
    }
    if (subscription.amount === undefined || !subscription.interval || !subscription.startAt) {
      const cancelled = await this.abandon(provider, subscription, scheduler);
      throw new SubscriptionError(
        ErrorCode.UnexpectedResponse,
        `${provider} returned a merchant-scheduled subscription without amount, interval or startAt` +
          `; the subscription ${subscription.id} was ${cancelled ? 'cancelled again' : 'created and could NOT be cancelled: cancel it yourself'}`,
        { provider, raw: subscription },
      );
    }
    let schedule: ScheduleRecord;
    try {
      schedule = await scheduler.register({
        provider,
        subscriptionId: subscription.id,
        reference: subscription.reference,
        amount: subscription.amount,
        currency: subscription.currency,
        interval: subscription.interval,
        firstChargeAt: subscription.startAt,
        totalCycles: subscription.totalCycles,
        mandateEndsAt: subscription.mandateEndsAt,
        customer: subscription.customer,
        metadata: subscription.metadata,
        awaitingAuthorization: true,
      });
    } catch (error) {
      const cancelled = await this.abandon(provider, subscription, scheduler);
      throw new SubscriptionError(
        ErrorCode.Internal,
        `${provider} subscription ${subscription.id} was created but its billing schedule could not be registered (${describe(error)}); ` +
          (cancelled ? 'the subscription was cancelled again' : 'it could NOT be cancelled again: cancel it yourself'),
        { provider, raw: subscription, cause: error },
      );
    }
    return overlaySchedule(subscription, schedule, scheduler.now());
  }

  async get(provider: Provider, subscriptionId: string): Promise<Subscription> {
    const adapter = this.provider(provider);
    const scheduler = this.schedulerFor(provider);
    // A gateway that is only ever billed through the scheduler may not know the id the caller holds (PayU: the reference,
    // until the mandate exists): resolve the schedule first and ask the gateway by the id the schedule holds.
    const early =
      scheduler && merchantSchedulingOf(adapter.capabilities) === MerchantScheduling.Always
        ? await this.findSchedule(scheduler, provider, subscriptionId)
        : undefined;
    let subscription: Subscription;
    try {
      subscription = early ? await this.viewOf(adapter, early) : await adapter.getSubscription(subscriptionId);
    } catch (error) {
      // The gateway has no status for a mandate its schedule tracks (PayU answers "Consent is Not Mandated" for a working
      // card mandate): the schedule answers, and nothing is cancelled for it.
      const tracked =
        scheduler && error instanceof SubscriptionError && error.code === ErrorCode.NotFound
          ? await this.findSchedule(scheduler, provider, subscriptionId)
          : undefined;
      if (!scheduler || !tracked) throw error;
      subscription = subscriptionFromSchedule(tracked);
      return guarded(provider, 'reading the billing schedule', async () => overlayTracked(scheduler, tracked, subscription));
    }
    if (subscription.scheduling !== SchedulingMode.Merchant) return subscription;
    if (!scheduler) return subscription;
    return guarded(provider, 'reading the billing schedule', async () => {
      const found = early ?? (await scheduler.find(provider, subscription.reference, subscriptionId, subscription.id));
      if (!found) return subscription;
      const schedule = await syncWithGateway(scheduler, found, subscription);
      return overlaySchedule(subscription, schedule, scheduler.now());
    });
  }

  /**
   * Cancels the subscription. For merchant-scheduled subscriptions billing is
   * stopped FIRST (the schedule is cancelled), then the gateway mandate is
   * cancelled: if the gateway call fails the schedule stays cancelled, so the
   * customer is never billed against a mandate you meant to end, and the error
   * propagates so you can retry. Cancelling twice, or after completion, is fine.
   */
  async cancel(provider: Provider, subscriptionId: string, options?: CancelSubscriptionOptions): Promise<Subscription> {
    const adapter = this.provider(provider);
    const scheduler = this.schedulerFor(provider);
    const found = scheduler ? await this.findSchedule(scheduler, provider, subscriptionId) : undefined;
    if (!scheduler || !found) return adapter.cancelSubscription(subscriptionId, options);

    if (options?.mode === CancelMode.AtPeriodEnd && !adapter.capabilities.cancelAtPeriodEnd) {
      // Refuse before billing is stopped: a merchant-scheduled mandate has no "period" to run to the end of.
      throw unsupported(provider, 'cancelling at the end of the period', 'cancel immediately: billing stops with the schedule');
    }
    const schedule = await guarded(provider, 'cancelling the billing schedule', () => stopBilling(scheduler, found));
    let subscription: Subscription;
    try {
      subscription = await adapter.cancelSubscription(found.subscriptionId, options);
    } catch (error) {
      // The customer never authorised: the gateway has no mandate to cancel, and stopping the schedule was all there was to do.
      if (!noMandateYet(schedule, error)) throw error;
      subscription = subscriptionFromSchedule(schedule);
    }
    return overlaySchedule(subscription, schedule, scheduler.now());
  }

  /**
   * Pauses charging. A merchant-scheduled subscription is paused by the
   * scheduler alone (the gateway's own pause, where it has one, is never used,
   * so the mandate stays valid and nothing can resume it behind the scheduler's
   * back). `resumeAt` makes the scheduler resume it by itself.
   */
  async pause(provider: Provider, subscriptionId: string, options?: PauseSubscriptionOptions): Promise<Subscription> {
    const adapter = this.provider(provider);
    const scheduler = this.schedulerFor(provider);
    const found = scheduler ? await this.findSchedule(scheduler, provider, subscriptionId) : undefined;
    if (!scheduler || !found) return adapter.pauseSubscription(subscriptionId, options);
    const paused = await guarded(provider, 'pausing the billing schedule', () =>
      scheduler.pause(found.id, { resumeAt: options?.resumeAt }),
    );
    const subscription = await this.viewOf(adapter, paused, true);
    return overlaySchedule(subscription, paused, scheduler.now());
  }

  async resume(provider: Provider, subscriptionId: string, options?: ResumeSubscriptionOptions): Promise<Subscription> {
    const adapter = this.provider(provider);
    const scheduler = this.schedulerFor(provider);
    const found = scheduler ? await this.findSchedule(scheduler, provider, subscriptionId) : undefined;
    if (!scheduler || !found) return adapter.resumeSubscription(subscriptionId, options);
    const resumed = await guarded(provider, 'resuming the billing schedule', () =>
      scheduler.resume(found.id, { nextChargeAt: options?.nextChargeAt }),
    );
    const subscription = await this.viewOf(adapter, resumed, true);
    return overlaySchedule(subscription, resumed, scheduler.now());
  }

  /**
   * Updates the subscription. For a merchant-scheduled one the gateway is told
   * what it holds (amount, mandate end) and the schedule gets every field the
   * scheduler can apply (`amount`, `nextChargeAt`, `remainingCycles`,
   * `mandateEndsAt`): nothing is silently dropped. `planId` and `quantity` are
   * refused because the scheduler bills one fixed amount.
   */
  async update(provider: Provider, subscriptionId: string, input: UpdateSubscriptionInput): Promise<Subscription> {
    const adapter = this.provider(provider);
    const scheduler = this.schedulerFor(provider);
    const found = scheduler ? await this.findSchedule(scheduler, provider, subscriptionId) : undefined;
    if (!scheduler || !found) return adapter.updateSubscription(subscriptionId, input);

    if (input.planId !== undefined || input.quantity !== undefined) {
      throw unsupported(
        provider,
        'changing the plan or quantity of a merchant-scheduled subscription',
        'the billing scheduler bills one fixed amount per cycle: update `amount` instead',
      );
    }
    if (found.status === ScheduleStatus.Cancelled || found.status === ScheduleStatus.Completed) {
      throw new SubscriptionError(
        ErrorCode.Conflict,
        `The subscription is ${found.status}; its terms cannot change`,
        { provider },
      );
    }
    const scheduleFields: UpdateScheduleInput = {
      ...(input.amount !== undefined ? { amount: input.amount } : {}),
      ...(input.nextChargeAt !== undefined ? { nextChargeAt: input.nextChargeAt } : {}),
      ...(input.remainingCycles !== undefined ? { remainingCycles: input.remainingCycles } : {}),
      ...(input.mandateEndsAt !== undefined ? { mandateEndsAt: input.mandateEndsAt } : {}),
    };
    const scheduleOnly = input.nextChargeAt !== undefined || input.remainingCycles !== undefined;
    const gatewayInput: UpdateSubscriptionInput = scheduleOnly
      ? {
          ...(input.amount !== undefined ? { amount: input.amount } : {}),
          ...(input.mandateEndsAt !== undefined ? { mandateEndsAt: input.mandateEndsAt } : {}),
          ...(input.timing !== undefined ? { timing: input.timing } : {}),
          ...(input.notifyCustomer !== undefined ? { notifyCustomer: input.notifyCustomer } : {}),
        }
      : input;
    const touchesGateway = input.amount !== undefined || input.mandateEndsAt !== undefined;

    // The gateway first: it validates what it holds (mandate ceiling, modify rules) before the schedule changes.
    const subscription = touchesGateway
      ? await adapter.updateSubscription(found.subscriptionId, gatewayInput)
      : await this.viewOf(adapter, found);
    const updated = await guarded(provider, 'updating the billing schedule', () => scheduler.update(found.id, scheduleFields));
    return overlaySchedule(subscription, updated, scheduler.now());
  }

  /**
   * Verifies what the gateway returned to the browser after the customer
   * authorised, and starts the billing schedule for merchant-scheduled
   * subscriptions. Store `subscriptionId` from the result: on some gateways it
   * only exists from this point.
   *
   * Always pass `expectedSubscriptionId` (the id or reference your server
   * stored at creation): the browser supplies `result`, so without it a
   * customer could present a genuine result from a different subscription.
   *
   * Billing starts only when the customer really authorised and the mandate is
   * not still pending at the bank. If starting it fails after the gateway
   * verified the result, the mandate is live but unbilled: this throws
   * `INTERNAL_ERROR` whose `raw` is the verification (so the new subscription
   * id is not lost); calling `verifyCheckout` again, or a webhook, finishes it.
   */
  async verifyCheckout(
    provider: Provider,
    result: CheckoutResult,
    options: { expectedSubscriptionId?: string } = {},
  ): Promise<CheckoutVerification> {
    const adapter = this.provider(provider);
    const verification = await adapter.verifyCheckout(result);
    const expected = options.expectedSubscriptionId;
    if (expected !== undefined && expected !== verification.subscriptionId && expected !== verification.reference) {
      // The merchant may have stored its own reference. Some gateways' results carry none (Razorpay's), so read the
      // verified subscription once and compare ITS reference.
      // A lookup that fails proves nothing, so it counts as no match (the result is refused, never accepted on a guess).
      const fetched =
        verification.reference === undefined
          ? await adapter.getSubscription(verification.subscriptionId).catch(() => undefined)
          : undefined;
      if (fetched?.reference !== expected) {
        // The signature is genuine but it is for another subscription: treat it exactly like a forged result.
        throw new SubscriptionError(
          ErrorCode.SignatureInvalid,
          `${provider} checkout result is for a different subscription than expected`,
          { provider },
        );
      }
    }
    const scheduler = this.schedulerFor(provider);
    const awaitingBank = verification.status === SubscriptionStatus.PendingAuthorization;
    if (!scheduler || (!verification.authorized && !awaitingBank)) return verification;
    try {
      const schedule = await scheduler.find(provider, verification.reference, verification.subscriptionId);
      if (schedule && awaitsActivation(schedule)) {
        if (awaitingBank) {
          // The customer is done but the bank has not confirmed (eNACH): remember the id the mandate now has, so the
          // scheduler's status checks ask the gateway by it. Billing starts when the mandate is live.
          await scheduler.attachSubscriptionId(schedule.id, verification.subscriptionId);
        } else {
          await scheduler.activate(schedule.id, { subscriptionId: verification.subscriptionId });
        }
      }
    } catch (error) {
      throw new SubscriptionError(
        ErrorCode.Internal,
        `${provider} verified the customer's authorisation, so the mandate ${verification.subscriptionId} is live, but its billing ` +
          `schedule could not be started (${describe(error)}): nothing will be billed until verifyCheckout is called again or the ` +
          "gateway's authorisation webhook is handled. The verification is in `raw`.",
        { provider, raw: verification, cause: error },
      );
    }
    return verification;
  }

  /** Runs the billing scheduler once. Call from a cron job, every 15 minutes or so. */
  tick(options?: { limit?: number }): Promise<TickResult> {
    if (!this.scheduler) {
      return Promise.reject(
        new SubscriptionError(ErrorCode.Config, 'tick() needs a scheduler: pass one to createSubscriptions'),
      );
    }
    const scheduler = this.scheduler;
    return guarded(undefined, 'running the billing scheduler', () => scheduler.tick(options));
  }

  /** The scheduler, when this gateway can be merchant-scheduled at all; otherwise the facade never reads it. */
  private schedulerFor(provider: Provider): BillingScheduler | undefined {
    return this.scheduler && merchantSchedulingOf(this.provider(provider).capabilities) !== MerchantScheduling.Never
      ? this.scheduler
      : undefined;
  }

  /**
   * What the gateway says about the mandate of `schedule`. While the customer has not authorised there may be no mandate
   * the gateway can answer for (PayU knows only the consent, not yet a mandate id): the view is then built from the schedule.
   */
  private async viewOf(adapter: SubscriptionProvider, schedule: ScheduleRecord, anyFailure = false): Promise<Subscription> {
    try {
      return await adapter.getSubscription(schedule.subscriptionId);
    } catch (error) {
      // `anyFailure`: pause and resume are the scheduler's alone and must not depend on a gateway read at all.
      if (anyFailure || noMandateYet(schedule, error) || isNotFound(error)) return subscriptionFromSchedule(schedule);
      throw error;
    }
  }

  /** The ONE way the facade finds a schedule: provider-scoped, by what the caller knows (reference or gateway id). */
  private findSchedule(
    scheduler: BillingScheduler,
    provider: Provider,
    ...keys: Array<string | undefined>
  ): Promise<ScheduleRecord | undefined> {
    return guarded(provider, 'looking up the billing schedule', () => scheduler.find(provider, ...keys));
  }

  /** Best-effort undo of a gateway subscription that could not be scheduled. Never throws; true when it was cancelled. */
  private async abandon(provider: Provider, subscription: Subscription, scheduler?: BillingScheduler): Promise<boolean> {
    try {
      if (scheduler) {
        // Never cancel a subscription some schedule already tracks: an idempotent retry returns a live one.
        const tracked = await scheduler.find(provider, subscription.reference, subscription.id);
        if (tracked && tracked.subscriptionId === subscription.id) return false;
      }
      await this.provider(provider).cancelSubscription(subscription.id);
      return true;
    } catch {
      return false;
    }
  }
}

export function createSubscriptions(options: SubscriptionsOptions): Subscriptions {
  return new Subscriptions(options);
}

/** A ready scheduler (it has `tick`), as opposed to the options to build one from. */
function isScheduler(value: BillingScheduler | SchedulerSettings): value is BillingScheduler {
  return value instanceof BillingScheduler || typeof (value as { tick?: unknown }).tick === 'function';
}

/** Gateway statuses that mean the mandate is live. */
const LIVE_GATEWAY_STATUSES: readonly SubscriptionStatus[] = [SubscriptionStatus.Active, SubscriptionStatus.Trialing];

function missingScheduler(provider: Provider, created?: Subscription, cancelled?: boolean): SubscriptionError {
  return new SubscriptionError(
    ErrorCode.Config,
    `${provider} subscriptions are merchant-scheduled: pass a scheduler to createSubscriptions so charges are raised` +
      (created ? `; the subscription ${created.id} was created at the gateway and ${cancelled ? 'cancelled again' : 'could NOT be cancelled: cancel it yourself'}` : ''),
    { provider, ...(created ? { raw: created } : {}) },
  );
}

/** True when the request can only be served by the billing scheduler, which is knowable before calling the gateway. */
function mustBeMerchantScheduled(adapter: SubscriptionProvider, input: CreateSubscriptionInput): boolean {
  if (merchantSchedulingOf(adapter.capabilities) === MerchantScheduling.Always) return true;
  return typeof input.plan === 'object' && input.plan !== null && input.plan.scheduling === SchedulingMode.Merchant;
}

/** How much of a gateway's billing goes through the scheduler. */
const MerchantScheduling = {
  /** The gateway raises every debit itself (Razorpay). */
  Never: 'never',
  /** Either: a plan chooses (Cashfree periodic or on-demand). */
  Optional: 'optional',
  /** The merchant raises every debit (PayU). */
  Always: 'always',
} as const;
type MerchantScheduling = (typeof MerchantScheduling)[keyof typeof MerchantScheduling];

/**
 * The ONE place the facade decides whether a gateway's subscriptions are merchant-scheduled, from its capabilities:
 * whether a scheduler is consulted for it (`schedulerFor`), whether creating a subscription needs one, whether the schedule
 * is resolved before the gateway is asked, and what `capabilities()` adds.
 */
function merchantSchedulingOf(capabilities: Capabilities): MerchantScheduling {
  const modes = capabilities.scheduling;
  if (!capabilities.merchantCharges && !modes.includes(SchedulingMode.Merchant)) return MerchantScheduling.Never;
  return modes.every((mode) => mode === SchedulingMode.Merchant) ? MerchantScheduling.Always : MerchantScheduling.Optional;
}

function isNotFound(error: unknown): boolean {
  return error instanceof SubscriptionError && error.code === ErrorCode.NotFound;
}

/** The schedule's own view of a subscription the gateway has no status for, overlaid with the schedule's state. */
function overlayTracked(scheduler: BillingScheduler, schedule: ScheduleRecord, subscription: Subscription): Subscription {
  return overlaySchedule(subscription, schedule, scheduler.now());
}

/** True when the schedule never saw the customer authorise and the gateway says it has nothing under that id. */
function noMandateYet(schedule: ScheduleRecord, error: unknown): boolean {
  return (
    schedule.activatedAt === undefined &&
    error instanceof SubscriptionError &&
    (error.code === ErrorCode.Validation || error.code === ErrorCode.NotFound)
  );
}

/** A subscription as far as the schedule knows it, for a mandate the gateway has no record of yet. */
function subscriptionFromSchedule(schedule: ScheduleRecord): Subscription {
  return {
    provider: schedule.provider,
    id: schedule.subscriptionId,
    ...(schedule.reference !== undefined ? { reference: schedule.reference } : {}),
    status: SubscriptionStatus.Created,
    providerStatus: GATEWAY_STATUS_UNAVAILABLE,
    scheduling: SchedulingMode.Merchant,
    ...(schedule.customer !== undefined ? { customer: schedule.customer } : {}),
    amount: schedule.amount,
    currency: schedule.currency,
    interval: schedule.interval,
    ...(schedule.totalCycles !== undefined ? { totalCycles: schedule.totalCycles } : {}),
    createdAt: schedule.createdAt,
    startAt: schedule.firstChargeAt,
    ...(schedule.mandateEndsAt !== undefined ? { mandateEndsAt: schedule.mandateEndsAt } : {}),
    ...(schedule.metadata !== undefined ? { metadata: schedule.metadata } : {}),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs a scheduler interaction; anything that is not already a `SubscriptionError` (a store failure) becomes `INTERNAL_ERROR`. */
async function guarded<T>(provider: Provider | undefined, what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SubscriptionError) throw error;
    throw new SubscriptionError(ErrorCode.Internal, `${what} failed: ${describe(error)}`, { ...(provider !== undefined ? { provider } : {}), cause: error });
  }
}

/** Cancels the schedule unless it is already over; a schedule that is cancelled or completed is left as it is. */
async function stopBilling(scheduler: BillingScheduler, found: ScheduleRecord): Promise<ScheduleRecord> {
  if (found.status === ScheduleStatus.Cancelled || found.status === ScheduleStatus.Completed) return found;
  try {
    return await scheduler.cancel(found.id);
  } catch (error) {
    // It completed between the lookup and the cancel: nothing left to stop.
    const latest = await scheduler.get(found.id);
    if (latest?.status === ScheduleStatus.Completed) return latest;
    throw error;
  }
}

/**
 * Brings the schedule in step with what the gateway reports, for apps without
 * webhooks: a mandate that is live starts (or revives) billing, a mandate that is
 * dead stops it so ticks stop calling it.
 */
async function syncWithGateway(
  scheduler: BillingScheduler,
  schedule: ScheduleRecord,
  subscription: Subscription,
): Promise<ScheduleRecord> {
  const status = subscription.status;
  if (awaitsActivation(schedule) && LIVE_GATEWAY_STATUSES.includes(status)) {
    return scheduler.activate(schedule.id, { subscriptionId: subscription.id });
  }
  const gatewayIsDead =
    status === SubscriptionStatus.Cancelled || status === SubscriptionStatus.Expired || status === SubscriptionStatus.Failed;
  const stillOpen =
    schedule.status === ScheduleStatus.PendingAuthorization ||
    schedule.status === ScheduleStatus.Active ||
    schedule.status === ScheduleStatus.Paused ||
    schedule.status === ScheduleStatus.Halted;
  if (gatewayIsDead && stillOpen) {
    const pending = schedule.status === ScheduleStatus.PendingAuthorization;
    const reason =
      status === SubscriptionStatus.Expired
        ? pending
          ? ScheduleStatusReason.AuthorizationTimeout
          : ScheduleStatusReason.MandateExpired
        : status === SubscriptionStatus.Failed && pending
          ? ScheduleStatusReason.AuthorizationFailed
          : ScheduleStatusReason.CancelledByGateway;
    return scheduler.cancel(schedule.id, { reason });
  }
  return schedule;
}

const SCHEDULE_TO_SUBSCRIPTION_STATUS: Record<ScheduleStatus, SubscriptionStatus | undefined> = {
  [ScheduleStatus.PendingAuthorization]: undefined,
  [ScheduleStatus.Active]: SubscriptionStatus.Active,
  [ScheduleStatus.Paused]: SubscriptionStatus.Paused,
  [ScheduleStatus.Halted]: SubscriptionStatus.Halted,
  [ScheduleStatus.Cancelled]: SubscriptionStatus.Cancelled,
  [ScheduleStatus.Completed]: SubscriptionStatus.Completed,
};

/**
 * For merchant-scheduled subscriptions the gateway only knows the mandate; the
 * billing state lives in the schedule. This merges the two into one view, as of `now`.
 * `trialing` only while nothing is paid and the first charge date is still ahead, `past_due` while a failed
 * debit is being retried. A terminal gateway status (mandate revoked, expired) always wins.
 */
export function overlaySchedule(subscription: Subscription, schedule: ScheduleRecord, now: Date = new Date()): Subscription {
  const merged: Subscription = {
    ...subscription,
    amount: schedule.amount,
    interval: schedule.interval,
    totalCycles: schedule.totalCycles ?? subscription.totalCycles,
    paidCycles: schedule.paidCycles,
    nextChargeAt: schedule.nextChargeAt ?? undefined,
    mandateEndsAt: schedule.mandateEndsAt ?? subscription.mandateEndsAt,
  };
  if (schedule.totalCycles !== undefined) {
    merged.remainingCycles = Math.max(schedule.totalCycles - schedule.paidCycles, 0);
  }

  const gatewayIsTerminal =
    subscription.status === SubscriptionStatus.Cancelled ||
    subscription.status === SubscriptionStatus.Expired ||
    subscription.status === SubscriptionStatus.Failed;
  if (gatewayIsTerminal) return merged;

  const fromSchedule = SCHEDULE_TO_SUBSCRIPTION_STATUS[schedule.status];
  if (fromSchedule === SubscriptionStatus.Active) {
    if (schedule.retrying === true) {
      // A debit failed and is being retried.
      merged.status = SubscriptionStatus.PastDue;
    } else if (schedule.paidCycles === 0 && now.getTime() < Date.parse(schedule.firstChargeAt)) {
      // Mandate is live and the first charge date has not come yet: a free trial or a delayed start.
      merged.status = SubscriptionStatus.Trialing;
      merged.trialEndsAt = schedule.firstChargeAt;
    } else {
      merged.status = SubscriptionStatus.Active;
    }
  } else if (fromSchedule) {
    merged.status = fromSchedule;
  }
  return merged;
}
