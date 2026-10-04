import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode, Environment, IntervalUnit, Provider } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import { EventsHeader, verifyEventsSignature } from '../../src/events-webhook.js';
import { FILE_STORE_FORMAT } from '../../src/scheduler-file-store.js';
import type { TickResult } from '../../src/scheduler/schemas.js';
import { EnvVar, type EnvironmentVariables } from '../../src/service-config.js';
import { buildService, createTickLoop, runServe, silentLogger, type Logger, type RunningService } from '../../src/service.js';
import { mockFetch } from '../helpers/mock-fetch.js';

const API_KEY = 'service-api-key-0123456789';
const RAZORPAY_SECRET = 'razorpay-key-secret-value';
const RAZORPAY_WEBHOOK_SECRET = 'razorpay-webhook-secret-value';
const PAYU_SALT = 'payu-salt-value-xyz';
const EVENTS_URL = 'https://hooks.example.com/in';
const EVENTS_SECRET = 'events-secret-value';
const ALL_SECRETS = [API_KEY, RAZORPAY_SECRET, RAZORPAY_WEBHOOK_SECRET, PAYU_SALT, EVENTS_SECRET];

const baseEnv: EnvironmentVariables = {
  [EnvVar.ApiKey]: API_KEY,
  [EnvVar.Port]: '0',
  [EnvVar.RazorpayKeyId]: 'rzp_test_id',
  [EnvVar.RazorpayKeySecret]: RAZORPAY_SECRET,
  [EnvVar.RazorpayWebhookSecret]: RAZORPAY_WEBHOOK_SECRET,
};
const payuEnv: EnvironmentVariables = {
  [EnvVar.PayuKey]: 'payu_key',
  [EnvVar.PayuSalt]: PAYU_SALT,
  [EnvVar.PayuEnvironment]: Environment.Test,
};

function recordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (m) => void lines.push(`info: ${m}`),
    warn: (m) => void lines.push(`warn: ${m}`),
    error: (m) => void lines.push(`error: ${m}`),
  };
}

let dir: string;
let running: RunningService | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'india-subscriptions-service-'));
});
afterEach(async () => {
  await running?.stop();
  running = undefined;
  await rm(dir, { recursive: true, force: true });
});

const authed = { authorization: `Bearer ${API_KEY}` };

/** A Razorpay `subscription.authenticated` webhook (trimmed from the docs sample used in test/razorpay/webhook.test.ts). */
const WEBHOOK_BODY = JSON.stringify({
  entity: 'event',
  account_id: 'acc_F5Motm2sJ5Fomd',
  event: 'subscription.authenticated',
  contains: ['subscription'],
  payload: {
    subscription: {
      entity: {
        id: 'sub_F5aa7VaVXtXh80',
        entity: 'subscription',
        plan_id: 'plan_F5Zu0nrXVhHV2m',
        customer_id: 'cust_F5ZuzTm0cqYpzp',
        status: 'authenticated',
        current_start: null,
        current_end: null,
        ended_at: null,
        quantity: 1,
        notes: [],
        charge_at: 1593109800,
        start_at: 1593109800,
        end_at: 1598380200,
        auth_attempts: 0,
        total_count: 3,
        paid_count: 0,
        customer_notify: true,
        created_at: 1592811228,
        expire_by: null,
        short_url: null,
        has_scheduled_changes: false,
        change_scheduled_at: null,
        source: 'api',
        remaining_count: 3,
      },
    },
  },
  created_at: 1592811255,
});
const webhookHeaders = (body = WEBHOOK_BODY, secret = RAZORPAY_WEBHOOK_SECRET): Record<string, string> => ({
  'x-razorpay-signature': createHmac('sha256', secret).update(body, 'utf8').digest('hex'),
  'x-razorpay-event-id': 'evt_test_1',
  'content-type': 'application/json',
});

