/**
 * Seam 15: one-time payments end to end on PayU, PhonePe and Paytm, through the real facade (`subs.payments.*`,
 * `subs.webhooks.handle`) and the real adapters, with scripted gateway HTTP. Each gateway has its own describe: create (the checkout
 * instruction and the outgoing request), verify (the result the customer's browser brings back, the SIGNATURE_INVALID cases),
 * get, a signed webhook, and a refund. The provider is always named explicitly: no routing is configured.
 *
 * Signatures are computed here with node:crypto (PayU's reverse hash, PhonePe's webhook Authorization value) or with the independent
 * Paytm checksum of test/paytm/helpers.ts, never with the library.
 */
import { describe, expect, it } from 'vitest';
import { createSubscriptions, type Subscriptions } from '../../src/client.js';
import { CheckoutKind, Currency, Environment, ErrorCode, EventType, HttpMethod, PaymentMethod, PaymentStatus, Provider, RefundStatus } from '../../src/constants.js';
import type { SubscriptionProvider } from '../../src/provider.js';
import { PAYMENT_REFUND_TOKEN_PREFIX, PAYU_API_URLS, PAYU_ONE_TIME_MARKER, PAYU_PAYMENT_URLS, PAYU_NO_ERROR_CODE, PAYU_NO_ERROR_MESSAGE, PayUCommand, PayUCommandField, PayUPaymentMode, PayUPaymentStatus, PayUPgType, PayUTransactionState } from '../../src/providers/payu/constants.js';
import { PHONEPE_AUTH_SCHEME, PhonePeEvent, PhonePeOrderState, PhonePePath, PhonePePaymentFlowType, PhonePePaymentMode, PhonePeRefundState } from '../../src/providers/phonepe/constants.js';
import { PAYTM_BASE_URLS, PAYTM_CURRENCY, PAYTM_PAYMENT_ORDER_PREFIX, PAYTM_REQUEST_TYPE_PAYMENT, PAYTM_TXN_TYPE_REFUND, PaytmHostFamily, PaytmPath, PaytmQuery, PaytmResultStatus, PaytmTxnStatus } from '../../src/providers/paytm/constants.js';
import type { RecordedCall } from '../helpers/mock-fetch.js';
import { KEY as PAYTM_KEY, MID as PAYTM_MID, formBody, reply, sent, signForm, webhookRequest as paytmWebhookRequest } from '../paytm/helpers.js';
import { PAY_ERROR_CASE_2_CREATE, PAY_RESPONSE_CASE_1_CREATE, REFUND_RESPONSE_CASE_1_REFUND, WEBHOOK_ORDER_COMPLETED_WEBHOOK } from '../phonepe/payment-fixtures.js';
import { O_BEARER, RETURN_URL as PHONEPE_RETURN_URL, SANDBOX_API, SANDBOX_TOKEN_URL, TEST_TOKEN, WEBHOOK_AUTHORIZATION, sha256Hex, tokenBody, webhookRequest as phonepeWebhookRequest } from '../phonepe/helpers.js';
import { PAYU_ACCOUNT, CUSTOMER, Clock, payuProvider, rejection, scriptedFetch, sha512Hex, signedPayuForm, type Reply } from './helpers.js';
import { form, paytmProvider, phonepeProvider } from './fakes.js';

const T0 = '2026-01-01T05:00:00.000Z';
const AMOUNT = 49900;
const REFUND_AMOUNT = 10000;
const DESCRIPTION = 'Pro plan';

/** A facade over exactly the given gateways, with no routing and no scheduler. */
const facade = (...providers: SubscriptionProvider[]): Subscriptions => createSubscriptions({ providers });

const paymentInput = (reference: string, over: Record<string, unknown> = {}) => ({ reference, amount: AMOUNT, description: DESCRIPTION, customer: CUSTOMER, ...over });

/** The gateway URLs the calls went to, in order. */
const urls = (calls: RecordedCall[]) => calls.map((call) => call.url);

// ---------------------------------------------------------------------------
// PayU
// ---------------------------------------------------------------------------

const PAYU_ID = 'ORDER_PU_1';
const PAYU_MIHPAYID = '403993715537565049';
const PAYU_API = PAYU_API_URLS[Environment.Test];

/** The fields PayU posts to `surl` for a payment this library created (`udf5` carries the marker), unsigned. */
const payuFields = (over: Record<string, string> = {}): Record<string, string> => ({
  mihpayid: PAYU_MIHPAYID,
  mode: PayUPaymentMode.Upi,
  status: PayUPaymentStatus.Success,
  unmappedstatus: PayUTransactionState.Captured,
  key: PAYU_ACCOUNT.key,
  txnid: PAYU_ID,
  amount: '499.00',
  productinfo: DESCRIPTION,
  firstname: CUSTOMER.name,
  email: CUSTOMER.email,
  phone: CUSTOMER.phone,
  udf1: '', udf2: '', udf3: '', udf4: '',
  udf5: PAYU_ONE_TIME_MARKER,
  PG_TYPE: PayUPgType.Upi,
  addedon: '2026-01-01 10:31:00',
  error: PAYU_NO_ERROR_CODE,
  error_Message: PAYU_NO_ERROR_MESSAGE,
  ...over,
});
const signedPayu = (over: Record<string, string> = {}) => signedPayuForm(payuFields(over), PAYU_ACCOUNT.key, PAYU_ACCOUNT.salt);

