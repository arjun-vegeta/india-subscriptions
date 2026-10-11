import { describe, expect, it } from 'vitest';
import { CheckoutKind, Currency, ErrorCode, PaymentMethod, PaymentStatus, RefundStatus } from '../../src/constants.js';
import { createSubscriptions } from '../../src/client.js';
import { SubscriptionError } from '../../src/errors.js';
import {
  FALLBACK_PAYMENT_STATUS,
  PAYMENT_METHOD_FOR_ONE_TIME_MODE,
  PAYTM_MODES_FOR_METHOD,
  PAYTM_ONE_TIME_PAYMENT_METHODS,
  PAYTM_PAYMENT_STATUS_MAP,
} from '../../src/providers/paytm/constants.js';
import {
  CALLBACK_URL,
  CUSTOMER,
  KEY,
  MID,
  RETURN_URL,
  SALT,
  STAGING,
  STAGING_GW,
  PRODUCTION,
  PRODUCTION_GW,
  independentSign,
  makeProvider,
  reply,
  sent,
  signForm,
} from './helpers.js';

/*
 * Fixtures are the sample payloads of Paytm's documentation, copied as printed with the page named. Where a sample carries
 * placeholder values (the Show Payment Page callback) only the field names are the docs'; the values are filled in. Paytm
 * publishes no merchant key, so every request signature is checked against an independent implementation and every callback
 * is signed with the test key.
 */

const INITIATE_URL = (orderId: string) => `${STAGING}/theia/api/v1/initiateTransaction?mid=${MID}&orderId=${orderId}`;
const TXN_URL = `${STAGING_GW}/v3/order/status`;
const REFUND_URL = `${STAGING_GW}/refund/apply`;

async function errorOf(promise: Promise<unknown>): Promise<SubscriptionError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SubscriptionError);
    return error as SubscriptionError;
  }
  throw new Error('expected the call to fail');
}

/** [init-txn / "RESPONSE" tab, SUCCESS], verbatim: https://www.paytmpayments.com/docs/api/initiate-transaction-api */
const INITIATE_SUCCESS = {
  head: {
    responseTimestamp: '1526969112101',
    version: 'v1',
    clientId: 'C11',
    signature: 'TXBw50YPUKIgJd8gR8RpZuOMZ+csvCT7i0/YXmG//J8+BpFdY5goPBiLAkCzKlCkOvAQip/Op5aD6Vs+cNUTjFmC55JBxvp7WunZ45Ke2q0=',
  },
  body: {
    resultInfo: { resultStatus: 'S', resultCode: '0000', resultMsg: 'Success' },
    txnToken: 'fe795335ed3049c78a57271075f2199e1526969112097',
    isPromoCodeValid: false,
    authenticated: false,
  },
};
/** [init-txn / "RESPONSE" tab, FAIL], verbatim. */
const INITIATE_FAIL = {
  head: { responseTimestamp: '1555581762193', version: 'v1' },
  body: { resultInfo: { resultStatus: 'F', resultCode: '2004', resultMsg: 'SSO Token is invalid', bankRetry: null, retry: null }, extraParamsMap: null },
};

/** [txn-status / "RESPONSE" tab, SUCCESS], verbatim: https://www.paytmpayments.com/docs/api/v3/transaction-status-api */
const TXN_SAMPLE_SUCCESS = {
  head: { responseTimestamp: '1553496322922', version: 'v1', clientId: 'C11', signature: 'xxxxx' },
  body: {
    resultInfo: { resultStatus: 'TXN_SUCCESS', resultCode: '01', resultMsg: 'Txn Success' },
    txnId: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    bankTxnId: 'xxxxxxxxxxxxxxx',
    orderId: 'xxxxxxx',
    txnAmount: '100.00',
    txnType: 'SALE',
    gatewayName: 'HDFC',
    bankName: 'HSBC',
    mid: 'xxxxxxxxxxxxxxxxxxxx',
    paymentMode: 'CC',
    refundAmt: '100.00',
    txnDate: '2019-02-20 12:35:20.0',
    authRefId: '50112883',
  },
};
/** [txn-status / "RESPONSE" tab, FAIL], verbatim. */
const TXN_SAMPLE_FAIL = {
  head: { responseTimestamp: '1553498041521', version: 'v1', clientId: 'C11', signature: null },
  body: {
    resultInfo: { resultStatus: 'TXN_FAILURE', resultCode: '334', resultMsg: 'Invalid Order Id.' },
    orderId: 'xxxxxxx',
    mid: 'xxxxxxxxxxxxxxxxxxxx',
  },
};

/** A Transaction Status answer of the documented shape for one order. */
function txn(resultStatus: string, resultCode: string, resultMsg: string, fields: Record<string, unknown> = {}) {
  return reply({
    resultInfo: { resultStatus, resultCode, resultMsg },
    txnId: '202005081112128XXXXXX68470101509706',
    bankTxnId: '77700XXXX215242',
    orderId: 'pay_ORDERID_98765',
    txnAmount: '1.00',
    txnType: 'SALE',
    gatewayName: 'HDFC',
    bankName: 'ICICI Bank',
    mid: MID,
    paymentMode: 'UPI',
    refundAmt: '0.00',
    txnDate: '2020-07-24 15:13:02.0',
    ...fields,
  });
}

const PAYMENT_INPUT = { reference: 'ORDERID_98765', amount: 100, customer: CUSTOMER };

