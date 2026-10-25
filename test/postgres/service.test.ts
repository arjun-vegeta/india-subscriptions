/**
 * The HTTP service on a real PostgreSQL database (`DATABASE_URL`), through `runServe`: it migrates and serves, several
 * instances share one database (a purchase started on one is completed on the other, a schedule registered on one is ticked by
 * the other, instances ticking at once raise one debit, a queued report is sent by exactly one of them), and a restart keeps
 * the state. Gateways and Google are scripted; PostgreSQL is not.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { Environment, IntervalUnit, PaymentMethod, Provider } from '../../src/constants.js';
import type { FetchLike } from '../../src/http.js';
import { LATEST_MIGRATION_VERSION, PostgresRoutingStatsStore, PostgresTable } from '../../src/postgres/index.js';
import { ApiPath } from '../../src/server/constants.js';
import { PayUCommand } from '../../src/providers/payu/constants.js';
import {
  EntitlementsSchema,
  FlushResultSchema,
  PurchaseSessionSchema,
  ReportStatus,
  SessionStatus,
  firstTransactionId,
} from '../../src/purchase/index.js';
import { RouteOutcomeKind } from '../../src/routing/index.js';
import { CycleStatus, ScheduleStatus, scheduleIdFor } from '../../src/scheduler/index.js';
import { EnvVar, type EnvironmentVariables } from '../../src/service-config.js';
import { runServe, type Logger, type RunningService } from '../../src/service.js';
import { SERVICE_PRIVATE_PEM } from '../googleplay/helpers.js';
import { CUSTOMER as PAYU_CUSTOMER, PAYU_ACCOUNT } from '../integration/helpers.js';
import { FakePayU, PAYU_COMPOSITE, PAYU_REFERENCE } from '../integration/fakes.js';
import { RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET, storeFakes, subscriptionCallback } from '../integration/store-fakes.js';
import { DATABASE_URL, describePostgres, newPool, sleep, uniqueName } from './helpers.js';

const API_KEY = 'service-api-key-0123456789';
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
};
const TABLE_COUNT = Object.values(PostgresTable).length;
const GATEWAY_LATENCY_MS = 150;

function recordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (m) => void lines.push(`info: ${m}`),
    warn: (m) => void lines.push(`warn: ${m}`),
    error: (m) => void lines.push(`error: ${m}`),
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await sleep(20);
  }
}

describePostgres('the service on PostgreSQL', () => {
  const schema = uniqueName('ffu4_test_service_');
  const pool = newPool({ max: 4 });
  const tables = (): string[] => Object.values(PostgresTable).filter((name) => name !== PostgresTable.Migrations).map((name) => `"${schema}"."india_subscriptions_${name}"`);
  let dir: string;
  let purchasesFile: string;
  const started: RunningService[] = [];

  /** What Google and the gateways answer, shared by every instance of one test: they are the same outside world. */
  function world() {
    const fakes = storeFakes();
    const payu = new FakePayU();
    const delayed: FetchLike = async (url, init) => {
      const host = new URL(url).host;
      if (host === 'test.payu.in') {
        await sleep(GATEWAY_LATENCY_MS);
        return payu.gateway.fetch(url, init);
      }
      if (host === 'androidpublisher.googleapis.com') await sleep(GATEWAY_LATENCY_MS);
      return fakes.fetch(url, init);
    };
    return { fakes, payu, fetch: delayed };
  }
  type World = ReturnType<typeof world>;

  const environment = (): EnvironmentVariables => ({
    [EnvVar.ApiKey]: API_KEY,
    [EnvVar.Port]: '0',
    [EnvVar.RazorpayKeyId]: 'rzp_test_key',
    [EnvVar.RazorpayKeySecret]: RAZORPAY_KEY_SECRET,
    [EnvVar.RazorpayWebhookSecret]: RAZORPAY_WEBHOOK_SECRET,
    [EnvVar.PayuKey]: PAYU_ACCOUNT.key,
    [EnvVar.PayuSalt]: PAYU_ACCOUNT.salt,
    [EnvVar.PayuEnvironment]: Environment.Test,
    [EnvVar.PayuSuccessUrl]: PAYU_ACCOUNT.successUrl,
    [EnvVar.GooglePlayPackageName]: 'com.example.app',
    [EnvVar.GooglePlayClientEmail]: 'billing@example-project.iam.gserviceaccount.com',
    [EnvVar.GooglePlayPrivateKey]: SERVICE_PRIVATE_PEM.replace(/\n/g, '\\n'),
    [EnvVar.GooglePlayEnvironment]: Environment.Test,
    [EnvVar.GooglePlayPushAudience]: `${BASE}/v1/google_play/webhooks`,
    [EnvVar.GooglePlayPushServiceAccountEmail]: 'pubsub-push@example-project.iam.gserviceaccount.com',
    [EnvVar.PurchasesFile]: purchasesFile,
    [EnvVar.PublicBaseUrl]: BASE,
    [EnvVar.DatabaseUrl]: DATABASE_URL,
    [EnvVar.DatabaseSchema]: schema,
    // The loop ticks once at start-up and then every hour: every later tick in these tests is the test's own.
    [EnvVar.SchedulerTickSeconds]: '3600',
  });

  async function serve(w: World, logger?: Logger): Promise<Instance> {
    const running = await runServe({ env: environment(), fetch: w.fetch, logger: logger ?? recordingLogger() });
    started.push(running);
    return new Instance(running);
  }

  class Instance {
    constructor(readonly running: RunningService) {}
    api(method: string, path: string, options: { json?: unknown; form?: Record<string, string>; auth?: boolean } = {}): Promise<Response> {
      return fetch(`${this.running.url}${path}`, {
        method,
        redirect: 'manual',
        headers: {
          ...(options.auth === false ? {} : { authorization: `Bearer ${API_KEY}` }),
          ...(options.json !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(options.form !== undefined ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
        body: options.json !== undefined ? JSON.stringify(options.json) : options.form !== undefined ? new URLSearchParams(options.form).toString() : undefined,
      });
    }
    async session(id: string) {
      return PurchaseSessionSchema.parse(await (await this.api('GET', `/v1/purchases/${id}`)).json());
    }
    async flush() {
      return FlushResultSchema.parse(await (await this.api('POST', '/v1/purchases/flush')).json());
    }
    async stop(): Promise<void> {
      await this.running.stop();
    }
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'india-subscriptions-pg-service-'));
    purchasesFile = join(dir, 'purchases.json');
    await writeFile(purchasesFile, JSON.stringify({ catalog: [MONTHLY], policy: { android: 'user_choice' }, routing: { priority: [Provider.Razorpay] } }));
  });

  afterEach(async () => {
    await Promise.all(started.splice(0).map((running) => running.stop()));
  });

  afterAll(async () => {
    try {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await pool.end().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  const empty = async (): Promise<void> => {
    const exists = await pool.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema]);
    if (exists.rows.length > 0) await pool.query(`TRUNCATE ${tables().join(', ')}`);
  };
  beforeEach(empty);

  it('creates the schema and tables at start-up, records the migration, and serves', async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    const logger = recordingLogger();
    const one = await serve(world(), logger);

    const created = await pool.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1`, [schema]);
    expect(created.rows[0]).toEqual({ n: TABLE_COUNT });
    const versions = await pool.query(`SELECT version FROM "${schema}"."india_subscriptions_migrations" ORDER BY version`);
    expect(versions.rows.map((row) => row['version'])).toEqual(Array.from({ length: LATEST_MIGRATION_VERSION }, (_, i) => i + 1));

    expect((await one.api('GET', ApiPath.Health, { auth: false })).status).toBe(200);
    expect((await one.api('GET', '/v1/providers')).status).toBe(200);
    expect((await one.api('GET', '/v1/entitlements/nobody')).status).toBe(200);
    const output = logger.lines.join('\n');
    expect(output).toContain('billing scheduler: on (store PostgreSQL');
    expect(output).toContain('purchases: on (file ');
    expect(output).toContain('state PostgreSQL');
    for (const secret of [DATABASE_URL as string, new URL(DATABASE_URL as string).password].filter((value) => value !== '')) expect(output).not.toContain(secret);
    expect(logger.lines.filter((line) => line.startsWith('error:'))).toEqual([]);

    // A second start finds the schema current and changes nothing.
    await one.stop();
    started.length = 0;
    const two = await serve(world());
    expect((await pool.query(`SELECT count(*)::int AS n FROM "${schema}"."india_subscriptions_migrations"`)).rows[0]).toEqual({ n: LATEST_MIGRATION_VERSION });
    await two.stop();
  });

  it('starting several instances at the same moment on an empty database leaves one consistent schema', async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    const w = world();
    const instances = await Promise.all([serve(w), serve(w), serve(w), serve(w)]);
    expect(instances).toHaveLength(4);
    expect((await pool.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1`, [schema])).rows[0]).toEqual({ n: TABLE_COUNT });
    expect((await pool.query(`SELECT count(*)::int AS n FROM "${schema}"."india_subscriptions_migrations"`)).rows[0]).toEqual({ n: LATEST_MIGRATION_VERSION });
  });

  it('a purchase started on one instance is completed on another, and the report it queues is sent by exactly one of three', async () => {
    const w = world();
    const [a, b, c] = [await serve(w), await serve(w), await serve(w)];

    const first = PurchaseSessionSchema.parse(
      await (await a.api('POST', '/v1/purchases', { json: { platform: 'android', product: MONTHLY.key, customer: CUSTOMER, customerRef: 'cust_1', returnUrl: APP_RETURN } })).json(),
    );
    expect(first.status).toBe(SessionStatus.Open);
    const chosen = PurchaseSessionSchema.parse(
      await (await a.api('POST', `/v1/purchases/${first.id}/alternative`, { json: { externalTransactionToken: TOKEN } })).json(),
    );
    const subscriptionId = chosen.options[1]!.handle;

    // Instance B knows the session instance A made, and completes it: the customer's browser may reach any instance.
    expect((await b.session(first.id)).options).toHaveLength(2);
    const back = await b.api('POST', `/checkout/${first.id}/return`, { auth: false, form: subscriptionCallback(subscriptionId) });
    expect(back.status).toBe(303);
    expect(new URL(back.headers.get('location') ?? '').searchParams.get('status')).toBe(SessionStatus.Completed);

    // Every instance answers the same: the session, and what the customer now owns.
    for (const instance of [a, b, c]) {
      expect(await instance.session(first.id)).toMatchObject({ status: SessionStatus.Completed, provider: Provider.Razorpay, subscriptionId });
      const owned = EntitlementsSchema.parse(await (await instance.api('GET', '/v1/entitlements/cust_1')).json());
      expect(owned.active).toBe(true);
      expect(owned.items).toHaveLength(1);
    }

    // The report is in the database and nothing has gone to Google yet. All three instances flush at the same moment.
    const reportId = firstTransactionId(first.id);
    expect((await pool.query(`SELECT status FROM "${schema}"."india_subscriptions_reports" WHERE id = $1`, [reportId])).rows).toEqual([{ status: ReportStatus.Queued }]);
    expect(w.fakes.google).toEqual([]);
    const results = await Promise.all([a.flush(), b.flush(), c.flush()]);
    expect(results.reduce((total, result) => total + result.sent, 0)).toBe(1);
    expect(w.fakes.google).toHaveLength(1);
    expect(w.fakes.google[0]).toMatchObject({ method: 'POST', query: { externalTransactionId: reportId } });
    expect((await pool.query(`SELECT status FROM "${schema}"."india_subscriptions_reports" WHERE id = $1`, [reportId])).rows).toEqual([{ status: ReportStatus.Sent }]);
    expect((await Promise.all([a.flush(), b.flush()])).map((result) => result.sent)).toEqual([0, 0]);
    expect(w.fakes.google).toHaveLength(1);

    // Routing statistics are shared too: the order was counted by A and the authorisation by B, and a store of its own sees both.
    const stats = new PostgresRoutingStatsStore(pool, { schema });
    const since = new Date(Date.now() - 3_600_000).toISOString();
    expect(await stats.read({ provider: Provider.Razorpay, kind: RouteOutcomeKind.Request }, since)).toMatchObject({ success: 1 });
    expect(await stats.read({ provider: Provider.Razorpay, kind: RouteOutcomeKind.Authorization }, since)).toMatchObject({ success: 1 });
  });

  it('a schedule registered on one instance is ticked by another, and instances ticking at once raise one debit', async () => {
    const w = world();
    const [a, b, c] = [await serve(w), await serve(w), await serve(w)];
    const register = (reference: string, mandate: string) =>
      a.running.service.scheduler!.register({
        provider: Provider.PayU,
        subscriptionId: `${PaymentMethod.Card}:${mandate}`,
        reference,
        amount: 49900,
        interval: { unit: IntervalUnit.Month, count: 1 },
        // A debit that is already due, with no waiting between the notification and the debit.
        firstChargeAt: new Date(Date.now() - 3_600_000).toISOString(),
        customer: PAYU_CUSTOMER,
        notifyLeadHours: 0,
        minNoticeHours: 0,
      });
    const cyclesOf = async (instance: Instance, reference: string) =>
      (await instance.running.service.scheduler!.listCycles(scheduleIdFor(Provider.PayU, reference)))[0]?.status;

    // Registered on A, ticked by B alone: B finds it due, notifies and debits.
    await register('order_first', '1001');
    expect(await c.running.service.scheduler!.get(scheduleIdFor(Provider.PayU, 'order_first'))).toMatchObject({ status: ScheduleStatus.Active });
    expect(await b.running.service.client.tick()).toMatchObject({ due: 1, notified: 1, charged: 1, succeeded: 1 });
    expect(w.payu.commandsNamed(PayUCommand.PreDebit)).toHaveLength(1);
    expect(w.payu.executedDebits).toBe(1);

    // A second schedule, ticked by all three instances at the same moment: one debit.
    await register('order_second', '1002');
    const ticks = await Promise.all([a, b, c].map((instance) => instance.running.service.client.tick()));
    expect(ticks.reduce((total, tick) => total + tick.charged, 0)).toBe(1);
    expect(ticks.reduce((total, tick) => total + tick.locked, 0)).toBeGreaterThan(0);
    expect(w.payu.executedDebits).toBe(2);
    expect(w.payu.commandsNamed(PayUCommand.SiTransaction)).toHaveLength(2);

    // Whoever asks sees both debits as paid, and ticking again has nothing to do.
    for (const instance of [a, b, c]) {
      expect(await cyclesOf(instance, 'order_first')).toBe(CycleStatus.Succeeded);
      expect(await cyclesOf(instance, 'order_second')).toBe(CycleStatus.Succeeded);
      expect(await instance.running.service.scheduler!.get(scheduleIdFor(Provider.PayU, 'order_second'))).toMatchObject({ paidCycles: 1 });
    }
    expect((await Promise.all([a, b].map((instance) => instance.running.service.client.tick()))).map((tick) => tick.charged)).toEqual([0, 0]);
    expect(w.payu.executedDebits).toBe(2);
  });

  it('a restart keeps schedules, sessions, entitlements, the report queue and the routing statistics', async () => {
    const w = world();
    const one = await serve(w);
    const session = PurchaseSessionSchema.parse(
      await (await one.api('POST', '/v1/purchases', { json: { platform: 'android', product: MONTHLY.key, customer: CUSTOMER, customerRef: 'cust_9', returnUrl: APP_RETURN } })).json(),
    );
    const chosen = PurchaseSessionSchema.parse(
      await (await one.api('POST', `/v1/purchases/${session.id}/alternative`, { json: { externalTransactionToken: TOKEN } })).json(),
    );
    await one.api('POST', `/checkout/${session.id}/return`, { auth: false, form: subscriptionCallback(chosen.options[1]!.handle) });
    await one.running.service.scheduler!.register({
      provider: Provider.PayU,
      subscriptionId: PAYU_COMPOSITE,
      reference: PAYU_REFERENCE,
      amount: 49900,
      interval: { unit: IntervalUnit.Month, count: 1 },
      firstChargeAt: new Date(Date.now() + 30 * 24 * 3_600_000).toISOString(),
      customer: PAYU_CUSTOMER,
    });
    await one.stop();
    started.length = 0;

    const logger = recordingLogger();
    const two = await serve(w, logger);
    expect(await two.session(session.id)).toMatchObject({ status: SessionStatus.Completed });
    expect(EntitlementsSchema.parse(await (await two.api('GET', '/v1/entitlements/cust_9')).json()).active).toBe(true);
    expect(await two.running.service.scheduler!.get(scheduleIdFor(Provider.PayU, PAYU_REFERENCE))).toMatchObject({ status: ScheduleStatus.Active });
    // The report queued before the restart was still queued: the new instance sends it on its first tick.
    await waitFor(() => w.fakes.google.length > 0);
    expect(w.fakes.google).toHaveLength(1);
    expect(await two.flush()).toMatchObject({ sent: 0 });
    expect((await pool.query(`SELECT status FROM "${schema}"."india_subscriptions_reports"`)).rows).toEqual([{ status: ReportStatus.Sent }]);
    const stats = new PostgresRoutingStatsStore(pool, { schema });
    expect(await stats.read({ provider: Provider.Razorpay, kind: RouteOutcomeKind.Authorization }, new Date(Date.now() - 3_600_000).toISOString())).toMatchObject({ success: 1 });
    expect(logger.lines.filter((line) => line.startsWith('error:'))).toEqual([]);
  });
});
