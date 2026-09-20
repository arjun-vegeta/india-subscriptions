import { ErrorCode, SchedulingMode, SubscriptionStatus, type Provider } from './constants.js';
import { SubscriptionError } from './errors.js';
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
import { ScheduleStatus } from './scheduler/constants.js';
import type { ScheduleRecord, TickResult } from './scheduler/schemas.js';
import type { BillingScheduler } from './scheduler/scheduler.js';

export interface SubscriptionsOptions {
  /** Gateway adapters, built with `razorpay(...)`, `cashfree(...)`, `payu(...)`. */
  providers: SubscriptionProvider[];
  /**
   * Billing engine for merchant-scheduled mandates (gateways that hold the
   * mandate but expect you to raise each debit). Required to create such
   * subscriptions through this client; call `tick()` from a cron job.
   */
  scheduler?: BillingScheduler;
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

  readonly plans = {
    create: (provider: Provider, input: CreatePlanInput): Promise<Plan> => this.provider(provider).createPlan(input),
    get: (provider: Provider, planId: string): Promise<Plan> => this.provider(provider).getPlan(planId),
  };

  readonly charges = {
    list: (provider: Provider, subscriptionId: string, options?: ListChargesOptions): Promise<Charge[]> =>
      this.provider(provider).listCharges(subscriptionId, options),
    get: (provider: Provider, subscriptionId: string, chargeId: string): Promise<Charge> =>
      this.provider(provider).getCharge(subscriptionId, chargeId),
    /** Raises a debit yourself. With a scheduler configured you normally never call this. */
    create: (provider: Provider, input: CreateChargeInput): Promise<Charge> =>
      this.provider(provider).createCharge(input),
    notify: (provider: Provider, input: NotifyChargeInput): Promise<ChargeNotification> =>
      this.provider(provider).notifyCharge(input),
    refund: (provider: Provider, input: RefundInput): Promise<Refund> => this.provider(provider).refundCharge(input),
  };

