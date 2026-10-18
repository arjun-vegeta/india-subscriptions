import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createSubscriptions, type Subscriptions } from '../../src/client.js';
import {
  Currency,
  ChargeKind,
  ChargeStatus,
  ContentType,
  ErrorCode,
  EventType,
  HeaderName,
  HttpMethod,
  Provider,
  ProviderKind,
  RefundStatus,
  SchedulingMode,
  SubscriptionStatus,
} from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import type { HttpResponse } from '../../src/http.js';
import { BaseProvider, type GatewayErrorInfo } from '../../src/provider.js';
import type { BillingScheduler } from '../../src/scheduler/scheduler.js';
import { TickResultSchema } from '../../src/scheduler/schemas.js';
import { SchemaName, namedSchema } from '../../src/schema-registry.js';
import {
  CapabilitiesSchema,
  type CancelSubscriptionOptions,
  type Capabilities,
  type Charge,
  type ChargeNotification,
  type CheckoutResult,
  type CheckoutVerification,
  type CreateChargeInput,
  type CreatePlanInput,
  type CreateSubscriptionInput,
  type ListChargesOptions,
  type NotifyChargeInput,
  type PauseSubscriptionOptions,
  type Plan,
  type Refund,
  type RefundInput,
  type ResumeSubscriptionOptions,
  type Subscription,
  type SubscriptionEvent,
  type UpdateSubscriptionInput,
  type WebhookRequest,
} from '../../src/schemas.js';
import {
  ApiPath,
  ERROR_HTTP_STATUS,
  HealthStatus,
  ServerErrorCode,
  ServerHeader,
  Tag,
  createHandler,
  createNodeServer,
  ErrorResponseSchema,
  HealthSchema,
  WebhookReceiptSchema,
  listen,
  routes,
  type EventsHook,
  type HandlerOptions,
} from '../../src/server/index.js';

// ---------------------------------------------------------------------------
// A scriptable fake gateway wired into a real Subscriptions facade
// ---------------------------------------------------------------------------

const API_KEY = 'test-api-key-0123456789';
const SIGNATURE_HEADER = 'x-fake-signature';
const VALID_SIGNATURE = 'valid';
const BASE = 'http://service.test';

const PLAN: Plan = {
  provider: Provider.Razorpay,
  id: 'plan_1',
  name: 'Gold',
  amount: 49900,
  currency: Currency.INR,
  scheduling: SchedulingMode.Gateway,
  raw: { id: 'plan_1' },
};
const SUBSCRIPTION: Subscription = {
  provider: Provider.Razorpay,
  id: 'sub_1',
  status: SubscriptionStatus.Active,
  providerStatus: 'active',
  scheduling: SchedulingMode.Gateway,
  raw: { id: 'sub_1' },
};
const CHARGE: Charge = {
  provider: Provider.Razorpay,
  id: 'pay_1',
  subscriptionId: 'sub_1',
  kind: ChargeKind.Recurring,
  status: ChargeStatus.Succeeded,
  amount: 49900,
  raw: {},
};
const NOTIFICATION: ChargeNotification = {
  provider: Provider.Razorpay,
  id: 'note_1',
  subscriptionId: 'sub_1',
  accepted: true,
  amount: 49900,
  debitAt: '2026-12-01T10:00:00+05:30',
  raw: {},
};
const REFUND: Refund = {
  provider: Provider.Razorpay,
  id: 'rf_1',
  chargeId: 'pay_1',
  status: RefundStatus.Succeeded,
  amount: 1000,
  raw: {},
};
const VERIFICATION: CheckoutVerification = {
  provider: Provider.Razorpay,
  subscriptionId: 'sub_1',
  authorized: true,
  status: SubscriptionStatus.Active,
  raw: {},
};
const EVENT: SubscriptionEvent = {
  id: 'evt_1',
  provider: Provider.Razorpay,
  type: EventType.SubscriptionCharged,
  providerEventType: 'subscription.charged',
  subscriptionId: 'sub_1',
  raw: {},
};
const CAPABILITIES: Capabilities = {
  provider: Provider.Razorpay,
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
  paymentMethods: [],
  oneTimePayments: false,
  oneTimePaymentMethods: [],
};

interface Call {
  method: string;
  args: unknown[];
}

type Script = (...args: never[]) => unknown;

class FakeProvider extends BaseProvider {
  readonly capabilities: Capabilities;
  readonly calls: Call[] = [];
  private readonly scripts = new Map<string, Script>();

  constructor(readonly name: Provider) {
    super();
    this.capabilities = { ...CAPABILITIES, provider: name };
  }

  /** Replaces the answer of one method. */
  script(method: string, script: Script): void {
    this.scripts.set(method, script);
  }

  failWith(method: string, error: unknown): void {
    this.script(method, () => {
      throw error;
    });
  }

  private run<T>(method: string, args: unknown[], fallback: T): T {
    this.calls.push({ method, args });
    const script = this.scripts.get(method);
    return script ? ((script as (...a: unknown[]) => T)(...args) as T) : fallback;
  }

  protected describeError(_response: HttpResponse): GatewayErrorInfo {
    return { message: 'unused' };
  }

