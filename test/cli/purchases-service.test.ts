import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Environment, ErrorCode, Provider } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import type { FetchLike } from '../../src/http.js';
import { PURCHASE_STORE_FORMAT } from '../../src/purchase-file-store.js';
import { FlushOutcome, ReportKind, type FlushResult } from '../../src/purchase/index.js';
import { EnvVar, type EnvironmentVariables } from '../../src/service-config.js';
import { buildService, createTickLoop, runServe, silentLogger, type Logger, type RunningService } from '../../src/service.js';
import { loadPurchasesFile } from '../../src/service-purchases.js';
import { SERVICE_PRIVATE_PEM } from '../googleplay/helpers.js';
import { ORDER_CREATED } from '../razorpay/one-time-fixtures.js';

const API_KEY = 'service-api-key-0123456789';
const RAZORPAY_SECRET = 'razorpay-key-secret-value';
const PAYU_SALT = 'payu-salt-value-xyz';
const BASE_URL = 'https://billing.example.com';
const authed = { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' };

const baseEnv: EnvironmentVariables = {
  [EnvVar.ApiKey]: API_KEY,
  [EnvVar.Port]: '0',
  [EnvVar.RazorpayKeyId]: 'rzp_test_id',
  [EnvVar.RazorpayKeySecret]: RAZORPAY_SECRET,
};
const payuEnv: EnvironmentVariables = {
  [EnvVar.PayuKey]: 'payu_key',
  [EnvVar.PayuSalt]: PAYU_SALT,
  [EnvVar.PayuEnvironment]: Environment.Test,
  [EnvVar.PayuSuccessUrl]: 'https://shop.example.com/payu/ok',
};
const googleEnv: EnvironmentVariables = {
  [EnvVar.GooglePlayPackageName]: 'com.example.app',
  [EnvVar.GooglePlayClientEmail]: 'billing@example-project.iam.gserviceaccount.com',
  [EnvVar.GooglePlayPrivateKey]: SERVICE_PRIVATE_PEM.replace(/\n/g, '\\n'),
  [EnvVar.GooglePlayEnvironment]: Environment.Test,
  [EnvVar.GooglePlayPushAudience]: `${BASE_URL}/v1/google_play/webhooks`,
  [EnvVar.GooglePlayPushServiceAccountEmail]: 'pubsub-push@example-project.iam.gserviceaccount.com',
};

const COINS = { key: 'coins-100', kind: 'one_time', name: '100 coins', amount: 9900 };
const MONTHLY = { key: 'pro-monthly', kind: 'subscription', name: 'Pro monthly', amount: 49900, interval: { unit: 'month', count: 1 }, taxRateBps: 1800, googlePlay: { productId: 'pro', basePlanId: 'monthly' } };

function recordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (m) => void lines.push(`info: ${m}`),
    warn: (m) => void lines.push(`warn: ${m}`),
    error: (m) => void lines.push(`error: ${m}`),
  };
}

/** Razorpay's order creation: the sample of the orders page with what the request carried. */
const razorpayOrders: FetchLike = async (_url, init) => {
  const request = JSON.parse(String(init?.body)) as { amount: number; notes: Record<string, string> };
  const order = { ...(JSON.parse(ORDER_CREATED) as Record<string, unknown>), id: 'order_svc_1', amount: request.amount, amount_due: request.amount, notes: request.notes };
  return new Response(JSON.stringify(order), { status: 200, headers: { 'content-type': 'application/json' } });
};

let dir: string;
let running: RunningService | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'india-subscriptions-purchases-'));
});
afterEach(async () => {
  await running?.stop();
  running = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function writePurchases(content: unknown): Promise<string> {
  const path = join(dir, 'purchases.json');
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}

async function envWith(content: unknown, extra: EnvironmentVariables = {}): Promise<EnvironmentVariables> {
  return {
    ...baseEnv,
    [EnvVar.PurchasesFile]: await writePurchases(content),
    [EnvVar.PurchaseStoreFile]: join(dir, 'state', 'purchases-state.json'),
    [EnvVar.PublicBaseUrl]: BASE_URL,
    ...extra,
  };
}

async function failureOf(promise: Promise<unknown>): Promise<SubscriptionError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SubscriptionError);
  return error as SubscriptionError;
}