describe('buildService', () => {
  it('builds the enabled gateways and nothing else', async () => {
    const service = await buildService({ ...baseEnv, ...payuEnv }, { logger: silentLogger });
    expect(service.client.providers).toEqual([Provider.Razorpay, Provider.PayU]);
    expect(service.scheduler).toBeUndefined();
    expect(service.store).toBeUndefined();
    expect(service.onEvents).toBeUndefined();
  });

  it('propagates configuration errors', async () => {
    const error = await buildService({}, { logger: silentLogger }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SubscriptionError);
    expect((error as SubscriptionError).code).toBe(ErrorCode.Config);
  });

  it('turns the scheduler on with SCHEDULER_STORE_FILE, creating the file with mode 0600', async () => {
    const path = join(dir, 'nested', 'state.json');
    const service = await buildService({ ...baseEnv, ...payuEnv, [EnvVar.SchedulerStoreFile]: path }, { logger: silentLogger });
    expect(service.scheduler).toBeDefined();
    expect(service.client.scheduler).toBe(service.scheduler);
    expect(JSON.parse(await readFile(path, 'utf8')).format).toBe(FILE_STORE_FORMAT);
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
    await service.close();
  });

  it('refuses a scheduler file that is not a store file, and leaves it alone', async () => {
    const path = join(dir, 'foreign.json');
    await writeFile(path, '{"not":"ours"}');
    const error = await buildService({ ...baseEnv, [EnvVar.SchedulerStoreFile]: path }, { logger: silentLogger }).catch(
      (e: unknown) => e,
    );
    expect((error as SubscriptionError).code).toBe(ErrorCode.Config);
    expect(await readFile(path, 'utf8')).toBe('{"not":"ours"}');
  });

  describe('startup report', () => {
    it('lists gateways, the URL, the scheduler and the events webhook, with no secret and no URL path', async () => {
      const service = await buildService(
        {
          ...baseEnv,
          ...payuEnv,
          [EnvVar.SchedulerStoreFile]: join(dir, 's.json'),
          [EnvVar.SchedulerTickSeconds]: '120',
          [EnvVar.EventsWebhookUrl]: `${EVENTS_URL}/secret-token?k=v`,
          [EnvVar.EventsWebhookSecret]: EVENTS_SECRET,
        },
        { logger: silentLogger },
      );
      const report = service.describe('http://127.0.0.1:8787').join('\n');
      expect(report).toContain('gateways enabled: razorpay, payu');
      expect(report).toContain('listening on http://127.0.0.1:8787');
      expect(report).toContain('billing scheduler: on');
      expect(report).toContain('tick every 120s');
      expect(report).toContain('events webhook: https://hooks.example.com (signed; gateway events and scheduler events)');
      expect(report).not.toContain('secret-token');
      for (const secret of ALL_SECRETS) expect(report).not.toContain(secret);
      await service.close();
    });

    it('says plainly what the missing scheduler means for merchant-scheduled gateways', async () => {
      const service = await buildService({ ...baseEnv, ...payuEnv }, { logger: silentLogger });
      const report = service.describe('http://127.0.0.1:1').join('\n');
      expect(report).toContain('billing scheduler: OFF');
      expect(report).toContain(EnvVar.SchedulerStoreFile);
      expect(report).toContain('payu bills through the scheduler');
      expect(report).toContain('refused');
    });

    it('does not alarm when no enabled gateway needs the scheduler', async () => {
      const service = await buildService(baseEnv, { logger: silentLogger });
      expect(service.describe('http://127.0.0.1:1').join('\n')).toContain('none of the enabled gateways needs it');
    });
  });
});

