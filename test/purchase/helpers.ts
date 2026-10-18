import { randomUUID } from 'node:crypto';
import {
  ChargeKind,
  ChargeStatus,
  CheckoutKind,
  ErrorCode,
  EventType,
  IntervalUnit,
  PaymentMethod,
  PaymentStatus,
  Platform,
  ProductKind,
  Provider,
  ProviderKind,
  RefundStatus,
  SchedulingMode,
  SubscriptionStatus,
  type ProductKind as ProductKindValue,
} from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import type { ExternalTransactionReporter } from '../../src/provider.js';
import { MemoryRoutingStatsStore, Router } from '../../src/routing/index.js';
import type {
  Capabilities,
  Charge,
  CheckoutInstruction,
  CheckoutResult,
  CheckoutVerification,
  CreatePaymentInput,
  CreateSubscriptionInput,
  ExternalTransactionRecord,
  ExternalTransactionRefund,
  ExternalTransactionReport,
  Payment,
  PaymentVerification,
  Refund,
  Subscription,
  SubscriptionEvent,
} from '../../src/schemas.js';
import {
  MemoryPurchaseStore,
  Purchases,
  type IssueReport,
  type PlatformPolicyInput,
  type Product,
  type PurchaseHost,
  type PurchasesOptions,
} from '../../src/purchase/index.js';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const T0 = '2026-11-22T10:30:00.000Z';

/** A clock the test moves by hand. */
export class FakeClock {
  private ms: number;
  constructor(iso: string = T0) {
    this.ms = Date.parse(iso);
  }
  readonly now = (): Date => new Date(this.ms);
  readonly epoch = (): number => this.ms;
  advance(ms: number): void {
    this.ms += ms;
  }
  iso(offsetMs = 0): string {
    return new Date(this.ms + offsetMs).toISOString();
  }
}

// ---------------------------------------------------------------------------
// Capabilities of the fake providers
// ---------------------------------------------------------------------------

function capabilities(provider: Provider, overrides: Partial<Capabilities> = {}): Capabilities {
  return {
    provider,
    kind: ProviderKind.Gateway,
    scheduling: [SchedulingMode.Gateway],
    gatewayPlans: false,
    trial: true,
    upfrontAmount: true,
    quantity: false,
    pause: false,
    resume: false,
    cancel: true,
    cancelAtPeriodEnd: false,
    changePlan: false,
    merchantCharges: false,
    merchantPreDebitNotification: false,
    listCharges: false,
    refunds: true,
    signedWebhooks: true,
    idempotencyKeys: false,
    paymentMethods: [PaymentMethod.Upi, PaymentMethod.Card],
    oneTimePayments: true,
    oneTimePaymentMethods: [PaymentMethod.Upi, PaymentMethod.Card, PaymentMethod.NetBanking],
    ...overrides,
  };
}

/** Three gateways with different capabilities, and one of each store. */
export const FAKE_CAPABILITIES: Record<string, Capabilities> = {
  razorpay: capabilities(Provider.Razorpay, { paymentMethods: [PaymentMethod.Upi, PaymentMethod.Card, PaymentMethod.ENach] }),
  /** No trials, no wallets, no cards for one-time payments. */
  cashfree: capabilities(Provider.Cashfree, { trial: false, oneTimePaymentMethods: [PaymentMethod.Upi, PaymentMethod.Wallet] }),
  /** No one-time payments at all. */
  phonepe: capabilities(Provider.PhonePe, { oneTimePayments: false, oneTimePaymentMethods: [], paymentMethods: [PaymentMethod.Upi] }),
  appStore: capabilities(Provider.AppStore, { kind: ProviderKind.Store, paymentMethods: [], oneTimePaymentMethods: [], trial: true }),
  googlePlay: capabilities(Provider.GooglePlay, { kind: ProviderKind.Store, paymentMethods: [], oneTimePaymentMethods: [], trial: true }),
};

