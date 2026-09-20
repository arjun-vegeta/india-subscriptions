import { Subscriptions } from '../../src/client.js';
import {
  CancelMode,
  ChargeKind,
  ChargeStatus,
  CheckoutKind,
  Currency,
  ErrorCode,
  EventType,
  IntervalUnit,
  PaymentMethod,
  Provider,
  RefundStatus,
  SchedulingMode,
  SubscriptionStatus,
} from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import { BaseProvider, type GatewayErrorInfo } from '../../src/provider.js';
import type {
  BillingInterval,
  CancelSubscriptionOptions,
  Capabilities,
  Charge,
  ChargeNotification,
  CheckoutResult,
  CheckoutVerification,
  CreateChargeInput,
  CreatePlanInput,
  CreateSubscriptionInput,
  Customer,
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
} from '../../src/schemas.js';
import {
  BillingScheduler,
  MemorySchedulerStore,
  type CycleRecord,
  type ScheduleRecord,
  type SchedulerConfigInput,
  type SchedulerEvent,
  type SchedulerStore,
  type TickResult,
} from '../../src/scheduler/index.js';
import { FakeClock, HOUR, T0, plusHours } from '../scheduler/helpers.js';

export { FakeClock, HOUR, T0, plusHours };

// ---------------------------------------------------------------------------
// Time fixtures
// ---------------------------------------------------------------------------

export const DAY = 24 * HOUR;
/** The end of a 14-day trial that starts at `T0`. */
export const TRIAL_END = plusHours(T0, 14 * 24);
/** Monthly billing is computed in IST: 15 Jan 05:30 IST, 15 Feb 05:30 IST, ... */
export const CYCLE_2 = '2026-02-15T00:00:00.000Z';
export const CYCLE_3 = '2026-03-15T00:00:00.000Z';
export const AMOUNT = 49900;
export const REFERENCE = 'ref-1';

// ---------------------------------------------------------------------------
// Fake-gateway vocabulary (the fake's own wire format; nothing here is a gateway's)
// ---------------------------------------------------------------------------

export const SIGNATURE_HEADER = 'x-fake-signature';
export const VALID_SIGNATURE = 'valid';
export const FORGED_SIGNATURE = 'forged';
export const CHECKOUT_ID_FIELD = 'subscription_id';
export const CHECKOUT_SIGNATURE_FIELD = 'signature';
export const CHECKOUT_URL = 'https://gateway.example.test/authorize';

export const GatewayMethod = {
  CreatePlan: 'createPlan',
  GetPlan: 'getPlan',
  CreateSubscription: 'createSubscription',
  GetSubscription: 'getSubscription',
  CancelSubscription: 'cancelSubscription',
  PauseSubscription: 'pauseSubscription',
  ResumeSubscription: 'resumeSubscription',
  UpdateSubscription: 'updateSubscription',
  ListCharges: 'listCharges',
  GetCharge: 'getCharge',
  NotifyCharge: 'notifyCharge',
  CreateCharge: 'createCharge',
  RefundCharge: 'refundCharge',
  VerifyCheckout: 'verifyCheckout',
  ParseWebhook: 'parseWebhook',
} as const;
export type GatewayMethod = (typeof GatewayMethod)[keyof typeof GatewayMethod];

export const StoreMethod = {
  GetSchedule: 'getSchedule',
  SaveSchedule: 'saveSchedule',
  FindBySubscriptionId: 'findBySubscriptionId',
  ListDueSchedules: 'listDueSchedules',
  GetCycle: 'getCycle',
  SaveCycle: 'saveCycle',
  ListCycles: 'listCycles',
  AcquireLock: 'acquireLock',
  ReleaseLock: 'releaseLock',
} as const;
export type StoreMethod = (typeof StoreMethod)[keyof typeof StoreMethod];

/** Store calls that change state or take a lock: a facade that "does not touch the scheduler" makes none of them. */
export const STORE_WRITES: readonly StoreMethod[] = [
  StoreMethod.SaveSchedule,
  StoreMethod.SaveCycle,
  StoreMethod.AcquireLock,
];

export const ProviderCode = {
  MandateInactive: 'MANDATE_INACTIVE',
  UnknownMandate: 'UNKNOWN_MANDATE',
  NoPreDebitNotice: 'NO_PRE_DEBIT_NOTICE',
  TooLateToSchedule: 'TOO_LATE_TO_SCHEDULE',
  InsufficientFunds: 'INSUFFICIENT_FUNDS',
} as const;

/** How the fake gateway answers the next `createCharge`. */
export const ChargeOutcome = {
  Succeed: 'succeed',
  Fail: 'fail',
  Pending: 'pending',
  Scheduled: 'scheduled',
  Reject: 'reject',
} as const;
export type ChargeOutcome = (typeof ChargeOutcome)[keyof typeof ChargeOutcome];

/** The four gateway shapes the facade has to cope with. */
export const Style = {
  /** Razorpay-like: the gateway raises every debit. */
  Gateway: 'gateway',
  /** PayU-like: merchant raises debits and sends the pre-debit notification (`notifyCharge`). */
  Notify: 'notify',
  /** Cashfree-on-demand-like: merchant raises each debit `merchantChargeLeadHours` ahead; the gateway notifies. */
  Advance: 'advance',
  /** Cashfree-like: gateway-scheduled by default, merchant-scheduled when the plan asks for it. */
  Dual: 'dual',
} as const;
export type Style = (typeof Style)[keyof typeof Style];

