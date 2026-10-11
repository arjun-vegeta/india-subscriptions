import { describe, expect, it } from 'vitest';
import { ChargeStatus, ErrorCode, EventType, PaymentMethod, PaymentStatus, RefundStatus } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import { PAYMENT_EVENT_MAP_ONE_TIME, PAYTM_PAYMENT_ORDER_PREFIX } from '../../src/providers/paytm/constants.js';
import { KEY, formBody, independentSign, makeProvider, signForm, webhookRequest } from './helpers.js';

const { provider } = makeProvider([]);

function parse(rawBody: string) {
  return provider.parseWebhook(webhookRequest(rawBody));
}

function parseForm(fields: Record<string, string>, key = KEY) {
  return parse(formBody(signForm(fields, key)));
}

function failure(run: () => unknown): SubscriptionError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SubscriptionError);
    return error as SubscriptionError;
  }
  throw new Error('expected the call to fail');
}

/*
 * Field values are the samples of https://www.paytmpayments.com/docs/payment-status (Payment Status, "Wallet", "Net Banking",
 * "New card", "EMI" and "UPI Collect" tabs), https://www.paytmpayments.com/docs/accept-refund-webhook,
 * https://www.paytmpayments.com/docs/success-refund-webhook and https://www.paytmpayments.com/docs/refund-arn-notification.
 * The docs print every sample with a CHECKSUMHASH made with Paytm's own key, which cannot be reproduced, so each form here is
 * signed with the test key by the independent implementation. The samples' ORDERID is "ORDERID_98765"; for a one-time payment
 * it is "pay_ORDERID_98765", the order id this adapter creates (the Payment Status webhook of a subscription debit carries the
 * same fields, and the order id is what tells them apart).
 */

const SUBSCRIPTION_DEBIT_ORDER = 'ORDERID_98765';
const PAYMENT_ORDER = `${PAYTM_PAYMENT_ORDER_PREFIX}ORDERID_98765`;

/** [wh-payment / tab "Wallet" code blocks 1 and 2] */
const WALLET_SUCCESS: Record<string, string> = {
  ORDERID: SUBSCRIPTION_DEBIT_ORDER,
  MID: 'INTEGR7769XXXXXX9383',
  TXNID: '202005081112128XXXXXX68470101509706',
  TXNAMOUNT: '1.00',
  PAYMENTMODE: 'PPI',
  CURRENCY: 'INR',
  TXNDATE: '2020-07-24 15:13:02.0',
  STATUS: 'TXN_SUCCESS',
  RESPCODE: '01',
  RESPMSG: 'Txn Success',
  GATEWAYNAME: 'WALLET',
  BANKTXNID: '62909899',
  BANKNAME: 'WALLET',
};
const WALLET_FAILURE: Record<string, string> = {
  ...WALLET_SUCCESS,
  STATUS: 'TXN_FAILURE',
  RESPCODE: '227',
  RESPMSG: 'Your payment has been declined by your bank. Please try again or use a different method to complete the payment.',
};
/** [wh-payment / tab "Net Banking" code block 1] */
const NET_BANKING_SUCCESS: Record<string, string> = {
  ORDERID: SUBSCRIPTION_DEBIT_ORDER,
  MID: 'INTEGR7769XXXXXX9383',
  TXNID: '202005081112128XXXXXX68470101509706',
  TXNAMOUNT: '1.00',
  PAYMENTMODE: 'NB',
  CURRENCY: 'INR',
  TXNDATE: '2020-07-24 14:53:34.0',
  STATUS: 'TXN_SUCCESS',
  RESPCODE: '01',
  RESPMSG: 'Txn Success',
  GATEWAYNAME: 'SBI',
  BANKTXNID: '19180340015',
  BANKNAME: 'SBI',
};
/** [wh-payment / tab "New card" code block 1] */
const CARD_SUCCESS: Record<string, string> = {
  ORDERID: SUBSCRIPTION_DEBIT_ORDER,
  MID: 'INTEGR7769XXXXXX9383',
  TXNID: '202005081112128XXXXXX68470101509706',
  TXNAMOUNT: '1.00',
  PAYMENTMODE: 'CC',
  CURRENCY: 'INR',
  TXNDATE: '2020-07-24 15:35:33.0',
  STATUS: 'TXN_SUCCESS',
  RESPCODE: '01',
  RESPMSG: 'Txn Success',
  GATEWAYNAME: 'HDFC',
  BANKTXNID: '777001087423130',
  BANKNAME: 'JPMorgan Chase Bank',
};
/** [wh-payment / tab "EMI" code block 1] */
const EMI_SUCCESS: Record<string, string> = {
  ORDERID: SUBSCRIPTION_DEBIT_ORDER,
  MID: 'INTEGR7769XXXXXX9383',
  TXNID: '202005081112128XXXXXX68470101509706',
  TXNAMOUNT: '2000.00',
  PAYMENTMODE: 'EMI',
  CURRENCY: 'INR',
  TXNDATE: '2020-07-27 19:43:11.0',
  STATUS: 'TXN_SUCCESS',
  RESPCODE: '01',
  RESPMSG: 'Txn Success',
  GATEWAYNAME: 'HDFC',
  BANKTXNID: '777001131568358',
  BANKNAME: 'ICICI Bank',
};
/** [wh-payment / tab "UPI Collect" code blocks 1 and 2] (no BANKNAME) */
const UPI_SUCCESS: Record<string, string> = {
  ORDERID: SUBSCRIPTION_DEBIT_ORDER,
  MID: 'INTEGR7769XXXXXX9383',
  TXNID: '202005081112128XXXXXX68470101509706',
  TXNAMOUNT: '1.00',
  PAYMENTMODE: 'UPI',
  CURRENCY: 'INR',
  TXNDATE: '2020-07-28 10:14:55.0',
  STATUS: 'TXN_SUCCESS',
  RESPCODE: '01',
  RESPMSG: 'Txn Success',
  GATEWAYNAME: 'PPBLC',
  BANKTXNID: '6877266',
};

