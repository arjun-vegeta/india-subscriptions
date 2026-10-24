/**
 * The documentation's main flows, EXECUTED: the samples are cut out of the Markdown, run with the real library behind
 * `india-subscriptions`, and driven with scripted gateway responses (test/helpers/mock-fetch.ts). Only the web framework is
 * faked (Express), because it is not installed; Next.js route handlers use the standard Request and Response and run as they are.
 */
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Main from '../../src/index.js';
import * as Checkout from '../../src/checkout/index.js';
import * as Server from '../../src/server-entry.js';
import { ErrorCode, HttpMethod, Provider } from '../../src/constants.js';
import { signEventsBody } from '../../src/events-webhook.js';
import { RazorpayEndpoint } from '../../src/providers/razorpay/constants.js';
import { mockFetch, type MockRoute } from '../helpers/mock-fetch.js';
import { SERVICE_PRIVATE_PEM } from '../googleplay/helpers.js';
import { REFUND_CREATED, ORDER_CREATED } from '../razorpay/one-time-fixtures.js';
import { RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET as STORE_WEBHOOK_SECRET, orderCallback, storeFakes, subscriptionCallback } from '../integration/store-fakes.js';
import { SampleLoader, fakeExpress, type FakeExpress } from './fakes.js';
import { PLAN, REFUND, SUBSCRIPTION } from './fixtures.js';
import { ROOT, allBlocks, type Block } from './lib.js';

const KEY_SECRET = 'docs_key_secret';
const WEBHOOK_SECRET = 'docs_webhook_secret';
const RZP = 'https://api.razorpay.com';
const executed: string[] = [];

function block(page: string, needle: string): Block {
  const found = allBlocks().find((candidate) => candidate.page === page && candidate.code.includes(needle));
  if (!found) throw new Error(`no code block in ${page} contains ${needle}`);
  return found;
}

/** Every titled `ts` block of the documentation, by title, plus extra sources. */
function projectFiles(extra: Record<string, string> = {}): Map<string, string> {
  const files = new Map<string, string>();
  for (const candidate of allBlocks()) {
    if (candidate.lang === 'ts' && typeof candidate.attrs.title === 'string') files.set(candidate.attrs.title, candidate.code);
  }
  for (const [name, source] of Object.entries(extra)) files.set(name, source);
  return files;
}

function loader(files: Map<string, string>): { loader: SampleLoader; express: FakeExpress } {
  const express = fakeExpress();
  return {
    express,
    loader: new SampleLoader(files, {
      'india-subscriptions': Main,
      'india-subscriptions/checkout': Checkout,
      'india-subscriptions/server': Server,
      express: { default: express, __esModule: true },
    }),
  };
}

const originalFetch = globalThis.fetch;
const logs: string[] = [];

function install(routes: MockRoute[]) {
  const mock = mockFetch(routes);
  globalThis.fetch = mock.fetch as unknown as typeof fetch;
  return mock;
}

