import { ChargeKind, ChargeStatus, Currency, ErrorCode, EventType, IntervalUnit, PaymentMethod, Provider, SchedulingMode, SubscriptionStatus } from '../../src/constants.js';
import { SubscriptionError, unsupported } from '../../src/errors.js';
import type { SubscriptionProvider } from '../../src/provider.js';
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
} from '../../src/schemas.js';
import { BillingScheduler, MemorySchedulerStore, scheduleIdFor, type RegisterScheduleInput, type SchedulerEvent, type SchedulerOptions, type TickResult } from '../../src/scheduler/index.js';

export const HOUR = 60 * 60 * 1000;

/** The default schedule id of `registration()`: the PayU subscription `sub_1`. */
export const SID = scheduleIdFor(Provider.PayU, 'sub_1');

/** The instant the fake clock starts at. */
export const T0 = '2026-01-01T00:00:00.000Z';
/** 15 Jan 2026, 10:00 IST. */
export const DUE = '2026-01-15T04:30:00.000Z';

export function plusHours(iso: string, hours: number): string {
  return new Date(Date.parse(iso) + hours * HOUR).toISOString();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A controllable clock. */
export class FakeClock {
  private ms: number;
  constructor(iso: string = T0) {
    this.ms = Date.parse(iso);
  }
  readonly now = (): Date => new Date(this.ms);
  set(iso: string): void {
    this.ms = Date.parse(iso);
  }
  iso(): string {
    return new Date(this.ms).toISOString();
  }
}

/** How the fake gateway answers the next `createCharge`. */
export const CreateBehaviour = {
  Succeed: 'succeed',
  Fail: 'fail',
  Pending: 'pending',
  Scheduled: 'scheduled',
  /** The debit is recorded at the gateway (succeeded), but the answer is lost. */
  UnknownCreated: 'unknown_created',
  /** The debit is recorded at the gateway (pending), but the answer is lost. */
  UnknownPendingCreated: 'unknown_pending_created',
  /** The request never reached the gateway and the answer is lost. */
  UnknownLost: 'unknown_lost',
  /** The gateway refuses the request outright. */
  Reject: 'reject',
  /** The debit is recorded at the gateway, then the adapter throws a non-SubscriptionError (a bug after the request was sent). */
  ForeignCreated: 'foreign_created',
  /** The adapter throws a non-SubscriptionError and the gateway never saw the request. */
  ForeignLost: 'foreign_lost',
  /** Throws `FakeProvider.createError` (nothing is recorded at the gateway). */
  ThrowConfigured: 'throw_configured',
} as const;
export type CreateBehaviour = (typeof CreateBehaviour)[keyof typeof CreateBehaviour];

export const NotifyBehaviour = {
  Accept: 'accept',
  Reject: 'reject',
  Throw: 'throw',
} as const;
export type NotifyBehaviour = (typeof NotifyBehaviour)[keyof typeof NotifyBehaviour];

/** The three gateway styles the scheduler supports. */
export const Style = {
  /** PayU: merchant sends the pre-debit notification. */
  Notify: 'notify',
  /** Cashfree on-demand: charge is raised days ahead with a scheduled date. */
  Advance: 'advance',
  /** Charge on the due date, no notification. */
  OnDue: 'on_due',
} as const;
export type Style = (typeof Style)[keyof typeof Style];

export interface FakeProviderOptions {
  style?: Style;
  leadHours?: number;
  maxAheadHours?: number;
  merchantCharges?: boolean;
}

/** A scriptable fake gateway that behaves like a real one: it de-duplicates debits by `chargeId`. */
export class FakeProvider implements SubscriptionProvider {
  readonly name = Provider.PayU;
  readonly capabilities: Capabilities;

  readonly notifyCalls: NotifyChargeInput[] = [];
  readonly createCalls: CreateChargeInput[] = [];
  readonly getCalls: Array<{ subscriptionId: string; chargeId: string }> = [];
  /** The gateway's own record of debits, by chargeId. */
  readonly gateway = new Map<string, Charge>();

  createScript: CreateBehaviour[] = [];
  notifyScript: NotifyBehaviour[] = [];
  getChargeError: SubscriptionError | undefined;
  /** What `CreateBehaviour.ThrowConfigured` throws. */
  createError: SubscriptionError | undefined;
  createDelayMs = 0;
  /** Runs inside `createCharge` before the gateway acts; throwing here simulates a crash. */
  onCreate: ((input: CreateChargeInput) => void | Promise<void>) | undefined;

  constructor(options: FakeProviderOptions = {}) {
    const style = options.style ?? Style.Notify;
    this.capabilities = {
      provider: Provider.PayU,
      scheduling: [SchedulingMode.Merchant],
      gatewayPlans: false,
      trial: true,
      upfrontAmount: true,
      quantity: false,
      pause: false,
      resume: false,
      cancelAtPeriodEnd: false,
      changePlan: false,
      merchantCharges: options.merchantCharges ?? true,
      merchantPreDebitNotification: style === Style.Notify,
      ...(style === Style.Advance
        ? {
            merchantChargeLeadHours: options.leadHours ?? 24,
            ...(options.maxAheadHours !== undefined ? { merchantChargeMaxAheadHours: options.maxAheadHours } : {}),
          }
        : {}),
      listCharges: false,
      refunds: false,
      signedWebhooks: true,
      idempotencyKeys: true,
      paymentMethods: [PaymentMethod.Upi],
    };
  }

  private charge(input: CreateChargeInput, status: ChargeStatus): Charge {
    return {
      provider: this.name,
      id: `pay_${input.chargeId}`,
      reference: input.chargeId,
      subscriptionId: input.subscriptionId,
      kind: ChargeKind.Recurring,
      status,
      amount: input.amount,
      currency: Currency.INR,
      ...(input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt } : {}),
      ...(status === ChargeStatus.Failed ? { failureCode: 'INSUFFICIENT_FUNDS', failureReason: 'Insufficient funds' } : {}),
      raw: null,
    };
  }

  /** Changes the status of a debit the gateway already holds (a bank answer arriving later). */
  settle(chargeId: string, status: ChargeStatus): Charge {
    const existing = this.gateway.get(chargeId);
    if (!existing) throw new Error(`fake gateway has no charge ${chargeId}`);
    const updated: Charge = {
      ...existing,
      status,
      ...(status === ChargeStatus.Failed ? { failureCode: 'INSUFFICIENT_FUNDS', failureReason: 'Insufficient funds' } : {}),
    };
    this.gateway.set(chargeId, updated);
    return updated;
  }

  async notifyCharge(input: NotifyChargeInput): Promise<ChargeNotification> {
    this.notifyCalls.push(input);
    const behaviour = this.notifyScript.shift() ?? NotifyBehaviour.Accept;
    if (behaviour === NotifyBehaviour.Throw) {
      throw new SubscriptionError(ErrorCode.ProviderUnavailable, 'gateway down', { provider: this.name });
    }
    return {
      provider: this.name,
      id: input.notificationId,
      subscriptionId: input.subscriptionId,
      accepted: behaviour === NotifyBehaviour.Accept,
      amount: input.amount,
      debitAt: input.debitAt,
      invoiceNumber: `INV-${input.notificationId}`,
      raw: null,
    };
  }

  async createCharge(input: CreateChargeInput): Promise<Charge> {
    this.createCalls.push(input);
    if (this.onCreate) await this.onCreate(input);
    if (this.createDelayMs > 0) await sleep(this.createDelayMs);

    const existing = this.gateway.get(input.chargeId);
    if (existing) return existing;
    const behaviour = this.createScript.shift() ?? CreateBehaviour.Succeed;
    const unknown = () =>
      new SubscriptionError(ErrorCode.OutcomeUnknown, 'no response received', { provider: this.name });
    const record = (status: ChargeStatus): Charge => {
      const charge = this.charge(input, status);
      this.gateway.set(input.chargeId, charge);
      return charge;
    };
    switch (behaviour) {
      case CreateBehaviour.Succeed:
        return record(ChargeStatus.Succeeded);
      case CreateBehaviour.Fail:
        return record(ChargeStatus.Failed);
      case CreateBehaviour.Pending:
        return record(ChargeStatus.Pending);
      case CreateBehaviour.Scheduled:
        return record(ChargeStatus.Scheduled);
      case CreateBehaviour.UnknownCreated:
        record(ChargeStatus.Succeeded);
        throw unknown();
      case CreateBehaviour.UnknownPendingCreated:
        record(ChargeStatus.Pending);
        throw unknown();
      case CreateBehaviour.UnknownLost:
        throw unknown();
      case CreateBehaviour.ForeignCreated:
        record(ChargeStatus.Succeeded);
        throw new TypeError("Cannot read properties of undefined (reading 'status')");
      case CreateBehaviour.ForeignLost:
        throw new TypeError("Cannot read properties of undefined (reading 'status')");
      case CreateBehaviour.ThrowConfigured:
        throw this.createError ?? unknown();
      case CreateBehaviour.Reject:
        throw new SubscriptionError(ErrorCode.ProviderError, 'mandate is not active', {
          provider: this.name,
          providerCode: 'MANDATE_INACTIVE',
        });
    }
  }

  async getCharge(subscriptionId: string, chargeId: string): Promise<Charge> {
    this.getCalls.push({ subscriptionId, chargeId });
    if (this.getChargeError) throw this.getChargeError;
    const charge = this.gateway.get(chargeId);
    if (!charge) throw new SubscriptionError(ErrorCode.NotFound, `no charge ${chargeId}`, { provider: this.name });
    return charge;
  }

  // The scheduler never uses these.
  createPlan(_input: CreatePlanInput): Promise<Plan> {
    return Promise.reject(unsupported(this.name, 'plans'));
  }
  getPlan(_planId: string): Promise<Plan> {
    return Promise.reject(unsupported(this.name, 'plans'));
  }
  createSubscription(_input: CreateSubscriptionInput): Promise<Subscription> {
    return Promise.reject(unsupported(this.name, 'subscriptions'));
  }
  /** The gateway's view of mandates by subscription id, which the scheduler asks for while a schedule awaits authorisation. */
  readonly mandates = new Map<string, SubscriptionStatus>();
  readonly subscriptionCalls: string[] = [];
  subscriptionError: SubscriptionError | undefined;

  async getSubscription(subscriptionId: string): Promise<Subscription> {
    this.subscriptionCalls.push(subscriptionId);
    if (this.subscriptionError) throw this.subscriptionError;
    const status = this.mandates.get(subscriptionId);
    if (status === undefined) {
      throw new SubscriptionError(ErrorCode.NotFound, `no mandate ${subscriptionId}`, { provider: this.name });
    }
    return { provider: this.name, id: subscriptionId, status, providerStatus: status, scheduling: SchedulingMode.Merchant, raw: null };
  }
  cancelSubscription(_subscriptionId: string, _options?: CancelSubscriptionOptions): Promise<Subscription> {
    return Promise.reject(unsupported(this.name, 'subscriptions'));
  }
  pauseSubscription(_subscriptionId: string, _options?: PauseSubscriptionOptions): Promise<Subscription> {
    return Promise.reject(unsupported(this.name, 'subscriptions'));
  }
  resumeSubscription(_subscriptionId: string, _options?: ResumeSubscriptionOptions): Promise<Subscription> {
    return Promise.reject(unsupported(this.name, 'subscriptions'));
  }
  updateSubscription(_subscriptionId: string, _input: UpdateSubscriptionInput): Promise<Subscription> {
    return Promise.reject(unsupported(this.name, 'subscriptions'));
  }
  listCharges(_subscriptionId: string, _options?: ListChargesOptions): Promise<Charge[]> {
    return Promise.reject(unsupported(this.name, 'listing charges'));
  }
  refundCharge(_input: RefundInput): Promise<Refund> {
    return Promise.reject(unsupported(this.name, 'refunds'));
  }
  verifyCheckout(_result: CheckoutResult): Promise<CheckoutVerification> {
    return Promise.reject(unsupported(this.name, 'checkout'));
  }
  parseWebhook(_request: WebhookRequest): SubscriptionEvent[] {
    throw unsupported(this.name, 'webhooks');
  }
}

