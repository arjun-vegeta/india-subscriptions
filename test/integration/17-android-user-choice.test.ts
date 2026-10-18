/**
 * Seam 17: an Android purchase with user choice billing, end to end through the HTTP service, the purchase module, the real
 * Google Play adapter and a real gateway adapter (Razorpay), with scripted Google and Razorpay answers.
 *
 * Start (the Google Play option with user choice billing on), the customer picks the alternative on Google's screen, the
 * gateway option and its hosted page, the return endpoint, completion, the first report queued and then sent to Google, a
 * renewal webhook that queues the renewal report, and a refund that queues the refund report.
 */
import { describe, expect, it } from 'vitest';
import { CheckoutKind, Environment, EventType, HttpMethod, Provider } from '../../src/constants.js';
import { createSubscriptions } from '../../src/client.js';
import { googlePlay } from '../../src/providers/googleplay/index.js';
import { razorpay } from '../../src/providers/razorpay/index.js';
import {
  EntitlementsSchema,
  FlushResultSchema,
  MemoryPurchaseStore,
  PurchaseSessionSchema,
  ReportKind,
  ReportStatus,
  SessionStatus,
  firstTransactionId,
  refundReportId,
  renewalTransactionId,
  type PurchaseStore,
} from '../../src/purchase/index.js';
import { createHandler } from '../../src/server/index.js';
import { SERVICE_PRIVATE_PEM } from '../googleplay/helpers.js';
import { WEBHOOK_REFUND_PROCESSED, WEBHOOK_SUBSCRIPTION_CHARGED } from '../razorpay/one-time-fixtures.js';
import { Clock, hmacHex as hmacOf } from './helpers.js';
import {
  RAZORPAY_KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET,
  orderCallback,
  storeFakes,
  subscriptionCallback,
} from './store-fakes.js';

const API_KEY = 'integration-api-key-0123456789';
const BASE = 'https://billing.example.com';
const APP_RETURN = 'myapp://purchase/done';
const TOKEN = 'external-transaction-token-from-the-device';
const CUSTOMER = { name: 'Asha Rao', email: 'asha@example.com', phone: '9876543210', state: 'Karnataka' };

const MONTHLY = {
  key: 'pro-monthly',
  kind: 'subscription',
  name: 'Pro monthly',
  amount: 49900,
  interval: { unit: 'month', count: 1 },
  taxRateBps: 1800,
  googlePlay: { productId: 'pro', basePlanId: 'monthly' },
} as const;
const COINS = { key: 'coins-100', kind: 'one_time', name: '100 coins', amount: 9900, taxRateBps: 1800, googlePlay: { productId: 'coins_100' } } as const;

function setup(store: PurchaseStore = new MemoryPurchaseStore()) {
  const fakes = storeFakes();
  const clock = new Clock('2026-11-23T10:00:00.000Z');
  const issues: string[] = [];
  const client = createSubscriptions({
    providers: [
      razorpay({ keyId: 'rzp_test_key', keySecret: RAZORPAY_KEY_SECRET, webhookSecret: RAZORPAY_WEBHOOK_SECRET }, { fetch: fakes.fetch, now: clock.now, maxRetries: 0 }),
      googlePlay(
        {
          packageName: 'com.example.app',
          clientEmail: 'billing@example-project.iam.gserviceaccount.com',
          privateKey: SERVICE_PRIVATE_PEM,
          environment: Environment.Test,
          pushAudience: `${BASE}/v1/google_play/webhooks`,
          pushServiceAccountEmail: 'pubsub-push@example-project.iam.gserviceaccount.com',
        },
        { fetch: fakes.fetch, now: clock.now, maxRetries: 0 },
      ),
    ],
    purchases: {
      catalog: [MONTHLY, COINS],
      policy: { android: 'user_choice' },
      store,
      now: clock.now,
      gatewayReturnUrl: (id) => `${BASE}/checkout/${id}/return`,
      hostedCheckoutUrl: (id) => `${BASE}/checkout/${id}`,
      onIssue: (issue) => void issues.push(`${issue.issue}: ${issue.message}`),
    },
  });
  const handler = createHandler({ client, apiKey: API_KEY });
  const call = (method: string, path: string, options: { json?: unknown; form?: Record<string, string>; body?: string; headers?: Record<string, string>; auth?: boolean } = {}) => {
    const headers: Record<string, string> = { ...options.headers };
    if (options.auth !== false) headers.authorization = `Bearer ${API_KEY}`;
    let body = options.body;
    if (options.json !== undefined) {
      body = JSON.stringify(options.json);
      headers['content-type'] = 'application/json';
    }
    if (options.form !== undefined) {
      body = new URLSearchParams(options.form).toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
    }
    return handler(new Request(`${BASE}${path}`, { method, headers, body, redirect: 'manual' }));
  };
  return { fakes, clock, client, call, store, issues };
}