beforeEach(() => {
  process.env.RAZORPAY_KEY_ID = 'rzp_test_docs';
  process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
  process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.RAZORPAY_PLAN_ID = PLAN.id;
  logs.length = 0;
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void logs.push(args.join(' ')));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

afterAll(() => {
  // eslint-disable-next-line no-console
  process.stdout.write(`documentation flows executed: ${executed.length} (${executed.join(', ')})\n`);
});

const createRoutes: MockRoute[] = [
  { method: HttpMethod.Get, url: `${RZP}${RazorpayEndpoint.plan(PLAN.id)}`, json: PLAN },
  { method: HttpMethod.Post, url: `${RZP}/v1/subscriptions`, json: SUBSCRIPTION },
];

function signedCheckout(subscriptionId: string, secret = KEY_SECRET): Record<string, string> {
  const paymentId = 'pay_00000000000001';
  return {
    razorpay_payment_id: paymentId,
    razorpay_subscription_id: subscriptionId,
    razorpay_signature: createHmac('sha256', secret).update(`${paymentId}|${subscriptionId}`).digest('hex'),
  };
}

function chargedWebhook(eventId: string, secret = WEBHOOK_SECRET) {
  const rawBody = JSON.stringify({
    entity: 'event',
    event: 'subscription.charged',
    contains: ['subscription', 'payment'],
    payload: {
      subscription: { entity: { ...SUBSCRIPTION, status: 'active', paid_count: 1, remaining_count: 119 } },
      payment: {
        entity: { id: 'pay_00000000000001', entity: 'payment', amount: 49900, currency: 'INR', status: 'captured', method: 'upi', created_at: 1580280581 },
      },
    },
    created_at: 1580280600,
  });
  return {
    rawBody,
    headers: {
      'x-razorpay-signature': createHmac('sha256', secret).update(rawBody).digest('hex'),
      'x-razorpay-event-id': eventId,
    },
  };
}

function expectedStartAt(): number {
  return Math.floor(Date.now() / 1000) + 14 * 24 * 60 * 60;
}

describe('Your first subscription, Express (executed)', () => {
  it('creates, verifies and handles a webhook through the page\'s own code', async () => {
    const { calls } = install([
      ...createRoutes,
      { method: HttpMethod.Get, url: `${RZP}/v1/subscriptions/sub_other`, json: { ...SUBSCRIPTION, id: 'sub_other', notes: {} } },
    ]);
    const { loader: sampleLoader, express } = loader(projectFiles());
    sampleLoader.load('server.ts');
    const app = express.apps[0];
    expect(app).toBeDefined();
    if (!app) return;
    const user = { 'x-user-id': 'u_1' };

    // 1. no session, no subscription
    expect((await app.dispatch('POST', '/api/subscriptions', { body: '{}' })).statusCode).toBe(401);

    // 2. create: 14-day trial, the plan id from the environment, the customer from the stored user
    const created = await app.dispatch('POST', '/api/subscriptions', { body: '{}', headers: user });
    expect(created.statusCode).toBe(201);
    expect(created.body).toMatchObject({ checkout: { kind: 'razorpay_checkout', subscriptionId: SUBSCRIPTION.id, keyId: 'rzp_test_docs' } });
    const sent = calls.find((call) => call.url === `${RZP}/v1/subscriptions`)?.json as { start_at: number; plan_id: string };
    expect(sent.plan_id).toBe(PLAN.id);
    expect(Math.abs(sent.start_at - expectedStartAt())).toBeLessThan(60);

    // 3. verify: the genuine result passes; a forged signature and a result for another subscription are refused
    const verify = (result: unknown) =>
      app.dispatch('POST', '/api/subscriptions/verify', { body: JSON.stringify(result), headers: user });
    expect((await verify(signedCheckout(SUBSCRIPTION.id))).body).toEqual({ authorized: true });
    expect((await verify(signedCheckout(SUBSCRIPTION.id, 'wrong_secret'))).statusCode).toBe(400);
    expect((await verify(signedCheckout('sub_other'))).statusCode).toBe(400);

    // 4. webhook: raw body, verified, de-duplicated
    const hook = chargedWebhook('evt_1');
    const deliver = (input: { rawBody: string; headers: Record<string, string> }) =>
      app.dispatch('POST', '/webhooks/razorpay', { body: input.rawBody, headers: input.headers });
    expect((await deliver(hook)).statusCode).toBe(200);
    expect((await deliver(hook)).statusCode).toBe(200);
    expect(logs.filter((line) => line === 'access on for u_1')).toHaveLength(1);
    expect((await deliver(chargedWebhook('evt_2', 'wrong'))).statusCode).toBe(401);
    executed.push('first-subscription-express');
  });
});

describe('Your first subscription, Next.js route handlers (executed)', () => {
  it('creates, verifies and handles a webhook with real Request and Response objects', async () => {
    const { calls } = install([
      ...createRoutes,
      { method: HttpMethod.Get, url: `${RZP}/v1/subscriptions/sub_other`, json: { ...SUBSCRIPTION, id: 'sub_other', notes: {} } },
    ]);
    const { loader: sampleLoader } = loader(projectFiles());
    const create = sampleLoader.load('app/api/subscriptions/route.ts') as { POST: (request: Request) => Promise<Response> };
    const verify = sampleLoader.load('app/api/subscriptions/verify/route.ts') as { POST: (request: Request) => Promise<Response> };
    const webhook = sampleLoader.load('app/api/webhooks/razorpay/route.ts') as { POST: (request: Request) => Promise<Response> };
    const post = (handler: { POST: (request: Request) => Promise<Response> }, body: string, headers: Record<string, string> = {}) =>
      handler.POST(new Request('https://app.example.com/x', { method: 'POST', body, headers }));
    const user = { 'x-user-id': 'u_1' };

    expect((await post(create, '{}')).status).toBe(401);
    const created = await post(create, '{}', user);
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ checkout: { kind: 'razorpay_checkout', subscriptionId: SUBSCRIPTION.id } });
    const sent = calls.find((call) => call.url === `${RZP}/v1/subscriptions`)?.json as { start_at: number };
    expect(Math.abs(sent.start_at - expectedStartAt())).toBeLessThan(60);

    const ok = await post(verify, JSON.stringify(signedCheckout(SUBSCRIPTION.id)), user);
    expect(await ok.json()).toEqual({ authorized: true });
    expect((await post(verify, JSON.stringify(signedCheckout(SUBSCRIPTION.id, 'wrong_secret')), user)).status).toBe(400);
    expect((await post(verify, JSON.stringify(signedCheckout('sub_other')), user)).status).toBe(400);

    const hook = chargedWebhook('evt_1');
    expect((await post(webhook, hook.rawBody, hook.headers)).status).toBe(200);
    expect((await post(webhook, hook.rawBody, hook.headers)).status).toBe(200);
    expect(logs.filter((line) => line === 'access on for u_1')).toHaveLength(1);
    const forged = chargedWebhook('evt_3', 'wrong');
    expect((await post(webhook, forged.rawBody, forged.headers)).status).toBe(401);
    executed.push('first-subscription-nextjs');
  });
});