  override async createPlan(input: CreatePlanInput): Promise<Plan> {
    return this.run('createPlan', [input], { ...PLAN, provider: this.name });
  }
  override async getPlan(planId: string): Promise<Plan> {
    return this.run('getPlan', [planId], { ...PLAN, provider: this.name });
  }
  async createSubscription(input: CreateSubscriptionInput): Promise<Subscription> {
    return this.run('createSubscription', [input], { ...SUBSCRIPTION, provider: this.name });
  }
  async getSubscription(subscriptionId: string): Promise<Subscription> {
    return this.run('getSubscription', [subscriptionId], { ...SUBSCRIPTION, provider: this.name });
  }
  async cancelSubscription(subscriptionId: string, options?: CancelSubscriptionOptions): Promise<Subscription> {
    return this.run('cancelSubscription', [subscriptionId, options], { ...SUBSCRIPTION, provider: this.name });
  }
  override async pauseSubscription(subscriptionId: string, options?: PauseSubscriptionOptions): Promise<Subscription> {
    return this.run('pauseSubscription', [subscriptionId, options], { ...SUBSCRIPTION, provider: this.name });
  }
  override async resumeSubscription(subscriptionId: string, options?: ResumeSubscriptionOptions): Promise<Subscription> {
    return this.run('resumeSubscription', [subscriptionId, options], { ...SUBSCRIPTION, provider: this.name });
  }
  override async updateSubscription(subscriptionId: string, input: UpdateSubscriptionInput): Promise<Subscription> {
    return this.run('updateSubscription', [subscriptionId, input], { ...SUBSCRIPTION, provider: this.name });
  }
  override async listCharges(subscriptionId: string, options?: ListChargesOptions): Promise<Charge[]> {
    return this.run('listCharges', [subscriptionId, options], [{ ...CHARGE, provider: this.name }]);
  }
  override async getCharge(subscriptionId: string, chargeId: string): Promise<Charge> {
    return this.run('getCharge', [subscriptionId, chargeId], { ...CHARGE, provider: this.name });
  }
  override async notifyCharge(input: NotifyChargeInput): Promise<ChargeNotification> {
    return this.run('notifyCharge', [input], { ...NOTIFICATION, provider: this.name });
  }
  override async createCharge(input: CreateChargeInput): Promise<Charge> {
    return this.run('createCharge', [input], { ...CHARGE, provider: this.name });
  }
  override async refundCharge(input: RefundInput): Promise<Refund> {
    return this.run('refundCharge', [input], { ...REFUND, provider: this.name });
  }
  async verifyCheckout(result: CheckoutResult): Promise<CheckoutVerification> {
    return this.run('verifyCheckout', [result], { ...VERIFICATION, provider: this.name });
  }
  parseWebhook(request: WebhookRequest): SubscriptionEvent[] {
    this.calls.push({ method: 'parseWebhook', args: [request] });
    if (request.headers[SIGNATURE_HEADER] !== VALID_SIGNATURE) {
      throw new SubscriptionError(ErrorCode.SignatureInvalid, `${this.name} webhook signature does not match`, {
        provider: this.name,
      });
    }
    const script = this.scripts.get('parseWebhook');
    return script ? ((script as (r: WebhookRequest) => SubscriptionEvent[])(request)) : [{ ...EVENT, provider: this.name }];
  }

  lastCall(method: string): Call | undefined {
    return [...this.calls].reverse().find((call) => call.method === method);
  }
}

const TICK_RESULT = TickResultSchema.parse({
  at: '2026-11-17T10:00:00Z',
  due: 3,
  locked: 0,
  notified: 1,
  charged: 2,
  reconciled: 0,
  succeeded: 2,
  failed: 0,
  awaiting: 0,
  completed: 0,
  halted: 0,
  expired: 0,
  errors: [],
});

interface Harness {
  client: Subscriptions;
  razorpay: FakeProvider;
  cashfree: FakeProvider;
  handler: (request: Request) => Promise<Response>;
  tickCalls: unknown[];
  events: { provider: Provider; events: SubscriptionEvent[] }[];
}

function harness(overrides: Partial<HandlerOptions> = {}): Harness {
  const razorpay = new FakeProvider(Provider.Razorpay);
  const cashfree = new FakeProvider(Provider.Cashfree);
  const tickCalls: unknown[] = [];
  const scheduler = {
    tick: async (options?: unknown) => {
      tickCalls.push(options);
      return TICK_RESULT;
    },
    get: async () => undefined,
    findBySubscriptionId: async () => undefined,
    handleEvent: async () => undefined,
  } as unknown as BillingScheduler;
  const client = createSubscriptions({ providers: [razorpay, cashfree], scheduler });
  const events: Harness['events'] = [];
  const onEvents: EventsHook = (provider, received) => {
    events.push({ provider, events: received });
  };
  const handler = createHandler({ client, apiKey: API_KEY, onEvents, ...overrides });
  return { client, razorpay, cashfree, handler, tickCalls, events };
}

interface CallOptions {
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
  auth?: string | null;
}

function send(h: Harness['handler'], method: string, path: string, options: CallOptions = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.auth !== null) headers.set(HeaderName.Authorization, `Bearer ${options.auth ?? API_KEY}`);
  let body: string | undefined;
  if (options.rawBody !== undefined) body = options.rawBody;
  else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers.set(HeaderName.ContentType, ContentType.Json);
  }
  return h(new Request(`${BASE}${path}`, { method, headers, body }));
}

function parsedWith(schema: z.ZodType, value: unknown): void {
  const result = schema.safeParse(value);
  expect(result.success, result.success ? '' : JSON.stringify(result.error.issues)).toBe(true);
}

const PLAN_INPUT = { name: 'Gold', amount: 49900, interval: { unit: 'month', count: 1 } };
const SUBSCRIPTION_INPUT = {
  plan: 'plan_1',
  customer: { name: 'Asha', email: 'asha@example.com', phone: '9876543210' },
  totalCycles: 12,
};

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

interface RouteCase {
  name: string;
  method: string;
  path: string;
  body?: unknown;
  status: number;
  schema: SchemaName;
  array?: boolean;
  provider?: 'razorpay' | 'cashfree';
  /** The facade/provider call this route must cause. */
  call?: { method: string; args: unknown[] };
}

