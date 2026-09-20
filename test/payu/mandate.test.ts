import { describe, expect, it } from 'vitest';
import { CancelMode, ErrorCode, PaymentMethod, SchedulingMode, SubscriptionStatus } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import { NOW, SALT, TEST_API_URL, apiRoute, expectedCommandHash, makeProvider, var1Of } from './helpers.js';

async function failure(run: () => Promise<unknown>): Promise<SubscriptionError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(SubscriptionError);
    return error as SubscriptionError;
  }
  throw new Error('expected an error');
}

const CARD_ID = 'card:25599222315';
const ENACH_ID = 'enach:10731087875';
const UPI_ID = 'upi:25600438037';
const FIRST_REQUEST_ID = 'req_000000000000000000000001';

/** Source: reference__check-mandate-status-api, "Response" (cards). */
const CARD_STATUS = {
  status: 'active',
  action: 'check_mandate_status',
  authpayuid: '25599222315',
  amount: '10.00',
  mandateStartDate: '2025-10-14',
  mandateEndDate: '2027-12-01',
};

/** Source: reference__net_banking_mandate_status_api, "Response — mandate active". */
const ENACH_ACTIVE = {
  status: 'SUCCESS',
  action: 'NB_mandate_status',
  authpayuid: '10731087875',
  amount: '100.00',
  mandateStartDate: '2022-07-19',
  mandateEndDate: '2023-12-20',
};

/** Source: reference__net_banking_mandate_status_api, "Response — cancelled". */
const ENACH_CANCELLED = { ...ENACH_ACTIVE, status: 'CANCEL_SUCCESS', deletedon: '2023-03-20 00:00:00' };

/** Source: reference__get-mandate-status-api-for-upi-only, "Response". */
const UPI_STATUS = {
  status: 'active',
  action: 'MANDATE_STATUS',
  authpayuid: '25600438037',
  amount: '1.00',
  mandateStartDate: '2025-10-14 00:00:00',
  mandateEndDate: '2027-12-01 00:00:00',
};