// ---------------------------------------------------------------------------
// The fake host
// ---------------------------------------------------------------------------

/** The wire format of the fake checkout result: which order it is for and how the customer's attempt ended. */
export const RESULT_ORDER = 'order';
export const RESULT_OUTCOME = 'outcome';
export const Outcome = { Paid: 'paid', Failed: 'failed', Pending: 'pending' } as const;
export type Outcome = (typeof Outcome)[keyof typeof Outcome];

export function result(order: string, outcome: Outcome = Outcome.Paid, extra: Record<string, unknown> = {}): CheckoutResult {
  return { [RESULT_ORDER]: order, [RESULT_OUTCOME]: outcome, ...extra };
}

export interface HostCall {
  method: 'create' | 'get' | 'verifyCheckout' | 'payments.create' | 'payments.get' | 'payments.verify';
  provider: Provider;
  input?: unknown;
}

interface Script {
  /** Errors the next `create` calls throw, one per call, before one succeeds. */
  createErrors: SubscriptionError[];
  /** Makes every `create` throw this. */
  alwaysFail?: SubscriptionError;
}

/**
 * A `PurchaseHost` with scripted providers and no network. It follows the facade's rules: a verified result that is for
 * another order than `expected*Id` is refused with `SIGNATURE_INVALID`; a store returns its own id and the account
 * token as `reference`, a gateway returns the id `create` returned.
 */
export class FakeHost implements PurchaseHost {
  readonly calls: HostCall[] = [];
  /** Subscription objects `get` answers with, by id; edit them to move a subscription through its life. */
  readonly subscriptions = new Map<string, Subscription>();
  readonly payments_ = new Map<string, Payment>();
  /** The charge a verification of this order carries. */
  readonly verifiedCharge = new Map<string, Charge>();
  readonly scripts = new Map<Provider, Script>();
  /** Makes `get` fail (a provider that is down after the customer paid). */
  getFails = false;
  private counter = 0;
  private readonly capabilityList: Capabilities[];

  constructor(capabilityList: Capabilities[]) {
    this.capabilityList = capabilityList;
  }

  get providers(): Provider[] {
    return this.capabilityList.map((entry) => entry.provider);
  }

  capabilities = (name: Provider): Capabilities => {
    const found = this.capabilityList.find((entry) => entry.provider === name);
    if (!found) throw new SubscriptionError(ErrorCode.Config, `Provider ${name} is not configured`);
    return found;
  };

  script(provider: Provider): Script {
    let script = this.scripts.get(provider);
    if (!script) {
      script = { createErrors: [] };
      this.scripts.set(provider, script);
    }
    return script;
  }

  /** Makes the next `count` creates at `provider` fail with `code`. */
  failCreates(provider: Provider, code: ErrorCode, count = 1): void {
    for (let i = 0; i < count; i += 1) this.script(provider).createErrors.push(new SubscriptionError(code, `${provider} ${code}`, { provider }));
  }

  private isStore(provider: Provider): boolean {
    return this.capabilities(provider).kind === ProviderKind.Store;
  }

  private beforeCreate(provider: Provider): void {
    const script = this.scripts.get(provider);
    if (script?.alwaysFail) throw script.alwaysFail;
    const next = script?.createErrors.shift();
    if (next) throw next;
  }

  private checkoutFor(provider: Provider, id: string, kind: ProductKindValue, productId?: string): CheckoutInstruction {
    if (provider === Provider.AppStore) {
      return { kind: CheckoutKind.AppleStoreKit, productId: productId ?? 'apple.product', appAccountToken: id };
    }
    if (provider === Provider.GooglePlay) {
      return {
        kind: CheckoutKind.GooglePlayBilling,
        productKind: kind,
        productId: productId ?? 'google.product',
        obfuscatedAccountId: id,
        userChoiceBilling: false,
      };
    }
    return { kind: CheckoutKind.Redirect, url: `https://pay.example/${provider}/${id}` };
  }