const DEFAULT_NAME: Record<Style, Provider> = {
  [Style.Gateway]: Provider.Razorpay,
  [Style.Notify]: Provider.PayU,
  [Style.Advance]: Provider.Cashfree,
  [Style.Dual]: Provider.Cashfree,
};

const MIN_NOTICE_HOURS = 24;

function capabilitiesFor(name: Provider, style: Style, pause: boolean, resume: boolean, leadHours: number): Capabilities {
  const schedulingModes: Record<Style, SchedulingMode[]> = {
    [Style.Gateway]: [SchedulingMode.Gateway],
    [Style.Notify]: [SchedulingMode.Merchant],
    [Style.Advance]: [SchedulingMode.Merchant],
    [Style.Dual]: [SchedulingMode.Gateway, SchedulingMode.Merchant],
  };
  return {
    provider: name,
    scheduling: schedulingModes[style],
    gatewayPlans: false,
    trial: true,
    upfrontAmount: true,
    quantity: false,
    pause,
    resume,
    cancelAtPeriodEnd: false,
    changePlan: false,
    merchantCharges: style !== Style.Gateway,
    merchantPreDebitNotification: style === Style.Notify,
    ...(style === Style.Advance || style === Style.Dual ? { merchantChargeLeadHours: leadHours } : {}),
    listCharges: true,
    refunds: false,
    signedWebhooks: true,
    idempotencyKeys: true,
    paymentMethods: [PaymentMethod.Upi],
  };
}

export interface RecordedCall {
  method: GatewayMethod;
  args: unknown[];
  /** The fake clock's reading when the call arrived. */
  at: string;
}

export interface GatewayOptions {
  style?: Style;
  name?: Provider;
  /** Whether the gateway has its own pause / resume operation. Default: only the gateway-scheduled style. */
  pause?: boolean;
  resume?: boolean;
  /** `merchantChargeLeadHours` for the advance styles. */
  leadHours?: number;
  /** The subscription id changes when the customer authorises (PayU: merchant reference -> mandate id). */
  idChanges?: boolean;
  /** After an id change, does the gateway still put the merchant reference on the subscription? Default false. */
  echoReferenceAfterAuth?: boolean;
  /** Fields the gateway leaves off a merchant-scheduled subscription it returns. */
  omit?: Array<'amount' | 'interval' | 'startAt'>;
  clock: () => Date;
  /** A log shared with the store, to assert the order of gateway and store calls. */
  log?: string[];
}

interface GatewaySubscription {
  id: string;
  /** The id before authorisation, when the id changed. */
  preAuthId?: string;
  reference?: string;
  status: SubscriptionStatus;
  scheduling: SchedulingMode;
  amount: number;
  interval: BillingInterval;
  totalCycles?: number;
  startAt: string;
  createdAt: string;
  customer?: Customer;
  metadata?: Record<string, string>;
  authorized: boolean;
  resumeAt?: string;
  mandateEndsAt?: string;
}

interface RecordedNotification {
  subscriptionId: string;
  at: string;
  debitAt: string;
  amount: number;
}

const DEFAULT_PLAN = { amount: AMOUNT, interval: { unit: IntervalUnit.Month, count: 1 } } as const;

/**
 * A scriptable gateway that behaves the way the real ones do where it matters
 * to the facade: it keys everything by the id it currently knows, rejects
 * debits on a mandate that is not active, de-duplicates debits by `chargeId`,
 * enforces the 24-hour pre-debit notice (notify style) and the charge lead time
 * (advance style), and records every call.
 */
export class FakeGateway extends BaseProvider {
  readonly name: Provider;
  readonly capabilities: Capabilities;
  readonly style: Style;

  readonly calls: RecordedCall[] = [];
  readonly subscriptions = new Map<string, GatewaySubscription>();
  readonly charges = new Map<string, Charge>();
  readonly notifications: RecordedNotification[] = [];

  /** Outcomes for the next `createCharge` calls, consumed in order. */
  chargeScript: ChargeOutcome[] = [];
  /** Keep scheduled charges `scheduled` even after their date. */
  holdScheduled = false;
  /** Refuse every pre-debit notification (the gateway answers `accepted: false`). */
  rejectNotifications = false;

  private readonly options: GatewayOptions;
  private readonly aliases = new Map<string, string>();
  private readonly byIdempotencyKey = new Map<string, GatewaySubscription>();
  private readonly failures = new Map<GatewayMethod, Error>();
  private seq = 0;

  constructor(options: GatewayOptions) {
    super({
      fetch: async () => {
        throw new Error('the fake gateway never uses the network');
      },
      now: options.clock,
    });
    this.options = options;
    this.style = options.style ?? Style.Notify;
    this.name = options.name ?? DEFAULT_NAME[this.style];
    const isGateway = this.style === Style.Gateway;
    this.capabilities = capabilitiesFor(
      this.name,
      this.style,
      options.pause ?? isGateway,
      options.resume ?? isGateway,
      options.leadHours ?? 24,
    );
  }

  // --- scripting ---------------------------------------------------------

  /** Makes the next call to `method` throw `error` before it changes anything. */
  failOnce(method: GatewayMethod, error: Error = new SubscriptionError(ErrorCode.ProviderUnavailable, 'gateway down', { provider: this.name })): void {
    this.failures.set(method, error);
  }

