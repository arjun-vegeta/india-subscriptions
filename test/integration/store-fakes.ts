/**
 * Scripted services for the store scenarios: Google's token endpoint and the external transactions API, and a Razorpay
 * that keeps the plans, subscriptions and orders it is asked to create and reports them paid on request. One `fetch`
 * answers for both, by host, the way the adapters reach them.
 */
import { createHmac } from 'node:crypto';
import type { FetchLike } from '../../src/http.js';
import { RazorpayEndpoint, RazorpayNoteKey } from '../../src/providers/razorpay/constants.js';
import { EXTERNAL_CREATE_RESPONSE_SAMPLE, EXTERNAL_REFUND_RESPONSE_SAMPLE } from '../googleplay/fixtures.js';
import { tokenBody } from '../googleplay/helpers.js';
import { ORDER_FETCHED, ORDER_PAYMENTS } from '../razorpay/one-time-fixtures.js';
import { RAZORPAY_ADAPTER_TEST, fixtureJson } from './helpers.js';

export const RAZORPAY_KEY_SECRET = 'rzp_secret_for_the_store_scenarios';
export const RAZORPAY_WEBHOOK_SECRET = 'rzp_whsec_for_the_store_scenarios';

export interface GoogleCall {
  method: string;
  path: string;
  query: Record<string, string>;
  json: Record<string, unknown> | undefined;
}

export const hmacHex = (secret: string, text: string): string => createHmac('sha256', secret).update(text, 'utf8').digest('hex');

const reply = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export interface StoreFakes {
  fetch: FetchLike;
  /** Every call to Google's external transactions API, in order. */
  google: GoogleCall[];
  /** Makes the next calls to Google's external transactions API fail with this status, one per call. */
  googleFailures: number[];
  /** Calls to Razorpay, `METHOD path`. */
  razorpay: string[];
  /** The amount of each order or subscription charge Razorpay was asked to create. */
  orders: Map<string, { amount: number; notes: Record<string, string> }>;
  subscriptions: Map<string, { notes: Record<string, string> }>;
}

export function storeFakes(): StoreFakes {
  const g: StoreFakes = { fetch: undefined as never, google: [], googleFailures: [], razorpay: [], orders: new Map(), subscriptions: new Map() };
  const doc = (name: string) => fixtureJson(RAZORPAY_ADAPTER_TEST, name);
  let counter = 0;

  g.fetch = async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const parsed = new URL(url);

    if (parsed.host === 'oauth2.googleapis.com') return reply(tokenBody());
    if (parsed.host === 'androidpublisher.googleapis.com') {
      const path = parsed.pathname.replace('/androidpublisher/v3', '');
      g.google.push({
        method,
        path,
        query: Object.fromEntries(parsed.searchParams),
        json: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
      });
      const failure = g.googleFailures.shift();
      if (failure !== undefined) return reply({ error: { code: failure, message: 'scripted failure', status: 'UNAVAILABLE' } }, failure);
      if (path.endsWith(':refund')) return reply({ ...EXTERNAL_REFUND_RESPONSE_SAMPLE, externalTransactionId: decodeURIComponent(path.split('/').pop()!.replace(':refund', '')) });
      return reply({ ...EXTERNAL_CREATE_RESPONSE_SAMPLE, externalTransactionId: parsed.searchParams.get('externalTransactionId') });
    }

    // Razorpay.
    const path = parsed.pathname;
    g.razorpay.push(`${method} ${path}`);
    if (method === 'POST' && path === RazorpayEndpoint.plans) {
      const request = JSON.parse(String(init?.body)) as { item: { amount: number } };
      return reply({ ...doc('CREATE_PLAN_RESPONSE'), id: 'plan_store_1', period: 'monthly', interval: 1, item: { ...doc('CREATE_PLAN_RESPONSE').item, amount: request.item.amount, unit_amount: request.item.amount } });
    }
    if (method === 'POST' && path === RazorpayEndpoint.subscriptions) {
      counter += 1;
      const id = `sub_store_${counter}`;
      const request = JSON.parse(String(init?.body)) as { notes: Record<string, string> };
      g.subscriptions.set(id, { notes: request.notes });
      return reply({ ...doc('CREATE_SUBSCRIPTION_RESPONSE'), id, notes: request.notes });
    }
    const subscription = /^\/v1\/subscriptions\/([^/]+)$/.exec(path);
    if (method === 'GET' && subscription) {
      const known = g.subscriptions.get(subscription[1] as string);
      return reply({ ...doc('FETCH_SUBSCRIPTION_RESPONSE'), id: subscription[1], notes: known?.notes ?? {} });
    }
    if (method === 'POST' && path === RazorpayEndpoint.orders) {
      counter += 1;
      const id = `order_store_${counter}`;
      const request = JSON.parse(String(init?.body)) as { amount: number; notes: Record<string, string> };
      g.orders.set(id, { amount: request.amount, notes: request.notes });
      return reply({ ...JSON.parse(ORDER_FETCHED), id, amount: request.amount, amount_due: request.amount, notes: request.notes });
    }
    const order = /^\/v1\/orders\/([^/]+)(\/payments)?$/.exec(path);
    if (method === 'GET' && order) {
      const known = g.orders.get(order[1] as string);
      if (!known) return reply({ error: { code: 'BAD_REQUEST_ERROR', description: 'The id provided does not exist' } }, 400);
      if (order[2]) {
        const items = (JSON.parse(ORDER_PAYMENTS) as { items: Array<Record<string, unknown>> }).items.map((item) => ({ ...item, order_id: order[1], amount: known.amount }));
        return reply({ entity: 'collection', count: items.length, items });
      }
      return reply({ ...JSON.parse(ORDER_FETCHED), id: order[1], amount: known.amount, amount_due: 0, amount_paid: known.amount, status: 'paid', attempts: 2, notes: known.notes });
    }
    throw new Error(`unexpected request ${method} ${url}`);
  };
  return g;
}

/** The callback Razorpay's checkout sends for a subscription: the payment id first, then the subscription id. */
export function subscriptionCallback(subscriptionId: string, paymentId = 'pay_first_authorisation'): Record<string, string> {
  return {
    razorpay_payment_id: paymentId,
    razorpay_subscription_id: subscriptionId,
    razorpay_signature: hmacHex(RAZORPAY_KEY_SECRET, `${paymentId}|${subscriptionId}`),
  };
}

/** The callback for an order: the order id first, then the payment id. */
export function orderCallback(orderId: string, paymentId = 'pay_order_payment'): Record<string, string> {
  return {
    razorpay_order_id: orderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: hmacHex(RAZORPAY_KEY_SECRET, `${orderId}|${paymentId}`),
  };
}

export { RazorpayNoteKey };