export interface Harness {
  clock: FakeClock;
  store: MemorySchedulerStore;
  provider: FakeProvider;
  scheduler: BillingScheduler;
  events: SchedulerEvent[];
  /** Moves the clock to `iso` and ticks. */
  tickAt(iso: string): Promise<TickResult>;
  /** A second scheduler on the same store, as another worker process would be. */
  another(provider?: FakeProvider): BillingScheduler;
}

export interface HarnessOptions extends FakeProviderOptions {
  startAt?: string;
  scheduler?: Partial<Omit<SchedulerOptions, 'store' | 'resolveProvider' | 'now' | 'onEvent'>>;
  provider?: FakeProvider;
  store?: MemorySchedulerStore;
}

export function makeHarness(options: HarnessOptions = {}): Harness {
  const clock = new FakeClock(options.startAt ?? T0);
  const store = options.store ?? new MemorySchedulerStore();
  const provider = options.provider ?? new FakeProvider(options);
  const events: SchedulerEvent[] = [];
  const build = (use: FakeProvider): BillingScheduler =>
    new BillingScheduler({
      ...options.scheduler,
      store,
      resolveProvider: () => use,
      now: clock.now,
      onEvent: (event) => {
        events.push(event);
      },
    });
  const scheduler = build(provider);
  return {
    clock,
    store,
    provider,
    scheduler,
    events,
    another: (use = provider) => build(use),
    async tickAt(iso) {
      clock.set(iso);
      return scheduler.tick();
    },
  };
}