  callsTo(method: GatewayMethod): RecordedCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  /** The gateway-side subscription by its current id. */
  sub(id: string): GatewaySubscription {
    const found = this.subscriptions.get(id);
    if (!found) throw new Error(`fake gateway has no subscription ${id}`);
    return found;
  }

  /** The most recently created gateway-side subscription. */
  last(): GatewaySubscription {
    const all = [...this.subscriptions.values()];
    const found = all[all.length - 1];
    if (!found) throw new Error('fake gateway has no subscriptions');
    return found;
  }

  /** Simulates the bank or the customer changing the mandate behind the merchant's back. */
  setStatus(id: string, status: SubscriptionStatus): void {
    this.sub(id).status = status;
  }

  /** Changes the status of a debit the gateway already holds (the bank's answer arriving later). */
  settle(chargeId: string, status: ChargeStatus): Charge {
    const existing = this.charges.get(chargeId);
    if (!existing) throw new Error(`fake gateway has no charge ${chargeId}`);
    const updated: Charge = { ...existing, status };
    this.charges.set(chargeId, updated);
    return updated;
  }

  /**
   * The customer approves the mandate in their bank app. Returns what the
   * browser hands back to the merchant (`checkoutResult`). When the gateway
   * changes ids at authorisation, the subscription gets its mandate id here.
   */
  authorize(id: string): CheckoutResult {
    const sub = this.resolve(id);
    if (sub.status !== SubscriptionStatus.Cancelled && sub.status !== SubscriptionStatus.Expired) {
      sub.authorized = true;
      sub.status = SubscriptionStatus.Active;
      if (this.options.idChanges && sub.preAuthId === undefined) {
        sub.preAuthId = sub.id;
        this.subscriptions.delete(sub.id);
        sub.id = `mandate_${++this.seq}`;
        this.subscriptions.set(sub.id, sub);
        this.aliases.set(sub.preAuthId, sub.id);
      }
    }
    return this.checkoutResult(id);
  }

  checkoutResult(idKnownToBrowser: string, signature: string = VALID_SIGNATURE): CheckoutResult {
    return { [CHECKOUT_ID_FIELD]: idKnownToBrowser, [CHECKOUT_SIGNATURE_FIELD]: signature };
  }

  /** A signed webhook request carrying one event about `subscriptionId`. */
  webhook(
    type: EventType,
    subscriptionId: string,
    extra: { chargeId?: string; withReference?: boolean; signature?: string; eventId?: string } = {},
  ): WebhookRequest {
    const sub = this.subscriptions.get(subscriptionId);
    const reference = extra.withReference === false ? undefined : (sub?.reference ?? sub?.preAuthId);
    const event: FakeWebhookEvent = {
      id: extra.eventId ?? `evt_${++this.seq}`,
      type,
      subscriptionId,
      ...(reference !== undefined ? { reference } : {}),
      ...(extra.chargeId !== undefined ? { chargeId: extra.chargeId } : {}),
    };
    return {
      rawBody: JSON.stringify({ events: [event] }),
      headers: { [SIGNATURE_HEADER]: extra.signature ?? VALID_SIGNATURE },
    };
  }

  // --- SubscriptionProvider ----------------------------------------------

  protected describeError(response: { text: string }): GatewayErrorInfo {
    return { message: response.text };
  }

  async createSubscription(input: CreateSubscriptionInput): Promise<Subscription> {
    this.enter(GatewayMethod.CreateSubscription, [input]);
    if (input.idempotencyKey !== undefined) {
      const prior = this.byIdempotencyKey.get(input.idempotencyKey);
      if (prior) return this.view(prior, true);
    }
    const plan = typeof input.plan === 'string' ? DEFAULT_PLAN : input.plan;
    const scheduling =
      this.style === Style.Gateway
        ? SchedulingMode.Gateway
        : this.style === Style.Dual
          ? (typeof input.plan === 'string' ? undefined : input.plan.scheduling) ?? SchedulingMode.Gateway
          : SchedulingMode.Merchant;
    const now = this.now();
    let startAt = now.toISOString();
    if (input.startAt !== undefined) startAt = new Date(input.startAt).toISOString();
    else if (input.trial?.endsAt !== undefined) startAt = new Date(input.trial.endsAt).toISOString();
    else if (input.trial?.days !== undefined) startAt = new Date(now.getTime() + input.trial.days * DAY).toISOString();

    const preAuthId = this.options.idChanges ? (input.reference ?? `txn_${++this.seq}`) : undefined;
    const sub: GatewaySubscription = {
      id: preAuthId ?? `${this.name}_sub_${++this.seq}`,
      reference: input.reference,
      status: SubscriptionStatus.Created,
      scheduling,
      amount: plan.amount,
      interval: plan.interval,
      totalCycles: input.totalCycles,
      startAt,
      createdAt: now.toISOString(),
      customer: input.customer,
      metadata: input.metadata,
      authorized: false,
      ...(input.mandateEndsAt !== undefined ? { mandateEndsAt: new Date(input.mandateEndsAt).toISOString() } : {}),
    };
    this.subscriptions.set(sub.id, sub);
    if (input.idempotencyKey !== undefined) this.byIdempotencyKey.set(input.idempotencyKey, sub);
    return this.view(sub, true);
  }

