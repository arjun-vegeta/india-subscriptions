/**
 * Seam 8: `buildService(env)` / `parseServiceEnv` / `runServe` -> the adapters. The adapters keep their credentials in
 * private fields, so the effect of every environment variable is observed where it matters: on the request each adapter
 * sends, the form it builds, the signatures it accepts.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CashfreeConfigSchema } from '../../src/providers/cashfree/schemas.js';
import { PayUConfigSchema } from '../../src/providers/payu/schemas.js';
import { RazorpayConfigSchema } from '../../src/providers/razorpay/schemas.js';
import { ContentType, Environment, ErrorCode, EventType, HeaderName, HttpMethod, IntervalUnit, Provider, SchedulingMode } from '../../src/constants.js';
import { CASHFREE_API_VERSION, CASHFREE_BASE_URLS, CashfreeHeader, CashfreePath } from '../../src/providers/cashfree/constants.js';
import { ConsentHashLayout, PAYU_API_URLS, PAYU_PAYMENT_URLS, PayUCommand, PAYU_ENACH_CANCELLATION_NOTIFICATION } from '../../src/providers/payu/constants.js';
import { RAZORPAY_BASE_URL, RAZORPAY_DEFAULT_DURATION_YEARS, RazorpayEndpoint } from '../../src/providers/razorpay/constants.js';
import { ScheduleStatus, scheduleIdFor } from '../../src/scheduler/index.js';
import { EnvVar, type EnvironmentVariables } from '../../src/service-config.js';
import { buildService, runServe, silentLogger } from '../../src/service.js';
import { basicAuth } from '../../src/http.js';
import {
  CASHFREE_ADAPTER_TEST,
  CASHFREE_WEBHOOK_TEST,
  CUSTOMER,
  RAZORPAY_ADAPTER_TEST,
  RAZORPAY_WEBHOOK_TEST,
  cashfreeWebhookRequest,
  fixtureJson,
  fixtureObject,
  fixtureText,
  hmacHex,
  plusHours,
  razorpayWebhookRequest,
  scriptedFetch,
  sha512Hex,
  signedPayuForm,
} from './helpers.js';
import { PAYU_MANDATE } from './fakes.js';

/** The service builds its adapters on the real clock, so a first charge must lie in the real future. */
const PAYU_DUE = '2099-01-15T04:30:00.000Z';
import { PayUPaymentMode, PayUPaymentSource, PayUPgType } from '../../src/providers/payu/constants.js';

const API_KEY = 'integration-api-key-0123456789';
const RZP = { id: 'rzp_cfg_key', secret: 'rzp_cfg_secret', hook: 'rzp_cfg_hook' };
const CF = { id: 'cf_cfg_id', secret: 'cf_cfg_secret', hook: 'cf_cfg_hook' };
const PAYU = { key: 'cfgKey1', salt: 'cfg-salt-never-real', success: 'https://merchant.example/payu/ok', failure: 'https://merchant.example/payu/no' };

const everything: EnvironmentVariables = {
  [EnvVar.ApiKey]: API_KEY,
  [EnvVar.Port]: '0',
  [EnvVar.RazorpayKeyId]: RZP.id,
  [EnvVar.RazorpayKeySecret]: RZP.secret,
  [EnvVar.RazorpayWebhookSecret]: RZP.hook,
  [EnvVar.RazorpayDefaultDurationYears]: '5',
  [EnvVar.RazorpayBaseUrl]: 'https://razorpay.proxy.example/',
  [EnvVar.CashfreeClientId]: CF.id,
  [EnvVar.CashfreeClientSecret]: CF.secret,
  [EnvVar.CashfreeEnvironment]: Environment.Live,
  [EnvVar.CashfreeWebhookSecret]: CF.hook,
  [EnvVar.CashfreeApiVersion]: '2025-01-01',
  [EnvVar.CashfreeBaseUrl]: 'https://cashfree.proxy.example/pg/',
  [EnvVar.PayuKey]: PAYU.key,
  [EnvVar.PayuSalt]: PAYU.salt,
  [EnvVar.PayuEnvironment]: Environment.Live,
  [EnvVar.PayuSuccessUrl]: PAYU.success,
  [EnvVar.PayuFailureUrl]: PAYU.failure,
  [EnvVar.PayuConsentHashLayout]: ConsentHashLayout.FourPipes,
  [EnvVar.PayuAcceptUnsignedWebhooks]: 'true',
  [EnvVar.PayuPaymentUrl]: 'https://payu.proxy.example/_payment',
  [EnvVar.PayuApiUrl]: 'https://payu.proxy.example/postservice.php?form=2',
};