describe('capabilities and tables', () => {
  it('declares one-time payments and the four methods Initiate Transaction can enable', () => {
    const { provider } = makeProvider();
    expect(provider.capabilities.oneTimePayments).toBe(true);
    expect(provider.capabilities.oneTimePaymentMethods).toEqual(['upi', 'card', 'netbanking', 'wallet']);
    expect(PAYTM_ONE_TIME_PAYMENT_METHODS).toEqual(provider.capabilities.oneTimePaymentMethods);
    // Subscriptions are unchanged.
    expect(provider.capabilities.paymentMethods).toEqual(['upi', 'card', 'enach']);
  });

  it('offers each one-time method as the Paytm payment modes [init-txn enablePaymentMode]', () => {
    expect(PAYTM_MODES_FOR_METHOD[PaymentMethod.Upi]).toEqual(['UPI']);
    expect(PAYTM_MODES_FOR_METHOD[PaymentMethod.Card]).toEqual(['CREDIT_CARD', 'DEBIT_CARD']);
    expect(PAYTM_MODES_FOR_METHOD[PaymentMethod.NetBanking]).toEqual(['NET_BANKING']);
    expect(PAYTM_MODES_FOR_METHOD[PaymentMethod.Wallet]).toEqual(['BALANCE']);
  });

  it('maps every documented Paytm payment status, and nothing else, to a payment status', () => {
    expect(PAYTM_PAYMENT_STATUS_MAP).toEqual({
      TXN_SUCCESS: PaymentStatus.Succeeded,
      TXN_FAILURE: PaymentStatus.Failed,
      PENDING: PaymentStatus.Pending,
    });
    expect(FALLBACK_PAYMENT_STATUS).toBe(PaymentStatus.Pending);
  });

  it('maps every documented payment mode to a method; the modes with no unified method are absent', () => {
    expect(PAYMENT_METHOD_FOR_ONE_TIME_MODE).toEqual({
      UPI: 'upi',
      UPI_INTENT: 'upi',
      CC: 'card',
      CREDIT_CARD: 'card',
      DC: 'card',
      DEBIT_CARD: 'card',
      NB: 'netbanking',
      NET_BANKING: 'netbanking',
      PPI: 'wallet',
      BALANCE: 'wallet',
    });
    for (const unmapped of ['PPBL', 'PAYTMCC', 'Paytm Postpaid', 'PAYTM_DIGITAL_CREDIT', 'EMI', 'BANK_TRANSFER']) {
      expect(PAYMENT_METHOD_FOR_ONE_TIME_MODE[unmapped]).toBeUndefined();
    }
  });
});