  async getSubscription(subscriptionId: string): Promise<Subscription> {
    this.enter(GatewayMethod.GetSubscription, [subscriptionId]);
    return this.view(this.resolve(subscriptionId), false);
  }

  async cancelSubscription(subscriptionId: string, options?: CancelSubscriptionOptions): Promise<Subscription> {
    this.enter(GatewayMethod.CancelSubscription, [subscriptionId, options]);
    const sub = this.resolve(subscriptionId);
    sub.status = SubscriptionStatus.Cancelled;
    return this.view(sub, false);
  }

  override async pauseSubscription(subscriptionId: string, options?: PauseSubscriptionOptions): Promise<Subscription> {
    this.enter(GatewayMethod.PauseSubscription, [subscriptionId, options]);
    if (!this.capabilities.pause) return super.pauseSubscription(subscriptionId, options);
    const sub = this.resolve(subscriptionId);
    sub.status = SubscriptionStatus.Paused;
    if (options?.resumeAt !== undefined) sub.resumeAt = new Date(options.resumeAt).toISOString();
    return this.view(sub, false);
  }

  override async resumeSubscription(subscriptionId: string, options?: ResumeSubscriptionOptions): Promise<Subscription> {
    this.enter(GatewayMethod.ResumeSubscription, [subscriptionId, options]);
    if (!this.capabilities.resume) return super.resumeSubscription(subscriptionId, options);
    const sub = this.resolve(subscriptionId);
    sub.status = SubscriptionStatus.Active;
    delete sub.resumeAt;
    return this.view(sub, false);
  }

  override async updateSubscription(subscriptionId: string, input: UpdateSubscriptionInput): Promise<Subscription> {
    this.enter(GatewayMethod.UpdateSubscription, [subscriptionId, input]);
    const sub = this.resolve(subscriptionId);
    if (input.amount !== undefined) sub.amount = input.amount;
    return this.view(sub, false);
  }

  override async listCharges(subscriptionId: string, options?: ListChargesOptions): Promise<Charge[]> {
    this.enter(GatewayMethod.ListCharges, [subscriptionId, options]);
    return [...this.charges.values()].filter((charge) => charge.subscriptionId === subscriptionId);
  }

  override async getCharge(subscriptionId: string, chargeId: string): Promise<Charge> {
    this.enter(GatewayMethod.GetCharge, [subscriptionId, chargeId]);
    const charge = this.charges.get(chargeId);
    if (!charge || charge.subscriptionId !== subscriptionId) {
      throw new SubscriptionError(ErrorCode.NotFound, `no charge ${chargeId}`, { provider: this.name });
    }
    if (
      charge.status === ChargeStatus.Scheduled &&
      !this.holdScheduled &&
      charge.scheduledAt !== undefined &&
      this.now().getTime() >= Date.parse(charge.scheduledAt)
    ) {
      return this.settle(chargeId, ChargeStatus.Succeeded);
    }
    return charge;
  }

  override async notifyCharge(input: NotifyChargeInput): Promise<ChargeNotification> {
    this.enter(GatewayMethod.NotifyCharge, [input]);
    const sub = this.mandate(input.subscriptionId);
    if (sub.status !== SubscriptionStatus.Active) {
      throw new SubscriptionError(ErrorCode.ProviderError, 'mandate is not active', {
        provider: this.name,
        providerCode: ProviderCode.MandateInactive,
      });
    }
    const accepted = !this.rejectNotifications;
    if (accepted) {
      this.notifications.push({
        subscriptionId: sub.id,
        at: this.now().toISOString(),
        debitAt: input.debitAt,
        amount: input.amount,
      });
    }
    return {
      provider: this.name,
      id: input.notificationId,
      subscriptionId: input.subscriptionId,
      accepted,
      amount: input.amount,
      debitAt: input.debitAt,
      invoiceNumber: `INV-${input.notificationId}`,
      raw: null,
    };
  }