const NOW = new Date('2026-11-17T05:00:00.000Z');
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'india-subscriptions-integration-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function build(env: EnvironmentVariables, respond: Parameters<typeof scriptedFetch>[0] = () => ({ status: 500 })) {
  const gateway = scriptedFetch(respond);
  return buildService(env, { fetch: gateway.fetch, logger: silentLogger }).then((service) => ({ service, ...gateway }));
}

describe('every environment variable reaches the adapter config', () => {
  it('the service config holds exactly the fields of each adapter\'s config schema, every one populated from its variable', async () => {
    const { service } = await build(everything);
    const gateways = service.config.gateways;
    expect(Object.keys(gateways[Provider.Razorpay] ?? {}).sort()).toEqual(Object.keys(RazorpayConfigSchema.shape).sort());
    expect(Object.keys(gateways[Provider.Cashfree] ?? {}).sort()).toEqual(Object.keys(CashfreeConfigSchema.shape).sort());
    expect(Object.keys(gateways[Provider.PayU] ?? {}).sort()).toEqual(Object.keys(PayUConfigSchema.shape).sort());
    for (const config of Object.values(gateways)) for (const value of Object.values(config as Record<string, unknown>)) expect(value).toBeDefined();
    expect(service.client.providers).toEqual([Provider.Razorpay, Provider.Cashfree, Provider.PayU]);
  });

  it('Razorpay: key pair as basic auth, base URL override, default duration (open-ended = 5 years of cycles), webhook secret', async () => {
    const plan = { ...fixtureJson(RAZORPAY_ADAPTER_TEST, 'CREATE_PLAN_RESPONSE'), period: 'monthly', interval: 1 };
    const { service, calls } = await build(everything, (call) =>
      call.url.endsWith(RazorpayEndpoint.plans) ? { json: plan } : { json: fixtureJson(RAZORPAY_ADAPTER_TEST, 'CREATE_SUBSCRIPTION_RESPONSE') },
    );
    await service.client.create(Provider.Razorpay, { plan: { name: 'Pro', amount: 49900, interval: { unit: IntervalUnit.Month, count: 1 } }, customer: CUSTOMER });
    expect(calls[0]?.url).toBe(`https://razorpay.proxy.example${RazorpayEndpoint.plans}`);
    expect(calls[0]?.headers[HeaderName.Authorization]).toBe(basicAuth(RZP.id, RZP.secret));
    expect(calls[1]?.json).toMatchObject({ total_count: 60 });
    const [event] = await service.client.webhooks.parse(Provider.Razorpay, razorpayWebhookRequest(fixtureText(RAZORPAY_WEBHOOK_TEST, 'WEBHOOK_HALTED'), RZP.hook));
    expect(event?.type).toBe(EventType.SubscriptionHalted);

    // Defaults: the public host, ten years, and no webhook secret means webhooks are refused with CONFIG.
    const minimal = await build({ [EnvVar.ApiKey]: API_KEY, [EnvVar.RazorpayKeyId]: RZP.id, [EnvVar.RazorpayKeySecret]: RZP.secret }, (call) =>
      call.url.endsWith(RazorpayEndpoint.plans) ? { json: plan } : { json: fixtureJson(RAZORPAY_ADAPTER_TEST, 'CREATE_SUBSCRIPTION_RESPONSE') },
    );
    await minimal.service.client.create(Provider.Razorpay, { plan: { name: 'Pro', amount: 49900, interval: { unit: IntervalUnit.Month, count: 1 } }, customer: CUSTOMER });
    expect(minimal.calls[0]?.url).toBe(`${RAZORPAY_BASE_URL}${RazorpayEndpoint.plans}`);
    expect(minimal.calls[1]?.json).toMatchObject({ total_count: RAZORPAY_DEFAULT_DURATION_YEARS * 12 });
    await expect(minimal.service.client.webhooks.parse(Provider.Razorpay, razorpayWebhookRequest('{}', RZP.hook))).rejects.toMatchObject({ code: ErrorCode.Config });
    expect(minimal.service.config.warnings.join('\n')).toContain(EnvVar.RazorpayWebhookSecret);
  });

  it('Cashfree: client id / secret / api version headers, base URL override, test vs live hosts, webhook secret and its fallback to the client secret', async () => {
    const plan = fixtureObject(CASHFREE_ADAPTER_TEST, 'PLAN_ENTITY_EXAMPLE');
    const { service, calls } = await build(everything, () => ({ json: plan }));
    await service.client.plans.get(Provider.Cashfree, 'plan_1');
    expect(calls[0]?.url).toBe(`https://cashfree.proxy.example/pg${CashfreePath.plan('plan_1')}`);
    expect(calls[0]?.headers).toMatchObject({ [CashfreeHeader.ClientId]: CF.id, [CashfreeHeader.ClientSecret]: CF.secret, [CashfreeHeader.ApiVersion]: '2025-01-01' });
    const body = fixtureText(CASHFREE_WEBHOOK_TEST, 'STATUS_CHANGED_2023');
    expect(await service.client.webhooks.parse(Provider.Cashfree, cashfreeWebhookRequest(body, CF.hook))).toHaveLength(1);
    await expect(service.client.webhooks.parse(Provider.Cashfree, cashfreeWebhookRequest(body, CF.secret))).rejects.toMatchObject({ code: ErrorCode.SignatureInvalid });

    for (const [environment, host] of [[Environment.Test, CASHFREE_BASE_URLS[Environment.Test]], [Environment.Live, CASHFREE_BASE_URLS[Environment.Live]]] as const) {
      const minimal = await build(
        { [EnvVar.ApiKey]: API_KEY, [EnvVar.CashfreeClientId]: CF.id, [EnvVar.CashfreeClientSecret]: CF.secret, [EnvVar.CashfreeEnvironment]: environment },
        () => ({ json: plan }),
      );
      await minimal.service.client.plans.get(Provider.Cashfree, 'plan_1');
      expect(minimal.calls[0]?.url).toBe(`${host}${CashfreePath.plan('plan_1')}`);
      expect(minimal.calls[0]?.headers[CashfreeHeader.ApiVersion]).toBe(CASHFREE_API_VERSION);
      // Without CASHFREE_WEBHOOK_SECRET webhooks verify with the client secret.
      expect(await minimal.service.client.webhooks.parse(Provider.Cashfree, cashfreeWebhookRequest(body, CF.secret))).toHaveLength(1);
    }
  });

  it('PayU: key and salt, environment hosts, surl / furl, consent hash layout, URL overrides, and opt-in for the unsigned eNACH webhook', async () => {
    const { service, calls } = await build(everything, () => ({ json: {} }));
    const subscription = await service.client.provider(Provider.PayU).createSubscription({
      reference: 'cfg_order',
      plan: { name: 'Pro monthly', amount: 49900, interval: { unit: IntervalUnit.Month, count: 1 } },
      customer: CUSTOMER,
      startAt: PAYU_DUE,
    });
    expect(calls).toHaveLength(0);
    const checkout = subscription.checkout as { url: string; fields: Record<string, string> };
    expect(checkout.url).toBe('https://payu.proxy.example/_payment');
    expect(checkout.fields).toMatchObject({ key: PAYU.key, surl: PAYU.success, furl: PAYU.failure });
    // The FOUR-pipe layout of PAYU_CONSENT_HASH_LAYOUT, computed independently.
    const f = checkout.fields;
    expect(f.hash).toBe(sha512Hex(`${f.key}|${f.txnid}|${f.amount}|${f.productinfo}|${f.firstname}|${f.email}|||||||||${f.si_details}|${PAYU.salt}`));
    expect(JSON.stringify(f)).not.toContain(PAYU.salt);

    // The salt verifies PayU's response hash; the checkout verification works with the configured key and salt.
    const result = signedPayuForm(
      { mihpayid: PAYU_MANDATE, mode: PayUPaymentMode.CreditCard, status: 'success', unmappedstatus: 'captured', txnid: 'cfg_order', amount: '2.00', productinfo: f.productinfo as string, firstname: f.firstname as string, email: CUSTOMER.email, udf1: '', udf2: '', udf3: '', udf4: '', udf5: '', payment_source: PayUPaymentSource.MandateRegistered, PG_TYPE: PayUPgType.CreditCard, cardToken: 't' },
      PAYU.key,
      PAYU.salt,
    );
    expect((await service.client.provider(Provider.PayU).verifyCheckout(result)).authorized).toBe(true);

    // PAYU_ACCEPT_UNSIGNED_WEBHOOKS=true: the unsigned eNACH cancellation is a cancellation.
    const unsigned = { rawBody: JSON.stringify({ statusCode: 1, notificationType: PAYU_ENACH_CANCELLATION_NOTIFICATION, status: 'CANCEL_SUCCESS', authPayuid: '26108200310' }), headers: {} };
    expect((await service.client.webhooks.parse(Provider.PayU, unsigned))[0]?.type).toBe(EventType.SubscriptionCancelled);

    // Defaults for a minimal PayU env: the test hosts of PAYU_ENVIRONMENT and the six-pipe layout; unsigned webhooks stay `unknown`.
    const minimal = await build({ [EnvVar.ApiKey]: API_KEY, [EnvVar.PayuKey]: PAYU.key, [EnvVar.PayuSalt]: PAYU.salt, [EnvVar.PayuEnvironment]: Environment.Test, [EnvVar.PayuSuccessUrl]: PAYU.success }, () => ({ json: {} }));
    const plain = await minimal.service.client.provider(Provider.PayU).createSubscription({ reference: 'cfg_min', plan: { name: 'Pro monthly', amount: 49900, interval: { unit: IntervalUnit.Month, count: 1 } }, customer: CUSTOMER });
    const mf = (plain.checkout as { url: string; fields: Record<string, string> });
    expect(mf.url).toBe(PAYU_PAYMENT_URLS[Environment.Test]);
    expect(mf.fields.furl).toBe(PAYU.success); // failureUrl falls back to successUrl
    expect(mf.fields.hash).toBe(sha512Hex(`${mf.fields.key}|${mf.fields.txnid}|${mf.fields.amount}|${mf.fields.productinfo}|${mf.fields.firstname}|${mf.fields.email}|||||||||||${mf.fields.si_details}|${PAYU.salt}`));
    expect((await minimal.service.client.webhooks.parse(Provider.PayU, unsigned))[0]?.type).toBe(EventType.Unknown);
    expect(PAYU_API_URLS[Environment.Test]).toContain('form=2');
  });
});