  readonly webhooks = {
    /** Verifies the signature and returns normalised events. Pure: nothing is stored. */
    parse: (provider: Provider, request: WebhookRequest): SubscriptionEvent[] =>
      this.provider(provider).parseWebhook(request),
    /** `parse`, then applies each event to the billing scheduler. Use this in your webhook route. */
    handle: async (provider: Provider, request: WebhookRequest): Promise<SubscriptionEvent[]> => {
      const events = this.provider(provider).parseWebhook(request);
      if (this.scheduler) {
        for (const event of events) await this.scheduler.handleEvent(event);
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
    this.scheduler = options.scheduler;
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

  capabilities(name: Provider): Capabilities {
    return this.provider(name).capabilities;
  }

  async create(provider: Provider, input: CreateSubscriptionInput): Promise<Subscription> {
    const subscription = await this.provider(provider).createSubscription(input);
    if (subscription.scheduling !== SchedulingMode.Merchant) return subscription;

    const scheduler = this.requireScheduler(provider);
    if (subscription.amount === undefined || !subscription.interval || !subscription.startAt) {
      throw new SubscriptionError(
        ErrorCode.UnexpectedResponse,
        `${provider} returned a merchant-scheduled subscription without amount, interval or startAt`,
        { provider },
      );
    }
    const schedule = await scheduler.register({
      id: scheduleIdOf(subscription),
      provider,
      subscriptionId: subscription.id,
      reference: subscription.reference,
      amount: subscription.amount,
      currency: subscription.currency,
      interval: subscription.interval,
      firstChargeAt: subscription.startAt,
      totalCycles: subscription.totalCycles,
      customer: subscription.customer,
      metadata: subscription.metadata,
      awaitingAuthorization: true,
    });
    return overlaySchedule(subscription, schedule);
  }

  async get(provider: Provider, subscriptionId: string): Promise<Subscription> {
    const subscription = await this.provider(provider).getSubscription(subscriptionId);
    return this.withSchedule(subscription);
  }

  async cancel(provider: Provider, subscriptionId: string, options?: CancelSubscriptionOptions): Promise<Subscription> {
    const subscription = await this.provider(provider).cancelSubscription(subscriptionId, options);
    const schedule = await this.findSchedule(subscription);
    if (schedule && this.scheduler) {
      return overlaySchedule(subscription, await this.scheduler.cancel(schedule.id));
    }
    return subscription;
  }

  /**
   * Pauses charging. For merchant-scheduled subscriptions this works on every
   * gateway, because pausing is simply the scheduler not raising debits; the
   * gateway is also told when it has a pause operation of its own.
   */
  async pause(provider: Provider, subscriptionId: string, options?: PauseSubscriptionOptions): Promise<Subscription> {
    const adapter = this.provider(provider);
    const schedule = await this.findScheduleById(provider, subscriptionId);
    if (schedule && this.scheduler) {
      const paused = await this.scheduler.pause(schedule.id);
      const subscription = adapter.capabilities.pause
        ? await adapter.pauseSubscription(subscriptionId, options)
        : await adapter.getSubscription(subscriptionId);
      return overlaySchedule(subscription, paused);
    }
    return adapter.pauseSubscription(subscriptionId, options);
  }

  async resume(provider: Provider, subscriptionId: string, options?: ResumeSubscriptionOptions): Promise<Subscription> {
    const adapter = this.provider(provider);
    const schedule = await this.findScheduleById(provider, subscriptionId);
    if (schedule && this.scheduler) {
      const subscription = adapter.capabilities.resume
        ? await adapter.resumeSubscription(subscriptionId, options)
        : await adapter.getSubscription(subscriptionId);
      const resumed = await this.scheduler.resume(schedule.id, { nextChargeAt: options?.nextChargeAt });
      return overlaySchedule(subscription, resumed);
    }
    return adapter.resumeSubscription(subscriptionId, options);
  }

  async update(provider: Provider, subscriptionId: string, input: UpdateSubscriptionInput): Promise<Subscription> {
    const subscription = await this.provider(provider).updateSubscription(subscriptionId, input);
    const schedule = await this.findSchedule(subscription);
    if (schedule && this.scheduler && input.amount !== undefined) {
      return overlaySchedule(subscription, await this.scheduler.updateAmount(schedule.id, input.amount));
    }
    return this.withSchedule(subscription);
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
   */
  async verifyCheckout(
    provider: Provider,
    result: CheckoutResult,
    options: { expectedSubscriptionId?: string } = {},
  ): Promise<CheckoutVerification> {
    const verification = await this.provider(provider).verifyCheckout(result);
    const expected = options.expectedSubscriptionId;
    if (expected !== undefined && expected !== verification.subscriptionId && expected !== verification.reference) {
      // The signature is genuine but it is for another subscription: treat it
      // exactly like a forged result.
      throw new SubscriptionError(
        ErrorCode.SignatureInvalid,
        `${provider} checkout result is for a different subscription than expected`,
        { provider },
      );
    }
    if (!this.scheduler || !verification.authorized) return verification;
    const schedule =
      (verification.reference ? await this.scheduler.get(verification.reference) : undefined) ??
      (await this.scheduler.get(verification.subscriptionId));
    if (schedule && schedule.status === ScheduleStatus.PendingAuthorization) {
      await this.scheduler.activate(schedule.id, { subscriptionId: verification.subscriptionId });
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
    return this.scheduler.tick(options);
  }

  private requireScheduler(provider: Provider): BillingScheduler {
    if (!this.scheduler) {
      throw new SubscriptionError(
        ErrorCode.Config,
        `${provider} subscriptions are merchant-scheduled: pass a scheduler to createSubscriptions so charges are raised`,
        { provider },
      );
    }
    return this.scheduler;
  }

  private async findSchedule(subscription: Subscription): Promise<ScheduleRecord | undefined> {
    if (!this.scheduler) return undefined;
    return (
      (subscription.reference ? await this.scheduler.get(subscription.reference) : undefined) ??
      (await this.scheduler.get(subscription.id))
    );
  }

  private async findScheduleById(provider: Provider, subscriptionId: string): Promise<ScheduleRecord | undefined> {
    if (!this.scheduler) return undefined;
    const direct = await this.scheduler.get(subscriptionId);
    if (direct && direct.provider === provider) return direct;
    return this.scheduler.findBySubscriptionId(provider, subscriptionId);
  }

  private async withSchedule(subscription: Subscription): Promise<Subscription> {
    if (subscription.scheduling !== SchedulingMode.Merchant) return subscription;
    const schedule =
      (await this.findSchedule(subscription)) ?? (await this.findScheduleById(subscription.provider, subscription.id));
    return schedule ? overlaySchedule(subscription, schedule) : subscription;
  }
}

export function createSubscriptions(options: SubscriptionsOptions): Subscriptions {
  return new Subscriptions(options);
}

/** A schedule is keyed by the merchant's reference when there is one, so it survives gateway id changes. */
function scheduleIdOf(subscription: Subscription): string {
  return subscription.reference ?? subscription.id;
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
 * billing state lives in the schedule. This merges the two into one view.
 * A terminal gateway status (mandate revoked, expired) always wins.
 */
export function overlaySchedule(subscription: Subscription, schedule: ScheduleRecord): Subscription {
  const merged: Subscription = {
    ...subscription,
    amount: schedule.amount,
    interval: schedule.interval,
    totalCycles: schedule.totalCycles ?? subscription.totalCycles,
    paidCycles: schedule.paidCycles,
    nextChargeAt: schedule.nextChargeAt ?? undefined,
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
  if (fromSchedule === SubscriptionStatus.Active && schedule.paidCycles === 0 && schedule.nextChargeAt) {
    // Mandate is live but nothing has been charged yet: a free trial or delayed start.
    merged.status = SubscriptionStatus.Trialing;
    merged.trialEndsAt = schedule.nextChargeAt;
  } else if (fromSchedule) {
    merged.status = fromSchedule;
  }
  return merged;
}