  override async createCharge(input: CreateChargeInput): Promise<Charge> {
    this.enter(GatewayMethod.CreateCharge, [input]);
    const sub = this.mandate(input.subscriptionId);
    const existing = this.charges.get(input.chargeId);
    if (existing) return existing;
    const reject = (providerCode: string, message: string): SubscriptionError =>
      new SubscriptionError(ErrorCode.ProviderError, message, { provider: this.name, providerCode });
    if (sub.status !== SubscriptionStatus.Active) throw reject(ProviderCode.MandateInactive, 'mandate is not active');

    const now = this.now().getTime();
    if (this.style === Style.Notify) {
      const noticed = this.notifications.some(
        (note) => note.subscriptionId === sub.id && Date.parse(note.at) + MIN_NOTICE_HOURS * HOUR <= now,
      );
      if (!noticed) throw reject(ProviderCode.NoPreDebitNotice, 'no pre-debit notification at least 24h old');
    } else {
      const lead = (this.capabilities.merchantChargeLeadHours ?? 0) * HOUR;
      if (input.scheduledAt === undefined || Date.parse(input.scheduledAt) < now + lead) {
        throw reject(ProviderCode.TooLateToSchedule, 'charge must be scheduled at least the lead time ahead');
      }
    }

    const outcome = this.chargeScript.shift() ?? (this.style === Style.Notify ? ChargeOutcome.Succeed : ChargeOutcome.Scheduled);
    if (outcome === ChargeOutcome.Reject) throw reject(ProviderCode.MandateInactive, 'gateway refused the debit');
    const status: Record<Exclude<ChargeOutcome, 'reject'>, ChargeStatus> = {
      [ChargeOutcome.Succeed]: ChargeStatus.Succeeded,
      [ChargeOutcome.Fail]: ChargeStatus.Failed,
      [ChargeOutcome.Pending]: ChargeStatus.Pending,
      [ChargeOutcome.Scheduled]: ChargeStatus.Scheduled,
    };
    const charge: Charge = {
      provider: this.name,
      id: `pay_${input.chargeId}`,
      reference: input.chargeId,
      subscriptionId: input.subscriptionId,
      kind: ChargeKind.Recurring,
      status: status[outcome],
      amount: input.amount,
      currency: Currency.INR,
      ...(input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt } : {}),
      ...(outcome === ChargeOutcome.Fail
        ? { failureCode: ProviderCode.InsufficientFunds, failureReason: 'Insufficient funds' }
        : {}),
      raw: null,
    };
    this.charges.set(input.chargeId, charge);
    return charge;
  }

  async verifyCheckout(result: CheckoutResult): Promise<CheckoutVerification> {
    this.enter(GatewayMethod.VerifyCheckout, [result]);
    if (result[CHECKOUT_SIGNATURE_FIELD] !== VALID_SIGNATURE) {
      throw new SubscriptionError(ErrorCode.SignatureInvalid, 'checkout signature does not verify', { provider: this.name });
    }
    const sub = this.resolve(String(result[CHECKOUT_ID_FIELD]));
    return {
      provider: this.name,
      subscriptionId: sub.id,
      reference: sub.reference ?? sub.preAuthId,
      authorized: sub.authorized,
      status: sub.status,
      raw: result,
    };
  }

  parseWebhook(request: WebhookRequest): SubscriptionEvent[] {
    this.enter(GatewayMethod.ParseWebhook, [request]);
    if (request.headers[SIGNATURE_HEADER] !== VALID_SIGNATURE) {
      throw new SubscriptionError(ErrorCode.SignatureInvalid, 'webhook signature does not verify', { provider: this.name });
    }
    const body = JSON.parse(request.rawBody) as { events: FakeWebhookEvent[] };
    return body.events.map((event) => {
      const id = event.subscriptionId ?? event.reference;
      return {
        id: event.id,
        provider: this.name,
        type: event.type,
        providerEventType: event.type,
        ...(event.subscriptionId !== undefined ? { subscriptionId: event.subscriptionId } : {}),
        ...(id !== undefined
          ? {
              subscription: {
                provider: this.name,
                id,
                ...(event.reference !== undefined ? { reference: event.reference } : {}),
                status: SubscriptionStatus.Active,
                providerStatus: SubscriptionStatus.Active,
                scheduling: this.style === Style.Gateway ? SchedulingMode.Gateway : SchedulingMode.Merchant,
                raw: null,
              },
            }
          : {}),
        ...(event.chargeId !== undefined && this.charges.has(event.chargeId)
          ? { charge: this.charges.get(event.chargeId) }
          : {}),
        raw: event,
      };
    });
  }

  // --- unsupported by this fake (the facade never needs them from the fake) ---
  override createPlan(_input: CreatePlanInput): Promise<Plan> {
    return super.createPlan(_input);
  }
  override refundCharge(_input: RefundInput): Promise<Refund> {
    return super.refundCharge(_input);
  }

  // --- internals ---------------------------------------------------------

  private enter(method: GatewayMethod, args: unknown[]): void {
    this.calls.push({ method, args, at: this.now().toISOString() });
    this.options.log?.push(`${this.name}.${method}`);
    const failure = this.failures.get(method);
    if (failure) {
      this.failures.delete(method);
      throw failure;
    }
  }

  /** By the current id, or by the id the subscription had before authorisation. */
  private resolve(id: string): GatewaySubscription {
    const sub = this.subscriptions.get(id) ?? this.subscriptions.get(this.aliases.get(id) ?? '');
    if (!sub) throw new SubscriptionError(ErrorCode.NotFound, `no subscription ${id}`, { provider: this.name });
    return this.expire(sub);
  }

  /** Money-moving calls are keyed strictly by the mandate's current id. */
  private mandate(id: string): GatewaySubscription {
    const sub = this.subscriptions.get(id);
    if (!sub) {
      throw new SubscriptionError(ErrorCode.ProviderError, `unknown mandate ${id}`, {
        provider: this.name,
        providerCode: ProviderCode.UnknownMandate,
      });
    }
    return this.expire(sub);
  }

  /** A mandate stops being usable when its end date passes. */
  private expire(sub: GatewaySubscription): GatewaySubscription {
    if (
      sub.status === SubscriptionStatus.Active &&
      sub.mandateEndsAt !== undefined &&
      this.now().getTime() >= Date.parse(sub.mandateEndsAt)
    ) {
      sub.status = SubscriptionStatus.Expired;
    }
    return sub;
  }

  private view(sub: GatewaySubscription, fresh: boolean): Subscription {
    if (sub.status === SubscriptionStatus.Paused && sub.resumeAt !== undefined && this.now().getTime() >= Date.parse(sub.resumeAt)) {
      sub.status = SubscriptionStatus.Active;
      delete sub.resumeAt;
    }
    const merchant = sub.scheduling === SchedulingMode.Merchant;
    const omit = merchant ? (this.options.omit ?? []) : [];
    const showReference =
      sub.reference !== undefined && !(sub.preAuthId !== undefined && !(this.options.echoReferenceAfterAuth ?? false));
    return {
      provider: this.name,
      id: sub.id,
      ...(showReference ? { reference: sub.reference } : {}),
      status: sub.status,
      providerStatus: sub.status,
      scheduling: sub.scheduling,
      ...(sub.customer !== undefined ? { customer: sub.customer } : {}),
      ...(omit.includes('amount') ? {} : { amount: sub.amount }),
      currency: Currency.INR,
      ...(omit.includes('interval') ? {} : { interval: sub.interval }),
      ...(sub.totalCycles !== undefined ? { totalCycles: sub.totalCycles } : {}),
      createdAt: sub.createdAt,
      ...(omit.includes('startAt') ? {} : { startAt: sub.startAt }),
      ...(sub.mandateEndsAt !== undefined ? { mandateEndsAt: sub.mandateEndsAt } : {}),
      ...(fresh ? { checkout: { kind: CheckoutKind.Redirect, url: CHECKOUT_URL } } : {}),
      ...(sub.metadata !== undefined ? { metadata: sub.metadata } : {}),
      raw: { fake: sub.id },
    };
  }
}