describe('runServe', () => {
  it('serves health without a key, and protects the rest', async () => {
    const logger = recordingLogger();
    running = await runServe({ env: baseEnv, logger });
    expect(running.url).toBe(`http://127.0.0.1:${running.port}`);
    expect(running.port).toBeGreaterThan(0);

    const health = await fetch(`${running.url}/v1/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok', providers: [Provider.Razorpay] });

    const denied = await fetch(`${running.url}/v1/providers`);
    expect(denied.status).toBe(401);
    const wrong = await fetch(`${running.url}/v1/providers`, { headers: { authorization: 'Bearer nope' } });
    expect(wrong.status).toBe(401);
    const allowed = await fetch(`${running.url}/v1/providers`, { headers: authed });
    expect(allowed.status).toBe(200);

    const output = logger.lines.join('\n');
    expect(output).toContain(`listening on ${running.url}`);
    for (const secret of ALL_SECRETS) expect(output).not.toContain(secret);
  });

  it('with --allow-unauthenticated serves the protected routes without a key', async () => {
    const env = { ...baseEnv };
    delete env[EnvVar.ApiKey];
    const logger = recordingLogger();
    running = await runServe({ env, allowUnauthenticated: true, logger });
    expect((await fetch(`${running.url}/v1/providers`)).status).toBe(200);
    expect(logger.lines.join('\n')).toContain('warn: Running WITHOUT an API key');
  });

  it('binds loopback by default', async () => {
    running = await runServe({ env: baseEnv, logger: silentLogger });
    expect(running.server.host).toBe('127.0.0.1');
  });

  it('rejects, and releases the store, when it cannot listen', async () => {
    running = await runServe({ env: baseEnv, logger: silentLogger });
    const env = { ...baseEnv, [EnvVar.Port]: String(running.port), [EnvVar.SchedulerStoreFile]: join(dir, 's.json') };
    await expect(runServe({ env, logger: silentLogger })).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });

  it('stop() closes the server and is safe to call twice', async () => {
    const service = await runServe({ env: baseEnv, logger: silentLogger });
    const { url } = service;
    await service.stop();
    await service.stop();
    await service.stopped;
    await expect(fetch(`${url}/v1/health`)).rejects.toThrow();
  });

  it('refuses a merchant-scheduled gateway when the scheduler is off, before calling the gateway', async () => {
    const gateway = mockFetch([]);
    running = await runServe({ env: { ...baseEnv, ...payuEnv }, fetch: gateway.fetch, logger: silentLogger });
    const response = await fetch(`${running.url}/v1/payu/subscriptions`, {
      method: 'POST',
      headers: { ...authed, 'content-type': 'application/json' },
      body: JSON.stringify({
        plan: { name: 'Pro', amount: 49900, interval: { unit: 'month', count: 1 } },
        customer: { name: 'Asha', email: 'asha@example.com', phone: '9876543210' },
      }),
    });
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(body.error.code).toBe(ErrorCode.Config);
    expect(body.error.message).toContain('merchant-scheduled');
    expect(gateway.calls).toHaveLength(0);
  });

  describe('events webhook', () => {
    const eventsEnv = { ...baseEnv, [EnvVar.EventsWebhookUrl]: EVENTS_URL, [EnvVar.EventsWebhookSecret]: EVENTS_SECRET };

    async function postWebhook(url: string, body = WEBHOOK_BODY, headers = webhookHeaders(body)): Promise<Response> {
      return fetch(`${url}/v1/razorpay/webhooks`, { method: 'POST', headers, body });
    }

    it('forwards the normalised events, signed, from the raw gateway route (which needs no API key)', async () => {
      const receiver = mockFetch([{ url: EVENTS_URL, status: 200 }]);
      running = await runServe({ env: eventsEnv, fetch: receiver.fetch, logger: silentLogger });
      const response = await postWebhook(running.url);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ received: 1 });

      expect(receiver.calls).toHaveLength(1);
      const call = receiver.calls[0]!;
      expect(call.method).toBe('POST');
      expect(() => verifyEventsSignature(EVENTS_SECRET, call.body as string, call.headers)).not.toThrow();
      expect(Number(call.headers[EventsHeader.Timestamp])).toBeGreaterThan(1_700_000_000);
      const delivered = call.json as { kind: string; provider: string; events: { type: string; provider: string }[] };
      expect(delivered.kind).toBe('gateway');
      expect(delivered.provider).toBe(Provider.Razorpay);
      expect(delivered.events).toHaveLength(1);
      expect(delivered.events[0]).toMatchObject({ provider: Provider.Razorpay, type: 'subscription.authorized' });
    });

    it.each([
      ['a non-2xx answer', { status: 503 }],
      ['a network failure', { networkError: true }],
    ])('answers the gateway 500 on %s, so the gateway retries', async (_name, route) => {
      const receiver = mockFetch([{ url: EVENTS_URL, ...route }]);
      running = await runServe({ env: eventsEnv, fetch: receiver.fetch, logger: silentLogger });
      const response = await postWebhook(running.url);
      expect(response.status).toBe(500);
      expect(receiver.calls).toHaveLength(1);
    });

    it('forwards nothing for a webhook whose signature does not verify', async () => {
      const receiver = mockFetch([]);
      running = await runServe({ env: eventsEnv, fetch: receiver.fetch, logger: silentLogger });
      const response = await postWebhook(running.url, WEBHOOK_BODY, webhookHeaders(WEBHOOK_BODY, 'wrong-secret'));
      expect(response.status).toBe(401);
      expect(receiver.calls).toHaveLength(0);
    });

    it('without an events webhook configured simply acknowledges', async () => {
      running = await runServe({ env: baseEnv, logger: silentLogger });
      const response = await postWebhook(running.url);
      expect(response.status).toBe(200);
    });
  });
});

describe('scheduler events on the events webhook', () => {
  const registration = {
    provider: Provider.PayU,
    subscriptionId: 'payu-sub-1',
    reference: 'order-1',
    amount: 49900,
    interval: { unit: IntervalUnit.Month, count: 1 },
    firstChargeAt: '2099-01-15T04:30:00.000Z',
    awaitingAuthorization: true,
  };
  const env = (): EnvironmentVariables => ({
    ...baseEnv,
    ...payuEnv,
    [EnvVar.SchedulerStoreFile]: join(dir, 'state.json'),
    [EnvVar.EventsWebhookUrl]: EVENTS_URL,
    [EnvVar.EventsWebhookSecret]: EVENTS_SECRET,
  });

  it('forwards them, signed, as `scheduler` deliveries with a stable id per event', async () => {
    const receiver = mockFetch([
      { url: EVENTS_URL, status: 200 },
      { url: EVENTS_URL, status: 200 },
    ]);
    const service = await buildService(env(), { fetch: receiver.fetch, logger: silentLogger });
    expect(service.schedulerEvents).toBeDefined();
    const schedule = await service.scheduler!.register(registration);
    await service.scheduler!.cancel(schedule.id);
    await service.schedulerEvents!.idle();

    expect(receiver.calls.length).toBeGreaterThanOrEqual(2);
    const events: { id: string; type: string; scheduleId: string; provider: string }[] = [];
    for (const call of receiver.calls) {
      expect(() => verifyEventsSignature(EVENTS_SECRET, call.body as string, call.headers)).not.toThrow();
      const delivery = call.json as { kind: string; events: typeof events };
      expect(delivery.kind).toBe('scheduler');
      events.push(...delivery.events);
    }
    expect(events.map((e) => e.type)).toEqual(['schedule.registered', 'schedule.cancelled']);
    for (const e of events) {
      expect(e.scheduleId).toBe(schedule.id);
      expect(e.provider).toBe(Provider.PayU);
      expect(e.id).toMatch(/^sevt_[0-9a-f]{32}$/);
    }
    expect(new Set(events.map((e) => e.id)).size).toBe(2);
    await service.close();
  });

  it('does not run a relay without a scheduler, or without the webhook', async () => {
    const noStore = { ...env() };
    delete noStore[EnvVar.SchedulerStoreFile];
    expect((await buildService(noStore, { logger: silentLogger })).schedulerEvents).toBeUndefined();
    const noHook = { ...env() };
    delete noHook[EnvVar.EventsWebhookUrl];
    delete noHook[EnvVar.EventsWebhookSecret];
    const service = await buildService(noHook, { logger: silentLogger });
    expect(service.schedulerEvents).toBeUndefined();
    await service.close();
  });

  it('a receiver that is down never breaks billing; undelivered events are logged with id and type', async () => {
    const receiver = mockFetch(Array.from({ length: 10 }, () => ({ url: EVENTS_URL, status: 503 })));
    const logger = recordingLogger();
    const service = await buildService(env(), { fetch: receiver.fetch, logger });
    const schedule = await service.scheduler!.register(registration);
    expect(schedule.status).toBe('pending_authorization');
    expect((await service.scheduler!.get(schedule.id))?.id).toBe(schedule.id);
    await vi.waitFor(() => expect(receiver.calls.length).toBeGreaterThanOrEqual(1));
    await service.close(); // stops the retry loop instead of waiting out the backoff

    const errors = logger.lines.filter((line) => line.startsWith('error: ')).join('\n');
    expect(errors).toMatch(/scheduler event sevt_[0-9a-f]{32} \(schedule\.registered\)/);
    for (const secret of ALL_SECRETS) expect(logger.lines.join('\n')).not.toContain(secret);
    // The schedule itself is stored regardless.
    const reopened = await buildService(env(), { logger: silentLogger });
    expect((await reopened.scheduler!.get(schedule.id))?.id).toBe(schedule.id);
    await reopened.close();
  });
});

describe('createTickLoop', () => {
  const result = (overrides: Partial<TickResult> = {}): TickResult => ({
    at: '2026-01-01T00:00:00.000Z',
    due: 0,
    locked: 0,
    notified: 0,
    charged: 0,
    reconciled: 0,
    succeeded: 0,
    failed: 0,
    awaiting: 0,
    completed: 0,
    halted: 0,
    expired: 0,
    errors: [],
    ...overrides,
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ticks at start and then every interval, until stopped', async () => {
    vi.useFakeTimers();
    const tick = vi.fn(async () => result());
    const loop = createTickLoop({ scheduler: { tick }, intervalMs: 1000, logger: silentLogger });
    loop.start();
    loop.start(); // idempotent
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(tick).toHaveBeenCalledTimes(4);
    await loop.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(tick).toHaveBeenCalledTimes(4);
  });

  it('never overlaps itself: a slow tick makes the next interval skip', async () => {
    vi.useFakeTimers();
    let active = 0;
    let maxActive = 0;
    let finish: () => void = () => undefined;
    const tick = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      active -= 1;
      return result();
    });
    const logger = recordingLogger();
    const loop = createTickLoop({ scheduler: { tick }, intervalMs: 1000, logger });
    loop.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(maxActive).toBe(1);
    expect(logger.lines.some((line) => line.includes('skipped'))).toBe(true);

    finish();
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(2);
    finish();
    await loop.stop();
    expect(maxActive).toBe(1);
  });

  it('logs a failing tick and keeps going; stop() waits for the tick in flight', async () => {
    vi.useFakeTimers();
    const tick = vi
      .fn<() => Promise<TickResult>>()
      .mockRejectedValueOnce(new SubscriptionError(ErrorCode.Network, 'store unreachable'))
      .mockResolvedValue(result({ due: 1, charged: 1, succeeded: 1 }));
    const logger = recordingLogger();
    const loop = createTickLoop({ scheduler: { tick }, intervalMs: 1000, logger });
    loop.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(2);
    await loop.stop();
    expect(logger.lines).toContain('error: scheduler tick failed: NETWORK: store unreachable');
    expect(logger.lines.some((line) => line.startsWith('info: scheduler tick: due=1 notified=0 charged=1'))).toBe(true);
  });

  it('logs per-schedule errors but stays quiet when nothing happened', async () => {
    const logger = recordingLogger();
    const tick = vi
      .fn<() => Promise<TickResult>>()
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result({ due: 1, errors: [{ scheduleId: 'razorpay:abc', code: ErrorCode.Conflict, message: 'locked' }] }));
    const loop = createTickLoop({ scheduler: { tick }, intervalMs: 1000, logger });
    expect(await loop.runOnce()).toEqual(result());
    expect(logger.lines).toEqual([]);
    await loop.runOnce();
    expect(logger.lines).toContain('warn: scheduler tick: razorpay:abc: CONFLICT: locked');
  });

  it('does not throw even when the failure is not a SubscriptionError', async () => {
    const logger = recordingLogger();
    const loop = createTickLoop({
      scheduler: {
        tick: async () => {
          throw new Error('password=hunter2');
        },
      },
      intervalMs: 1000,
      logger,
    });
    expect(await loop.runOnce()).toBeUndefined();
    expect(logger.lines.join('\n')).not.toContain('hunter2');
  });
});

describe('all five gateways', () => {
  const PHONEPE_SECRET = 'phonepe-client-secret-value';
  const PAYTM_KEY = 'PAYTMKEY0123456A'; // 16 bytes
  const allFive: EnvironmentVariables = {
    ...baseEnv,
    ...payuEnv,
    [EnvVar.CashfreeClientId]: 'cf_id',
    [EnvVar.CashfreeClientSecret]: 'cashfree-client-secret',
    [EnvVar.CashfreeEnvironment]: Environment.Test,
    [EnvVar.PhonepeClientId]: 'pp_id',
    [EnvVar.PhonepeClientSecret]: PHONEPE_SECRET,
    [EnvVar.PhonepeClientVersion]: '1',
    [EnvVar.PhonepeEnvironment]: Environment.Test,
    [EnvVar.PaytmMid]: 'MID123',
    [EnvVar.PaytmMerchantKey]: PAYTM_KEY,
    [EnvVar.PaytmWebsite]: 'WEBSTAGING',
    [EnvVar.PaytmEnvironment]: Environment.Test,
  };
  const secrets = [...ALL_SECRETS, PHONEPE_SECRET, PAYTM_KEY, 'cashfree-client-secret'];

  it('builds each new gateway on its own', async () => {
    for (const [provider, extra] of [
      [Provider.PhonePe, Object.fromEntries(Object.entries(allFive).filter(([k]) => k.startsWith('PHONEPE_')))],
      [Provider.Paytm, Object.fromEntries(Object.entries(allFive).filter(([k]) => k.startsWith('PAYTM_')))],
    ] as const) {
      const service = await buildService({ [EnvVar.ApiKey]: API_KEY, ...extra }, { logger: silentLogger });
      expect(service.client.providers).toEqual([provider]);
      expect(service.client.capabilities(provider).provider).toBe(provider);
    }
  });

  it('answers /v1/providers with five capability sets', async () => {
    running = await runServe({ env: allFive, logger: silentLogger });
    const health = await (await fetch(`${running.url}/v1/health`)).json();
    expect(health).toMatchObject({ status: 'ok' });
    const response = await fetch(`${running.url}/v1/providers`, { headers: authed });
    expect(response.status).toBe(200);
    const capabilities = (await response.json()) as { provider: string; scheduling: string[]; merchantCharges: boolean }[];
    expect(capabilities.map((c) => c.provider).sort()).toEqual(['cashfree', 'paytm', 'payu', 'phonepe', 'razorpay']);
    const by = Object.fromEntries(capabilities.map((c) => [c.provider, c]));
    expect(by.phonepe?.scheduling).toEqual(['merchant']);
    expect(by.paytm?.scheduling).toEqual(['merchant', 'gateway']);
    expect(by.razorpay?.merchantCharges).toBe(false);
    for (const provider of ['phonepe', 'paytm']) {
      const one = await fetch(`${running.url}/v1/${provider}/capabilities`, { headers: authed });
      expect(((await one.json()) as { provider: string }).provider).toBe(provider);
    }
  });

  it('says what the missing scheduler means for each gateway, and prints no secret', async () => {
    const service = await buildService(allFive, { logger: silentLogger });
    const report = service.describe('http://127.0.0.1:1').join('\n');
    expect(report).toContain('gateways enabled: razorpay, cashfree, payu, phonepe, paytm');
    expect(report).toContain('billing scheduler: OFF');
    expect(report).toContain('payu, phonepe bill through the scheduler, so creating a subscription there will be refused');
    expect(report).toContain('paytm bills through the scheduler unless a plan asks for scheduling "gateway"');
    expect(report).toContain('cashfree subscriptions on plans with scheduling "merchant" will be refused');
    expect(report).not.toContain('razorpay bill');
    for (const secret of secrets) expect(report).not.toContain(secret);
  });

  it('with a store file the scheduler is on and the report no longer warns', async () => {
    const service = await buildService({ ...allFive, [EnvVar.SchedulerStoreFile]: join(dir, 'five.json') }, { logger: silentLogger });
    const report = service.describe('http://127.0.0.1:1').join('\n');
    expect(report).toContain('billing scheduler: on');
    expect(report).not.toContain('refused');
    await service.close();
  });

  it.each([
    [Provider.PhonePe, 'phonepe bills through the scheduler, so creating a subscription there will be refused'],
    [Provider.Paytm, 'paytm bills through the scheduler unless a plan asks for scheduling "gateway": those subscriptions will be refused'],
  ])('the startup log for %s alone', async (provider, sentence) => {
    const env = {
      [EnvVar.ApiKey]: API_KEY,
      ...Object.fromEntries(Object.entries(allFive).filter(([k]) => k.startsWith(provider === Provider.PhonePe ? 'PHONEPE_' : 'PAYTM_'))),
    };
    const service = await buildService(env, { logger: silentLogger });
    expect(service.describe('http://127.0.0.1:1').join('\n')).toContain(`billing scheduler: OFF (${EnvVar.SchedulerStoreFile} is not set; ${sentence})`);
  });

  it('refuses to create a PhonePe or Paytm subscription without a scheduler, before calling the gateway', async () => {
    const gateway = mockFetch([]);
    running = await runServe({ env: allFive, fetch: gateway.fetch, logger: silentLogger });
    const body = JSON.stringify({
      plan: { name: 'Pro', amount: 49900, interval: { unit: 'month', count: 1 } },
      customer: { name: 'Asha', email: 'asha@example.com', phone: '9876543210' },
    });
    const response = await fetch(`${running.url}/v1/phonepe/subscriptions`, {
      method: 'POST',
      headers: { ...authed, 'content-type': 'application/json' },
      body,
    });
    const json = (await response.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe(ErrorCode.Config);
    expect(json.error.message).toContain('merchant-scheduled');
    expect(gateway.calls).toHaveLength(0);
  });
});