describe('createPayment: Initiate Transaction', () => {
  it('sends the documented request signed over the exact body, and returns the payment with the payment-page form', async () => {
    const { provider, calls } = makeProvider([{ url: INITIATE_URL('pay_ORDERID_98765'), json: INITIATE_SUCCESS }]);
    const payment = await provider.createPayment({
      ...PAYMENT_INPUT,
      description: 'Pro plan, one month',
      returnUrl: RETURN_URL,
    });

    expect(calls).toHaveLength(1);
    const request = sent(calls[0] as never);
    expect(request.url.href).toBe(INITIATE_URL('pay_ORDERID_98765'));
    expect(request.head).toEqual({ signature: independentSign(request.sentBodyText, KEY, SALT) });
    // The sample request of the docs has requestType Payment, mid, websiteName, orderId, txnAmount, userInfo and callbackUrl.
    expect(request.sentBodyText).toBe(
      '{"requestType":"Payment","mid":"INTEGR7769XXXXXX9383","websiteName":"WEBSTAGING","orderId":"pay_ORDERID_98765",' +
        '"callbackUrl":"https://merchant.example/return","txnAmount":{"value":"1.00","currency":"INR"},' +
        '"userInfo":{"custId":"CUST_001","mobile":"9876543210","email":"ashish@example.com","firstName":"Ashish","lastName":"Kumar"},' +
        '"extendInfo":{"comments":"Pro plan, one month"}}',
    );

    expect(payment).toEqual({
      provider: 'paytm',
      id: 'pay_ORDERID_98765',
      reference: 'ORDERID_98765',
      status: PaymentStatus.Created,
      providerStatus: 'INITIATED',
      amount: 100,
      currency: Currency.INR,
      customer: { id: 'CUST_001', name: 'Ashish Kumar', email: 'ashish@example.com', phone: '+919876543210' },
      createdAt: '2026-11-17T05:00:00.000Z',
      checkout: {
        kind: CheckoutKind.FormPost,
        url: `${STAGING}/theia/api/v1/showPaymentPage?mid=${MID}&orderId=pay_ORDERID_98765`,
        fields: { mid: MID, orderId: 'pay_ORDERID_98765', txnToken: 'fe795335ed3049c78a57271075f2199e1526969112097' },
      },
      raw: INITIATE_SUCCESS.body,
    });
  });

  it('sends nothing the caller did not ask for: no callbackUrl, payment modes or comments by default', async () => {
    const { provider, calls } = makeProvider([{ url: INITIATE_URL('pay_ORDERID_98765'), json: INITIATE_SUCCESS }]);
    await provider.createPayment(PAYMENT_INPUT);
    expect(sent(calls[0] as never).body).toEqual({
      requestType: 'Payment',
      mid: MID,
      websiteName: 'WEBSTAGING',
      orderId: 'pay_ORDERID_98765',
      txnAmount: { value: '1.00', currency: 'INR' },
      userInfo: { custId: 'CUST_001', mobile: '9876543210', email: 'ashish@example.com', firstName: 'Ashish', lastName: 'Kumar' },
    });
  });

  it('uses the configured callbackUrl unless the payment has a returnUrl', async () => {
    const configured = makeProvider([{ url: INITIATE_URL('pay_ORDERID_98765'), json: INITIATE_SUCCESS }], { callbackUrl: CALLBACK_URL });
    await configured.provider.createPayment(PAYMENT_INPUT);
    expect(sent(configured.calls[0] as never).body.callbackUrl).toBe(CALLBACK_URL);
    const overridden = makeProvider([{ url: INITIATE_URL('pay_ORDERID_98765'), json: INITIATE_SUCCESS }], { callbackUrl: CALLBACK_URL });
    await overridden.provider.createPayment({ ...PAYMENT_INPUT, returnUrl: RETURN_URL });
    expect(sent(overridden.calls[0] as never).body.callbackUrl).toBe(RETURN_URL);
  });

  it('goes to the production host with the production website name', async () => {
    const { provider, calls } = makeProvider(
      [{ url: `${PRODUCTION}/theia/api/v1/initiateTransaction?mid=${MID}&orderId=pay_ORDERID_98765`, json: INITIATE_SUCCESS }],
      { environment: 'live', website: 'DEFAULT' },
    );
    const payment = await provider.createPayment(PAYMENT_INPUT);
    expect(sent(calls[0] as never).body.websiteName).toBe('DEFAULT');
    expect(payment.checkout).toMatchObject({ url: `${PRODUCTION}/theia/api/v1/showPaymentPage?mid=${MID}&orderId=pay_ORDERID_98765` });
  });

  it('puts the order id under pay_: a generated one when there is no reference, the reference after the prefix otherwise', async () => {
    const generated = makeProvider([{ url: INITIATE_URL('pay_gen1'), json: INITIATE_SUCCESS }]);
    const payment = await generated.provider.createPayment({ amount: 100, customer: CUSTOMER });
    expect(payment).toMatchObject({ id: 'pay_gen1', reference: 'gen1' });
    expect(sent(generated.calls[0] as never).body.orderId).toBe('pay_gen1');
    // A customer without an id gets a custId derived from the order id.
    const anonymous = makeProvider([{ url: INITIATE_URL('pay_gen1'), json: INITIATE_SUCCESS }]);
    await anonymous.provider.createPayment({ amount: 100, customer: { email: 'a@example.com' } });
    expect((sent(anonymous.calls[0] as never).body.userInfo as { custId: string }).custId).toMatch(/^cust_[0-9a-f]{24}$/);
  });

  it('limits the payment page to the requested methods: one Paytm mode for UPI, net banking and wallet, two for cards', async () => {
    const { provider, calls } = makeProvider([{ url: INITIATE_URL('pay_ORDERID_98765'), json: INITIATE_SUCCESS }]);
    await provider.createPayment({
      ...PAYMENT_INPUT,
      paymentMethods: [PaymentMethod.Upi, PaymentMethod.Card, PaymentMethod.NetBanking, PaymentMethod.Wallet],
    });
    expect(sent(calls[0] as never).body.enablePaymentMode).toEqual([
      { mode: 'UPI' },
      { mode: 'CREDIT_CARD' },
      { mode: 'DEBIT_CARD' },
      { mode: 'NET_BANKING' },
      { mode: 'BALANCE' },
    ]);
  });

  it.each([
    ['expiresAt', { expiresAt: '2026-11-18T00:00:00.000Z' }, /expiresAt/],
    ['metadata', { metadata: { cart: '42' } }, /metadata/],
  ])('refuses %s with UNSUPPORTED instead of dropping it, before any request', async (_name, extra, message) => {
    const { provider, calls } = makeProvider();
    const error = await errorOf(provider.createPayment({ ...PAYMENT_INPUT, ...extra }));
    expect(error.code).toBe(ErrorCode.Unsupported);
    expect(error.message).toMatch(message);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['enach', { paymentMethods: [PaymentMethod.Upi, PaymentMethod.ENach] }],
    ['physical_nach', { paymentMethods: [PaymentMethod.PhysicalNach] }],
    ['a reference that makes the order id longer than 50 characters', { reference: 'r'.repeat(47) }],
    ['a reference with a character Paytm does not allow in an order id', { reference: 'order 1' }],
    ['a "|" in the description', { description: 'a|b' }],
    ['a phone number that is not a 10-digit mobile', { customer: { ...CUSTOMER, phone: '+9112345' } }],
  ])('refuses %s with VALIDATION, before any request', async (_name, extra) => {
    const { provider, calls } = makeProvider();
    const error = await errorOf(provider.createPayment({ ...PAYMENT_INPUT, ...extra } as never));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(calls).toHaveLength(0);
  });

  it('accepts a reference that makes the order id exactly 50 characters', async () => {
    const reference = 'r'.repeat(46);
    const { provider } = makeProvider([{ url: INITIATE_URL(`pay_${reference}`), json: INITIATE_SUCCESS }]);
    expect((await provider.createPayment({ ...PAYMENT_INPUT, reference })).id).toBe(`pay_${reference}`);
  });

  it('accepts "Success Idempotent" (0002) for a repeated request', async () => {
    const idempotent = reply({
      resultInfo: { resultStatus: 'S', resultCode: '0002', resultMsg: 'Success Idempotent' },
      txnToken: 'f0bed899539742309eebd8XXXX7edcf61588842333227',
    });
    const { provider } = makeProvider([{ url: INITIATE_URL('pay_ORDERID_98765'), json: idempotent }]);
    const payment = await provider.createPayment(PAYMENT_INPUT);
    expect(payment.checkout).toMatchObject({ fields: { txnToken: 'f0bed899539742309eebd8XXXX7edcf61588842333227' } });
  });

  it.each([
    ['196', 'F', 'Payment failed as amount entered exceeds the allowed limit.', ErrorCode.Validation],
    ['1007', 'F', 'Missing mandatory element', ErrorCode.Validation],
    ['1008', 'F', 'Pipe character is not allowed', ErrorCode.Validation],
    ['2004', 'F', 'SSO Token is invalid', ErrorCode.Validation],
    ['2005', 'F', 'Checksum provided is invalid', ErrorCode.Auth],
    ['2007', 'F', 'Txn amount is invalid', ErrorCode.Validation],
    ['2023', 'F', 'Repeat Request Inconsistent', ErrorCode.Conflict],
    ['1006', 'F', 'Your Session has expired', ErrorCode.ProviderError],
    ['9999', 'F', 'a code the page does not list', ErrorCode.ProviderError],
    ['00000900', 'U', 'System error', ErrorCode.OutcomeUnknown],
  ])('Initiate Transaction code %s (%s, "%s") is %s', async (code, status, message, expected) => {
    const { provider } = makeProvider([
      { url: INITIATE_URL('pay_ORDERID_98765'), json: reply({ resultInfo: { resultStatus: status, resultCode: code, resultMsg: message } }) },
    ]);
    const error = await errorOf(provider.createPayment(PAYMENT_INPUT));
    expect(error.code).toBe(expected);
    expect(error.providerCode).toBe(code);
  });

  it('turns the docs\' failure sample into an error that quotes Paytm', async () => {
    const { provider } = makeProvider([{ url: INITIATE_URL('pay_ORDERID_98765'), json: INITIATE_FAIL }]);
    const error = await errorOf(provider.createPayment(PAYMENT_INPUT));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(error.message).toContain('SSO Token is invalid');
  });

  it('a request that gets no answer, and an answer with no verdict, are OUTCOME_UNKNOWN: the order may exist', async () => {
    const dropped = makeProvider([{ url: INITIATE_URL('pay_ORDERID_98765'), networkError: true }]);
    expect((await errorOf(dropped.provider.createPayment(PAYMENT_INPUT))).code).toBe(ErrorCode.OutcomeUnknown);
    const silent = makeProvider([{ url: INITIATE_URL('pay_ORDERID_98765'), json: reply({}) }]);
    expect((await errorOf(silent.provider.createPayment(PAYMENT_INPUT))).code).toBe(ErrorCode.OutcomeUnknown);
  });

  it('a success without a txnToken is UNEXPECTED_RESPONSE and names the order id to look up', async () => {
    const { provider } = makeProvider([
      { url: INITIATE_URL('pay_ORDERID_98765'), json: reply({ resultInfo: { resultStatus: 'S', resultCode: '0000', resultMsg: 'Success' } }) },
    ]);
    const error = await errorOf(provider.createPayment(PAYMENT_INPUT));
    expect(error.code).toBe(ErrorCode.UnexpectedResponse);
    expect(error.message).toContain('pay_ORDERID_98765');
  });

  it('never puts the merchant key in the result or in an error', async () => {
    const ok = makeProvider([{ url: INITIATE_URL('pay_ORDERID_98765'), json: INITIATE_SUCCESS }]);
    expect(JSON.stringify(await ok.provider.createPayment(PAYMENT_INPUT))).not.toContain(KEY);
    const bad = makeProvider([{ url: INITIATE_URL('pay_ORDERID_98765'), json: INITIATE_FAIL }]);
    expect(JSON.stringify(await errorOf(bad.provider.createPayment(PAYMENT_INPUT)))).not.toContain(KEY);
  });

  it('refuses a subscription reference or a debit id that starts with pay_: that prefix is reserved for one-time payments', async () => {
    const { provider, calls } = makeProvider();
    const subscription = await errorOf(
      provider.createSubscription({ plan: { name: 'Pro', amount: 49900, interval: { unit: 'month', count: 1 } }, customer: CUSTOMER, reference: 'pay_123' }),
    );
    expect(subscription.code).toBe(ErrorCode.Validation);
    expect(subscription.message).toContain('pay_');
    const charge = await errorOf(provider.createCharge({ subscriptionId: '130010', chargeId: 'pay_c1', amount: 49900 }));
    expect(charge.code).toBe(ErrorCode.Validation);
    expect(calls).toHaveLength(0);
  });
});

