import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CheckoutKind,
  Currency,
  Environment,
  ErrorCode,
  HttpMethod,
  PaymentMethod,
  PaymentStatus,
  Provider,
  RefundStatus,
} from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import type { ProviderOptions } from '../../src/provider.js';
import { CashfreeProvider } from '../../src/providers/cashfree/index.js';
import { mockFetch, type MockRoute, type RecordedCall } from '../helpers/mock-fetch.js';
import {
  CREATE_ORDER_RESPONSE,
  GET_ORDER_ACTIVE,
  GET_ORDER_PAID,
  PAYMENTS_FOR_ORDER_CARD,
  PAYMENTS_FOR_ORDER_UPI,
  REFUND_ENTITY,
} from './payment-fixtures.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const CLIENT_ID = 'test_client_id_123';
const CLIENT_SECRET = 'test_client_secret_ZZ9_do_not_leak';
const SANDBOX = 'https://sandbox.cashfree.com/pg';
const PRODUCTION = 'https://api.cashfree.com/pg';
/** 2026-11-17 10:30 IST. */
const NOW = new Date('2026-11-17T05:00:00.000Z');
const UUID = '47bf8872-46fe-11ee-be56-0242ac120002';

/** Retries must not sleep for real. */
class TestCashfree extends CashfreeProvider {
  constructor(config: ConstructorParameters<typeof CashfreeProvider>[0], options?: ProviderOptions) {
    super(config, options);
    this.http.sleep = async () => {};
  }
}

function setup(routes: MockRoute[], overrides: Partial<ConstructorParameters<typeof CashfreeProvider>[0]> = {}) {
  const mock = mockFetch(routes);
  const provider = new TestCashfree(
    { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, environment: Environment.Test, ...overrides },
    { fetch: mock.fetch, now: () => NOW },
  );
  return { provider, ...mock };
}

async function rejection(promise: Promise<unknown>): Promise<SubscriptionError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SubscriptionError);
    return error as SubscriptionError;
  }
  throw new Error('expected the promise to reject');
}