describe('the scheduler and the facade share the adapters built from the environment', () => {
  it('with SCHEDULER_STORE_FILE: client.scheduler IS service.scheduler, and its debits go out through the adapter configured from the environment (key, salt, hosts)', async () => {
    const env: EnvironmentVariables = {
      [EnvVar.ApiKey]: API_KEY,
      [EnvVar.PayuKey]: PAYU.key,
      [EnvVar.PayuSalt]: PAYU.salt,
      [EnvVar.PayuEnvironment]: Environment.Test,
      [EnvVar.PayuSuccessUrl]: PAYU.success,
      [EnvVar.SchedulerStoreFile]: join(dir, 'schedules.json'),
    };
    const seen: string[] = [];
    const { service, calls } = await build(env, (call) => {
      const command = call.form?.command;
      seen.push(String(command));
      if (command === PayUCommand.CheckMandateStatus) return { json: { status: 'active', amount: '499.00' } };
      return { status: 500 };
    });
    try {
      expect(service.scheduler).toBeDefined();
      expect(service.client.scheduler).toBe(service.scheduler);
      const subscription = await service.client.create(Provider.PayU, {
        reference: 'cfg_sched',
        plan: { name: 'Pro monthly', amount: 49900, interval: { unit: IntervalUnit.Month, count: 1 } },
        customer: CUSTOMER,
        startAt: PAYU_DUE,
      });
      expect(subscription.scheduling).toBe(SchedulingMode.Merchant);
      // The schedule is in the FILE store the service opened, and a tick through the scheduler talks to PayU with the env's credentials.
      const schedule = await service.scheduler!.get(scheduleIdFor(Provider.PayU, 'cfg_sched'));
      expect(schedule?.status).toBe(ScheduleStatus.PendingAuthorization);
      const subscriptionAgain = await service.scheduler!.find(Provider.PayU, 'cfg_sched');
      expect(subscriptionAgain?.id).toBe(schedule?.id);
      expect(calls).toHaveLength(0);
      expect(seen).toEqual([]);
      expect(plusHours(PAYU_DUE, 0)).toBe(PAYU_DUE);
    } finally {
      await service.close();
    }
  });

  it('PayU alone, with no SCHEDULER_STORE_FILE: the startup report says creating a subscription will be refused, and it is: CONFIG, before any gateway call', async () => {
    const env: EnvironmentVariables = { [EnvVar.ApiKey]: API_KEY, [EnvVar.PayuKey]: PAYU.key, [EnvVar.PayuSalt]: PAYU.salt, [EnvVar.PayuEnvironment]: Environment.Test, [EnvVar.PayuSuccessUrl]: PAYU.success };
    const { service, calls } = await build(env);
    expect(service.scheduler).toBeUndefined();
    expect(service.describe('http://127.0.0.1:8787').join('\n')).toMatch(/billing scheduler: OFF .*payu bills through the scheduler, so creating a subscription there will be refused/);
    const create = service.client.create(Provider.PayU, { reference: 'x', plan: { name: 'Pro', amount: 49900, interval: { unit: IntervalUnit.Month, count: 1 } }, customer: CUSTOMER });
    await expect(create).rejects.toMatchObject({ code: ErrorCode.Config, provider: Provider.PayU });
    await expect(service.client.tick()).rejects.toMatchObject({ code: ErrorCode.Config });
    expect(calls).toHaveLength(0);
    // Gateway webhooks are still verified and normalised (nothing to apply them to).
    const result = signedPayuForm(
      { mihpayid: PAYU_MANDATE, mode: PayUPaymentMode.CreditCard, status: 'success', unmappedstatus: 'captured', txnid: 'x', amount: '2.00', productinfo: 'Pro', firstname: 'Asha', email: CUSTOMER.email, udf1: '', udf2: '', udf3: '', udf4: '', udf5: '', payment_source: PayUPaymentSource.MandateRegistered, PG_TYPE: PayUPgType.CreditCard, cardToken: 't' },
      PAYU.key,
      PAYU.salt,
    );
    const events = await service.client.webhooks.handle(Provider.PayU, { rawBody: new URLSearchParams(result).toString(), headers: {} });
    expect(events[0]?.type).toBe(EventType.SubscriptionAuthorized);
  });

  it('Cashfree alone, with no store: a periodic plan works, a merchant-scheduled one is refused before any gateway call', async () => {
    const env: EnvironmentVariables = { [EnvVar.ApiKey]: API_KEY, [EnvVar.CashfreeClientId]: CF.id, [EnvVar.CashfreeClientSecret]: CF.secret, [EnvVar.CashfreeEnvironment]: Environment.Test };
    const { service, calls } = await build(env);
    const refused = service.client.create(Provider.Cashfree, {
      reference: 'od',
      plan: { name: 'On demand', amount: 49900, interval: { unit: IntervalUnit.Month, count: 1 }, scheduling: SchedulingMode.Merchant },
      customer: { ...CUSTOMER },
    });
    await expect(refused).rejects.toMatchObject({ code: ErrorCode.Config });
    expect(calls).toHaveLength(0);
  });
});