describe('getPayment: Transaction Status', () => {
  it('sends the documented request and reads the docs\' success sample (a payment of 100.00 with refundAmt 100.00 is refunded)', async () => {
    const { provider, calls } = makeProvider([{ url: TXN_URL, json: TXN_SAMPLE_SUCCESS }]);
    const payment = await provider.getPayment('pay_ORDERID_98765');
    const request = sent(calls[0] as never);
    expect(request.url.href).toBe(TXN_URL);
    expect(request.sentBodyText).toBe('{"mid":"INTEGR7769XXXXXX9383","orderId":"pay_ORDERID_98765"}');
    expect(request.head).toEqual({ signature: independentSign(request.sentBodyText, KEY, SALT) });
    expect(payment).toEqual({
      provider: 'paytm',
      id: 'pay_ORDERID_98765',
      reference: 'ORDERID_98765',
      status: PaymentStatus.Refunded,
      providerStatus: 'TXN_SUCCESS',
      amount: 10000,
      currency: 'INR',
      refundedAmount: 10000,
      paymentMethod: PaymentMethod.Card,
      paidAt: '2019-02-20T07:05:20.000Z',
      raw: TXN_SAMPLE_SUCCESS.body,
    });
  });

  it('TXN_SUCCESS without a refund is succeeded, with the amount in paise and paidAt in IST', async () => {
    const { provider } = makeProvider([{ url: TXN_URL, json: txn('TXN_SUCCESS', '01', 'Txn Success') }]);
    expect(await provider.getPayment('pay_ORDERID_98765')).toMatchObject({
      status: PaymentStatus.Succeeded,
      providerStatus: 'TXN_SUCCESS',
      amount: 100,
      paymentMethod: PaymentMethod.Upi,
      paidAt: '2020-07-24T09:43:02.000Z',
    });
  });

  it('TXN_SUCCESS with a part of the amount refunded is partially_refunded', async () => {
    const { provider } = makeProvider([{ url: TXN_URL, json: txn('TXN_SUCCESS', '01', 'Txn Success', { txnAmount: '10.00', refundAmt: '2.50' }) }]);
    expect(await provider.getPayment('pay_ORDERID_98765')).toMatchObject({
      status: PaymentStatus.PartiallyRefunded,
      amount: 1000,
      refundedAmount: 250,
    });
  });

  it.each([
    ['TXN_FAILURE', '227', 'Your payment has been declined by your bank. Please contact your bank for any queries.', PaymentStatus.Failed],
    ['TXN_FAILURE', '235', 'Wallet balance Insufficient, bankName=WALLET', PaymentStatus.Failed],
    ['TXN_FAILURE', '295', 'Your payment failed as the UPI ID entered is incorrect.', PaymentStatus.Failed],
    ['TXN_FAILURE', '401', 'Your payment has been declined by your bank.', PaymentStatus.Failed],
    ['TXN_FAILURE', '810', 'Txn Failed', PaymentStatus.Failed],
    ['PENDING', '400', 'Transaction status not confirmed yet.', PaymentStatus.Pending],
    ['PENDING', '402', 'Looks like the payment is not complete. Please wait while we confirm the status with your bank.', PaymentStatus.Pending],
    ['A_STATUS_PAYTM_ADDS_LATER', '999', 'new', PaymentStatus.Pending],
  ])('status %s with code %s is %s, and the status stays visible verbatim', async (status, code, message, expected) => {
    const { provider } = makeProvider([{ url: TXN_URL, json: txn(status, code, message) }]);
    const payment = await provider.getPayment('pay_ORDERID_98765');
    expect(payment.status).toBe(expected);
    expect(payment.providerStatus).toBe(status);
    expect(payment.paidAt).toBeUndefined();
    if (expected === PaymentStatus.Failed) {
      expect(payment).toMatchObject({ failureCode: code, failureReason: message });
    } else {
      expect(payment.failureCode).toBeUndefined();
    }
  });

  it('a status that is missing is pending too, with a placeholder providerStatus', async () => {
    const { provider } = makeProvider([{ url: TXN_URL, json: reply({ resultInfo: { resultCode: '400' }, orderId: 'pay_ORDERID_98765', txnAmount: '1.00' }) }]);
    expect(await provider.getPayment('pay_ORDERID_98765')).toMatchObject({ status: PaymentStatus.Pending, providerStatus: 'UNKNOWN' });
  });

  it.each([
    ['PPI', PaymentMethod.Wallet],
    ['UPI', PaymentMethod.Upi],
    ['CC', PaymentMethod.Card],
    ['DC', PaymentMethod.Card],
    ['NB', PaymentMethod.NetBanking],
    ['PPBL', undefined],
    ['PAYTMCC', undefined],
    ['EMI', undefined],
  ])('payment mode %s is %s', async (mode, method) => {
    const { provider } = makeProvider([{ url: TXN_URL, json: txn('TXN_SUCCESS', '01', 'Txn Success', { paymentMode: mode }) }]);
    expect((await provider.getPayment('pay_ORDERID_98765')).paymentMethod).toBe(method);
  });

  it('NO_RECORD_FOUND (331) and the docs\' failure sample (334 Invalid Order ID) are NOT_FOUND', async () => {
    const none = makeProvider([{ url: TXN_URL, json: reply({ resultInfo: { resultStatus: 'NO_RECORD_FOUND', resultCode: '331', resultMsg: 'No Record Found' } }) }]);
    expect((await errorOf(none.provider.getPayment('pay_ORDERID_98765'))).code).toBe(ErrorCode.NotFound);
    const invalid = makeProvider([{ url: TXN_URL, json: TXN_SAMPLE_FAIL }]);
    const error = await errorOf(invalid.provider.getPayment('pay_ORDERID_98765'));
    expect(error.code).toBe(ErrorCode.NotFound);
    expect(error.providerCode).toBe('334');
  });

  it('a wrong merchant id and "Server Down" are errors, never a failed payment', async () => {
    const mid = makeProvider([{ url: TXN_URL, json: reply({ resultInfo: { resultStatus: 'TXN_FAILURE', resultCode: '335', resultMsg: 'Mid is invalid' } }) }]);
    expect((await errorOf(mid.provider.getPayment('pay_ORDERID_98765'))).code).toBe(ErrorCode.Config);
    const down = makeProvider([{ url: TXN_URL, json: reply({ resultInfo: { resultStatus: 'TXN_FAILURE', resultCode: '501', resultMsg: 'Server Down' } }) }]);
    expect((await errorOf(down.provider.getPayment('pay_ORDERID_98765'))).code).toBe(ErrorCode.ProviderUnavailable);
  });

  it('an answer with no amount cannot become a payment: UNEXPECTED_RESPONSE', async () => {
    const { provider } = makeProvider([{ url: TXN_URL, json: reply({ resultInfo: { resultStatus: 'PENDING', resultCode: '400', resultMsg: 'x' } }) }]);
    expect((await errorOf(provider.getPayment('pay_ORDERID_98765'))).code).toBe(ErrorCode.UnexpectedResponse);
  });

  it('accepts only the ids createPayment returns: any other order id is VALIDATION, with no request', async () => {
    const { provider, calls } = makeProvider();
    for (const id of ['ORDERID_98765', 'sub_abc', 'pay_', '']) {
      expect((await errorOf(provider.getPayment(id))).code).toBe(ErrorCode.Validation);
    }
    expect(calls).toHaveLength(0);
  });

  it('reads the status API host of its own page (securegw-stage.paytmpayments.in, securegw.paytmpayments.in in production)', async () => {
    const { provider, calls } = makeProvider([{ url: `${PRODUCTION_GW}/v3/order/status`, json: txn('TXN_SUCCESS', '01', 'Txn Success') }], { environment: 'live' });
    await provider.getPayment('pay_ORDERID_98765');
    expect(calls[0]?.url).toBe(`${PRODUCTION_GW}/v3/order/status`);
  });
});

