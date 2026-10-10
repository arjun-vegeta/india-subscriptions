import { describe, expect, it } from 'vitest';
import { CheckoutKind, Currency, ErrorCode, HttpMethod, PaymentMethod, PaymentStatus, Provider, RefundStatus } from '../../src/constants.js';
import {
  MIN_PAYMENT_PAISE,
  ONE_TIME_PAYMENT_METHODS,
  ORDER_STATE_TO_PAYMENT_STATUS,
  PAYMENT_METHOD_BY_MODE,
  PAYMENT_MODES_BY_METHOD,
  UNKNOWN_PAYMENT_STATUS,
} from '../../src/providers/phonepe/index.js';
import { SETUP_ORDER_COMPLETED_SC_ORDER, REDEMPTION_ORDER_COMPLETED_A_REDORDER, NOTIFICATION_STATUS_SC_NOTIFSTATUS } from './fixtures.js';
import {
  ORDER_CASE_1_STATUS,
  ORDER_CASE_3_STATUS,
  ORDER_CASE_4_STATUS,
  ORDER_CASE_5_STATUS,
  ORDER_CASE_6_STATUS,
  ORDER_CASE_7_STATUS,
  ORDER_SAMPLE_CURL_STATUS,
  PAY_ERROR_CASE_2_CREATE,
  PAY_ERROR_CASE_3_CREATE,
  PAY_MODE_CONFIG_ENABLED_CREATE,
  PAY_REQUEST_CREATE_CURL,
  PAY_RESPONSE_CASE_1_CREATE,
  REFUND_REQUEST_REFUND,
  REFUND_RESPONSE_CASE_1_REFUND,
} from './payment-fixtures.js';
import { CUSTOMER, NOW, O_BEARER, RETURN_URL, SANDBOX_API, TEST_TOKEN, makeProvider, rejection, route } from './helpers.js';

const PAY = '/checkout/v2/pay';
const ID = PAY_REQUEST_CREATE_CURL.merchantOrderId;
const orderPath = (id: string) => `/checkout/v2/order/${id}/status?details=true&errorContext=true`;
const orderRoute = (id: string, json: unknown, status?: number) => route(HttpMethod.Get, orderPath(id), { json, ...(status ? { status } : {}) });
const payRoute = () => route(HttpMethod.Post, PAY, { json: PAY_RESPONSE_CASE_1_CREATE });

/** The input that produces the documentation's curl sample: its order id, amount, message and redirect URL. */
const SAMPLE_INPUT = {
  reference: ID,
  amount: PAY_REQUEST_CREATE_CURL.amount,
  description: PAY_REQUEST_CREATE_CURL.paymentFlow.message,
  customer: CUSTOMER,
  returnUrl: PAY_REQUEST_CREATE_CURL.paymentFlow.merchantUrls.redirectUrl,
};