function payuGateway() {
  const state = { paid: false };
  const transaction = (txnid: string) => ({
    status: 1,
    msg: '1 out of 1 Transactions Fetched Successfully',
    transaction_details: {
      [txnid]: {
        mihpayid: PAYU_MIHPAYID, txnid, amt: '499.00', transaction_amount: '499.00', net_amount_debit: '499.00', mode: PayUPaymentMode.Upi, PG_TYPE: PayUPgType.Upi,
        status: PayUPaymentStatus.Success, unmappedstatus: PayUTransactionState.Captured, addedon: '2026-01-01 10:31:00', error_code: PAYU_NO_ERROR_CODE,
        error_Message: PAYU_NO_ERROR_MESSAGE, productinfo: DESCRIPTION, firstname: CUSTOMER.name,
      },
    },
  });
  const notFound = (txnid: string) => ({ status: 0, msg: '0 out of 1 Transactions Fetched Successfully', transaction_details: { [txnid]: { mihpayid: 'Not Found', status: 'Not Found' } } });
  const { fetch, calls } = scriptedFetch((call): Reply => {
    expect(call.method).toBe(HttpMethod.Post);
    expect(call.url).toBe(PAYU_API);
    const fields = call.form ?? {};
    switch (fields[PayUCommandField.Command]) {
      case PayUCommand.VerifyPayment:
        return { json: state.paid ? transaction(fields[PayUCommandField.Var1] as string) : notFound(fields[PayUCommandField.Var1] as string) };
      case PayUCommand.CheckActionStatus:
        return { json: { status: 0, msg: '0 out of 1 Transactions Fetched Successfully', transaction_details: { [PAYU_MIHPAYID]: 'No action status found' } } };
      case PayUCommand.RefundTransaction:
        return { json: { status: 1, msg: 'Refund Request Queued', request_id: '17265314530', bank_ref_num: '100142082006', mihpayid: PAYU_MIHPAYID } };
      default:
        throw new Error(`unexpected PayU command ${fields[PayUCommandField.Command]}`);
    }
  });
  const provider = payuProvider(fetch, new Clock(T0));
  return { provider, subs: facade(provider), calls, state };
}