export interface FakeWebhookEvent {
  id: string;
  type: EventType;
  subscriptionId?: string;
  reference?: string;
  chargeId?: string;
}

// ---------------------------------------------------------------------------
// A store that can be told to fail and that logs every call
// ---------------------------------------------------------------------------

interface Fault {
  method: StoreMethod;
  error: Error;
  remaining: number;
  when?: (argument: unknown) => boolean;
}

export const STORE_DOWN = 'store down';

export class InstrumentedStore implements SchedulerStore {
  readonly inner = new MemorySchedulerStore();
  readonly calls: StoreMethod[] = [];
  private readonly faults: Fault[] = [];

  constructor(private readonly log?: string[]) {}

  /** Makes the next `times` calls to `method` (optionally only those whose first argument matches) throw. */
  fail(method: StoreMethod, options: { error?: Error; times?: number; when?: (argument: unknown) => boolean } = {}): void {
    this.faults.push({
      method,
      error: options.error ?? new Error(STORE_DOWN),
      remaining: options.times ?? 1,
      when: options.when,
    });
  }

  writes(): StoreMethod[] {
    return this.calls.filter((call) => STORE_WRITES.includes(call));
  }

  private enter(method: StoreMethod, argument?: unknown): void {
    this.calls.push(method);
    this.log?.push(`store.${method}`);
    const fault = this.faults.find(
      (candidate) =>
        candidate.method === method && candidate.remaining > 0 && (!candidate.when || candidate.when(argument)),
    );
    if (fault) {
      fault.remaining -= 1;
      throw fault.error;
    }
  }

  async getSchedule(id: string): Promise<ScheduleRecord | undefined> {
    this.enter(StoreMethod.GetSchedule, id);
    return this.inner.getSchedule(id);
  }
  async saveSchedule(schedule: ScheduleRecord): Promise<void> {
    this.enter(StoreMethod.SaveSchedule, schedule);
    return this.inner.saveSchedule(schedule);
  }
  async findBySubscriptionId(provider: Provider, subscriptionId: string): Promise<ScheduleRecord | undefined> {
    this.enter(StoreMethod.FindBySubscriptionId, subscriptionId);
    return this.inner.findBySubscriptionId(provider, subscriptionId);
  }
  async listDueSchedules(at: string, limit: number): Promise<ScheduleRecord[]> {
    this.enter(StoreMethod.ListDueSchedules, at);
    return this.inner.listDueSchedules(at, limit);
  }
  async getCycle(scheduleId: string, index: number): Promise<CycleRecord | undefined> {
    this.enter(StoreMethod.GetCycle, scheduleId);
    return this.inner.getCycle(scheduleId, index);
  }
  async saveCycle(cycle: CycleRecord): Promise<void> {
    this.enter(StoreMethod.SaveCycle, cycle);
    return this.inner.saveCycle(cycle);
  }
  async listCycles(scheduleId: string): Promise<CycleRecord[]> {
    this.enter(StoreMethod.ListCycles, scheduleId);
    return this.inner.listCycles(scheduleId);
  }
  async acquireLock(scheduleId: string, ttlMs: number): Promise<string | undefined> {
    this.enter(StoreMethod.AcquireLock, scheduleId);
    return this.inner.acquireLock(scheduleId, ttlMs);
  }
  async releaseLock(scheduleId: string, token: string): Promise<void> {
    this.enter(StoreMethod.ReleaseLock, scheduleId);
    return this.inner.releaseLock(scheduleId, token);
  }
}

// ---------------------------------------------------------------------------
// The assembled world: real Subscriptions + real BillingScheduler + fake clock
// ---------------------------------------------------------------------------

export interface WorldOptions {
  /** One gateway per entry. Default: a single notify-style (PayU-like) gateway. */
  gateways?: Array<Omit<GatewayOptions, 'clock' | 'log'>>;
  /** `false` builds a client with no scheduler. */
  scheduler?: false | Omit<SchedulerConfigInput, never>;
  startAt?: string;
}