  async create(provider: Provider, input: CreateSubscriptionInput): Promise<Subscription> {
    this.calls.push({ method: 'create', provider, input });
    this.beforeCreate(provider);
    this.counter += 1;
    const id = this.isStore(provider) ? randomUUID() : `sub_${provider}_${this.counter}`;
    const subscription: Subscription = {
      provider,
      id,
      reference: input.reference,
      status: SubscriptionStatus.Created,
      providerStatus: 'created',
      scheduling: SchedulingMode.Gateway,
      checkout: this.checkoutFor(provider, id, ProductKind.Subscription, input.storeProduct?.productId),
    };
    return subscription;
  }

  async get(provider: Provider, subscriptionId: string): Promise<Subscription> {
    this.calls.push({ method: 'get', provider, input: subscriptionId });
    if (this.getFails) throw new SubscriptionError(ErrorCode.ProviderUnavailable, 'get failed', { provider });
    const found = this.subscriptions.get(subscriptionId);
    if (!found) throw new SubscriptionError(ErrorCode.NotFound, `no subscription ${subscriptionId}`, { provider });
    return found;
  }

  async verifyCheckout(
    provider: Provider,
    resultFields: CheckoutResult,
    options: { expectedSubscriptionId?: string } = {},
  ): Promise<CheckoutVerification> {
    this.calls.push({ method: 'verifyCheckout', provider, input: { result: resultFields, options } });
    const order = String(resultFields[RESULT_ORDER]);
    const outcome = resultFields[RESULT_OUTCOME];
    const store = this.isStore(provider);
    const subscriptionId = store ? `store_sub_${order.slice(0, 8)}` : order;
    const reference = store ? order : undefined;
    const expected = options.expectedSubscriptionId;
    if (expected !== undefined && expected !== subscriptionId && expected !== reference) {
      throw new SubscriptionError(ErrorCode.SignatureInvalid, `${provider} checkout result is for a different subscription than expected`, { provider });
    }
    const charge = this.verifiedCharge.get(order);
    return {
      provider,
      subscriptionId,
      ...(reference !== undefined ? { reference } : {}),
      authorized: outcome === Outcome.Paid,
      status:
        outcome === Outcome.Paid
          ? SubscriptionStatus.Active
          : outcome === Outcome.Pending
            ? SubscriptionStatus.PendingAuthorization
            : SubscriptionStatus.Failed,
      ...(charge ? { charge } : {}),
    };
  }

  readonly payments = {
    create: async (provider: Provider, input: CreatePaymentInput): Promise<Payment> => {
      this.calls.push({ method: 'payments.create', provider, input });
      this.beforeCreate(provider);
      this.counter += 1;
      const id = this.isStore(provider) ? randomUUID() : `order_${provider}_${this.counter}`;
      return {
        provider,
        id,
        reference: input.reference,
        status: PaymentStatus.Created,
        providerStatus: 'created',
        amount: input.amount,
        checkout: this.checkoutFor(provider, id, ProductKind.OneTime, input.storeProduct?.productId),
      };
    },
    get: async (provider: Provider, paymentId: string): Promise<Payment> => {
      this.calls.push({ method: 'payments.get', provider, input: paymentId });
      if (this.getFails) throw new SubscriptionError(ErrorCode.ProviderUnavailable, 'get failed', { provider });
      const found = this.payments_.get(paymentId);
      if (!found) throw new SubscriptionError(ErrorCode.NotFound, `no payment ${paymentId}`, { provider });
      return found;
    },
    verify: async (
      provider: Provider,
      resultFields: CheckoutResult,
      options: { expectedPaymentId?: string } = {},
    ): Promise<PaymentVerification> => {
      this.calls.push({ method: 'payments.verify', provider, input: { result: resultFields, options } });
      const order = String(resultFields[RESULT_ORDER]);
      const outcome = resultFields[RESULT_OUTCOME];
      const store = this.isStore(provider);
      const paymentId = store ? `store_pay_${order.slice(0, 8)}` : order;
      const reference = store ? order : undefined;
      const expected = options.expectedPaymentId;
      if (expected !== undefined && expected !== paymentId && expected !== reference) {
        throw new SubscriptionError(ErrorCode.SignatureInvalid, `${provider} payment result is for a different payment than expected`, { provider });
      }
      return {
        provider,
        paymentId,
        ...(reference !== undefined ? { reference } : {}),
        paid: outcome === Outcome.Paid,
        status:
          outcome === Outcome.Paid ? PaymentStatus.Succeeded : outcome === Outcome.Pending ? PaymentStatus.Pending : PaymentStatus.Failed,
      };
    },
  };