describe('buildService with purchases', () => {
  it('builds purchases over the facade from the file, and creates the durable store with mode 0600', async () => {
    const env = await envWith({ catalog: [COINS] });
    const service = await buildService(env, { logger: silentLogger });
    expect(service.purchases).toBeDefined();
    expect(service.client.purchases).toBe(service.purchases);
    expect(service.purchaseStore).toBeDefined();
    const stateFile = env[EnvVar.PurchaseStoreFile] as string;
    expect(JSON.parse(await readFile(stateFile, 'utf8')).format).toBe(PURCHASE_STORE_FORMAT);
    if (process.platform !== 'win32') expect((await stat(stateFile)).mode & 0o777).toBe(0o600);
    await service.close();
  });

  it('is off without the file: no purchases, no store, and the startup report says what that means', async () => {
    const service = await buildService(baseEnv, { logger: silentLogger });
    expect(service.purchases).toBeUndefined();
    expect(service.purchaseStore).toBeUndefined();
    const report = service.describe('http://127.0.0.1:1').join('\n');
    expect(report).toContain(`purchases: OFF (${EnvVar.PurchasesFile} is not set`);
  });

  it('the startup report names the file, the state file and the hosted checkout origin, and no secret', async () => {
    const service = await buildService(await envWith({ catalog: [COINS] }, { ...payuEnv }), { logger: silentLogger });
    const report = service.describe('http://127.0.0.1:1').join('\n');
    expect(report).toContain('purchases: on (file ');
    expect(report).toContain('hosted checkout on https://billing.example.com');
    expect(report).toContain('no Google reports');
    expect(report).not.toContain(RAZORPAY_SECRET);
    expect(report).not.toContain(PAYU_SALT);
    await service.close();
  });

  it('describes the app stores and Google reports when Google Play is configured', async () => {
    const service = await buildService(await envWith({ catalog: [COINS], policy: { android: 'user_choice' } }, googleEnv), { logger: silentLogger }).catch((e: unknown) => e);
    // user_choice needs a catalog with Google Play products and tax rates: this catalog has none, so it is refused.
    expect((service as SubscriptionError).message).toContain('taxRateBps');
    const ok = await buildService(await envWith({ catalog: [MONTHLY], policy: { android: 'user_choice' } }, googleEnv), { logger: silentLogger });
    const report = ok.describe('http://127.0.0.1:1').join('\n');
    expect(report).toContain('app stores enabled: google_play');
    expect(report).toContain('Google reports flushed on every tick');
    await ok.close();
  });

  it('serves purchases over HTTP: start a web purchase, hosted URLs built on PUBLIC_BASE_URL, the session survives a restart', async () => {
    const env = await envWith({ catalog: [COINS], routing: { priority: [Provider.Razorpay] } });
    running = await runServe({ env, fetch: razorpayOrders, logger: silentLogger });
    const started = await fetch(`${running.url}/v1/purchases`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({ platform: 'web', product: COINS.key, customer: { name: 'Asha', email: 'asha@example.com', phone: '9876543210' }, customerRef: 'cust_1', returnUrl: 'https://shop.example.com/done' }),
    });
    expect(await started.clone().text()).not.toContain('"error"');
    expect(started.status).toBe(201);
    const session = (await started.json()) as { id: string; options: Array<{ provider: string; hostedUrl: string; checkout: { kind: string; callbackUrl?: string } }> };
    // Razorpay's checkout goes back to the hosted checkout's return endpoint.
    expect(session.options[0]).toMatchObject({
      provider: Provider.Razorpay,
      hostedUrl: `${BASE_URL}/checkout/${session.id}`,
      checkout: { kind: 'razorpay_checkout', callbackUrl: `${BASE_URL}/checkout/${session.id}/return` },
    });

    await running.stop();
    running = await runServe({ env, fetch: razorpayOrders, logger: silentLogger });
    const again = await fetch(`${running.url}/v1/purchases/${session.id}`, { headers: authed });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { id: string }).id).toBe(session.id);
    // And the hosted page needs no key.
    const page = await fetch(`${running.url}/checkout/${session.id}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await page.text()).toContain('https://checkout.razorpay.com/v1/checkout.js');
  });

  it('warns at startup that PayU cannot take the hosted checkout\'s return URL, only when both are configured', async () => {
    const logger = recordingLogger();
    running = await runServe({ env: await envWith({ catalog: [COINS] }, { ...payuEnv }), fetch: razorpayOrders, logger });
    expect(logger.lines.join('\n')).toMatch(/warn: payu accepts return URLs of at most 50 characters and the hosted checkout's return URL is \d+/);
    await running.stop();
    const quiet = recordingLogger();
    running = await runServe({ env: await envWith({ catalog: [COINS] }, { [EnvVar.PublicBaseUrl]: undefined }), fetch: razorpayOrders, logger: quiet });
    expect(quiet.lines.join('\n')).not.toContain('payu accepts');
  });

  it('the route that flushes the report queue answers, with nothing to send', async () => {
    running = await runServe({ env: await envWith({ catalog: [COINS] }), fetch: razorpayOrders, logger: silentLogger });
    const response = await fetch(`${running.url}/v1/purchases/flush`, { method: 'POST', headers: authed });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sent: 0, overdue: [] });
  });

  it('without the file the purchase routes say what to set, and everything else works as before', async () => {
    running = await runServe({ env: baseEnv, fetch: razorpayOrders, logger: silentLogger });
    const response = await fetch(`${running.url}/v1/entitlements/cust_1`, { headers: authed });
    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: ErrorCode.Config, message: expect.stringContaining(EnvVar.PurchasesFile) });
    expect((await fetch(`${running.url}/v1/providers`, { headers: authed })).status).toBe(200);
    expect((await fetch(`${running.url}/checkout/ps_x`)).status).toBe(404);
  });
});

describe('the purchases file', () => {
  const capabilities = (...providers: Provider[]) => providers.map((provider) => ({ provider }) as never);

  it('reports every problem in one pass, by field path, without a single value', async () => {
    const path = await writePurchases({
      catalog: [
        { key: 'a', kind: 'subscription', name: 'A', amount: 'SECRET-AMOUNT' },
        { key: 'b', kind: 'one_time', name: '', amount: 100 },
        { key: 'c', kind: 'nonsense', name: 'C', amount: 100 },
      ],
      polcy: { android: 'store' },
      policy: { android: 'SECRET-POLICY' },
      routing: { weights: { cost: 'SECRET-WEIGHT' } },
    });
    const error = await failureOf(loadPurchasesFile(path, { capabilities: [], hasReporter: false }));
    expect(error.code).toBe(ErrorCode.Config);
    for (const part of ['"polcy": is not a key', 'catalog.0.amount', 'catalog.1.name', 'catalog.2.kind', 'policy.android', 'routing.weights.cost']) {
      expect(error.message, part).toContain(part);
    }
    expect(error.message).toContain(EnvVar.PurchasesFile);
    for (const secret of ['SECRET-AMOUNT', 'SECRET-POLICY', 'SECRET-WEIGHT']) expect(error.message).not.toContain(secret);
  });

  it('applies the module\'s catalog validation: every problem listed once, in one error', async () => {
    const path = await writePurchases({
      catalog: [
        { key: 'a', kind: 'subscription', name: 'A', amount: 100 },
        { key: 'a', kind: 'one_time', name: 'A again', amount: 100, interval: { unit: 'month', count: 1 } },
      ],
      policy: { android: 'user_choice' },
    });
    const error = await failureOf(loadPurchasesFile(path, { capabilities: capabilities(Provider.Razorpay), hasReporter: false }));
    for (const part of ['google_play provider is not configured', 'no reporter is configured', 'appears more than once', 'needs an `interval`', `${EnvVar.PublicBaseUrl} must be set`]) {
      expect(error.message, part).toContain(part);
    }
  });

  it('is refused when it is missing, not JSON, or not an object, naming the path and never the content', async () => {
    const missing = await failureOf(loadPurchasesFile(join(dir, 'nope.json'), { capabilities: [], hasReporter: false }));
    expect(missing.message).toContain('nope.json');
    expect(missing.message).toContain('ENOENT');
    const notJson = await failureOf(loadPurchasesFile(await writePurchases('{ SECRET-TEXT'), { capabilities: [], hasReporter: false }));
    expect(notJson.message).toContain('not valid JSON');
    expect(notJson.message).not.toContain('SECRET-TEXT');
    for (const content of ['[]', 'null', '"text"']) {
      expect((await failureOf(loadPurchasesFile(await writePurchases(content), { capabilities: [], hasReporter: false }))).message).toContain('one JSON object');
    }
  });

  it('needs at least one product', async () => {
    const error = await failureOf(loadPurchasesFile(await writePurchases({ catalog: [] }), { capabilities: [], hasReporter: false }));
    expect(error.message).toContain('catalog');
    expect(error.message).toContain('at least one product');
  });

  it('returns the catalog, the policy with its defaults, and the routing strategy as written', async () => {
    const config = await loadPurchasesFile(await writePurchases({ catalog: [COINS], routing: { priority: ['razorpay'] } }), { capabilities: capabilities(Provider.Razorpay), hasReporter: false });
    expect(config.catalog).toHaveLength(1);
    expect(config.policy).toEqual({ ios: 'store', android: 'store', web: 'gateways' });
    expect(config.routing?.priority).toEqual(['razorpay']);
    const without = await loadPurchasesFile(await writePurchases({ catalog: [COINS] }), { capabilities: capabilities(Provider.Razorpay), hasReporter: false });
    expect(without.routing).toBeUndefined();
  });

  it('makes buildService throw it, and release what it opened', async () => {
    const env = await envWith({ catalog: [{ key: 'a' }] });
    const error = await failureOf(buildService(env, { logger: silentLogger }));
    expect(error.code).toBe(ErrorCode.Config);
    // The store file is only created for a configuration that loaded.
    await expect(stat(env[EnvVar.PurchaseStoreFile] as string)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a state file that is not a purchase store, and leaves it alone', async () => {
    const env = await envWith({ catalog: [COINS] });
    const stateFile = env[EnvVar.PurchaseStoreFile] as string;
    await writeFile(join(dir, 'foreign.json'), '{"not":"ours"}');
    const foreign = { ...env, [EnvVar.PurchaseStoreFile]: join(dir, 'foreign.json') };
    expect((await failureOf(buildService(foreign, { logger: silentLogger }))).code).toBe(ErrorCode.Config);
    expect(await readFile(join(dir, 'foreign.json'), 'utf8')).toBe('{"not":"ours"}');
    expect(stateFile).toBeDefined();
  });
});

describe('createTickLoop flushes the Google report queue', () => {
  const flushed = (overrides: Partial<FlushResult> = {}): FlushResult => ({
    sent: 0,
    retrying: 0,
    blocked: 0,
    rejected: 0,
    skipped: 0,
    entries: [],
    overdue: [],
    ...overrides,
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes on every tick, with or without a scheduler, and stops with the loop', async () => {
    vi.useFakeTimers();
    const flush = vi.fn(async () => flushed());
    const loop = createTickLoop({ purchases: { flush }, intervalMs: 1000, logger: silentLogger });
    loop.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(flush).toHaveBeenCalledTimes(4);
    await loop.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(flush).toHaveBeenCalledTimes(4);
  });

  it('runs the scheduler tick and the flush together, and one failing does not stop the other', async () => {
    const logger = recordingLogger();
    const tick = vi.fn(async () => {
      throw new Error('scheduler down with a SECRET detail');
    });
    const flush = vi.fn(async () => flushed({ sent: 1 }));
    const loop = createTickLoop({ scheduler: { tick }, purchases: { flush }, intervalMs: 1000, logger });
    expect(await loop.runOnce()).toBeUndefined();
    expect(flush).toHaveBeenCalledTimes(1);
    const output = logger.lines.join('\n');
    expect(output).toContain('error: scheduler tick failed');
    expect(output).toContain('purchase reports: sent=1');
    expect(output).not.toContain('SECRET');

    const failing = recordingLogger();
    const broken = createTickLoop({
      scheduler: { tick: vi.fn(async () => ({ at: '2026-01-01T00:00:00.000Z', due: 0, locked: 0, notified: 0, charged: 0, reconciled: 0, succeeded: 0, failed: 0, awaiting: 0, completed: 0, halted: 0, expired: 0, errors: [] })) },
      purchases: { flush: vi.fn(async () => { throw new SubscriptionError(ErrorCode.Internal, 'store gone'); }) },
      intervalMs: 1000,
      logger: failing,
    });
    expect(await broken.runOnce()).toMatchObject({ due: 0 });
    expect(failing.lines.join('\n')).toContain('error: purchase report flush failed: INTERNAL_ERROR: store gone');
  });

  it('logs sent, retrying, rejected and overdue counts, and names reports by id, kind and code only', async () => {
    const logger = recordingLogger();
    const flush = vi.fn(async () =>
      flushed({
        sent: 3,
        retrying: 2,
        rejected: 1,
        blocked: 1,
        skipped: 0,
        entries: [
          { id: 'ext_rejected1', kind: ReportKind.Transaction, outcome: FlushOutcome.Rejected, attempts: 1, dueBy: '2026-11-23T10:00:00.000Z', overdue: false, errorCode: ErrorCode.Validation, errorMessage: 'userTaxAddress is SECRET-STATE-KARNATAKA' },
          { id: 'ext_retry1', kind: ReportKind.Refund, outcome: FlushOutcome.Retrying, attempts: 2, dueBy: '2026-11-23T10:00:00.000Z', overdue: false, errorCode: ErrorCode.Network, errorMessage: 'token SECRET-TOKEN' },
        ],
        overdue: [{ id: 'ext_late1', kind: ReportKind.Transaction, attempts: 9, dueBy: '2026-11-22T10:00:00.000Z', overdue: true, errorMessage: 'amount 49900 SECRET' }],
      }),
    );
    await createTickLoop({ purchases: { flush }, intervalMs: 1000, logger }).runOnce();
    const output = logger.lines.join('\n');
    expect(output).toContain('info: purchase reports: sent=3 retrying=2 blocked=1 rejected=1 skipped=0 overdue=1');
    expect(output).toContain('warn: purchase report ext_rejected1 (transaction) was rejected: VALIDATION; it will not be retried');
    expect(output).toContain('warn: purchase report ext_late1 (transaction) is overdue since 2026-11-22T10:00:00.000Z after 9 attempts');
    expect(output).not.toContain('SECRET');
    expect(output).not.toContain('49900');
  });

  it('is quiet when there is nothing to report', async () => {
    const logger = recordingLogger();
    await createTickLoop({ purchases: { flush: async () => flushed() }, intervalMs: 1000, logger }).runOnce();
    expect(logger.lines).toEqual([]);
  });

  it('runServe ticks when purchases and Google Play are configured, even without a scheduler, and a tick is harmless with nothing queued', async () => {
    const logger = recordingLogger();
    const env = await envWith({ catalog: [MONTHLY], policy: { android: 'user_choice' } }, { ...googleEnv, [EnvVar.SchedulerTickSeconds]: '3600' });
    running = await runServe({ env, fetch: razorpayOrders, logger });
    expect(running.service.scheduler).toBeUndefined();
    expect(running.service.purchases).toBeDefined();
    await running.stop();
    running = undefined;
    expect(logger.lines.filter((line) => line.startsWith('error:'))).toEqual([]);
    expect(logger.lines.join('\n')).toContain('app stores enabled: google_play');
  });
});
