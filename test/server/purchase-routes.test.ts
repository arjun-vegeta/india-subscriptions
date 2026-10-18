import { describe, expect, it } from 'vitest';
import { ErrorCode, EventType, HttpMethod, PaymentStatus, Provider } from '../../src/constants.js';
import { EntitlementsSchema, FlushResultSchema, PurchaseSessionSchema, SessionStatus, ReportKind } from '../../src/purchase/index.js';
import { ApiPath, ServerErrorCode, Tag, routes } from '../../src/server/index.js';
import {
  BASE,
  COINS,
  CUSTOMER,
  MONTHLY,
  PAID,
  RESULT_ORDER,
  RESULT_OUTCOME,
  SIGNATURE_HEADER,
  VALID_SIGNATURE,
  ScriptedGateway,
  jsonOf,
  send,
  startBody,
  wire,
  type ErrorBody,
} from './support.js';

async function start(t: ReturnType<typeof wire>, fields: Record<string, unknown> = {}) {
  const response = await send(t.handler, HttpMethod.Post, '/v1/purchases', { body: startBody(fields) });
  return { response, session: response.status === 201 ? PurchaseSessionSchema.parse(await jsonOf(response)) : undefined };
}

describe('purchase routes', () => {
  it('POST /v1/purchases starts a web purchase at the best gateway and answers 201 with the session', async () => {
    const t = wire();
    const { response, session } = await start(t);
    expect(response.status).toBe(201);
    expect(session).toMatchObject({ platform: 'web', product: MONTHLY.key, status: SessionStatus.Open, customerRef: 'cust_1', returnUrl: 'https://shop.example.com/done' });
    expect(session?.id).toMatch(/^ps_/);
    expect(session?.options).toHaveLength(1);
    expect(session?.options[0]).toMatchObject({ channel: 'gateway', provider: Provider.Razorpay });
    // The hosted checkout hooks set what the gateway returns to, and the option's hostedUrl.
    expect(session?.options[0]?.hostedUrl).toBe(`${BASE}/checkout/${session?.id}`);
    const created = t.gateways[0]?.created[0]?.input as { returnUrl?: string };
    expect(created.returnUrl).toBe(`${BASE}/checkout/${session?.id}/return`);
  });

  it('GET /v1/purchases/{sessionId} reads the session; an unknown one is 404', async () => {
    const t = wire();
    const { session } = await start(t);
    const found = await send(t.handler, HttpMethod.Get, `/v1/purchases/${session?.id}`);
    expect(found.status).toBe(200);
    expect(PurchaseSessionSchema.parse(await jsonOf(found)).id).toBe(session?.id);
    const missing = await send(t.handler, HttpMethod.Get, '/v1/purchases/ps_missing');
    expect(missing.status).toBe(404);
    expect((await jsonOf<ErrorBody>(missing)).error.code).toBe(ErrorCode.NotFound);
  });

  it('POST /v1/purchases/{sessionId}/complete verifies against the order and writes the entitlement', async () => {
    const t = wire();
    const { session } = await start(t);
    const option = session!.options[0]!;
    const done = await send(t.handler, HttpMethod.Post, `/v1/purchases/${session?.id}/complete`, {
      body: { provider: option.provider, result: { [RESULT_ORDER]: option.handle, [RESULT_OUTCOME]: PAID } },
    });
    expect(done.status).toBe(200);
    expect(PurchaseSessionSchema.parse(await jsonOf(done))).toMatchObject({ status: SessionStatus.Completed, provider: option.provider });

    const entitlements = await send(t.handler, HttpMethod.Get, '/v1/entitlements/cust_1');
    expect(entitlements.status).toBe(200);
    const parsed = EntitlementsSchema.parse(await jsonOf(entitlements));
    expect(parsed.active).toBe(true);
    expect(parsed.items[0]).toMatchObject({ product: MONTHLY.key, channel: 'gateway', platform: 'web', active: true });
  });

  it('complete refuses a result for another order with 401 and leaves the session open', async () => {
    const t = wire();
    const { session } = await start(t);
    const done = await send(t.handler, HttpMethod.Post, `/v1/purchases/${session?.id}/complete`, {
      body: { provider: session!.options[0]!.provider, result: { [RESULT_ORDER]: 'sub_razorpay_99', [RESULT_OUTCOME]: PAID } },
    });
    expect(done.status).toBe(401);
    expect((await jsonOf<ErrorBody>(done)).error.code).toBe(ErrorCode.SignatureInvalid);
    const after = PurchaseSessionSchema.parse(await jsonOf(await send(t.handler, HttpMethod.Get, `/v1/purchases/${session?.id}`)));
    expect(after.status).toBe(SessionStatus.Open);
  });

  it('answers 409 when the customer already owns the product', async () => {
    const t = wire();
    const { session } = await start(t);
    await send(t.handler, HttpMethod.Post, `/v1/purchases/${session?.id}/complete`, {
      body: { provider: session!.options[0]!.provider, result: { [RESULT_ORDER]: session!.options[0]!.handle, [RESULT_OUTCOME]: PAID } },
    });
    const again = await send(t.handler, HttpMethod.Post, '/v1/purchases', { body: startBody({ reference: 'another-ref' }) });
    expect(again.status).toBe(409);
    expect((await jsonOf<ErrorBody>(again)).error.code).toBe(ErrorCode.Conflict);
  });

  it('start with the same reference returns the same session', async () => {
    const t = wire();
    const first = await start(t, { reference: 'order-1' });
    const second = await start(t, { reference: 'order-1' });
    expect(second.session?.id).toBe(first.session?.id);
    expect(t.gateways.flatMap((gateway) => gateway.created)).toHaveLength(1);
  });

  it('a one-time product is bought as a payment', async () => {
    const t = wire();
    const { session } = await start(t, { product: COINS.key });
    expect(session?.options[0]?.handle).toMatch(/^order_/);
    const done = await send(t.handler, HttpMethod.Post, `/v1/purchases/${session?.id}/complete`, {
      body: { provider: session!.options[0]!.provider, result: { [RESULT_ORDER]: session!.options[0]!.handle, [RESULT_OUTCOME]: PAID } },
    });
    expect(PurchaseSessionSchema.parse(await jsonOf(done)).paymentId).toBe(session?.options[0]?.handle);
  });

  it('falls back to the next gateway when the first is unavailable', async () => {
    const first = new ScriptedGateway(Provider.Razorpay);
    const second = new ScriptedGateway(Provider.Cashfree);
    const { SubscriptionError } = await import('../../src/errors.js');
    first.failCreates = new SubscriptionError(ErrorCode.ProviderUnavailable, 'down', { provider: Provider.Razorpay });
    const t = wire({ gateways: [first, second], routing: { strategy: { priority: [Provider.Razorpay, Provider.Cashfree] } } });
    const { session } = await start(t);
    expect(session?.options[0]?.provider).toBe(Provider.Cashfree);
    expect(session?.attempts.map((attempt) => [attempt.provider, attempt.outcome])).toEqual([
      [Provider.Razorpay, 'failed'],
      [Provider.Cashfree, 'created'],
    ]);
  });

  it.each([
    ['an unknown product', { product: 'nope' }, 404],
    ['an unknown platform', { platform: 'toaster' }, 400],
    ['no customer ref', { customerRef: undefined }, 400],
    ['a malformed return URL', { returnUrl: 'not a url' }, 400],
    ['a reference with a space', { reference: 'not valid' }, 400],
  ])('rejects %s', async (_name, fields, status) => {
    const t = wire();
    const response = await send(t.handler, HttpMethod.Post, '/v1/purchases', { body: startBody(fields) });
    expect(response.status).toBe(status);
  });

  it('chooseAlternative is refused for a session that was not started with user choice billing', async () => {
    const t = wire();
    const { session } = await start(t);
    const response = await send(t.handler, HttpMethod.Post, `/v1/purchases/${session?.id}/alternative`, { body: { externalTransactionToken: 'tok' } });
    expect(response.status).toBe(400);
    const invalid = await send(t.handler, HttpMethod.Post, `/v1/purchases/${session?.id}/alternative`, { body: {} });
    expect(invalid.status).toBe(400);
    const unknown = await send(t.handler, HttpMethod.Post, '/v1/purchases/ps_unknown/alternative', { body: { externalTransactionToken: 'tok' } });
    expect(unknown.status).toBe(404);
  });

  it('complete rejects an invalid body with 400', async () => {
    const t = wire();
    const { session } = await start(t);
    for (const body of [{}, { provider: Provider.Razorpay }, { provider: 'nope', result: {} }]) {
      const response = await send(t.handler, HttpMethod.Post, `/v1/purchases/${session?.id}/complete`, { body });
      expect(response.status).toBe(400);
    }
  });

  it('POST /v1/purchases/flush sends the queued reports (none queued here) and takes an optional body', async () => {
    const t = wire();
    for (const options of [{}, { body: { limit: 5 } }]) {
      const response = await send(t.handler, HttpMethod.Post, '/v1/purchases/flush', options);
      expect(response.status).toBe(200);
      expect(FlushResultSchema.parse(await jsonOf(response))).toMatchObject({ sent: 0, retrying: 0, rejected: 0, overdue: [] });
    }
    const invalid = await send(t.handler, HttpMethod.Post, '/v1/purchases/flush', { body: { limit: 0 } });
    expect(invalid.status).toBe(400);
    expect(ReportKind.Transaction).toBe('transaction');
  });

  it('webhook events keep entitlements current: a payment success for an unknown order is ignored, a refund ends a one-time entitlement', async () => {
    const t = wire();
    const { session } = await start(t, { product: COINS.key });
    const option = session!.options[0]!;
    await send(t.handler, HttpMethod.Post, `/v1/purchases/${session?.id}/complete`, {
      body: { provider: option.provider, result: { [RESULT_ORDER]: option.handle, [RESULT_OUTCOME]: PAID } },
    });
    const body = JSON.stringify({
      events: [
        { id: 'e0', provider: Provider.Razorpay, type: EventType.PaymentSucceeded, providerEventType: 'x', paymentId: 'order_unknown', raw: {} },
        {
          id: 'e1',
          provider: Provider.Razorpay,
          type: EventType.RefundSucceeded,
          providerEventType: 'x',
          paymentId: option.handle,
          refund: { provider: Provider.Razorpay, id: 'rf_1', chargeId: option.handle, paymentId: option.handle, status: 'succeeded', amount: COINS.amount, raw: {} },
          raw: {},
        },
      ],
    });
    const hook = await send(t.handler, HttpMethod.Post, '/v1/razorpay/webhooks', { auth: null, rawBody: body, headers: { [SIGNATURE_HEADER]: VALID_SIGNATURE } });
    expect(hook.status).toBe(200);
    const entitlements = EntitlementsSchema.parse(await jsonOf(await send(t.handler, HttpMethod.Get, '/v1/entitlements/cust_1')));
    expect(entitlements.items[0]?.status).toBe('refunded');
    expect(entitlements.active).toBe(false);
    expect(PaymentStatus.Refunded).toBe('refunded');
  });

  it('a webhook whose purchase handling fails still answers 5xx with the events kept in the error, so the gateway retries', async () => {
    const failing = wire({
      purchases: {
        store: {
          // A store that is down: every read fails.
          getSession: async () => {
            throw new Error('disk gone');
          },
        } as never,
      },
    });
    const body = JSON.stringify({ events: [{ id: 'e1', provider: Provider.Razorpay, type: EventType.PaymentSucceeded, providerEventType: 'x', paymentId: 'order_1', raw: {} }] });
    const hook = await send(failing.handler, HttpMethod.Post, '/v1/razorpay/webhooks', { auth: null, rawBody: body, headers: { [SIGNATURE_HEADER]: VALID_SIGNATURE } });
    expect(hook.status).toBeGreaterThanOrEqual(500);
    // The hook never saw them: the gateway will deliver again.
    expect(failing.events).toHaveLength(0);
  });
});

