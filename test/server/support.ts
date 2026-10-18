import {
  CheckoutKind,
  ContentType,
  ErrorCode,
  EventType,
  HeaderName,
  PaymentMethod,
  PaymentStatus,
  Provider,
  ProviderKind,
  RefundStatus,
  SchedulingMode,
  SubscriptionStatus,
} from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import type { HttpResponse } from '../../src/http.js';
import { BaseProvider, type GatewayErrorInfo } from '../../src/provider.js';
import type {
  Capabilities,
  CheckoutInstruction,
  CheckoutResult,
  CheckoutVerification,
  CreatePaymentInput,
  CreateSubscriptionInput,
  Payment,
  PaymentVerification,
  Refund,
  RefundPaymentInput,
  Subscription,
  SubscriptionEvent,
  WebhookRequest,
} from '../../src/schemas.js';
import { createHandler, type EventsHook } from '../../src/server/index.js';
import { Subscriptions, createSubscriptions, type SubscriptionsOptions } from '../../src/client.js';
import { MemoryPurchaseStore, type Product } from '../../src/purchase/index.js';

export const API_KEY = 'route-test-api-key-0123456789';
export const BASE = 'http://service.test';
/** A webhook is valid when it carries this header. */
export const SIGNATURE_HEADER = 'x-fake-signature';
export const VALID_SIGNATURE = 'valid';
/** The wire format of the scripted checkout result. */
export const RESULT_ORDER = 'order';
export const RESULT_OUTCOME = 'outcome';
export const PAID = 'paid';
export const NOW = '2026-11-23T10:00:00.000Z';

export function capabilities(provider: Provider, fields: Partial<Capabilities> = {}): Capabilities {
  return {
    provider,
    kind: ProviderKind.Gateway,
    scheduling: [SchedulingMode.Gateway],
    gatewayPlans: true,
    trial: true,
    upfrontAmount: true,
    quantity: true,
    pause: true,
    resume: true,
    cancel: true,
    cancelAtPeriodEnd: true,
    changePlan: true,
    merchantCharges: false,
    merchantPreDebitNotification: false,
    listCharges: true,
    refunds: true,
    signedWebhooks: true,
    idempotencyKeys: true,
    paymentMethods: [PaymentMethod.Upi, PaymentMethod.Card],
    oneTimePayments: true,
    oneTimePaymentMethods: [PaymentMethod.Upi, PaymentMethod.Card],
    ...fields,
  };
}

export interface Created {
  method: 'createSubscription' | 'createPayment';
  input: CreateSubscriptionInput | CreatePaymentInput;
}

/**
 * A gateway with no network: creates orders with a redirect checkout (or the instruction a test sets), verifies results of
 * the form `{ order, outcome }`, and remembers what it was asked.
 */
export class ScriptedGateway extends BaseProvider {
  readonly capabilities: Capabilities;
  readonly created: Created[] = [];
  readonly refunds: RefundPaymentInput[] = [];
  /** Makes creates fail with this error. */
  failCreates: SubscriptionError | undefined;
  /** The checkout instruction of the next orders; the order id is passed in. */
  checkout: (id: string) => CheckoutInstruction = (id) => ({ kind: CheckoutKind.Redirect, url: `https://pay.example/${this.name}/${id}` });
  /** What the customer's verified purchase turns out to be. */
  readonly payments = new Map<string, Payment>();
  readonly subscriptions = new Map<string, Subscription>();
  /** Makes every verification fail with this error (a gateway that is down). */
  failVerifications: SubscriptionError | undefined;
  private counter = 0;

  constructor(
    readonly name: Provider,
    fields: Partial<Capabilities> = {},
  ) {
    super();
    this.capabilities = capabilities(name, fields);
  }

