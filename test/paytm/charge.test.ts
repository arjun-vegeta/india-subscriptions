import { describe, expect, it } from 'vitest';
import { ChargeKind, ChargeStatus, ErrorCode, PaymentMethod, RefundStatus } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import { MID, PRODUCTION, PRODUCTION_GW, STAGING, STAGING_GW, makeProvider, reply, sent, statusAnswer } from './helpers.js';

const STATUS_URL = `${STAGING}/subscription/checkStatus`;
const PRENOTIFY_URL = `${STAGING}/subscription/preNotify`;
const RENEW_URL = `${STAGING}/subscription/renew?mid=${MID}&orderId=c_1`;
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

// ---------------------------------------------------------------------------
// Pre-notify
// ---------------------------------------------------------------------------

/** Pre-Notify success, verbatim [prenotify / api_response SUCCESS]. */
const PRENOTIFY_SUCCESS = {
  head: { timestamp: '1577962598975', clientId: '1234', version: 'v1' },
  body: { resultInfo: { code: '3006', message: 'SUCCESS', status: 'SUCCESS' }, paytmReferenceId: '123456789' },
};
/** Pre-Notify failure, verbatim [prenotify / api_response FAIL]. */
const PRENOTIFY_FAIL = {
  head: { timestamp: '1577962598975', clientId: '1234', version: 'v1' },
  body: { resultInfo: { code: '3047', message: 'Invalid Debit Date', status: 'FAILURE' } },
};

const NOTIFY = { subscriptionId: '130010', notificationId: 'n_abc', amount: 49900, debitAt: '2026-11-19T04:30:00.000Z' };