type Harness = ReturnType<typeof setup>;

async function start(t: Harness, product: string, customerRef: string) {
  const started = await t.call(HttpMethod.Post, '/v1/purchases', {
    json: { platform: 'android', product, customer: CUSTOMER, customerRef, returnUrl: APP_RETURN },
  });
  expect(started.status).toBe(201);
  return PurchaseSessionSchema.parse(await started.json());
}

async function startAndChoose(t: Harness, product: string, customerRef: string) {
  const first = await start(t, product, customerRef);
  const chosen = await t.call(HttpMethod.Post, `/v1/purchases/${first.id}/alternative`, { json: { externalTransactionToken: TOKEN } });
  expect(chosen.status).toBe(200);
  return { first, chosen: PurchaseSessionSchema.parse(await chosen.json()) };
}

const flush = async (t: Harness) => FlushResultSchema.parse(await (await t.call(HttpMethod.Post, '/v1/purchases/flush')).json());

describe('Android user choice billing: a subscription', () => {
  it('starts with the Google Play option, adds the gateway option when the customer picks the alternative', async () => {
    const t = setup();
    const first = await start(t, MONTHLY.key, 'cust_1');

    expect(first).toMatchObject({ platform: 'android', policy: 'user_choice', status: SessionStatus.Open });
    expect(first.options).toHaveLength(1);
    expect(first.options[0]).toMatchObject({ channel: 'store', provider: Provider.GooglePlay });
    expect(first.options[0]?.checkout).toMatchObject({
      kind: CheckoutKind.GooglePlayBilling,
      productKind: 'subscription',
      productId: 'pro',
      basePlanId: 'monthly',
      userChoiceBilling: true,
    });
    // Starting creates nothing at a gateway: that is a write, done only when the customer chooses.
    expect(t.fakes.razorpay).toEqual([]);

    const choice = await t.call(HttpMethod.Post, `/v1/purchases/${first.id}/alternative`, { json: { externalTransactionToken: TOKEN } });
    expect(choice.status).toBe(200);
    const chosen = PurchaseSessionSchema.parse(await choice.json());
    expect(chosen.externalTransactionToken).toBe(TOKEN);
    expect(chosen.options.map((option) => [option.channel, option.provider])).toEqual([
      ['store', Provider.GooglePlay],
      ['gateway', Provider.Razorpay],
    ]);
    const gateway = chosen.options[1]!;
    expect(gateway.hostedUrl).toBe(`${BASE}/checkout/${chosen.id}`);
    expect(gateway.handle).toMatch(/^sub_store_/);
    expect(t.fakes.razorpay).toEqual(['POST /v1/plans', 'POST /v1/subscriptions']);

    // Choosing again with the same token is the same option, never a second mandate.
    const again = await t.call(HttpMethod.Post, `/v1/purchases/${chosen.id}/alternative`, { json: { externalTransactionToken: TOKEN } });
    expect(PurchaseSessionSchema.parse(await again.json()).options).toHaveLength(2);
    expect(t.fakes.razorpay).toEqual(['POST /v1/plans', 'POST /v1/subscriptions']);
    // A different token after the option exists is a conflict.
    const other = await t.call(HttpMethod.Post, `/v1/purchases/${chosen.id}/alternative`, { json: { externalTransactionToken: 'another' } });
    expect(other.status).toBe(409);
  });

  it('runs end to end: hosted page, return, completion, the first report, a renewal, then a refund of the first charge is a refund report', async () => {
    const t = setup();
    const { chosen } = await startAndChoose(t, MONTHLY.key, 'cust_1');
    const gateway = chosen.options[1]!;
    const subscriptionId = gateway.handle;

    // The hosted page the Custom Tab opens: Razorpay Standard Checkout, no key needed.
    const page = await t.call(HttpMethod.Get, `/checkout/${chosen.id}`, { auth: false });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain('https://checkout.razorpay.com');
    expect(await page.text()).toContain(subscriptionId);
    expect(gateway.checkout).toMatchObject({ kind: CheckoutKind.RazorpayCheckout, subscriptionId, callbackUrl: `${BASE}/checkout/${chosen.id}/return` });

    // Razorpay posts the result to the return endpoint; the app is sent back to its deep link.
    const back = await t.call(HttpMethod.Post, `/checkout/${chosen.id}/return`, { auth: false, form: subscriptionCallback(subscriptionId) });
    expect(back.status).toBe(303);
    const location = new URL(back.headers.get('location') ?? '');
    expect(`${location.protocol}//${location.host}${location.pathname}`).toBe(APP_RETURN);
    expect(location.searchParams.get('session')).toBe(chosen.id);
    expect(location.searchParams.get('status')).toBe(SessionStatus.Completed);

    const done = PurchaseSessionSchema.parse(await (await t.call(HttpMethod.Get, `/v1/purchases/${chosen.id}`)).json());
    expect(done).toMatchObject({ status: SessionStatus.Completed, provider: Provider.Razorpay, subscriptionId });
    const owned = EntitlementsSchema.parse(await (await t.call(HttpMethod.Get, '/v1/entitlements/cust_1')).json());
    expect(owned).toMatchObject({ active: true });
    expect(owned.items[0]).toMatchObject({ product: MONTHLY.key, kind: 'subscription', provider: Provider.Razorpay, channel: 'gateway', platform: 'android' });

    // The first report is durable before the return endpoint answered; Google has not been told yet.
    const firstId = firstTransactionId(chosen.id);
    const queued = await t.store.getReport(firstId);
    expect(queued).toMatchObject({ kind: ReportKind.Transaction, status: ReportStatus.Queued, sessionId: chosen.id });
    expect(queued?.transaction).toMatchObject({ externalTransactionId: firstId, externalTransactionToken: TOKEN, productKind: 'subscription', amount: 0, taxAmount: 0, state: 'Karnataka' });
    expect(t.fakes.google).toEqual([]);
    expect(new Date(queued!.dueBy).getTime() - new Date(queued!.createdAt).getTime()).toBe(24 * 3_600_000);

    // The flush route sends it to Google: the device token, zero amounts (no charge has moved yet), the customer's state.
    const sent = await flush(t);
    expect(sent).toMatchObject({ sent: 1, retrying: 0, rejected: 0, overdue: [] });
    expect(t.fakes.google).toHaveLength(1);
    expect(t.fakes.google[0]).toMatchObject({ method: 'POST', path: '/applications/com.example.app/externalTransactions', query: { externalTransactionId: firstId } });
    expect(t.fakes.google[0]?.json).toMatchObject({
      originalPreTaxAmount: { currency: 'INR', priceMicros: '0' },
      recurringTransaction: { externalTransactionToken: TOKEN, externalSubscription: { subscriptionType: 'RECURRING' } },
      userTaxAddress: { regionCode: 'IN', administrativeArea: 'KARNATAKA' },
    });
    expect((await t.store.getReport(firstId))?.status).toBe(ReportStatus.Sent);
    // Flushing again sends nothing.
    expect(await flush(t)).toMatchObject({ sent: 0 });
    expect(t.fakes.google).toHaveLength(1);

    // A renewal arrives as Razorpay's `subscription.charged` webhook: it queues the renewal report.
    const renewal = WEBHOOK_SUBSCRIPTION_CHARGED.replaceAll('sub_DEX6xcJ1HSW4CR', subscriptionId)
      .replace('pay_DEXFWroJ6LikKT', 'pay_renewal_one')
      .replace('"amount": 100000,', '"amount": 49900,');
    const charged = await t.call(HttpMethod.Post, '/v1/razorpay/webhooks', {
      auth: false,
      body: renewal,
      headers: { 'x-razorpay-signature': hmacOf(RAZORPAY_WEBHOOK_SECRET, renewal), 'x-razorpay-event-id': 'evt_renewal_1' },
    });
    expect(charged.status).toBe(200);
    expect(await charged.json()).toEqual({ received: 1 });
    const renewalId = renewalTransactionId(chosen.id, 'pay_renewal_one');
    expect(await t.store.getReport(renewalId)).toMatchObject({ kind: ReportKind.Transaction, status: ReportStatus.Queued, dependsOn: firstId });
    // Delivering the same webhook again queues nothing more.
    await t.call(HttpMethod.Post, '/v1/razorpay/webhooks', {
      auth: false,
      body: renewal,
      headers: { 'x-razorpay-signature': hmacOf(RAZORPAY_WEBHOOK_SECRET, renewal), 'x-razorpay-event-id': 'evt_renewal_1' },
    });

    const renewed = await flush(t);
    expect(renewed).toMatchObject({ sent: 1, overdue: [] });
    expect(t.fakes.google).toHaveLength(2);
    expect(t.fakes.google[1]?.query).toEqual({ externalTransactionId: renewalId });
    expect(t.fakes.google[1]?.json).toMatchObject({
      // 499.00 rupees with 18% tax included: 422.88 before tax and 76.12 of tax.
      originalPreTaxAmount: { currency: 'INR', priceMicros: '422880000' },
      originalTaxAmount: { currency: 'INR', priceMicros: '76120000' },
      recurringTransaction: { initialExternalTransactionId: firstId, externalSubscription: { subscriptionType: 'RECURRING' } },
      userTaxAddress: { regionCode: 'IN', administrativeArea: 'KARNATAKA' },
    });
    expect(JSON.stringify(t.fakes.google[1]?.json)).not.toContain(TOKEN);
    expect(t.issues).toEqual([]);
  });

  it('a Google outage leaves the report queued and retried, never lost, and flags it overdue after 24 hours', async () => {
    const t = setup();
    const { chosen } = await startAndChoose(t, MONTHLY.key, 'cust_1');
    await t.call(HttpMethod.Post, `/checkout/${chosen.id}/return`, { auth: false, form: subscriptionCallback(chosen.options[1]!.handle) });
    const firstId = firstTransactionId(chosen.id);

    t.fakes.googleFailures.push(503);
    const failed = await flush(t);
    expect(failed).toMatchObject({ sent: 0, retrying: 1 });
    expect(failed.entries[0]).toMatchObject({ id: firstId, outcome: 'retrying', errorCode: 'OUTCOME_UNKNOWN' });
    expect((await t.store.getReport(firstId))?.status).toBe(ReportStatus.Queued);

    // Within the backoff nothing is attempted; after it, the report goes out.
    expect(await flush(t)).toMatchObject({ sent: 0, retrying: 0 });
    t.clock.advanceHours(1);
    expect(await flush(t)).toMatchObject({ sent: 1 });
    expect((await t.store.getReport(firstId))?.status).toBe(ReportStatus.Sent);

    // A report that stays unsent past its deadline is listed as overdue.
    const second = await startAndChoose(t, COINS.key, 'cust_2');
    await t.call(HttpMethod.Post, `/checkout/${second.chosen.id}/return`, { auth: false, form: orderCallback(second.chosen.options[1]!.handle) });
    t.fakes.googleFailures.push(503, 503);
    t.clock.advanceHours(25);
    const late = await flush(t);
    expect(late.overdue.map((entry) => entry.id)).toEqual([firstTransactionId(second.chosen.id)]);
    expect(late.overdue[0]).toMatchObject({ overdue: true, kind: ReportKind.Transaction });
  });
});