describe('verifyPayment: the callback and Transaction Status', () => {
  /** The key-value post of the Show Payment Page page [spp], field names as printed, values filled in. */
  const CALLBACK: Record<string, string> = {
    CURRENCY: 'INR',
    GATEWAYNAME: 'HDFC',
    RESPMSG: 'Txn Success',
    BANKNAME: 'HSBC',
    PAYMENTMODE: 'CC',
    MID: MID,
    RESPCODE: '01',
    TXNID: '202005081112128XXXXXX68470101509706',
    TXNAMOUNT: '1.00',
    ORDERID: 'pay_ORDERID_98765',
    STATUS: 'TXN_SUCCESS',
    BANKTXNID: '777001087423130',
    TXNDATE: '2015-11-02 11:40:46.0',
  };

  it('checks the CHECKSUMHASH over the other fields, then reads Transaction Status: paid comes from the status API', async () => {
    const { provider, calls } = makeProvider([{ url: TXN_URL, json: txn('TXN_SUCCESS', '01', 'Txn Success', { paymentMode: 'CC' }) }]);
    const verification = await provider.verifyPayment(signForm(CALLBACK));
    expect(calls).toHaveLength(1);
    expect(sent(calls[0] as never).body).toEqual({ mid: MID, orderId: 'pay_ORDERID_98765' });
    expect(verification).toMatchObject({
      provider: 'paytm',
      paymentId: 'pay_ORDERID_98765',
      reference: 'ORDERID_98765',
      paid: true,
      status: PaymentStatus.Succeeded,
      payment: { id: 'pay_ORDERID_98765', status: PaymentStatus.Succeeded, amount: 100, paymentMethod: PaymentMethod.Card },
      raw: { callback: signForm(CALLBACK) },
    });
  });

  it('a callback that says TXN_SUCCESS while Paytm still reports PENDING is not paid yet', async () => {
    const { provider } = makeProvider([{ url: TXN_URL, json: txn('PENDING', '402', 'Looks like the payment is not complete.') }]);
    const verification = await provider.verifyPayment(signForm(CALLBACK));
    expect(verification).toMatchObject({ paid: false, status: PaymentStatus.Pending });
  });

  it('a callback that says TXN_FAILURE while Paytm reports TXN_SUCCESS is paid: the status API decides', async () => {
    const { provider } = makeProvider([{ url: TXN_URL, json: txn('TXN_SUCCESS', '01', 'Txn Success') }]);
    const verification = await provider.verifyPayment(signForm({ ...CALLBACK, STATUS: 'TXN_FAILURE', RESPCODE: '227' }));
    expect(verification.paid).toBe(true);
  });

  it('a failed payment is not paid, and carries Paytm\'s failure code', async () => {
    const { provider } = makeProvider([{ url: TXN_URL, json: txn('TXN_FAILURE', '227', 'Your payment has been declined by your bank.') }]);
    const verification = await provider.verifyPayment(signForm({ ...CALLBACK, STATUS: 'TXN_FAILURE', RESPCODE: '227' }));
    expect(verification).toMatchObject({ paid: false, status: PaymentStatus.Failed, payment: { failureCode: '227' } });
  });

  it('a payment that is paid and has been refunded since is still paid', async () => {
    const { provider } = makeProvider([{ url: TXN_URL, json: txn('TXN_SUCCESS', '01', 'Txn Success', { refundAmt: '1.00' }) }]);
    expect(await provider.verifyPayment(signForm(CALLBACK))).toMatchObject({ paid: true, status: PaymentStatus.Refunded });
  });

  it('uses the callback\'s TXNAMOUNT when Transaction Status leaves the amount out', async () => {
    const { provider } = makeProvider([
      { url: TXN_URL, json: reply({ resultInfo: { resultStatus: 'TXN_FAILURE', resultCode: '227', resultMsg: 'declined' }, orderId: 'pay_ORDERID_98765' }) },
    ]);
    expect((await provider.verifyPayment(signForm({ ...CALLBACK, STATUS: 'TXN_FAILURE' }))).payment?.amount).toBe(100);
  });

  it('puts back a "+" that a form decoder turned into a space in the checksum', async () => {
    const signed = signForm(CALLBACK);
    const { provider } = makeProvider([{ url: TXN_URL, json: txn('TXN_SUCCESS', '01', 'Txn Success') }]);
    const damaged = { ...signed, CHECKSUMHASH: (signed.CHECKSUMHASH as string).replace(/\+/g, ' ') };
    expect((await provider.verifyPayment(damaged)).paid).toBe(true);
  });

  it.each([
    ['a changed amount', (fields: Record<string, string>) => ({ ...fields, TXNAMOUNT: '0.01' })],
    ['a changed status', (fields: Record<string, string>) => ({ ...fields, STATUS: 'TXN_FAILURE' })],
    ['an added field', (fields: Record<string, string>) => ({ ...fields, EXTRA: 'x' })],
    ['a removed field', (fields: Record<string, string>) => Object.fromEntries(Object.entries(fields).filter(([name]) => name !== 'BANKNAME'))],
    ['no checksum', (fields: Record<string, string>) => Object.fromEntries(Object.entries(fields).filter(([name]) => name !== 'CHECKSUMHASH'))],
    ['an empty checksum', (fields: Record<string, string>) => ({ ...fields, CHECKSUMHASH: '' })],
    ['a checksum made with another key', () => signForm(CALLBACK, 'zzzzzzzzzzzzzzzz')],
    ['a checksum of other text', (fields: Record<string, string>) => ({ ...fields, CHECKSUMHASH: independentSign('{}', KEY) })],
  ])('%s is SIGNATURE_INVALID, and nothing is read from the result or sent to Paytm', async (_name, tamper) => {
    const { provider, calls } = makeProvider();
    const error = await errorOf(provider.verifyPayment(tamper(signForm(CALLBACK))));
    expect(error.code).toBe(ErrorCode.SignatureInvalid);
    expect(calls).toHaveLength(0);
  });

  it('a field that is not text is VALIDATION: it cannot have been signed', async () => {
    const { provider } = makeProvider();
    const error = await errorOf(provider.verifyPayment({ ...signForm(CALLBACK), TXNAMOUNT: 1 } as never));
    expect(error.code).toBe(ErrorCode.Validation);
  });

  it('a genuine callback of an order that is not a one-time payment is VALIDATION: it belongs to verifyCheckout', async () => {
    const { provider, calls } = makeProvider();
    const error = await errorOf(provider.verifyPayment(signForm({ ...CALLBACK, ORDERID: 'sub_abc', SUBS_ID: '130010' })));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(calls).toHaveLength(0);
  });

  it('a callback with no ORDERID is rejected', async () => {
    const { provider } = makeProvider();
    const { ORDERID: _omitted, ...withoutOrder } = CALLBACK;
    expect((await errorOf(provider.verifyPayment(signForm(withoutOrder)))).code).toBe(ErrorCode.Validation);
  });

  it('Transaction Status that cannot be read is an error, not a guess: the payment is not confirmed', async () => {
    const { provider } = makeProvider([{ url: TXN_URL, networkError: true }]);
    const error = await errorOf(provider.verifyPayment(signForm(CALLBACK)));
    expect([ErrorCode.Network, ErrorCode.Timeout, ErrorCode.ProviderUnavailable]).toContain(error.code);
    const unknown = makeProvider([{ url: TXN_URL, json: reply({ resultInfo: { resultStatus: 'NO_RECORD_FOUND', resultCode: '331', resultMsg: 'No Record Found' } }) }]);
    expect((await errorOf(unknown.provider.verifyPayment(signForm(CALLBACK)))).code).toBe(ErrorCode.NotFound);
  });
});