export interface World {
  clock: FakeClock;
  log: string[];
  store: InstrumentedStore;
  scheduler: BillingScheduler | undefined;
  subs: Subscriptions;
  /** The first gateway. */
  gateway: FakeGateway;
  gateways: FakeGateway[];
  events: SchedulerEvent[];
  /** Moves the clock to `iso`, then ticks through the facade. */
  at(iso: string): Promise<TickResult>;
  /** Moves the clock without ticking. */
  setClock(iso: string): void;
  gw(name: Provider): FakeGateway;
}

export function makeWorld(options: WorldOptions = {}): World {
  const clock = new FakeClock(options.startAt ?? T0);
  const log: string[] = [];
  const store = new InstrumentedStore(log);
  const events: SchedulerEvent[] = [];
  const gateways = (options.gateways ?? [{ style: Style.Notify }]).map(
    (spec) => new FakeGateway({ ...spec, clock: clock.now, log }),
  );
  const registry = new Map(gateways.map((gateway) => [gateway.name, gateway]));
  const scheduler =
    options.scheduler === false
      ? undefined
      : new BillingScheduler({
          ...options.scheduler,
          store,
          resolveProvider: (name) => {
            const gateway = registry.get(name);
            if (!gateway) throw new Error(`no gateway ${name}`);
            return gateway;
          },
          now: clock.now,
          onEvent: (event) => {
            events.push(event);
          },
        });
  const subs = new Subscriptions({ providers: gateways, scheduler });
  const first = gateways[0];
  if (!first) throw new Error('a world needs a gateway');
  return {
    clock,
    log,
    store,
    scheduler,
    subs,
    gateway: first,
    gateways,
    events,
    async at(iso) {
      clock.set(iso);
      return subs.tick();
    },
    setClock: (iso) => clock.set(iso),
    gw(name) {
      const found = registry.get(name);
      if (!found) throw new Error(`no gateway ${name}`);
      return found;
    },
  };
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** A merchant-scheduled monthly plan, three cycles, 14-day free trial. */
export function trialInput(overrides: Partial<CreateSubscriptionInput> = {}): CreateSubscriptionInput {
  return {
    reference: REFERENCE,
    plan: {
      name: 'Pro',
      amount: AMOUNT,
      interval: { unit: IntervalUnit.Month, count: 1 },
      scheduling: SchedulingMode.Merchant,
    },
    customer: { name: 'Asha Rao', email: 'asha@example.in', phone: '9876543210' },
    totalCycles: 3,
    trial: { days: 14 },
    metadata: { account: 'acct_42' },
    ...overrides,
  };
}

/** The same without a trial: the first charge is due as soon as the customer authorises. */
export function immediateInput(overrides: Partial<CreateSubscriptionInput> = {}): CreateSubscriptionInput {
  const { trial: _trial, ...rest } = trialInput();
  return { ...rest, ...overrides };
}

/** A plain gateway-scheduled subscription request (no scheduler involvement). */
export function gatewayInput(overrides: Partial<CreateSubscriptionInput> = {}): CreateSubscriptionInput {
  return {
    reference: 'gw-ref-1',
    plan: 'plan_monthly',
    customer: { email: 'asha@example.in' },
    totalCycles: 12,
    ...overrides,
  };
}

/** Creates the subscription through the facade, then has the customer authorise it. Returns what verifyCheckout returned. */
export async function createAndAuthorize(
  world: World,
  input: CreateSubscriptionInput = trialInput(),
  gateway: FakeGateway = world.gateway,
): Promise<{ created: Subscription; verification: CheckoutVerification }> {
  const created = await world.subs.create(gateway.name, input);
  const verification = await world.subs.verifyCheckout(gateway.name, gateway.authorize(created.id));
  return { created, verification };
}

export async function scheduleOf(world: World, id: string = REFERENCE): Promise<ScheduleRecord> {
  const schedule = await world.scheduler?.get(id);
  if (!schedule) throw new Error(`no schedule ${id}`);
  return schedule;
}

export async function cyclesOf(world: World, id: string = REFERENCE): Promise<CycleRecord[]> {
  return (await world.scheduler?.listCycles(id)) ?? [];
}

// ---------------------------------------------------------------------------
// A stub adapter for pure-delegation tests: every method returns one fixed object
// ---------------------------------------------------------------------------

export interface StubResults {
  plan: Plan;
  fetchedPlan: Plan;
  created: Subscription;
  fetched: Subscription;
  cancelled: Subscription;
  paused: Subscription;
  resumed: Subscription;
  updated: Subscription;
  charges: Charge[];
  charge: Charge;
  raised: Charge;
  notification: ChargeNotification;
  refund: Refund;
  verification: CheckoutVerification;
  events: SubscriptionEvent[];
}

function stubSubscription(id: string, status: SubscriptionStatus): Subscription {
  return {
    provider: Provider.Razorpay,
    id,
    reference: 'gw-ref-1',
    status,
    providerStatus: status,
    scheduling: SchedulingMode.Gateway,
    raw: { stub: id },
  };
}

function stubCharge(id: string): Charge {
  return {
    provider: Provider.Razorpay,
    id,
    kind: ChargeKind.Recurring,
    status: ChargeStatus.Succeeded,
    amount: AMOUNT,
    raw: { stub: id },
  };
}

export function makeStubResults(): StubResults {
  const plan = (id: string): Plan => ({
    provider: Provider.Razorpay,
    id,
    name: id,
    amount: AMOUNT,
    currency: Currency.INR,
    scheduling: SchedulingMode.Gateway,
    raw: { stub: id },
  });
  return {
    plan: plan('plan_created'),
    fetchedPlan: plan('plan_fetched'),
    created: stubSubscription('sub_created', SubscriptionStatus.Created),
    fetched: stubSubscription('sub_fetched', SubscriptionStatus.Active),
    cancelled: stubSubscription('sub_cancelled', SubscriptionStatus.Cancelled),
    paused: stubSubscription('sub_paused', SubscriptionStatus.Paused),
    resumed: stubSubscription('sub_resumed', SubscriptionStatus.Active),
    updated: stubSubscription('sub_updated', SubscriptionStatus.Active),
    charges: [stubCharge('pay_listed')],
    charge: stubCharge('pay_fetched'),
    raised: stubCharge('pay_raised'),
    notification: {
      provider: Provider.Razorpay,
      id: 'ntf_1',
      subscriptionId: 'sub_1',
      accepted: true,
      amount: AMOUNT,
      debitAt: TRIAL_END,
      raw: { stub: 'ntf_1' },
    },
    refund: {
      provider: Provider.Razorpay,
      id: 'rfnd_1',
      chargeId: 'pay_1',
      status: RefundStatus.Succeeded,
      amount: AMOUNT,
      raw: { stub: 'rfnd_1' },
    },
    verification: {
      provider: Provider.Razorpay,
      subscriptionId: 'sub_verified',
      reference: 'gw-ref-1',
      authorized: true,
      raw: { stub: 'verification' },
    },
    events: [
      {
        id: 'evt_stub',
        provider: Provider.Razorpay,
        type: EventType.SubscriptionCharged,
        providerEventType: 'subscription.charged',
        subscriptionId: 'sub_1',
        raw: { stub: 'event' },
      },
    ],
  };
}

export class StubProvider extends BaseProvider {
  readonly name = Provider.Razorpay;
  readonly capabilities: Capabilities = capabilitiesFor(Provider.Razorpay, Style.Gateway, true, true, 0);
  readonly calls: Array<{ method: GatewayMethod; args: unknown[] }> = [];
  readonly results = makeStubResults();

  constructor() {
    super({
      fetch: async () => {
        throw new Error('the stub never uses the network');
      },
    });
  }

  private record<T>(method: GatewayMethod, args: unknown[], result: T): Promise<T> {
    this.calls.push({ method, args });
    return Promise.resolve(result);
  }

  protected describeError(response: { text: string }): GatewayErrorInfo {
    return { message: response.text };
  }
  override createPlan(input: CreatePlanInput): Promise<Plan> {
    return this.record(GatewayMethod.CreatePlan, [input], this.results.plan);
  }
  override getPlan(planId: string): Promise<Plan> {
    return this.record(GatewayMethod.GetPlan, [planId], this.results.fetchedPlan);
  }
  createSubscription(input: CreateSubscriptionInput): Promise<Subscription> {
    return this.record(GatewayMethod.CreateSubscription, [input], this.results.created);
  }
  getSubscription(subscriptionId: string): Promise<Subscription> {
    return this.record(GatewayMethod.GetSubscription, [subscriptionId], this.results.fetched);
  }
  cancelSubscription(subscriptionId: string, options?: CancelSubscriptionOptions): Promise<Subscription> {
    return this.record(GatewayMethod.CancelSubscription, [subscriptionId, options], this.results.cancelled);
  }
  override pauseSubscription(subscriptionId: string, options?: PauseSubscriptionOptions): Promise<Subscription> {
    return this.record(GatewayMethod.PauseSubscription, [subscriptionId, options], this.results.paused);
  }
  override resumeSubscription(subscriptionId: string, options?: ResumeSubscriptionOptions): Promise<Subscription> {
    return this.record(GatewayMethod.ResumeSubscription, [subscriptionId, options], this.results.resumed);
  }
  override updateSubscription(subscriptionId: string, input: UpdateSubscriptionInput): Promise<Subscription> {
    return this.record(GatewayMethod.UpdateSubscription, [subscriptionId, input], this.results.updated);
  }
  override listCharges(subscriptionId: string, options?: ListChargesOptions): Promise<Charge[]> {
    return this.record(GatewayMethod.ListCharges, [subscriptionId, options], this.results.charges);
  }
  override getCharge(subscriptionId: string, chargeId: string): Promise<Charge> {
    return this.record(GatewayMethod.GetCharge, [subscriptionId, chargeId], this.results.charge);
  }
  override notifyCharge(input: NotifyChargeInput): Promise<ChargeNotification> {
    return this.record(GatewayMethod.NotifyCharge, [input], this.results.notification);
  }
  override createCharge(input: CreateChargeInput): Promise<Charge> {
    return this.record(GatewayMethod.CreateCharge, [input], this.results.raised);
  }
  override refundCharge(input: RefundInput): Promise<Refund> {
    return this.record(GatewayMethod.RefundCharge, [input], this.results.refund);
  }
  verifyCheckout(result: CheckoutResult): Promise<CheckoutVerification> {
    return this.record(GatewayMethod.VerifyCheckout, [result], this.results.verification);
  }
  parseWebhook(request: WebhookRequest): SubscriptionEvent[] {
    this.calls.push({ method: GatewayMethod.ParseWebhook, args: [request] });
    return this.results.events;
  }
}

/** The cancel mode constant re-exported for tests that need a non-default option. */
export { CancelMode };
