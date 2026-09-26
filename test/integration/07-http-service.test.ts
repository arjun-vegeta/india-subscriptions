/**
 * Seam 7: the HTTP service (`createHandler`) over the real facade, real adapters and real scheduler. JSON in and out is
 * validated against the schemas PUBLISHED in the OpenAPI document (what a generated client is built from); gateway
 * webhooks go through the raw route with real signatures: Razorpay and Cashfree headers, PayU's form-encoded body and
 * JSON mandate webhooks; and the events forwarder's signed envelope is verified the way a receiver would.
 */
import { describe, expect, it } from 'vitest';
import { CheckoutKind, ContentType, ErrorCode, EventType, HeaderName, HttpMethod, IntervalUnit, Provider, SchedulingMode, SubscriptionStatus } from '../../src/constants.js';
import { EventsDeliverySchema, EventsDeliveryKind } from '../../src/events-envelope.js';
import { EventsHeader, createEventsForwarder, verifyEventsSignature } from '../../src/events-webhook.js';
import { CashfreePaymentStatus } from '../../src/providers/cashfree/constants.js';
import { RazorpayEndpoint, RazorpayNoteKey } from '../../src/providers/razorpay/constants.js';
import { PayUCommand, PayUUpiMandateAction, PayUPaymentMode, PayUPgType } from '../../src/providers/payu/constants.js';
import { ScheduleStatus, chargeIdFor } from '../../src/scheduler/index.js';
import { ApiPath, AuthMode, HttpStatus, OperationId, ServerErrorCode, createHandler, routes } from '../../src/server/index.js';
import { CF_FIRST_DUE, PAYU_COMPOSITE, PAYU_DUE, PAYU_REFERENCE, consentResult, setupCashfree, setupPayu } from './fakes.js';
import {
  CUSTOMER,
  Clock,
  RAZORPAY_ACCOUNT,
  RAZORPAY_ADAPTER_TEST,
  RAZORPAY_WEBHOOK_TEST,
  cashfreeWebhookRequest,
  fixtureJson,
  fixtureText,
  hmacHex,
  plusHours,
  published,
  razorpayProvider,
  razorpayWebhookRequest,
  scriptedFetch,
  wire,
  CASHFREE_ACCOUNT,
  CASHFREE_WEBHOOK_TEST,
  pathOf,
} from './helpers.js';
import type { Subscriptions } from '../../src/client.js';

const API_KEY = 'integration-api-key-0123456789';
const BASE = 'http://localhost';

function api(client: Subscriptions, onEvents?: Parameters<typeof createHandler>[0]['onEvents']) {
  const handler = createHandler({ client, apiKey: API_KEY, onEvents });
  return async (method: string, path: string, options: { json?: unknown; body?: string; headers?: Record<string, string>; auth?: boolean } = {}) => {
    const headers: Record<string, string> = { ...(options.auth === false ? {} : { [HeaderName.Authorization]: `Bearer ${API_KEY}` }), ...options.headers };
    let body = options.body;
    if (options.json !== undefined) {
      body = JSON.stringify(options.json);
      headers[HeaderName.ContentType] = ContentType.Json;
    }
    const response = await handler(new Request(`${BASE}${path}`, { method, headers, body }));
    const text = await response.text();
    return { status: response.status, text, json: text ? (JSON.parse(text) as any) : undefined };
  };
}

/** Sends `json` as the request body only after it validates against the published request schema, and checks the answer likewise. */
async function exchange(call: ReturnType<typeof api>, operationId: string, method: string, path: string, json?: unknown) {
  const schemas = published(operationId);
  if (json !== undefined && schemas.request) expect(schemas.request.safeParse(json).success, `request body of ${operationId} against the published schema`).toBe(true);
  const reply = await call(method, path, json === undefined ? {} : { json });
  const validator = schemas.response[String(reply.status)];
  expect(validator, `a published response schema for ${operationId} ${reply.status}`).toBeDefined();
  const verdict = validator!.safeParse(reply.json);
  expect(verdict.success, `${operationId} ${reply.status} body against the published schema: ${verdict.success ? '' : verdict.error.message}`).toBe(true);
  return reply;
}

