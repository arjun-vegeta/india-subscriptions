import { describe, expect, it } from 'vitest';
import { ErrorCode, RefundStatus } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import { SALT, TEST_API_URL, apiRoute, expectedCommandHash, makeProvider } from './helpers.js';

async function failure(run: () => Promise<unknown>): Promise<SubscriptionError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(SubscriptionError);
    return error as SubscriptionError;
  }
  throw new Error('expected an error');
}

const SUBSCRIPTION_ID = 'card:25600342065';

/** The debit's lookup, shaped like reference__verify-si-payment-status "Response — recurring success", keyed by txnid. */
const FOUND = {
  status: 1,
  msg: '1 out of 1 Transactions Fetched Successfully',
  transaction_details: {
    chg_1: {
      mihpayid: '30141596997',
      txnid: 'chg_1',
      transaction_amount: '499.00',
      net_amount_debit: 499.0,
      status: 'success',
      unmappedstatus: 'captured',
    },
  },
};

const NOT_FOUND = {
  status: 0,
  msg: '0 out of 1 Transactions Fetched Successfully',
  transaction_details: { chg_1: { mihpayid: 'Not Found', status: 'Not Found' } },
};

/**
 * Shape of reference__refund_transaction_api "Sample response (captured transaction)". The docs print placeholders
 * ("Request ID"); a plausible PayU refund id is used instead.
 */
const QUEUED = { status: 1, msg: 'Refund Request Queued', request_id: '17265314530', bank_ref_num: '100142082006', mihpayid: '30141596997' };