describe('createPayment: the request [CREATE]', () => {
  it('POST /checkout/v2/pay with the documented body, the O-Bearer token and JSON headers', async () => {
    const t = makeProvider([payRoute()]);
    await t.provider.createPayment(SAMPLE_INPUT);

    const [call] = t.apiCalls();
    expect(call).toMatchObject({ method: 'POST', url: `${SANDBOX_API}${PAY}` });
    expect(call?.headers).toMatchObject({ authorization: O_BEARER(TEST_TOKEN), 'content-type': 'application/json' });
    // The sample body of the curl example, plus the order id the adapter adds to the return URL.
    expect(call?.json).toEqual({
      ...PAY_REQUEST_CREATE_CURL,
      paymentFlow: {
        ...PAY_REQUEST_CREATE_CURL.paymentFlow,
        merchantUrls: { redirectUrl: `${PAY_REQUEST_CREATE_CURL.paymentFlow.merchantUrls.redirectUrl}?merchantOrderId=${ID}` },
      },
    });
  });

  it('returns a created payment: id and reference are the merchant order id, PhonePe\'s redirect URL untouched [CREATE case 1]', async () => {
    const t = makeProvider([payRoute()]);
    const payment = await t.provider.createPayment(SAMPLE_INPUT);
    expect(payment).toEqual({
      provider: Provider.PhonePe,
      id: ID,
      reference: ID,
      status: PaymentStatus.Created,
      providerStatus: 'PENDING',
      amount: 1000,
      currency: Currency.INR,
      customer: CUSTOMER,
      createdAt: NOW.toISOString(),
      checkout: { kind: CheckoutKind.Redirect, url: PAY_RESPONSE_CASE_1_CREATE.redirectUrl },
      raw: PAY_RESPONSE_CASE_1_CREATE,
    });
  });

  it('without a reference the id is a generated pay_<hex> that fits PhonePe\'s order id rule', async () => {
    const t = makeProvider([payRoute()], { options: { generatePaymentId: undefined } });
    const payment = await t.provider.createPayment({ amount: 1000, customer: CUSTOMER, returnUrl: RETURN_URL });
    expect(payment.id).toMatch(/^pay_[0-9a-f]{24}$/);
    expect(payment.id.length).toBeLessThanOrEqual(63);
    expect(t.apiCalls()[0]?.json).toMatchObject({ merchantOrderId: payment.id });
  });

  it('uses the injected id generator', async () => {
    const t = makeProvider([payRoute()], { options: { generatePaymentId: () => 'pay_fixed_1' } });
    expect((await t.provider.createPayment({ amount: 1000, customer: CUSTOMER, returnUrl: RETURN_URL })).id).toBe('pay_fixed_1');
  });

  it('the config redirectUrl is the return page when the input has none; with neither it is VALIDATION and nothing is sent', async () => {
    const t = makeProvider([payRoute()]);
    await t.provider.createPayment({ reference: ID, amount: 1000, customer: CUSTOMER });
    expect(t.apiCalls()[0]?.json).toMatchObject({ paymentFlow: { merchantUrls: { redirectUrl: `${RETURN_URL}?merchantOrderId=${ID}` } } });

    const bare = makeProvider([], { config: { redirectUrl: undefined } });
    const error = await rejection(bare.provider.createPayment({ reference: ID, amount: 1000, customer: CUSTOMER }));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(bare.apiCalls()).toHaveLength(0);
  });

  it('paymentMethods become enabledPaymentModes: UPI is intent and QR, cards are both card types, net banking [CREATE]', async () => {
    const t = makeProvider([payRoute()]);
    await t.provider.createPayment({
      ...SAMPLE_INPUT,
      paymentMethods: [PaymentMethod.Upi, PaymentMethod.NetBanking, PaymentMethod.Card],
    });
    expect((t.apiCalls()[0]?.json as { paymentFlow: { paymentModeConfig: unknown } }).paymentFlow.paymentModeConfig).toEqual(PAY_MODE_CONFIG_ENABLED_CREATE);
    // No disabledPaymentModes alongside: "If both are included, the API will return an error".
    expect(JSON.stringify(t.apiCalls()[0]?.json)).not.toContain('disabledPaymentModes');
  });

  it('a single method is sent alone, and a repeated method once', async () => {
    const t = makeProvider([payRoute()]);
    await t.provider.createPayment({ ...SAMPLE_INPUT, paymentMethods: [PaymentMethod.Upi, PaymentMethod.Upi] });
    expect((t.apiCalls()[0]?.json as { paymentFlow: { paymentModeConfig: unknown } }).paymentFlow.paymentModeConfig).toEqual({
      enabledPaymentModes: [{ type: 'UPI_INTENT' }, { type: 'UPI_QR' }],
    });
  });

  it.each([PaymentMethod.Wallet, PaymentMethod.ENach, PaymentMethod.PhysicalNach])(
    'refuses %s: PhonePe has no instrument for it, and it is not silently dropped',
    async (method) => {
      const t = makeProvider();
      const error = await rejection(t.provider.createPayment({ ...SAMPLE_INPUT, paymentMethods: [PaymentMethod.Upi, method] }));
      expect(error.code).toBe(ErrorCode.Validation);
      expect(error.message).toContain(method);
      expect(t.calls).toHaveLength(0);
    },
  );

  it('expiresAt becomes expireAfter in seconds, rounded down so the order never outlives the deadline', async () => {
    const t = makeProvider([payRoute()]);
    await t.provider.createPayment({ ...SAMPLE_INPUT, expiresAt: new Date(NOW.getTime() + 1_200_900).toISOString() });
    expect(t.apiCalls()[0]?.json).toMatchObject({ expireAfter: 1200 });
  });

  it.each([
    ['299 seconds', 299_000],
    ['3601 seconds', 3_601_000],
    ['a deadline in the past', -1000],
  ])('refuses an expiresAt %s away: PhonePe accepts 300 to 3600, and the value is never clamped', async (_name, offsetMs) => {
    const t = makeProvider();
    const error = await rejection(t.provider.createPayment({ ...SAMPLE_INPUT, expiresAt: new Date(NOW.getTime() + offsetMs).toISOString() }));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(error.message).toContain('expiresAt');
    expect(t.calls).toHaveLength(0);
  });

  it('accepts both ends of the documented expiry range', async () => {
    for (const seconds of [300, 3600]) {
      const t = makeProvider([payRoute()]);
      await t.provider.createPayment({ ...SAMPLE_INPUT, expiresAt: new Date(NOW.getTime() + seconds * 1000).toISOString() });
      expect(t.apiCalls()[0]?.json).toMatchObject({ expireAfter: seconds });
    }
  });

  it('metadata under udf1 to udf15 goes to metaInfo, and comes back on the payment', async () => {
    const t = makeProvider([payRoute()]);
    const payment = await t.provider.createPayment({ ...SAMPLE_INPUT, metadata: { udf1: 'cart-77', udf11: 'a_b-c+d@e.f' } });
    expect(t.apiCalls()[0]?.json).toMatchObject({ metaInfo: { udf1: 'cart-77', udf11: 'a_b-c+d@e.f' } });
    expect(payment.metadata).toEqual({ udf1: 'cart-77', udf11: 'a_b-c+d@e.f' });
  });

  it('empty metadata sends no metaInfo', async () => {
    const t = makeProvider([payRoute()]);
    await t.provider.createPayment({ ...SAMPLE_INPUT, metadata: {} });
    expect(t.apiCalls()[0]?.json).not.toHaveProperty('metaInfo');
  });

  it.each([
    ['a key that is not udf1 to udf15', { orderRef: 'x' }, 'orderRef'],
    ['udf16', { udf16: 'x' }, 'udf16'],
    ['a udf1 value above 256 characters', { udf1: 'x'.repeat(257) }, 'udf1'],
    ['a udf11 value above 50 characters', { udf11: 'x'.repeat(51) }, 'udf11'],
    ['a udf11 value with characters PhonePe does not allow', { udf11: 'a/b' }, 'udf11'],
  ])('refuses metadata with %s, and sends nothing', async (_name, metadata, mentioned) => {
    const t = makeProvider();
    const error = await rejection(t.provider.createPayment({ ...SAMPLE_INPUT, metadata }));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(error.message).toContain(mentioned);
    expect(t.calls).toHaveLength(0);
  });

  it(`refuses an amount below ${MIN_PAYMENT_PAISE} paise [CREATE: "Minimum value = 100"], accepts ${MIN_PAYMENT_PAISE}`, async () => {
    const t = makeProvider([payRoute()]);
    expect((await rejection(t.provider.createPayment({ ...SAMPLE_INPUT, amount: 99 }))).code).toBe(ErrorCode.Validation);
    expect(t.calls).toHaveLength(0);
    await t.provider.createPayment({ ...SAMPLE_INPUT, amount: 100 });
    expect(t.apiCalls()[0]?.json).toMatchObject({ amount: 100 });
  });

  it.each([
    ['64 characters', 'a'.repeat(64)],
    ['a space', 'order 1'],
    ['a dot', 'order.1'],
    ['the ST_ prefix of a subscription setup order', 'ST_order_1'],
  ])('refuses a reference with %s: PhonePe takes 63 of letters, digits, "_" and "-"', async (_name, reference) => {
    const t = makeProvider();
    expect((await rejection(t.provider.createPayment({ ...SAMPLE_INPUT, reference }))).code).toBe(ErrorCode.Validation);
    expect(t.calls).toHaveLength(0);
  });

  it('accepts a 63 character reference', async () => {
    // The facade's own limit on `reference` is 60, so the adapter's 63 is reached only through the generated ids and direct use.
    const t = makeProvider([payRoute()]);
    const reference = 'a'.repeat(60);
    expect((await t.provider.createPayment({ ...SAMPLE_INPUT, reference })).id).toBe(reference);
  });

  it('customer, idempotencyKey and storeProduct are not sent (PhonePe has no field for them)', async () => {
    const t = makeProvider([payRoute()]);
    await t.provider.createPayment({ ...SAMPLE_INPUT, idempotencyKey: 'key-1', storeProduct: { productId: 'p' } });
    expect(JSON.stringify(t.apiCalls()[0]?.json)).not.toMatch(/ashish|key-1|productId/i);
  });

  it('a duplicate order id answers BAD_REQUEST [CREATE case 2]: VALIDATION, with PhonePe\'s code kept', async () => {
    const t = makeProvider([route(HttpMethod.Post, PAY, { status: 400, json: PAY_ERROR_CASE_2_CREATE })]);
    const error = await rejection(t.provider.createPayment(SAMPLE_INPUT));
    expect(error).toMatchObject({ code: ErrorCode.Validation, providerCode: 'BAD_REQUEST', httpStatus: 400 });
  });

  it('a server error on the create is OUTCOME_UNKNOWN or PROVIDER_ERROR, never retried blindly [CREATE case 3]', async () => {
    const t = makeProvider([route(HttpMethod.Post, PAY, { status: 500, json: PAY_ERROR_CASE_3_CREATE })]);
    const error = await rejection(t.provider.createPayment(SAMPLE_INPUT));
    expect([ErrorCode.OutcomeUnknown, ErrorCode.ProviderError]).toContain(error.code);
    expect(t.apiCalls()).toHaveLength(1);
  });

  it('a response without a redirectUrl is UNEXPECTED_RESPONSE', async () => {
    const t = makeProvider([route(HttpMethod.Post, PAY, { json: { orderId: 'OMO1', state: 'PENDING' } })]);
    expect((await rejection(t.provider.createPayment(SAMPLE_INPUT))).code).toBe(ErrorCode.UnexpectedResponse);
  });
});