describe('refundPayment: the Refund API', () => {
  /** [refund / "RESPONSE" tab, SUCCESS], verbatim: https://www.paytmpayments.com/docs/api/refund-api */
  const REFUND_PENDING = {
    head: {
      responseTimestamp: '1567421120859',
      signature: 'WaFdplm36GmfBtZ6jPIFClLSEffhAk9fTpJ6i8WpgqiZvtUNl53mLL7mu4JWwxPpfSa5pdexyxK/68WtoTmd53TI+R9GffjGc3USoLgWcKI=',
      version: 'v1',
    },
    body: {
      txnTimestamp: '2019-09-02 12:31:49.0',
      orderId: 'YOUR_ORDER_ID',
      mid: 'YOUR_MID_HERE',
      refId: 'UNIQUE_REFUND_ID',
      resultInfo: { resultStatus: 'PENDING', resultCode: '601', resultMsg: 'Refund request was raised for this transaction. But it is pending state' },
      refundId: 'PAYTM_REFUND_ID',
      txnId: 'PAYTM_TRANSACTION_ID',
      refundAmount: '1.00',
    },
  };
  /** [refund / "RESPONSE" tab, FAIL], verbatim. */
  const REFUND_FAIL = {
    head: {
      responseTimestamp: '1567421388384',
      signature: 'ry2bNQ+iq+geNezbFNBfIkXXWTFPUnavG6XkxciEJUNLmL7Op9S7qWP8V1TGHNYvggw2IsIt1OmprSfq92pODO5xiNJ+6pFyVtBUxnRrdL8=',
      version: 'v1',
    },
    body: {
      orderId: 'YOUR_ORDER_ID',
      mid: 'YOUR_MID_HERE',
      resultInfo: { resultStatus: 'TXN_FAILURE', resultCode: '607', resultMsg: 'Refund can not be initiated for a cancelled transaction.' },
      txnId: 'PAYTM_TRANSACTION_ID',
      refundAmount: '1.00',
    },
  };

  const PAID = () => txn('TXN_SUCCESS', '01', 'Txn Success', { txnAmount: '10.00' });

  it('reads the transaction, then sends the documented refund request: refId is refundId, orderId is the payment id, txnId is Paytm\'s', async () => {
    const { provider, calls } = makeProvider([
      { url: TXN_URL, json: PAID() },
      { url: REFUND_URL, json: REFUND_PENDING },
    ]);
    const refund = await provider.refundPayment({ paymentId: 'pay_ORDERID_98765', refundId: 'REFUNDID_98765', reason: 'Customer cancelled' });
    expect(calls).toHaveLength(2);
    const request = sent(calls[1] as never);
    expect(request.url.href).toBe(REFUND_URL);
    expect(request.sentBodyText).toBe(
      '{"mid":"INTEGR7769XXXXXX9383","txnType":"REFUND","orderId":"pay_ORDERID_98765","txnId":"202005081112128XXXXXX68470101509706","refId":"REFUNDID_98765","refundAmount":"10.00","comments":"Customer cancelled"}',
    );
    expect(request.head).toEqual({ signature: independentSign(request.sentBodyText, KEY, SALT) });
    // The refund is for the whole payment, is asynchronous (601 PENDING), and names the payment twice, as the contract says.
    expect(refund).toEqual({
      provider: 'paytm',
      id: 'PAYTM_REFUND_ID',
      reference: 'REFUNDID_98765',
      chargeId: 'pay_ORDERID_98765',
      paymentId: 'pay_ORDERID_98765',
      status: RefundStatus.Pending,
      providerStatus: 'PENDING',
      amount: 100,
      currency: 'INR',
      createdAt: '2019-09-02T07:01:49.000Z',
      raw: REFUND_PENDING.body,
    });
  });

  it('refunds part of the payment when asked, and refuses more than was paid', async () => {
    const part = makeProvider([
      { url: TXN_URL, json: PAID() },
      { url: REFUND_URL, json: REFUND_PENDING },
    ]);
    await part.provider.refundPayment({ paymentId: 'pay_ORDERID_98765', refundId: 'r1', amount: 250 });
    expect(sent(part.calls[1] as never).body).toMatchObject({ refundAmount: '2.50' });

    const more = makeProvider([{ url: TXN_URL, json: PAID() }]);
    const error = await errorOf(more.provider.refundPayment({ paymentId: 'pay_ORDERID_98765', refundId: 'r1', amount: 1001 }));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(more.calls).toHaveLength(1);
  });

  it.each([
    ['PENDING', '402'],
    ['TXN_FAILURE', '227'],
  ])('a payment Paytm reports as %s cannot be refunded: VALIDATION, and no refund request is sent', async (status, code) => {
    const { provider, calls } = makeProvider([{ url: TXN_URL, json: txn(status, code, 'not paid') }]);
    const error = await errorOf(provider.refundPayment({ paymentId: 'pay_ORDERID_98765', refundId: 'r1' }));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(calls).toHaveLength(1);
  });

  it('a refund Paytm says is final is succeeded; the docs\' failure sample (607) is a VALIDATION error quoting Paytm', async () => {
    const done = makeProvider([
      { url: TXN_URL, json: PAID() },
      { url: REFUND_URL, json: reply({ ...REFUND_PENDING.body, resultInfo: { resultStatus: 'TXN_SUCCESS', resultCode: '10', resultMsg: 'Refund Successfull' } }) },
    ]);
    expect((await done.provider.refundPayment({ paymentId: 'pay_ORDERID_98765', refundId: 'r1' })).status).toBe(RefundStatus.Succeeded);

    const failed = makeProvider([
      { url: TXN_URL, json: PAID() },
      { url: REFUND_URL, json: REFUND_FAIL },
    ]);
    const error = await errorOf(failed.provider.refundPayment({ paymentId: 'pay_ORDERID_98765', refundId: 'r1' }));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(error.providerCode).toBe('607');
    expect(error.message).toContain('cancelled transaction');
  });

  it.each([
    ['617', 'Refund Already Raised', ErrorCode.Conflict],
    ['629', 'Refund is already Successful', ErrorCode.Conflict],
    ['635', 'Partial Refund under Rupee 1 is not allowed', ErrorCode.Validation],
    ['636', 'Refund not allowed on orders older than 1 Year.', ErrorCode.Validation],
    ['659', 'Refund amount is greater than the allowed limit on this transaction', ErrorCode.Validation],
  ])('refund code %s ("%s") is %s', async (code, message, expected) => {
    const { provider } = makeProvider([
      { url: TXN_URL, json: PAID() },
      { url: REFUND_URL, json: reply({ resultInfo: { resultStatus: 'TXN_FAILURE', resultCode: code, resultMsg: message } }) },
    ]);
    expect((await errorOf(provider.refundPayment({ paymentId: 'pay_ORDERID_98765', refundId: 'r1' }))).code).toBe(expected);
  });

  it('a refund whose answer is lost is OUTCOME_UNKNOWN: repeating it with the same refundId is safe at Paytm', async () => {
    const { provider } = makeProvider([
      { url: TXN_URL, json: PAID() },
      { url: REFUND_URL, networkError: true },
    ]);
    expect((await errorOf(provider.refundPayment({ paymentId: 'pay_ORDERID_98765', refundId: 'r1' }))).code).toBe(ErrorCode.OutcomeUnknown);
  });

  it('accepts only the ids createPayment returns, with no request', async () => {
    const { provider, calls } = makeProvider();
    expect((await errorOf(provider.refundPayment({ paymentId: 'ORDERID_98765', refundId: 'r1' }))).code).toBe(ErrorCode.Validation);
    expect(calls).toHaveLength(0);
  });

  it('refunding a debit with refundCharge is unchanged: no paymentId on the refund', async () => {
    const { provider } = makeProvider([
      { url: TXN_URL, json: txn('TXN_SUCCESS', '01', 'Txn Success', { orderId: 'c_1' }) },
      { url: REFUND_URL, json: REFUND_PENDING },
    ]);
    const refund = await provider.refundCharge({ chargeId: 'c_1', refundId: 'r1' });
    expect(refund.chargeId).toBe('c_1');
    expect(refund.paymentId).toBeUndefined();
  });
});