describe('HTTP service, Razorpay', () => {
  const NOW = '2026-03-13T10:00:00.000Z';
  const SUB = 'sub_00000000000001';
  const gatewayFetch = () => {
    const doc = (name: string) => fixtureJson(RAZORPAY_ADAPTER_TEST, name);
    const plan = { ...doc('CREATE_PLAN_RESPONSE'), id: 'plan_00000000000001', period: 'monthly', interval: 1, item: { ...doc('CREATE_PLAN_RESPONSE').item, amount: 49900, unit_amount: 49900 } };
    return scriptedFetch((call) => {
      const key = `${call.method} ${pathOf(call.url).split('?')[0]}`;
      if (key === `POST ${RazorpayEndpoint.plans}`) return { json: plan };
      if (key === `POST ${RazorpayEndpoint.subscriptions}`) return { json: { ...doc('CREATE_SUBSCRIPTION_RESPONSE'), notes: { [RazorpayNoteKey.Reference]: 'order_1' } } };
      if (key === `GET ${RazorpayEndpoint.subscription(SUB)}`) return { json: doc('FETCH_SUBSCRIPTION_RESPONSE') };
      if (key === `POST ${RazorpayEndpoint.cancelSubscription(SUB)}`) return { json: doc('CANCEL_RESPONSE') };
      if (key === `GET ${RazorpayEndpoint.invoices}`) return { json: doc('INVOICES_RESPONSE') };
      throw new Error(`unexpected ${key}`);
    });
  };

  it('routes: create, verify, get, charges, cancel, and the raw webhook with a real signature; every JSON body matches its published schema', async () => {
    const clock = new Clock(NOW);
    const gateway = gatewayFetch();
    const events: Array<[Provider, EventType[]]> = [];
    const { subs } = wire(razorpayProvider(gateway.fetch, clock), clock, gateway.calls);
    const call = api(subs, (provider, list) => void events.push([provider, list.map((event) => event.type)]));

    expect((await call(HttpMethod.Get, ApiPath.Health, { auth: false })).status).toBe(HttpStatus.Ok);
    expect((await call(HttpMethod.Get, ApiPath.Providers, { auth: false })).json.error.code).toBe(ServerErrorCode.Unauthorized);

    const created = await exchange(call, OperationId.CreateSubscription, HttpMethod.Post, '/v1/razorpay/subscriptions', {
      reference: 'order_1',
      plan: { name: 'Pro monthly', amount: 49900, interval: { unit: IntervalUnit.Month, count: 1 } },
      customer: CUSTOMER,
      totalCycles: 12,
    });
    expect(created.status).toBe(HttpStatus.Created);
    expect(created.json).toMatchObject({ id: SUB, reference: 'order_1', scheduling: SchedulingMode.Gateway });

    const payment = 'pay_AuthorisationOne';
    const verified = await exchange(call, OperationId.VerifyCheckout, HttpMethod.Post, '/v1/razorpay/checkout/verify', {
      result: { razorpay_payment_id: payment, razorpay_subscription_id: SUB, razorpay_signature: hmacHex(RAZORPAY_ACCOUNT.keySecret, `${payment}|${SUB}`) },
      expectedSubscriptionId: SUB,
    });
    expect(verified.json).toMatchObject({ authorized: true, subscriptionId: SUB });
    const forged = await call(HttpMethod.Post, '/v1/razorpay/checkout/verify', { json: { result: { razorpay_payment_id: payment, razorpay_subscription_id: SUB, razorpay_signature: 'x' } } });
    expect(forged.status).toBe(HttpStatus.Unauthorized);
    expect(forged.json.error.code).toBe(ErrorCode.SignatureInvalid);

    expect((await exchange(call, OperationId.GetSubscription, HttpMethod.Get, `/v1/razorpay/subscriptions/${SUB}`)).json.status).toBe(SubscriptionStatus.Active);
    expect((await exchange(call, OperationId.ListCharges, HttpMethod.Get, `/v1/razorpay/subscriptions/${SUB}/charges?limit=5`)).json).toBeInstanceOf(Array);
    expect((await exchange(call, OperationId.CancelSubscription, HttpMethod.Post, `/v1/razorpay/subscriptions/${SUB}/cancel`)).json.status).toBe(SubscriptionStatus.Cancelled);
    // A merchant-only operation the gateway cannot do is a 422 with the library's code.
    const unsupported = await call(HttpMethod.Post, '/v1/razorpay/charges', { json: { subscriptionId: SUB, chargeId: 'c', amount: 100 } });
    expect(unsupported.status).toBe(HttpStatus.Unprocessable);
    expect(unsupported.json.error.code).toBe(ErrorCode.Unsupported);

    // The raw webhook route: no API key, authenticated by the signature over the EXACT bytes (pretty-printed fixture, CRLF, non-ASCII).
    const crlf = fixtureText(RAZORPAY_WEBHOOK_TEST, 'WEBHOOK_CHARGED').replaceAll('\n', '\r\n');
    const withUnicode = `${crlf.replace('Notes for Internal Reference', 'Notes for Internal Reference \u2026 caf\u00e9')}\r\n`;
    const request = razorpayWebhookRequest(withUnicode, RAZORPAY_ACCOUNT.webhookSecret, 'evt_http_1');
    const ok = await call(HttpMethod.Post, '/v1/razorpay/webhooks', { auth: false, body: request.rawBody, headers: request.headers });
    expect(ok.status).toBe(HttpStatus.Ok);
    expect(published(OperationId.ReceiveWebhook).response['200']?.safeParse(ok.json).success).toBe(true);
    expect(ok.json).toEqual({ received: 1 });
    expect(events).toEqual([[Provider.Razorpay, [EventType.SubscriptionCharged]]]);
    const tampered = await call(HttpMethod.Post, '/v1/razorpay/webhooks', { auth: false, body: `${request.rawBody} `, headers: request.headers });
    expect(tampered.status).toBe(HttpStatus.Unauthorized);
    expect(events).toHaveLength(1);
    // A gateway that is not configured is a 404, not a crash.
    expect((await call(HttpMethod.Post, '/v1/payu/webhooks', { auth: false, body: 'x=1' })).status).toBe(HttpStatus.NotFound);
  });

  it('every route except health, the OpenAPI document and the gateway webhooks demands the API key', async () => {
    const clock = new Clock(NOW);
    const gateway = gatewayFetch();
    const { subs } = wire(razorpayProvider(gateway.fetch, clock), clock, gateway.calls);
    const call = api(subs);
    for (const route of routes) {
      const path = route.path.replace('{provider}', 'razorpay').replace('{subscriptionId}', SUB).replace('{planId}', 'p').replace('{chargeId}', 'c');
      const reply = await call(route.method, path, { auth: false, ...(route.requestBody ? { json: {} } : {}) });
      if (route.auth === AuthMode.Bearer) expect(reply.status, `${route.method} ${route.path}`).toBe(HttpStatus.Unauthorized);
      if (route.auth === AuthMode.None) expect(reply.status, `${route.method} ${route.path}`).toBe(HttpStatus.Ok);
    }
  });
});