describe('runServe over a real socket', () => {
  it('serves the routes with the environment\'s credentials: the raw PayU form webhook arrives byte for byte through node:http, and the API key is enforced', async () => {
    const env: EnvironmentVariables = {
      [EnvVar.ApiKey]: API_KEY,
      [EnvVar.Host]: '127.0.0.1',
      [EnvVar.Port]: '0',
      [EnvVar.PayuKey]: PAYU.key,
      [EnvVar.PayuSalt]: PAYU.salt,
      [EnvVar.PayuEnvironment]: Environment.Test,
      [EnvVar.PayuSuccessUrl]: PAYU.success,
      [EnvVar.SchedulerStoreFile]: join(dir, 'serve.json'),
      [EnvVar.SchedulerTickSeconds]: '86400',
    };
    const running = await runServe({ env, fetch: scriptedFetch(() => ({ status: 500 })).fetch, logger: silentLogger });
    try {
      const authed = { [HeaderName.Authorization]: `Bearer ${API_KEY}`, [HeaderName.ContentType]: ContentType.Json };
      expect((await fetch(`${running.url}/v1/providers`)).status).toBe(401);
      const created = await fetch(`${running.url}/v1/payu/subscriptions`, {
        method: HttpMethod.Post,
        headers: authed,
        body: JSON.stringify({ reference: 'socket_1', plan: { name: 'Pro monthly', amount: 49900, interval: { unit: IntervalUnit.Month, count: 1 } }, customer: CUSTOMER, startAt: PAYU_DUE }),
      });
      expect(created.status).toBe(201);
      const consent = signedPayuForm(
        { mihpayid: PAYU_MANDATE, mode: PayUPaymentMode.CreditCard, status: 'success', unmappedstatus: 'captured', txnid: 'socket_1', amount: '2.00', productinfo: 'Pro monthly', firstname: 'Asha Rao', email: CUSTOMER.email, udf1: '', udf2: '', udf3: '', udf4: '', udf5: '', payment_source: PayUPaymentSource.MandateRegistered, PG_TYPE: PayUPgType.CreditCard, cardToken: 't' },
        PAYU.key,
        PAYU.salt,
      );
      const hook = await fetch(`${running.url}/v1/payu/webhooks`, { method: HttpMethod.Post, headers: { [HeaderName.ContentType]: ContentType.Form }, body: new URLSearchParams(consent).toString() });
      expect(await hook.json()).toEqual({ received: 1 });
      const schedule = await running.service.scheduler!.get(scheduleIdFor(Provider.PayU, 'socket_1'));
      expect(schedule?.status).toBe(ScheduleStatus.Active);
      expect(hmacHex('k', 'v')).toHaveLength(64);
    } finally {
      await running.stop();
    }
  });
});