const ROUTE_CASES: RouteCase[] = [
  {
    name: 'GET capabilities',
    method: HttpMethod.Get,
    path: '/v1/razorpay/capabilities',
    status: 200,
    schema: SchemaName.Capabilities,
  },
  {
    name: 'POST plans',
    method: HttpMethod.Post,
    path: '/v1/razorpay/plans',
    body: PLAN_INPUT,
    status: 201,
    schema: SchemaName.Plan,
    call: { method: 'createPlan', args: [{ ...PLAN_INPUT, currency: Currency.INR }] },
  },
  {
    name: 'GET plan',
    method: HttpMethod.Get,
    path: '/v1/razorpay/plans/plan_1',
    status: 200,
    schema: SchemaName.Plan,
    call: { method: 'getPlan', args: ['plan_1'] },
  },
  {
    name: 'POST subscriptions',
    method: HttpMethod.Post,
    path: '/v1/razorpay/subscriptions',
    body: SUBSCRIPTION_INPUT,
    status: 201,
    schema: SchemaName.Subscription,
    call: { method: 'createSubscription', args: [SUBSCRIPTION_INPUT] },
  },
  {
    name: 'GET subscription',
    method: HttpMethod.Get,
    path: '/v1/razorpay/subscriptions/sub_1',
    status: 200,
    schema: SchemaName.Subscription,
    call: { method: 'getSubscription', args: ['sub_1'] },
  },
  {
    name: 'PATCH subscription',
    method: HttpMethod.Patch,
    path: '/v1/razorpay/subscriptions/sub_1',
    body: { quantity: 3 },
    status: 200,
    schema: SchemaName.Subscription,
    call: { method: 'updateSubscription', args: ['sub_1', { quantity: 3, timing: 'immediately' }] },
  },
  {
    name: 'POST cancel with a body',
    method: HttpMethod.Post,
    path: '/v1/razorpay/subscriptions/sub_1/cancel',
    body: { mode: 'at_period_end' },
    status: 200,
    schema: SchemaName.Subscription,
    call: { method: 'cancelSubscription', args: ['sub_1', { mode: 'at_period_end' }] },
  },
  {
    name: 'POST cancel without a body',
    method: HttpMethod.Post,
    path: '/v1/razorpay/subscriptions/sub_1/cancel',
    status: 200,
    schema: SchemaName.Subscription,
    call: { method: 'cancelSubscription', args: ['sub_1', { mode: 'immediately' }] },
  },
  {
    name: 'POST pause without a body',
    method: HttpMethod.Post,
    path: '/v1/razorpay/subscriptions/sub_1/pause',
    status: 200,
    schema: SchemaName.Subscription,
    call: { method: 'pauseSubscription', args: ['sub_1', {}] },
  },
  {
    name: 'POST pause with a body',
    method: HttpMethod.Post,
    path: '/v1/razorpay/subscriptions/sub_1/pause',
    body: { resumeAt: '2026-12-01T00:00:00Z' },
    status: 200,
    schema: SchemaName.Subscription,
    call: { method: 'pauseSubscription', args: ['sub_1', { resumeAt: '2026-12-01T00:00:00Z' }] },
  },
  {
    name: 'POST resume',
    method: HttpMethod.Post,
    path: '/v1/razorpay/subscriptions/sub_1/resume',
    status: 200,
    schema: SchemaName.Subscription,
    call: { method: 'resumeSubscription', args: ['sub_1', {}] },
  },
  {
    name: 'GET charges',
    method: HttpMethod.Get,
    path: '/v1/razorpay/subscriptions/sub_1/charges',
    status: 200,
    schema: SchemaName.Charge,
    array: true,
    call: { method: 'listCharges', args: ['sub_1', {}] },
  },
  {
    name: 'GET charges with limit',
    method: HttpMethod.Get,
    path: '/v1/razorpay/subscriptions/sub_1/charges?limit=5',
    status: 200,
    schema: SchemaName.Charge,
    array: true,
    call: { method: 'listCharges', args: ['sub_1', { limit: 5 }] },
  },
  {
    name: 'GET charge',
    method: HttpMethod.Get,
    path: '/v1/razorpay/subscriptions/sub_1/charges/pay_1',
    status: 200,
    schema: SchemaName.Charge,
    call: { method: 'getCharge', args: ['sub_1', 'pay_1'] },
  },
  {
    name: 'POST charges',
    method: HttpMethod.Post,
    path: '/v1/razorpay/charges',
    body: { subscriptionId: 'sub_1', chargeId: 'chg_1', amount: 49900 },
    status: 201,
    schema: SchemaName.Charge,
    call: { method: 'createCharge', args: [{ subscriptionId: 'sub_1', chargeId: 'chg_1', amount: 49900 }] },
  },
  {
    name: 'POST charge-notifications',
    method: HttpMethod.Post,
    path: '/v1/razorpay/charge-notifications',
    body: { subscriptionId: 'sub_1', notificationId: 'note_1', amount: 49900, debitAt: '2026-12-01T10:00:00+05:30' },
    status: 201,
    schema: SchemaName.ChargeNotification,
    call: {
      method: 'notifyCharge',
      args: [{ subscriptionId: 'sub_1', notificationId: 'note_1', amount: 49900, debitAt: '2026-12-01T10:00:00+05:30' }],
    },
  },
  {
    name: 'POST refunds',
    method: HttpMethod.Post,
    path: '/v1/razorpay/refunds',
    body: { chargeId: 'pay_1', refundId: 'rf_1', amount: 1000 },
    status: 201,
    schema: SchemaName.Refund,
    call: { method: 'refundCharge', args: [{ chargeId: 'pay_1', refundId: 'rf_1', amount: 1000 }] },
  },
  {
    name: 'POST checkout/verify',
    method: HttpMethod.Post,
    path: '/v1/razorpay/checkout/verify',
    body: { result: { razorpay_payment_id: 'pay_1', razorpay_subscription_id: 'sub_1', razorpay_signature: 'abc' } },
    status: 200,
    schema: SchemaName.CheckoutVerification,
    call: {
      method: 'verifyCheckout',
      args: [{ razorpay_payment_id: 'pay_1', razorpay_subscription_id: 'sub_1', razorpay_signature: 'abc' }],
    },
  },
  {
    name: 'POST webhooks/parse',
    method: HttpMethod.Post,
    path: '/v1/razorpay/webhooks/parse',
    body: { rawBody: '{"event":"x"}', headers: { [SIGNATURE_HEADER]: VALID_SIGNATURE } },
    status: 200,
    schema: SchemaName.SubscriptionEvent,
    array: true,
    call: {
      method: 'parseWebhook',
      args: [{ rawBody: '{"event":"x"}', headers: { [SIGNATURE_HEADER]: VALID_SIGNATURE } }],
    },
  },
  {
    name: 'routes the second gateway to the second provider',
    method: HttpMethod.Get,
    path: '/v1/cashfree/plans/plan_9',
    status: 200,
    schema: SchemaName.Plan,
    provider: 'cashfree',
    call: { method: 'getPlan', args: ['plan_9'] },
  },
];