describe('HTTP service, Cashfree on-demand (with the scheduler)', () => {
  it('create -> raw status webhook with Cashfree headers activates -> tick raises the charge -> the payment webhook settles it', async () => {
    const t = setupCashfree();
    const call = api(t.subs);
    const created = await exchange(call, OperationId.CreateSubscription, HttpMethod.Post, '/v1/cashfree/subscriptions', {
      reference: t.reference,
      plan: { name: 'On demand monthly', amount: 49900, interval: { unit: IntervalUnit.Month, count: 1 }, scheduling: SchedulingMode.Merchant },
      customer: { ...CUSTOMER, email: 'sushane.yadav@abc.com' },
      startAt: CF_FIRST_DUE,
    });
    expect(created.json).toMatchObject({ id: t.reference, scheduling: SchedulingMode.Merchant, amount: 49900, startAt: CF_FIRST_DUE });
    expect((await t.scheduler.get(t.scheduleId))?.status).toBe(ScheduleStatus.PendingAuthorization);

    // The service's own verify route (return URL) and the gateway's webhook route both lead to activation.
    const body = JSON.parse(fixtureText(CASHFREE_WEBHOOK_TEST, 'STATUS_CHANGED_2023'));
    body.data.subscription_details.subscription_id = t.reference;
    const request = cashfreeWebhookRequest(JSON.stringify(body), CASHFREE_ACCOUNT.webhookSecret);
    const bad = await call(HttpMethod.Post, '/v1/cashfree/webhooks', { auth: false, body: request.rawBody, headers: { ...request.headers, 'x-webhook-signature': 'AAAA' } });
    expect(bad.status).toBe(HttpStatus.Unauthorized);
    const good = await call(HttpMethod.Post, '/v1/cashfree/webhooks', { auth: false, body: request.rawBody, headers: request.headers });
    expect(good).toMatchObject({ status: HttpStatus.Ok, json: { received: 1 } });
    expect((await t.scheduler.get(t.scheduleId))?.status).toBe(ScheduleStatus.Active);

    // tick over HTTP
    t.clock.set(plusHours(CF_FIRST_DUE, -48));
    const tick = await exchange(call, OperationId.RunSchedulerTick, HttpMethod.Post, '/v1/scheduler/tick', { limit: 10 });
    expect(tick.json).toMatchObject({ charged: 1, awaiting: 1 });
    expect(t.fake.chargeCalls).toHaveLength(1);

    // the payment webhook of that charge
    const paid = await t.paymentWebhook('PAYMENT_SUCCESS_2026', chargeIdFor(t.scheduleId, 0, 1), CashfreePaymentStatus.Success);
    expect(paid[0]?.type).toBe(EventType.SubscriptionCharged);
    const got = await exchange(call, OperationId.GetSubscription, HttpMethod.Get, `/v1/cashfree/subscriptions/${t.reference}`);
    expect(got.json).toMatchObject({ paidCycles: 1 });
  });
});