describe('Managing subscriptions (executed)', () => {
  it('pauses, resumes, updates, lists, refunds and cancels with scripted Razorpay answers', async () => {
    const active = { ...SUBSCRIPTION, status: 'active' };
    const sub = `${RZP}${RazorpayEndpoint.subscription(SUBSCRIPTION.id)}`;
    const { calls } = install([
      { method: HttpMethod.Get, url: sub, json: active },
      { method: HttpMethod.Post, url: `${RZP}${RazorpayEndpoint.pauseSubscription(SUBSCRIPTION.id)}`, json: { ...active, status: 'paused' } },
      { method: HttpMethod.Post, url: `${RZP}${RazorpayEndpoint.resumeSubscription(SUBSCRIPTION.id)}`, json: active },
      { method: HttpMethod.Patch, url: sub, json: active },
      { method: HttpMethod.Get, url: new RegExp(`${RZP}/v1/invoices\\?`), json: { entity: 'collection', count: 0, items: [] } },
      { method: HttpMethod.Post, url: `${RZP}${RazorpayEndpoint.refundPayment('pay_00000000000001')}`, json: REFUND },
      { method: HttpMethod.Post, url: `${RZP}${RazorpayEndpoint.cancelSubscription(SUBSCRIPTION.id)}`, json: { ...active, status: 'cancelled' } },
    ]);
    const page = 'docs/guides/managing-subscriptions.md';
    const files = projectFiles({ 'managing.ts': block(page, 'export async function manage').code });
    const { loader: sampleLoader } = loader(files);
    const { manage } = sampleLoader.load('managing.ts') as { manage: (id: string, paymentId: string) => Promise<{ charges: number; status: string }> };
    const result = await manage(SUBSCRIPTION.id, 'pay_00000000000001');
    expect(result).toEqual({ charges: 0, status: 'cancelled' });
    const update = calls.find((call) => call.method === 'PATCH')?.json as { plan_id: string; schedule_change_at: string };
    expect(update).toMatchObject({ plan_id: 'plan_new', schedule_change_at: 'cycle_end' });
    expect(calls.find((call) => call.url.includes('/cancel'))?.json).toEqual({ cancel_at_cycle_end: true });
    expect(calls.find((call) => call.url.includes('/refund'))?.json).toMatchObject({ amount: 5000, receipt: 'refund_1' });
    executed.push('managing-subscriptions');
  });
});

describe('Testing your integration (executed)', () => {
  it('runs the fake-fetch and the simulated-webhook samples', async () => {
    const page = 'docs/guides/testing.md';
    const files = new Map<string, string>([
      ['fake.ts', block(page, 'export async function trialSubscription').code],
      ['hook.ts', block(page, 'export async function simulateCharged').code],
    ]);
    const { loader: sampleLoader } = loader(files);
    const { trialSubscription } = sampleLoader.load('fake.ts') as { trialSubscription: () => Promise<{ id: string; status: string; checkout?: { kind: string } }> };
    const created = await trialSubscription();
    expect(created).toMatchObject({ id: 'sub_00000000000001', status: 'created', checkout: { kind: 'razorpay_checkout' } });
    const { simulateCharged } = sampleLoader.load('hook.ts') as { simulateCharged: (body: object) => Promise<string | undefined> };
    expect(await simulateCharged({ ...SUBSCRIPTION, status: 'active' })).toBe('evt_1');
    executed.push('testing-guide');
  });
});