/** The sample as the webhook of a one-time payment: only the order id differs. */
function asPayment(fields: Record<string, string>): Record<string, string> {
  return { ...fields, ORDERID: PAYMENT_ORDER };
}

describe('Payment Status webhook of a one-time payment', () => {
  it('TXN_SUCCESS is payment.succeeded, with the payment built from the signed fields and no charge', () => {
    const [event] = parseForm(asPayment(WALLET_SUCCESS));
    expect(event).toMatchObject({
      provider: 'paytm',
      type: EventType.PaymentSucceeded,
      providerEventType: 'PAYMENT_STATUS:TXN_SUCCESS',
      occurredAt: '2020-07-24T09:43:02.000Z',
      paymentId: PAYMENT_ORDER,
    });
    expect(event?.charge).toBeUndefined();
    expect(event?.subscriptionId).toBeUndefined();
    expect(event?.payment).toEqual({
      provider: 'paytm',
      id: PAYMENT_ORDER,
      reference: 'ORDERID_98765',
      status: PaymentStatus.Succeeded,
      providerStatus: 'TXN_SUCCESS',
      amount: 100,
      currency: 'INR',
      paymentMethod: PaymentMethod.Wallet,
      paidAt: '2020-07-24T09:43:02.000Z',
      raw: expect.objectContaining({ TXNID: '202005081112128XXXXXX68470101509706', BANKTXNID: '62909899', RESPCODE: '01' }),
    });
  });

  it('TXN_FAILURE is payment.failed with Paytm\'s code and message, and no paidAt', () => {
    const [event] = parseForm(asPayment(WALLET_FAILURE));
    expect(event).toMatchObject({ type: EventType.PaymentFailed, providerEventType: 'PAYMENT_STATUS:TXN_FAILURE', paymentId: PAYMENT_ORDER });
    expect(event?.payment).toMatchObject({
      status: PaymentStatus.Failed,
      providerStatus: 'TXN_FAILURE',
      failureCode: '227',
      failureReason: WALLET_FAILURE.RESPMSG,
    });
    expect(event?.payment?.paidAt).toBeUndefined();
  });

  it('a status that is not final is an unknown event that still carries a pending payment', () => {
    const [event] = parseForm(asPayment({ ...WALLET_SUCCESS, STATUS: 'PENDING' }));
    expect(event).toMatchObject({ type: EventType.Unknown, providerEventType: 'PAYMENT_STATUS:PENDING', paymentId: PAYMENT_ORDER });
    expect(event?.payment?.status).toBe(PaymentStatus.Pending);
    const [later] = parseForm(asPayment({ ...WALLET_SUCCESS, STATUS: 'SOMETHING_NEW' }));
    expect(later).toMatchObject({ type: EventType.Unknown });
    expect(later?.payment).toMatchObject({ status: PaymentStatus.Pending, providerStatus: 'SOMETHING_NEW' });
  });

  it('maps every documented status to its event and payment status', () => {
    expect(PAYMENT_EVENT_MAP_ONE_TIME).toEqual({ TXN_SUCCESS: EventType.PaymentSucceeded, TXN_FAILURE: EventType.PaymentFailed });
  });

  it.each([
    ['Wallet (PPI)', WALLET_SUCCESS, PaymentMethod.Wallet, 100],
    ['Net Banking (NB)', NET_BANKING_SUCCESS, PaymentMethod.NetBanking, 100],
    ['card (CC)', CARD_SUCCESS, PaymentMethod.Card, 100],
    ['UPI Collect (UPI, no BANKNAME)', UPI_SUCCESS, PaymentMethod.Upi, 100],
    ['EMI (no unified method)', EMI_SUCCESS, undefined, 200000],
  ])('the %s sample carries the right method and amount', (_name, fields, method, amount) => {
    const [event] = parseForm(asPayment(fields));
    expect(event?.type).toBe(EventType.PaymentSucceeded);
    expect(event?.payment?.paymentMethod).toBe(method);
    expect(event?.payment?.amount).toBe(amount);
  });

  it('is told from a subscription debit by the order id alone: the same fields under another order id are subscription.charged, as before', () => {
    const [payment] = parseForm(asPayment(WALLET_SUCCESS));
    const [debit] = parseForm(WALLET_SUCCESS);
    expect(payment?.type).toBe(EventType.PaymentSucceeded);
    expect(debit).toMatchObject({ type: EventType.SubscriptionCharged, providerEventType: 'PAYMENT_STATUS:TXN_SUCCESS' });
    expect(debit?.paymentId).toBeUndefined();
    expect(debit?.payment).toBeUndefined();
    expect(debit?.charge).toMatchObject({ id: SUBSCRIPTION_DEBIT_ORDER, status: ChargeStatus.Succeeded, amount: 100 });
    const [failed] = parseForm(WALLET_FAILURE);
    expect(failed).toMatchObject({ type: EventType.SubscriptionChargeFailed });
    expect(failed?.paymentId).toBeUndefined();
  });

  it('an order id that only contains pay_, or is just the prefix, is not a one-time payment', () => {
    expect(parseForm({ ...WALLET_SUCCESS, ORDERID: 'c_pay_1' })[0]?.type).toBe(EventType.SubscriptionCharged);
    expect(parseForm({ ...WALLET_SUCCESS, ORDERID: 'pay_' })[0]?.type).toBe(EventType.SubscriptionCharged);
  });

  it('reads a flat JSON object of text fields as the same notification', () => {
    const [event] = parse(JSON.stringify(signForm(asPayment(WALLET_SUCCESS))));
    expect(event).toMatchObject({ type: EventType.PaymentSucceeded, paymentId: PAYMENT_ORDER });
  });

  it('the event id is built from the content: stable across redelivery and re-signing, different for another status', () => {
    const [first] = parse(formBody(signForm(asPayment(WALLET_SUCCESS))));
    const [again] = parse(formBody(signForm(asPayment(WALLET_SUCCESS), KEY, 'Qx9/')));
    const [other] = parseForm(asPayment(WALLET_FAILURE));
    expect(first?.id).toBe('paytm:PAYMENT_STATUS:pay_ORDERID_98765:TXN_SUCCESS:202005081112128XXXXXX68470101509706');
    expect(again?.id).toBe(first?.id);
    expect(other?.id).not.toBe(first?.id);
  });

  it.each([
    ['a changed amount', (fields: Record<string, string>) => ({ ...fields, TXNAMOUNT: '0.01' })],
    ['a changed status', (fields: Record<string, string>) => ({ ...fields, STATUS: 'TXN_FAILURE' })],
    ['a changed order id', (fields: Record<string, string>) => ({ ...fields, ORDERID: 'pay_OTHER' })],
    ['no checksum', (fields: Record<string, string>) => Object.fromEntries(Object.entries(fields).filter(([name]) => name !== 'CHECKSUMHASH'))],
    ['a checksum made with another key', () => signForm(asPayment(WALLET_SUCCESS), 'zzzzzzzzzzzzzzzz')],
  ])('%s is SIGNATURE_INVALID: no event is produced', (_name, tamper) => {
    const error = failure(() => parse(formBody(tamper(signForm(asPayment(WALLET_SUCCESS))))));
    expect(error.code).toBe(ErrorCode.SignatureInvalid);
  });

  it('a payment webhook without its amount is UNEXPECTED_RESPONSE: a payment cannot be built without one', () => {
    const { TXNAMOUNT: _amount, ...withoutAmount } = asPayment(WALLET_SUCCESS);
    expect(failure(() => parseForm(withoutAmount)).code).toBe(ErrorCode.UnexpectedResponse);
  });
});

