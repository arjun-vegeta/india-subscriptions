import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CheckoutKind, ErrorCode, HttpMethod, PaymentMethod, PaymentStatus, RefundStatus } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import type { ProviderOptions } from '../../src/provider.js';
import { PaymentSchema, PaymentVerificationSchema, RefundSchema, type CreatePaymentInput } from '../../src/schemas.js';
import { RAZORPAY_EXPECTED_ORDER_ID_KEY, RazorpayNoteKey } from '../../src/providers/razorpay/constants.js';
import { razorpay, type RazorpayConfig } from '../../src/providers/razorpay/index.js';
import { mockFetch, type MockRoute, type RecordedCall } from '../helpers/mock-fetch.js';
import {
  CHECKOUT_SUCCESS_CALLBACK,
  ORDER_CREATED,
  ORDER_CREATE_FAILURE,
  ORDER_FETCHED,
  ORDER_PAYMENTS,
  REFUND_CREATED,
} from './one-time-fixtures.js';

/*
 * One-time payment tests for the adapter: the exact outgoing request and the
 * normalised result for createPayment, getPayment, verifyPayment and
 * refundPayment. Response fixtures are the verbatim samples in
 * one-time-fixtures.ts (each names its Razorpay page). Where a test needs a
 * response that differs from a sample it overrides named fields of the sample
 * and says so. Signatures are computed here with node:crypto.
 */