describe('Running the scheduler (executed)', () => {
  it('builds the PayU client with its own scheduler and ticks with nothing due', async () => {
    process.env.PAYU_KEY = 'docs_key';
    process.env.PAYU_SALT = 'docs_salt';
    const { calls } = install([]);
    const files = projectFiles({ 'tick.ts': block('docs/guides/scheduler.md', 'export async function runTick').code });
    const { loader: sampleLoader } = loader(files);
    const { runTick } = sampleLoader.load('tick.ts') as { runTick: () => Promise<void> };
    await runTick();
    expect(logs.some((line) => line.startsWith('due=0'))).toBe(true);
    expect(calls).toHaveLength(0);
    executed.push('scheduler-tick');
  });
});

describe('The events webhook signature (executed)', () => {
  const secret = 'docs_events_secret';
  const body = JSON.stringify({
    kind: 'gateway',
    provider: 'razorpay',
    events: [{ id: 'evt_1', provider: 'razorpay', type: 'subscription.charged', providerEventType: 'subscription.charged' }],
  });
  const now = 1_767_225_600;
  const timestamp = String(now);
  const signature = signEventsBody(secret, timestamp, body);
  const cases = [
    { name: 'valid', body, timestamp, signature, now, ok: true, message: '' },
    { name: 'tampered body', body: body.replace('evt_1', 'evt_2'), timestamp, signature, now, ok: false, message: 'bad signature' },
    { name: 'stale timestamp', body, timestamp, signature, now: now + 301, ok: false, message: 'tolerance' },
    { name: 'future timestamp', body, timestamp, signature, now: now - 301, ok: false, message: 'tolerance' },
    { name: 'no timestamp', body, timestamp: '', signature, now, ok: false, message: 'timestamp' },
  ];

  it('TypeScript: verifyEventsSignature and EventsDeliverySchema', () => {
    process.env.EVENTS_WEBHOOK_SECRET = secret;
    const { loader: sampleLoader } = loader(new Map([['events.ts', block('docs/getting-started/any-language.md', 'export function receiveEvents').code]]));
    const { receiveEvents } = sampleLoader.load('events.ts') as { receiveEvents: (raw: string, headers: Record<string, string>) => { kind: string } };
    const headers = { 'x-india-subscriptions-timestamp': String(Math.floor(Date.now() / 1000)), 'x-india-subscriptions-signature': '' };
    headers['x-india-subscriptions-signature'] = signEventsBody(secret, headers['x-india-subscriptions-timestamp'], body);
    expect(receiveEvents(body, headers).kind).toBe('gateway');
    expect(() => receiveEvents(body.replace('evt_1', 'evt_2'), headers)).toThrowError(expect.objectContaining({ code: ErrorCode.SignatureInvalid }));
    executed.push('events-signature-typescript');
  });

  const python = spawnSync('python3', ['--version']).status === 0;
  it.skipIf(!python)('Python: the standard-library sample agrees with the TypeScript signature', () => {
    const directory = mkdtempSync(join(tmpdir(), 'docs-flow-py-'));
    try {
      const sample = join(directory, 'sample.py');
      writeFileSync(sample, block('docs/getting-started/any-language.md', 'def verify_events_signature').code);
      for (const testCase of cases) {
        const input = JSON.stringify({
          secret,
          body: testCase.body,
          headers: { 'x-india-subscriptions-timestamp': testCase.timestamp, 'x-india-subscriptions-signature': testCase.signature },
          now: testCase.now,
        });
        const run = spawnSync('python3', [join(ROOT, 'test/docs/run_python_verify.py'), sample], { input, encoding: 'utf8' });
        const out = run.stdout.trim();
        expect(testCase.ok ? out : out.startsWith('ERROR:') && out.includes(testCase.message) ? 'refused' : out, `${testCase.name}: ${out} ${run.stderr}`).toBe(testCase.ok ? 'OK' : 'refused');
      }
      executed.push('events-signature-python');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  const go = spawnSync('go', ['version']).status === 0;
  it.skipIf(!go)('Go: the sample agrees with the TypeScript signature', () => {
    const directory = mkdtempSync(join(tmpdir(), 'docs-flow-go-'));
    try {
      writeFileSync(join(directory, 'go.mod'), 'module docssample\n\ngo 1.20\n');
      writeFileSync(join(directory, 'sample.go'), block('docs/getting-started/any-language.md', 'func VerifyEventsSignature').code);
      copyFileSync(join(ROOT, 'test/docs/run_go_verify.go.txt'), join(directory, 'driver.go'));
      for (const testCase of cases) {
        const input = JSON.stringify({ secret, body: testCase.body, timestamp: testCase.timestamp, signature: testCase.signature, now: testCase.now });
        const run = spawnSync('go', ['run', '.'], { cwd: directory, input, encoding: 'utf8', timeout: 120_000 });
        const out = run.stdout.trim();
        expect(testCase.ok ? out : out.startsWith('ERROR:') && out.includes(testCase.message) ? 'refused' : out, `${testCase.name}: ${out} ${run.stderr}`).toBe(testCase.ok ? 'OK' : 'refused');
      }
      executed.push('events-signature-go');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 240_000);
  it('has an events signature sample in each language', () => {
    expect(existsSync(join(ROOT, 'test/docs/run_go_verify.go.txt'))).toBe(true);
  });
});

describe('The curl commands (executed against the real request handler)', () => {
  it('reach real routes, with bodies the service accepts', async () => {
    const mock = install([
      { method: HttpMethod.Post, url: `${RZP}/v1/plans`, json: PLAN },
      { method: HttpMethod.Post, url: `${RZP}/v1/subscriptions`, json: SUBSCRIPTION },
      { method: HttpMethod.Post, url: `${RZP}/v1/orders`, json: JSON.parse(ORDER_CREATED) },
    ]);
    const key = 'docs_service_api_key_value';
    const subs = Main.createSubscriptions({
      providers: [Main.razorpay({ keyId: 'rzp_test_docs', keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET }, { fetch: mock.fetch })],
      purchases: {
        catalog: [{ key: 'ebook', kind: Main.ProductKind.OneTime, name: 'E-book', amount: 49900 }],
        store: new Main.MemoryPurchaseStore(),
      },
    });
    const handler = Server.createHandler({ client: subs, apiKey: key });
    const curls = allBlocks().filter((candidate) => candidate.lang === 'bash' && candidate.code.trim().startsWith('curl'));
    expect(curls.length).toBeGreaterThanOrEqual(6);
    for (const curl of curls) {
      const command = curl.code.replace(/\\\n\s*/g, ' ');
      const url = /(https?:\/\/[^\s"']+)/.exec(command)?.[1] ?? '';
      const data = /-d '([^']*)'/.exec(command)?.[1];
      const method = /-X (\w+)/.exec(command)?.[1] ?? (data === undefined ? 'GET' : 'POST');
      const headers: Record<string, string> = {};
      if (command.includes('Authorization: Bearer $INDIA_SUBSCRIPTIONS_API_KEY')) headers.authorization = `Bearer ${key}`;
      if (data !== undefined) headers['content-type'] = 'application/json';
      const response = await handler(new Request(url.replace('http://127.0.0.1:8787', 'http://localhost'), { method, headers, ...(data === undefined ? {} : { body: data }) }));
      const text = await response.text();
      const where = `${curl.page}:${curl.line} ${method} ${url} -> ${response.status} ${text.slice(0, 200)}`;
      expect([400, 404, 405, 413], where).not.toContain(response.status);
      if (response.status === 401) expect(JSON.parse(text).error.code, where).toBe(ErrorCode.SignatureInvalid);
      if (url.endsWith('/subscriptions')) {
        expect(response.status, where).toBe(201);
        expect(JSON.parse(text)).toMatchObject({ provider: Provider.Razorpay, checkout: { kind: 'razorpay_checkout' } });
      }
      if (url.endsWith('/routing/decide')) {
        expect(response.status, where).toBe(200);
        expect(JSON.parse(text)).toMatchObject({ provider: Provider.Razorpay, ranked: [Provider.Razorpay] });
      }
      if (url.endsWith('/v1/purchases')) {
        expect(response.status, where).toBe(201);
        expect(JSON.parse(text)).toMatchObject({ platform: 'web', product: 'ebook', policy: 'gateways', customerRef: 'user_42', status: 'open' });
      }
      if (url.endsWith('/entitlements/user_42')) {
        expect(response.status, where).toBe(200);
        expect(JSON.parse(text)).toEqual({ customerRef: 'user_42', active: false, items: [] });
      }
    }
    executed.push('curl-commands');
  });
});

describe('The gateway configuration samples (executed)', () => {
  it('build real providers; the scheduler-driven gateways report pause and resume through the facade', () => {
    process.env.PHONEPE_CLIENT_ID = 'cid';
    process.env.PHONEPE_CLIENT_SECRET = 'secret';
    process.env.PHONEPE_CLIENT_VERSION = '1';
    process.env.PAYTM_MID = 'dummymid';
    process.env.PAYTM_MERCHANT_KEY = '0123456789abcdef';
    process.env.PAYU_KEY = 'k';
    process.env.PAYU_SALT = 's';
    process.env.CASHFREE_CLIENT_ID = 'id';
    process.env.CASHFREE_CLIENT_SECRET = 'secret';
    const cases: Array<[string, string, string]> = [
      ['docs/gateways/phonepe.md', 'phonepe(', 'phonepe'],
      ['docs/gateways/paytm.md', 'paytm(', 'paytm'],
    ];
    for (const [page, needle, name] of cases) {
      const { loader: sampleLoader } = loader(new Map([['config.ts', block(page, needle).code]]));
      const { subs } = sampleLoader.load('config.ts') as { subs: Main.Subscriptions };
      expect(subs.providers).toEqual([name]);
      const effective = subs.capabilities(name as Main.Provider);
      expect(effective.pause && effective.resume, `${name}: pause and resume come from the scheduler`).toBe(true);
      expect(effective.merchantCharges).toBe(true);
    }
    for (const page of ['razorpay', 'cashfree', 'payu']) {
      const { loader: sampleLoader } = loader(new Map([['config.ts', block(`docs/gateways/${page}.md`, 'export const gateway').code]]));
      const { gateway } = sampleLoader.load('config.ts') as { gateway: { name: string } };
      expect(gateway.name).toBe(page);
    }
    executed.push('gateway-configuration');
  });
});


// ---------------------------------------------------------------------------
// One-time payments, routing and purchases
// ---------------------------------------------------------------------------

/** Environment for the guides' samples, which read their keys the way a deployment does. */
function purchaseEnvironment(): void {
  process.env.RAZORPAY_KEY_ID = 'rzp_test_docs';
  process.env.RAZORPAY_KEY_SECRET = RAZORPAY_KEY_SECRET;
  process.env.RAZORPAY_WEBHOOK_SECRET = STORE_WEBHOOK_SECRET;
  process.env.CASHFREE_CLIENT_ID = 'cf_id';
  process.env.CASHFREE_CLIENT_SECRET = 'cf_secret';
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  process.env.APP_STORE_ISSUER_ID = 'issuer';
  process.env.APP_STORE_KEY_ID = 'KEYID';
  process.env.APP_STORE_PRIVATE_KEY = ec;
  process.env.GOOGLE_PLAY_CLIENT_EMAIL = 'billing@example-project.iam.gserviceaccount.com';
  process.env.GOOGLE_PLAY_PRIVATE_KEY = SERVICE_PRIVATE_PEM;
}

describe('One-time payments (executed)', () => {
  it('creates an order, verifies a result against the stored id, reads the payment and refunds part of it', async () => {
    purchaseEnvironment();
    const fakes = storeFakes();
    const refundCalls: string[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (new URL(url).pathname.endsWith('/refund')) {
        refundCalls.push(String(init?.body));
        return new Response(REFUND_CREATED, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return fakes.fetch(url, init);
    }) as typeof fetch;
    const { loader: sampleLoader } = loader(projectFiles());
    const { startPayment } = sampleLoader.load('payments-create.ts') as {
      startPayment: (order: string, amount: number, customer: Main.Customer) => Promise<{ paymentId: string; checkout?: { kind: string } }>;
    };
    const { confirmPayment } = sampleLoader.load('payments-verify.ts') as {
      confirmPayment: (provider: Main.Provider, stored: string, result: Record<string, string>) => Promise<boolean>;
    };
    const { refundPartOfPayment } = sampleLoader.load('payments-refund.ts') as { refundPartOfPayment: (paymentId: string) => Promise<string> };

    const customer = { name: 'Asha Rao', email: 'asha@example.com', phone: '9876543210' };
    const created = await startPayment('order-1001', 49900, customer);
    expect(created.checkout).toMatchObject({ kind: 'razorpay_checkout', orderId: created.paymentId, amount: 49900 });

    expect(await confirmPayment(Provider.Razorpay, created.paymentId, orderCallback(created.paymentId))).toBe(true);
    // A genuine result for another order is refused, like a forged one.
    const other = await startPayment('order-1002', 49900, customer);
    expect(await confirmPayment(Provider.Razorpay, created.paymentId, orderCallback(other.paymentId))).toBe(false);
    expect(await confirmPayment(Provider.Razorpay, created.paymentId, { ...orderCallback(created.paymentId), razorpay_signature: 'forged' })).toBe(false);

    expect(await refundPartOfPayment(created.paymentId)).toBeDefined();
    expect(JSON.parse(refundCalls[0] as string)).toMatchObject({ amount: 10000 });
    executed.push('one-time-payments');
  });
});

describe('Routing (executed)', () => {
  it('reads a decision, and routes around a gateway whose circuit is open', async () => {
    purchaseEnvironment();
    const { loader: sampleLoader } = loader(projectFiles());
    const { chooseForSubscription } = sampleLoader.load('routing-decide.ts') as { chooseForSubscription: (amount: number) => Promise<string> };
    expect(await chooseForSubscription(49900)).toBe(Provider.Razorpay);

    const { explain } = sampleLoader.load('routing-explain.ts') as { explain: (amount: number) => Promise<string[]> };
    const lines = await explain(49900);
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.includes('score'))).toBe(true);

    const { canSell } = sampleLoader.load('routing-no-route.ts') as { canSell: (amount: number) => Promise<boolean> };
    expect(await canSell(49900)).toBe(true);
    // Cashfree is limited to Rs 15,000 a debit in the sample strategy; Razorpay has no limit, so there is still a route.
    expect(await canSell(5_000_000)).toBe(true);

    const { decideAfterAnOutage } = sampleLoader.load('routing-test.ts') as { decideAfterAnOutage: () => Promise<string> };
    expect(await decideAfterAnOutage()).toBe(Provider.Cashfree);
    executed.push('routing');
  });
});

describe('Purchase sessions (executed)', () => {
  const TOKEN = 'external-transaction-token-from-the-device';
  const customer = { name: 'Asha Rao', email: 'asha@example.com', phone: '9876543210', state: 'Karnataka' };

  it('starts a purchase on an iPhone without calling Apple', async () => {
    const { loader: sampleLoader } = loader(projectFiles());
    const { startOnAnIphone } = sampleLoader.load('purchases-test.ts') as { startOnAnIphone: () => Promise<string | undefined> };
    expect(await startOnAnIphone()).toBe('apple_storekit');
    executed.push('purchase-iphone-start');
  });

  it('runs an Android user choice purchase end to end through the guide\'s own code', async () => {
    purchaseEnvironment();
    const fakes = storeFakes();
    globalThis.fetch = fakes.fetch as unknown as typeof fetch;
    const { loader: sampleLoader } = loader(projectFiles());
    const start = sampleLoader.load('purchases-start.ts') as {
      startPurchase: (platform: string, product: string, customerRef: string, customer: Main.Customer) => Promise<Main.PurchaseSession>;
    };
    const alternative = sampleLoader.load('purchases-alternative.ts') as {
      customerPickedTheAlternative: (sessionId: string, token: string) => Promise<string | undefined>;
    };
    const complete = sampleLoader.load('purchases-complete.ts') as {
      completePurchase: (sessionId: string, provider: Main.Provider, result: Record<string, string>) => Promise<{ status: string; subscriptionId?: string }>;
    };
    const entitlements = sampleLoader.load('purchases-entitlements.ts') as { hasAccess: (customerRef: string, product: string) => Promise<boolean> };
    const flush = sampleLoader.load('purchases-flush.ts') as { sendReports: () => Promise<void> };

    const session = await start.startPurchase(Main.Platform.Android, 'pro-monthly', 'cust_1', customer);
    expect(session).toMatchObject({ policy: 'user_choice', status: 'open' });
    expect(session.options[0]).toMatchObject({ channel: 'store', provider: Provider.GooglePlay, checkout: { userChoiceBilling: true } });
    expect(fakes.razorpay).toEqual([]);

    const hostedUrl = await alternative.customerPickedTheAlternative(session.id, TOKEN);
    expect(hostedUrl).toBe(`https://billing.example.com/checkout/${session.id}`);
    expect(fakes.razorpay).toEqual(['POST /v1/plans', 'POST /v1/subscriptions']);
    const chosen = await (sampleLoader.load('billing-purchases.ts') as { purchasesOf: () => Main.Purchases }).purchasesOf().get(session.id);
    const gateway = chosen.options.find((option) => option.channel === 'gateway');
    expect(gateway?.provider).toBe(Provider.Razorpay);

    const done = await complete.completePurchase(session.id, Provider.Razorpay, subscriptionCallback(gateway?.handle as string));
    expect(done.status).toBe('completed');
    expect(await entitlements.hasAccess('cust_1', 'pro-monthly')).toBe(true);
    expect(await entitlements.hasAccess('cust_1', 'coins-100')).toBe(false);

    // One product, once: a second start of the same product is refused.
    await expect(start.startPurchase(Main.Platform.Web, 'pro-monthly', 'cust_1', customer)).rejects.toMatchObject({ code: ErrorCode.Conflict });

    expect(fakes.google).toEqual([]);
    await flush.sendReports();
    expect(fakes.google).toHaveLength(1);
    expect(fakes.google[0]?.json).toMatchObject({
      recurringTransaction: { externalTransactionToken: TOKEN },
      userTaxAddress: { regionCode: 'IN', administrativeArea: 'KARNATAKA' },
    });
    expect(logs.some((line) => line.startsWith('sent 1'))).toBe(true);
    executed.push('purchase-android-user-choice');
  });

  it('forwards the five calls from a mobile backend, forcing the customer and refusing other users\' sessions', async () => {
    purchaseEnvironment();
    process.env.BILLING_SERVICE_URL = 'http://billing.test';
    process.env.INDIA_SUBSCRIPTIONS_API_KEY = 'docs_mobile_api_key_value';
    const fakes = storeFakes();
    const { loader: sampleLoader } = loader(projectFiles());
    const { purchasesOf, subs } = sampleLoader.load('billing-purchases.ts') as { purchasesOf: () => Main.Purchases; subs: Main.Subscriptions };
    expect(purchasesOf()).toBe(subs.purchases);
    const handler = Server.createHandler({ client: subs, apiKey: 'docs_mobile_api_key_value' });
    globalThis.fetch = (async (url: string, init?: RequestInit) =>
      url.startsWith('http://billing.test') ? handler(new Request(url, init)) : fakes.fetch(url, init)) as typeof fetch;
    const { handleBillingRequest } = sampleLoader.load('mobile-backend.ts') as { handleBillingRequest: (request: Request, userId: string) => Promise<Response> };
    const call = (method: string, path: string, user: string, body?: unknown) =>
      handleBillingRequest(new Request(`https://api.example.com/billing${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), user);

    const started = await call('POST', '/v1/purchases', 'user_7', { platform: 'ios', product: 'pro-monthly', customer: { email: 'a@example.com' }, customerRef: 'someone_else' });
    expect(started.status).toBe(201);
    const session = (await started.json()) as Main.PurchaseSession;
    expect(session).toMatchObject({ customerRef: 'user_7', policy: 'store' });
    expect(session.options[0]?.checkout).toMatchObject({ kind: 'apple_storekit' });

    expect((await call('GET', `/v1/purchases/${session.id}`, 'user_7')).status).toBe(200);
    expect((await call('GET', `/v1/purchases/${session.id}`, 'user_8')).status).toBe(404);
    expect((await call('POST', `/v1/purchases/${session.id}/complete`, 'user_8', { provider: 'app_store', result: {} })).status).toBe(404);
    expect(await (await call('GET', '/v1/entitlements/user_7', 'user_7')).json()).toEqual({ customerRef: 'user_7', active: false, items: [] });
    expect((await call('GET', '/v1/entitlements/user_7', 'user_8')).status).toBe(404);
    executed.push('mobile-backend');
  });
});