describe('PayU one-time payments through the facade', () => {
  it('create returns a created payment with the hashed form PayU documents; the id is looked up first', async () => {
    const t = payuGateway();
    const payment = await t.subs.payments.create(Provider.PayU, paymentInput(PAYU_ID));
    // The txnid is the reference: PayU is asked whether it already holds it before a form is returned.
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.form).toMatchObject({ [PayUCommandField.Command]: PayUCommand.VerifyPayment, [PayUCommandField.Var1]: PAYU_ID });
    const hash = sha512Hex(`${PAYU_ACCOUNT.key}|${PAYU_ID}|499.00|${DESCRIPTION}|${CUSTOMER.name}|${CUSTOMER.email}|||||${PAYU_ONE_TIME_MARKER}||||||${PAYU_ACCOUNT.salt}`);
    expect(payment).toMatchObject({
      provider: Provider.PayU,
      id: PAYU_ID,
      reference: PAYU_ID,
      status: PaymentStatus.Created,
      amount: AMOUNT,
      currency: Currency.INR,
      checkout: {
        kind: CheckoutKind.FormPost,
        url: PAYU_PAYMENT_URLS[Environment.Test],
        fields: {
          key: PAYU_ACCOUNT.key,
          txnid: PAYU_ID,
          amount: '499.00',
          productinfo: DESCRIPTION,
          firstname: CUSTOMER.name,
          email: CUSTOMER.email,
          phone: CUSTOMER.phone,
          surl: PAYU_ACCOUNT.successUrl,
          furl: PAYU_ACCOUNT.failureUrl,
          udf5: PAYU_ONE_TIME_MARKER,
          hash,
        },
      },
    });
    expect(JSON.stringify(payment)).not.toContain(PAYU_ACCOUNT.salt);
  });

  it('a create PayU cannot honour surfaces its mapped code and sends nothing', async () => {
    const t = payuGateway();
    const error = await rejection(() => t.subs.payments.create(Provider.PayU, paymentInput(PAYU_ID, { customer: { name: CUSTOMER.name, email: CUSTOMER.email } })));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(t.calls).toHaveLength(0);
  });

  it('verify accepts the form PayU posts to surl: the reverse hash is checked, no gateway call is needed', async () => {
    const t = payuGateway();
    const verification = await t.subs.payments.verify(Provider.PayU, signedPayu(), { expectedPaymentId: PAYU_ID });
    expect(t.calls).toHaveLength(0);
    expect(verification).toMatchObject({
      provider: Provider.PayU,
      paymentId: PAYU_ID,
      reference: PAYU_ID,
      paid: true,
      status: PaymentStatus.Succeeded,
      payment: { id: PAYU_ID, status: PaymentStatus.Succeeded, amount: AMOUNT, paymentMethod: PaymentMethod.Upi },
    });
  });

  it('verify refuses a tampered result and a genuine result of another payment with SIGNATURE_INVALID', async () => {
    const t = payuGateway();
    const tampered = { ...signedPayu(), amount: '1.00' };
    expect((await rejection(() => t.subs.payments.verify(Provider.PayU, tampered, { expectedPaymentId: PAYU_ID }))).code).toBe(ErrorCode.SignatureInvalid);
    const noHash = { ...signedPayu(), hash: '' };
    expect((await rejection(() => t.subs.payments.verify(Provider.PayU, noHash, { expectedPaymentId: PAYU_ID }))).code).toBe(ErrorCode.SignatureInvalid);
    const other = signedPayu({ txnid: 'ORDER_PU_2' });
    expect((await rejection(() => t.subs.payments.verify(Provider.PayU, other, { expectedPaymentId: PAYU_ID }))).code).toBe(ErrorCode.SignatureInvalid);
    expect(t.calls).toHaveLength(0);
  });

  it('get returns the payment as PayU reports it: verify_payment by txnid, then the refunds PayU holds', async () => {
    const t = payuGateway();
    t.state.paid = true;
    const payment = await t.subs.payments.get(Provider.PayU, PAYU_ID);
    expect(t.calls.map((call) => call.form?.[PayUCommandField.Command])).toEqual([PayUCommand.VerifyPayment, PayUCommand.CheckActionStatus]);
    expect(t.calls[1]?.form).toMatchObject({ [PayUCommandField.Var1]: PAYU_MIHPAYID });
    expect(payment).toMatchObject({ provider: Provider.PayU, id: PAYU_ID, status: PaymentStatus.Succeeded, providerStatus: PayUTransactionState.Captured, amount: AMOUNT, paymentMethod: PaymentMethod.Upi });
  });

  it('a signed webhook is payment.succeeded with paymentId and payment; a changed field or a missing hash is SIGNATURE_INVALID', async () => {
    const t = payuGateway();
    const events = await t.subs.webhooks.handle(Provider.PayU, form(signedPayu()));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ provider: Provider.PayU, type: EventType.PaymentSucceeded, paymentId: PAYU_ID, payment: { id: PAYU_ID, status: PaymentStatus.Succeeded, amount: AMOUNT } });
    expect(t.calls).toHaveLength(0);
    const tampered = form({ ...signedPayu(), amount: '1.00' });
    expect((await rejection(() => t.subs.webhooks.handle(Provider.PayU, tampered))).code).toBe(ErrorCode.SignatureInvalid);
    const unsigned = form({ ...signedPayu(), hash: '' });
    expect((await rejection(() => t.subs.webhooks.handle(Provider.PayU, unsigned))).code).toBe(ErrorCode.SignatureInvalid);
  });

  it('refund reads the payment, then sends cancel_refund_transaction with a prefixed token; chargeId and paymentId are the payment id', async () => {
    const t = payuGateway();
    t.state.paid = true;
    const refund = await t.subs.payments.refund(Provider.PayU, { paymentId: PAYU_ID, refundId: 'rf_1', amount: REFUND_AMOUNT });
    expect(t.calls).toHaveLength(2);
    expect(t.calls[0]?.form).toMatchObject({ [PayUCommandField.Command]: PayUCommand.VerifyPayment, [PayUCommandField.Var1]: PAYU_ID });
    expect(t.calls[1]?.form).toEqual({
      [PayUCommandField.Key]: PAYU_ACCOUNT.key,
      [PayUCommandField.Command]: PayUCommand.RefundTransaction,
      [PayUCommandField.Var1]: PAYU_MIHPAYID,
      [PayUCommandField.Var2]: `${PAYMENT_REFUND_TOKEN_PREFIX}rf_1`,
      [PayUCommandField.Var3]: '100.00',
      [PayUCommandField.Hash]: sha512Hex(`${PAYU_ACCOUNT.key}|${PayUCommand.RefundTransaction}|${PAYU_MIHPAYID}|${PAYU_ACCOUNT.salt}`),
    });
    expect(t.calls[1]?.body).not.toContain(PAYU_ACCOUNT.salt);
    expect(refund).toMatchObject({ provider: Provider.PayU, reference: 'rf_1', chargeId: PAYU_ID, paymentId: PAYU_ID, status: RefundStatus.Pending, amount: REFUND_AMOUNT, currency: Currency.INR });
  });
});