  /** The `create` and `verify` calls of one method. */
  callsOf(method: HostCall['method'], provider?: Provider): HostCall[] {
    return this.calls.filter((call) => call.method === method && (provider === undefined || call.provider === provider));
  }

  /** What `get` / `payments.get` answer for `id`. */
  setSubscription(id: string, provider: Provider, fields: Partial<Subscription> = {}): Subscription {
    const subscription: Subscription = {
      provider,
      id,
      status: SubscriptionStatus.Active,
      providerStatus: 'active',
      scheduling: SchedulingMode.Gateway,
      ...fields,
    };
    this.subscriptions.set(id, subscription);
    return subscription;
  }

  setPayment(id: string, provider: Provider, fields: Partial<Payment> = {}): Payment {
    const payment: Payment = {
      provider,
      id,
      status: PaymentStatus.Succeeded,
      providerStatus: 'paid',
      amount: 0,
      ...fields,
    };
    this.payments_.set(id, payment);
    return payment;
  }
}

// ---------------------------------------------------------------------------
// The fake reporter
// ---------------------------------------------------------------------------

export class FakeReporter implements ExternalTransactionReporter {
  readonly reports: ExternalTransactionReport[] = [];
  readonly refunds: ExternalTransactionRefund[] = [];
  /** Errors the next calls throw, one per call (both methods share the queue). */
  readonly failures: SubscriptionError[] = [];
  /** Makes every call throw this. */
  down: SubscriptionError | undefined;

  failNext(code: ErrorCode, count = 1): void {
    for (let i = 0; i < count; i += 1) this.failures.push(new SubscriptionError(code, `reporter ${code}`));
  }

  private gate(): void {
    if (this.down) throw this.down;
    const next = this.failures.shift();
    if (next) throw next;
  }

  async reportExternalTransaction(input: ExternalTransactionReport): Promise<ExternalTransactionRecord> {
    this.gate();
    this.reports.push(input);
    return { externalTransactionId: input.externalTransactionId, state: 'ok' };
  }