describe('Android user choice billing: a one-time purchase and its refund', () => {
  it('reports the payment with its tax split, and a refund of it as a refund report', async () => {
    const t = setup();
    const { chosen } = await startAndChoose(t, COINS.key, 'cust_9');
    const orderId = chosen.options[1]!.handle;
    expect(orderId).toMatch(/^order_store_/);

    const back = await t.call(HttpMethod.Get, `/checkout/${chosen.id}/return?${new URLSearchParams(orderCallback(orderId))}`, { auth: false });
    expect(back.status).toBe(303);
    expect(new URL(back.headers.get('location') ?? '').searchParams.get('status')).toBe(SessionStatus.Completed);

    const firstId = firstTransactionId(chosen.id);
    expect(await flush(t)).toMatchObject({ sent: 1 });
    expect(t.fakes.google[0]?.query).toEqual({ externalTransactionId: firstId });
    expect(t.fakes.google[0]?.json).toMatchObject({
      // 99.00 rupees with 18% tax included.
      originalPreTaxAmount: { currency: 'INR', priceMicros: '83900000' },
      originalTaxAmount: { currency: 'INR', priceMicros: '15100000' },
      oneTimeTransaction: { externalTransactionToken: TOKEN },
    });

    // Razorpay's `refund.processed` webhook for the whole payment.
    const refund = WEBHOOK_REFUND_PROCESSED.replaceAll('order_FPoIeimWki9j8A', orderId)
      .replace('"amount": 50000,', '"amount": 9900,')
      .replace('"amount": 500000,', '"amount": 9900,')
      .replace('"amount_refunded": 190000', '"amount_refunded": 9900')
      .replace('"refund_status": "partial"', '"refund_status": "full"');
    const hook = await t.call(HttpMethod.Post, '/v1/razorpay/webhooks', {
      auth: false,
      body: refund,
      headers: { 'x-razorpay-signature': hmacOf(RAZORPAY_WEBHOOK_SECRET, refund), 'x-razorpay-event-id': 'evt_refund_1' },
    });
    expect(hook.status).toBe(200);
    const reportId = refundReportId(chosen.id, 'rfnd_FS8TWyPrCsa0OB');
    expect(await t.store.getReport(reportId)).toMatchObject({ kind: ReportKind.Refund, status: ReportStatus.Queued, dependsOn: firstId });
    const entitlements = EntitlementsSchema.parse(await (await t.call(HttpMethod.Get, '/v1/entitlements/cust_9')).json());
    expect(entitlements).toMatchObject({ active: false });
    expect(entitlements.items[0]?.status).toBe('refunded');

    expect(await flush(t)).toMatchObject({ sent: 1 });
    const sent = t.fakes.google[1]!;
    expect(sent.method).toBe('POST');
    expect(sent.path).toBe(`/applications/com.example.app/externalTransactions/${firstId}:refund`);
    // A full refund names no amounts.
    expect(sent.json).toMatchObject({ fullRefund: {} });
    expect(sent.json).not.toHaveProperty('partialRefund');
    expect(t.issues).toEqual([]);
  });
});

describe('the report queue survives a restart', () => {
  it('a report queued before the process died is sent by the next one', async () => {
    const { FilePurchaseStore } = await import('../../src/purchase-file-store.js');
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'india-subscriptions-android-'));
    try {
      const path = join(dir, 'purchases.json');
      const before = setup(await FilePurchaseStore.open(path));
      const { chosen } = await startAndChoose(before, MONTHLY.key, 'cust_1');
      await before.call(HttpMethod.Post, `/checkout/${chosen.id}/return`, { auth: false, form: subscriptionCallback(chosen.options[1]!.handle) });
      expect(before.fakes.google).toEqual([]);
      // No flush, no close: the process "dies" here.

      const after = setup(await FilePurchaseStore.open(path));
      expect(await after.store.getReport(firstTransactionId(chosen.id))).toMatchObject({ status: ReportStatus.Queued });
      expect(await flush(after)).toMatchObject({ sent: 1 });
      expect(after.fakes.google).toHaveLength(1);
      expect(EventType.SubscriptionCharged).toBe('subscription.charged');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