// ---------------------------------------------------------------------------
// PhonePe
// ---------------------------------------------------------------------------

const PHONEPE_ID = 'TX123rrty34432456';
const PHONEPE_OTHER_ID = 'TX999other';
const PHONEPE_ORDER_PATTERN = /\/checkout\/v2\/order\/([^/?]+)\/status/;

function phonepeGateway() {
  const clock = new Clock(T0);
  const state = { orderState: PhonePeOrderState.Pending as string };
  const order = (id: string) => ({
    orderId: `OMO_${id}`,
    state: state.orderState,
    amount: AMOUNT,
    expireAt: clock.nowMs() + 3_600_000,
    ...(state.orderState === PhonePeOrderState.Completed
      ? {
          paymentDetails: [{ transactionId: 'OM2407021515097451914211', paymentMode: PhonePePaymentMode.UpiIntent, timestamp: Date.parse('2026-01-01T05:01:00.000Z'), amount: AMOUNT, state: PhonePeOrderState.Completed }],
        }
      : {}),
  });
  const { fetch, calls } = scriptedFetch((call): Reply => {
    if (call.url === SANDBOX_TOKEN_URL) return { json: tokenBody(clock.nowMs()) };
    if (call.url === `${SANDBOX_API}${PhonePePath.Pay}`) return call.json && (call.json as { merchantOrderId: string }).merchantOrderId === 'DUPLICATE' ? { status: 400, json: PAY_ERROR_CASE_2_CREATE } : { json: PAY_RESPONSE_CASE_1_CREATE };
    if (call.url === `${SANDBOX_API}${PhonePePath.Refund}`) return { json: { ...REFUND_RESPONSE_CASE_1_REFUND, amount: REFUND_AMOUNT } };
    const status = PHONEPE_ORDER_PATTERN.exec(call.url);
    if (status && call.method === HttpMethod.Get) return { json: order(decodeURIComponent(status[1] as string)) };
    throw new Error(`unexpected PhonePe request ${call.method} ${call.url}`);
  });
  const provider = phonepeProvider(fetch, clock);
  /** The gateway calls without the token requests. */
  const api = () => calls.filter((call) => call.url !== SANDBOX_TOKEN_URL);
  return { provider, subs: facade(provider), calls, api, state };
}