describe('notifyCharge: Pre-Notify', () => {
  it('reads the payment mode, then sends the pre-notify with the notification id as referenceId and the debit date as DD-MM-YYYY', async () => {
    const { provider, calls } = makeProvider([
      { url: STATUS_URL, json: statusAnswer() },
      { url: PRENOTIFY_URL, json: PRENOTIFY_SUCCESS },
    ]);
    const notification = await provider.notifyCharge(NOTIFY);
    expect(calls).toHaveLength(2);
    expect(sent(calls[0] as never).body).toEqual({ mid: MID, subsId: '130010' });
    const request = sent(calls[1] as never);
    expect(request.url.href).toBe(PRENOTIFY_URL);
    expect(request.head).toEqual({ tokenType: 'AES', signature: expect.any(String) });
    expect(request.body).toEqual({
      mid: MID,
      subsId: '130010',
      txnAmount: '499.00',
      txnDate: '19-11-2026',
      txnMessage: 'Subscription renewal',
      referenceId: 'n_abc',
    });
    expect(notification).toEqual({
      provider: 'paytm',
      id: 'n_abc',
      subscriptionId: '130010',
      accepted: true,
      providerStatus: 'SUCCESS',
      amount: 49900,
      debitAt: NOTIFY.debitAt,
      // The reference the debit must name as prenotifyReferenceId. Paytm does not tie the debit's own order id to it.
      invoiceNumber: 'n_abc',
      raw: PRENOTIFY_SUCCESS.body,
    });
    expect(notification.chargeId).toBeUndefined();
  });

  it('takes the debit date in IST: 01:30 IST on the 20th is the 20th although it is still the 19th in UTC', async () => {
    const { provider, calls } = makeProvider([
      { url: STATUS_URL, json: statusAnswer() },
      { url: PRENOTIFY_URL, json: PRENOTIFY_SUCCESS },
    ]);
    await provider.notifyCharge({ ...NOTIFY, debitAt: '2026-11-19T20:00:00.000Z' });
    expect(sent(calls[1] as never).body.txnDate).toBe('20-11-2026');
  });

  it('a bank mandate (eNACH) needs no pre-notify: accepted without a request, and the debit then names no pre-notify', async () => {
    for (const mode of ['BANK_MANDATE', 'BANKMANDATE']) {
      const { provider, calls } = makeProvider([
        { url: STATUS_URL, json: statusAnswer({ subsPaymentInstDetails: { paymentMode: mode, mandateType: 'E_MANDATE' } }) },
      ]);
      const notification = await provider.notifyCharge(NOTIFY);
      expect(calls).toHaveLength(1);
      expect(notification).toMatchObject({ accepted: true, providerStatus: 'NOT_REQUIRED', id: 'n_abc', amount: 49900, debitAt: NOTIFY.debitAt });
      expect(notification.invoiceNumber).toBeUndefined();
    }
  });

  it('sends it for UPI, cards, wallet, and when the mode cannot be read', async () => {
    for (const instrument of [{ paymentMode: 'UPI' }, { paymentMode: 'CC' }, { paymentMode: 'DC' }, { paymentMode: 'PPI' }, {}]) {
      const { provider, calls } = makeProvider([
        { url: STATUS_URL, json: statusAnswer({ subsPaymentInstDetails: instrument, payMode: undefined }) },
        { url: PRENOTIFY_URL, json: PRENOTIFY_SUCCESS },
      ]);
      expect((await provider.notifyCharge(NOTIFY)).accepted).toBe(true);
      expect(calls).toHaveLength(2);
    }
  });

  it('uses payMode when the instrument details carry no mode', async () => {
    const { provider, calls } = makeProvider([{ url: STATUS_URL, json: statusAnswer({ subsPaymentInstDetails: undefined, payMode: 'BANK_MANDATE' }) }]);
    await provider.notifyCharge(NOTIFY);
    expect(calls).toHaveLength(1);
  });

  it('passes a valid invoice number as invoiceDisplayNo, and refuses one Paytm cannot take before any request', async () => {
    const ok = makeProvider([
      { url: STATUS_URL, json: statusAnswer() },
      { url: PRENOTIFY_URL, json: PRENOTIFY_SUCCESS },
    ]);
    await ok.provider.notifyCharge({ ...NOTIFY, invoiceNumber: 'INV2026110001' });
    expect(sent(ok.calls[1] as never).body.invoiceDisplayNo).toBe('INV2026110001');
    const bad = makeProvider([]);
    expect(await errorOf(bad.provider.notifyCharge({ ...NOTIFY, invoiceNumber: 'INV-2026-11-00001' }))).toMatchObject({ code: ErrorCode.Validation });
    expect(bad.calls).toHaveLength(0);
  });

  it('config.debitReason is the reason the customer is shown', async () => {
    const { provider, calls } = makeProvider(
      [
        { url: STATUS_URL, json: statusAnswer() },
        { url: PRENOTIFY_URL, json: PRENOTIFY_SUCCESS },
      ],
      { debitReason: 'Pro plan renewal' },
    );
    await provider.notifyCharge(NOTIFY);
    expect(sent(calls[1] as never).body.txnMessage).toBe('Pro plan renewal');
  });

  it('3049 Duplicate Reference Id means an earlier try of this notification got through: accepted, with the reference', async () => {
    const { provider } = makeProvider([
      { url: STATUS_URL, json: statusAnswer() },
      { url: PRENOTIFY_URL, json: reply({ resultInfo: { code: '3049', message: 'Duplicate Reference Id', status: 'FAILURE' } }) },
    ]);
    expect(await provider.notifyCharge(NOTIFY)).toMatchObject({ accepted: true, invoiceNumber: 'n_abc', providerStatus: 'Duplicate Reference Id' });
  });

  it('3046 Notification already sent: accepted, but without a reference (the notification Paytm holds is under another one)', async () => {
    const { provider } = makeProvider([
      { url: STATUS_URL, json: statusAnswer() },
      { url: PRENOTIFY_URL, json: reply({ resultInfo: { code: '3046', message: 'Notification has already been sent', status: 'FAILURE' } }) },
    ]);
    const notification = await provider.notifyCharge(NOTIFY);
    expect(notification).toMatchObject({ accepted: true, providerStatus: 'ALREADY_SENT' });
    expect(notification.invoiceNumber).toBeUndefined();
  });

  const failures: [string, unknown, ErrorCode, string][] = [
    ['3047 Invalid Debit Date (the docs sample)', PRENOTIFY_FAIL, ErrorCode.Validation, '3047'],
    ['400 amount above the max', reply({ resultInfo: { code: '400', message: 'txnAmount can not be greater than max amount', status: 'FAILURE' } }), ErrorCode.Validation, '400'],
    ['400 subscription paused', reply({ resultInfo: { code: '400', message: 'Subscription is in paused/suspended state', status: 'FAILURE' } }), ErrorCode.Validation, '400'],
    ['401 authentication', reply({ resultInfo: { code: '401', message: 'Authentication Failure', status: 'FAILURE' } }), ErrorCode.Auth, '401'],
    ['3004 not found', reply({ resultInfo: { code: '3004', message: 'Subscription Not Found', status: 'FAILURE' } }), ErrorCode.NotFound, '3004'],
    ['3000 merchant not found', reply({ resultInfo: { code: '3000', message: 'MERCHANT_NOT_FOUND', status: 'FAILURE' } }), ErrorCode.Config, '3000'],
    ['3008 invalid amount', reply({ resultInfo: { code: '3008', message: 'Invalid Subscription Amount', status: 'FAILURE' } }), ErrorCode.Validation, '3008'],
    ['3065 retry in progress', reply({ resultInfo: { code: '3065', message: 'Pre-debit retry in progress, please try after sometime', status: 'FAILURE' } }), ErrorCode.ProviderUnavailable, '3065'],
    ['INT-6023 paused', reply({ resultInfo: { code: 'INT-6023', message: 'Scheduled payment is in paused state', status: 'FAILURE' } }), ErrorCode.ProviderError, 'INT-6023'],
    ['an unlisted code', reply({ resultInfo: { code: '9999', message: 'new', status: 'FAILURE' } }), ErrorCode.ProviderError, '9999'],
    ['no result', reply({}), ErrorCode.OutcomeUnknown, ''],
  ];
  for (const [name, answer, code, providerCode] of failures) {
    it(`a refusal: ${name} is ${code}`, async () => {
      const { provider } = makeProvider([
        { url: STATUS_URL, json: statusAnswer() },
        { url: PRENOTIFY_URL, json: answer },
      ]);
      const error = await errorOf(provider.notifyCharge(NOTIFY));
      expect(error.code).toBe(code);
      if (providerCode) expect(error.providerCode).toBe(providerCode);
    });
  }

  it('a lost answer is OUTCOME_UNKNOWN; an unknown subscription is NOT_FOUND from the status read, and no pre-notify is sent', async () => {
    const lost = makeProvider([
      { url: STATUS_URL, json: statusAnswer() },
      { url: PRENOTIFY_URL, networkError: true },
    ]);
    expect((await errorOf(lost.provider.notifyCharge(NOTIFY))).code).toBe(ErrorCode.OutcomeUnknown);
    const missing = makeProvider([{ url: STATUS_URL, json: reply({ resultInfo: { code: '3004', message: 'Subscription Not Found', status: 'FAILURE' } }) }]);
    expect((await errorOf(missing.provider.notifyCharge(NOTIFY))).code).toBe(ErrorCode.NotFound);
    expect(missing.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Renew
// ---------------------------------------------------------------------------

/** Renew success, verbatim [renew / api_response SUCCESS]. */
const RENEW_SUCCESS = {
  head: {
    responseTimestamp: '1567165743404',
    version: 'v1',
    signature: 'pBf7JJxatnwhDSj3hFlEVB6gahKUscUmclF5lXZPwMEg564Pd0dnUra+lz35brhS/7l8L6DygcvgLF9QPIhmG9AWPRp8SxzjaNY5leO8Gjc=',
  },
  body: {
    resultInfo: { resultStatus: 'S', resultCode: '900', resultMsg: 'Subscription Txn accepted.' },
    txnId: '20190830111212800110168307400852348',
  },
};
/** Renew failure, verbatim [renew / api_response FAIL]. */
const RENEW_FAIL = {
  head: { responseTimestamp: '1567165182391', version: 'v1' },
  body: { resultInfo: { resultStatus: 'F', resultCode: '928', resultMsg: 'Subscription Renewal Rejected.' } },
};

const CHARGE = { subscriptionId: '130010', chargeId: 'c_1', amount: 49900 };

describe('createCharge: Renew Subscription', () => {
  it('sends the Theia-style request with orderId = chargeId in the query and the body, and returns a pending recurring charge', async () => {
    const { provider, calls } = makeProvider([{ url: RENEW_URL, json: RENEW_SUCCESS }]);
    const charge = await provider.createCharge(CHARGE);
    expect(calls).toHaveLength(1);
    const request = sent(calls[0] as never);
    expect(request.url.href).toBe(RENEW_URL);
    expect(Object.keys(request.head)).toEqual(['signature']);
    expect(request.body).toEqual({
      mid: MID,
      orderId: 'c_1',
      txnAmount: { value: '499.00', currency: 'INR' },
      subscriptionId: '130010',
    });
    expect(charge).toEqual({
      provider: 'paytm',
      id: 'c_1',
      reference: 'c_1',
      subscriptionId: '130010',
      kind: ChargeKind.Recurring,
      status: ChargeStatus.Pending,
      providerStatus: 'Subscription Txn accepted.',
      amount: 49900,
      currency: 'INR',
      raw: RENEW_SUCCESS.body,
    });
  });

  it('names the pre-notify (invoiceNumber -> prenotifyReferenceId) and carries a description as a comment', async () => {
    const { provider, calls } = makeProvider([{ url: RENEW_URL, json: RENEW_SUCCESS }]);
    await provider.createCharge({ ...CHARGE, invoiceNumber: 'n_abc', description: 'November' });
    expect(sent(calls[0] as never).body).toMatchObject({ prenotifyReferenceId: 'n_abc', extendInfo: { comments: 'November' } });
  });

  it('sends debitDate (IST, YYYY-MM-DD HH:mm:ss) only for a LATER day: not for today and not for a past instant', async () => {
    const later = makeProvider([{ url: RENEW_URL, json: RENEW_SUCCESS }]);
    const charge = await later.provider.createCharge({ ...CHARGE, scheduledAt: '2026-11-20T04:30:00.000Z' });
    expect(sent(later.calls[0] as never).body.debitDate).toBe('2026-11-20 10:00:00');
    expect(charge.scheduledAt).toBe('2026-11-20T04:30:00.000Z');
    for (const scheduledAt of ['2026-11-17T12:00:00.000Z', '2026-11-16T04:30:00.000Z']) {
      const same = makeProvider([{ url: RENEW_URL, json: RENEW_SUCCESS }]);
      await same.provider.createCharge({ ...CHARGE, scheduledAt });
      expect(sent(same.calls[0] as never).body).not.toHaveProperty('debitDate');
    }
  });

  it('re-sending the same chargeId sends the same order id (the scheduler relies on Paytm refusing the repeat)', async () => {
    const { provider, calls } = makeProvider([
      { url: RENEW_URL, json: RENEW_SUCCESS },
      { url: RENEW_URL, json: RENEW_SUCCESS },
    ]);
    await provider.createCharge(CHARGE);
    await provider.createCharge(CHARGE);
    expect(sent(calls[0] as never).body).toEqual(sent(calls[1] as never).body);
  });

  const rejections: [string, string, ErrorCode][] = [
    ['325', 'Duplicate Order Id', ErrorCode.Conflict],
    ['931', 'Subscription already in progress', ErrorCode.Conflict],
    ['945', 'Manual renewal is not allowed as subscription has auto renewal preference configured', ErrorCode.Unsupported],
    ['947', 'Manual retry is not allowed on subscription where autorenewal or auto retry is configured', ErrorCode.Unsupported],
    ['905', 'Invalid Transaction Amount', ErrorCode.Validation],
    ['913', 'Invalid subscription amount type', ErrorCode.Validation],
    ['929', 'Invalid Subscription Details', ErrorCode.Validation],
    ['1103', 'The Debit Date is invalid', ErrorCode.Validation],
    ['1105', 'The Debit Date is beyond Subscription End Date', ErrorCode.Validation],
    ['1106', 'Debit on a later date functionality not available for the paymode', ErrorCode.Validation],
    ['3054', 'Prenotify not found for the given params', ErrorCode.Validation],
    ['901', 'Subscription not available', ErrorCode.NotFound],
    ['910', 'Subscription is not configured for the merchant', ErrorCode.Config],
    ['919', 'Merchant Not Found', ErrorCode.Config],
    ['2005', 'Checksum provided is invalid', ErrorCode.Auth],
    ['928', 'Subscription Renewal Rejected.', ErrorCode.ProviderError],
    ['935', 'Subscription has been already cancelled', ErrorCode.ProviderError],
    ['202', 'insufficient funds', ErrorCode.ProviderError],
    ['924', 'Wallet balance Insufficient', ErrorCode.ProviderError],
    ['165', 'User has crossed the monthly debit limit prescribed by RBI', ErrorCode.ProviderError],
    ['501', 'System Error', ErrorCode.OutcomeUnknown],
    ['1102', 'Something wents down', ErrorCode.OutcomeUnknown],
    ['7777', 'a code Paytm adds tomorrow', ErrorCode.OutcomeUnknown],
  ];
  for (const [code, message, expected] of rejections) {
    it(`Paytm's ${code} "${message}" is ${expected}`, async () => {
      const { provider } = makeProvider([{ url: RENEW_URL, json: reply({ resultInfo: { resultStatus: 'F', resultCode: code, resultMsg: message } }) }]);
      const error = await errorOf(provider.createCharge(CHARGE));
      expect(error.code).toBe(expected);
      expect(error.providerCode).toBe(code);
      expect(error.raw).toBeDefined();
    });
  }

  it('the docs\' sample failure (928) is a plain refusal; a "U" status, a missing result, a lost answer and an HTTP 5xx are OUTCOME_UNKNOWN', async () => {
    expect((await errorOf(makeProvider([{ url: RENEW_URL, json: RENEW_FAIL }]).provider.createCharge(CHARGE))).code).toBe(ErrorCode.ProviderError);
    const unknown = reply({ resultInfo: { resultStatus: 'U', resultCode: '900', resultMsg: 'System error' } });
    const results: [unknown, string][] = [
      [{ url: RENEW_URL, json: unknown }, 'U status'],
      [{ url: RENEW_URL, json: reply({}) }, 'no result'],
      [{ url: RENEW_URL, networkError: true }, 'dropped connection'],
      [{ url: RENEW_URL, status: 504, text: 'gateway timeout' }, 'HTTP 504'],
      [{ url: RENEW_URL, status: 500, text: '' }, 'HTTP 500'],
    ];
    for (const [route] of results) {
      const error = await errorOf(makeProvider([route as never]).provider.createCharge(CHARGE));
      expect(error.code).toBe(ErrorCode.OutcomeUnknown);
    }
  });

  it('a success code with a failed status is not success (Initiate\'s 900 is "System error")', async () => {
    const { provider } = makeProvider([{ url: RENEW_URL, json: reply({ resultInfo: { resultStatus: 'F', resultCode: '900', resultMsg: 'x' } }) }]);
    expect((await errorOf(provider.createCharge(CHARGE))).code).toBe(ErrorCode.OutcomeUnknown);
  });

  it('refuses a charge id Paytm cannot take as an order id, and a zero amount, before any request', async () => {
    const { provider, calls } = makeProvider([]);
    for (const chargeId of ['c|1', 'c 1', 'c/1', 'x'.repeat(51)]) {
      expect((await errorOf(provider.createCharge({ ...CHARGE, chargeId }))).code).toBe(ErrorCode.Validation);
    }
    expect((await errorOf(provider.createCharge({ ...CHARGE, amount: 0 }))).code).toBe(ErrorCode.Validation);
    expect(calls).toHaveLength(0);
  });

  it('accepts every id the scheduler generates (25 characters of letters, digits, _ and -)', async () => {
    const id = 'sch_Ab1-x_yz0123456789_cd';
    expect(id).toHaveLength(25);
    const { provider } = makeProvider([{ url: `${STAGING}/subscription/renew?mid=${MID}&orderId=${id}`, json: RENEW_SUCCESS }]);
    expect((await provider.createCharge({ ...CHARGE, chargeId: id })).id).toBe(id);
  });
});

// ---------------------------------------------------------------------------
// Transaction Status
// ---------------------------------------------------------------------------

/** Transaction Status success, verbatim [txn-status / SUCCESS]: a card payment that was refunded in full. */
const TXN_SAMPLE = {
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
/** Transaction Status failure, verbatim [txn-status / FAIL]. */
const TXN_INVALID_ORDER = {
  head: { responseTimestamp: '1553498041521', version: 'v1', clientId: 'C11', signature: null },
  body: { resultInfo: { resultStatus: 'TXN_FAILURE', resultCode: '334', resultMsg: 'Invalid Order Id.' }, orderId: 'xxxxxxx', mid: 'xxxxxxxxxxxxxxxxxxxx' },
};

function txn(resultStatus: string, resultCode: string, resultMsg: string, extra: Record<string, unknown> = {}) {
  return reply({
    resultInfo: { resultStatus, resultCode, resultMsg },
    txnId: '20260117111212800110168307400852348',
    bankTxnId: '77700XXXX215242',
    orderId: 'c_1',
    txnAmount: '499.00',
    gatewayName: 'PPBLC',
    bankName: 'HDFC Bank',
    mid: MID,
    paymentMode: 'UPI',
    refundAmt: '0.00',
    txnDate: '2026-11-19 10:00:42.0',
    subsId: '130010',
    ...extra,
  });
}

describe('getCharge: Transaction Status', () => {
  it('asks the transaction-status host with {mid, orderId} and maps TXN_SUCCESS to succeeded, keeping the txnId, bank reference and result code in raw', async () => {
    const answer = txn('TXN_SUCCESS', '01', 'Txn Success');
    const { provider, calls } = makeProvider([{ url: TXN_URL, json: answer }]);
    const charge = await provider.getCharge('130010', 'c_1');
    const request = sent(calls[0] as never);
    expect(request.url.href).toBe(TXN_URL);
    expect(Object.keys(request.head)).toEqual(['signature']);
    expect(request.body).toEqual({ mid: MID, orderId: 'c_1' });
    expect(charge).toMatchObject({
      provider: 'paytm',
      id: 'c_1',
      reference: 'c_1',
      subscriptionId: '130010',
      kind: ChargeKind.Recurring,
      status: ChargeStatus.Succeeded,
      providerStatus: 'TXN_SUCCESS',
      amount: 49900,
      currency: 'INR',
      paidAt: '2026-11-19T04:30:42.000Z',
      paymentMethod: PaymentMethod.Upi,
    });
    expect(charge.failureCode).toBeUndefined();
    expect(charge.raw).toMatchObject({ txnId: '20260117111212800110168307400852348', bankTxnId: '77700XXXX215242', resultInfo: { resultCode: '01' } });
  });

  it('TXN_FAILURE with a bank decline is failed, with the code and reason; the 24-hour pre-notify gap (267) is a failure too', async () => {
    for (const [code, message] of [
      ['227', 'Your payment has been declined by your bank.'],
      ['267', 'Your payment has been declined by your bank since at least a 24 hours gap is not maintained between successful pre-notify and mandate execution.'],
      ['235', 'Wallet balance Insufficient'],
      ['810', 'Txn Failed'],
    ] as const) {
      const { provider } = makeProvider([{ url: TXN_URL, json: txn('TXN_FAILURE', code, message) }]);
      const charge = await provider.getCharge('130010', 'c_1');
      expect(charge).toMatchObject({ status: ChargeStatus.Failed, providerStatus: 'TXN_FAILURE', failureCode: code, failureReason: message });
      expect(charge.paidAt).toBeUndefined();
    }
  });

  it('PENDING (400, 402) is pending', async () => {
    for (const [code, message] of [['400', 'Transaction status not confirmed yet.'], ['402', 'Looks like the payment is not complete.']] as const) {
      const { provider } = makeProvider([{ url: TXN_URL, json: txn('PENDING', code, message) }]);
      expect(await provider.getCharge('130010', 'c_1')).toMatchObject({ status: ChargeStatus.Pending, providerStatus: 'PENDING' });
    }
  });

  it('an unknown status is pending (in flight) and visible verbatim: never a failure that would start a second debit', async () => {
    const { provider } = makeProvider([{ url: TXN_URL, json: txn('AWAITING_BANK', '999', 'x') }]);
    expect(await provider.getCharge('130010', 'c_1')).toMatchObject({ status: ChargeStatus.Pending, providerStatus: 'AWAITING_BANK' });
  });

  it('a refunded success keeps counting as collected: refunded for a full refund (the docs\' sample), partially_refunded for part', async () => {
    const full = makeProvider([{ url: TXN_URL, json: TXN_SAMPLE }]);
    expect(await full.provider.getCharge('130010', 'xxxxxxx')).toMatchObject({
      status: ChargeStatus.Refunded,
      amount: 10000,
      refundedAmount: 10000,
      paymentMethod: PaymentMethod.Card,
      paidAt: '2019-02-20T07:05:20.000Z',
    });
    const part = makeProvider([{ url: TXN_URL, json: txn('TXN_SUCCESS', '01', 'Txn Success', { refundAmt: '100.00' }) }]);
    expect(await part.provider.getCharge('130010', 'c_1')).toMatchObject({ status: ChargeStatus.PartiallyRefunded, refundedAmount: 10000 });
  });

  it('NO_RECORD_FOUND (331) is NOT_FOUND, and so is "Invalid Order Id" (334, the docs\' sample): Paytm has no trace of the order', async () => {
    const none = makeProvider([{ url: TXN_URL, json: reply({ resultInfo: { resultStatus: 'NO_RECORD_FOUND', resultCode: '331', resultMsg: 'No Record Found' } }) }]);
    expect(await errorOf(none.provider.getCharge('130010', 'c_1'))).toMatchObject({ code: ErrorCode.NotFound, providerCode: '331' });
    const invalid = makeProvider([{ url: TXN_URL, json: TXN_INVALID_ORDER }]);
    expect(await errorOf(invalid.provider.getCharge('130010', 'c_1'))).toMatchObject({ code: ErrorCode.NotFound, providerCode: '334' });
  });

  it('a TXN_FAILURE that is not a failed debit is an error, never a failed charge: wrong MID, "Server Down", generic faults', async () => {
    const cases: [string, ErrorCode][] = [
      ['335', ErrorCode.Config],
      ['501', ErrorCode.ProviderUnavailable],
      ['9999', ErrorCode.ProviderUnavailable],
      ['1001', ErrorCode.Validation],
    ];
    for (const [code, expected] of cases) {
      const { provider } = makeProvider([{ url: TXN_URL, json: txn('TXN_FAILURE', code, 'x') }]);
      expect(await errorOf(provider.getCharge('130010', 'c_1'))).toMatchObject({ code: expected, providerCode: code });
    }
  });

  it('a failure without txnAmount has amount 0; an answer without any result is UNEXPECTED_RESPONSE', async () => {
    const { provider } = makeProvider([{ url: TXN_URL, json: reply({ resultInfo: { resultStatus: 'TXN_FAILURE', resultCode: '227', resultMsg: 'declined' }, orderId: 'c_1' }) }]);
    expect(await provider.getCharge('130010', 'c_1')).toMatchObject({ status: ChargeStatus.Failed, amount: 0 });
    const empty = makeProvider([{ url: TXN_URL, json: reply({}) }]);
    expect((await errorOf(empty.provider.getCharge('130010', 'c_1'))).code).toBe(ErrorCode.UnexpectedResponse);
  });

  it('is a read: a transient failure is retried, a persistent one is PROVIDER_UNAVAILABLE (never NOT_FOUND)', async () => {
    const retried = makeProvider([{ url: TXN_URL, status: 503, text: 'busy' }, { url: TXN_URL, json: txn('PENDING', '400', 'x') }], {}, { maxRetries: 1 });
    (retried.provider as unknown as { http: { sleep: () => Promise<void> } }).http.sleep = async () => undefined;
    expect((await retried.provider.getCharge('130010', 'c_1')).status).toBe(ChargeStatus.Pending);
    const down = makeProvider([{ url: TXN_URL, status: 500, text: 'down' }]);
    expect((await errorOf(down.provider.getCharge('130010', 'c_1'))).code).toBe(ErrorCode.ProviderUnavailable);
    const dropped = makeProvider([{ url: TXN_URL, networkError: true }]);
    expect((await errorOf(dropped.provider.getCharge('130010', 'c_1'))).code).toBe(ErrorCode.Network);
  });

  it('refuses a blank or malformed charge id before any request', async () => {
    const { provider, calls } = makeProvider([]);
    for (const chargeId of ['', ' ', 'a|b', 'x'.repeat(51)]) {
      expect((await errorOf(provider.getCharge('130010', chargeId))).code).toBe(ErrorCode.Validation);
    }
    expect(calls).toHaveLength(0);
  });

  it('production uses the securegw.paytmpayments.in host, and transactionStatusBaseUrl overrides it', async () => {
    const live = makeProvider([{ url: `${PRODUCTION_GW}/v3/order/status`, json: txn('PENDING', '400', 'x') }], { environment: 'live' });
    await live.provider.getCharge('130010', 'c_1');
    const over = makeProvider([{ url: 'https://status.example/v3/order/status', json: txn('PENDING', '400', 'x') }], { transactionStatusBaseUrl: 'https://status.example' });
    await over.provider.getCharge('130010', 'c_1');
    // The JS Checkout page prints the .com host for this API; each API is sent where its own reference page says.
    expect(PRODUCTION).not.toBe(PRODUCTION_GW);
  });
});

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

/** Refund API answer, verbatim [refund / api_response SUCCESS]. */
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

describe('refundCharge: Refund API', () => {
  const REFUND = { chargeId: 'c_1', refundId: 'r_1' };

  it('looks up the txnId, then asks for the refund on the refund host; the answer is pending (the API is asynchronous)', async () => {
    const { provider, calls } = makeProvider([
      { url: TXN_URL, json: txn('TXN_SUCCESS', '01', 'Txn Success') },
      { url: REFUND_URL, json: REFUND_PENDING },
    ]);
    const refund = await provider.refundCharge({ ...REFUND, reason: 'customer request' });
    expect(sent(calls[0] as never).body).toEqual({ mid: MID, orderId: 'c_1' });
    const request = sent(calls[1] as never);
    expect(request.url.href).toBe(REFUND_URL);
    expect(Object.keys(request.head)).toEqual(['signature']);
    expect(request.body).toEqual({
      mid: MID,
      txnType: 'REFUND',
      orderId: 'c_1',
      txnId: '20260117111212800110168307400852348',
      refId: 'r_1',
      refundAmount: '499.00',
      comments: 'customer request',
    });
    expect(refund).toMatchObject({
      provider: 'paytm',
      id: 'PAYTM_REFUND_ID',
      reference: 'r_1',
      chargeId: 'c_1',
      status: RefundStatus.Pending,
      providerStatus: 'PENDING',
      amount: 100,
      currency: 'INR',
      createdAt: '2019-09-02T07:01:49.000Z',
    });
    expect(refund.raw).toEqual(REFUND_PENDING.body);
  });

  it('a partial refund sends that amount; one above the transaction is refused before the refund request', async () => {
    const part = makeProvider([
      { url: TXN_URL, json: txn('TXN_SUCCESS', '01', 'Txn Success') },
      { url: REFUND_URL, json: REFUND_PENDING },
    ]);
    await part.provider.refundCharge({ ...REFUND, amount: 10000, subscriptionId: undefined });
    expect(sent(part.calls[1] as never).body.refundAmount).toBe('100.00');
    const over = makeProvider([{ url: TXN_URL, json: txn('TXN_SUCCESS', '01', 'Txn Success') }]);
    expect((await errorOf(over.provider.refundCharge({ ...REFUND, amount: 49901 }))).code).toBe(ErrorCode.Validation);
    expect(over.calls).toHaveLength(1);
  });

  it('only a successful debit can be refunded; one Paytm does not know is NOT_FOUND', async () => {
    for (const answer of [txn('TXN_FAILURE', '227', 'declined'), txn('PENDING', '400', 'x')]) {
      const { provider, calls } = makeProvider([{ url: TXN_URL, json: answer }]);
      expect((await errorOf(provider.refundCharge(REFUND))).code).toBe(ErrorCode.Validation);
      expect(calls).toHaveLength(1);
    }
    const none = makeProvider([{ url: TXN_URL, json: reply({ resultInfo: { resultStatus: 'NO_RECORD_FOUND', resultCode: '331', resultMsg: 'No Record Found' } }) }]);
    expect((await errorOf(none.provider.refundCharge(REFUND))).code).toBe(ErrorCode.NotFound);
  });

  it('refuses a refund on eNACH / bank mandate (Paytm: "Refunds are currently not supported"), by the debit\'s mode and by the subscription\'s', async () => {
    for (const mode of ['BANK_MANDATE', 'BANKMANDATE']) {
      const { provider, calls } = makeProvider([{ url: TXN_URL, json: txn('TXN_SUCCESS', '01', 'Txn Success', { paymentMode: mode }) }]);
      const error = await errorOf(provider.refundCharge(REFUND));
      expect(error.code).toBe(ErrorCode.Unsupported);
      expect(error.message).toMatch(/eNACH/);
      expect(calls).toHaveLength(1);
    }
    const bySubscription = makeProvider([
      { url: TXN_URL, json: txn('TXN_SUCCESS', '01', 'Txn Success', { paymentMode: 'NB' }) },
      { url: STATUS_URL, json: statusAnswer({ subsPaymentInstDetails: { paymentMode: 'BANK_MANDATE' } }) },
    ]);
    expect((await errorOf(bySubscription.provider.refundCharge({ ...REFUND, subscriptionId: '130010' }))).code).toBe(ErrorCode.Unsupported);
    const upi = makeProvider([
      { url: TXN_URL, json: txn('TXN_SUCCESS', '01', 'Txn Success') },
      { url: STATUS_URL, json: statusAnswer() },
      { url: REFUND_URL, json: REFUND_PENDING },
    ]);
    expect((await upi.provider.refundCharge({ ...REFUND, subscriptionId: '130010' })).subscriptionId).toBe('130010');
  });

  it('a final answer is succeeded; its amount is Paytm\'s', async () => {
    const { provider } = makeProvider([
      { url: TXN_URL, json: txn('TXN_SUCCESS', '01', 'Txn Success') },
      { url: REFUND_URL, json: reply({ resultInfo: { resultStatus: 'TXN_SUCCESS', resultCode: '10', resultMsg: 'Refund successful' }, refundId: 'rf_9', refundAmount: '499.00' }) },
    ]);
    expect(await provider.refundCharge(REFUND)).toMatchObject({ id: 'rf_9', status: RefundStatus.Succeeded, providerStatus: 'TXN_SUCCESS', amount: 49900 });
  });

  const refusals: [string, ErrorCode][] = [
    ['617', ErrorCode.Conflict],
    ['671', ErrorCode.Conflict],
    ['626', ErrorCode.Conflict],
    ['629', ErrorCode.Conflict],
    ['619', ErrorCode.Validation],
    ['635', ErrorCode.Validation],
    ['656', ErrorCode.Validation],
    ['673', ErrorCode.NotFound],
    ['657', ErrorCode.Unsupported],
    ['678', ErrorCode.Unsupported],
    ['330', ErrorCode.Auth],
    ['672', ErrorCode.ProviderError],
    ['999', ErrorCode.ProviderError],
  ];
  for (const [code, expected] of refusals) {
    it(`TXN_FAILURE ${code} is ${expected}`, async () => {
      const { provider } = makeProvider([
        { url: TXN_URL, json: txn('TXN_SUCCESS', '01', 'Txn Success') },
        { url: REFUND_URL, json: reply({ resultInfo: { resultStatus: 'TXN_FAILURE', resultCode: code, resultMsg: 'no' } }) },
      ]);
      expect(await errorOf(provider.refundCharge(REFUND))).toMatchObject({ code: expected, providerCode: code });
    });
  }

  it('a lost answer and an answer without a verdict are OUTCOME_UNKNOWN; a txn without a txnId is UNEXPECTED_RESPONSE', async () => {
    const lost = makeProvider([{ url: TXN_URL, json: txn('TXN_SUCCESS', '01', 'Txn Success') }, { url: REFUND_URL, networkError: true }]);
    expect((await errorOf(lost.provider.refundCharge(REFUND))).code).toBe(ErrorCode.OutcomeUnknown);
    const none = makeProvider([{ url: TXN_URL, json: txn('TXN_SUCCESS', '01', 'Txn Success') }, { url: REFUND_URL, json: reply({}) }]);
    expect((await errorOf(none.provider.refundCharge(REFUND))).code).toBe(ErrorCode.OutcomeUnknown);
    const noId = makeProvider([{ url: TXN_URL, json: txn('TXN_SUCCESS', '01', 'Txn Success', { txnId: undefined }) }]);
    expect((await errorOf(noId.provider.refundCharge(REFUND))).code).toBe(ErrorCode.UnexpectedResponse);
  });

  it('refundBaseUrl overrides the refund host, production uses securegw.paytmpayments.in', async () => {
    const live = makeProvider(
      [
        { url: `${PRODUCTION_GW}/v3/order/status`, json: txn('TXN_SUCCESS', '01', 'Txn Success') },
        { url: 'https://refund.example/refund/apply', json: REFUND_PENDING },
      ],
      { environment: 'live', refundBaseUrl: 'https://refund.example' },
    );
    await live.provider.refundCharge(REFUND);
    expect(live.remaining()).toBe(0);
  });
});
