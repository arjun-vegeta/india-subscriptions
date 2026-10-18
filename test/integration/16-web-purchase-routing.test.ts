/**
 * Seam 16: a web purchase through the HTTP service, the purchase module, the router and two real gateway adapters. The
 * first gateway (Razorpay) is unavailable, the second (Cashfree) takes the order, the customer pays on the hosted checkout
 * and comes back to its return endpoint, and the routing outcome is recorded in exactly one place.
 */
import { describe, expect, it } from 'vitest';
import { Environment, ErrorCode, HttpMethod, PaymentMethod, Provider } from '../../src/constants.js';
import { createSubscriptions } from '../../src/client.js';
import type { FetchLike } from '../../src/http.js';
import { cashfree } from '../../src/providers/cashfree/index.js';
import { razorpay } from '../../src/providers/razorpay/index.js';
import { EntitlementsSchema, MemoryPurchaseStore, PurchaseSessionSchema, SessionStatus } from '../../src/purchase/index.js';
import { MemoryRoutingStatsStore, RouteOutcomeKind, RouteOutcomeResult } from '../../src/routing/index.js';
import { createHandler } from '../../src/server/index.js';
import { CREATE_ORDER_RESPONSE, GET_ORDER_PAID, PAYMENTS_FOR_ORDER_UPI } from '../cashfree/payment-fixtures.js';

const API_KEY = 'integration-api-key-0123456789';
const BASE = 'https://billing.example.com';
const SESSION_RETURN = 'https://shop.example.com/done';
const COINS = { key: 'coins-100', kind: 'one_time', name: '100 coins', amount: 9900 } as const;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Gateways {
  fetch: FetchLike;
  razorpayCalls: string[];
  cashfreeCalls: string[];
  /** The Cashfree order the customer paid, by id. */
  orders: Map<string, Record<string, unknown>>;
}

/** Razorpay is down (503 on every call); Cashfree keeps the orders it is asked to create and reports them paid on request. */
function gateways(): Gateways {
  const g: Gateways = { fetch: undefined as never, razorpayCalls: [], cashfreeCalls: [], orders: new Map() };
  g.fetch = async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.startsWith('https://api.razorpay.com')) {
      g.razorpayCalls.push(`${method} ${url}`);
      return json({ error: { code: 'SERVER_ERROR', description: 'Service unavailable' } }, 503);
    }
    g.cashfreeCalls.push(`${method} ${url}`);
    const path = new URL(url).pathname.replace('/pg', '');
    if (method === 'POST' && path === '/orders') {
      const request = JSON.parse(String(init?.body)) as { order_id: string; order_amount: number; order_meta: Record<string, string> };
      const order = { ...CREATE_ORDER_RESPONSE, order_id: request.order_id, order_amount: request.order_amount, order_meta: request.order_meta };
      g.orders.set(request.order_id, order);
      return json(order);
    }
    const orderId = path.split('/')[2] as string;
    const order = g.orders.get(orderId);
    if (!order) return json({ message: 'order not found', code: 'order_not_found', type: 'invalid_request_error' }, 404);
    if (path.endsWith('/payments')) {
      return json(PAYMENTS_FOR_ORDER_UPI.slice(0, 1).map((attempt) => ({ ...attempt, order_id: orderId, order_amount: order.order_amount, payment_amount: order.order_amount })));
    }
    if (path.endsWith('/refunds')) return json([]);
    return json({ ...GET_ORDER_PAID, order_id: orderId, order_amount: order.order_amount, order_meta: order.order_meta });
  };
  return g;
}

