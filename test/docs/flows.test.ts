/**
 * The documentation's main flows, EXECUTED: the samples are cut out of the Markdown, run with the real library behind
 * `india-subscriptions`, and driven with scripted gateway responses (test/helpers/mock-fetch.ts). Only the web framework is
 * faked (Express), because it is not installed; Next.js route handlers use the standard Request and Response and run as they are.
 */
import { createHmac } from 'node:crypto';
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
      ['hook.ts', block(page, 'export function simulateCharged').code],
    ]);
    const { loader: sampleLoader } = loader(files);
    const { trialSubscription } = sampleLoader.load('fake.ts') as { trialSubscription: () => Promise<{ id: string; status: string; checkout?: { kind: string } }> };
    const created = await trialSubscription();
    expect(created).toMatchObject({ id: 'sub_00000000000001', status: 'created', checkout: { kind: 'razorpay_checkout' } });
    const { simulateCharged } = sampleLoader.load('hook.ts') as { simulateCharged: (body: object) => string | undefined };
    expect(simulateCharged({ ...SUBSCRIPTION, status: 'active' })).toBe('evt_1');
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
    ]);
    const key = 'docs_service_api_key_value';
    const subs = Main.createSubscriptions({
      providers: [Main.razorpay({ keyId: 'rzp_test_docs', keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET }, { fetch: mock.fetch })],
    });
    const handler = Server.createHandler({ client: subs, apiKey: key });
    const curls = allBlocks().filter((candidate) => candidate.lang === 'bash' && candidate.code.trim().startsWith('curl'));
    expect(curls.length).toBeGreaterThanOrEqual(3);
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
    }
    executed.push('curl-commands');
  });
});