describe('purchase routes without a purchases configuration', () => {
  const PURCHASE_ROUTES = routes.filter((route) => route.tag === Tag.Purchases);

  it.each(PURCHASE_ROUTES.map((route) => [`${route.method} ${route.path}`, route] as const))(
    '%s answers with a clear configuration error',
    async (_name, route) => {
      const t = wire({ purchases: false });
      const path = route.path.replace('{sessionId}', 'ps_x').replace('{customerRef}', 'cust_1');
      const response = await send(t.handler, route.method, path, route.requestBody ? { body: route.requestBody.required ? startBody() : {} } : {});
      // Bodies are validated first: send one each route accepts.
      expect([400, 500]).toContain(response.status);
      if (response.status === 500) {
        const body = await jsonOf<ErrorBody>(response);
        expect(body.error.code).toBe(ErrorCode.Config);
        expect(body.error.message).toContain('PURCHASES_FILE');
      }
    },
  );

  it('answers the configuration error (500) once the body is valid, and everything else works as before', async () => {
    const t = wire({ purchases: false });
    const start = await send(t.handler, HttpMethod.Post, '/v1/purchases', { body: startBody() });
    expect(start.status).toBe(500);
    const body = await jsonOf<ErrorBody>(start);
    expect(body.error.code).toBe(ErrorCode.Config);
    expect(body.error.message).toBe('Purchases are not configured on this service: set PURCHASES_FILE (the catalog) and PURCHASE_STORE_FILE');
    expect((await send(t.handler, HttpMethod.Get, '/v1/entitlements/cust_1')).status).toBe(500);
    expect((await send(t.handler, HttpMethod.Get, '/v1/purchases/ps_x')).status).toBe(500);
    expect((await send(t.handler, HttpMethod.Post, '/v1/purchases/flush')).status).toBe(500);
    // The rest of the service is unaffected.
    expect((await send(t.handler, HttpMethod.Get, '/v1/providers')).status).toBe(200);
    expect((await send(t.handler, HttpMethod.Post, '/v1/razorpay/payments', { body: { amount: 100, customer: { name: 'A' } } })).status).toBe(201);
    const health = await send(t.handler, HttpMethod.Get, '/v1/health', { auth: null });
    expect(health.status).toBe(200);
  });
});