describe('getPayment: Order Status [STATUS]', () => {
  it('GET /checkout/v2/order/{id}/status?details=true&errorContext=true with the token', async () => {
    const t = makeProvider([orderRoute(ID, ORDER_CASE_1_STATUS)]);
    await t.provider.getPayment(ID);
    const [call] = t.apiCalls();
    expect(call).toMatchObject({ method: 'GET', url: `${SANDBOX_API}${orderPath(ID)}` });
    expect(call?.headers).toMatchObject({ authorization: O_BEARER(TEST_TOKEN), 'content-type': 'application/json' });
    expect(call?.body).toBeUndefined();
  });

  it('Case 1: completed UPI intent: succeeded, paid at the attempt\'s time, method upi; the empty udf values are not metadata', async () => {
    const t = makeProvider([orderRoute(ID, ORDER_CASE_1_STATUS)]);
    expect(await t.provider.getPayment(ID)).toEqual({
      provider: Provider.PhonePe,
      id: ID,
      reference: ID,
      status: PaymentStatus.Succeeded,
      providerStatus: 'COMPLETED',
      amount: 1000,
      currency: Currency.INR,
      paymentMethod: PaymentMethod.Upi,
      paidAt: new Date(1719913509762).toISOString(),
      raw: ORDER_CASE_1_STATUS,
    });
  });

  it('the curl sample (UPI QR with placeholder values) is a succeeded UPI payment', async () => {
    const t = makeProvider([orderRoute(ID, ORDER_SAMPLE_CURL_STATUS)]);
    expect(await t.provider.getPayment(ID)).toMatchObject({
      status: PaymentStatus.Succeeded,
      amount: 1000,
      paymentMethod: PaymentMethod.Upi,
      paidAt: new Date(1711694662542).toISOString(),
    });
  });

  it('Case 3: a card payment: method card, the udf values come back as metadata', async () => {
    const t = makeProvider([orderRoute(ID, ORDER_CASE_3_STATUS)]);
    const payment = await t.provider.getPayment(ID);
    expect(payment).toMatchObject({ status: PaymentStatus.Succeeded, amount: 100, paymentMethod: PaymentMethod.Card });
    expect(payment.metadata).toEqual(ORDER_CASE_3_STATUS.metaInfo);
  });

  it('Case 4: PENDING with no payment attempt yet is created, with the order\'s own state kept', async () => {
    const t = makeProvider([orderRoute(ID, ORDER_CASE_4_STATUS)]);
    expect(await t.provider.getPayment(ID)).toMatchObject({
      status: PaymentStatus.Created,
      providerStatus: 'PENDING',
      amount: 100,
      metadata: Object.fromEntries(Array.from({ length: 15 }, (_, index) => [`udf${index + 1}`, `additional-information-${index + 1}`])),
    });
  });

  it('PENDING with an attempt in flight is pending', async () => {
    const order = { ...ORDER_CASE_4_STATUS, paymentDetails: [{ transactionId: 'OM1', paymentMode: 'UPI_INTENT', timestamp: 1720702400000, amount: 100, state: 'PENDING' }] };
    const t = makeProvider([orderRoute(ID, order)]);
    expect(await t.provider.getPayment(ID)).toMatchObject({ status: PaymentStatus.Pending, providerStatus: 'PENDING', paymentMethod: PaymentMethod.Upi });
  });

  it('PENDING after a failed attempt is still pending: the customer may retry inside the order\'s life', async () => {
    const order = { ...ORDER_CASE_5_STATUS, state: 'PENDING', errorCode: undefined, detailedErrorCode: undefined };
    const t = makeProvider([orderRoute(ID, order)]);
    const payment = await t.provider.getPayment(ID);
    expect(payment.status).toBe(PaymentStatus.Pending);
    expect(payment.failureCode).toBeUndefined();
  });

  it('Case 5: a failed order: failed, with the code, the detailed code and the errorContext description', async () => {
    const t = makeProvider([orderRoute(ID, ORDER_CASE_5_STATUS)]);
    expect(await t.provider.getPayment(ID)).toMatchObject({
      status: PaymentStatus.Failed,
      providerStatus: 'FAILED',
      amount: 200,
      paymentMethod: PaymentMethod.Upi,
      failureCode: 'INVALID_MPIN',
      failureReason: 'Wrong MPIN was entered',
    });
  });

  it('a failed order without an errorContext still names the code and the detailed code', async () => {
    const { errorContext: _dropped, ...order } = ORDER_CASE_5_STATUS;
    const t = makeProvider([orderRoute(ID, order)]);
    expect(await t.provider.getPayment(ID)).toMatchObject({
      status: PaymentStatus.Failed,
      failureCode: 'INVALID_MPIN',
      failureReason: 'INVALID_MPIN (detailed error code ZM)',
    });
  });

  it('a failed order whose codes are only on its attempt takes them from the latest attempt', async () => {
    const order = { ...ORDER_CASE_5_STATUS, errorCode: undefined, detailedErrorCode: undefined, errorContext: undefined };
    const t = makeProvider([orderRoute(ID, order)]);
    expect(await t.provider.getPayment(ID)).toMatchObject({ failureCode: 'INVALID_MPIN' });
  });

  it('Case 6: PhonePe has no such order: NOT_FOUND with its code', async () => {
    const t = makeProvider([orderRoute(ID, ORDER_CASE_6_STATUS, 404)]);
    expect(await rejection(t.provider.getPayment(ID))).toMatchObject({ code: ErrorCode.NotFound, providerCode: 'INVALID_MERCHANT_ORDER_ID' });
  });

  it('a bare 404 without PhonePe\'s code proves nothing and is PROVIDER_ERROR, not NOT_FOUND', async () => {
    const t = makeProvider([orderRoute(ID, { message: 'nope' }, 404)]);
    expect((await rejection(t.provider.getPayment(ID))).code).toBe(ErrorCode.ProviderError);
  });

  it('Case 7: a CREDIT_LINE payment (a mode with no unified method): succeeded, no paymentMethod invented', async () => {
    const t = makeProvider([orderRoute('ORD123456', ORDER_CASE_7_STATUS)]);
    const payment = await t.provider.getPayment('ORD123456');
    expect(payment).toMatchObject({ status: PaymentStatus.Succeeded, amount: 50000, paidAt: new Date(1746000000000).toISOString() });
    expect(payment.paymentMethod).toBeUndefined();
  });

  it('a state PhonePe adds later is pending, with the state kept verbatim', async () => {
    const t = makeProvider([orderRoute(ID, { ...ORDER_CASE_1_STATUS, state: 'AUTHORIZED' })]);
    expect(await t.provider.getPayment(ID)).toMatchObject({ status: UNKNOWN_PAYMENT_STATUS, providerStatus: 'AUTHORIZED' });
    expect(UNKNOWN_PAYMENT_STATUS).toBe(PaymentStatus.Pending);
  });

  it('a state named like an inherited property is the fallback, not a crash', async () => {
    const t = makeProvider([orderRoute(ID, { ...ORDER_CASE_1_STATUS, state: 'constructor' })]);
    expect((await t.provider.getPayment(ID)).status).toBe(PaymentStatus.Pending);
  });

  it('an order without an amount is UNEXPECTED_RESPONSE', async () => {
    const { amount: _amount, paymentDetails: _details, ...order } = ORDER_CASE_1_STATUS;
    const t = makeProvider([orderRoute(ID, order)]);
    expect((await rejection(t.provider.getPayment(ID))).code).toBe(ErrorCode.UnexpectedResponse);
  });

  it.each([
    ['a subscription setup order', 'order_setup_1', SETUP_ORDER_COMPLETED_SC_ORDER],
    ['a subscription debit', 'order_debit_1', REDEMPTION_ORDER_COMPLETED_A_REDORDER],
    ['a pre-debit notification', 'order_notice_1', NOTIFICATION_STATUS_SC_NOTIFSTATUS],
    ['an order of an unknown flow', 'order_other_1', { ...ORDER_CASE_1_STATUS, paymentFlow: { type: 'PAYMENT_LINK' } }],
  ])('refuses %s: it is not a one-time payment, so it can never be read or confirmed as one', async (_name, id, order) => {
    const t = makeProvider([orderRoute(id, order)]);
    const error = await rejection(t.provider.getPayment(id));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(error.message).toContain('not a one-time payment');
  });

  it('refuses an id PhonePe could not hold, and the ST_ prefix, without a call', async () => {
    const t = makeProvider();
    for (const id of ['', 'has space', 'ST_sub_1', 'x'.repeat(64)]) {
      expect((await rejection(t.provider.getPayment(id))).code).toBe(ErrorCode.Validation);
    }
    expect(t.calls).toHaveLength(0);
  });

  it('PENDING without attempts reads as created only for an order with no attempt list at all too', async () => {
    const { paymentDetails: _dropped, ...order } = ORDER_CASE_4_STATUS;
    const t = makeProvider([orderRoute(ID, order)]);
    expect((await t.provider.getPayment(ID)).status).toBe(PaymentStatus.Created);
  });

  it('an expired access token is replaced once and the read repeated', async () => {
    const t = makeProvider(
      [route(HttpMethod.Get, orderPath(ID), { status: 401, json: { code: 'UNAUTHORIZED', message: 'token' } }), orderRoute(ID, ORDER_CASE_1_STATUS)],
      { tokens: 2 },
    );
    expect((await t.provider.getPayment(ID)).status).toBe(PaymentStatus.Succeeded);
    expect(t.tokenCalls()).toHaveLength(2);
  });
});

