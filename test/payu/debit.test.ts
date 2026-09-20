import { describe, expect, it } from 'vitest';
import { ChargeKind, ChargeStatus, ErrorCode, PaymentMethod } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import { SALT, TEST_API_URL, apiRoute, expectedCommandHash, makeProvider, var1Of } from './helpers.js';

async function failure(run: () => Promise<unknown>): Promise<SubscriptionError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(SubscriptionError);
    return error as SubscriptionError;
  }
  throw new Error('expected an error');
}

const CARD_ID = 'card:25511473084';
const UPI_ID = 'upi:25600438037';
const ENACH_ID = 'enach:403993715525331373';

// ---------------------------------------------------------------------------
// Pre-debit notification
// ---------------------------------------------------------------------------

/** Source: reference__pre_debit_notification_api, "Cards success response". */
const PRE_DEBIT_CARD_OK = {
  invoiceid: '76323425',
  approvedStatus: 'na',
  invoiceStatus: 'unpaid',
  amount: '100.00',
  status: 1,
  message: 'Invoice Created Successfully',
  action: 'MANDATE_PRE_DEBIT',
};

/** Source: reference__pre_debit_notification_api, "UPI success response". */
const PRE_DEBIT_UPI_OK = { status: 1, action: 'MANDATE_PRE_DEBIT', message: 'Request Processed Successfully' };

const NOTIFICATION = {
  notificationId: '9a900b2f-85e2-4034-aaa9-9c71e1d2af14',
  amount: 10000,
  // 10:30 on 20 March 2026 in IST
  debitAt: '2026-03-20T05:00:00.000Z',
  invoiceNumber: '19976ec0-c01f-4f6f-886b-8ea614f5fd83',
};