function setup() {
  const g = gateways();
  const stats = new MemoryRoutingStatsStore();
  const now = () => new Date('2026-11-23T10:00:00.000Z');
  const client = createSubscriptions({
    providers: [
      razorpay({ keyId: 'rzp_test_id', keySecret: 'rzp_secret' }, { fetch: g.fetch, maxRetries: 0, now }),
      cashfree({ clientId: 'cf_id', clientSecret: 'cf_secret', environment: Environment.Test }, { fetch: g.fetch, maxRetries: 0, now }),
    ],
    routing: { stats, now, strategy: { priority: [Provider.Razorpay, Provider.Cashfree] } },
    purchases: {
      catalog: [COINS],
      store: new MemoryPurchaseStore(),
      now,
      gatewayReturnUrl: (id) => `${BASE}/checkout/${id}/return`,
      hostedCheckoutUrl: (id) => `${BASE}/checkout/${id}`,
    },
  });
  const handler = createHandler({ client, apiKey: API_KEY });
  const call = (method: string, path: string, body?: unknown, auth = true) =>
    handler(
      new Request(`${BASE}${path}`, {
        method,
        redirect: 'manual',
        headers: { ...(auth ? { authorization: `Bearer ${API_KEY}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  return { g, stats, client, call };
}

const totals = async (stats: MemoryRoutingStatsStore, provider: Provider, kind: RouteOutcomeKind) =>
  stats.read({ provider, kind }, '2026-11-23T00:00:00.000Z');

describe('a web purchase with the first gateway down', () => {
  it('is routed to the second gateway, paid on the hosted checkout, completed through the return endpoint', async () => {
    const t = setup();
    const started = await t.call(HttpMethod.Post, '/v1/purchases', {
      platform: 'web',
      product: COINS.key,
      customer: { name: 'Asha', email: 'asha@example.com', phone: '9876543210' },
      customerRef: 'cust_1',
      returnUrl: SESSION_RETURN,
      paymentMethods: undefined,
    });
    expect(started.status).toBe(201);
    const session = PurchaseSessionSchema.parse(await started.json());

    // Razorpay was tried first and answered 503 to a write that carries no idempotency key (its outcome is unknown); Cashfree took the order.
    expect(session.attempts.map((attempt) => [attempt.provider, attempt.outcome, attempt.errorCode])).toEqual([
      [Provider.Razorpay, 'failed', ErrorCode.OutcomeUnknown],
      [Provider.Cashfree, 'created', undefined],
    ]);
    expect(t.g.razorpayCalls).toHaveLength(1);
    const option = session.options[0]!;
    expect(option).toMatchObject({ channel: 'gateway', provider: Provider.Cashfree, hostedUrl: `${BASE}/checkout/${session.id}` });
    expect(option.checkout).toMatchObject({ kind: 'cashfree_checkout', productKind: 'one_time', environment: Environment.Test });
    expect(option.routing?.ranked).toEqual([Provider.Razorpay, Provider.Cashfree]);
    // Cashfree was told to send the customer to the hosted checkout's return endpoint, with the order id added.
    const created = [...t.g.orders.values()][0] as { order_id: string; order_meta: { return_url: string } };
    expect(created.order_meta.return_url).toBe(`${BASE}/checkout/${session.id}/return?order_id=${created.order_id}`);
    expect(option.handle).toBe(created.order_id);

    // The customer's browser opens the hosted page (no key): Cashfree.js, a strict policy.
    const page = await t.call(HttpMethod.Get, `/checkout/${session.id}`, undefined, false);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain('https://sdk.cashfree.com');
    expect(await page.text()).toContain('https://sdk.cashfree.com/js/v3/cashfree.js');

    // Cashfree sends the customer back with the order id; the order is confirmed with Cashfree, not believed.
    const back = await t.call(HttpMethod.Get, `/checkout/${session.id}/return?order_id=${created.order_id}`, undefined, false);
    expect(back.status).toBe(303);
    const location = new URL(back.headers.get('location') ?? '');
    expect(location.origin + location.pathname).toBe(SESSION_RETURN);
    expect(location.searchParams.get('status')).toBe(SessionStatus.Completed);
    expect(t.g.cashfreeCalls.some((line) => line.endsWith(`/orders/${created.order_id}`))).toBe(true);

    const done = PurchaseSessionSchema.parse(await (await t.call(HttpMethod.Get, `/v1/purchases/${session.id}`)).json());
    expect(done).toMatchObject({ status: SessionStatus.Completed, provider: Provider.Cashfree, paymentId: created.order_id });

    const owned = EntitlementsSchema.parse(await (await t.call(HttpMethod.Get, '/v1/entitlements/cust_1')).json());
    expect(owned.active).toBe(true);
    expect(owned.items).toMatchObject([{ product: COINS.key, kind: 'one_time', provider: Provider.Cashfree, channel: 'gateway', platform: 'web', paymentId: created.order_id }]);
  });

  it('records each routing outcome in exactly one place', async () => {
    const t = setup();
    const started = await t.call(HttpMethod.Post, '/v1/purchases', {
      platform: 'web',
      product: COINS.key,
      customer: { name: 'Asha', email: 'asha@example.com', phone: '9876543210' },
      customerRef: 'cust_2',
      returnUrl: SESSION_RETURN,
    });
    const session = PurchaseSessionSchema.parse(await started.json());
    const orderId = session.options[0]!.handle;

    // Creating the order: one unavailable for Razorpay, one success for Cashfree, and nothing else.
    expect(await totals(t.stats, Provider.Razorpay, RouteOutcomeKind.Request)).toEqual({ success: 0, failure: 0, unavailable: 1 });
    expect(await totals(t.stats, Provider.Cashfree, RouteOutcomeKind.Request)).toEqual({ success: 1, failure: 0, unavailable: 0 });

    await t.call(HttpMethod.Get, `/checkout/${session.id}/return?order_id=${orderId}`, undefined, false);
    // The customer paying: one payment success for Cashfree. A second visit to the return endpoint counts nothing more.
    await t.call(HttpMethod.Get, `/checkout/${session.id}/return?order_id=${orderId}`, undefined, false);
    expect(await totals(t.stats, Provider.Cashfree, RouteOutcomeKind.Payment)).toEqual({ success: 1, failure: 0, unavailable: 0 });
    // Neither the facade nor the HTTP route recorded anything of their own.
    expect(await totals(t.stats, Provider.Razorpay, RouteOutcomeKind.Request)).toEqual({ success: 0, failure: 0, unavailable: 1 });
    expect(await totals(t.stats, Provider.Cashfree, RouteOutcomeKind.Request)).toEqual({ success: 1, failure: 0, unavailable: 0 });
    expect(await totals(t.stats, Provider.Razorpay, RouteOutcomeKind.Payment)).toEqual({ success: 0, failure: 0, unavailable: 0 });
    expect(RouteOutcomeResult.Unavailable).toBe('unavailable');
  });

  it('opens the circuit of a gateway that keeps failing: the next purchase goes straight to the second gateway', async () => {
    const t = setup();
    const start = (customerRef: string) =>
      t.call(HttpMethod.Post, '/v1/purchases', {
        platform: 'web',
        product: COINS.key,
        customer: { name: 'Asha', email: 'asha@example.com', phone: '9876543210' },
        customerRef,
        returnUrl: SESSION_RETURN,
      });
    for (let i = 0; i < 5; i += 1) expect((await start(`cust_${i}`)).status).toBe(201);
    expect(t.g.razorpayCalls).toHaveLength(5);
    const sixth = PurchaseSessionSchema.parse(await (await start('cust_6')).json());
    // Five consecutive `unavailable` results opened Razorpay's circuit: it is not called again, and the decision says why.
    expect(t.g.razorpayCalls).toHaveLength(5);
    expect(sixth.attempts.map((attempt) => attempt.provider)).toEqual([Provider.Cashfree]);
    expect(sixth.options[0]?.routing?.candidates.find((candidate) => candidate.provider === Provider.Razorpay)?.exclusions).toContain('unhealthy');
  });

  it('routing decisions over HTTP see the same state', async () => {
    const t = setup();
    const decision = await t.call(HttpMethod.Post, '/v1/routing/decide', { kind: 'one_time', amount: 9900, paymentMethods: [PaymentMethod.Upi] });
    expect(decision.status).toBe(200);
    expect(((await decision.json()) as { ranked: string[] }).ranked).toEqual([Provider.Razorpay, Provider.Cashfree]);
  });
});
