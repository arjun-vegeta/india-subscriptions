import { describe, expect, it } from 'vitest';
import { ErrorCode, EventType, HttpMethod, PaymentMethod, PaymentStatus, Provider } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import { RoutingDecisionSchema } from '../../src/routing/index.js';
import { PaymentSchema, PaymentVerificationSchema, RefundSchema } from '../../src/schemas.js';
import { ApiPath, ServerErrorCode, routes, Tag } from '../../src/server/index.js';
import {
  PAID,
  RESULT_ORDER,
  RESULT_OUTCOME,
  SIGNATURE_HEADER,
  VALID_SIGNATURE,
  ScriptedGateway,
  jsonOf,
  send,
  wire,
  type ErrorBody,
} from './support.js';

const PAYMENT_INPUT = { amount: 9900, customer: { name: 'Asha', email: 'asha@example.com' }, reference: 'pay-ref-1' };

describe('one-time payment routes', () => {
  it('POST /v1/{provider}/payments creates the payment and answers 201 with its checkout', async () => {
    const t = wire();
    const response = await send(t.handler, HttpMethod.Post, '/v1/razorpay/payments', { body: PAYMENT_INPUT });
    expect(response.status).toBe(201);
    const payment = PaymentSchema.parse(await jsonOf(response));
    expect(payment).toMatchObject({ provider: Provider.Razorpay, amount: 9900, status: PaymentStatus.Created, reference: 'pay-ref-1' });
    expect(payment.checkout).toMatchObject({ kind: 'redirect' });
    expect(t.gateways[0]?.created).toHaveLength(1);
    expect(t.gateways[1]?.created).toHaveLength(0);
  });

  it('GET /v1/{provider}/payments/{paymentId} reads the payment, 404 for one the gateway does not know', async () => {
    const t = wire();
    const created = PaymentSchema.parse(await jsonOf(await send(t.handler, HttpMethod.Post, '/v1/razorpay/payments', { body: PAYMENT_INPUT })));
    const found = await send(t.handler, HttpMethod.Get, `/v1/razorpay/payments/${created.id}`);
    expect(found.status).toBe(200);
    expect(PaymentSchema.parse(await jsonOf(found)).id).toBe(created.id);
    const missing = await send(t.handler, HttpMethod.Get, '/v1/razorpay/payments/nope');
    expect(missing.status).toBe(404);
    expect((await jsonOf<ErrorBody>(missing)).error.code).toBe(ErrorCode.NotFound);
  });

  it('POST /v1/{provider}/payments/verify verifies the result, binding it to expectedPaymentId', async () => {
    const t = wire();
    const created = PaymentSchema.parse(await jsonOf(await send(t.handler, HttpMethod.Post, '/v1/razorpay/payments', { body: PAYMENT_INPUT })));
    const ok = await send(t.handler, HttpMethod.Post, '/v1/razorpay/payments/verify', {
      body: { result: { [RESULT_ORDER]: created.id, [RESULT_OUTCOME]: PAID }, expectedPaymentId: created.id },
    });
    expect(ok.status).toBe(200);
    expect(PaymentVerificationSchema.parse(await jsonOf(ok))).toMatchObject({ paymentId: created.id, paid: true });

    // A genuine result for another payment is refused like a forged one.
    const other = await send(t.handler, HttpMethod.Post, '/v1/razorpay/payments/verify', {
      body: { result: { [RESULT_ORDER]: 'order_other', [RESULT_OUTCOME]: PAID }, expectedPaymentId: created.id },
    });
    expect(other.status).toBe(401);
    expect((await jsonOf<ErrorBody>(other)).error.code).toBe(ErrorCode.SignatureInvalid);
  });

  it('POST /v1/{provider}/payment-refunds refunds, answering 201', async () => {
    const t = wire();
    const response = await send(t.handler, HttpMethod.Post, '/v1/razorpay/payment-refunds', {
      body: { paymentId: 'order_razorpay_1', refundId: 'rf-1', amount: 1000, reason: 'customer asked' },
    });
    expect(response.status).toBe(201);
    expect(RefundSchema.parse(await jsonOf(response))).toMatchObject({ id: 'rf-1', paymentId: 'order_razorpay_1', amount: 1000 });
    expect(t.gateways[0]?.refunds).toEqual([{ paymentId: 'order_razorpay_1', refundId: 'rf-1', amount: 1000, reason: 'customer asked' }]);
  });

  it.each([
    ['create', HttpMethod.Post, '/v1/razorpay/payments', {}],
    ['create (a negative amount)', HttpMethod.Post, '/v1/razorpay/payments', { amount: -5, customer: { name: 'A' } }],
    ['verify (no result)', HttpMethod.Post, '/v1/razorpay/payments/verify', {}],
    ['refund (no refund id)', HttpMethod.Post, '/v1/razorpay/payment-refunds', { paymentId: 'p' }],
  ])('rejects an invalid body with 400 VALIDATION: %s', async (_name, method, path, body) => {
    const t = wire();
    const response = await send(t.handler, method, path, { body });
    expect(response.status).toBe(400);
    expect((await jsonOf<ErrorBody>(response)).error.code).toBe(ErrorCode.Validation);
    expect(t.gateways[0]?.created).toHaveLength(0);
  });

  it('answers 404 for a gateway that is not configured and 400 for a provider that does not exist', async () => {
    const t = wire();
    const missing = await send(t.handler, HttpMethod.Post, '/v1/payu/payments', { body: PAYMENT_INPUT });
    expect(missing.status).toBe(404);
    const unknown = await send(t.handler, HttpMethod.Post, '/v1/nopay/payments', { body: PAYMENT_INPUT });
    expect(unknown.status).toBe(400);
  });

  it('answers 422 UNSUPPORTED for a gateway that has no one-time payments', async () => {
    const t = wire({ gateways: [new ScriptedGateway(Provider.PhonePe, { oneTimePayments: false, oneTimePaymentMethods: [] })] });
    // The scripted gateway implements createPayment; the default adapter behaviour is what a real one without the feature does.
    t.gateways[0]!.failCreates = new SubscriptionError(ErrorCode.Unsupported, 'phonepe does not support one-time payments', { provider: Provider.PhonePe });
    const response = await send(t.handler, HttpMethod.Post, '/v1/phonepe/payments', { body: PAYMENT_INPUT });
    expect(response.status).toBe(422);
    expect((await jsonOf<ErrorBody>(response)).error.code).toBe(ErrorCode.Unsupported);
  });

  it('maps a gateway outage to 503 and keeps its retryable flag', async () => {
    const t = wire();
    t.gateways[0]!.failCreates = new SubscriptionError(ErrorCode.ProviderUnavailable, 'down', { provider: Provider.Razorpay });
    const response = await send(t.handler, HttpMethod.Post, '/v1/razorpay/payments', { body: PAYMENT_INPUT });
    expect(response.status).toBe(503);
    expect((await jsonOf<ErrorBody>(response)).error.retryable).toBe(true);
  });

  it('demands the API key on every payment route', async () => {
    const t = wire();
    for (const route of routes.filter((candidate) => candidate.tag === Tag.Payments)) {
      const path = route.path.replace('{provider}', 'razorpay').replace(/\{\w+\}/g, 'x');
      const response = await send(t.handler, route.method, path, { auth: null, ...(route.requestBody ? { body: {} } : {}) });
      expect(response.status, `${route.method} ${route.path}`).toBe(401);
      expect((await jsonOf<ErrorBody>(response)).error.code).toBe(ServerErrorCode.Unauthorized);
      const wrong = await send(t.handler, route.method, path, { auth: 'wrong-key', ...(route.requestBody ? { body: {} } : {}) });
      expect(wrong.status).toBe(401);
    }
  });

  it('covers every payment route', () => {
    expect(routes.filter((route) => route.tag === Tag.Payments).map((route) => `${route.method} ${route.path}`).sort()).toEqual(
      [
        `POST ${ApiPath.Payments}`,
        `GET ${ApiPath.Payment}`,
        `POST ${ApiPath.PaymentVerify}`,
        `POST ${ApiPath.PaymentRefunds}`,
      ].sort(),
    );
  });
});