describe('the status and payment-method tables', () => {
  it.each([
    ['PENDING', PaymentStatus.Pending],
    ['COMPLETED', PaymentStatus.Succeeded],
    ['FAILED', PaymentStatus.Failed],
    ['NOTIFICATION_IN_PROGRESS', PaymentStatus.Pending],
    ['NOTIFIED', PaymentStatus.Pending],
  ])('order state %s is payment status %s', (state, status) => {
    expect(ORDER_STATE_TO_PAYMENT_STATUS).toHaveProperty(state, status);
  });

  it('PhonePe never reports cancelled, refunded or partially refunded on an order', () => {
    const produced = new Set<string>(Object.values(ORDER_STATE_TO_PAYMENT_STATUS));
    for (const status of [PaymentStatus.Cancelled, PaymentStatus.Refunded, PaymentStatus.PartiallyRefunded, PaymentStatus.Created]) {
      expect(produced.has(status)).toBe(false);
    }
  });

  it.each([
    ['UPI_INTENT', PaymentMethod.Upi],
    ['UPI_QR', PaymentMethod.Upi],
    ['UPI_COLLECT', PaymentMethod.Upi],
    ['CARD', PaymentMethod.Card],
    ['NET_BANKING', PaymentMethod.NetBanking],
  ])('attempt mode %s is payment method %s', (mode, method) => {
    expect(PAYMENT_METHOD_BY_MODE[mode]).toBe(method);
  });

  it('every method in capabilities.oneTimePaymentMethods can be restricted to, and nothing else can', () => {
    expect(ONE_TIME_PAYMENT_METHODS).toEqual([PaymentMethod.Upi, PaymentMethod.Card, PaymentMethod.NetBanking]);
    expect(Object.keys(PAYMENT_MODES_BY_METHOD).sort()).toEqual([...ONE_TIME_PAYMENT_METHODS].sort());
    const { provider } = makeProvider();
    expect(provider.capabilities).toMatchObject({ oneTimePayments: true, oneTimePaymentMethods: ONE_TIME_PAYMENT_METHODS });
  });
});