describe('refundCharge', () => {
  it('looks the debit up by txnid, then cancel_refund_transaction: var1 = mihpayid (the only hashed field), var2 = token, var3 = rupees', async () => {
    const { provider, calls } = makeProvider([apiRoute(FOUND), apiRoute(QUEUED)]);
    const refund = await provider.refundCharge({ subscriptionId: SUBSCRIPTION_ID, chargeId: 'chg_1', refundId: 'rf_chg_1' });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.form).toEqual({ key: 'BmTY3G', command: 'verify_payment', var1: 'chg_1', hash: expectedCommandHash('verify_payment', 'chg_1') });
    expect(calls[1]!.url).toBe(TEST_API_URL);
    expect(calls[1]!.form).toEqual({
      key: 'BmTY3G',
      command: 'cancel_refund_transaction',
      var1: '30141596997',
      var2: 'rf_chg_1',
      var3: '499.00',
      // sha512(key|command|var1|salt): var2 and var3 are not covered (hashing page and PayU's SDK).
      hash: expectedCommandHash('cancel_refund_transaction', '30141596997'),
    });
    expect(calls[1]!.body).not.toContain(SALT);

    expect(refund).toMatchObject({
      provider: 'payu',
      id: '17265314530',
      reference: 'rf_chg_1',
      chargeId: 'chg_1',
      subscriptionId: SUBSCRIPTION_ID,
      status: RefundStatus.Pending,
      providerStatus: 'Refund Request Queued',
      amount: 49900,
      currency: 'INR',
    });
  });

  it('a partial amount is sent as var3; a reason becomes var9 without the characters PayU forbids', async () => {
    const { provider, calls } = makeProvider([apiRoute(FOUND), apiRoute(QUEUED)]);
    const refund = await provider.refundCharge({
      chargeId: 'chg_1',
      refundId: 'rf_2',
      amount: 5000,
      reason: 'Customer asked #1 & said "thanks" [ok]',
    });
    expect(calls[1]!.form).toMatchObject({
      var3: '50.00',
      var9: '{"refundDetails":{"remarks":"Customer asked 1 said \\"thanks\\" ok"}}',
    });
    expect(refund.amount).toBe(5000);
  });

  it('a payment id PayU does not know as a txnid is used as the payment id, with an explicit amount', async () => {
    const { provider, calls } = makeProvider([apiRoute(NOT_FOUND), apiRoute(QUEUED)]);
    await provider.refundCharge({ chargeId: '30141596997', refundId: 'rf_3', amount: 100 });
    expect(calls[1]!.form).toMatchObject({ var1: '30141596997', var3: '1.00' });
  });

  it('...but without an amount it cannot know what to refund: VALIDATION, and nothing is sent', async () => {
    const { provider, calls } = makeProvider([apiRoute(NOT_FOUND)]);
    const error = await failure(() => provider.refundCharge({ chargeId: '30141596997', refundId: 'rf_3' }));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(calls).toHaveLength(1);
  });

  it('a charge id that is neither a txnid PayU knows nor a payment id is NOT_FOUND', async () => {
    const { provider } = makeProvider([apiRoute(NOT_FOUND)]);
    expect((await failure(() => provider.refundCharge({ chargeId: 'chg_1', refundId: 'rf_4', amount: 100 }))).code).toBe(ErrorCode.NotFound);
  });

  /** Source: reference__error-codes-for-refund-initiation: 102 is queued, 100 success, 101 pending. */
  it.each([
    ['102', RefundStatus.Pending],
    ['101', RefundStatus.Pending],
    ['100', RefundStatus.Succeeded],
  ])('error_code %s is a %s refund', async (code, status) => {
    const { provider } = makeProvider([apiRoute(FOUND), apiRoute({ ...QUEUED, error_code: code })]);
    expect((await provider.refundCharge({ chargeId: 'chg_1', refundId: 'rf_5' })).status).toBe(status);
  });

  it.each([
    ['232 refunds not supported (eNACH)', { status: 0, msg: 'Refund not accepted for txn', error_code: '232' }, ErrorCode.Unsupported],
    ['236 refund not possible', { status: 0, msg: 'Refund not possible on this transaction', error_code: '236' }, ErrorCode.Unsupported],
    ['116 transaction not found', { status: 0, msg: 'Transaction Not Found', error_code: '116' }, ErrorCode.NotFound],
    ['106 token exists', { status: 0, msg: 'Token already exists.', error_code: '106' }, ErrorCode.Conflict],
    ['105 invalid amount', { status: 0, msg: 'Invalid amount', error_code: '105' }, ErrorCode.Validation],
    ['111 invalid transaction status', { status: 0, msg: 'Invalid transaction status', error_code: '111' }, ErrorCode.Conflict],
    ['214 duplicate amount window', { status: 0, msg: 'Two refunds of same amount', error_code: '214' }, ErrorCode.Conflict],
    ['an unlisted code', { status: 0, msg: 'Something', error_code: '999' }, ErrorCode.ProviderError],
    ['status 1 with a non-success code', { status: 1, msg: 'Odd', error_code: '555' }, ErrorCode.ProviderError],
  ])('%s', async (_label, body, code) => {
    const { provider } = makeProvider([apiRoute(FOUND), apiRoute(body)]);
    const error = await failure(() => provider.refundCharge({ chargeId: 'chg_1', refundId: 'rf_6' }));
    expect(error.code).toBe(code);
    expect(error.providerCode).toBe(body.error_code);
  });

  it.each([
    ['token is empty', { status: 0, msg: 'token is empty' }, ErrorCode.ProviderError],
    ['transaction not exists', { status: 0, msg: 'transaction not exists' }, ErrorCode.NotFound],
    ['token already used or request pending', { status: 0, msg: 'token already used or request pending' }, ErrorCode.Conflict],
    ['Invalid Hash.', { status: 0, msg: 'Invalid Hash.' }, ErrorCode.Auth],
    ['internal error: unclear', { status: 422, errorCode: 'ER1002', errorMessage: 'INTERNAL_ERROR' }, ErrorCode.OutcomeUnknown],
  ])('a body-level "%s" without an error code', async (_label, body, code) => {
    const { provider } = makeProvider([apiRoute(FOUND), apiRoute(body)]);
    expect((await failure(() => provider.refundCharge({ chargeId: 'chg_1', refundId: 'rf_7' }))).code).toBe(code);
  });

  it('"Capture is done today" with status 1 queued nothing: CONFLICT, not a pending refund', async () => {
    const { provider } = makeProvider([apiRoute(FOUND), apiRoute({ status: 1, msg: 'Capture is done today, please check for refund status tomorrow' })]);
    const error = await failure(() => provider.refundCharge({ chargeId: 'chg_1', refundId: 'rf_8' }));
    expect(error.code).toBe(ErrorCode.Conflict);
  });

  it('a dropped connection on the refund is OUTCOME_UNKNOWN and not retried', async () => {
    const { provider, calls } = makeProvider([apiRoute(FOUND), { method: 'POST', url: TEST_API_URL, networkError: true }], {}, { maxRetries: 3 });
    const error = await failure(() => provider.refundCharge({ chargeId: 'chg_1', refundId: 'rf_9' }));
    expect(error.code).toBe(ErrorCode.OutcomeUnknown);
    expect(calls).toHaveLength(2);
  });

  it('a refund token longer than PayU\'s 23 characters is VALIDATION before any request', async () => {
    const { provider, calls } = makeProvider();
    const error = await failure(() => provider.refundCharge({ chargeId: 'chg_1', refundId: 'r'.repeat(24) }));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(error.message).toContain('23');
    expect(calls).toHaveLength(0);
  });

  it('a 23-character token is accepted', async () => {
    const { provider } = makeProvider([apiRoute(FOUND), apiRoute(QUEUED)]);
    expect((await provider.refundCharge({ chargeId: 'chg_1', refundId: 'r'.repeat(23) })).reference).toBe('r'.repeat(23));
  });

  it('an invalid subscription id is VALIDATION before any request', async () => {
    const { provider, calls } = makeProvider();
    expect((await failure(() => provider.refundCharge({ subscriptionId: 'x', chargeId: 'chg_1', refundId: 'rf_1' }))).code).toBe(ErrorCode.Validation);
    expect(calls).toHaveLength(0);
  });
});
