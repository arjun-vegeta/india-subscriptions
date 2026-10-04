import { describe, expect, it } from 'vitest';
import { ChargeKind, ChargeStatus, ErrorCode, EventType, PaymentMethod, RefundStatus, SchedulingMode, SubscriptionStatus } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import { KEY, MID, formBody, independentSign, makeProvider, signForm, webhookRequest } from './helpers.js';

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
 * Field values are the docs' samples ([wh-sub-status], [wh-payment], [wh-prenotify], [wh-refund-arn] and the JSON refund
 * pages); the docs print each webhook as a PHP-style key dump with a CHECKSUMHASH made with Paytm's key, which cannot be
 * reproduced, so every form here carries a CHECKSUMHASH computed with the test key by the independent implementation.
 */

/** [wh-sub-status / tab "UPI" code block 1] */
const SUBSCRIPTION_UPI: Record<string, string> = {
  UPFRONTTXNID: '20220217111212800110168855403425511',
  vpa: '***30021266@pa***',
  PAYMENTMODE: 'UPI',
  CUSTID: 'CUST_001',
  MID: 'INTEGR7769XXXXXX9383',
  EXPIRYDATE: '2022-04-17 00:00:00',
  UPDATEDDATE: '2022-02-17 13:07:49',
  CUSTMOBILE: '8130021266',
  FREQUENCYUNIT: 'MONTH',
  MAXAMOUNT: '1.0',
  ORDERID: 'ORDERID_98765',
  CREATEDDATE: '2022-02-17 12:07:26',
  UPFRONTTXNAMOUNT: '1.00',
  STATUS: 'ACTIVE',
  FREQUENCY: '1',
  AMOUNTTYPE: 'FIX',
  MERCHANTNAME: 'TEST INTEGRATION 5',
  SUBS_ID: '272874',
  CUSTEMAILID: 'customer@example.com',
  PAUSESTARTDATE: '2023-05-01 00:00:00',
  PAUSEENDDATE: '2023-05-19 00:00:00',
};

/** [wh-sub-status / tab "Bank Mandate" code block 1] */
const SUBSCRIPTION_BANK: Record<string, string> = {
  BANKNAME: 'Paytm Payments Bank Ltd',
  BANKLOGO: 'https://pgpqa-static3.paytmpayments.com/native/bank/PPBL.png',
  PAYMENTMODE: 'BANK_MANDATE',
  CUSTID: 'CUST_001',
  MID: 'INTEGR7769XXXXXX9383',
  EXPIRYDATE: '2020-09-25 00:00:00',
  UPDATEDDATE: '2020-09-11 16:06:34',
  FREQUENCYUNIT: 'MONTH',
  MAXAMOUNT: '1000.0',
  IFSC: 'PYTM0123456',
  ORDERID: 'ORDERID_98765',
  CREATEDDATE: '2020-09-11 16:02:25',
  UPFRONTTXNAMOUNT: '0.00',
  STATUS: 'AUTHORIZED',
  MASKEDACCOUNTNUMBER: 'XXXXXX7777',
  AMOUNTTYPE: 'VARIABLE',
  MERCHANTNAME: 'TEST INTEGRATION 5',
  MANDATETYPE: 'E_MANDATE',
  SUBS_ID: '102893',
  SUBSTATUS: 'NPCI_PENDING',
};

/** [wh-sub-status / tab "Wallet" code block 1] */
const SUBSCRIPTION_WALLET: Record<string, string> = {
  PPITYPE: 'Y',
  BANKNAME: 'WALLET',
  PAYMENTMODE: 'PPI',
  CUSTID: 'CUST_001',
  MID: 'INTEGR7769XXXXXX9383',
  EXPIRYDATE: '2020-09-25 00:00:00',
  UPDATEDDATE: '2020-09-11 13:07:49',
  CUSTMOBILE: '7777777777',
  FREQUENCYUNIT: 'MONTH',
  MAXAMOUNT: '1000.0',
  ORDERID: 'ORDERID_98765',
  CREATEDDATE: '2020-09-11 13:07:26',
  UPFRONTTXNAMOUNT: '0.00',
  STATUS: 'ACTIVE',
  AMOUNTTYPE: 'VARIABLE',
  MERCHANTNAME: 'TEST INTEGRATION 5',
  SUBS_ID: '102771',
  CUSTEMAILID: 'customer@example.com',
};