describe('verifyPayment: the unsigned return [STEPS, CHECKLIST]', () => {
  const returned = (id = ID) => ({ merchantOrderId: id, anything: 'else the browser sent' });

  it('reads the order from PhonePe and reports paid only for COMPLETED', async () => {
    const t = makeProvider([orderRoute(ID, ORDER_CASE_1_STATUS)]);
    const verification = await t.provider.verifyPayment(returned());
    expect(t.apiCalls()).toHaveLength(1);
    expect(verification).toMatchObject({
      provider: Provider.PhonePe,
      paymentId: ID,
      reference: ID,
      paid: true,
      status: PaymentStatus.Succeeded,
      payment: { id: ID, status: PaymentStatus.Succeeded, amount: 1000 },
    });
    expect(verification.raw).toEqual(ORDER_CASE_1_STATUS);
  });

  it.each([
    ['PENDING (no attempt)', ORDER_CASE_4_STATUS, PaymentStatus.Created],
    ['FAILED', ORDER_CASE_5_STATUS, PaymentStatus.Failed],
    ['a state PhonePe adds later', { ...ORDER_CASE_1_STATUS, state: 'AUTHORIZED' }, PaymentStatus.Pending],
  ])('is not paid when the order is %s', async (_name, order, status) => {
    const t = makeProvider([orderRoute(ID, order)]);
    expect(await t.provider.verifyPayment(returned())).toMatchObject({ paid: false, status });
  });

  it('browser data cannot make a payment paid: success-looking parameters change nothing', async () => {
    const t = makeProvider([orderRoute(ID, ORDER_CASE_5_STATUS)]);
    const verification = await t.provider.verifyPayment({ merchantOrderId: ID, state: 'COMPLETED', code: 'PAYMENT_SUCCESS', paid: 'true' });
    expect(verification.paid).toBe(false);
  });

  it('the return of a subscription setup order is refused, not reported as a payment', async () => {
    const t = makeProvider([orderRoute('order_setup_1', SETUP_ORDER_COMPLETED_SC_ORDER)]);
    expect((await rejection(t.provider.verifyPayment(returned('order_setup_1')))).code).toBe(ErrorCode.Validation);
  });

  it('a result without the order id is VALIDATION and nothing is sent', async () => {
    const t = makeProvider();
    for (const result of [{}, { merchantOrderId: '' }, { merchantOrderId: 7 }, { merchantSubscriptionId: 'sub_1' }]) {
      expect((await rejection(t.provider.verifyPayment(result))).code).toBe(ErrorCode.Validation);
    }
    expect(t.calls).toHaveLength(0);
  });

  it('an unknown order is NOT_FOUND', async () => {
    const t = makeProvider([orderRoute(ID, ORDER_CASE_6_STATUS, 404)]);
    expect((await rejection(t.provider.verifyPayment(returned()))).code).toBe(ErrorCode.NotFound);
  });
});