  async refundExternalTransaction(input: ExternalTransactionRefund): Promise<ExternalTransactionRecord> {
    this.gate();
    this.refunds.push(input);
    return { externalTransactionId: input.externalTransactionId, state: 'refunded' };
  }
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

export const CUSTOMER = { name: 'Asha', email: 'asha@example.com', phone: '9876543210', state: 'Karnataka' };
export const CUSTOMER_REF = 'cust_1';

export const MONTHLY: Product = {
  key: 'pro_monthly',
  kind: ProductKind.Subscription,
  name: 'Pro monthly',
  amount: 59_000,
  interval: { unit: IntervalUnit.Month, count: 1 },
  taxRateBps: 1800,
  appStore: { productId: 'com.example.pro.monthly' },
  googlePlay: { productId: 'pro', basePlanId: 'monthly' },
};
export const TRIAL_MONTHLY: Product = {
  ...MONTHLY,
  key: 'pro_trial',
  trialDays: 7,
  appStore: { productId: 'com.example.pro.trial' },
  googlePlay: { productId: 'pro', basePlanId: 'trial' },
};
export const LIFETIME: Product = {
  key: 'lifetime',
  kind: ProductKind.OneTime,
  name: 'Lifetime',
  amount: 118_000,
  taxRateBps: 1800,
  appStore: { productId: 'com.example.lifetime' },
  googlePlay: { productId: 'lifetime' },
};
export const COINS: Product = {
  key: 'coins',
  kind: ProductKind.OneTime,
  name: 'Coins',
  amount: 9_900,
  taxRateBps: 1800,
  appStore: { productId: 'com.example.coins', consumable: true },
  googlePlay: { productId: 'coins', consumable: true },
};
export const BOOK: Product = {
  key: 'book',
  kind: ProductKind.OneTime,
  name: 'Printed book',
  amount: 49_900,
  physicalGoods: true,
};
export const CATALOG: Product[] = [MONTHLY, TRIAL_MONTHLY, LIFETIME, COINS, BOOK];

export interface Harness {
  clock: FakeClock;
  host: FakeHost;
  router: Router;
  store: MemoryPurchaseStore;
  reporter: FakeReporter;
  purchases: Purchases;
  issues: IssueReport[];
}

export interface HarnessOptions {
  capabilities?: Capabilities[];
  catalog?: Product[];
  policy?: PlatformPolicyInput;
  reporter?: FakeReporter | null;
  purchases?: Partial<PurchasesOptions>;
  priority?: Provider[];
}

/** Everything wired together on one fake clock: Razorpay, Cashfree, PhonePe, both stores, a router over them. */
export function harness(options: HarnessOptions = {}): Harness {
  const clock = new FakeClock();
  const list = options.capabilities ?? Object.values(FAKE_CAPABILITIES);
  const host = new FakeHost(list);
  const router = new Router({
    capabilities: () => list.map((entry) => host.capabilities(entry.provider)),
    strategy: { priority: options.priority ?? [Provider.Razorpay, Provider.Cashfree, Provider.PhonePe] },
    stats: new MemoryRoutingStatsStore(),
    now: clock.now,
  });
  const store = new MemoryPurchaseStore({ now: clock.epoch });
  const reporter = options.reporter === null ? undefined : (options.reporter ?? new FakeReporter());
  const issues: IssueReport[] = [];
  const purchases = new Purchases({
    host,
    router,
    catalog: options.catalog ?? CATALOG,
    policy: options.policy ?? { android: 'user_choice' },
    store,
    ...(reporter ? { reporter } : {}),
    now: clock.now,
    onIssue: (issue) => issues.push(issue),
    ...options.purchases,
  });
  return { clock, host, router, store, reporter: reporter ?? new FakeReporter(), purchases, issues };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

let eventCounter = 0;

export function event(provider: Provider, type: EventType, fields: Partial<SubscriptionEvent> = {}): SubscriptionEvent {
  eventCounter += 1;
  return { id: `evt_${eventCounter}`, provider, type, providerEventType: type, ...fields };
}

export function charge(provider: Provider, id: string, subscriptionId: string, amount: number, fields: Partial<Charge> = {}): Charge {
  return {
    provider,
    id,
    subscriptionId,
    kind: ChargeKind.Recurring,
    status: ChargeStatus.Succeeded,
    amount,
    ...fields,
  };
}

export function refundOf(provider: Provider, id: string, chargeId: string, amount: number, fields: Partial<Refund> = {}): Refund {
  return { provider, id, chargeId, status: RefundStatus.Succeeded, amount, ...fields };
}

/** `Platform` values, so tests do not repeat literals. */
export { Platform, EventType, ProductKind, Provider, SubscriptionStatus, PaymentStatus, ErrorCode };

/** The `SubscriptionError` a promise rejects with. */
export async function rejection(promise: Promise<unknown>): Promise<SubscriptionError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SubscriptionError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}