describe('getSubscription: per-method status command', () => {
  it('cards: check_mandate_status with {authPayuId, requestId}', async () => {
    const { provider, calls } = makeProvider([apiRoute(CARD_STATUS)]);
    const subscription = await provider.getSubscription(CARD_ID);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(TEST_API_URL);
    expect(call.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const var1 = '{"authPayuId":"25599222315","requestId":"' + FIRST_REQUEST_ID + '"}';
    expect(call.form).toEqual({
      key: 'BmTY3G',
      command: 'check_mandate_status',
      var1,
      hash: expectedCommandHash('check_mandate_status', var1),
    });

    expect(subscription).toMatchObject({
      provider: 'payu',
      id: CARD_ID,
      status: SubscriptionStatus.Active,
      providerStatus: 'active',
      scheduling: SchedulingMode.Merchant,
      maxAmount: 1000,
      currency: 'INR',
      // dates are IST midnights
      startAt: '2025-10-13T18:30:00.000Z',
      mandateEndsAt: '2027-11-30T18:30:00.000Z',
      paymentMethod: PaymentMethod.Card,
    });
  });

  it('eNACH: NB_mandate_status with the lower-case authpayuid its page prints', async () => {
    const { provider, calls } = makeProvider([apiRoute(ENACH_ACTIVE)]);
    const subscription = await provider.getSubscription(ENACH_ID);
    const var1 = '{"authpayuid":"10731087875","requestId":"' + FIRST_REQUEST_ID + '"}';
    expect(calls[0]!.form).toEqual({
      key: 'BmTY3G',
      command: 'NB_mandate_status',
      var1,
      hash: expectedCommandHash('NB_mandate_status', var1),
    });
    expect(subscription).toMatchObject({ status: SubscriptionStatus.Active, providerStatus: 'SUCCESS', paymentMethod: PaymentMethod.ENach, maxAmount: 10000 });
  });

  it('eNACH cancelled: endedAt from deletedon', async () => {
    const { provider } = makeProvider([apiRoute(ENACH_CANCELLED)]);
    const subscription = await provider.getSubscription(ENACH_ID);
    expect(subscription).toMatchObject({ status: SubscriptionStatus.Cancelled, endedAt: '2023-03-19T18:30:00.000Z' });
  });

  it('UPI: upi_mandate_status with {authPayuId, requestId}', async () => {
    const { provider, calls } = makeProvider([apiRoute(UPI_STATUS)]);
    const subscription = await provider.getSubscription(UPI_ID);
    const var1 = '{"authPayuId":"25600438037","requestId":"' + FIRST_REQUEST_ID + '"}';
    expect(calls[0]!.form).toEqual({
      key: 'BmTY3G',
      command: 'upi_mandate_status',
      var1,
      hash: expectedCommandHash('upi_mandate_status', var1),
    });
    expect(subscription).toMatchObject({ status: SubscriptionStatus.Active, paymentMethod: PaymentMethod.Upi, mandateEndsAt: '2027-11-30T18:30:00.000Z' });
  });

  it('an id that does not decode is VALIDATION and no request is made', async () => {
    const { provider, calls } = makeProvider();
    const error = await failure(() => provider.getSubscription('25599222315'));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(calls).toHaveLength(0);
  });

  it('a body without a status is UNEXPECTED_RESPONSE', async () => {
    const { provider } = makeProvider([apiRoute({ action: 'check_mandate_status' })]);
    expect((await failure(() => provider.getSubscription(CARD_ID))).code).toBe(ErrorCode.UnexpectedResponse);
  });
});

/**
 * Every status the docs print for each command, plus one the adapter has never seen.
 * Sources: reference__check-mandate-status-api (cards), reference__net_banking_mandate_status_api (eNACH),
 * reference__modify-the-recurring-payment-for-upi (UPI values; the status page lists none).
 */
describe('getSubscription: status tables', () => {
  const cases: [string, string, SubscriptionStatus][] = [
    [CARD_ID, 'active', SubscriptionStatus.Active],
    [CARD_ID, 'cancelled', SubscriptionStatus.Cancelled],
    [CARD_ID, 'discarded', SubscriptionStatus.Cancelled],
    [CARD_ID, 'deleted', SubscriptionStatus.Cancelled],
    [CARD_ID, 'failed', SubscriptionStatus.Failed],
    [CARD_ID, 'expired', SubscriptionStatus.Expired],
    [CARD_ID, 'paused', SubscriptionStatus.Paused],
    [CARD_ID, 'Active', SubscriptionStatus.Active],
    [ENACH_ID, 'INITIATED', SubscriptionStatus.PendingAuthorization],
    [ENACH_ID, 'SUCCESS', SubscriptionStatus.Active],
    [ENACH_ID, 'FAILED', SubscriptionStatus.Failed],
    [ENACH_ID, 'CANCEL_INITIATED', SubscriptionStatus.Cancelled],
    [ENACH_ID, 'CANCEL_PENDING', SubscriptionStatus.Cancelled],
    [ENACH_ID, 'CANCEL_SUCCESS', SubscriptionStatus.Cancelled],
    [ENACH_ID, 'CANCEL_FAILED', SubscriptionStatus.Active],
    [ENACH_ID, 'CANCEL_INITIATION_FAILED', SubscriptionStatus.Active],
    [UPI_ID, 'active', SubscriptionStatus.Active],
    [UPI_ID, 'revoked', SubscriptionStatus.Cancelled],
    [UPI_ID, 'pause', SubscriptionStatus.Paused],
    [UPI_ID, 'paused', SubscriptionStatus.Paused],
    [UPI_ID, 'unpause', SubscriptionStatus.Active],
    // Documented fallback: not confirmed live, so pending_authorization; the status stays verbatim.
    [CARD_ID, 'suspended', SubscriptionStatus.PendingAuthorization],
    [ENACH_ID, 'BRAND_NEW', SubscriptionStatus.PendingAuthorization],
    [UPI_ID, 'on_hold', SubscriptionStatus.PendingAuthorization],
  ];

  it.each(cases)('%s: "%s" is %s', async (id, status, expected) => {
    const { provider } = makeProvider([apiRoute({ status, action: 'x', authpayuid: '1', amount: '1.00' })]);
    const subscription = await provider.getSubscription(id);
    expect(subscription.status).toBe(expected);
    expect(subscription.providerStatus).toBe(status);
  });
});

/** Body-level failures: PayU answers HTTP 200 with the error in the body. Sources are the fact sheet's 1.6 table. */
describe('getSubscription: errors inside an HTTP 200', () => {
  const cases: [string, unknown, ErrorCode][] = [
    ['bad hash', { status: 0, msg: 'Invalid Hash.' }, ErrorCode.Auth],
    ['inactive merchant', { msg: 'Merchant is not authorized to use PayU API', status: 0 }, ErrorCode.Auth],
    ['SI is not valid (ER0816)', { status: 422, errorCode: 'ER0816', errorMessage: 'SI is not valid', action: 'check_mandate_status' }, ErrorCode.NotFound],
    ['consent not mandated', { status: 0, message: 'Consent is Not Mandated', action: 'check_mandate_status' }, ErrorCode.NotFound],
    ['UPI entry not found', { status: 0, message: 'Mandate entry not found', action: 'MANDATE_STATUS' }, ErrorCode.NotFound],
    ['eNACH entry not found', { status: 0, message: 'ENACH Mandate entry not found', action: 'NB_mandate_status' }, ErrorCode.NotFound],
    ['authPayuId missing', { status: 0, message: 'authPayuId is mandatory', action: 'check_mandate_status' }, ErrorCode.Validation],
    ['internal error (ER1002)', { status: 422, errorCode: 'ER1002', errorMessage: 'INTERNAL_ERROR', action: 'check_mandate_status' }, ErrorCode.ProviderUnavailable],
    ['an unrecognised failure', { status: 0, message: 'Something new went wrong' }, ErrorCode.ProviderError],
  ];

  it.each(cases)('%s', async (_label, body, code) => {
    const { provider } = makeProvider([apiRoute(body)]);
    const error = await failure(() => provider.getSubscription(CARD_ID));
    expect(error.code).toBe(code);
    expect(error.provider).toBe('payu');
    expect(error.raw).toEqual(body);
    expect(error.message).not.toContain(SALT);
  });

  it('keeps the gateway code and message', async () => {
    const { provider } = makeProvider([apiRoute({ status: 422, errorCode: 'ER0816', errorMessage: 'SI is not valid' })]);
    const error = await failure(() => provider.getSubscription(CARD_ID));
    expect(error.providerCode).toBe('ER0816');
    expect(error.message).toContain('SI is not valid');
  });

  it('an HTTP 5xx on a read is PROVIDER_UNAVAILABLE', async () => {
    const { provider } = makeProvider([apiRoute({ msg: 'down' }, 503)]);
    expect((await failure(() => provider.getSubscription(CARD_ID))).code).toBe(ErrorCode.ProviderUnavailable);
  });
});

describe('cancelSubscription', () => {
  it('cards: mandate_revoke', async () => {
    /** Source: reference__cancel-the-recurring-payment-for-cards, "Response". */
    const { provider, calls } = makeProvider([apiRoute({ status: 1, message: 'Mandate Revoked Successfully', action: 'MANDATE_REVOKE' })]);
    const subscription = await provider.cancelSubscription(CARD_ID);
    const var1 = '{"authPayuId":"25599222315","requestId":"' + FIRST_REQUEST_ID + '"}';
    expect(calls[0]!.form).toEqual({ key: 'BmTY3G', command: 'mandate_revoke', var1, hash: expectedCommandHash('mandate_revoke', var1) });
    expect(subscription).toMatchObject({
      id: CARD_ID,
      status: SubscriptionStatus.Cancelled,
      providerStatus: 'Mandate Revoked Successfully',
      endedAt: NOW.toISOString(),
      paymentMethod: PaymentMethod.Card,
    });
  });

  it('eNACH: mandate_revoke; the asynchronous acknowledgement counts as cancelled', async () => {
    /** Source: reference__cancel-the-recurring-payment-for-net-banking, "Immediate response" (note the capital-M `Message`). */
    const { provider, calls } = makeProvider([
      apiRoute({ action: 'MANDATE_REVOKE', status: 1, Message: 'Mandate Cancel Initiated', authpayuid: 26734617195 }),
    ]);
    const subscription = await provider.cancelSubscription(ENACH_ID, { mode: CancelMode.Immediately });
    expect(calls[0]!.form?.command).toBe('mandate_revoke');
    expect(subscription).toMatchObject({ status: SubscriptionStatus.Cancelled, providerStatus: 'Mandate Cancel Initiated' });
  });

  it('UPI: upi_mandate_revoke', async () => {
    /** Source: reference__cancel-the-recurring-payment-for-upi, "Response". */
    const { provider, calls } = makeProvider([
      apiRoute({ status: 1, action: 'MANDATE_REVOKE', message: 'Mandate Revoke request processed successfully' }),
    ]);
    const subscription = await provider.cancelSubscription(UPI_ID);
    const var1 = '{"authPayuId":"25600438037","requestId":"' + FIRST_REQUEST_ID + '"}';
    expect(calls[0]!.form).toEqual({ key: 'BmTY3G', command: 'upi_mandate_revoke', var1, hash: expectedCommandHash('upi_mandate_revoke', var1) });
    expect(subscription.status).toBe(SubscriptionStatus.Cancelled);
  });

  it('at_period_end is UNSUPPORTED and makes no request', async () => {
    const { provider, calls } = makeProvider();
    const error = await failure(() => provider.cancelSubscription(UPI_ID, { mode: CancelMode.AtPeriodEnd }));
    expect(error.code).toBe(ErrorCode.Unsupported);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['Mandate is not active', { status: 0, action: 'MANDATE_REVOKE', message: 'Mandate is not active' }],
    ['Mandate not in appropriate state to perform action', { status: 0, message: 'Mandate not in appropriate state to perform action', action: 'MANDATE_REVOKE' }],
    ['Mandate already revoked', { status: 0, action: 'MANDATE_REVOKE', message: 'Mandate already revoked' }],
    ['Mandate Revoke Request Rejected', { status: 0, action: 'MANDATE_REVOKE', message: 'Mandate Revoke Request Rejected' }],
  ])('"%s" is CONFLICT', async (_message, body) => {
    const { provider } = makeProvider([apiRoute(body)]);
    expect((await failure(() => provider.cancelSubscription(CARD_ID))).code).toBe(ErrorCode.Conflict);
  });

  it('a dropped connection is OUTCOME_UNKNOWN and is not retried', async () => {
    const { provider, calls } = makeProvider([{ method: 'POST', url: TEST_API_URL, networkError: true }], {}, { maxRetries: 3 });
    const error = await failure(() => provider.cancelSubscription(CARD_ID));
    expect(error.code).toBe(ErrorCode.OutcomeUnknown);
    expect(calls).toHaveLength(1);
  });

  it('an unclassified body failure on a write is PROVIDER_ERROR; an answer without a success status is UNEXPECTED_RESPONSE', async () => {
    expect((await failure(() => makeProvider([apiRoute({ status: 0, message: 'odd' })]).provider.cancelSubscription(CARD_ID))).code).toBe(
      ErrorCode.ProviderError,
    );
    expect((await failure(() => makeProvider([apiRoute({ action: 'MANDATE_REVOKE' })]).provider.cancelSubscription(CARD_ID))).code).toBe(
      ErrorCode.UnexpectedResponse,
    );
  });
});

describe('updateSubscription', () => {
  /** Source: reference__modify-the-recurring-payment-for-upi, "Response — pending customer approval". */
  const PENDING = {
    status: 1,
    action: 'MANDATE_UPDATE',
    message: 'Mandate update pending at PG. Please wait for webhook or use upi_mandate_status service to confirm updated status',
  };

  it('UPI: upi_mandate_modify with amount (rupees, as a number) and an IST endDate, then reads the mandate back', async () => {
    const { provider, calls } = makeProvider([apiRoute(PENDING), apiRoute(UPI_STATUS)]);
    const subscription = await provider.updateSubscription(UPI_ID, { amount: 49950, mandateEndsAt: '2027-12-31T20:00:00.000Z' });

    expect(calls).toHaveLength(2);
    // 2027-12-31T20:00Z is 01:30 on 1 January in IST.
    const var1 = '{"requestId":"' + FIRST_REQUEST_ID + '","authPayuId":"25600438037","endDate":"2028-01-01","amount":499.5}';
    expect(calls[0]!.form).toEqual({ key: 'BmTY3G', command: 'upi_mandate_modify', var1, hash: expectedCommandHash('upi_mandate_modify', var1) });
    expect(calls[1]!.form?.command).toBe('upi_mandate_status');
    expect(subscription.id).toBe(UPI_ID);
    expect(subscription.status).toBe(SubscriptionStatus.Active);
    expect(subscription.raw).toMatchObject({ update: PENDING });
  });

  it('an amount alone is enough, and endDate alone too', async () => {
    const amountOnly = makeProvider([apiRoute(PENDING), apiRoute(UPI_STATUS)]);
    await amountOnly.provider.updateSubscription(UPI_ID, { amount: 49900 });
    expect(var1Of(amountOnly.calls[0]!)).toEqual({ requestId: FIRST_REQUEST_ID, authPayuId: '25600438037', amount: 499 });
    const endOnly = makeProvider([apiRoute(PENDING), apiRoute(UPI_STATUS)]);
    await endOnly.provider.updateSubscription(UPI_ID, { mandateEndsAt: '2027-06-30T00:00:00.000Z' });
    expect(var1Of(endOnly.calls[0]!)).toEqual({ requestId: FIRST_REQUEST_ID, authPayuId: '25600438037', endDate: '2027-06-30' });
  });

  it.each([
    ['cards need the customer to re-authenticate', CARD_ID],
    ['eNACH has no modify API', ENACH_ID],
  ])('%s: UNSUPPORTED', async (_why, id) => {
    const { provider, calls } = makeProvider();
    const error = await failure(() => provider.updateSubscription(id, { amount: 10000 }));
    expect(error.code).toBe(ErrorCode.Unsupported);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['planId', { planId: 'p' }],
    ['quantity', { quantity: 2 }],
    ['remainingCycles', { remainingCycles: 3 }],
    ['nextChargeAt', { nextChargeAt: '2027-01-01T00:00:00.000Z' }],
    ['a change at period end', { amount: 10000, timing: 'at_period_end' as const }],
  ])('%s is UNSUPPORTED on a UPI mandate', async (_field, input) => {
    const { provider, calls } = makeProvider();
    expect((await failure(() => provider.updateSubscription(UPI_ID, input))).code).toBe(ErrorCode.Unsupported);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['Invalid Data', ErrorCode.Validation],
    ['amount or endDate required to update', ErrorCode.Validation],
    ['Mandate is not active', ErrorCode.Conflict],
  ])('a body-level "%s" is %s', async (message, code) => {
    const { provider } = makeProvider([apiRoute({ status: 0, action: 'MANDATE_UPDATE', message })]);
    expect((await failure(() => provider.updateSubscription(UPI_ID, { amount: 10000 }))).code).toBe(code);
  });

  it('nothing to update is VALIDATION', async () => {
    const { provider } = makeProvider();
    expect((await failure(() => provider.updateSubscription(UPI_ID, {}))).code).toBe(ErrorCode.Validation);
  });
});