describe('PhonePe one-time payments through the facade', () => {
  it('create posts the documented body with the O-Bearer token and returns a created payment with a redirect', async () => {
    const t = phonepeGateway();
    const payment = await t.subs.payments.create(Provider.PhonePe, paymentInput(PHONEPE_ID, { returnUrl: PHONEPE_RETURN_URL }));
    const [call] = t.api();
    expect(t.api()).toHaveLength(1);
    expect(call).toMatchObject({ method: HttpMethod.Post, url: `${SANDBOX_API}${PhonePePath.Pay}` });
    expect(call?.headers.authorization).toBe(O_BEARER(TEST_TOKEN));
    expect(call?.json).toEqual({ merchantOrderId: PHONEPE_ID, amount: AMOUNT, paymentFlow: { type: PhonePePaymentFlowType.PgCheckout, message: DESCRIPTION, merchantUrls: { redirectUrl: `${PHONEPE_RETURN_URL}?merchantOrderId=${PHONEPE_ID}` } } });
    expect(payment).toMatchObject({
      provider: Provider.PhonePe,
      id: PHONEPE_ID,
      reference: PHONEPE_ID,
      status: PaymentStatus.Created,
      amount: AMOUNT,
      currency: Currency.INR,
      checkout: { kind: CheckoutKind.Redirect, url: PAY_RESPONSE_CASE_1_CREATE.redirectUrl },
    });
  });

  it('a create PhonePe refuses surfaces its mapped code with PhonePe\'s own code kept', async () => {
    const t = phonepeGateway();
    const error = await rejection(() => t.subs.payments.create(Provider.PhonePe, paymentInput('DUPLICATE')));
    expect(error).toMatchObject({ code: ErrorCode.Validation, providerCode: PAY_ERROR_CASE_2_CREATE.code, httpStatus: 400 });
  });

  it('verify reads the order from PhonePe: a completed order is paid, and success-looking browser data cannot make a pending one paid', async () => {
    const t = phonepeGateway();
    const forged = { merchantOrderId: PHONEPE_ID, state: PhonePeOrderState.Completed, paid: 'true' };
    const pending = await t.subs.payments.verify(Provider.PhonePe, forged, { expectedPaymentId: PHONEPE_ID });
    expect(pending).toMatchObject({ paid: false, status: PaymentStatus.Created });
    t.state.orderState = PhonePeOrderState.Completed;
    const verification = await t.subs.payments.verify(Provider.PhonePe, { merchantOrderId: PHONEPE_ID }, { expectedPaymentId: PHONEPE_ID });
    expect(verification).toMatchObject({ provider: Provider.PhonePe, paymentId: PHONEPE_ID, reference: PHONEPE_ID, paid: true, status: PaymentStatus.Succeeded, payment: { id: PHONEPE_ID, amount: AMOUNT, paymentMethod: PaymentMethod.Upi } });
    expect(t.api().every((call) => call.method === HttpMethod.Get)).toBe(true);
  });

  it('verify refuses the return of another order, even a completed one, with SIGNATURE_INVALID', async () => {
    const t = phonepeGateway();
    t.state.orderState = PhonePeOrderState.Completed;
    const error = await rejection(() => t.subs.payments.verify(Provider.PhonePe, { merchantOrderId: PHONEPE_OTHER_ID }, { expectedPaymentId: PHONEPE_ID }));
    expect(error.code).toBe(ErrorCode.SignatureInvalid);
  });

  it('get returns the order as PhonePe reports it: created while no attempt exists, then succeeded with the attempt\'s time', async () => {
    const t = phonepeGateway();
    expect(await t.subs.payments.get(Provider.PhonePe, PHONEPE_ID)).toMatchObject({ status: PaymentStatus.Created, providerStatus: PhonePeOrderState.Pending, amount: AMOUNT });
    t.state.orderState = PhonePeOrderState.Completed;
    const payment = await t.subs.payments.get(Provider.PhonePe, PHONEPE_ID);
    expect(t.api().at(-1)).toMatchObject({ method: HttpMethod.Get });
    expect(t.api().at(-1)?.url).toContain(`${SANDBOX_API}${PhonePePath.orderStatus(PHONEPE_ID)}`);
    expect(payment).toMatchObject({ id: PHONEPE_ID, status: PaymentStatus.Succeeded, providerStatus: PhonePeOrderState.Completed, amount: AMOUNT, paymentMethod: PaymentMethod.Upi, paidAt: '2026-01-01T05:01:00.000Z' });
  });

  it('a webhook with PhonePe\'s Authorization value is payment.succeeded; a wrong or missing value is SIGNATURE_INVALID', async () => {
    const t = phonepeGateway();
    const body = {
      ...WEBHOOK_ORDER_COMPLETED_WEBHOOK,
      event: PhonePeEvent.CheckoutOrderCompleted,
      payload: { ...WEBHOOK_ORDER_COMPLETED_WEBHOOK.payload, merchantOrderId: PHONEPE_ID, amount: AMOUNT, paymentDetails: [{ ...WEBHOOK_ORDER_COMPLETED_WEBHOOK.payload.paymentDetails[0], amount: AMOUNT }] },
    };
    const events = await t.subs.webhooks.handle(Provider.PhonePe, phonepeWebhookRequest(body));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ provider: Provider.PhonePe, type: EventType.PaymentSucceeded, paymentId: PHONEPE_ID, payment: { id: PHONEPE_ID, status: PaymentStatus.Succeeded, amount: AMOUNT, paymentMethod: PaymentMethod.Upi } });
    const wrong = sha256Hex('someone:else');
    expect(WEBHOOK_AUTHORIZATION).not.toBe(wrong);
    expect((await rejection(() => t.subs.webhooks.handle(Provider.PhonePe, phonepeWebhookRequest(body, wrong)))).code).toBe(ErrorCode.SignatureInvalid);
    expect((await rejection(() => t.subs.webhooks.handle(Provider.PhonePe, phonepeWebhookRequest(body, null)))).code).toBe(ErrorCode.SignatureInvalid);
    // A non-completed state is not reported as a success, whatever the event name says.
    const lying = { ...body, payload: { ...body.payload, state: PhonePeOrderState.Failed } };
    const [unknown] = await t.subs.webhooks.handle(Provider.PhonePe, phonepeWebhookRequest(lying));
    expect(unknown?.type).toBe(EventType.Unknown);
  });

  it('refund reads the order, then posts the documented refund body; chargeId and paymentId are the order id', async () => {
    const t = phonepeGateway();
    t.state.orderState = PhonePeOrderState.Completed;
    const refund = await t.subs.payments.refund(Provider.PhonePe, { paymentId: PHONEPE_ID, refundId: 'Refund-1', amount: REFUND_AMOUNT });
    const [read, write] = t.api();
    expect(t.api()).toHaveLength(2);
    expect(read).toMatchObject({ method: HttpMethod.Get });
    expect(write).toMatchObject({ method: HttpMethod.Post, url: `${SANDBOX_API}${PhonePePath.Refund}` });
    expect(write?.headers.authorization).toBe(`${PHONEPE_AUTH_SCHEME} ${TEST_TOKEN}`);
    expect(write?.json).toEqual({ merchantRefundId: 'Refund-1', originalMerchantOrderId: PHONEPE_ID, amount: REFUND_AMOUNT });
    expect(refund).toMatchObject({
      provider: Provider.PhonePe,
      id: REFUND_RESPONSE_CASE_1_REFUND.refundId,
      reference: 'Refund-1',
      chargeId: PHONEPE_ID,
      paymentId: PHONEPE_ID,
      status: RefundStatus.Pending,
      providerStatus: PhonePeRefundState.Pending,
      amount: REFUND_AMOUNT,
      currency: Currency.INR,
    });
  });
});