/** [wh-payment / tab "Wallet" code blocks 1 and 2] */
const PAYMENT_SUCCESS: Record<string, string> = {
  ORDERID: 'ORDERID_98765',
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
const PAYMENT_FAILURE: Record<string, string> = {
  ...PAYMENT_SUCCESS,
  STATUS: 'TXN_FAILURE',
  RESPCODE: '227',
  RESPMSG: 'Your payment has been declined by your bank. Please try again or use a different method to complete the payment.',
};
/** [wh-payment / tab "UPI Collect" code block 1] */
const PAYMENT_UPI: Record<string, string> = {
  ORDERID: 'ORDERID_98765',
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

/** [wh-prenotify / tab "Wallet" code block 1] */
const PRENOTIFY: Record<string, string> = {
  NOTIFICATIONSTATUS: 'SUCCESS',
  TXNDATE: '14/09/2020 00:00',
  NOTIFICATIONDATE: '14/09/2020 11:37',
  REFERENCEID: 'REF_123456',
  TXNMESSAGE: 'test',
};

/** [wh-refund-arn]: the field list of the page (it prints no sample values), filled with the docs' sample values elsewhere. */
const REFUND_ARN: Record<string, string> = {
  ORDERID: 'ORDERID_98765',
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

/** [wh-accept-refund / tab "Success" code block 1], body only. */
const ACCEPT_REFUND_BODY = {
  txnTimestamp: '2020-09-03 16:51:41.0',
  orderId: 'ORDERID_98765',
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

/** [wh-success-refund / tab "Success" code block 1], body only. */
const SUCCESS_REFUND_BODY = {
  source: 'MERCHANT',
  txnId: '202005081112128XXXXXX68470101509706',
  orderId: 'ORDERID_98765',
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
    { refundType: 'TO_SOURCE', payMethod: 'CREDIT_CARD', refundAmount: '1.00', rrn: '1735XXXX84', issuingBankName: 'HDFC Bank', maskedCardNumber: '5242********3040', cardScheme: 'MASTER', userCreditExpectedDate: '2020-09-13' },
  ],
  agentInfo: { employeeId: 'Emp-001', name: 'Lalit', phoneNo: '7777777777', email: 'customer@example.com' },
};

/** A JSON refund webhook signed over `signedText` and sent as `sentText`. */
function refundWebhook(body: unknown, options: { indent?: number; signOver?: 'compact' | 'sent'; key?: string; signature?: string | null } = {}) {
  const compact = JSON.stringify(body);
  const sentBody = options.indent ? JSON.stringify(body, null, options.indent) : compact;
  const signedText = options.signOver === 'sent' ? sentBody : compact;
  const signature = options.signature === undefined ? independentSign(signedText, options.key ?? KEY) : options.signature;
  const head = signature === null ? { version: 'v1' } : { signature, version: 'v1' };
  // The envelope is assembled around the exact body text, as a sender that signs a string would.
  return `{"head":${JSON.stringify(head)},"body":${sentBody}}`;
}

describe('Subscription Status webhook', () => {
  it('ACTIVE is subscription.activated, with the subscription (id, reference, scheduling, amount, interval, method) and no charge', () => {
    const [event] = parseForm(SUBSCRIPTION_UPI);
    expect(event).toMatchObject({
      provider: 'paytm',
      type: EventType.SubscriptionActivated,
      providerEventType: 'SUBSCRIPTION_STATUS:ACTIVE',
      subscriptionId: '272874',
      occurredAt: '2022-02-17T07:37:49.000Z',
    });
    expect(event?.subscription).toMatchObject({
      id: '272874',
      reference: 'ORDERID_98765',
      status: SubscriptionStatus.Active,
      providerStatus: 'ACTIVE',
      scheduling: SchedulingMode.Gateway,
      amount: 100,
      maxAmount: 100,
      interval: { unit: 'month', count: 1 },
      paymentMethod: PaymentMethod.Upi,
      customer: { id: 'CUST_001', email: 'customer@example.com', phone: '8130021266' },
      createdAt: '2022-02-17T06:37:26.000Z',
      mandateEndsAt: '2022-04-16T18:30:00.000Z',
    });
    expect(event?.charge).toBeUndefined();
    expect(event?.raw).toMatchObject({ SUBS_ID: '272874', vpa: '***30021266@pa***' });
  });

  it('verifies mixed-case field names (vpa) with the docs\' sort rule: they sort after every upper-case name', () => {
    // signForm sorts with an independent implementation; the upper-case-first order is what makes this pass.
    expect(parseForm(SUBSCRIPTION_UPI)).toHaveLength(1);
    expect(Object.keys(SUBSCRIPTION_UPI).sort().at(-1)).toBe('vpa');
  });

  it('a bank mandate that is authorised but not yet confirmed is subscription.authorized (SUBSTATUS NPCI_PENDING), VARIABLE is merchant-collected, e-mandate is enach', () => {
    const [event] = parseForm(SUBSCRIPTION_BANK);
    expect(event).toMatchObject({ type: EventType.SubscriptionAuthorized, subscriptionId: '102893' });
    expect(event?.subscription).toMatchObject({
      status: SubscriptionStatus.PendingAuthorization,
      providerStatus: 'AUTHORIZED',
      scheduling: SchedulingMode.Merchant,
      maxAmount: 100000,
      paymentMethod: PaymentMethod.ENach,
    });
    expect(event?.subscription?.amount).toBeUndefined();
  });

  it('a wallet subscription: PPI has no unified method', () => {
    const [event] = parseForm(SUBSCRIPTION_WALLET);
    expect(event).toMatchObject({ type: EventType.SubscriptionActivated, subscriptionId: '102771' });
    expect(event?.subscription?.paymentMethod).toBeUndefined();
  });

  const table: [string, Record<string, string>, EventType][] = [
    ['ACTIVE', {}, EventType.SubscriptionActivated],
    ['ACTIVE', { subStatus: 'RESUMED' }, EventType.SubscriptionResumed],
    ['ACTIVE', { SUBSTATUS: 'RESUMED' }, EventType.SubscriptionResumed],
    ['ACTIVE', { subStatus: 'ACTIVE' }, EventType.SubscriptionActivated],
    ['SUSPENDED', {}, EventType.SubscriptionPaused],
    ['REJECT', {}, EventType.SubscriptionCancelled],
    ['EXPIRED', {}, EventType.SubscriptionExpired],
    ['CLOSED', {}, EventType.SubscriptionExpired],
    ['AUTHORIZATION_FAILED', {}, EventType.SubscriptionAuthorizationFailed],
    ['AUTHORIZED', {}, EventType.SubscriptionAuthorized],
    ['AUTHORISED', {}, EventType.SubscriptionAuthorized],
    ['INIT', {}, EventType.Unknown],
    ['IN_AUTHORIZATION', {}, EventType.Unknown],
    ['CONFIRMED', {}, EventType.Unknown],
    ['SOMETHING_NEW', {}, EventType.Unknown],
  ];
  for (const [status, extra, expected] of table) {
    it(`STATUS ${status}${Object.keys(extra).length ? ` with ${JSON.stringify(extra)}` : ''} is ${expected}`, () => {
      const [event] = parseForm({ ...SUBSCRIPTION_UPI, STATUS: status, ...extra });
      expect(event?.type).toBe(expected);
      expect(event?.providerEventType).toBe(`SUBSCRIPTION_STATUS:${status}`);
      expect(event?.subscription?.providerStatus).toBe(status);
      expect(event?.subscriptionId).toBe('272874');
    });
  }

  it('the event id is built from the content: stable across redelivery and re-signing, different for another status or update time', () => {
    const [first] = parse(formBody(signForm(SUBSCRIPTION_UPI)));
    const [again] = parse(formBody(signForm(SUBSCRIPTION_UPI, KEY, 'Qx9/')));
    const [other] = parseForm({ ...SUBSCRIPTION_UPI, STATUS: 'SUSPENDED' });
    const [later] = parseForm({ ...SUBSCRIPTION_UPI, UPDATEDDATE: '2022-02-18 09:00:00' });
    expect(first?.id).toBe('paytm:SUBSCRIPTION_STATUS:272874:ACTIVE::2022-02-17 13:07:49');
    expect(again?.id).toBe(first?.id);
    expect(other?.id).not.toBe(first?.id);
    expect(later?.id).not.toBe(first?.id);
  });
});

describe('Payment Status webhook', () => {
  it('TXN_SUCCESS is subscription.charged: charge.id and charge.reference are the order id, and no subscription id is claimed', () => {
    const [event] = parseForm(PAYMENT_SUCCESS);
    expect(event).toMatchObject({ provider: 'paytm', type: EventType.SubscriptionCharged, providerEventType: 'PAYMENT_STATUS:TXN_SUCCESS', occurredAt: '2020-07-24T09:43:02.000Z' });
    expect(event?.subscriptionId).toBeUndefined();
    expect(event?.subscription).toBeUndefined();
    expect(event?.charge).toMatchObject({
      id: 'ORDERID_98765',
      reference: 'ORDERID_98765',
      kind: ChargeKind.Recurring,
      status: ChargeStatus.Succeeded,
      providerStatus: 'TXN_SUCCESS',
      amount: 100,
      currency: 'INR',
      paidAt: '2020-07-24T09:43:02.000Z',
    });
    expect(event?.charge?.subscriptionId).toBeUndefined();
    expect(event?.raw).toMatchObject({ TXNID: '202005081112128XXXXXX68470101509706', BANKTXNID: '62909899', RESPCODE: '01' });
  });

  it('TXN_FAILURE is subscription.charge_failed with Paytm\'s code and message', () => {
    const [event] = parseForm(PAYMENT_FAILURE);
    expect(event?.type).toBe(EventType.SubscriptionChargeFailed);
    expect(event?.charge).toMatchObject({ id: 'ORDERID_98765', status: ChargeStatus.Failed, failureCode: '227', failureReason: PAYMENT_FAILURE.RESPMSG });
    expect(event?.charge?.paidAt).toBeUndefined();
  });

  it('the UPI sample (no BANKNAME) is a UPI charge', () => {
    const [event] = parseForm(PAYMENT_UPI);
    expect(event?.charge).toMatchObject({ paymentMethod: PaymentMethod.Upi, paidAt: '2020-07-28T04:44:55.000Z' });
  });

  it('a PENDING payment is not a charge outcome: an unknown event carrying a pending charge', () => {
    const [event] = parseForm({ ...PAYMENT_SUCCESS, STATUS: 'PENDING' });
    expect(event).toMatchObject({ type: EventType.Unknown, providerEventType: 'PAYMENT_STATUS:PENDING' });
    expect(event?.charge?.status).toBe(ChargeStatus.Pending);
  });

  it('the id is order id + status + transaction id, so a redelivery repeats it and a later outcome for the order differs', () => {
    const [first] = parseForm(PAYMENT_SUCCESS);
    const [again] = parse(formBody(signForm(PAYMENT_SUCCESS, KEY, 'Zz+/')));
    const [failed] = parseForm(PAYMENT_FAILURE);
    expect(first?.id).toBe('paytm:PAYMENT_STATUS:ORDERID_98765:TXN_SUCCESS:202005081112128XXXXXX68470101509706');
    expect(again?.id).toBe(first?.id);
    expect(failed?.id).not.toBe(first?.id);
  });
});

describe('Pre-Notify callback', () => {
  it('SUCCESS means the customer was told: subscription.charge_scheduled with no subscription or amount; FAILURE is unknown', () => {
    const [event] = parseForm(PRENOTIFY);
    expect(event).toMatchObject({ type: EventType.SubscriptionChargeScheduled, providerEventType: 'PRE_NOTIFY_CALLBACK:SUCCESS', occurredAt: '2020-09-14T06:07:00.000Z' });
    expect(event?.subscriptionId).toBeUndefined();
    expect(event?.charge).toBeUndefined();
    expect(event?.id).toBe('paytm:PRE_NOTIFY_CALLBACK:REF_123456:SUCCESS');
    const [failed] = parseForm({ ...PRENOTIFY, NOTIFICATIONSTATUS: 'FAILURE', NOTIFICATIONSTATUSCODE: 'U28' });
    expect(failed).toMatchObject({ type: EventType.Unknown, providerEventType: 'PRE_NOTIFY_CALLBACK:FAILURE' });
  });
});

describe('Refund webhooks', () => {
  it('Refund ARN (key-value) is information about a refund that already succeeded, not a state change', () => {
    const [event] = parseForm(REFUND_ARN);
    expect(event).toMatchObject({ type: EventType.Unknown, providerEventType: 'REFUND_ARN', occurredAt: '2020-09-03T11:22:10.000Z' });
    expect(event?.refund).toMatchObject({
      id: '20200903XXXXXX801300168821700215705',
      reference: 'REFUNDID_98765',
      chargeId: 'ORDERID_98765',
      status: RefundStatus.Succeeded,
      amount: 100,
    });
  });

  it('Success Refund (JSON, signed over the compact body) is refund.succeeded with the refund', () => {
    const [event] = parse(refundWebhook(SUCCESS_REFUND_BODY));
    expect(event).toMatchObject({ type: EventType.RefundSucceeded, providerEventType: 'SUCCESS_REFUND', occurredAt: '2020-09-03T11:22:10.000Z' });
    expect(event?.refund).toMatchObject({
      id: '20200903XXXXXX801300168821700215705',
      reference: 'REFUNDID_98765',
      chargeId: 'ORDERID_98765',
      status: RefundStatus.Succeeded,
      providerStatus: 'SUCCESS_REFUND',
      amount: 100,
      createdAt: '2020-09-03T11:22:08.000Z',
    });
    expect(event?.subscriptionId).toBeUndefined();
  });

  it('Accept Refund with status SUCCESS is only an acceptance (the customer is not credited): an unknown event with a pending refund', () => {
    const [event] = parse(refundWebhook(ACCEPT_REFUND_BODY));
    expect(event).toMatchObject({ type: EventType.Unknown, providerEventType: 'ACCEPT_REFUND:SUCCESS', occurredAt: '2020-09-03T11:22:09.000Z' });
    expect(event?.refund).toMatchObject({ status: RefundStatus.Pending, providerStatus: 'SUCCESS', reference: 'REFUNDID_98765' });
  });

  it('Accept Refund with status FAILED (and a rejection reason) is refund.failed; so is a failed Success Refund', () => {
    const rejected = { ...ACCEPT_REFUND_BODY, status: 'FAILED', rejectRefundReasonCode: '1', rejectRefundReasonMessage: 'Insufficient balance in your settlement account' };
    const [event] = parse(refundWebhook(rejected));
    expect(event).toMatchObject({ type: EventType.RefundFailed, providerEventType: 'ACCEPT_REFUND:FAILED' });
    expect(event?.refund).toMatchObject({ status: RefundStatus.Failed });
    const [late] = parse(refundWebhook({ ...SUCCESS_REFUND_BODY, status: 'FAILED' }));
    expect(late?.type).toBe(EventType.RefundFailed);
  });

  it('verifies the signature against the exact text received: a body sent pretty-printed and signed as sent, or signed compact', () => {
    expect(parse(refundWebhook(SUCCESS_REFUND_BODY, { indent: 2, signOver: 'sent' }))[0]?.type).toBe(EventType.RefundSucceeded);
    expect(parse(refundWebhook(SUCCESS_REFUND_BODY, { indent: 2, signOver: 'compact' }))[0]?.type).toBe(EventType.RefundSucceeded);
  });

  it('a refund webhook with a changed body, no signature (the docs\' failure sample has none), or another key is SIGNATURE_INVALID', () => {
    const genuine = refundWebhook(SUCCESS_REFUND_BODY);
    const cases: [string, string][] = [
      ['a changed amount', genuine.replace('"refundAmount":"1.00"', '"refundAmount":"9.00"')],
      ['a changed refund id', genuine.replace('REFUNDID_98765', 'REFUNDID_00000')],
      ['no signature', refundWebhook(SUCCESS_REFUND_BODY, { signature: null })],
      ['an empty signature', refundWebhook(SUCCESS_REFUND_BODY, { signature: '' })],
      ['another key', refundWebhook(SUCCESS_REFUND_BODY, { key: 'zzzzzzzzzzzzzzzz' })],
      ['a signature of other text', refundWebhook(SUCCESS_REFUND_BODY, { signature: independentSign('{}', KEY) })],
    ];
    for (const [name, body] of cases) {
      expect(failure(() => parse(body)).code, name).toBe(ErrorCode.SignatureInvalid);
    }
  });

  it('a refund event id repeats on redelivery and differs for the other stage of the same refund', () => {
    const [accepted] = parse(refundWebhook(ACCEPT_REFUND_BODY));
    const [acceptedAgain] = parse(refundWebhook(ACCEPT_REFUND_BODY, { indent: 2 }));
    const [success] = parse(refundWebhook(SUCCESS_REFUND_BODY));
    expect(acceptedAgain?.id).toBe(accepted?.id);
    expect(success?.id).not.toBe(accepted?.id);
  });
});

describe('every key-value webhook kind: signature', () => {
  const kinds: [string, Record<string, string>][] = [
    ['subscription status', SUBSCRIPTION_UPI],
    ['payment', PAYMENT_SUCCESS],
    ['pre-notify callback', PRENOTIFY],
    ['refund ARN', REFUND_ARN],
  ];
  for (const [name, fields] of kinds) {
    it(`${name}: a tampered value, an added field, a missing or foreign checksum and the wrong key are SIGNATURE_INVALID`, () => {
      const genuine = signForm(fields);
      const firstField = Object.keys(fields)[0] as string;
      const variants: [string, Record<string, string>][] = [
        ['a changed value', { ...genuine, [firstField]: `${fields[firstField]}x` }],
        ['an added field', { ...genuine, EXTRA: '1' }],
        ['no checksum', (({ CHECKSUMHASH: _removed, ...rest }) => rest)(genuine)],
        ['an empty checksum', { ...genuine, CHECKSUMHASH: '' }],
        ['a checksum of other fields', { ...genuine, CHECKSUMHASH: independentSign('x', KEY) }],
        ['the wrong key', signForm(fields, 'zzzzzzzzzzzzzzzz')],
      ];
      for (const [variant, body] of variants) {
        expect(failure(() => parse(formBody(body))).code, variant).toBe(ErrorCode.SignatureInvalid);
      }
      expect(parse(formBody(genuine))).toHaveLength(1);
    });
  }

  it('nothing is read from a webhook that fails: bad signature beats missing fields', () => {
    expect(failure(() => parse(formBody({ FOO: 'bar', CHECKSUMHASH: 'x' }))).code).toBe(ErrorCode.SignatureInvalid);
  });

  it('a form delivered as a flat JSON object is verified with the same rule', () => {
    const body = JSON.stringify(signForm(PAYMENT_SUCCESS));
    expect(parse(body)[0]?.type).toBe(EventType.SubscriptionCharged);
    const forged = JSON.stringify({ ...signForm(PAYMENT_SUCCESS), TXNAMOUNT: '9999.00' });
    expect(failure(() => parse(forged)).code).toBe(ErrorCode.SignatureInvalid);
  });

  it('a JSON object with a null value is signed with it as empty; a non-text value cannot be a Paytm form', () => {
    const fields = { ...PAYMENT_SUCCESS, BANKNAME: null as unknown as string };
    const checksum = independentSign(Object.keys(fields).sort().map((name) => (fields as Record<string, string | null>)[name] ?? '').join('|'), KEY);
    expect(parse(JSON.stringify({ ...fields, CHECKSUMHASH: checksum }))[0]?.type).toBe(EventType.SubscriptionCharged);
    expect(failure(() => parse(JSON.stringify({ ...signForm(PAYMENT_SUCCESS), TXNAMOUNT: 1 }))).code).toBe(ErrorCode.UnexpectedResponse);
  });

  it('a genuinely signed body of no known kind is UNEXPECTED_RESPONSE; invalid JSON too', () => {
    expect(failure(() => parse(formBody(signForm({ FOO: 'bar' })))).code).toBe(ErrorCode.UnexpectedResponse);
    expect(failure(() => parse('{not json')).code).toBe(ErrorCode.UnexpectedResponse);
  });

  it('a "+" in the checksum that a form decoder turned into a space is put back', () => {
    let fields: Record<string, string> | undefined;
    for (let i = 0; i < 400 && !fields; i += 1) {
      const candidate = signForm(PAYMENT_SUCCESS, KEY, `S${String(i).padStart(3, '0')}`);
      if (candidate.CHECKSUMHASH?.includes('+')) fields = candidate;
    }
    const found = fields as Record<string, string>;
    // Encoded as a form encoder would, except the checksum: its "+" stays raw, which a form decoder reads as a space.
    const { CHECKSUMHASH, ...rest } = found;
    const raw = `${formBody(rest)}&CHECKSUMHASH=${CHECKSUMHASH}`;
    expect(parse(raw)[0]?.type).toBe(EventType.SubscriptionCharged);
  });

  it('events never carry the merchant key', () => {
    for (const [, fields] of kinds) expect(JSON.stringify(parseForm(fields))).not.toContain(KEY);
    expect(MID).toBeTruthy();
  });
});