  protected describeError(_response: HttpResponse): GatewayErrorInfo {
    return { message: 'unused' };
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.name}_${this.counter}`;
  }

  async createSubscription(input: CreateSubscriptionInput): Promise<Subscription> {
    this.created.push({ method: 'createSubscription', input });
    if (this.failCreates) throw this.failCreates;
    const id = this.nextId('sub');
    const subscription: Subscription = {
      provider: this.name,
      id,
      reference: input.reference,
      status: SubscriptionStatus.Created,
      providerStatus: 'created',
      scheduling: SchedulingMode.Gateway,
      checkout: this.checkout(id),
      raw: {},
    };
    this.subscriptions.set(id, subscription);
    return subscription;
  }

  async getSubscription(id: string): Promise<Subscription> {
    const found = this.subscriptions.get(id);
    if (!found) throw new SubscriptionError(ErrorCode.NotFound, `no subscription ${id}`, { provider: this.name });
    return found;
  }

  async cancelSubscription(id: string): Promise<Subscription> {
    return this.getSubscription(id);
  }

  async verifyCheckout(result: CheckoutResult): Promise<CheckoutVerification> {
    if (this.failVerifications) throw this.failVerifications;
    const order = String(result[RESULT_ORDER]);
    const paid = result[RESULT_OUTCOME] === PAID;
    if (paid) {
      const known = this.subscriptions.get(order);
      if (known) this.subscriptions.set(order, { ...known, status: SubscriptionStatus.Active, providerStatus: 'active' });
    }
    return {
      provider: this.name,
      subscriptionId: order,
      authorized: paid,
      status: paid ? SubscriptionStatus.Active : SubscriptionStatus.Failed,
      raw: {},
    };
  }

  override async createPayment(input: CreatePaymentInput): Promise<Payment> {
    this.created.push({ method: 'createPayment', input });
    if (this.failCreates) throw this.failCreates;
    const id = this.nextId('order');
    const payment: Payment = {
      provider: this.name,
      id,
      reference: input.reference,
      status: PaymentStatus.Created,
      providerStatus: 'created',
      amount: input.amount,
      checkout: this.checkout(id),
      raw: {},
    };
    this.payments.set(id, payment);
    return payment;
  }

  override async getPayment(id: string): Promise<Payment> {
    const found = this.payments.get(id);
    if (!found) throw new SubscriptionError(ErrorCode.NotFound, `no payment ${id}`, { provider: this.name });
    return found;
  }

  override async verifyPayment(result: CheckoutResult): Promise<PaymentVerification> {
    if (this.failVerifications) throw this.failVerifications;
    const order = String(result[RESULT_ORDER]);
    const paid = result[RESULT_OUTCOME] === PAID;
    const known = this.payments.get(order);
    if (paid && known) this.payments.set(order, { ...known, status: PaymentStatus.Succeeded, providerStatus: 'paid' });
    return {
      provider: this.name,
      paymentId: order,
      paid,
      status: paid ? PaymentStatus.Succeeded : PaymentStatus.Failed,
      ...(this.payments.get(order) ? { payment: this.payments.get(order) } : {}),
      raw: {},
    };
  }

  override async refundPayment(input: RefundPaymentInput): Promise<Refund> {
    this.refunds.push(input);
    return {
      provider: this.name,
      id: input.refundId,
      chargeId: input.paymentId,
      paymentId: input.paymentId,
      status: RefundStatus.Succeeded,
      amount: input.amount ?? 0,
      raw: {},
    };
  }

  parseWebhook(request: WebhookRequest): SubscriptionEvent[] {
    if (request.headers[SIGNATURE_HEADER] !== VALID_SIGNATURE) {
      throw new SubscriptionError(ErrorCode.SignatureInvalid, `${this.name} webhook signature does not match`, { provider: this.name });
    }
    const body = JSON.parse(request.rawBody) as { events?: SubscriptionEvent[] };
    return body.events ?? [];
  }
}

export const MONTHLY: Product = {
  key: 'pro-monthly',
  kind: 'subscription',
  name: 'Pro monthly',
  amount: 49900,
  interval: { unit: 'month', count: 1 },
  taxRateBps: 1800,
};
export const COINS: Product = { key: 'coins-100', kind: 'one_time', name: '100 coins', amount: 9900, taxRateBps: 1800 };

export interface Wiring {
  client: Subscriptions;
  handler: (request: Request) => Promise<Response>;
  gateways: ScriptedGateway[];
  events: Array<{ provider: Provider; events: SubscriptionEvent[] }>;
}

export interface WireOptions {
  gateways?: ScriptedGateway[];
  /** `false`: no `purchases` option at all (the service without a purchases file). */
  purchases?: false | Partial<NonNullable<SubscriptionsOptions['purchases']>>;
  routing?: SubscriptionsOptions['routing'];
  /** Hooks of the hosted checkout, set like the service sets them from its public URL. */
  hosted?: boolean;
  catalog?: Product[];
}

/** A real facade, router and purchases over scripted gateways, behind the real HTTP handler. */
export function wire(options: WireOptions = {}): Wiring {
  const gateways = options.gateways ?? [new ScriptedGateway(Provider.Razorpay), new ScriptedGateway(Provider.Cashfree)];
  const purchases =
    options.purchases === false
      ? undefined
      : {
          catalog: options.catalog ?? [MONTHLY, COINS],
          store: new MemoryPurchaseStore(),
          ...(options.hosted === false
            ? {}
            : {
                gatewayReturnUrl: (id: string) => `${BASE}/checkout/${id}/return`,
                hostedCheckoutUrl: (id: string) => `${BASE}/checkout/${id}`,
              }),
          ...options.purchases,
        };
  const client = createSubscriptions({ providers: gateways, ...(purchases ? { purchases } : {}), routing: options.routing ?? { strategy: { priority: [Provider.Razorpay, Provider.Cashfree] } } });
  const events: Wiring['events'] = [];
  const onEvents: EventsHook = (provider, received) => {
    events.push({ provider, events: received });
  };
  const handler = createHandler({ client, apiKey: API_KEY, onEvents });
  return { client, handler, gateways, events };
}

export interface SendOptions {
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
  /** `null`: no Authorization header. */
  auth?: string | null;
  contentType?: string;
}

export function send(
  handler: (request: Request) => Promise<Response>,
  method: string,
  path: string,
  options: SendOptions = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.auth !== null) headers.set(HeaderName.Authorization, `Bearer ${options.auth ?? API_KEY}`);
  let body: string | undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
    if (options.contentType) headers.set(HeaderName.ContentType, options.contentType);
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers.set(HeaderName.ContentType, ContentType.Json);
  }
  return handler(new Request(`${BASE}${path}`, { method, headers, body, redirect: 'manual' }));
}

export const CUSTOMER = { name: 'Asha', email: 'asha@example.com', phone: '9876543210', state: 'Karnataka' };

export function startBody(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { platform: 'web', product: MONTHLY.key, customer: CUSTOMER, customerRef: 'cust_1', returnUrl: 'https://shop.example.com/done', ...fields };
}

export interface ErrorBody {
  error: { code: string; message: string; retryable: boolean };
}

export async function jsonOf<T = unknown>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export { EventType };