describe('HTTP service, PayU', () => {
  const formBody = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

  it('create -> verify route (form fields as JSON) -> form-encoded webhook (content-type x-www-form-urlencoded) -> tick', async () => {
    const t = setupPayu();
    const call = api(t.subs);
    const created = await exchange(call, OperationId.CreateSubscription, HttpMethod.Post, '/v1/payu/subscriptions', {
      reference: PAYU_REFERENCE,
      plan: { name: 'Pro monthly', amount: 49900, interval: { unit: IntervalUnit.Month, count: 1 } },
      customer: CUSTOMER,
      startAt: PAYU_DUE,
    });
    expect(created.json.checkout).toMatchObject({ kind: CheckoutKind.FormPost });
    expect(created.json.checkout.fields).not.toHaveProperty('salt');

    // PayU posts the consent result to the MERCHANT's surl as a form; the merchant forwards it as JSON to verify.
    const result = consentResult(PAYU_REFERENCE);
    const verified = await exchange(call, OperationId.VerifyCheckout, HttpMethod.Post, '/v1/payu/checkout/verify', { result, expectedSubscriptionId: PAYU_REFERENCE });
    expect(verified.json).toMatchObject({ authorized: true, subscriptionId: PAYU_COMPOSITE });
    expect((await t.scheduler.get(t.scheduleId))?.status).toBe(ScheduleStatus.Active);

    // The same consent as PayU's webhook: a form-encoded raw body with the documented content type; a redelivery is harmless.
    const headers = { [HeaderName.ContentType]: ContentType.Form };
    const hook = await call(HttpMethod.Post, '/v1/payu/webhooks', { auth: false, body: formBody(result), headers });
    expect(hook).toMatchObject({ status: HttpStatus.Ok, json: { received: 1 } });
    const again = await call(HttpMethod.Post, '/v1/payu/webhooks', { auth: false, body: formBody(result), headers: { [HeaderName.ContentType]: `${ContentType.Form}; charset=UTF-8` } });
    expect(again.status).toBe(HttpStatus.Ok);
    // A body whose hash does not verify is a 401 and changes nothing.
    const forged = await call(HttpMethod.Post, '/v1/payu/webhooks', { auth: false, body: formBody({ ...result, amount: '3.00' }), headers });
    expect(forged.status).toBe(HttpStatus.Unauthorized);

    t.clock.set(plusHours(PAYU_DUE, -48));
    expect((await exchange(call, OperationId.RunSchedulerTick, HttpMethod.Post, '/v1/scheduler/tick')).json.notified).toBe(1);
    t.clock.set(PAYU_DUE);
    expect((await exchange(call, OperationId.RunSchedulerTick, HttpMethod.Post, '/v1/scheduler/tick')).json).toMatchObject({ charged: 1, succeeded: 1 });
    expect(t.fake.commandsNamed(PayUCommand.SiTransaction)).toHaveLength(1);

    // get through the service by the composite id; cancel by the composite id revokes the mandate
    expect((await exchange(call, OperationId.GetSubscription, HttpMethod.Get, `/v1/payu/subscriptions/${encodeURIComponent(PAYU_COMPOSITE)}`)).json).toMatchObject({ paidCycles: 1 });
    expect((await exchange(call, OperationId.CancelSubscription, HttpMethod.Post, `/v1/payu/subscriptions/${encodeURIComponent(PAYU_COMPOSITE)}/cancel`)).json.status).toBe(SubscriptionStatus.Cancelled);
  });

  it('webhooks/parse is documented as "verify and normalise", but it applies the events to the scheduler as well', async () => {
    const t = setupPayu();
    const call = api(t.subs);
    await t.create();
    const request = { rawBody: formBody(consentResult(PAYU_REFERENCE)), headers: {} };
    const reply = await exchange(call, OperationId.ParseWebhook, HttpMethod.Post, '/v1/payu/webhooks/parse', request);
    expect(reply.json[0].type).toBe(EventType.SubscriptionAuthorized);
    expect((await t.scheduler.get(t.scheduleId))?.status).toBe(ScheduleStatus.Active);
  });
});