const BASE = 'https://api.razorpay.com';
const KEY_ID = 'test_key_id';
const KEY_SECRET = 'test_key_secret_value';
const AUTH = `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`, 'utf8').toString('base64')}`;
const json = (text: string) => JSON.parse(text) as Record<string, any>;
const iso = (unix: number) => new Date(unix * 1000).toISOString();

function setup(routes: MockRoute[], options: ProviderOptions = {}, config: Partial<RazorpayConfig> = {}) {
  const mock = mockFetch(routes);
  const provider = razorpay({ keyId: KEY_ID, keySecret: KEY_SECRET, ...config }, { fetch: mock.fetch, maxRetries: 0, ...options });
  (provider as unknown as { http: { sleep: () => Promise<void> } }).http.sleep = async () => {};
  return { provider, calls: mock.calls, remaining: mock.remaining };
}

const route = (method: HttpMethod, path: string | RegExp, body: unknown, status = 200): MockRoute => ({
  method,
  url: typeof path === 'string' ? `${BASE}${path}` : path,
  json: body,
  status,
});

function expectRequest(call: RecordedCall | undefined, method: HttpMethod, url: string, body?: unknown) {
  expect(call).toBeDefined();
  expect(call?.method).toBe(method);
  expect(call?.url).toBe(url);
  expect(call?.headers.authorization).toBe(AUTH);
  expect(call?.headers.accept).toBe('application/json');
  if (body === undefined) {
    expect(call?.body).toBeUndefined();
  } else {
    expect(call?.headers['content-type']).toBe('application/json');
    expect(call?.json).toEqual(body);
    expect(call?.body).toBe(JSON.stringify(call?.json));
  }
}

async function failure(run: () => Promise<unknown>): Promise<SubscriptionError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(SubscriptionError);
    return error as SubscriptionError;
  }
  throw new Error('expected the call to reject');
}

const hmac = (message: string, secret = KEY_SECRET) => createHmac('sha256', secret).update(message, 'utf8').digest('hex');

const CUSTOMER = { name: 'Gaurav Kumar', email: 'gaurav.kumar@example.com', phone: '+919000090000' };
const payInput = (over: Partial<CreatePaymentInput> = {}): CreatePaymentInput => ({ amount: 5000, customer: CUSTOMER, ...over });

// The order of the orders/fetch-payments sample: a failed UPI attempt, then a captured one.
const PAYMENTS_ORDER_ID = 'order_N8FRN5zTm5S3wx';
const FAILED_PAYMENT_ID = 'pay_N8FUmetkCE2hZP';
const CAPTURED_PAYMENT_ID = 'pay_N8FVRD1DzYzBh1';
/** orders/fetch-with-id sample with the id, amount and status of the order the payments sample belongs to. */
const orderOf = (over: Record<string, unknown> = {}) => ({
  ...json(ORDER_FETCHED),
  id: PAYMENTS_ORDER_ID,
  amount: 100,
  amount_due: 0,
  amount_paid: 100,
  status: 'paid',
  attempts: 2,
  ...over,
});
const paymentsCollection = (items: Array<Record<string, unknown>>) => ({ entity: 'collection', count: items.length, items });
const attempts = () => json(ORDER_PAYMENTS).items as Array<Record<string, any>>;

describe('createPayment', () => {
  it('creates an order: POST /v1/orders with the amount in paise, INR, and the reference, description and metadata as notes', async () => {
    // orders/create "Success" sample, with the notes the request carried.
    const response = {
      ...json(ORDER_CREATED),
      notes: {
        plan: 'pro',
        [RazorpayNoteKey.PaymentReference]: 'order-1001',
        [RazorpayNoteKey.PaymentDescription]: 'Pro plan, one year',
      },
    };
    const { provider, calls } = setup([route(HttpMethod.Post, '/v1/orders', response)]);
    const payment = await provider.createPayment(
      payInput({
        reference: 'order-1001',
        description: 'Pro plan, one year',
        metadata: { plan: 'pro' },
        returnUrl: 'https://merchant.example.com/razorpay/callback',
      }),
    );

    expect(calls).toHaveLength(1);
    expectRequest(calls[0], HttpMethod.Post, `${BASE}/v1/orders`, {
      amount: 5000,
      currency: 'INR',
      notes: {
        plan: 'pro',
        [RazorpayNoteKey.PaymentReference]: 'order-1001',
        [RazorpayNoteKey.PaymentDescription]: 'Pro plan, one year',
      },
    });
    expect(payment).toEqual({
      provider: 'razorpay',
      id: 'order_RB58MiP5SPFYyM',
      reference: 'order-1001',
      status: PaymentStatus.Created,
      providerStatus: 'created',
      amount: 5000,
      currency: 'INR',
      customer: CUSTOMER,
      createdAt: iso(1756455561),
      checkout: {
        kind: CheckoutKind.RazorpayCheckout,
        keyId: KEY_ID,
        orderId: 'order_RB58MiP5SPFYyM',
        amount: 5000,
        callbackUrl: 'https://merchant.example.com/razorpay/callback',
        prefill: CUSTOMER,
      },
      metadata: { plan: 'pro' },
      raw: { order: response, payments: [] },
    });
    expect(PaymentSchema.safeParse(payment).success).toBe(true);
  });

  it('sends the idempotencyKey as the receipt; with the documented sample values the body is the documented curl body', async () => {
    const { provider, calls } = setup([route(HttpMethod.Post, '/v1/orders', json(ORDER_CREATED))]);
    const payment = await provider.createPayment(
      payInput({ idempotencyKey: 'receipt#1', metadata: { key1: 'value3', key2: 'value2' } }),
    );
    // The curl sample of orders/create: amount 5000, INR, receipt "receipt#1", notes key1 and key2.
    expectRequest(calls[0], HttpMethod.Post, `${BASE}/v1/orders`, {
      amount: 5000,
      currency: 'INR',
      receipt: 'receipt#1',
      notes: { key1: 'value3', key2: 'value2' },
    });
    expect(payment.metadata).toEqual({ key1: 'value3', key2: 'value2' });
    expect(payment.reference).toBeUndefined();
  });

  it('sends only amount and currency when nothing else is given, and leaves out prefill the customer did not give', async () => {
    const { provider, calls } = setup([route(HttpMethod.Post, '/v1/orders', { ...json(ORDER_CREATED), notes: [] })]);
    const payment = await provider.createPayment({ amount: 100, customer: { email: 'a@example.com' } });
    expectRequest(calls[0], HttpMethod.Post, `${BASE}/v1/orders`, { amount: 100, currency: 'INR' });
    expect(payment.checkout).toEqual({
      kind: 'razorpay_checkout',
      keyId: KEY_ID,
      orderId: 'order_RB58MiP5SPFYyM',
      amount: 5000,
      prefill: { email: 'a@example.com' },
    });
    expect(payment.metadata).toBeUndefined();
  });

  it('is UNSUPPORTED for paymentMethods and for expiresAt, before any request is sent', async () => {
    const { provider, calls } = setup([]);
    const methods = await failure(() => provider.createPayment(payInput({ paymentMethods: [PaymentMethod.Upi] })));
    expect(methods.code).toBe(ErrorCode.Unsupported);
    expect(methods.message).toContain('payment methods');
    const expires = await failure(() => provider.createPayment(payInput({ expiresAt: '2030-01-01T00:00:00.000Z' })));
    expect(expires.code).toBe(ErrorCode.Unsupported);
    expect(expires.message).toContain('expiry');
    expect(calls).toHaveLength(0);
  });

  it('is VALIDATION, before any request, for input Razorpay would refuse', async () => {
    const { provider, calls } = setup([]);
    const cases: Array<[string, CreatePaymentInput, string]> = [
      ['below INR 1', payInput({ amount: 99 }), 'at least 100 paise'],
      ['a key over 40 characters', payInput({ idempotencyKey: 'k'.repeat(41) }), 'idempotencyKey'],
      ['a key with non-ASCII characters', payInput({ idempotencyKey: 'rèçu-1' }), 'idempotencyKey'],
      ['a reserved metadata key', payInput({ metadata: { [RazorpayNoteKey.PaymentReference]: 'x' } }), 'reserved'],
      [
        'more than 15 notes',
        payInput({ metadata: Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`k${i}`, 'v'])), reference: 'r' }),
        '15',
      ],
      ['a note value over 256 characters', payInput({ metadata: { long: 'x'.repeat(257) } }), '256'],
      ['a non-integer amount', payInput({ amount: 100.5 }), 'amount'],
    ];
    for (const [label, input, text] of cases) {
      const error = await failure(() => provider.createPayment(input));
      expect(error.code, label).toBe(ErrorCode.Validation);
      expect(error.message, label).toContain(text);
    }
    expect(calls).toHaveLength(0);
  });

  it('surfaces Razorpay\'s documented failure body as VALIDATION with the description and the field', async () => {
    const { provider } = setup([route(HttpMethod.Post, '/v1/orders', json(ORDER_CREATE_FAILURE), 400)]);
    const error = await failure(() => provider.createPayment(payInput({ amount: 100 })));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(error.message).toContain('The amount must be at least INR 1.00');
    expect(error.message).toContain('field: amount');
    expect(error.providerCode).toBe('BAD_REQUEST_ERROR');
    expect(error.httpStatus).toBe(400);
  });

  describe('a repeat of a call that carried an idempotencyKey', () => {
    const duplicate = {
      error: {
        code: 'BAD_REQUEST_ERROR',
        description: 'Duplicate request. This request has already been processed.',
        source: 'business',
        step: 'payment_initiation',
        reason: 'input_validation_failed',
        metadata: {},
      },
    };

    it('reads the existing order back by its receipt and returns it', async () => {
      const existing = json(ORDER_CREATED);
      const { provider, calls } = setup([
        route(HttpMethod.Post, '/v1/orders', duplicate, 400),
        route(HttpMethod.Get, /\/v1\/orders\?receipt=/, { entity: 'collection', count: 1, items: [existing] }),
      ]);
      const payment = await provider.createPayment(payInput({ idempotencyKey: 'receipt#1' }));
      expect(payment.id).toBe('order_RB58MiP5SPFYyM');
      expect(payment.checkout).toMatchObject({ orderId: 'order_RB58MiP5SPFYyM', amount: 5000 });
      expectRequest(calls[1], HttpMethod.Get, `${BASE}/v1/orders?receipt=receipt%231`);
    });

    it('is CONFLICT when the existing order is for another amount', async () => {
      const { provider } = setup([
        route(HttpMethod.Post, '/v1/orders', duplicate, 400),
        route(HttpMethod.Get, /\/v1\/orders\?receipt=/, { entity: 'collection', count: 1, items: [json(ORDER_CREATED)] }),
      ]);
      const error = await failure(() => provider.createPayment(payInput({ amount: 9900, idempotencyKey: 'receipt#1' })));
      expect(error.code).toBe(ErrorCode.Conflict);
      expect(error.message).toContain('different amount');
    });

    it('is CONFLICT with Razorpay\'s own text when no order with that receipt can be found', async () => {
      const { provider } = setup([
        route(HttpMethod.Post, '/v1/orders', duplicate, 400),
        route(HttpMethod.Get, /\/v1\/orders\?receipt=/, { entity: 'collection', count: 0, items: [] }),
      ]);
      const error = await failure(() => provider.createPayment(payInput({ idempotencyKey: 'receipt#1' })));
      expect(error.code).toBe(ErrorCode.Conflict);
      expect(error.message).toContain('Duplicate request');
    });

    it('is CONFLICT without a lookup when the call carried no idempotencyKey (nothing was sent as a receipt)', async () => {
      const { provider, calls } = setup([route(HttpMethod.Post, '/v1/orders', duplicate, 400)]);
      const error = await failure(() => provider.createPayment(payInput({ reference: 'order-1' })));
      expect(error.code).toBe(ErrorCode.Conflict);
      expect(calls).toHaveLength(1);
    });

    it('is retried automatically after a dropped connection, because the receipt makes the create safe to repeat', async () => {
      const { provider, calls } = setup(
        [{ method: HttpMethod.Post, url: `${BASE}/v1/orders`, networkError: true }, route(HttpMethod.Post, '/v1/orders', json(ORDER_CREATED))],
        { maxRetries: 2 },
      );
      expect((await provider.createPayment(payInput({ idempotencyKey: 'receipt#1' }))).id).toBe('order_RB58MiP5SPFYyM');
      expect(calls).toHaveLength(2);
      expect(calls[1]?.json).toEqual(calls[0]?.json);
    });
  });

  it('is OUTCOME_UNKNOWN, never retried, when a create without a key gets no answer', async () => {
    const { provider, calls } = setup(
      [{ method: HttpMethod.Post, url: `${BASE}/v1/orders`, networkError: true }, route(HttpMethod.Post, '/v1/orders', json(ORDER_CREATED))],
      { maxRetries: 2 },
    );
    const error = await failure(() => provider.createPayment(payInput()));
    expect(error.code).toBe(ErrorCode.OutcomeUnknown);
    expect(calls).toHaveLength(1);
  });

  it('never puts the key secret in an error', async () => {
    const { provider } = setup([route(HttpMethod.Post, '/v1/orders', { error: { description: 'The API key provided is invalid.' } }, 401)]);
    const error = await failure(() => provider.createPayment(payInput()));
    const everything = JSON.stringify({ message: error.message, json: error.toJSON(), raw: error.raw });
    expect(everything).not.toContain(KEY_SECRET);
  });
});

describe('getPayment', () => {
  it('reads the order and its payments (two GETs) and reports the captured attempt', async () => {
    const { provider, calls } = setup([
      route(HttpMethod.Get, `/v1/orders/${PAYMENTS_ORDER_ID}`, orderOf()),
      route(HttpMethod.Get, `/v1/orders/${PAYMENTS_ORDER_ID}/payments`, json(ORDER_PAYMENTS)),
    ]);
    const payment = await provider.getPayment(PAYMENTS_ORDER_ID);
    expect(calls).toHaveLength(2);
    expectRequest(calls[0], HttpMethod.Get, `${BASE}/v1/orders/${PAYMENTS_ORDER_ID}`);
    expectRequest(calls[1], HttpMethod.Get, `${BASE}/v1/orders/${PAYMENTS_ORDER_ID}/payments`);
    expect(payment).toMatchObject({
      provider: 'razorpay',
      id: PAYMENTS_ORDER_ID,
      status: PaymentStatus.Succeeded,
      providerStatus: 'captured',
      amount: 100,
      currency: 'INR',
      refundedAmount: 0,
      paymentMethod: PaymentMethod.Upi,
      customer: { email: 'void@razorpay.com', phone: '+919999999999' },
      paidAt: iso(1701688721),
    });
    expect(payment.failureCode).toBeUndefined();
    expect((payment.raw as { payments: Array<{ id: string }> }).payments.map((p) => p.id)).toEqual([FAILED_PAYMENT_ID, CAPTURED_PAYMENT_ID]);
    expect(PaymentSchema.safeParse(payment).success).toBe(true);
  });

  it('reads the reference and the metadata back from the order notes', async () => {
    const order = orderOf({
      notes: { plan: 'pro', [RazorpayNoteKey.PaymentReference]: 'order-1001', [RazorpayNoteKey.PaymentDescription]: 'Pro plan' },
    });
    const { provider } = setup([
      route(HttpMethod.Get, `/v1/orders/${PAYMENTS_ORDER_ID}`, order),
      route(HttpMethod.Get, `/v1/orders/${PAYMENTS_ORDER_ID}/payments`, json(ORDER_PAYMENTS)),
    ]);
    const payment = await provider.getPayment(PAYMENTS_ORDER_ID);
    expect(payment.reference).toBe('order-1001');
    expect(payment.metadata).toEqual({ plan: 'pro' });
  });

  it('is created for an order nobody has paid, with no payments (orders/fetch-with-id sample)', async () => {
    const { provider } = setup([
      route(HttpMethod.Get, '/v1/orders/order_DaaS6LOUAASb7Y', json(ORDER_FETCHED)),
      route(HttpMethod.Get, '/v1/orders/order_DaaS6LOUAASb7Y/payments', paymentsCollection([])),
    ]);
    const payment = await provider.getPayment('order_DaaS6LOUAASb7Y');
    expect(payment).toMatchObject({ id: 'order_DaaS6LOUAASb7Y', status: PaymentStatus.Created, providerStatus: 'created', amount: 2000 });
    expect(payment.paidAt).toBeUndefined();
    expect(payment.paymentMethod).toBeUndefined();
  });

  it('is failed, with the failure code and reason, when every attempt failed', async () => {
    const failed = attempts()[0] as Record<string, unknown>;
    const { provider } = setup([
      route(HttpMethod.Get, `/v1/orders/${PAYMENTS_ORDER_ID}`, orderOf({ status: 'attempted', amount_paid: 0, amount_due: 100, attempts: 1 })),
      route(HttpMethod.Get, `/v1/orders/${PAYMENTS_ORDER_ID}/payments`, paymentsCollection([failed])),
    ]);
    const payment = await provider.getPayment(PAYMENTS_ORDER_ID);
    expect(payment).toMatchObject({
      status: PaymentStatus.Failed,
      providerStatus: 'failed',
      failureCode: 'BAD_REQUEST_ERROR',
      failureReason: 'Payment was unsuccessful due to a temporary issue. If amount got deducted, it will be refunded within 5-7 working days.',
    });
    expect(payment.paidAt).toBeUndefined();
  });

  it('is pending for an authorised payment that is not captured yet', async () => {
    const authorized = { ...attempts()[1], status: 'authorized', captured: false };
    const { provider } = setup([
      route(HttpMethod.Get, `/v1/orders/${PAYMENTS_ORDER_ID}`, orderOf({ status: 'attempted', amount_paid: 0 })),
      route(HttpMethod.Get, `/v1/orders/${PAYMENTS_ORDER_ID}/payments`, paymentsCollection([attempts()[0] as Record<string, unknown>, authorized])),
    ]);
    const payment = await provider.getPayment(PAYMENTS_ORDER_ID);
    expect(payment).toMatchObject({ status: PaymentStatus.Pending, providerStatus: 'authorized' });
    expect(payment.paidAt).toBeUndefined();
  });

  it('reports partial and full refunds of the captured payment', async () => {
    const run = async (over: Record<string, unknown>) => {
      const { provider } = setup([
        route(HttpMethod.Get, `/v1/orders/${PAYMENTS_ORDER_ID}`, orderOf()),
        route(HttpMethod.Get, `/v1/orders/${PAYMENTS_ORDER_ID}/payments`, paymentsCollection([{ ...attempts()[1], ...over }])),
      ]);
      return provider.getPayment(PAYMENTS_ORDER_ID);
    };
    const partial = await run({ amount_refunded: 40, refund_status: 'partial' });
    expect(partial).toMatchObject({ status: PaymentStatus.PartiallyRefunded, refundedAmount: 40 });
    const full = await run({ amount_refunded: 100, refund_status: 'full' });
    expect(full).toMatchObject({ status: PaymentStatus.Refunded, refundedAmount: 100 });
    // Razorpay's own `refunded` payment status, with no amount_refunded: the whole amount.
    const refundedStatus = await run({ status: 'refunded', amount_refunded: null });
    expect(refundedStatus).toMatchObject({ status: PaymentStatus.Refunded, providerStatus: 'refunded', refundedAmount: 100 });
  });

  it('trusts a paid order over a payment list that has no captured payment yet', async () => {
    const { provider } = setup([
      route(HttpMethod.Get, `/v1/orders/${PAYMENTS_ORDER_ID}`, orderOf()),
      route(HttpMethod.Get, `/v1/orders/${PAYMENTS_ORDER_ID}/payments`, paymentsCollection([attempts()[0] as Record<string, unknown>])),
    ]);
    const payment = await provider.getPayment(PAYMENTS_ORDER_ID);
    expect(payment).toMatchObject({ status: PaymentStatus.Succeeded, providerStatus: 'paid' });
    expect(payment.paidAt).toBeUndefined();
    expect(payment.failureCode).toBeUndefined();
  });

  it('never reports success for a status Razorpay adds later', async () => {
    const unknownPayment = { ...attempts()[1], status: 'under_review' };
    const { provider } = setup([
      route(HttpMethod.Get, `/v1/orders/${PAYMENTS_ORDER_ID}`, orderOf({ status: 'attempted' })),
      route(HttpMethod.Get, `/v1/orders/${PAYMENTS_ORDER_ID}/payments`, paymentsCollection([unknownPayment])),
    ]);
    expect(await provider.getPayment(PAYMENTS_ORDER_ID)).toMatchObject({ status: PaymentStatus.Pending, providerStatus: 'under_review' });
    const { provider: other } = setup([
      route(HttpMethod.Get, '/v1/orders/order_x', orderOf({ id: 'order_x', status: 'on_hold' })),
      route(HttpMethod.Get, '/v1/orders/order_x/payments', paymentsCollection([])),
    ]);
    expect(await other.getPayment('order_x')).toMatchObject({ status: PaymentStatus.Pending, providerStatus: 'on_hold' });
  });

  it('is VALIDATION, before any request, for an id that is not an order id', async () => {
    const { provider, calls } = setup([]);
    for (const id of ['', '  ', CAPTURED_PAYMENT_ID, 'sub_1']) {
      const error = await failure(() => provider.getPayment(id));
      expect(error.code).toBe(ErrorCode.Validation);
    }
    expect((await failure(() => provider.getPayment(CAPTURED_PAYMENT_ID))).message).toContain('order id');
    expect(calls).toHaveLength(0);
  });

  it('is NOT_FOUND for an order Razorpay does not know (orders/fetch-with-id failure body)', async () => {
    const body = {
      error: {
        code: 'BAD_REQUEST_ERROR',
        description: 'The id provided does not exist',
        source: 'business',
        step: 'payment_initiation',
        reason: 'input_validation_failed',
        metadata: {},
      },
    };
    const { provider } = setup([route(HttpMethod.Get, '/v1/orders/order_nope', body, 400)]);
    expect((await failure(() => provider.getPayment('order_nope'))).code).toBe(ErrorCode.NotFound);
  });

  it('retries a GET after a 503, because reads are safe to repeat', async () => {
    const { provider, calls } = setup(
      [
        route(HttpMethod.Get, '/v1/orders/order_x', { error: { description: 'try later' } }, 503),
        route(HttpMethod.Get, '/v1/orders/order_x', orderOf({ id: 'order_x', status: 'created' })),
        route(HttpMethod.Get, '/v1/orders/order_x/payments', paymentsCollection([])),
      ],
      { maxRetries: 2 },
    );
    expect((await provider.getPayment('order_x')).status).toBe(PaymentStatus.Created);
    expect(calls).toHaveLength(3);
  });
});

describe('verifyPayment', () => {
  // The signature sample of the Standard Checkout integration page (Java sample "Generate Signature on Your Server").
  const DOCUMENTED = {
    secret: 'EnLs21M47BllR3X8PSFtjtbd',
    razorpay_order_id: 'order_IEIaMR65cu6nz3',
    razorpay_payment_id: 'pay_IH4NVgf4Dreq1l',
    razorpay_signature: '0d4e745a1838664ad6c9c9902212a32d627d68e917290b0ad5f08ff4561bc50f',
  };
  const callback = () => json(CHECKOUT_SUCCESS_CALLBACK);
  const signedCallback = (over: Record<string, unknown> = {}) => {
    const fields = callback();
    return { ...fields, razorpay_signature: hmac(`${fields.razorpay_order_id}|${fields.razorpay_payment_id}`), ...over };
  };

  it('accepts the documented sample signature (order id, a pipe, payment id; HMAC SHA256 with the key secret)', async () => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, secret } = DOCUMENTED;
    expect(hmac(`${razorpay_order_id}|${razorpay_payment_id}`, secret)).toBe(razorpay_signature);
    const { provider } = setup([], {}, { keySecret: secret });
    const result = { razorpay_order_id, razorpay_payment_id, razorpay_signature };
    const verification = await provider.verifyPayment(result);
    expect(verification).toEqual({ provider: 'razorpay', paymentId: razorpay_order_id, paid: true, raw: result });
    expect(PaymentVerificationSchema.safeParse(verification).success).toBe(true);
  });

  it('accepts a callback signed with the account secret, computed here, and returns the order id as the payment id', async () => {
    const { provider } = setup([]);
    const result = signedCallback();
    expect(result.razorpay_signature).not.toBe(callback().razorpay_signature);
    const verification = await provider.verifyPayment(result);
    expect(verification).toMatchObject({ paymentId: 'order_9A33XWu170gUtm', paid: true, raw: result });
    expect(verification.status).toBeUndefined();
    expect(verification.payment).toBeUndefined();
  });

  it('puts the order id first: the subscription order (payment id first) does not verify', async () => {
    const { provider } = setup([]);
    const fields = callback();
    const reversed = signedCallback({ razorpay_signature: hmac(`${fields.razorpay_payment_id}|${fields.razorpay_order_id}`) });
    expect((await failure(() => provider.verifyPayment(reversed))).code).toBe(ErrorCode.SignatureInvalid);
  });

  it('is SIGNATURE_INVALID for the documented placeholder signature (it was not made with this secret), a changed character, upper case or another secret', async () => {
    const { provider } = setup([]);
    const real = signedCallback().razorpay_signature as string;
    const flipped = `${real.slice(0, -1)}${real.endsWith('0') ? '1' : '0'}`;
    const fields = callback();
    for (const razorpay_signature of [
      fields.razorpay_signature,
      flipped,
      real.toUpperCase(),
      hmac(`${fields.razorpay_order_id}|${fields.razorpay_payment_id}`, 'another-secret'),
      'deadbeef',
    ]) {
      expect((await failure(() => provider.verifyPayment(signedCallback({ razorpay_signature })))).code).toBe(ErrorCode.SignatureInvalid);
    }
  });

  it('is SIGNATURE_INVALID when the order id or the payment id was altered after signing', async () => {
    const { provider } = setup([]);
    for (const altered of [{ razorpay_order_id: 'order_attacker0001' }, { razorpay_payment_id: 'pay_attacker000001' }]) {
      expect((await failure(() => provider.verifyPayment(signedCallback(altered)))).code).toBe(ErrorCode.SignatureInvalid);
    }
  });

  it.each(['razorpay_payment_id', 'razorpay_order_id', 'razorpay_signature'])('is VALIDATION when %s is missing, empty or not a string', async (field) => {
    const { provider } = setup([]);
    for (const bad of [undefined, '', 12345, null]) {
      const error = await failure(() => provider.verifyPayment(signedCallback({ [field]: bad })));
      expect(error.code).toBe(ErrorCode.Validation);
      expect(error.message).toContain(field);
    }
  });

  it('is VALIDATION for a subscription result, and verifyCheckout is VALIDATION for an order result', async () => {
    const { provider } = setup([]);
    const subscriptionResult = {
      razorpay_payment_id: 'pay_29QQoUBi66xm2f',
      razorpay_subscription_id: 'sub_00000000000001',
      razorpay_signature: hmac('pay_29QQoUBi66xm2f|sub_00000000000001'),
    };
    expect((await failure(() => provider.verifyPayment(subscriptionResult))).code).toBe(ErrorCode.Validation);
    expect((await failure(() => provider.verifyCheckout(signedCallback()))).code).toBe(ErrorCode.Validation);
  });

  describe(RAZORPAY_EXPECTED_ORDER_ID_KEY + ' (the order id from your own storage)', () => {
    it('signs with the stored id and returns it', async () => {
      const { provider } = setup([]);
      const verification = await provider.verifyPayment(signedCallback({ [RAZORPAY_EXPECTED_ORDER_ID_KEY]: 'order_9A33XWu170gUtm' }));
      expect(verification.paymentId).toBe('order_9A33XWu170gUtm');
    });

    it('rejects a genuine payment for a different order than the one you stored', async () => {
      const { provider } = setup([]);
      const other = 'order_other0000001';
      const result = {
        razorpay_payment_id: 'pay_29QQoUBi66xm2f',
        razorpay_order_id: other,
        razorpay_signature: hmac(`${other}|pay_29QQoUBi66xm2f`),
        [RAZORPAY_EXPECTED_ORDER_ID_KEY]: 'order_9A33XWu170gUtm',
      };
      expect((await failure(() => provider.verifyPayment(result))).code).toBe(ErrorCode.SignatureInvalid);
    });

    it('is VALIDATION when it is not a non-empty string', async () => {
      const { provider } = setup([]);
      for (const bad of [123, '', null]) {
        expect((await failure(() => provider.verifyPayment(signedCallback({ [RAZORPAY_EXPECTED_ORDER_ID_KEY]: bad })))).code).toBe(
          ErrorCode.Validation,
        );
      }
    });
  });

  it('never puts a secret or the expected signature in an error', async () => {
    const { provider } = setup([]);
    const errors = [
      await failure(() => provider.verifyPayment(signedCallback({ razorpay_signature: 'deadbeef' }))),
      await failure(() => provider.verifyPayment({})),
    ];
    for (const error of errors) {
      const everything = JSON.stringify({ message: error.message, json: error.toJSON(), raw: error.raw, stack: error.stack });
      expect(everything).not.toContain(KEY_SECRET);
      expect(everything).not.toContain(signedCallback().razorpay_signature as string);
    }
  });
});

describe('refundPayment', () => {
  const REFUND_ID = 'refund-0001-abcd';
  // refunds/create-normal "Success" sample, with the receipt the request carried.
  const refundResponse = (over: Record<string, unknown> = {}) => ({ ...json(REFUND_CREATED), receipt: REFUND_ID, ...over });
  const paymentsRoute = () => route(HttpMethod.Get, `/v1/orders/${PAYMENTS_ORDER_ID}/payments`, json(ORDER_PAYMENTS));

  it('finds the order\'s captured payment, then POSTs /v1/payments/{id}/refund with the idempotency header and no amount for a full refund', async () => {
    const { provider, calls } = setup([paymentsRoute(), route(HttpMethod.Post, `/v1/payments/${CAPTURED_PAYMENT_ID}/refund`, refundResponse())]);
    const refund = await provider.refundPayment({ paymentId: PAYMENTS_ORDER_ID, refundId: REFUND_ID, reason: 'Customer asked' });

    expect(calls).toHaveLength(2);
    expectRequest(calls[0], HttpMethod.Get, `${BASE}/v1/orders/${PAYMENTS_ORDER_ID}/payments`);
    expectRequest(calls[1], HttpMethod.Post, `${BASE}/v1/payments/${CAPTURED_PAYMENT_ID}/refund`, {
      receipt: REFUND_ID,
      notes: { [RazorpayNoteKey.RefundReference]: REFUND_ID, [RazorpayNoteKey.RefundReason]: 'Customer asked' },
    });
    expect(calls[1]?.headers['x-refund-idempotency']).toBe(REFUND_ID);
    expect(refund).toEqual({
      provider: 'razorpay',
      id: 'rfnd_FP8QHiV938haTz',
      reference: REFUND_ID,
      chargeId: PAYMENTS_ORDER_ID,
      paymentId: PAYMENTS_ORDER_ID,
      status: RefundStatus.Succeeded,
      providerStatus: 'processed',
      amount: 500100,
      currency: 'INR',
      createdAt: iso(1597078866),
      raw: refundResponse(),
    });
    expect(RefundSchema.safeParse(refund).success).toBe(true);
  });

  it('sends the amount for a partial refund', async () => {
    const { provider, calls } = setup([paymentsRoute(), route(HttpMethod.Post, `/v1/payments/${CAPTURED_PAYMENT_ID}/refund`, refundResponse({ amount: 40 }))]);
    const refund = await provider.refundPayment({ paymentId: PAYMENTS_ORDER_ID, refundId: REFUND_ID, amount: 40 });
    expect(calls[1]?.json).toEqual({
      amount: 40,
      receipt: REFUND_ID,
      notes: { [RazorpayNoteKey.RefundReference]: REFUND_ID },
    });
    expect(refund.amount).toBe(40);
  });

  it('still sends the refund for a payment that is already refunded, so a repeat of a refund gets the first answer', async () => {
    const refunded = { ...attempts()[1], status: 'refunded', refund_status: 'full', amount_refunded: 100 };
    const { provider, calls } = setup([
      route(HttpMethod.Get, `/v1/orders/${PAYMENTS_ORDER_ID}/payments`, paymentsCollection([refunded])),
      route(HttpMethod.Post, `/v1/payments/${CAPTURED_PAYMENT_ID}/refund`, refundResponse()),
    ]);
    expect((await provider.refundPayment({ paymentId: PAYMENTS_ORDER_ID, refundId: REFUND_ID })).id).toBe('rfnd_FP8QHiV938haTz');
    expect(calls[1]?.headers['x-refund-idempotency']).toBe(REFUND_ID);
  });

  it('is CONFLICT, and sends no refund, when the order has no captured payment', async () => {
    const { provider, calls } = setup([
      route(HttpMethod.Get, `/v1/orders/${PAYMENTS_ORDER_ID}/payments`, paymentsCollection([attempts()[0] as Record<string, unknown>])),
    ]);
    const error = await failure(() => provider.refundPayment({ paymentId: PAYMENTS_ORDER_ID, refundId: REFUND_ID }));
    expect(error.code).toBe(ErrorCode.Conflict);
    expect(calls).toHaveLength(1);
  });

  it('is VALIDATION, before any request, for an id that is not an order id or a refundId Razorpay would refuse as an idempotency key', async () => {
    const { provider, calls } = setup([]);
    expect((await failure(() => provider.refundPayment({ paymentId: CAPTURED_PAYMENT_ID, refundId: REFUND_ID }))).code).toBe(ErrorCode.Validation);
    for (const refundId of ['short', 'has spaces in it', 'under_score_ok_but_é_not']) {
      const error = await failure(() => provider.refundPayment({ paymentId: PAYMENTS_ORDER_ID, refundId }));
      expect(error.code).toBe(ErrorCode.Validation);
      expect(error.message).toContain('refundId');
    }
    expect((await failure(() => provider.refundPayment({ paymentId: PAYMENTS_ORDER_ID, refundId: 'x'.repeat(41) }))).code).toBe(ErrorCode.Validation);
    expect(calls).toHaveLength(0);
  });

  it('maps the documented refund errors: over-refund is VALIDATION, a reused receipt and a busy payment are CONFLICT', async () => {
    const body = (description: string) => ({
      error: { code: 'BAD_REQUEST_ERROR', description, source: 'business', step: 'payment_initiation', reason: 'input_validation_failed', metadata: {} },
    });
    const cases: Array<[string, number, ErrorCode]> = [
      ['The refund amount provided is greater than amount captured.', 400, ErrorCode.Validation],
      ['The payment has been fully refunded already.', 400, ErrorCode.Validation],
      ['Duplicate receipt found for this refund request.', 400, ErrorCode.Conflict],
      ['Request failed because another payment operation is in progress.', 400, ErrorCode.Conflict],
      ['Another request with the same idempotency key is still in progress.', 409, ErrorCode.Conflict],
    ];
    for (const [description, status, code] of cases) {
      const { provider } = setup([paymentsRoute(), route(HttpMethod.Post, `/v1/payments/${CAPTURED_PAYMENT_ID}/refund`, body(description), status)]);
      const error = await failure(() => provider.refundPayment({ paymentId: PAYMENTS_ORDER_ID, refundId: REFUND_ID, amount: 5 }));
      expect(error.code, description).toBe(code);
      expect(error.message).toContain(description.replace(/\.$/, ''));
    }
  });

  it('repeats the refund, header included, after a dropped connection, because the header makes it safe', async () => {
    const { provider, calls } = setup(
      [
        paymentsRoute(),
        { method: HttpMethod.Post, url: `${BASE}/v1/payments/${CAPTURED_PAYMENT_ID}/refund`, networkError: true },
        route(HttpMethod.Post, `/v1/payments/${CAPTURED_PAYMENT_ID}/refund`, refundResponse()),
      ],
      { maxRetries: 2 },
    );
    expect((await provider.refundPayment({ paymentId: PAYMENTS_ORDER_ID, refundId: REFUND_ID })).status).toBe(RefundStatus.Succeeded);
    expect(calls).toHaveLength(3);
    expect(calls[2]?.headers['x-refund-idempotency']).toBe(REFUND_ID);
    expect(calls[2]?.json).toEqual(calls[1]?.json);
  });

  it('keeps a pending refund pending and a failed one failed', async () => {
    for (const [status, expected] of [
      ['pending', RefundStatus.Pending],
      ['failed', RefundStatus.Failed],
    ] as const) {
      const { provider } = setup([paymentsRoute(), route(HttpMethod.Post, `/v1/payments/${CAPTURED_PAYMENT_ID}/refund`, refundResponse({ status }))]);
      const refund = await provider.refundPayment({ paymentId: PAYMENTS_ORDER_ID, refundId: REFUND_ID });
      expect(refund).toMatchObject({ status: expected, providerStatus: status, paymentId: PAYMENTS_ORDER_ID });
    }
  });
});
