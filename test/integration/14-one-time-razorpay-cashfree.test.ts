/**
 * Seam 14: one-time payments on Razorpay (an order checked out with Standard Checkout) and on Cashfree (an order paid
 * through the hosted checkout), through the real `Subscriptions` facade and the real adapters, with a scripted gateway
 * in place of the network. Every call names its gateway (`subs.payments.*(provider, ...)`): no routing is involved.
 * Covers create, verify (genuine, forged, for another payment), get, a signed webhook and a refund on each gateway.
 *
 * Fixtures are the documentation samples exported by test/razorpay/one-time-fixtures.ts and
 * test/cashfree/payment-fixtures.ts, with the ids edited so that one payment runs through the whole flow.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckoutKind, ContentType, Currency, ErrorCode, EventType, HeaderName, Environment, HttpMethod, PaymentMethod, PaymentStatus, ProductKind, Provider, RefundStatus } from '../../src/constants.js';
import { createSubscriptions, type Subscriptions } from '../../src/client.js';
import { CASHFREE_API_VERSION, CASHFREE_BASE_URLS, CashfreeHeader, CashfreePath } from '../../src/providers/cashfree/constants.js';
import { RAZORPAY_BASE_URL, RazorpayEndpoint, RazorpayHeader, RazorpayNoteKey } from '../../src/providers/razorpay/constants.js';
import { razorpay } from '../../src/providers/razorpay/index.js';
import { PaymentSchema, PaymentVerificationSchema, RefundSchema } from '../../src/schemas.js';
import type { RecordedCall } from '../helpers/mock-fetch.js';
import { PAYMENTS_FOR_ORDER_UPI, CREATE_ORDER_RESPONSE, GET_ORDER_ACTIVE, GET_ORDER_PAID, PAYMENT_SUCCESS_2026, REFUND_ENTITY } from '../cashfree/payment-fixtures.js';
import { CHECKOUT_SUCCESS_CALLBACK, ORDER_CREATED, ORDER_CREATE_FAILURE, ORDER_FETCHED, ORDER_PAYMENTS, REFUND_CREATED, WEBHOOK_PAYMENT_CAPTURED } from '../razorpay/one-time-fixtures.js';
import {
  CASHFREE_ACCOUNT,
  CUSTOMER,
  Clock,
  RAZORPAY_ACCOUNT,
  cashfreeProvider,
  cashfreeWebhookRequest,
  hmacHex,
  razorpayProvider,
  razorpayWebhookRequest,
  rejection,
  scriptedFetch,
  type Reply,
} from './helpers.js';

const NOW = '2026-03-13T10:00:00.000Z';
const REFUND_ID = 'refund-0001-abcd';
const json = (text: string) => JSON.parse(text) as Record<string, any>;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const basicAuth = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`, 'utf8').toString('base64')}`;
const unscripted = (call: RecordedCall): never => {
  throw new Error(`unscripted gateway call ${call.method} ${call.url}`);
};

/** A client with one configured gateway and no routing options; the router is spied on to show it is never asked. */
function facade(provider: Parameters<typeof createSubscriptions>[0]['providers'][number]) {
  const subs = createSubscriptions({ providers: [provider] });
  const route = vi.spyOn(subs.router, 'route');
  return { subs, route };
}

// ---------------------------------------------------------------------------
// Razorpay
// ---------------------------------------------------------------------------