function body(call: RecordedCall | undefined): Record<string, unknown> {
  expect(call).toBeDefined();
  return (call?.json ?? {}) as Record<string, unknown>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const AUTH_HEADERS = {
  'x-client-id': CLIENT_ID,
  'x-client-secret': CLIENT_SECRET,
  'x-api-version': '2026-01-01',
  accept: 'application/json',
};

const ORDER_ID = CREATE_ORDER_RESPONSE.order_id;
const PAID_ORDER_ID = GET_ORDER_PAID.order_id;
const ACTIVE_ORDER_ID = GET_ORDER_ACTIVE.order_id;
const UPI_ORDER_ID = 'order_8123';

function orderUrl(orderId: string): string {
  return `${SANDBOX}/orders/${orderId}`;
}

/** Routes for `getPayment` of an order: the order, its attempts, and (paid orders) its refunds. */
function loadRoutes(orderId: string, order: unknown, attempts: unknown, refunds?: unknown): MockRoute[] {
  const routes: MockRoute[] = [
    { method: HttpMethod.Get, url: orderUrl(orderId), json: order },
    { method: HttpMethod.Get, url: `${orderUrl(orderId)}/payments`, json: attempts },
  ];
  if (refunds !== undefined) routes.push({ method: HttpMethod.Get, url: `${orderUrl(orderId)}/refunds`, json: refunds });
  return routes;
}

const CUSTOMER = { name: 'John Doe', email: 'pmlpayme@ntsas.com', phone: '9876543210' };

// ---------------------------------------------------------------------------
// createPayment
// ---------------------------------------------------------------------------

describe('createPayment', () => {
  it('sends the order exactly as documented and returns the payment with its checkout', async () => {
    // Response: orders/create, example create_order_success (test/cashfree/payment-fixtures.ts).
    const { provider, calls } = setup([{ method: HttpMethod.Post, url: `${SANDBOX}/orders`, json: CREATE_ORDER_RESPONSE }]);
    const payment = await provider.createPayment({
      reference: ORDER_ID,
      amount: 2200,
      description: 'Order created for payment',
      customer: CUSTOMER,
      paymentMethods: [PaymentMethod.Upi, PaymentMethod.Card],
      returnUrl: 'https://www.cashfree.com/devstudio/thankyou',
      expiresAt: '2026-12-01T10:00:00Z',
      metadata: { name: 'John', age: '19' },
      idempotencyKey: UUID,
    });

    expect(calls).toHaveLength(1);
    const call = calls[0] as RecordedCall;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${SANDBOX}/orders`);
    expect(call.headers).toEqual({ ...AUTH_HEADERS, 'content-type': 'application/json', 'x-idempotency-key': UUID });
    expect(call.json).toEqual({
      order_id: ORDER_ID,
      order_amount: 22,
      order_currency: 'INR',
      customer_details: {
        customer_id: 'cust_9876543210',
        customer_phone: '9876543210',
        customer_email: 'pmlpayme@ntsas.com',
        customer_name: 'John Doe',
      },
      order_meta: {
        return_url: `https://www.cashfree.com/devstudio/thankyou?order_id=${ORDER_ID}`,
        payment_methods_filters: { methods: { action: 'ALLOW', values: ['upi', 'credit_card', 'debit_card', 'prepaid_card'] } },
      },
      order_expiry_time: '2026-12-01T15:30:00+05:30',
      order_note: 'Order created for payment',
      order_tags: { name: 'John', age: '19' },
    });

    expect(payment).toEqual({
      provider: Provider.Cashfree,
      id: ORDER_ID,
      reference: ORDER_ID,
      status: PaymentStatus.Created,
      providerStatus: 'ACTIVE',
      amount: 2200,
      currency: Currency.INR,
      refundedAmount: undefined,
      paymentMethod: undefined,
      customer: { id: '409128494', name: 'John Doe', email: 'pmlpayme@ntsas.com', phone: '9876543210' },
      createdAt: '2023-08-11T12:32:46.000Z',
      paidAt: undefined,
      checkout: {
        kind: CheckoutKind.CashfreeCheckout,
        sessionId: CREATE_ORDER_RESPONSE.payment_session_id,
        environment: Environment.Test,
        productKind: 'one_time',
      },
      metadata: { name: 'John', age: '19' },
      raw: CREATE_ORDER_RESPONSE,
    });
  });

  it('needs only an amount and a phone; the order id and customer id are derived', async () => {
    const { provider, calls } = setup([{ method: HttpMethod.Post, url: `${SANDBOX}/orders`, json: CREATE_ORDER_RESPONSE }]);
    await provider.createPayment({ amount: 1999, customer: { phone: '+919876543210' } });
    const sent = body(calls[0]);
    expect(sent['order_id']).toMatch(/^order_[0-9a-f]{32}$/);
    expect(sent['order_amount']).toBe(19.99);
    expect(sent['customer_details']).toEqual({ customer_id: 'cust_9876543210', customer_phone: '9876543210' });
    expect(sent).not.toHaveProperty('order_meta');
    expect(sent).not.toHaveProperty('order_expiry_time');
    expect(calls[0]?.headers).not.toHaveProperty('x-idempotency-key');
  });

  it('uses the caller customer id, accepts +91, and converts paise to rupees without drift', async () => {
    const { provider, calls } = setup([{ method: HttpMethod.Post, url: `${SANDBOX}/orders`, json: CREATE_ORDER_RESPONSE }]);
    await provider.createPayment({ amount: 100050, customer: { id: 'user_42', phone: '919876543210' } });
    const sent = body(calls[0]);
    expect(sent['order_amount']).toBe(1000.5);
    expect(sent['customer_details']).toEqual({ customer_id: 'user_42', customer_phone: '9876543210' });
  });

  it('restricts the order to every method asked for, once each', async () => {
    const { provider, calls } = setup([{ method: HttpMethod.Post, url: `${SANDBOX}/orders`, json: CREATE_ORDER_RESPONSE }]);
    await provider.createPayment({
      amount: 5000,
      customer: CUSTOMER,
      paymentMethods: [PaymentMethod.NetBanking, PaymentMethod.Wallet, PaymentMethod.Upi, PaymentMethod.NetBanking],
    });
    const meta = body(calls[0])['order_meta'];
    expect(meta).toEqual({
      payment_methods_filters: { methods: { action: 'ALLOW', values: ['netbanking', 'wallet', 'upi'] } },
    });
  });

  it('keeps a return URL that already names this order, and the rest of its query', async () => {
    const { provider, calls } = setup([{ method: HttpMethod.Post, url: `${SANDBOX}/orders`, json: CREATE_ORDER_RESPONSE }]);
    await provider.createPayment({
      reference: ORDER_ID,
      amount: 5000,
      customer: CUSTOMER,
      returnUrl: `https://shop.example.com/done?cart=7&order_id=${ORDER_ID}`,
    });
    const meta = body(calls[0])['order_meta'] as { return_url: string };
    expect(meta.return_url).toBe(`https://shop.example.com/done?cart=7&order_id=${ORDER_ID}`);
  });

  it('adds the order id to a return URL that has a query already', async () => {
    const { provider, calls } = setup([{ method: HttpMethod.Post, url: `${SANDBOX}/orders`, json: CREATE_ORDER_RESPONSE }]);
    await provider.createPayment({
      reference: 'order_abc',
      amount: 5000,
      customer: CUSTOMER,
      returnUrl: 'https://shop.example.com/done?cart=7',
    });
    expect((body(calls[0])['order_meta'] as { return_url: string }).return_url).toBe(
      'https://shop.example.com/done?cart=7&order_id=order_abc',
    );
  });

  it('calls the production host for the live environment', async () => {
    const { provider, calls } = setup(
      [{ method: HttpMethod.Post, url: `${PRODUCTION}/orders`, json: CREATE_ORDER_RESPONSE }],
      { environment: Environment.Live },
    );
    const payment = await provider.createPayment({ amount: 5000, customer: CUSTOMER });
    expect(calls[0]?.url).toBe(`${PRODUCTION}/orders`);
    expect(payment.checkout).toMatchObject({ environment: Environment.Live });
  });

  it('does not send customer.state or storeProduct: a gateway has no field for them', async () => {
    const { provider, calls } = setup([{ method: HttpMethod.Post, url: `${SANDBOX}/orders`, json: CREATE_ORDER_RESPONSE }]);
    await provider.createPayment({
      amount: 5000,
      customer: { ...CUSTOMER, state: 'Karnataka' },
      storeProduct: { productId: 'coins_100' },
    });
    expect(JSON.stringify(calls[0]?.json)).not.toContain('Karnataka');
    expect(JSON.stringify(calls[0]?.json)).not.toContain('coins_100');
  });

  describe('refuses what Cashfree cannot take, before any request', () => {
    const cases: Array<[string, Parameters<CashfreeProvider['createPayment']>[0], RegExp]> = [
      ['an amount under one rupee', { amount: 99, customer: CUSTOMER }, /at least 100 paise/],
      ['a reference that is too short', { reference: 'ab', amount: 5000, customer: CUSTOMER }, /order_id/],
      ['a reference that is too long', { reference: 'a'.repeat(46), amount: 5000, customer: CUSTOMER }, /order_id/],
      ['a reference with a space', { reference: 'order 1', amount: 5000, customer: CUSTOMER }, /order_id/],
      ['no phone', { amount: 5000, customer: { email: 'a@b.co' } }, /customer\.phone is required: Cashfree rejects an order/],
      ['a phone that is not an Indian mobile', { amount: 5000, customer: { phone: '+14155550123' } }, /10-digit Indian mobile/],
      ['a customer id with a space', { amount: 5000, customer: { id: 'bad id', phone: '9876543210' } }, /customer_id/],
      ['a customer name under 3 characters', { amount: 5000, customer: { name: 'Al', phone: '9876543210' } }, /customer\.name/],
      ['a description under 3 characters', { amount: 5000, customer: CUSTOMER, description: 'ab' }, /order_note/],
      ['a description over 200 characters', { amount: 5000, customer: CUSTOMER, description: 'x'.repeat(201) }, /order_note/],
      ['an expiry in the past', { amount: 5000, customer: CUSTOMER, expiresAt: '2026-11-17T04:59:00Z' }, /in the future/],
      [
        'more than 10 metadata entries',
        { amount: 5000, customer: CUSTOMER, metadata: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, 'v'])) },
        /at most 10 order tags/,
      ],
      ['an empty metadata value', { amount: 5000, customer: CUSTOMER, metadata: { note: '' } }, /metadata "note"/],
      ['a metadata value over 255 characters', { amount: 5000, customer: CUSTOMER, metadata: { note: 'x'.repeat(256) } }, /metadata "note"/],
      [
        'a return URL with another order id',
        { amount: 5000, customer: CUSTOMER, reference: 'order_abc', returnUrl: 'https://shop.example.com/done?order_id=other' },
        /already has an order_id parameter/,
      ],
      [
        'a return URL over 250 characters',
        { amount: 5000, customer: CUSTOMER, returnUrl: `https://shop.example.com/${'a'.repeat(240)}` },
        /Cashfree allows 250/,
      ],
      ['an idempotency key that is not a UUID', { amount: 5000, customer: CUSTOMER, idempotencyKey: 'order-1' }, /must be a UUID/],
    ];
    for (const [name, input, message] of cases) {
      it(name, async () => {
        const { provider, calls } = setup([]);
        const error = await rejection(provider.createPayment(input));
        expect(error.code).toBe(ErrorCode.Validation);
        expect(error.message).toMatch(message);
        expect(calls).toHaveLength(0);
      });
    }

    for (const method of [PaymentMethod.ENach, PaymentMethod.PhysicalNach]) {
      it(`${method} as a payment method (UNSUPPORTED)`, async () => {
        const { provider, calls } = setup([]);
        const error = await rejection(provider.createPayment({ amount: 5000, customer: CUSTOMER, paymentMethods: [PaymentMethod.Upi, method] }));
        expect(error.code).toBe(ErrorCode.Unsupported);
        expect(calls).toHaveLength(0);
      });
    }

    it('input that fails the shared schema', async () => {
      const { provider, calls } = setup([]);
      const error = await rejection(provider.createPayment({ amount: 0, customer: CUSTOMER }));
      expect(error.code).toBe(ErrorCode.Validation);
      expect(calls).toHaveLength(0);
    });
  });

  it('raises UNEXPECTED_RESPONSE when Cashfree returns no payment session id', async () => {
    const response = { ...clone(CREATE_ORDER_RESPONSE), payment_session_id: null };
    const { provider } = setup([{ method: HttpMethod.Post, url: `${SANDBOX}/orders`, json: response }]);
    const error = await rejection(provider.createPayment({ amount: 5000, customer: CUSTOMER }));
    expect(error.code).toBe(ErrorCode.UnexpectedResponse);
  });

  it('maps a reused order id (409) to CONFLICT', async () => {
    // orders/create, response 409: "order with same id is already present".
    const { provider } = setup([
      {
        method: HttpMethod.Post,
        url: `${SANDBOX}/orders`,
        status: 409,
        json: {
          message: 'order with same id is already present',
          code: 'order_already_exists',
          type: 'invalid_request_error',
        },
      },
    ]);
    const error = await rejection(provider.createPayment({ reference: ORDER_ID, amount: 5000, customer: CUSTOMER }));
    expect(error.code).toBe(ErrorCode.Conflict);
    expect(error.providerCode).toBe('order_already_exists');
  });

  it('is OUTCOME_UNKNOWN when a create without an idempotency key gets no response, and is not retried', async () => {
    const { provider, calls } = setup([{ method: HttpMethod.Post, url: `${SANDBOX}/orders`, networkError: true }]);
    const error = await rejection(provider.createPayment({ amount: 5000, customer: CUSTOMER }));
    expect(error.code).toBe(ErrorCode.OutcomeUnknown);
    expect(calls).toHaveLength(1);
  });

  it('retries a create that carries an idempotency key', async () => {
    const { provider, calls } = setup([
      { method: HttpMethod.Post, url: `${SANDBOX}/orders`, networkError: true },
      { method: HttpMethod.Post, url: `${SANDBOX}/orders`, json: CREATE_ORDER_RESPONSE },
    ]);
    const payment = await provider.createPayment({ amount: 5000, customer: CUSTOMER, idempotencyKey: UUID });
    expect(payment.id).toBe(ORDER_ID);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.headers['x-idempotency-key']).toBe(UUID);
  });

  it('never puts the secrets in an error', async () => {
    const { provider } = setup([
      { method: HttpMethod.Post, url: `${SANDBOX}/orders`, status: 401, json: { message: 'authentication Failed', code: 'request_failed', type: 'authentication_error' } },
    ]);
    const error = await rejection(provider.createPayment({ amount: 5000, customer: CUSTOMER }));
    expect(error.code).toBe(ErrorCode.Auth);
    expect(JSON.stringify(error)).not.toContain(CLIENT_SECRET);
    expect(error.message).not.toContain(CLIENT_SECRET);
  });
});