describe('refundPayment [REFUND]', () => {
  const REFUND_PATH = '/payments/v2/refund';
  const completedOrder = ORDER_CASE_1_STATUS;
  const refundRoute = (json: unknown = REFUND_RESPONSE_CASE_1_REFUND) => route(HttpMethod.Post, REFUND_PATH, { json });

  it('reads the order, then POST /payments/v2/refund with the documented body; the refund carries chargeId and paymentId', async () => {
    const t = makeProvider([orderRoute('Order-12345', completedOrder), refundRoute()]);
    const refund = await t.provider.refundPayment({ paymentId: 'Order-12345', refundId: 'Refund-id-12345', amount: 1000 });

    const [read, write] = t.apiCalls();
    expect(read).toMatchObject({ method: 'GET', url: `${SANDBOX_API}${orderPath('Order-12345')}` });
    expect(write).toMatchObject({ method: 'POST', url: `${SANDBOX_API}${REFUND_PATH}` });
    expect(write?.headers).toMatchObject({ authorization: O_BEARER(TEST_TOKEN), 'content-type': 'application/json' });
    expect(write?.json).toEqual({ merchantRefundId: 'Refund-id-12345', originalMerchantOrderId: 'Order-12345', amount: 1000 });
    expect(refund).toEqual({
      provider: Provider.PhonePe,
      id: 'OMRxxxxx',
      reference: 'Refund-id-12345',
      chargeId: 'Order-12345',
      paymentId: 'Order-12345',
      status: RefundStatus.Pending,
      providerStatus: 'PENDING',
      amount: 1234,
      currency: Currency.INR,
      raw: REFUND_RESPONSE_CASE_1_REFUND,
    });
  });

  it('the documentation\'s sample request is what a partial refund sends', async () => {
    const order = { ...completedOrder, amount: 5000 };
    const t = makeProvider([orderRoute(REFUND_REQUEST_REFUND.originalMerchantOrderId, order), refundRoute()]);
    await t.provider.refundPayment({
      paymentId: REFUND_REQUEST_REFUND.originalMerchantOrderId,
      refundId: REFUND_REQUEST_REFUND.merchantRefundId,
      amount: REFUND_REQUEST_REFUND.amount,
    });
    expect(t.apiCalls()[1]?.json).toEqual(REFUND_REQUEST_REFUND);
  });

  it('without an amount the whole payment is refunded: its amount is read from the order', async () => {
    const t = makeProvider([orderRoute(ID, completedOrder), refundRoute({ ...REFUND_RESPONSE_CASE_1_REFUND, amount: 1000 })]);
    const refund = await t.provider.refundPayment({ paymentId: ID, refundId: 'r_1' });
    expect(t.apiCalls()[1]?.json).toMatchObject({ amount: 1000 });
    expect(refund.amount).toBe(1000);
  });

  it('an amount above the payment is refused before the refund call (PhonePe: "cannot exceed the initiated amount")', async () => {
    const t = makeProvider([orderRoute(ID, completedOrder)]);
    const error = await rejection(t.provider.refundPayment({ paymentId: ID, refundId: 'r_1', amount: 1001 }));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(t.apiCalls()).toHaveLength(1);
  });

  it.each([
    ['PENDING', ORDER_CASE_4_STATUS],
    ['FAILED', ORDER_CASE_5_STATUS],
  ])('a %s payment cannot be refunded: VALIDATION, no refund call', async (_state, order) => {
    const t = makeProvider([orderRoute(ID, order)]);
    expect((await rejection(t.provider.refundPayment({ paymentId: ID, refundId: 'r_1' }))).code).toBe(ErrorCode.Validation);
    expect(t.apiCalls()).toHaveLength(1);
  });

  it('a subscription debit is not a payment and cannot be refunded through this call', async () => {
    const t = makeProvider([orderRoute('order_debit_1', REDEMPTION_ORDER_COMPLETED_A_REDORDER)]);
    expect((await rejection(t.provider.refundPayment({ paymentId: 'order_debit_1', refundId: 'r_1' }))).code).toBe(ErrorCode.Validation);
    expect(t.apiCalls()).toHaveLength(1);
  });

  it('refuses a reason, which PhonePe has no field for, before any call', async () => {
    const t = makeProvider();
    const error = await rejection(t.provider.refundPayment({ paymentId: ID, refundId: 'r_1', reason: 'customer asked' }));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(error.message).toContain('reason');
    expect(t.calls).toHaveLength(0);
  });

  it('an unknown payment is NOT_FOUND', async () => {
    const t = makeProvider([orderRoute(ID, ORDER_CASE_6_STATUS, 404)]);
    expect((await rejection(t.provider.refundPayment({ paymentId: ID, refundId: 'r_1' }))).code).toBe(ErrorCode.NotFound);
  });

  it('refuses a refund id PhonePe could not hold, without a call', async () => {
    const t = makeProvider();
    for (const refundId of ['has space', 'x'.repeat(64)]) {
      expect((await rejection(t.provider.refundPayment({ paymentId: ID, refundId }))).code).toBe(ErrorCode.Validation);
    }
    expect(t.calls).toHaveLength(0);
  });

  it('PhonePe\'s refusal of an excess refund (EXCESS_REFUND_AMOUNT) is VALIDATION with its code kept', async () => {
    const t = makeProvider([
      orderRoute(ID, completedOrder),
      route(HttpMethod.Post, REFUND_PATH, { status: 400, json: { code: 'EXCESS_REFUND_AMOUNT', message: 'Refund amount exceeds' } }),
    ]);
    expect(await rejection(t.provider.refundPayment({ paymentId: ID, refundId: 'r_1', amount: 1000 }))).toMatchObject({
      code: ErrorCode.Validation,
      providerCode: 'EXCESS_REFUND_AMOUNT',
    });
  });

  it('the refund call is never repeated by the adapter (a lost answer is OUTCOME_UNKNOWN)', async () => {
    const t = makeProvider([orderRoute(ID, completedOrder), { method: HttpMethod.Post, url: `${SANDBOX_API}${REFUND_PATH}`, networkError: true }]);
    expect((await rejection(t.provider.refundPayment({ paymentId: ID, refundId: 'r_1' }))).code).toBe(ErrorCode.OutcomeUnknown);
    expect(t.apiCalls().filter((call) => call.method === 'POST')).toHaveLength(1);
  });
});