describe('notifyCharge', () => {
  it('cards: pre_debit_SI with the var1 of the docs sample, hashed as posted', async () => {
    const { provider, calls } = makeProvider([apiRoute(PRE_DEBIT_CARD_OK)]);
    const notification = await provider.notifyCharge({ subscriptionId: CARD_ID, ...NOTIFICATION });

    // Source of the field set and values: reference__pre_debit_notification_api, "Cards request".
    const var1 =
      '{"authpayuid":"25511473084","requestId":"9a900b2f-85e2-4034-aaa9-9c71e1d2af14","amount":"100.00","debitDate":"2026-03-20","invoiceDisplayNumber":"19976ec0-c01f-4f6f-886b-8ea614f5fd83"}';
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe(TEST_API_URL);
    expect(calls[0]!.form).toEqual({ key: 'BmTY3G', command: 'pre_debit_SI', var1, hash: expectedCommandHash('pre_debit_SI', var1) });
    expect(calls[0]!.body).not.toContain(SALT);

    expect(notification).toMatchObject({
      provider: 'payu',
      id: '76323425',
      subscriptionId: CARD_ID,
      accepted: true,
      providerStatus: '1',
      amount: 10000,
      debitAt: NOTIFICATION.debitAt,
      invoiceNumber: NOTIFICATION.invoiceNumber,
    });
    expect(notification.raw).toEqual(PRE_DEBIT_CARD_OK);
  });

  it('UPI: the same command; with no invoiceDisplayNumber the adapter makes one from the notification id and echoes it', async () => {
    const { provider, calls } = makeProvider([apiRoute(PRE_DEBIT_UPI_OK)]);
    const notification = await provider.notifyCharge({
      subscriptionId: UPI_ID,
      notificationId: 'ntf_abc_0_1_1',
      amount: 12500,
      debitAt: NOTIFICATION.debitAt,
    });
    expect(var1Of(calls[0]!)).toEqual({
      authpayuid: '25600438037',
      requestId: 'ntf_abc_0_1_1',
      amount: '125.00',
      debitDate: '2026-03-20',
      invoiceDisplayNumber: 'INV_ntf_abc_0_1_1',
    });
    expect(notification).toMatchObject({ accepted: true, id: 'ntf_abc_0_1_1', invoiceNumber: 'INV_ntf_abc_0_1_1', amount: 12500 });
  });

  it('debitDate is the IST date: 01:30 IST on the 20th is still the 19th in UTC', async () => {
    const { provider, calls } = makeProvider([apiRoute(PRE_DEBIT_UPI_OK)]);
    await provider.notifyCharge({ subscriptionId: UPI_ID, ...NOTIFICATION, debitAt: '2026-03-19T20:00:00.000Z' });
    expect(var1Of(calls[0]!).debitDate).toBe('2026-03-20');
  });

  it('eNACH needs no pre-debit: accepted without any request', async () => {
    const { provider, calls } = makeProvider();
    const notification = await provider.notifyCharge({ subscriptionId: ENACH_ID, ...NOTIFICATION });
    expect(calls).toHaveLength(0);
    expect(notification).toMatchObject({ accepted: true, providerStatus: 'not_required', invoiceNumber: NOTIFICATION.invoiceNumber });
  });

  /** Source: reference__pre_debit_notification_api, "Scenario table (verbatim payloads)". */
  it.each([
    ['Duplicate Pre-debit (a retry after a lost answer): accepted', { status: 'E9254', action: 'MANDATE_PRE_DEBIT', message: 'Predebit notification already sent for the mandate sequence no.:2' }, true, 'E9254'],
    ['Execution Already Exists', { status: 'E9256', action: 'MANDATE_PRE_DEBIT', message: 'Execution already sent for the mandate sequence no.:2' }, false, 'E9256: Execution already sent for the mandate sequence no.:2'],
    ['Too Far in Advance', { status: 'E9260', action: 'MANDATE_PRE_DEBIT', message: 'Predebit notification can only be sent for a maximum 30 days in advance.' }, false, 'E9260: Predebit notification can only be sent for a maximum 30 days in advance.'],
    ['Incorrect Time Period', { status: 'E9263', action: 'MANDATE_PRE_DEBIT', message: 'Predebit for calculated sequence sent during incorrect period' }, false, 'E9263: Predebit for calculated sequence sent during incorrect period'],
    ['Mandate Revoked (bank/NPCI)', { status: 'QC', action: 'MANDATE_PRE_DEBIT', message: 'MANDATE HAS BEEN REVOKED' }, false, 'QC: MANDATE HAS BEEN REVOKED'],
    ['status 0: failed to trigger, retry later', { status: 0, action: 'MANDATE_PRE_DEBIT', message: 'Try again later' }, false, '0: Try again later'],
    ['the string "1"', { status: '1', action: 'MANDATE_PRE_DEBIT', message: 'ok' }, true, '1'],
  ])('%s', async (_label, body, accepted, providerStatus) => {
    const { provider } = makeProvider([apiRoute(body)]);
    const notification = await provider.notifyCharge({ subscriptionId: UPI_ID, ...NOTIFICATION });
    expect(notification.accepted).toBe(accepted);
    expect(notification.providerStatus).toBe(providerStatus);
  });

  it.each([
    ['Invalid value for mandateSeqNo', { status: 0, message: 'Invalid value for mandateSeqNo', action: 'MANDATE_PRE_DEBIT' }, ErrorCode.Validation],
    ['Mandate is not active', { status: 0, action: 'MANDATE_PRE_DEBIT', message: 'Mandate is not active' }, ErrorCode.Conflict],
    ['Invalid Hash.', { status: 0, msg: 'Invalid Hash.' }, ErrorCode.Auth],
  ])('a body-level "%s" is thrown as %s', async (_label, body, code) => {
    const { provider } = makeProvider([apiRoute(body)]);
    expect((await failure(() => provider.notifyCharge({ subscriptionId: CARD_ID, ...NOTIFICATION }))).code).toBe(code);
  });

  it('a dropped connection is OUTCOME_UNKNOWN (a notification is not idempotent) and is not retried', async () => {
    const { provider, calls } = makeProvider([{ method: 'POST', url: TEST_API_URL, networkError: true }], {}, { maxRetries: 3 });
    const error = await failure(() => provider.notifyCharge({ subscriptionId: CARD_ID, ...NOTIFICATION }));
    expect(error.code).toBe(ErrorCode.OutcomeUnknown);
    expect(calls).toHaveLength(1);
  });

  it('an undecodable subscription id is VALIDATION without a request', async () => {
    const { provider, calls } = makeProvider();
    expect((await failure(() => provider.notifyCharge({ subscriptionId: '25511473084', ...NOTIFICATION }))).code).toBe(ErrorCode.Validation);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Recurring debit
// ---------------------------------------------------------------------------

/** Source: reference__recurring_payment_api, "Success response" (the transaction is keyed by its txnid). */
const SI_SUCCESS = {
  status: 1,
  message: 'Transaction Processed successfully',
  details: {
    REC15113506209: {
      authpayuid: '25600342065',
      transactionid: 'REC15113506209',
      amount: '1.00',
      user_credentials: '',
      card_token: '',
      payuid: '',
      status: 'captured',
      udf1: '',
      field9: 'Transaction Completed Successfully',
      udf2: '',
      udf3: '',
      udf4: '',
      udf5: '',
      phone: '9999999999',
      email: 'chota.bheem@gmail.com',
    },
  },
};

/** Source: reference__recurring_payment_api, the failure inside a `status: 1` envelope. */
const SI_FAILED_IN_ENVELOPE = {
  status: 1,
  message: 'Transaction Processed successfully',
  details: {
    REC9812123123: {
      authpayuid: '6611192559',
      transactionid: 'REC9812123123',
      amount: '1',
      user_credentials: ' ',
      card_token: ' ',
      payuid: '',
      status: 'failed',
      field9: 'Basic authentication check failed',
      phone: '',
      email: '',
    },
  },
};

function debitOf(txnid: string, status: string, extra: Record<string, unknown> = {}): unknown {
  return {
    status: 1,
    message: 'Transaction Processed successfully',
    details: { [txnid]: { authpayuid: '25600342065', transactionid: txnid, amount: '1.00', payuid: '', status, field9: 'x', ...extra } },
  };
}

describe('createCharge', () => {
  it('cards: si_transaction with authpayuid, invoiceDisplayNumber, rupee amount, txnid and customer details', async () => {
    const { provider, calls } = makeProvider([apiRoute(SI_SUCCESS)]);
    const charge = await provider.createCharge({
      subscriptionId: 'card:25600342065',
      chargeId: 'REC15113506209',
      amount: 100,
      invoiceNumber: '12345678910',
      customer: { phone: '+919999999999', email: 'chota.bheem@gmail.com' },
    });

    // Field set and order: reference__recurring_payment_api, "Request".
    const var1 =
      '{"authpayuid":"25600342065","invoiceDisplayNumber":"12345678910","amount":"1.00","txnid":"REC15113506209","phone":"9999999999","email":"chota.bheem@gmail.com"}';
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(TEST_API_URL);
    expect(calls[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(calls[0]!.form).toEqual({ key: 'BmTY3G', command: 'si_transaction', var1, hash: expectedCommandHash('si_transaction', var1) });

    expect(charge).toMatchObject({
      provider: 'payu',
      // payuid is blank while the debit is young: the txnid stands in.
      id: 'REC15113506209',
      reference: 'REC15113506209',
      subscriptionId: 'card:25600342065',
      kind: ChargeKind.Recurring,
      status: ChargeStatus.Succeeded,
      providerStatus: 'captured',
      amount: 100,
      currency: 'INR',
      paymentMethod: PaymentMethod.Card,
    });
  });

  it('keeps the PayU payment id when PayU has one', async () => {
    const { provider } = makeProvider([apiRoute(debitOf('chg_1', 'captured', { payuid: '30141596997' }))]);
    const charge = await provider.createCharge({ subscriptionId: CARD_ID, chargeId: 'chg_1', amount: 100 });
    expect(charge.id).toBe('30141596997');
    expect(charge.reference).toBe('chg_1');
  });

  it('UPI sends an invoice display number; eNACH does not', async () => {
    const upi = makeProvider([apiRoute(debitOf('chg_u', 'pending'))]);
    await upi.provider.createCharge({ subscriptionId: UPI_ID, chargeId: 'chg_u', amount: 12500 });
    expect(var1Of(upi.calls[0]!)).toEqual({
      authpayuid: '25600438037',
      invoiceDisplayNumber: 'INV_chg_u',
      amount: '125.00',
      txnid: 'chg_u',
    });
    const enach = makeProvider([apiRoute(debitOf('chg_e', 'pending'))]);
    await enach.provider.createCharge({ subscriptionId: ENACH_ID, chargeId: 'chg_e', amount: 12500, invoiceNumber: 'IGNORED' });
    expect(var1Of(enach.calls[0]!)).toEqual({ authpayuid: '403993715525331373', amount: '125.00', txnid: 'chg_e' });
  });

  it('scheduledAt is ignored: PayU debits when called', async () => {
    const { provider, calls } = makeProvider([apiRoute(debitOf('chg_s', 'pending'))]);
    await provider.createCharge({ subscriptionId: UPI_ID, chargeId: 'chg_s', amount: 100, scheduledAt: '2027-01-01T00:00:00.000Z' });
    expect(calls[0]!.body).not.toContain('2027');
  });

  /** Every documented inner status, then blank, then one PayU has not documented. Source: reference__recurring_payment_api 6.5. */
  it.each([
    ['captured', ChargeStatus.Succeeded],
    ['pending', ChargeStatus.Pending],
    ['in-progress', ChargeStatus.Pending],
    ['in progress', ChargeStatus.Pending],
    ['failed', ChargeStatus.Failed],
    ['', ChargeStatus.Failed],
    ['something_new', ChargeStatus.Pending],
  ])('inner status "%s" is %s', async (status, expected) => {
    const { provider } = makeProvider([apiRoute(debitOf('chg_x', status))]);
    const charge = await provider.createCharge({ subscriptionId: UPI_ID, chargeId: 'chg_x', amount: 100 });
    expect(charge.status).toBe(expected);
    if (status !== '') expect(charge.providerStatus).toBe(status);
  });

  it('a failed debit inside a status-1 envelope is a failed Charge with PayU\'s reason, not an exception', async () => {
    const { provider } = makeProvider([apiRoute(SI_FAILED_IN_ENVELOPE)]);
    const charge = await provider.createCharge({ subscriptionId: 'card:6611192559', chargeId: 'REC9812123123', amount: 100 });
    expect(charge).toMatchObject({ status: ChargeStatus.Failed, failureReason: 'Basic authentication check failed' });
  });

  it('a dropped connection is OUTCOME_UNKNOWN, sent once, never retried', async () => {
    const { provider, calls } = makeProvider([{ method: 'POST', url: TEST_API_URL, networkError: true }], {}, { maxRetries: 5 });
    const error = await failure(() => provider.createCharge({ subscriptionId: CARD_ID, chargeId: 'chg_1', amount: 100 }));
    expect(error.code).toBe(ErrorCode.OutcomeUnknown);
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('fetch the current state');
    expect(calls).toHaveLength(1);
  });

  it('an HTTP 502 / 504 is OUTCOME_UNKNOWN too', async () => {
    for (const status of [502, 504]) {
      const { provider } = makeProvider([apiRoute({ msg: 'gateway' }, status)]);
      expect((await failure(() => provider.createCharge({ subscriptionId: CARD_ID, chargeId: 'c', amount: 100 }))).code).toBe(
        ErrorCode.OutcomeUnknown,
      );
    }
  });

  it.each([
    ['Invalid Hash.', { status: 0, msg: 'Invalid Hash.' }, ErrorCode.Auth],
    ['debitDate is mandatory', { status: 0, message: 'debitDate is mandatory', errorCode: 'SIR004', action: 'SI_RECURRING' }, ErrorCode.Validation],
    ['Missing mandatory field: zipcode', { status: 0, message: 'Missing mandatory field: zipcode' }, ErrorCode.Validation],
    ['Mandate is not active', { status: 0, message: 'Mandate is not active' }, ErrorCode.Conflict],
    ['INTERNAL_ERROR (ER1002): unclear', { status: 422, errorCode: 'ER1002', errorMessage: 'INTERNAL_ERROR' }, ErrorCode.OutcomeUnknown],
    ['a failure nobody documented: unclear', { status: 0, message: 'Something else' }, ErrorCode.OutcomeUnknown],
  ])('body-level "%s" is %s', async (_label, body, code) => {
    const { provider } = makeProvider([apiRoute(body)]);
    const error = await failure(() => provider.createCharge({ subscriptionId: CARD_ID, chargeId: 'c', amount: 100 }));
    expect(error.code).toBe(code);
    expect(error.message).not.toContain(SALT);
  });

  it('an answer without a result for the txnid is UNEXPECTED_RESPONSE (reconcile with getCharge)', async () => {
    for (const body of [{ status: 1, message: 'ok', details: [] }, { status: 1, message: 'ok' }, debitOf('another_txn', 'captured')]) {
      const { provider } = makeProvider([apiRoute(body)]);
      const error = await failure(() => provider.createCharge({ subscriptionId: CARD_ID, chargeId: 'chg_1', amount: 100 }));
      expect(error.code).toBe(ErrorCode.UnexpectedResponse);
      expect(error.message).toContain('getCharge');
    }
  });

  it('a non-JSON answer is UNEXPECTED_RESPONSE', async () => {
    const { provider } = makeProvider([{ method: 'POST', url: TEST_API_URL, text: '<html>maintenance</html>' }]);
    expect((await failure(() => provider.createCharge({ subscriptionId: CARD_ID, chargeId: 'c', amount: 100 }))).code).toBe(
      ErrorCode.UnexpectedResponse,
    );
  });

  it('validates input before sending: bad id, non-positive amount', async () => {
    const { provider, calls } = makeProvider();
    expect((await failure(() => provider.createCharge({ subscriptionId: 'nope', chargeId: 'c', amount: 100 }))).code).toBe(ErrorCode.Validation);
    expect((await failure(() => provider.createCharge({ subscriptionId: CARD_ID, chargeId: 'c', amount: 0 }))).code).toBe(ErrorCode.Validation);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getCharge
// ---------------------------------------------------------------------------

/**
 * Source: reference__verify-si-payment-status, "Response — recurring success" (the key is replaced by the txnid
 * this test asks for: verify_payment is keyed by txnid).
 */
const VERIFIED_RECURRING = {
  status: 1,
  msg: '1 out of 1 Transactions Fetched Successfully',
  transaction_details: {
    chg_1: {
      mihpayid: '30141596997',
      request_id: '',
      bank_ref_num: '622716418717',
      amt: '0.00',
      transaction_amount: '1.00',
      txnid: 'chg_1',
      additional_charges: '0.00',
      productinfo: 'SI',
      firstname: '',
      bankcode: 'CCSI',
      udf1: '',
      field9: 'Transaction Completed',
      error_code: 'E000',
      addedon: '2026-08-15 22:00:04',
      payment_source: 'sirecurring',
      card_type: 'MAST',
      error_Message: 'NO ERROR',
      net_amount_debit: 1.0,
      disc: '0.00',
      mode: 'SI',
      PG_TYPE: 'SI-PG',
      card_no: 'XXXXXXXXXXXXXXXX',
      status: 'success',
      unmappedstatus: 'captured',
      Merchant_UTR: null,
      Settled_At: null,
      card_token: null,
      offerAvailed: null,
    },
  },
};

/** Source: reference__verify_payment_api, "Failure Responses": the txnid is unknown. */
const VERIFY_NOT_FOUND = {
  status: 0,
  msg: '0 out of 1 Transactions Fetched Successfully',
  transaction_details: { chg_1: { mihpayid: 'Not Found', status: 'Not Found' } },
};

function verifiedOf(status: string | null, unmappedstatus: string | null, extra: Record<string, unknown> = {}): unknown {
  return {
    status: 1,
    msg: '1 out of 1 Transactions Fetched Successfully',
    transaction_details: {
      chg_1: { mihpayid: '30141596997', txnid: 'chg_1', transaction_amount: '1.00', status, unmappedstatus, ...extra },
    },
  };
}

describe('getCharge', () => {
  it('verify_payment with the txnid as var1; maps a captured recurring debit', async () => {
    const { provider, calls } = makeProvider([apiRoute(VERIFIED_RECURRING)]);
    const charge = await provider.getCharge(CARD_ID, 'chg_1');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.form).toEqual({ key: 'BmTY3G', command: 'verify_payment', var1: 'chg_1', hash: expectedCommandHash('verify_payment', 'chg_1') });
    expect(charge).toMatchObject({
      provider: 'payu',
      id: '30141596997',
      reference: 'chg_1',
      subscriptionId: CARD_ID,
      kind: ChargeKind.Recurring,
      status: ChargeStatus.Succeeded,
      providerStatus: 'captured',
      amount: 100,
      // addedon is IST: 22:00:04 IST = 16:30:04Z
      paidAt: '2026-08-15T16:30:04.000Z',
      paymentMethod: PaymentMethod.Card,
    });
  });

  it('an unknown txnid is NOT_FOUND (the scheduler relies on it to know a debit never reached PayU)', async () => {
    const { provider } = makeProvider([apiRoute(VERIFY_NOT_FOUND)]);
    const error = await failure(() => provider.getCharge(CARD_ID, 'chg_1'));
    expect(error.code).toBe(ErrorCode.NotFound);
    expect(error.provider).toBe('payu');
  });

  it('"0 out of 1 Transactions Fetched" without a detail is NOT_FOUND too', async () => {
    const { provider } = makeProvider([apiRoute({ status: 0, msg: '0 out of 1 Transactions Fetched Successfully' })]);
    expect((await failure(() => provider.getCharge(CARD_ID, 'chg_1'))).code).toBe(ErrorCode.NotFound);
  });

  it('is a read: an HTTP 5xx is PROVIDER_UNAVAILABLE, never NOT_FOUND', async () => {
    const { provider } = makeProvider([apiRoute({ msg: 'down' }, 503)]);
    expect((await failure(() => provider.getCharge(CARD_ID, 'chg_1'))).code).toBe(ErrorCode.ProviderUnavailable);
  });

  /**
   * Every state PayU documents (fact sheet 8.1 and 8.4), then one it does not.
   * `autoRefund` is failed, not refunded: the scheduler counts a refunded charge as collected.
   */
  it.each([
    ['success', 'captured', ChargeStatus.Succeeded],
    ['success', 'auth', ChargeStatus.Pending],
    ['pending', 'pending', ChargeStatus.Pending],
    ['pending', null, ChargeStatus.Pending],
    ['in progress', null, ChargeStatus.Pending],
    ['pending', 'initiated', ChargeStatus.Pending],
    ['pending', 'in progress', ChargeStatus.Pending],
    ['failure', 'failed', ChargeStatus.Failed],
    ['failure', null, ChargeStatus.Failed],
    ['failure', 'bounced', ChargeStatus.Failed],
    ['failure', 'dropped', ChargeStatus.Failed],
    ['failure', 'autoRefund', ChargeStatus.Failed],
    ['failure', 'userCancelled', ChargeStatus.Cancelled],
    ['success', 'cancelled', ChargeStatus.Cancelled],
    ['success', null, ChargeStatus.Succeeded],
    ['brand_new', 'brand_new_too', ChargeStatus.Pending],
  ])('status %s / unmappedstatus %s is %s', async (status, unmapped, expected) => {
    const { provider } = makeProvider([apiRoute(verifiedOf(status, unmapped))]);
    const charge = await provider.getCharge(UPI_ID, 'chg_1');
    expect(charge.status).toBe(expected);
    expect(charge.providerStatus).toBe(unmapped ?? status);
  });

  it('a failed debit carries PayU\'s error code and reason', async () => {
    const { provider } = makeProvider([
      apiRoute(verifiedOf('failure', 'failed', { error_code: 'E1903', error_Message: 'Authorization failed at Bank', field9: 'Authorization failed at Bank' })),
    ]);
    const charge = await provider.getCharge(CARD_ID, 'chg_1');
    expect(charge).toMatchObject({ status: ChargeStatus.Failed, failureCode: 'E1903', failureReason: 'Authorization failed at Bank' });
  });

  it('a transaction payment_source=sist is the consent, kind authorization', async () => {
    const { provider } = makeProvider([apiRoute(verifiedOf('success', 'captured', { payment_source: 'sist' }))]);
    expect((await provider.getCharge(CARD_ID, 'chg_1')).kind).toBe(ChargeKind.Authorization);
  });

  it('rejects a txnid that PayU would read as a list, and a bad subscription id, before any request', async () => {
    const { provider, calls } = makeProvider();
    expect((await failure(() => provider.getCharge(CARD_ID, 'a|b'))).code).toBe(ErrorCode.Validation);
    expect((await failure(() => provider.getCharge('bad', 'chg_1'))).code).toBe(ErrorCode.Validation);
    expect(calls).toHaveLength(0);
  });

  it('a bad hash answer is AUTH', async () => {
    const { provider } = makeProvider([apiRoute({ status: 0, msg: 'Invalid Hash.' })]);
    expect((await failure(() => provider.getCharge(CARD_ID, 'chg_1'))).code).toBe(ErrorCode.Auth);
  });
});