// ---------------------------------------------------------------------------
// getPayment
// ---------------------------------------------------------------------------

describe('getPayment', () => {
  it('reads the order, its attempts and its refunds for a paid order', async () => {
    // orders/get example get_order_paid; payments-for-order example payments_entity_list_example (first two entries).
    const { provider, calls } = setup(loadRoutes(PAID_ORDER_ID, GET_ORDER_PAID, PAYMENTS_FOR_ORDER_UPI, []));
    const payment = await provider.getPayment(PAID_ORDER_ID);

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${orderUrl(PAID_ORDER_ID)}`,
      `GET ${orderUrl(PAID_ORDER_ID)}/payments`,
      `GET ${orderUrl(PAID_ORDER_ID)}/refunds`,
    ]);
    for (const call of calls) {
      expect(call.headers).toEqual(AUTH_HEADERS);
      expect(call.body).toBeUndefined();
    }

    expect(payment).toMatchObject({
      provider: Provider.Cashfree,
      id: PAID_ORDER_ID,
      reference: PAID_ORDER_ID,
      status: PaymentStatus.Succeeded,
      providerStatus: 'PAID',
      amount: 15050,
      currency: Currency.INR,
      refundedAmount: 0,
      paymentMethod: PaymentMethod.Upi,
      paidAt: '2021-07-23T06:48:59.000Z',
      customer: { id: '409128495', name: 'Jane Smith', email: 'jane.smith@example.com', phone: '9876543211' },
      createdAt: '2023-08-10T09:00:20.000Z',
      metadata: { product: 'Premium Plan', category: 'subscription' },
    });
    expect(payment.checkout).toBeUndefined();
    expect(payment.failureCode).toBeUndefined();
    expect(payment.raw).toEqual({ order: GET_ORDER_PAID, payments: PAYMENTS_FOR_ORDER_UPI, refunds: [] });
  });

  it('reports a part-refunded payment with the amount refunded so far', async () => {
    // refunds/create-refund example refunds_entity_example: a SUCCESS refund of 100.81 against an order of 150.5.
    const { provider } = setup(loadRoutes(PAID_ORDER_ID, GET_ORDER_PAID, PAYMENTS_FOR_ORDER_UPI, [REFUND_ENTITY]));
    const payment = await provider.getPayment(PAID_ORDER_ID);
    expect(payment.status).toBe(PaymentStatus.PartiallyRefunded);
    expect(payment.providerStatus).toBe('PAID');
    expect(payment.refundedAmount).toBe(10081);
    expect(payment.paidAt).toBe('2021-07-23T06:48:59.000Z');
  });

  it('reports a fully refunded payment, and counts only refunds that succeeded', async () => {
    const full = { ...clone(REFUND_ENTITY), refund_amount: 150.5 };
    const inFlight = { ...clone(REFUND_ENTITY), refund_id: 'REF-2', refund_status: 'PENDING', refund_amount: 50 };
    const failed = { ...clone(REFUND_ENTITY), refund_id: 'REF-3', refund_status: 'CANCELLED', refund_amount: 50 };
    const { provider } = setup(loadRoutes(PAID_ORDER_ID, GET_ORDER_PAID, PAYMENTS_FOR_ORDER_UPI, [full, inFlight, failed]));
    const payment = await provider.getPayment(PAID_ORDER_ID);
    expect(payment.status).toBe(PaymentStatus.Refunded);
    expect(payment.refundedAmount).toBe(15050);

    const partial = setup(loadRoutes(PAID_ORDER_ID, GET_ORDER_PAID, PAYMENTS_FOR_ORDER_UPI, [inFlight, failed]));
    expect((await partial.provider.getPayment(PAID_ORDER_ID)).status).toBe(PaymentStatus.Succeeded);
  });

  it('reads the card attempt of the documentation sample, whose status the page nests inside payment_method', async () => {
    // payments-for-order example `card`: payment_status sits inside payment_method on the page. The order status still decides.
    const order = { ...clone(GET_ORDER_PAID), order_id: 'order_18482zuD6LhQGYO3OOihGjnlDV4OzpD', order_amount: 1 };
    const { provider } = setup(loadRoutes(order.order_id, order, PAYMENTS_FOR_ORDER_CARD, []));
    const payment = await provider.getPayment(order.order_id);
    expect(payment.status).toBe(PaymentStatus.Succeeded);
    expect(payment.amount).toBe(100);
  });

  it('keeps an active order created, with a checkout to reopen, and does not read refunds', async () => {
    // orders/get example get_order_active.
    const { provider, calls } = setup(loadRoutes(ACTIVE_ORDER_ID, GET_ORDER_ACTIVE, []));
    const payment = await provider.getPayment(ACTIVE_ORDER_ID);
    expect(calls).toHaveLength(2);
    expect(payment.status).toBe(PaymentStatus.Created);
    expect(payment.amount).toBe(2200);
    expect(payment.checkout).toEqual({
      kind: CheckoutKind.CashfreeCheckout,
      sessionId: GET_ORDER_ACTIVE.payment_session_id,
      environment: Environment.Test,
      productKind: 'one_time',
    });
  });

  it('keeps an active order created after a failed attempt: the customer may retry', async () => {
    const failedOnly = [clone(PAYMENTS_FOR_ORDER_UPI)[1]];
    const { provider } = setup(loadRoutes(ACTIVE_ORDER_ID, GET_ORDER_ACTIVE, failedOnly));
    const payment = await provider.getPayment(ACTIVE_ORDER_ID);
    expect(payment.status).toBe(PaymentStatus.Created);
    expect(payment.failureCode).toBeUndefined();
  });

  it('reads an active or expired order as pending while an attempt is in flight', async () => {
    const attempt = { ...clone(PAYMENTS_FOR_ORDER_UPI)[0], payment_status: 'PENDING' };
    for (const orderStatus of ['ACTIVE', 'EXPIRED']) {
      const order = { ...clone(GET_ORDER_ACTIVE), order_status: orderStatus };
      const { provider } = setup(loadRoutes(ACTIVE_ORDER_ID, order, [attempt]));
      expect((await provider.getPayment(ACTIVE_ORDER_ID)).status, orderStatus).toBe(PaymentStatus.Pending);
    }
  });

  it('reports an expired order as failed, with the latest failed attempt as the reason', async () => {
    const [success, failed] = clone(PAYMENTS_FOR_ORDER_UPI) as Array<Record<string, unknown>>;
    const earlier = { ...failed, cf_payment_id: '1', payment_completion_time: '2021-07-23T10:00:00+05:30', error_details: { error_code: 'OLD', error_description: 'old attempt' } };
    const order = { ...clone(GET_ORDER_ACTIVE), order_status: 'EXPIRED' };
    // The attempts arrive in no documented order: the latest one by completion time wins.
    const { provider } = setup(loadRoutes(ACTIVE_ORDER_ID, order, [failed, earlier, { ...success, payment_status: 'USER_DROPPED', error_details: null, payment_message: 'dropped', payment_completion_time: '2021-07-22T10:00:00+05:30' }]));
    const payment = await provider.getPayment(ACTIVE_ORDER_ID);
    expect(payment.status).toBe(PaymentStatus.Failed);
    expect(payment.providerStatus).toBe('EXPIRED');
    expect(payment.failureCode).toBe('TRANSACTION_DECLINED');
    expect(payment.failureReason).toBe('issuer bank or payment service provider declined the transaction');
    expect(payment.paymentMethod).toBeUndefined();
  });

  it('maps order states: terminated is cancelled, termination requested pending, an unknown status pending and verbatim', async () => {
    const expected: Array<[string, PaymentStatus]> = [
      ['TERMINATED', PaymentStatus.Cancelled],
      ['TERMINATION_REQUESTED', PaymentStatus.Pending],
      ['SOME_NEW_STATE', PaymentStatus.Pending],
      ['expired', PaymentStatus.Failed],
    ];
    for (const [orderStatus, status] of expected) {
      const order = { ...clone(GET_ORDER_ACTIVE), order_status: orderStatus };
      const { provider } = setup(loadRoutes(ACTIVE_ORDER_ID, order, []));
      const payment = await provider.getPayment(ACTIVE_ORDER_ID);
      expect(payment.status, orderStatus).toBe(status);
      expect(payment.providerStatus).toBe(orderStatus);
    }
  });

  it('is NOT_FOUND for an unknown order', async () => {
    const { provider } = setup([
      {
        method: HttpMethod.Get,
        url: orderUrl('nope'),
        status: 404,
        json: { message: 'order not found', code: 'order_not_found', type: 'invalid_request_error' },
      },
    ]);
    const error = await rejection(provider.getPayment('nope'));
    expect(error.code).toBe(ErrorCode.NotFound);
  });

  it('refuses an empty payment id without a request', async () => {
    const { provider, calls } = setup([]);
    expect((await rejection(provider.getPayment('  '))).code).toBe(ErrorCode.Validation);
    expect(calls).toHaveLength(0);
  });

  it('url-encodes the order id', async () => {
    const order = { ...clone(GET_ORDER_ACTIVE), order_id: 'a/b' };
    const { provider, calls } = setup([
      { method: HttpMethod.Get, url: `${SANDBOX}/orders/a%2Fb`, json: order },
      { method: HttpMethod.Get, url: `${SANDBOX}/orders/a%2Fb/payments`, json: [] },
    ]);
    await provider.getPayment('a/b');
    expect(calls[0]?.url).toBe(`${SANDBOX}/orders/a%2Fb`);
  });

  it('rejects a response whose order has no status', async () => {
    const { order_status: _omitted, ...incomplete } = clone(GET_ORDER_ACTIVE);
    const { provider } = setup([{ method: HttpMethod.Get, url: orderUrl(ACTIVE_ORDER_ID), json: incomplete }]);
    expect((await rejection(provider.getPayment(ACTIVE_ORDER_ID))).code).toBe(ErrorCode.UnexpectedResponse);
  });
});

// ---------------------------------------------------------------------------
// verifyPayment
// ---------------------------------------------------------------------------

describe('verifyPayment', () => {
  it('fetches the order named by the return URL and reports paid only when Cashfree says PAID', async () => {
    const { provider, calls } = setup(loadRoutes(PAID_ORDER_ID, GET_ORDER_PAID, PAYMENTS_FOR_ORDER_UPI, []));
    const verification = await provider.verifyPayment({ order_id: PAID_ORDER_ID });
    expect(calls[0]?.url).toBe(orderUrl(PAID_ORDER_ID));
    expect(verification).toMatchObject({
      provider: Provider.Cashfree,
      paymentId: PAID_ORDER_ID,
      reference: PAID_ORDER_ID,
      paid: true,
      status: PaymentStatus.Succeeded,
    });
    expect(verification.payment?.id).toBe(PAID_ORDER_ID);
    expect(verification.raw).toEqual({ order: GET_ORDER_PAID, payments: PAYMENTS_FOR_ORDER_UPI, refunds: [] });
  });

  it('trusts nothing else in the query: a forged status does not make an unpaid order paid', async () => {
    const { provider } = setup(loadRoutes(ACTIVE_ORDER_ID, GET_ORDER_ACTIVE, []));
    const verification = await provider.verifyPayment({
      order_id: ACTIVE_ORDER_ID,
      order_status: 'PAID',
      payment_status: 'SUCCESS',
      cf_payment_id: '1',
    });
    expect(verification.paid).toBe(false);
    expect(verification.status).toBe(PaymentStatus.Created);
  });

  it('is not paid for a pending or failed order', async () => {
    const attempt = { ...clone(PAYMENTS_FOR_ORDER_UPI)[0], payment_status: 'PENDING' };
    const pending = setup(loadRoutes(ACTIVE_ORDER_ID, GET_ORDER_ACTIVE, [attempt]));
    expect((await pending.provider.verifyPayment({ order_id: ACTIVE_ORDER_ID })).paid).toBe(false);
    const expired = setup(loadRoutes(ACTIVE_ORDER_ID, { ...clone(GET_ORDER_ACTIVE), order_status: 'EXPIRED' }, []));
    const result = await expired.provider.verifyPayment({ order_id: ACTIVE_ORDER_ID });
    expect(result).toMatchObject({ paid: false, status: PaymentStatus.Failed });
  });

  it('keeps a part-refunded payment paid, and a fully refunded one not', async () => {
    const part = setup(loadRoutes(PAID_ORDER_ID, GET_ORDER_PAID, PAYMENTS_FOR_ORDER_UPI, [REFUND_ENTITY]));
    expect(await part.provider.verifyPayment({ order_id: PAID_ORDER_ID })).toMatchObject({ paid: true, status: PaymentStatus.PartiallyRefunded });
    const full = setup(loadRoutes(PAID_ORDER_ID, GET_ORDER_PAID, PAYMENTS_FOR_ORDER_UPI, [{ ...clone(REFUND_ENTITY), refund_amount: 150.5 }]));
    expect(await full.provider.verifyPayment({ order_id: PAID_ORDER_ID })).toMatchObject({ paid: false, status: PaymentStatus.Refunded });
  });

  it('refuses a result without an order id, with no request', async () => {
    const { provider, calls } = setup([]);
    for (const result of [{}, { order_id: '' }, { order_id: 42 }, { cf_subscriptionId: 'sub_1' }]) {
      expect((await rejection(provider.verifyPayment(result))).code).toBe(ErrorCode.Validation);
    }
    expect(calls).toHaveLength(0);
  });

  it('is NOT_FOUND when the order named in the query does not exist', async () => {
    const { provider } = setup([
      { method: HttpMethod.Get, url: orderUrl('ghost'), status: 404, json: { message: 'order not found', code: 'order_not_found', type: 'invalid_request_error' } },
    ]);
    expect((await rejection(provider.verifyPayment({ order_id: 'ghost' }))).code).toBe(ErrorCode.NotFound);
  });
});

// ---------------------------------------------------------------------------
// refundPayment
// ---------------------------------------------------------------------------

/** The x-idempotency-key of a refund, computed here independently: SHA-256 of "<order>\n<refund>" shaped as a version 4 UUID. */
function expectedRefundKey(orderId: string, refundId: string): string {
  const hex = createHash('sha256').update(`${orderId}\n${refundId}`).digest('hex');
  const variant = ((Number.parseInt(hex[16] as string, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

describe('refundPayment', () => {
  const REFUND_ORDER = REFUND_ENTITY.order_id;

  it('sends a partial refund exactly as documented and maps the response', async () => {
    // Response: refunds/create-refund example refunds_entity_example.
    const { provider, calls } = setup([{ method: HttpMethod.Post, url: `${orderUrl(REFUND_ORDER)}/refunds`, json: REFUND_ENTITY }]);
    const refund = await provider.refundPayment({ paymentId: REFUND_ORDER, refundId: 'REF-123', amount: 10081, reason: 'Refund for order #123' });

    expect(calls).toHaveLength(1);
    const call = calls[0] as RecordedCall;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${orderUrl(REFUND_ORDER)}/refunds`);
    expect(call.headers).toEqual({
      ...AUTH_HEADERS,
      'content-type': 'application/json',
      'x-idempotency-key': expectedRefundKey(REFUND_ORDER, 'REF-123'),
    });
    expect(call.headers['x-idempotency-key']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(call.json).toEqual({ refund_amount: 100.81, refund_id: 'REF-123', refund_note: 'Refund for order #123' });

    expect(refund).toEqual({
      provider: Provider.Cashfree,
      id: 'REF-123',
      reference: 'REF-123',
      chargeId: REFUND_ORDER,
      paymentId: REFUND_ORDER,
      status: RefundStatus.Succeeded,
      providerStatus: 'SUCCESS',
      amount: 10081,
      currency: Currency.INR,
      createdAt: '2021-07-25T03:27:52.000Z',
      raw: REFUND_ENTITY,
    });
  });

  it('presents the same idempotency key for a retry of the same refund, and another for another refund', async () => {
    const first = setup([{ method: HttpMethod.Post, url: /refunds$/, json: REFUND_ENTITY }]);
    await first.provider.refundPayment({ paymentId: REFUND_ORDER, refundId: 'REF-123', amount: 100 });
    const second = setup([{ method: HttpMethod.Post, url: /refunds$/, json: REFUND_ENTITY }]);
    await second.provider.refundPayment({ paymentId: REFUND_ORDER, refundId: 'REF-123', amount: 100 });
    const third = setup([{ method: HttpMethod.Post, url: /refunds$/, json: REFUND_ENTITY }]);
    await third.provider.refundPayment({ paymentId: REFUND_ORDER, refundId: 'REF-124', amount: 100 });
    expect(second.calls[0]?.headers['x-idempotency-key']).toBe(first.calls[0]?.headers['x-idempotency-key']);
    expect(third.calls[0]?.headers['x-idempotency-key']).not.toBe(first.calls[0]?.headers['x-idempotency-key']);
  });

  it('retries a refund whose response was lost', async () => {
    const { provider, calls } = setup([
      { method: HttpMethod.Post, url: /refunds$/, networkError: true },
      { method: HttpMethod.Post, url: /refunds$/, json: REFUND_ENTITY },
    ]);
    const refund = await provider.refundPayment({ paymentId: REFUND_ORDER, refundId: 'REF-123', amount: 100 });
    expect(refund.status).toBe(RefundStatus.Succeeded);
    expect(calls[1]?.headers['x-idempotency-key']).toBe(calls[0]?.headers['x-idempotency-key']);
  });

  it('refunds what is left when no amount is given: the successful attempt minus refunds already claimed', async () => {
    // payments-for-order example: a SUCCESS attempt of 10.01 on order_8123.
    const claimed = { ...clone(REFUND_ENTITY), refund_id: 'earlier_1', refund_status: 'PENDING', refund_amount: 3 };
    const failed = { ...clone(REFUND_ENTITY), refund_id: 'earlier_2', refund_status: 'REJECTED', refund_amount: 5 };
    const { provider, calls } = setup([
      { method: HttpMethod.Get, url: `${orderUrl(UPI_ORDER_ID)}/payments`, json: PAYMENTS_FOR_ORDER_UPI },
      { method: HttpMethod.Get, url: `${orderUrl(UPI_ORDER_ID)}/refunds`, json: [claimed, failed] },
      { method: HttpMethod.Post, url: `${orderUrl(UPI_ORDER_ID)}/refunds`, json: { ...clone(REFUND_ENTITY), order_id: UPI_ORDER_ID, refund_amount: 7.01 } },
    ]);
    const refund = await provider.refundPayment({ paymentId: UPI_ORDER_ID, refundId: 'full_refund_1' });
    expect(calls.map((call) => call.method)).toEqual(['GET', 'GET', 'POST']);
    expect(body(calls[2])).toEqual({ refund_amount: 7.01, refund_id: 'full_refund_1' });
    expect(refund.amount).toBe(701);
    expect(refund.paymentId).toBe(UPI_ORDER_ID);
  });

  it('refuses a full refund of an order with no successful attempt, or one already refunded in full', async () => {
    const failedOnly = [clone(PAYMENTS_FOR_ORDER_UPI)[1]];
    const none = setup([{ method: HttpMethod.Get, url: `${orderUrl(UPI_ORDER_ID)}/payments`, json: failedOnly }]);
    const noSuccess = await rejection(none.provider.refundPayment({ paymentId: UPI_ORDER_ID, refundId: 'full_refund_1' }));
    expect(noSuccess.code).toBe(ErrorCode.Validation);
    expect(noSuccess.message).toMatch(/no successful payment/);

    const done = setup([
      { method: HttpMethod.Get, url: `${orderUrl(UPI_ORDER_ID)}/payments`, json: PAYMENTS_FOR_ORDER_UPI },
      { method: HttpMethod.Get, url: `${orderUrl(UPI_ORDER_ID)}/refunds`, json: [{ ...clone(REFUND_ENTITY), refund_amount: 10.01 }] },
    ]);
    const spent = await rejection(done.provider.refundPayment({ paymentId: UPI_ORDER_ID, refundId: 'full_refund_1' }));
    expect(spent.message).toMatch(/already been refunded in full/);
    expect(done.calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('maps every documented refund status', async () => {
    const expected: Record<string, RefundStatus> = {
      SUCCESS: RefundStatus.Succeeded,
      PENDING: RefundStatus.Pending,
      PENDING_APPROVAL: RefundStatus.Pending,
      ONHOLD: RefundStatus.Pending,
      CANCELLED: RefundStatus.Failed,
      REJECTED: RefundStatus.Failed,
      SOMETHING_NEW: RefundStatus.Pending,
    };
    for (const [providerStatus, status] of Object.entries(expected)) {
      const { provider } = setup([{ method: HttpMethod.Post, url: /refunds$/, json: { ...clone(REFUND_ENTITY), refund_status: providerStatus } }]);
      const refund = await provider.refundPayment({ paymentId: REFUND_ORDER, refundId: 'REF-123', amount: 100 });
      expect(refund.status, providerStatus).toBe(status);
      expect(refund.providerStatus).toBe(providerStatus);
    }
  });

  it('falls back to the request for fields a response omits', async () => {
    const { order_id: _order, refund_amount: _amount, created_at: _created, ...sparse } = clone(REFUND_ENTITY);
    const { provider } = setup([{ method: HttpMethod.Post, url: /refunds$/, json: sparse }]);
    const refund = await provider.refundPayment({ paymentId: REFUND_ORDER, refundId: 'REF-123', amount: 250 });
    expect(refund).toMatchObject({ chargeId: REFUND_ORDER, paymentId: REFUND_ORDER, amount: 250, createdAt: NOW.toISOString() });
  });

  it('maps a refund that already exists (409) to CONFLICT', async () => {
    const { provider } = setup([
      { method: HttpMethod.Post, url: /refunds$/, status: 409, json: { message: 'refund already exists', code: 'refund_already_exists', type: 'invalid_request_error' } },
    ]);
    const error = await rejection(provider.refundPayment({ paymentId: REFUND_ORDER, refundId: 'REF-123', amount: 100 }));
    expect(error.code).toBe(ErrorCode.Conflict);
  });

  it('maps a reused refund id with another amount (422 idempotency error) to CONFLICT', async () => {
    const { provider } = setup([
      {
        method: HttpMethod.Post,
        url: /refunds$/,
        status: 422,
        json: { message: 'Different request body with the same idempotent key', code: 'idempotency_error', type: 'idempotency_error' },
      },
    ]);
    const error = await rejection(provider.refundPayment({ paymentId: REFUND_ORDER, refundId: 'REF-123', amount: 100 }));
    expect(error.code).toBe(ErrorCode.Conflict);
  });

  describe('refuses before any request', () => {
    const cases: Array<[string, Parameters<CashfreeProvider['refundPayment']>[0], RegExp]> = [
      ['a refund id under 3 characters', { paymentId: REFUND_ORDER, refundId: 'ab', amount: 100 }, /refundId/],
      ['a refund id with a space', { paymentId: REFUND_ORDER, refundId: 'refund 1', amount: 100 }, /refundId/],
      ['a refund id over 40 characters', { paymentId: REFUND_ORDER, refundId: 'r'.repeat(41), amount: 100 }, /refundId/],
      ['a reason under 3 characters', { paymentId: REFUND_ORDER, refundId: 'REF-1', amount: 100, reason: 'no' }, /refund_note/],
      ['a reason over 100 characters', { paymentId: REFUND_ORDER, refundId: 'REF-1', amount: 100, reason: 'x'.repeat(101) }, /refund_note/],
      ['a zero amount', { paymentId: REFUND_ORDER, refundId: 'REF-1', amount: 0 }, /amount/],
    ];
    for (const [name, input, message] of cases) {
      it(name, async () => {
        const { provider, calls } = setup([]);
        const error = await rejection(provider.refundPayment(input));
        expect(error.code).toBe(ErrorCode.Validation);
        expect(error.message).toMatch(message);
        expect(calls).toHaveLength(0);
      });
    }
  });
});