// ---------------------------------------------------------------------------
// Paytm
// ---------------------------------------------------------------------------

const PAYTM_REFERENCE = 'ORDERID_98765';
const PAYTM_ID = `${PAYTM_PAYMENT_ORDER_PREFIX}${PAYTM_REFERENCE}`;
const PAYTM_SUBSCRIPTION_HOST = PAYTM_BASE_URLS[PaytmHostFamily.Subscription][Environment.Test];
const PAYTM_TXN_ID = '202601011031128XXXXXX68470101509706';
const PAYTM_TXN_TOKEN = 'fe795335ed3049c78a57271075f2199e1526969112097';

/** The key-value post of Paytm's payment page for a paid card payment: field names as Paytm prints them. */
const paytmFields = (over: Record<string, string> = {}): Record<string, string> => ({
  CURRENCY: PAYTM_CURRENCY, GATEWAYNAME: 'HDFC', RESPMSG: 'Txn Success', BANKNAME: 'HSBC', PAYMENTMODE: 'CC', MID: PAYTM_MID, RESPCODE: '01', TXNID: PAYTM_TXN_ID,
  TXNAMOUNT: '499.00', ORDERID: PAYTM_ID, STATUS: PaytmTxnStatus.Success, BANKTXNID: '777001087423130', TXNDATE: '2026-01-01 10:31:00.0',
  ...over,
});

function paytmGateway() {
  const state = { txnStatus: PaytmTxnStatus.Pending as string };
  const transaction = (orderId: string) =>
    reply({
      resultInfo:
        state.txnStatus === PaytmTxnStatus.Success
          ? { resultStatus: state.txnStatus, resultCode: '01', resultMsg: 'Txn Success' }
          : { resultStatus: state.txnStatus, resultCode: '402', resultMsg: 'Looks like the payment is not complete.' },
      txnId: PAYTM_TXN_ID, bankTxnId: '777001087423130', orderId, txnAmount: '499.00', txnType: 'SALE', gatewayName: 'HDFC', bankName: 'HSBC', mid: PAYTM_MID,
      paymentMode: 'CC', refundAmt: '0.00', txnDate: '2026-01-01 10:31:00.0',
    });
  const { fetch, calls } = scriptedFetch((call): Reply => {
    const url = new URL(call.url);
    const orderId = url.searchParams.get(PaytmQuery.OrderId) ?? (call.json as { body: { orderId: string } }).body.orderId;
    switch (url.pathname) {
      case PaytmPath.InitiateTransaction:
        return orderId === 'pay_REJECTED'
          ? { json: reply({ resultInfo: { resultStatus: PaytmResultStatus.Failure, resultCode: '2007', resultMsg: 'Txn amount is invalid' } }) }
          : { json: reply({ resultInfo: { resultStatus: PaytmResultStatus.Success, resultCode: '0000', resultMsg: 'Success' }, txnToken: PAYTM_TXN_TOKEN }) };
      case PaytmPath.TransactionStatus:
        return { json: transaction(orderId) };
      case PaytmPath.Refund:
        return {
          json: reply({
            txnTimestamp: '2026-01-01 11:00:00.0',
            orderId,
            mid: PAYTM_MID,
            refId: (call.json as { body: { refId: string } }).body.refId,
            resultInfo: { resultStatus: 'PENDING', resultCode: '601', resultMsg: 'Refund request was raised for this transaction. But it is pending state' },
            refundId: 'PAYTM_REFUND_1',
            txnId: PAYTM_TXN_ID,
            refundAmount: '100.00',
          }),
        };
      default:
        throw new Error(`unexpected Paytm request ${call.method} ${call.url}`);
    }
  });
  const provider = paytmProvider(fetch, new Clock(T0));
  return { provider, subs: facade(provider), calls, state };
}