describe('routes: happy paths', () => {
  it.each(ROUTE_CASES)('$name', async (testCase) => {
    const h = harness();
    const response = await send(h.handler, testCase.method, testCase.path, { body: testCase.body });
    const json: unknown = await response.json();
    expect(response.status).toBe(testCase.status);
    expect(response.headers.get(HeaderName.ContentType)).toContain(ContentType.Json);

    const schema = testCase.array ? namedSchemaArray(testCase.schema) : namedSchema(testCase.schema);
    parsedWith(schema, json);

    if (testCase.call) {
      const provider = testCase.provider === 'cashfree' ? h.cashfree : h.razorpay;
      const seen = provider.lastCall(testCase.call.method);
      expect(seen?.args).toEqual(testCase.call.args);
      const other = provider === h.cashfree ? h.razorpay : h.cashfree;
      expect(other.calls).toHaveLength(0);
    }
  });

  it('GET /v1/health answers without a key', async () => {
    const h = harness();
    const response = await send(h.handler, HttpMethod.Get, '/v1/health', { auth: null });
    expect(response.status).toBe(200);
    const json: unknown = await response.json();
    parsedWith(HealthSchema, json);
    expect(json).toEqual({ status: HealthStatus.Ok, providers: [Provider.Razorpay, Provider.Cashfree] });
  });

  it('GET /v1/providers lists the capabilities of every configured gateway', async () => {
    const h = harness();
    const response = await send(h.handler, HttpMethod.Get, '/v1/providers');
    const json = (await response.json()) as Capabilities[];
    expect(response.status).toBe(200);
    parsedWith(namedSchemaArray(SchemaName.Capabilities), json);
    expect(json.map((entry) => entry.provider)).toEqual([Provider.Razorpay, Provider.Cashfree]);
    parsedWith(CapabilitiesSchema, json[0]);
  });

  it('GET /v1/openapi.json serves the document without a key', async () => {
    const h = harness();
    const response = await send(h.handler, HttpMethod.Get, '/v1/openapi.json', { auth: null });
    const json = (await response.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(response.status).toBe(200);
    expect(json.openapi).toBe('3.1.0');
    expect(Object.keys(json.paths)).toContain(ApiPath.Plans);
  });

  it('POST /v1/scheduler/tick runs the scheduler, with and without a limit', async () => {
    const h = harness();
    const first = await send(h.handler, HttpMethod.Post, '/v1/scheduler/tick', { body: { limit: 10 } });
    expect(first.status).toBe(200);
    parsedWith(TickResultSchema, await first.json());
    const second = await send(h.handler, HttpMethod.Post, '/v1/scheduler/tick');
    expect(second.status).toBe(200);
    expect(h.tickCalls).toEqual([{ limit: 10 }, undefined]);
  });

  it('covers every route in the table', () => {
    const covered = new Set([
      ...ROUTE_CASES.map((c) => `${c.method} ${c.path.split('?')[0]?.replace(/plan_1|plan_9|sub_1|pay_1|razorpay|cashfree/g, (m) => PLACEHOLDERS[m] ?? m)}`),
    ]);
    // Health, openapi, providers, tick and the raw webhook are covered by their own tests, and so are the routes of one-time
    // payments, routing, purchases and the hosted checkout (test/server/payment-routes.test.ts, purchase-routes.test.ts,
    // hosted-checkout.test.ts, each of which also checks that it covers every route of its own tags).
    const own = new Set(['GET /v1/health', 'GET /v1/openapi.json', 'GET /v1/providers', 'POST /v1/scheduler/tick', 'POST /v1/{provider}/webhooks']);
    const elsewhere = new Set<string>(routes.filter((route) => OTHER_FILE_TAGS.includes(route.tag)).map((route) => `${route.method} ${route.path}`));
    for (const key of elsewhere) own.add(key);
    for (const route of routes) {
      const key = `${route.method} ${route.path}`;
      expect(covered.has(key) || own.has(key), `no test for ${key}`).toBe(true);
    }
  });
});

const OTHER_FILE_TAGS: readonly string[] = [Tag.Payments, Tag.Routing, Tag.Purchases, Tag.HostedCheckout];

const PLACEHOLDERS: Record<string, string> = {
  plan_1: '{planId}',
  plan_9: '{planId}',
  sub_1: '{subscriptionId}',
  pay_1: '{chargeId}',
  razorpay: '{provider}',
  cashfree: '{provider}',
};

function namedSchemaArray(name: SchemaName): z.ZodType {
  return z.array(namedSchema(name));
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

describe('authentication', () => {
  it('refuses to start without an apiKey or an explicit opt-out', () => {
    const { client } = harness();
    expect(() => createHandler({ client })).toThrowError(SubscriptionError);
    try {
      createHandler({ client });
      expect.unreachable();
    } catch (error) {
      expect((error as SubscriptionError).code).toBe(ErrorCode.Config);
    }
    expect(() => createHandler({ client, apiKey: '' })).toThrowError(SubscriptionError);
    expect(() => createHandler({ client, allowUnauthenticated: true })).not.toThrow();
  });

  it('answers 401 when the key is missing', async () => {
    const h = harness();
    const response = await send(h.handler, HttpMethod.Get, '/v1/providers', { auth: null });
    expect(response.status).toBe(401);
    expect(response.headers.get(ServerHeader.WwwAuthenticate)).toBe('Bearer');
    const json = ErrorResponseSchema.parse(await response.json());
    expect(json.error.code).toBe(ServerErrorCode.Unauthorized);
    expect(h.razorpay.calls).toHaveLength(0);
  });

  it('answers 401 for a wrong key, a wrong scheme and a key of another length, and never echoes the key', async () => {
    const h = harness();
    for (const header of [`Bearer wrong-key`, `Bearer ${API_KEY}x`, `Basic ${API_KEY}`, API_KEY, 'Bearer']) {
      const response = await h.handler(
        new Request(`${BASE}/v1/providers`, { headers: { [HeaderName.Authorization]: header } }),
      );
      expect(response.status, header).toBe(401);
      const text = await response.text();
      expect(text).not.toContain(API_KEY);
    }
  });

  it('accepts the right key, case-insensitively for the scheme', async () => {
    const h = harness();
    const response = await h.handler(
      new Request(`${BASE}/v1/providers`, { headers: { [HeaderName.Authorization]: `bearer ${API_KEY}` } }),
    );
    expect(response.status).toBe(200);
  });

  it('checks auth before validating the provider or reading the body', async () => {
    const h = harness();
    const response = await send(h.handler, HttpMethod.Post, '/v1/nonsense/plans', { auth: null, rawBody: '{not json' });
    expect(response.status).toBe(401);
  });

  it('leaves health, the OpenAPI document and the gateway webhook open', async () => {
    const h = harness();
    expect((await send(h.handler, HttpMethod.Get, '/v1/health', { auth: null })).status).toBe(200);
    expect((await send(h.handler, HttpMethod.Get, '/v1/openapi.json', { auth: null })).status).toBe(200);
    const webhook = await send(h.handler, HttpMethod.Post, '/v1/razorpay/webhooks', {
      auth: null,
      rawBody: '{}',
      headers: { [SIGNATURE_HEADER]: VALID_SIGNATURE },
    });
    expect(webhook.status).toBe(200);
  });

  it('serves protected routes without a key only when allowUnauthenticated is set', async () => {
    const { client } = harness();
    const open = createHandler({ client, allowUnauthenticated: true });
    expect((await send(open, HttpMethod.Get, '/v1/providers', { auth: null })).status).toBe(200);
  });

  it('keeps requiring the key when both apiKey and allowUnauthenticated are given', async () => {
    const { client } = harness();
    const both = createHandler({ client, apiKey: API_KEY, allowUnauthenticated: true });
    expect((await send(both, HttpMethod.Get, '/v1/providers', { auth: null })).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Provider and body validation
// ---------------------------------------------------------------------------

describe('provider validation', () => {
  it('answers 400 for a name that is not a gateway', async () => {
    const h = harness();
    const response = await send(h.handler, HttpMethod.Get, '/v1/stripe/capabilities');
    expect(response.status).toBe(400);
    expect(ErrorResponseSchema.parse(await response.json()).error.code).toBe(ErrorCode.Validation);
  });

  it('answers 404 for a gateway that is known but not configured', async () => {
    const h = harness();
    const response = await send(h.handler, HttpMethod.Get, '/v1/payu/capabilities');
    expect(response.status).toBe(404);
    const json = ErrorResponseSchema.parse(await response.json());
    expect(json.error.code).toBe(ErrorCode.NotFound);
    expect(json.error.message).toContain('payu');
  });
});

describe('request validation', () => {
  it('answers 400 naming the offending path, and never reaches the gateway', async () => {
    const h = harness();
    const response = await send(h.handler, HttpMethod.Post, '/v1/razorpay/plans', {
      body: { name: 'Gold', amount: -5, interval: { unit: 'month', count: 1 } },
    });
    expect(response.status).toBe(400);
    const json = ErrorResponseSchema.parse(await response.json());
    expect(json.error.code).toBe(ErrorCode.Validation);
    expect(json.error.message).toContain('amount');
    expect(h.razorpay.calls).toHaveLength(0);
  });

  it('names nested paths', async () => {
    const h = harness();
    const response = await send(h.handler, HttpMethod.Post, '/v1/razorpay/subscriptions', {
      body: { plan: 'plan_1', customer: { email: 'not-an-email' } },
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain('customer.email');
  });

  it('answers 400 for invalid JSON', async () => {
    const h = harness();
    const response = await send(h.handler, HttpMethod.Post, '/v1/razorpay/plans', { rawBody: '{"name":' });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain('JSON');
  });

  it('answers 400 when a required body is missing, but accepts a missing optional one', async () => {
    const h = harness();
    expect((await send(h.handler, HttpMethod.Post, '/v1/razorpay/plans')).status).toBe(400);
    expect((await send(h.handler, HttpMethod.Post, '/v1/razorpay/subscriptions/sub_1/cancel')).status).toBe(200);
  });

  it('rejects a body of the wrong JSON type', async () => {
    const h = harness();
    expect((await send(h.handler, HttpMethod.Post, '/v1/razorpay/checkout/verify', { body: [1, 2] })).status).toBe(400);
    // the bare gateway result is no longer the body: it must be wrapped as `result`
    const bare = { razorpay_payment_id: 'pay_1' };
    expect((await send(h.handler, HttpMethod.Post, '/v1/razorpay/checkout/verify', { body: bare })).status).toBe(400);
  });

  describe('POST checkout/verify expectedSubscriptionId', () => {
    const verify = (body: unknown) => {
      const h = harness();
      return send(h.handler, HttpMethod.Post, '/v1/razorpay/checkout/verify', { body });
    };
    const result = { razorpay_payment_id: 'pay_1' };

    it('accepts a result that belongs to the expected subscription', async () => {
      expect((await verify({ result, expectedSubscriptionId: VERIFICATION.subscriptionId })).status).toBe(200);
    });

    it('rejects a genuine result that belongs to another subscription like a forged one', async () => {
      const response = await verify({ result, expectedSubscriptionId: 'sub_other' });
      expect(response.status).toBe(401);
      expect(ErrorResponseSchema.parse(await response.json()).error.code).toBe(ErrorCode.SignatureInvalid);
    });

    it('accepts a request without it', async () => {
      expect((await verify({ result })).status).toBe(200);
    });

    it('rejects an empty expectedSubscriptionId', async () => {
      expect((await verify({ result, expectedSubscriptionId: '' })).status).toBe(400);
    });
  });

  it('rejects an invalid limit query', async () => {
    const h = harness();
    for (const limit of ['abc', '0', '101', '']) {
      const response = await send(h.handler, HttpMethod.Get, `/v1/razorpay/subscriptions/sub_1/charges?limit=${limit}`);
      expect(response.status, limit).toBe(400);
    }
  });

  it('rejects a path with broken percent-encoding', async () => {
    const h = harness();
    expect((await send(h.handler, HttpMethod.Get, '/v1/razorpay/plans/%E0%A4%A')).status).toBe(400);
  });

  it('decodes percent-encoded path parameters', async () => {
    const h = harness();
    await send(h.handler, HttpMethod.Get, '/v1/razorpay/plans/plan%2F1');
    expect(h.razorpay.lastCall('getPlan')?.args).toEqual(['plan/1']);
  });
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const EXPECTED_STATUS: Record<ErrorCode, number> = {
  [ErrorCode.Validation]: 400,
  [ErrorCode.SignatureInvalid]: 401,
  [ErrorCode.NoRoute]: 422,
  [ErrorCode.NotFound]: 404,
  [ErrorCode.Conflict]: 409,
  [ErrorCode.Unsupported]: 422,
  [ErrorCode.RateLimited]: 429,
  [ErrorCode.Config]: 500,
  [ErrorCode.Auth]: 502,
  [ErrorCode.ProviderError]: 502,
  [ErrorCode.UnexpectedResponse]: 502,
  [ErrorCode.Network]: 502,
  [ErrorCode.ProviderUnavailable]: 503,
  [ErrorCode.Timeout]: 504,
  [ErrorCode.OutcomeUnknown]: 504,
  [ErrorCode.Internal]: 500,
};

describe('errors', () => {
  it.each(Object.values(ErrorCode))('maps %s to its HTTP status', async (code) => {
    const h = harness();
    h.razorpay.failWith(
      'getSubscription',
      new SubscriptionError(code, 'gateway said no', {
        provider: Provider.Razorpay,
        httpStatus: 418,
        providerCode: 'BAD_REQUEST_ERROR',
        raw: { secret: 'must-not-appear' },
      }),
    );
    const response = await send(h.handler, HttpMethod.Get, '/v1/razorpay/subscriptions/sub_1');
    expect(response.status).toBe(EXPECTED_STATUS[code]);
    expect(ERROR_HTTP_STATUS[code]).toBe(EXPECTED_STATUS[code]);
    const text = await response.text();
    expect(text).not.toContain('must-not-appear');
    const json = ErrorResponseSchema.parse(JSON.parse(text));
    expect(json.error).toMatchObject({
      code,
      message: 'gateway said no',
      provider: Provider.Razorpay,
      httpStatus: 418,
      providerCode: 'BAD_REQUEST_ERROR',
    });
    expect(typeof json.error.retryable).toBe('boolean');
  });

  it('flags retryable errors', async () => {
    const h = harness();
    h.razorpay.failWith('getPlan', new SubscriptionError(ErrorCode.RateLimited, 'slow down'));
    const response = await send(h.handler, HttpMethod.Get, '/v1/razorpay/plans/plan_1');
    expect(ErrorResponseSchema.parse(await response.json()).error.retryable).toBe(true);
  });

  it('turns an unknown thrown value into a generic 500 without leaking it', async () => {
    const h = harness();
    h.razorpay.failWith('getPlan', new TypeError('db password is hunter2 at /srv/app.js:42'));
    const response = await send(h.handler, HttpMethod.Get, '/v1/razorpay/plans/plan_1');
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('app.js');
    const json = ErrorResponseSchema.parse(JSON.parse(text));
    expect(json.error.code).toBe(ServerErrorCode.Internal);
    expect(json.error.retryable).toBe(false);
  });

  it('answers a tick on a client without a scheduler with 500 CONFIG', async () => {
    const razorpay = new FakeProvider(Provider.Razorpay);
    const client = createSubscriptions({ providers: [razorpay] });
    const handler = createHandler({ client, apiKey: API_KEY });
    const response = await send(handler, HttpMethod.Post, '/v1/scheduler/tick');
    expect(response.status).toBe(500);
    expect(ErrorResponseSchema.parse(await response.json()).error.code).toBe(ErrorCode.Config);
  });
});

// ---------------------------------------------------------------------------
// Routing: 404, 405, 413, basePath
// ---------------------------------------------------------------------------

describe('routing', () => {
  it('answers 404 for an unknown path', async () => {
    const h = harness();
    for (const path of ['/', '/v1', '/v1/razorpay', '/v1/razorpay/nope', '/v2/health', '/v1/razorpay/plans/a/b']) {
      const response = await send(h.handler, HttpMethod.Get, path);
      expect(response.status, path).toBe(404);
      expect(ErrorResponseSchema.parse(await response.json()).error.code).toBe(ErrorCode.NotFound);
    }
  });

  it('answers 405 with an Allow header for a known path and the wrong method', async () => {
    const h = harness();
    const response = await send(h.handler, HttpMethod.Delete, '/v1/razorpay/subscriptions/sub_1');
    expect(response.status).toBe(405);
    expect(response.headers.get(ServerHeader.Allow)).toBe('GET, PATCH');
    expect(ErrorResponseSchema.parse(await response.json()).error.code).toBe(ServerErrorCode.MethodNotAllowed);

    const health = await send(h.handler, HttpMethod.Post, '/v1/health', { auth: null });
    expect(health.status).toBe(405);
    expect(health.headers.get(ServerHeader.Allow)).toBe('GET');
  });

  it('tolerates a trailing slash', async () => {
    const h = harness();
    expect((await send(h.handler, HttpMethod.Get, '/v1/providers/')).status).toBe(200);
  });

  it('answers 413 for a body over the limit, by Content-Length and by streamed size', async () => {
    const h = harness({ maxBodyBytes: 64 });
    const big = JSON.stringify({ name: 'x'.repeat(200), amount: 1, interval: { unit: 'month', count: 1 } });
    const declared = await send(h.handler, HttpMethod.Post, '/v1/razorpay/plans', {
      rawBody: big,
      headers: { [ServerHeader.ContentLength]: String(big.length) },
    });
    expect(declared.status).toBe(413);
    expect(ErrorResponseSchema.parse(await declared.json()).error.code).toBe(ServerErrorCode.PayloadTooLarge);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new TextEncoder().encode('x'.repeat(40));
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const streamed = await h.handler(
      new Request(`${BASE}/v1/razorpay/plans`, {
        method: 'POST',
        headers: { [HeaderName.Authorization]: `Bearer ${API_KEY}` },
        body: stream,
        duplex: 'half',
      } as RequestInit),
    );
    expect(streamed.status).toBe(413);
    expect(h.razorpay.calls).toHaveLength(0);
  });

  it('accepts a body exactly at the limit', async () => {
    const body = JSON.stringify({ chargeId: 'pay_1', refundId: 'rf_1' });
    const h = harness({ maxBodyBytes: Buffer.byteLength(body) });
    expect((await send(h.handler, HttpMethod.Post, '/v1/razorpay/refunds', { rawBody: body })).status).toBe(201);
  });

  it('rejects a non-positive maxBodyBytes', () => {
    const { client } = harness();
    expect(() => createHandler({ client, apiKey: API_KEY, maxBodyBytes: 0 })).toThrowError(SubscriptionError);
  });

  describe('basePath', () => {
    it('serves under the prefix and nowhere else', async () => {
      const h = harness({ basePath: '/billing' });
      expect((await send(h.handler, HttpMethod.Get, '/billing/v1/providers')).status).toBe(200);
      expect((await send(h.handler, HttpMethod.Get, '/billing/v1/razorpay/plans/plan_1')).status).toBe(200);
      expect((await send(h.handler, HttpMethod.Get, '/v1/providers')).status).toBe(404);
      expect((await send(h.handler, HttpMethod.Get, '/billingv1/providers')).status).toBe(404);
      expect((await send(h.handler, HttpMethod.Get, '/billing')).status).toBe(404);
    });

    it('accepts a prefix written with a trailing slash or without a leading one', async () => {
      for (const basePath of ['/billing/', 'billing']) {
        const h = harness({ basePath });
        expect((await send(h.handler, HttpMethod.Get, '/billing/v1/providers')).status, basePath).toBe(200);
      }
    });

    it('puts the prefix in the document served from /openapi.json', async () => {
      const h = harness({ basePath: '/billing' });
      const response = await send(h.handler, HttpMethod.Get, '/billing/v1/openapi.json', { auth: null });
      expect(((await response.json()) as { servers: { url: string }[] }).servers).toEqual([{ url: '/billing' }]);
    });
  });
});

// ---------------------------------------------------------------------------
// Raw webhook route
// ---------------------------------------------------------------------------

/** Unusual whitespace, a BOM, non-ASCII text, an emoji and CRLF: a re-serialised body would differ. */
const AWKWARD_BODY = '﻿{ "event" :\t"subscription.charged" ,\r\n  "note": "café ₹499 \u{1F600}",  "n": 1.0 }\r\n  ';

describe('POST /v1/{provider}/webhooks', () => {
  it('hands the exact raw body string and the headers to the provider, then calls onEvents', async () => {
    const h = harness();
    const response = await send(h.handler, HttpMethod.Post, '/v1/razorpay/webhooks', {
      auth: null,
      rawBody: AWKWARD_BODY,
      headers: { [SIGNATURE_HEADER]: VALID_SIGNATURE, 'X-Other': 'a' },
    });
    expect(response.status).toBe(200);
    const json = WebhookReceiptSchema.parse(await response.json());
    expect(json).toEqual({ received: 1 });

    const seen = h.razorpay.lastCall('parseWebhook')?.args[0] as WebhookRequest;
    expect(seen.rawBody).toBe(AWKWARD_BODY);
    expect(Buffer.from(seen.rawBody, 'utf8').equals(Buffer.from(AWKWARD_BODY, 'utf8'))).toBe(true);
    expect(seen.headers[SIGNATURE_HEADER]).toBe(VALID_SIGNATURE);
    expect(seen.headers['x-other']).toBe('a');

    expect(h.events).toHaveLength(1);
    expect(h.events[0]?.provider).toBe(Provider.Razorpay);
    expect(h.events[0]?.events[0]?.id).toBe('evt_1');
  });

  it('works with no onEvents hook and with a body that is not JSON', async () => {
    const { client } = harness();
    const handler = createHandler({ client, apiKey: API_KEY });
    const response = await send(handler, HttpMethod.Post, '/v1/razorpay/webhooks', {
      auth: null,
      rawBody: 'txnid=1&status=success',
      headers: { [SIGNATURE_HEADER]: VALID_SIGNATURE, [HeaderName.ContentType]: ContentType.Form },
    });
    expect(response.status).toBe(200);
  });

  it('answers 401 for a bad signature and does not call onEvents', async () => {
    const h = harness();
    const response = await send(h.handler, HttpMethod.Post, '/v1/razorpay/webhooks', {
      auth: null,
      rawBody: '{}',
      headers: { [SIGNATURE_HEADER]: 'forged' },
    });
    expect(response.status).toBe(401);
    expect(ErrorResponseSchema.parse(await response.json()).error.code).toBe(ErrorCode.SignatureInvalid);
    expect(h.events).toHaveLength(0);
  });

  it('answers 500 without leaking when onEvents throws, so the gateway retries', async () => {
    const h = harness({
      onEvents: () => {
        throw new SubscriptionError(ErrorCode.NotFound, 'internal lookup hunter2 failed');
      },
    });
    const response = await send(h.handler, HttpMethod.Post, '/v1/razorpay/webhooks', {
      auth: null,
      rawBody: '{}',
      headers: { [SIGNATURE_HEADER]: VALID_SIGNATURE },
    });
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain('hunter2');
    expect(ErrorResponseSchema.parse(JSON.parse(text)).error.code).toBe(ServerErrorCode.Internal);
  });

  it('also awaits an async onEvents that rejects', async () => {
    const h = harness({ onEvents: async () => Promise.reject(new Error('queue down')) });
    const response = await send(h.handler, HttpMethod.Post, '/v1/razorpay/webhooks', {
      auth: null,
      rawBody: '{}',
      headers: { [SIGNATURE_HEADER]: VALID_SIGNATURE },
    });
    expect(response.status).toBe(500);
  });

  it('answers 404 for a webhook of an unconfigured gateway', async () => {
    const h = harness();
    const response = await send(h.handler, HttpMethod.Post, '/v1/payu/webhooks', { auth: null, rawBody: '{}' });
    expect(response.status).toBe(404);
  });

  it('is not subject to the body limit being bypassed', async () => {
    const h = harness({ maxBodyBytes: 8 });
    const response = await send(h.handler, HttpMethod.Post, '/v1/razorpay/webhooks', {
      auth: null,
      rawBody: 'x'.repeat(100),
      headers: { [SIGNATURE_HEADER]: VALID_SIGNATURE },
    });
    expect(response.status).toBe(413);
  });
});

// ---------------------------------------------------------------------------
// End to end through node:http
// ---------------------------------------------------------------------------

describe('createNodeServer', () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    while (closers.length > 0) await closers.pop()?.();
  });

  async function start(overrides: Partial<HandlerOptions> = {}): Promise<{ url: string; h: Harness }> {
    const h = harness(overrides);
    const running = await listen(
      createNodeServer({ client: h.client, apiKey: API_KEY, onEvents: (p, e) => void h.events.push({ provider: p, events: e }), ...overrides }),
    );
    closers.push(running.close);
    return { url: running.url, h };
  }

  it('serves JSON over a real socket, with auth', async () => {
    const { url, h } = await start();
    const health = await fetch(`${url}/v1/health`);
    expect(health.status).toBe(200);
    HealthSchema.parse(await health.json());

    const denied = await fetch(`${url}/v1/providers`);
    expect(denied.status).toBe(401);

    const created = await fetch(`${url}/v1/razorpay/plans`, {
      method: 'POST',
      headers: { authorization: `Bearer ${API_KEY}`, 'content-type': ContentType.Json },
      body: JSON.stringify(PLAN_INPUT),
    });
    expect(created.status).toBe(201);
    parsedWith(namedSchema(SchemaName.Plan), await created.json());
    expect(h.razorpay.lastCall('createPlan')?.args).toEqual([{ ...PLAN_INPUT, currency: Currency.INR }]);
  });

  it('passes the webhook body through byte for byte', async () => {
    const razorpay = new FakeProvider(Provider.Razorpay);
    const client = createSubscriptions({ providers: [razorpay] });
    const received: SubscriptionEvent[][] = [];
    const running = await listen(
      createNodeServer({ client, apiKey: API_KEY, onEvents: (_provider, events) => void received.push(events) }),
    );
    closers.push(running.close);

    const bytes = Buffer.from(AWKWARD_BODY, 'utf8');
    const response = await fetch(`${running.url}/v1/razorpay/webhooks`, {
      method: 'POST',
      headers: { [SIGNATURE_HEADER]: VALID_SIGNATURE, 'content-type': ContentType.Json },
      body: bytes,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: 1 });
    const seen = razorpay.lastCall('parseWebhook')?.args[0] as WebhookRequest;
    expect(seen.rawBody).toBe(AWKWARD_BODY);
    expect(seen.headers[SIGNATURE_HEADER]).toBe(VALID_SIGNATURE);
    expect(received).toHaveLength(1);
  });

  it('maps errors and 404/405 over the wire', async () => {
    const razorpay = new FakeProvider(Provider.Razorpay);
    razorpay.failWith('getPlan', new SubscriptionError(ErrorCode.Timeout, 'timed out', { provider: Provider.Razorpay }));
    const client = createSubscriptions({ providers: [razorpay] });
    const running = await listen(createNodeServer({ client, apiKey: API_KEY }));
    closers.push(running.close);
    const headers = { authorization: `Bearer ${API_KEY}` };

    const timeout = await fetch(`${running.url}/v1/razorpay/plans/p`, { headers });
    expect(timeout.status).toBe(504);
    expect(((await timeout.json()) as { error: { retryable: boolean } }).error.retryable).toBe(true);

    expect((await fetch(`${running.url}/nope`, { headers })).status).toBe(404);
    const wrongMethod = await fetch(`${running.url}/v1/providers`, { method: 'DELETE', headers });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('GET');
  });

  it('answers 413 for an oversized streamed body', async () => {
    const { url } = await start({ maxBodyBytes: 32 });
    const response = await fetch(`${url}/v1/razorpay/plans`, {
      method: 'POST',
      headers: { authorization: `Bearer ${API_KEY}`, 'content-type': ContentType.Json },
      body: JSON.stringify({ name: 'x'.repeat(500) }),
    });
    expect(response.status).toBe(413);
  });

  it('binds to an ephemeral loopback port by default', async () => {
    const h = harness();
    const running = await listen(createNodeServer({ client: h.client, apiKey: API_KEY }));
    closers.push(running.close);
    const address = running.server.address() as AddressInfo;
    expect(address.address).toBe('127.0.0.1');
    expect(running.port).toBe(address.port);
    expect(running.port).toBeGreaterThan(0);
  });

  it('refuses to start without a key', () => {
    const { client } = harness();
    expect(() => createNodeServer({ client })).toThrowError(SubscriptionError);
  });
});