describe('refund notifications of a one-time payment', () => {
  /** [wh-success-refund / tab "Success" code block 1], body only; orderId is the payment's order id. */
  const SUCCESS_REFUND_BODY = {
    source: 'MERCHANT',
    txnId: '202005081112128XXXXXX68470101509706',
    orderId: PAYMENT_ORDER,
    txnAmount: '1.00',
    mid: 'INTEGR7769XXXXXX9383',
    refundAmount: '1.00',
    txnTimestamp: '2020-09-03 16:51:41.0',
    totalRefundAmount: '1.00',
    acceptRefundTimestamp: '2020-09-03 16:52:10.0',
    refId: 'REFUNDID_98765',
    merchantRefundRequestTimestamp: '2020-09-03 16:52:08.0',
    userCreditInitiateTimestamp: '2020-09-03 16:52:10.0',
    refundId: '20200903XXXXXX801300168821700215705',
    refundDetailInfoList: [
      {
        refundType: 'TO_SOURCE',
        payMethod: 'CREDIT_CARD',
        refundAmount: '1.00',
        rrn: '1735XXXX84',
        issuingBankName: 'HDFC Bank',
        maskedCardNumber: '5242********3040',
        cardScheme: 'MASTER',
        userCreditExpectedDate: '2020-09-13',
      },
    ],
    agentInfo: { employeeId: 'Emp-001', name: 'Lalit', phoneNo: '7777777777', email: 'customer@example.com' },
  };
  /** [wh-accept-refund / tab "Success" code block 1], body only. */
  const ACCEPT_REFUND_BODY = {
    txnTimestamp: '2020-09-03 16:51:41.0',
    orderId: PAYMENT_ORDER,
    refundAmount: '1.00',
    refundId: '20200903XXXXXX801300168821700215705',
    txnAmount: '1.00',
    txnId: '202005081112128XXXXXX68470101509706',
    merchantRefundRequestTimestamp: '2020-09-03 16:52:08.0',
    acceptRefundTimestamp: '2020-09-03 16:52:09.0',
    refId: 'REFUNDID_98765',
    refundReason: 'Sample Refund Reason ',
    agentInfo: { employeeId: 'Emp-001', name: 'Lalit', phoneNo: '7777777777', email: 'customer@example.com' },
    status: 'SUCCESS',
  };
  /** [wh-refund-arn]: the field list of the page, filled in. */
  const REFUND_ARN: Record<string, string> = {
    ORDERID: PAYMENT_ORDER,
    REFID: 'REFUNDID_98765',
    MID: 'INTEGR7769XXXXXX9383',
    TXNID: '202005081112128XXXXXX68470101509706',
    REFUNDID: '20200903XXXXXX801300168821700215705',
    TXNAMOUNT: '1.00',
    REFUNDAMOUNT: '1.00',
    TXNDATETIME: '2020-09-03 16:51:41.0',
    REFUNDDATETIME: '2020-09-03 16:52:10.0',
    PAYMENTMODE: 'CC',
    GATEWAYNAME: 'HDFC',
    BANKNAME: 'HDFC Bank',
    ARN: '74056633031820896327619',
    RRN: '1735XXXX84',
  };

  function refundWebhook(body: unknown, key = KEY) {
    const compact = JSON.stringify(body);
    return `{"head":${JSON.stringify({ signature: independentSign(compact, key), version: 'v1' })},"body":${compact}}`;
  }

  it('Success Refund is refund.succeeded and carries paymentId, on the event and on the refund (chargeId is the same id)', () => {
    const [event] = parse(refundWebhook(SUCCESS_REFUND_BODY));
    expect(event).toMatchObject({ type: EventType.RefundSucceeded, providerEventType: 'SUCCESS_REFUND', paymentId: PAYMENT_ORDER });
    expect(event?.refund).toMatchObject({
      id: '20200903XXXXXX801300168821700215705',
      reference: 'REFUNDID_98765',
      chargeId: PAYMENT_ORDER,
      paymentId: PAYMENT_ORDER,
      status: RefundStatus.Succeeded,
      amount: 100,
    });
  });

  it('a FAILED refund is refund.failed with paymentId', () => {
    const rejected = { ...ACCEPT_REFUND_BODY, status: 'FAILED', rejectRefundReasonCode: '1', rejectRefundReasonMessage: 'Insufficient balance in your settlement account' };
    const [event] = parse(refundWebhook(rejected));
    expect(event).toMatchObject({ type: EventType.RefundFailed, providerEventType: 'ACCEPT_REFUND:FAILED', paymentId: PAYMENT_ORDER });
    expect(event?.refund).toMatchObject({ status: RefundStatus.Failed, paymentId: PAYMENT_ORDER, chargeId: PAYMENT_ORDER });
  });

  it('Accept Refund (the refund is registered, the customer has not been credited) is still an unknown event, with paymentId', () => {
    const [event] = parse(refundWebhook(ACCEPT_REFUND_BODY));
    expect(event).toMatchObject({ type: EventType.Unknown, providerEventType: 'ACCEPT_REFUND:SUCCESS', paymentId: PAYMENT_ORDER });
    expect(event?.refund).toMatchObject({ status: RefundStatus.Pending, paymentId: PAYMENT_ORDER });
  });

  it('the Refund ARN notification keeps its unknown event and gains paymentId', () => {
    const [event] = parseForm(REFUND_ARN);
    expect(event).toMatchObject({ type: EventType.Unknown, providerEventType: 'REFUND_ARN', paymentId: PAYMENT_ORDER });
    expect(event?.refund).toMatchObject({ chargeId: PAYMENT_ORDER, paymentId: PAYMENT_ORDER, status: RefundStatus.Succeeded });
  });

  it('refunds of a debit are unchanged: no paymentId anywhere', () => {
    const [success] = parse(refundWebhook({ ...SUCCESS_REFUND_BODY, orderId: 'ORDERID_98765' }));
    expect(success).toMatchObject({ type: EventType.RefundSucceeded });
    expect(success?.paymentId).toBeUndefined();
    expect(success?.refund?.paymentId).toBeUndefined();
    expect(success?.refund?.chargeId).toBe('ORDERID_98765');
    const [arn] = parseForm({ ...REFUND_ARN, ORDERID: 'ORDERID_98765' });
    expect(arn?.paymentId).toBeUndefined();
    expect(arn?.refund?.paymentId).toBeUndefined();
  });

  it('an unsigned or wrongly signed refund webhook is SIGNATURE_INVALID', () => {
    expect(failure(() => parse(refundWebhook(SUCCESS_REFUND_BODY, 'zzzzzzzzzzzzzzzz'))).code).toBe(ErrorCode.SignatureInvalid);
    expect(failure(() => parse(`{"head":{"version":"v1"},"body":${JSON.stringify(SUCCESS_REFUND_BODY)}}`)).code).toBe(ErrorCode.SignatureInvalid);
  });
});