describe('purchase routes: authentication', () => {
  it('every purchase and entitlement route demands the API key, with and without a wrong one', async () => {
    const t = wire();
    for (const route of routes.filter((candidate) => candidate.tag === Tag.Purchases)) {
      const path = route.path.replace('{sessionId}', 'ps_x').replace('{customerRef}', 'cust_1');
      const options = route.requestBody ? { body: {} } : {};
      const missing = await send(t.handler, route.method, path, { ...options, auth: null });
      expect(missing.status, `${route.method} ${route.path}`).toBe(401);
      expect((await jsonOf<ErrorBody>(missing)).error.code).toBe(ServerErrorCode.Unauthorized);
      expect((await send(t.handler, route.method, path, { ...options, auth: 'wrong' })).status).toBe(401);
    }
  });

  it('covers every purchase route', () => {
    expect(routes.filter((route) => route.tag === Tag.Purchases).map((route) => `${route.method} ${route.path}`).sort()).toEqual(
      [
        `POST ${ApiPath.Purchases}`,
        `POST ${ApiPath.PurchasesFlush}`,
        `GET ${ApiPath.Purchase}`,
        `POST ${ApiPath.PurchaseAlternative}`,
        `POST ${ApiPath.PurchaseComplete}`,
        `GET ${ApiPath.Entitlements}`,
      ].sort(),
    );
    expect(CUSTOMER.state).toBe('Karnataka');
  });
});