describe('Razorpay one-time payment through the facade', () => {
  const ORDER_ID = 'order_N8FRN5zTm5S3wx';
  const PAYMENT_ID = 'pay_N8FVRD1DzYzBh1';
  const REFERENCE = 'order-1001';
  const AMOUNT = 100;
  const secret = RAZORPAY_ACCOUNT.keySecret;
  const ordersUrl = `${RAZORPAY_BASE_URL}${RazorpayEndpoint.orders}`;
  const orderUrl = `${RAZORPAY_BASE_URL}${RazorpayEndpoint.order(ORDER_ID)}`;
  const refundUrl = `${RAZORPAY_BASE_URL}${RazorpayEndpoint.refundPayment(PAYMENT_ID)}`;
  const notes = { [RazorpayNoteKey.PaymentReference]: REFERENCE };

  let paid: boolean;
  let subs: Subscriptions;
  let route: ReturnType<typeof facade>['route'];
  let calls: RecordedCall[];

  /** The gateway: `paid` flips the order from created to paid, the way the customer's payment would. */
  function gateway(call: RecordedCall): Reply {
    const key = `${call.method} ${call.url}`;
    if (key === `${HttpMethod.Post} ${ordersUrl}`) {
      return { json: { ...json(ORDER_CREATED), id: ORDER_ID, amount: AMOUNT, amount_due: AMOUNT, notes } };
    }
    if (key === `${HttpMethod.Get} ${orderUrl}`) {
      const order = { ...json(ORDER_FETCHED), id: ORDER_ID, amount: AMOUNT, notes };
      return { json: paid ? { ...order, status: 'paid', amount_paid: AMOUNT, amount_due: 0, attempts: 2 } : order };
    }
    if (key === `${HttpMethod.Get} ${orderUrl}/payments`) {
      return { json: paid ? json(ORDER_PAYMENTS) : { entity: 'collection', count: 0, items: [] } };
    }
    if (key === `${HttpMethod.Post} ${refundUrl}`) {
      return { json: { ...json(REFUND_CREATED), payment_id: PAYMENT_ID, receipt: REFUND_ID, amount: 40 } };
    }
    return unscripted(call);
  }

  beforeEach(() => {
    paid = false;
    const fake = scriptedFetch(gateway);
    calls = fake.calls;
    ({ subs, route } = facade(razorpayProvider(fake.fetch, new Clock(NOW))));
  });

  /** The Standard Checkout handler response for the order, signed as the documentation describes: HMAC SHA256 of `order|payment`. */
  const handlerResponse = (orderId = ORDER_ID) => ({
    ...json(CHECKOUT_SUCCESS_CALLBACK),
    razorpay_order_id: orderId,
    razorpay_payment_id: PAYMENT_ID,
    razorpay_signature: hmacHex(secret, `${orderId}|${PAYMENT_ID}`),
  });

  it('creates an order: POST /v1/orders with the amount in paise, and returns a created payment with a razorpay_checkout instruction', async () => {
    const payment = await subs.payments.create(Provider.Razorpay, { amount: AMOUNT, customer: CUSTOMER, reference: REFERENCE });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: HttpMethod.Post, url: ordersUrl });
    expect(calls[0]?.headers[HeaderName.Authorization]).toBe(basicAuth(RAZORPAY_ACCOUNT.keyId, secret));
    expect(calls[0]?.headers[HeaderName.ContentType]).toBe(ContentType.Json);
    expect(calls[0]?.json).toEqual({ amount: AMOUNT, currency: Currency.INR, notes });

    expect(payment).toMatchObject({
      provider: Provider.Razorpay,
      id: ORDER_ID,
      reference: REFERENCE,
      status: PaymentStatus.Created,
      amount: AMOUNT,
      currency: Currency.INR,
      checkout: { kind: CheckoutKind.RazorpayCheckout, keyId: RAZORPAY_ACCOUNT.keyId, orderId: ORDER_ID, amount: AMOUNT },
    });
    expect(PaymentSchema.safeParse(payment).success).toBe(true);
    expect(route).not.toHaveBeenCalled();
  });

  it('verifies the handler response signed by the key secret as paid, and returns the order id as the payment id', async () => {
    const result = handlerResponse();
    const verification = await subs.payments.verify(Provider.Razorpay, result, { expectedPaymentId: ORDER_ID });

    expect(verification).toMatchObject({ provider: Provider.Razorpay, paymentId: ORDER_ID, paid: true });
    expect(PaymentVerificationSchema.safeParse(verification).success).toBe(true);
    // A signature check needs no gateway call.
    expect(calls).toHaveLength(0);
    expect(route).not.toHaveBeenCalled();
  });

  it('accepts the reference stored at creation as expectedPaymentId, by reading the order once', async () => {
    paid = true;
    const verification = await subs.payments.verify(Provider.Razorpay, handlerResponse(), { expectedPaymentId: REFERENCE });
    expect(verification.paid).toBe(true);
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([`${HttpMethod.Get} ${orderUrl}`, `${HttpMethod.Get} ${orderUrl}/payments`]);
  });

  it('rejects a tampered handler response with SIGNATURE_INVALID: a flipped signature, an altered order id, an altered payment id', async () => {
    const real = handlerResponse();
    const flipped = `${real.razorpay_signature.slice(0, -1)}${real.razorpay_signature.endsWith('0') ? '1' : '0'}`;
    for (const forged of [
      { ...real, razorpay_signature: flipped },
      { ...real, razorpay_order_id: 'order_attacker0001' },
      { ...real, razorpay_payment_id: 'pay_attacker000001' },
      { ...real, razorpay_signature: hmacHex('another-secret', `${ORDER_ID}|${PAYMENT_ID}`) },
    ]) {
      const error = await rejection(() => subs.payments.verify(Provider.Razorpay, forged, { expectedPaymentId: ORDER_ID }));
      expect(error.code).toBe(ErrorCode.SignatureInvalid);
    }
  });

  it('rejects a genuine result for a different order than expectedPaymentId with SIGNATURE_INVALID', async () => {
    paid = true;
    const other = handlerResponse('order_other0000001');
    const error = await rejection(() => subs.payments.verify(Provider.Razorpay, other, { expectedPaymentId: ORDER_ID }));
    expect(error.code).toBe(ErrorCode.SignatureInvalid);
    expect(error.provider).toBe(Provider.Razorpay);
  });

  it('gets the payment as the gateway reports it: created before the customer pays, succeeded after', async () => {
    const before = await subs.payments.get(Provider.Razorpay, ORDER_ID);
    expect(before).toMatchObject({ id: ORDER_ID, reference: REFERENCE, status: PaymentStatus.Created, amount: AMOUNT });

    paid = true;
    calls.length = 0;
    const after = await subs.payments.get(Provider.Razorpay, ORDER_ID);
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([`${HttpMethod.Get} ${orderUrl}`, `${HttpMethod.Get} ${orderUrl}/payments`]);
    expect(after).toMatchObject({
      provider: Provider.Razorpay,
      id: ORDER_ID,
      reference: REFERENCE,
      status: PaymentStatus.Succeeded,
      providerStatus: 'captured',
      amount: AMOUNT,
      refundedAmount: 0,
      paymentMethod: PaymentMethod.Upi,
    });
    expect(PaymentSchema.safeParse(after).success).toBe(true);
  });

  describe('webhooks.handle', () => {
    /** The documented payment.captured sample, pointed at this order and payment. */
    const captured = () => {
      const body = json(WEBHOOK_PAYMENT_CAPTURED);
      Object.assign(body.payload.payment.entity, { id: PAYMENT_ID, order_id: ORDER_ID, amount: AMOUNT });
      return JSON.stringify(body);
    };

    it('turns a signed payment.captured into payment.succeeded carrying the payment id and the payment', async () => {
      const events = await subs.webhooks.handle(Provider.Razorpay, razorpayWebhookRequest(captured(), RAZORPAY_ACCOUNT.webhookSecret, 'evt_cap_1'));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        id: 'evt_cap_1',
        provider: Provider.Razorpay,
        type: EventType.PaymentSucceeded,
        paymentId: ORDER_ID,
        payment: { id: ORDER_ID, status: PaymentStatus.Succeeded, amount: AMOUNT, currency: Currency.INR },
      });
      expect(calls).toHaveLength(0);
      expect(route).not.toHaveBeenCalled();
    });

    it('rejects a body changed after signing, and a signature made with another secret, with SIGNATURE_INVALID', async () => {
      const signed = razorpayWebhookRequest(captured(), RAZORPAY_ACCOUNT.webhookSecret);
      const tampered = { ...signed, rawBody: signed.rawBody.replace(`"amount":${AMOUNT}`, '"amount":1000000').replace(`"amount": ${AMOUNT}`, '"amount": 1000000') };
      expect(tampered.rawBody).not.toBe(signed.rawBody);
      expect((await rejection(() => subs.webhooks.handle(Provider.Razorpay, tampered))).code).toBe(ErrorCode.SignatureInvalid);
      const wrongSecret = razorpayWebhookRequest(captured(), 'not-the-webhook-secret');
      expect((await rejection(() => subs.webhooks.handle(Provider.Razorpay, wrongSecret))).code).toBe(ErrorCode.SignatureInvalid);
    });
  });

  it('refunds: finds the order\'s captured payment, then POSTs /v1/payments/{id}/refund; chargeId and paymentId are the order id', async () => {
    paid = true;
    const refund = await subs.payments.refund(Provider.Razorpay, { paymentId: ORDER_ID, refundId: REFUND_ID, amount: 40 });

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([`${HttpMethod.Get} ${orderUrl}/payments`, `${HttpMethod.Post} ${refundUrl}`]);
    const request = calls[1] as RecordedCall;
    expect(request.headers[HeaderName.Authorization]).toBe(basicAuth(RAZORPAY_ACCOUNT.keyId, secret));
    expect(request.headers[RazorpayHeader.RefundIdempotency.toLowerCase()]).toBe(REFUND_ID);
    expect(request.json).toEqual({ amount: 40, receipt: REFUND_ID, notes: { [RazorpayNoteKey.RefundReference]: REFUND_ID } });

    expect(refund).toMatchObject({
      provider: Provider.Razorpay,
      reference: REFUND_ID,
      chargeId: ORDER_ID,
      paymentId: ORDER_ID,
      status: RefundStatus.Succeeded,
      amount: 40,
      currency: Currency.INR,
    });
    expect(RefundSchema.safeParse(refund).success).toBe(true);
    expect(route).not.toHaveBeenCalled();
  });

  describe('a failing create is surfaced once, never retried', () => {
    it('maps the documented 400 failure body to VALIDATION after one request', async () => {
      const fake = scriptedFetch(() => ({ status: 400, json: json(ORDER_CREATE_FAILURE) }));
      const { subs: client } = facade(razorpayProvider(fake.fetch, new Clock(NOW)));
      const error = await rejection(() => client.payments.create(Provider.Razorpay, { amount: AMOUNT, customer: CUSTOMER }));
      expect(error.code).toBe(ErrorCode.Validation);
      expect(error.message).toContain('The amount must be at least INR 1.00');
      expect(fake.calls).toHaveLength(1);
    });

    it('is OUTCOME_UNKNOWN after one request when the connection drops, even with the adapter\'s default retries', async () => {
      const fake = scriptedFetch(() => ({ networkError: true }));
      const { subs: client } = facade(razorpay(RAZORPAY_ACCOUNT, { fetch: fake.fetch }));
      const error = await rejection(() => client.payments.create(Provider.Razorpay, { amount: AMOUNT, customer: CUSTOMER }));
      expect(error.code).toBe(ErrorCode.OutcomeUnknown);
      expect(fake.calls).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Cashfree
// ---------------------------------------------------------------------------

describe('Cashfree one-time payment through the facade', () => {
  const ORDER_ID = CREATE_ORDER_RESPONSE.order_id;
  const AMOUNT = 2200;
  const base = CASHFREE_BASE_URLS[Environment.Test];
  const ordersUrl = `${base}${CashfreePath.Orders}`;
  const orderUrl = `${base}${CashfreePath.order(ORDER_ID)}`;
  const refundsUrl = `${base}${CashfreePath.orderRefunds(ORDER_ID)}`;

  let paid: boolean;
  let subs: Subscriptions;
  let route: ReturnType<typeof facade>['route'];
  let calls: RecordedCall[];

  /** The gateway: `paid` turns the active order into a paid one with its successful UPI attempt. */
  function gateway(call: RecordedCall): Reply {
    const key = `${call.method} ${call.url}`;
    if (key === `${HttpMethod.Post} ${ordersUrl}`) return { json: CREATE_ORDER_RESPONSE };
    if (key === `${HttpMethod.Get} ${orderUrl}`) {
      return { json: paid ? { ...clone(GET_ORDER_PAID), order_id: ORDER_ID, order_amount: 22 } : { ...clone(GET_ORDER_ACTIVE), order_id: ORDER_ID } };
    }
    if (key === `${HttpMethod.Get} ${orderUrl}/payments`) {
      return { json: paid ? clone(PAYMENTS_FOR_ORDER_UPI).map((attempt) => ({ ...attempt, order_id: ORDER_ID })) : [] };
    }
    if (key === `${HttpMethod.Get} ${refundsUrl}`) return { json: [] };
    if (key === `${HttpMethod.Post} ${refundsUrl}`) {
      return { json: { ...clone(REFUND_ENTITY), order_id: ORDER_ID, refund_id: REFUND_ID, refund_amount: 10 } };
    }
    return unscripted(call);
  }

  beforeEach(() => {
    paid = false;
    const fake = scriptedFetch(gateway);
    calls = fake.calls;
    ({ subs, route } = facade(cashfreeProvider(fake.fetch, new Clock(NOW))));
  });

  it('creates an order: POST /pg/orders with the amount in rupees, the reference as order_id and the customer, and returns a cashfree_checkout instruction', async () => {
    const payment = await subs.payments.create(Provider.Cashfree, { amount: AMOUNT, customer: CUSTOMER, reference: ORDER_ID });

    expect(calls).toHaveLength(1);
    const call = calls[0] as RecordedCall;
    expect(call).toMatchObject({ method: HttpMethod.Post, url: ordersUrl });
    expect(call.headers[CashfreeHeader.ClientId]).toBe(CASHFREE_ACCOUNT.clientId);
    expect(call.headers[CashfreeHeader.ClientSecret]).toBe(CASHFREE_ACCOUNT.clientSecret);
    expect(call.headers[CashfreeHeader.ApiVersion]).toBe(CASHFREE_API_VERSION);
    expect(call.json).toMatchObject({
      order_id: ORDER_ID,
      order_amount: 22,
      order_currency: Currency.INR,
      customer_details: { customer_phone: CUSTOMER.phone, customer_email: CUSTOMER.email, customer_name: CUSTOMER.name },
    });

    expect(payment).toMatchObject({
      provider: Provider.Cashfree,
      id: ORDER_ID,
      reference: ORDER_ID,
      status: PaymentStatus.Created,
      amount: AMOUNT,
      currency: Currency.INR,
      checkout: {
        kind: CheckoutKind.CashfreeCheckout,
        sessionId: CREATE_ORDER_RESPONSE.payment_session_id,
        environment: Environment.Test,
        productKind: ProductKind.OneTime,
      },
    });
    expect(PaymentSchema.safeParse(payment).success).toBe(true);
    expect(route).not.toHaveBeenCalled();
  });

  it('verifies the return-URL result against the order Cashfree reports: paid once the order is PAID', async () => {
    paid = true;
    const verification = await subs.payments.verify(Provider.Cashfree, { order_id: ORDER_ID }, { expectedPaymentId: ORDER_ID });

    expect(verification).toMatchObject({ provider: Provider.Cashfree, paymentId: ORDER_ID, reference: ORDER_ID, paid: true, status: PaymentStatus.Succeeded });
    expect(PaymentVerificationSchema.safeParse(verification).success).toBe(true);
    expect(calls[0]).toMatchObject({ method: HttpMethod.Get, url: orderUrl });
    expect(route).not.toHaveBeenCalled();
  });

  it('is not fooled by a forged return URL: PAID and SUCCESS in the query do not make an active order paid', async () => {
    const forged = { order_id: ORDER_ID, order_status: 'PAID', payment_status: 'SUCCESS', cf_payment_id: '1' };
    const verification = await subs.payments.verify(Provider.Cashfree, forged, { expectedPaymentId: ORDER_ID });
    expect(verification).toMatchObject({ paid: false, status: PaymentStatus.Created });
  });

  it('rejects a result for another order than expectedPaymentId with SIGNATURE_INVALID, and a result for an unknown order with NOT_FOUND', async () => {
    paid = true;
    const other = await rejection(() => subs.payments.verify(Provider.Cashfree, { order_id: ORDER_ID }, { expectedPaymentId: 'order_someone_else' }));
    expect(other.code).toBe(ErrorCode.SignatureInvalid);

    const missing = scriptedFetch(() => ({ status: 404, json: { message: 'order not found', code: 'order_not_found', type: 'invalid_request_error' } }));
    const { subs: client } = facade(cashfreeProvider(missing.fetch, new Clock(NOW)));
    const unknown = await rejection(() => client.payments.verify(Provider.Cashfree, { order_id: 'order_ghost' }, { expectedPaymentId: 'order_ghost' }));
    expect(unknown.code).toBe(ErrorCode.NotFound);
  });

  it('gets the payment as the gateway reports it: created while the order is active, succeeded with the UPI attempt once paid', async () => {
    const before = await subs.payments.get(Provider.Cashfree, ORDER_ID);
    expect(before).toMatchObject({ id: ORDER_ID, status: PaymentStatus.Created, providerStatus: 'ACTIVE', amount: AMOUNT });

    paid = true;
    calls.length = 0;
    const after = await subs.payments.get(Provider.Cashfree, ORDER_ID);
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `${HttpMethod.Get} ${orderUrl}`,
      `${HttpMethod.Get} ${orderUrl}/payments`,
      `${HttpMethod.Get} ${refundsUrl}`,
    ]);
    expect(after).toMatchObject({
      provider: Provider.Cashfree,
      id: ORDER_ID,
      status: PaymentStatus.Succeeded,
      providerStatus: 'PAID',
      amount: AMOUNT,
      refundedAmount: 0,
      paymentMethod: PaymentMethod.Upi,
    });
    expect(PaymentSchema.safeParse(after).success).toBe(true);
  });

  describe('webhooks.handle', () => {
    /** The documented payment success webhook, pointed at this order. The signature covers the exact bytes. */
    const success = () => JSON.stringify({ ...json(PAYMENT_SUCCESS_2026), data: { ...json(PAYMENT_SUCCESS_2026).data, order: { ...json(PAYMENT_SUCCESS_2026).data.order, order_id: ORDER_ID, order_amount: 22 } } });

    it('turns a signed PAYMENT_SUCCESS_WEBHOOK into payment.succeeded carrying the payment id and the payment', async () => {
      const events = await subs.webhooks.handle(Provider.Cashfree, cashfreeWebhookRequest(success(), CASHFREE_ACCOUNT.webhookSecret));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        provider: Provider.Cashfree,
        type: EventType.PaymentSucceeded,
        providerEventType: 'PAYMENT_SUCCESS_WEBHOOK',
        paymentId: ORDER_ID,
        payment: { id: ORDER_ID, status: PaymentStatus.Succeeded, amount: AMOUNT, currency: Currency.INR },
      });
      expect(calls).toHaveLength(0);
      expect(route).not.toHaveBeenCalled();
    });

    it('rejects a body changed after signing, and a signature made with another secret, with SIGNATURE_INVALID', async () => {
      const signed = cashfreeWebhookRequest(success(), CASHFREE_ACCOUNT.webhookSecret);
      const tampered = { ...signed, rawBody: signed.rawBody.replace('"order_amount":22', '"order_amount":9999') };
      expect(tampered.rawBody).not.toBe(signed.rawBody);
      expect((await rejection(() => subs.webhooks.handle(Provider.Cashfree, tampered))).code).toBe(ErrorCode.SignatureInvalid);
      const wrongSecret = cashfreeWebhookRequest(success(), 'not-the-webhook-secret');
      expect((await rejection(() => subs.webhooks.handle(Provider.Cashfree, wrongSecret))).code).toBe(ErrorCode.SignatureInvalid);
    });
  });

  it('refunds: POSTs /pg/orders/{id}/refunds with the amount in rupees and an idempotency key; chargeId and paymentId are the order id', async () => {
    paid = true;
    const refund = await subs.payments.refund(Provider.Cashfree, { paymentId: ORDER_ID, refundId: REFUND_ID, amount: 1000 });

    expect(calls).toHaveLength(1);
    const call = calls[0] as RecordedCall;
    expect(call).toMatchObject({ method: HttpMethod.Post, url: refundsUrl });
    expect(call.headers[CashfreeHeader.ClientId]).toBe(CASHFREE_ACCOUNT.clientId);
    expect(call.headers[CashfreeHeader.IdempotencyKey]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(call.json).toEqual({ refund_amount: 10, refund_id: REFUND_ID });

    expect(refund).toMatchObject({
      provider: Provider.Cashfree,
      id: REFUND_ID,
      chargeId: ORDER_ID,
      paymentId: ORDER_ID,
      status: RefundStatus.Succeeded,
      amount: 1000,
      currency: Currency.INR,
    });
    expect(RefundSchema.safeParse(refund).success).toBe(true);
    expect(route).not.toHaveBeenCalled();
  });

  describe('a failing create is surfaced once, never retried', () => {
    it('maps a reused order id (409) to CONFLICT after one request', async () => {
      const fake = scriptedFetch(() => ({ status: 409, json: { message: 'order with same id is already present', code: 'order_already_exists', type: 'invalid_request_error' } }));
      const { subs: client } = facade(cashfreeProvider(fake.fetch, new Clock(NOW)));
      const error = await rejection(() => client.payments.create(Provider.Cashfree, { amount: AMOUNT, customer: CUSTOMER, reference: ORDER_ID }));
      expect(error.code).toBe(ErrorCode.Conflict);
      expect(error.providerCode).toBe('order_already_exists');
      expect(fake.calls).toHaveLength(1);
    });

    it('is OUTCOME_UNKNOWN after one request when the connection drops', async () => {
      const fake = scriptedFetch(() => ({ networkError: true }));
      const { subs: client } = facade(cashfreeProvider(fake.fetch, new Clock(NOW)));
      const error = await rejection(() => client.payments.create(Provider.Cashfree, { amount: AMOUNT, customer: CUSTOMER }));
      expect(error.code).toBe(ErrorCode.OutcomeUnknown);
      expect(fake.calls).toHaveLength(1);
    });
  });
});