describe('Paytm one-time payments through the facade', () => {
  it('create sends a signed Initiate Transaction request and returns a created payment with the payment-page form', async () => {
    const t = paytmGateway();
    const payment = await t.subs.payments.create(Provider.Paytm, paymentInput(PAYTM_REFERENCE));
    expect(t.calls).toHaveLength(1);
    const request = sent(t.calls[0] as RecordedCall, PAYTM_KEY);
    expect(request.url.href).toBe(`${PAYTM_SUBSCRIPTION_HOST}${PaytmPath.InitiateTransaction}?mid=${PAYTM_MID}&orderId=${PAYTM_ID}`);
    expect(request.body).toMatchObject({
      requestType: PAYTM_REQUEST_TYPE_PAYMENT,
      mid: PAYTM_MID,
      orderId: PAYTM_ID,
      txnAmount: { value: '499.00', currency: PAYTM_CURRENCY },
      userInfo: { mobile: CUSTOMER.phone, email: CUSTOMER.email, firstName: 'Asha', lastName: 'Rao' },
    });
    expect(payment).toMatchObject({
      provider: Provider.Paytm,
      id: PAYTM_ID,
      reference: PAYTM_REFERENCE,
      status: PaymentStatus.Created,
      amount: AMOUNT,
      currency: Currency.INR,
      checkout: { kind: CheckoutKind.FormPost, url: `${PAYTM_SUBSCRIPTION_HOST}${PaytmPath.ShowPaymentPage}?mid=${PAYTM_MID}&orderId=${PAYTM_ID}`, fields: { mid: PAYTM_MID, orderId: PAYTM_ID, txnToken: PAYTM_TXN_TOKEN } },
    });
    expect(JSON.stringify(payment)).not.toContain(PAYTM_KEY);
  });

  it('a create Paytm rejects surfaces its mapped code with Paytm\'s result code kept', async () => {
    const t = paytmGateway();
    const error = await rejection(() => t.subs.payments.create(Provider.Paytm, paymentInput('REJECTED')));
    expect(error).toMatchObject({ code: ErrorCode.Validation, providerCode: '2007' });
    expect(error.message).toContain('Txn amount is invalid');
  });

  it('verify checks the CHECKSUMHASH, then confirms with Transaction Status: paid comes from the status API', async () => {
    const t = paytmGateway();
    t.state.txnStatus = PaytmTxnStatus.Success;
    const callback = signForm(paytmFields());
    const verification = await t.subs.payments.verify(Provider.Paytm, callback, { expectedPaymentId: PAYTM_ID });
    expect(t.calls).toHaveLength(1);
    expect(new URL((t.calls[0] as RecordedCall).url).pathname).toBe(PaytmPath.TransactionStatus);
    expect(sent(t.calls[0] as RecordedCall, PAYTM_KEY).body).toEqual({ mid: PAYTM_MID, orderId: PAYTM_ID });
    expect(verification).toMatchObject({ provider: Provider.Paytm, paymentId: PAYTM_ID, reference: PAYTM_REFERENCE, paid: true, status: PaymentStatus.Succeeded, payment: { id: PAYTM_ID, amount: AMOUNT, paymentMethod: PaymentMethod.Card } });
    // The reference alone names the payment too.
    expect((await t.subs.payments.verify(Provider.Paytm, callback, { expectedPaymentId: PAYTM_REFERENCE })).paid).toBe(true);
  });

  it('verify does not report paid for a callback that says success while Paytm still says pending', async () => {
    const t = paytmGateway();
    const verification = await t.subs.payments.verify(Provider.Paytm, signForm(paytmFields()), { expectedPaymentId: PAYTM_ID });
    expect(verification).toMatchObject({ paid: false, status: PaymentStatus.Pending });
  });

  it('verify refuses a tampered callback and a genuine callback of another payment with SIGNATURE_INVALID', async () => {
    const t = paytmGateway();
    t.state.txnStatus = PaytmTxnStatus.Success;
    const signed = signForm(paytmFields());
    for (const tampered of [{ ...signed, TXNAMOUNT: '0.01' }, { ...signed, CHECKSUMHASH: '' }, signForm(paytmFields(), 'zzzzzzzzzzzzzzzz')]) {
      const error = await rejection(() => t.subs.payments.verify(Provider.Paytm, tampered, { expectedPaymentId: PAYTM_ID }));
      expect(error.code).toBe(ErrorCode.SignatureInvalid);
    }
    expect(t.calls).toHaveLength(0);
    const other = signForm(paytmFields({ ORDERID: `${PAYTM_PAYMENT_ORDER_PREFIX}OTHER_1` }));
    const error = await rejection(() => t.subs.payments.verify(Provider.Paytm, other, { expectedPaymentId: PAYTM_ID }));
    expect(error.code).toBe(ErrorCode.SignatureInvalid);
  });

  it('get returns the payment as Transaction Status reports it', async () => {
    const t = paytmGateway();
    t.state.txnStatus = PaytmTxnStatus.Success;
    const payment = await t.subs.payments.get(Provider.Paytm, PAYTM_ID);
    expect(sent(t.calls[0] as RecordedCall, PAYTM_KEY).body).toEqual({ mid: PAYTM_MID, orderId: PAYTM_ID });
    expect(payment).toMatchObject({
      provider: Provider.Paytm,
      id: PAYTM_ID,
      reference: PAYTM_REFERENCE,
      status: PaymentStatus.Succeeded,
      providerStatus: PaytmTxnStatus.Success,
      amount: AMOUNT,
      paymentMethod: PaymentMethod.Card,
      paidAt: '2026-01-01T05:01:00.000Z',
    });
  });

  it('a signed Payment Status webhook is payment.succeeded with paymentId and payment; a changed field or a wrong key is SIGNATURE_INVALID', async () => {
    const t = paytmGateway();
    const request = paytmWebhookRequest(formBody(signForm(paytmFields())));
    const events = await t.subs.webhooks.handle(Provider.Paytm, request);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ provider: Provider.Paytm, type: EventType.PaymentSucceeded, paymentId: PAYTM_ID, payment: { id: PAYTM_ID, status: PaymentStatus.Succeeded, amount: AMOUNT, paymentMethod: PaymentMethod.Card } });
    expect(t.calls).toHaveLength(0);
    const tampered = paytmWebhookRequest(formBody({ ...signForm(paytmFields()), TXNAMOUNT: '1.00' }));
    expect((await rejection(() => t.subs.webhooks.handle(Provider.Paytm, tampered))).code).toBe(ErrorCode.SignatureInvalid);
    const wrongKey = paytmWebhookRequest(formBody(signForm(paytmFields(), 'zzzzzzzzzzzzzzzz')));
    expect((await rejection(() => t.subs.webhooks.handle(Provider.Paytm, wrongKey))).code).toBe(ErrorCode.SignatureInvalid);
  });

  it('refund reads the transaction, then sends the signed Refund API request; chargeId and paymentId are the payment id', async () => {
    const t = paytmGateway();
    t.state.txnStatus = PaytmTxnStatus.Success;
    const refund = await t.subs.payments.refund(Provider.Paytm, { paymentId: PAYTM_ID, refundId: 'RF_1', amount: REFUND_AMOUNT });
    expect(t.calls).toHaveLength(2);
    expect(new URL((t.calls[0] as RecordedCall).url).pathname).toBe(PaytmPath.TransactionStatus);
    const request = sent(t.calls[1] as RecordedCall, PAYTM_KEY);
    expect(new URL((t.calls[1] as RecordedCall).url).pathname).toBe(PaytmPath.Refund);
    expect(request.body).toMatchObject({ mid: PAYTM_MID, txnType: PAYTM_TXN_TYPE_REFUND, orderId: PAYTM_ID, txnId: PAYTM_TXN_ID, refId: 'RF_1', refundAmount: '100.00' });
    expect(refund).toMatchObject({ provider: Provider.Paytm, id: 'PAYTM_REFUND_1', reference: 'RF_1', chargeId: PAYTM_ID, paymentId: PAYTM_ID, status: RefundStatus.Pending, amount: REFUND_AMOUNT, currency: Currency.INR });
  });
});