describe('through the facade', () => {
  const CALLBACK = signForm({
    CURRENCY: 'INR',
    GATEWAYNAME: 'HDFC',
    RESPMSG: 'Txn Success',
    PAYMENTMODE: 'CC',
    MID,
    RESPCODE: '01',
    TXNID: '202005081112128XXXXXX68470101509706',
    TXNAMOUNT: '1.00',
    ORDERID: 'pay_ORDERID_98765',
    STATUS: 'TXN_SUCCESS',
    TXNDATE: '2015-11-02 11:40:46.0',
  });

  it('subs.payments creates, verifies against the id or the reference, refuses another payment\'s result, and refunds', async () => {
    const { provider } = makeProvider([
      { url: INITIATE_URL('pay_ORDERID_98765'), json: INITIATE_SUCCESS },
      { url: TXN_URL, json: txn('TXN_SUCCESS', '01', 'Txn Success', { paymentMode: 'CC' }) },
      { url: TXN_URL, json: txn('TXN_SUCCESS', '01', 'Txn Success', { paymentMode: 'CC' }) },
      { url: TXN_URL, json: txn('TXN_SUCCESS', '01', 'Txn Success', { paymentMode: 'CC' }) },
      { url: TXN_URL, json: txn('TXN_SUCCESS', '01', 'Txn Success', { txnAmount: '10.00' }) },
      { url: REFUND_URL, json: reply({ resultInfo: { resultStatus: 'PENDING', resultCode: '601', resultMsg: 'pending' }, refundId: 'R1', refundAmount: '10.00' }) },
    ]);
    const subs = createSubscriptions({ providers: [provider] });
    const payment = await subs.payments.create('paytm', PAYMENT_INPUT);
    expect(payment.id).toBe('pay_ORDERID_98765');

    expect((await subs.payments.verify('paytm', CALLBACK, { expectedPaymentId: payment.id })).paid).toBe(true);
    expect((await subs.payments.verify('paytm', CALLBACK, { expectedPaymentId: 'ORDERID_98765' })).paid).toBe(true);
    expect((await errorOf(subs.payments.verify('paytm', CALLBACK, { expectedPaymentId: 'pay_OTHER' }))).code).toBe(ErrorCode.SignatureInvalid);

    const refund = await subs.payments.refund('paytm', { paymentId: payment.id, refundId: 'rf_1' });
    expect(refund).toMatchObject({ chargeId: payment.id, paymentId: payment.id, status: RefundStatus.Pending });
  });
});