describe('webhooks of any provider, including the stores', () => {
  it('POST /v1/{provider}/webhooks hands the events to the hook and, with purchases, to the purchase module', async () => {
    const t = wire();
    const body = JSON.stringify({ events: [{ id: 'e1', provider: Provider.Razorpay, type: EventType.PaymentSucceeded, providerEventType: 'x', paymentId: 'unknown', raw: {} }] });
    const response = await send(t.handler, HttpMethod.Post, '/v1/razorpay/webhooks', { auth: null, rawBody: body, headers: { [SIGNATURE_HEADER]: VALID_SIGNATURE } });
    expect(response.status).toBe(200);
    expect(await jsonOf(response)).toEqual({ received: 1 });
    expect(t.events).toHaveLength(1);
  });
});

describe('routing routes', () => {
  const REQUEST = { kind: 'one_time', amount: 9900 };

  it('POST /v1/routing/decide chooses a gateway and explains every candidate', async () => {
    const t = wire({
      gateways: [new ScriptedGateway(Provider.Razorpay), new ScriptedGateway(Provider.Cashfree), new ScriptedGateway(Provider.PhonePe, { oneTimePayments: false, oneTimePaymentMethods: [] })],
      routing: { strategy: { priority: [Provider.Cashfree, Provider.Razorpay] } },
    });
    const response = await send(t.handler, HttpMethod.Post, '/v1/routing/decide', { body: REQUEST });
    expect(response.status).toBe(200);
    const decision = RoutingDecisionSchema.parse(await jsonOf(response));
    expect(decision.provider).toBe(Provider.Cashfree);
    expect(decision.ranked).toEqual([Provider.Cashfree, Provider.Razorpay]);
    expect(decision.candidates.map((candidate) => [candidate.provider, candidate.eligible])).toEqual(
      expect.arrayContaining([
        [Provider.Cashfree, true],
        [Provider.Razorpay, true],
        [Provider.PhonePe, false],
      ]),
    );
    const phonepe = decision.candidates.find((candidate) => candidate.provider === Provider.PhonePe);
    expect(phonepe?.exclusions.length).toBeGreaterThan(0);
    // Nothing was created at any gateway.
    expect(t.gateways.every((gateway) => gateway.created.length === 0)).toBe(true);
  });

  it('honours the request: excluded gateways and payment methods', async () => {
    const t = wire();
    const response = await send(t.handler, HttpMethod.Post, '/v1/routing/decide', {
      body: { ...REQUEST, exclude: [Provider.Razorpay], paymentMethods: [PaymentMethod.Upi] },
    });
    expect(RoutingDecisionSchema.parse(await jsonOf(response)).ranked).toEqual([Provider.Cashfree]);
  });

  it('answers 422 NO_ROUTE listing why, when no gateway can take the request', async () => {
    const t = wire();
    const response = await send(t.handler, HttpMethod.Post, '/v1/routing/decide', { body: { ...REQUEST, exclude: [Provider.Razorpay, Provider.Cashfree] } });
    expect(response.status).toBe(422);
    const body = await jsonOf<ErrorBody>(response);
    expect(body.error.code).toBe(ErrorCode.NoRoute);
    expect(body.error.message).toContain('razorpay');
  });

  it('rejects a request that is not valid with 400', async () => {
    const t = wire();
    for (const body of [{}, { kind: 'one_time' }, { kind: 'nonsense', amount: 1 }, { kind: 'one_time', amount: 0 }]) {
      const response = await send(t.handler, HttpMethod.Post, '/v1/routing/decide', { body });
      expect(response.status).toBe(400);
    }
  });

  it('POST /v1/routing/outcomes records an outcome, and the router acts on it', async () => {
    const t = wire({ routing: { strategy: { circuitBreaker: { failureThreshold: 2, cooldownMs: 60_000 } } } });
    for (let i = 0; i < 2; i += 1) {
      const recorded = await send(t.handler, HttpMethod.Post, '/v1/routing/outcomes', {
        body: { provider: Provider.Razorpay, kind: 'payment', result: 'unavailable' },
      });
      expect(recorded.status).toBe(200);
      expect(await jsonOf(recorded)).toEqual({ recorded: true });
    }
    const decision = RoutingDecisionSchema.parse(await jsonOf(await send(t.handler, HttpMethod.Post, '/v1/routing/decide', { body: REQUEST })));
    expect(decision.ranked).toEqual([Provider.Cashfree]);
    expect(decision.candidates.find((candidate) => candidate.provider === Provider.Razorpay)?.eligible).toBe(false);
  });

  it('refuses an outcome that is invalid (400) or for a gateway that is not configured (404)', async () => {
    const t = wire();
    const invalid = await send(t.handler, HttpMethod.Post, '/v1/routing/outcomes', { body: { provider: Provider.Razorpay, kind: 'payment' } });
    expect(invalid.status).toBe(400);
    const missing = await send(t.handler, HttpMethod.Post, '/v1/routing/outcomes', { body: { provider: Provider.PayU, kind: 'payment', result: 'success' } });
    expect(missing.status).toBe(404);
  });

  it('works without purchases configured', async () => {
    const t = wire({ purchases: false });
    expect((await send(t.handler, HttpMethod.Post, '/v1/routing/decide', { body: REQUEST })).status).toBe(200);
  });

  it('demands the API key', async () => {
    const t = wire();
    for (const route of routes.filter((candidate) => candidate.tag === Tag.Routing)) {
      const response = await send(t.handler, route.method, route.path, { auth: null, body: {} });
      expect(response.status, route.path).toBe(401);
    }
  });

  it('covers every routing route', () => {
    expect(routes.filter((route) => route.tag === Tag.Routing).map((route) => `${route.method} ${route.path}`).sort()).toEqual(
      [`POST ${ApiPath.RoutingDecide}`, `POST ${ApiPath.RoutingOutcomes}`].sort(),
    );
  });
});