/** A registration for a monthly 49,900 paise plan whose first charge is due at `DUE`. */
export function registration(overrides: Partial<RegisterScheduleInput> = {}): RegisterScheduleInput {
  return {
    provider: Provider.PayU,
    subscriptionId: 'sub_1',
    amount: 49900,
    interval: { unit: IntervalUnit.Month, count: 1 },
    firstChargeAt: DUE,
    ...overrides,
  };
}

export interface EventSpec {
  type: EventType;
  subscriptionId?: string;
  reference?: string;
  charge?: { chargeId?: string; id?: string; status: ChargeStatus; subscriptionId?: string; amount?: number };
  id?: string;
}

/** A normalised webhook event, as an adapter's `parseWebhook` would produce it. */
export function makeEvent(spec: EventSpec): SubscriptionEvent {
  const subscriptionId = spec.subscriptionId;
  return {
    id: spec.id ?? `evt_${Math.random().toString(36).slice(2)}`,
    provider: Provider.PayU,
    type: spec.type,
    providerEventType: spec.type,
    ...(subscriptionId !== undefined ? { subscriptionId } : {}),
    ...(spec.reference !== undefined
      ? {
          subscription: {
            provider: Provider.PayU,
            id: subscriptionId ?? spec.reference,
            reference: spec.reference,
            status: SubscriptionStatus.Active,
            providerStatus: 'active',
            scheduling: SchedulingMode.Merchant,
            raw: null,
          },
        }
      : {}),
    ...(spec.charge
      ? {
          charge: {
            provider: Provider.PayU,
            id: spec.charge.id ?? `pay_${spec.charge.chargeId ?? 'x'}`,
            ...(spec.charge.chargeId !== undefined ? { reference: spec.charge.chargeId } : {}),
            subscriptionId: spec.charge.subscriptionId ?? subscriptionId ?? 'sub_1',
            kind: ChargeKind.Recurring,
            status: spec.charge.status,
            amount: spec.charge.amount ?? 49900,
            raw: null,
          },
        }
      : {}),
    raw: null,
  };
}