// ---------------------------------------------------------------------------
// The provider is always named: nothing is routed
// ---------------------------------------------------------------------------

describe('explicit provider API', () => {
  it('each call reaches only the gateway it names, in a client that holds all three', async () => {
    const payu = payuGateway();
    const phonepe = phonepeGateway();
    const paytm = paytmGateway();
    const subs = facade(payu.provider, phonepe.provider, paytm.provider);
    await subs.payments.create(Provider.PhonePe, paymentInput(PHONEPE_ID));
    expect([payu.calls.length, paytm.calls.length]).toEqual([0, 0]);
    expect(urls(phonepe.api())).toEqual([`${SANDBOX_API}${PhonePePath.Pay}`]);
    await subs.payments.create(Provider.Paytm, paymentInput(PAYTM_REFERENCE));
    expect(payu.calls).toHaveLength(0);
    expect(phonepe.api()).toHaveLength(1);
    expect(paytm.calls).toHaveLength(1);
    await subs.payments.create(Provider.PayU, paymentInput(PAYU_ID));
    expect(urls(payu.calls)).toEqual([PAYU_API]);
    expect(phonepe.api()).toHaveLength(1);
    expect(paytm.calls).toHaveLength(1);
  });

  it('a gateway that is not configured is a CONFIG error: no other gateway takes the payment', async () => {
    const payu = payuGateway();
    const phonepe = phonepeGateway();
    const subs = facade(payu.provider, phonepe.provider);
    const error = await rejection(() => subs.payments.create(Provider.Paytm, paymentInput(PAYTM_REFERENCE)));
    expect(error.code).toBe(ErrorCode.Config);
    expect([payu.calls.length, phonepe.calls.length]).toEqual([0, 0]);
  });
});