describe('the events forwarder over the service', () => {
  it('a gateway webhook is forwarded as a signed `gateway` delivery that a receiver can verify and validate; a failing receiver makes the webhook answer 500 and a redelivery is safe', async () => {
    const SECRET = 'events-secret-value';
    const received: Array<{ headers: Record<string, string>; body: string }> = [];
    let healthy = false;
    const receiver = scriptedFetch((call) => {
      received.push({ headers: call.headers, body: call.body ?? '' });
      return { status: healthy ? 200 : 503 };
    });
    const t = setupPayu();
    const call = api(t.subs, createEventsForwarder({ url: 'https://app.example/events', secret: SECRET, fetch: receiver.fetch }));
    await t.create();
    const request = formBody(consentResult(PAYU_REFERENCE));

    const failing = await call(HttpMethod.Post, '/v1/payu/webhooks', { auth: false, body: request });
    expect(failing.status).toBe(HttpStatus.InternalServerError);
    // The scheduler already applied the event before the hook failed; the gateway's retry is idempotent.
    expect((await t.scheduler.get(t.scheduleId))?.status).toBe(ScheduleStatus.Active);

    healthy = true;
    const retried = await call(HttpMethod.Post, '/v1/payu/webhooks', { auth: false, body: request });
    expect(retried).toMatchObject({ status: HttpStatus.Ok, json: { received: 1 } });

    const delivery = received.at(-1)!;
    expect(() => verifyEventsSignature(SECRET, delivery.body, delivery.headers, { now: () => Date.now() })).not.toThrow();
    expect(delivery.headers[EventsHeader.Timestamp]).toMatch(/^\d+$/);
    const parsed = EventsDeliverySchema.parse(JSON.parse(delivery.body));
    expect(parsed).toMatchObject({ kind: EventsDeliveryKind.Gateway, provider: Provider.PayU });
    function formBody(fields: Record<string, string>) {
      return new URLSearchParams(fields).toString();
    }
  });
});
