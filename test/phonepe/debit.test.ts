import { describe, expect, it } from 'vitest';
import { ChargeKind, ChargeStatus, Currency, Environment, ErrorCode, HttpMethod, PaymentMethod, Provider } from '../../src/constants.js';
import {
  ERROR_BAD_REQUEST,
  ERROR_DUPLICATE_TXN_REQUEST,
  ERROR_INTERNAL_SERVER_ERROR,
  ERROR_INTERVAL_EXPIRED,
  ERROR_INTERVAL_NOT_STARTED,
  ERROR_INVALID_MERCHANT_ORDER_ID,
  ERROR_INVALID_SUBSCRIPTION_STATE,
  ERROR_MANDATE_REDEMPTION_SKIPPED,
  ERROR_RECURRENCE_LIMIT_BREACHED,
  NOTIFICATION_STATUS_SC_NOTIFSTATUS,
  NOTIFY_RESPONSE_SC_NOTIFY,
  REDEEM_RESPONSE_SC_EXEC,
  REDEMPTION_ORDER_COMPLETED_A_REDORDER,
  REDEMPTION_ORDER_FAILED,
  REFUND_RESPONSE_SC_REFUND,
  SETUP_ORDER_COMPLETED_SC_ORDER,
  SETUP_ORDER_PENDING,
} from './fixtures.js';
import { HOUR, NOW, O_BEARER, PRODUCTION_API, SANDBOX_API, SANDBOX_TOKEN_URL, makeProvider, rejection, route, tokenBody } from './helpers.js';

/** The notification of the [SC-NOTIFSTATUS] sample: `Sub123`, 100 paise, window `validAfter` .. `validUpto` (epoch ms). */
const NOTIFIED = NOTIFICATION_STATUS_SC_NOTIFSTATUS;
const VALID_AFTER = NOTIFIED.paymentFlow.validAfter;
const VALID_UPTO = NOTIFIED.paymentFlow.validUpto;
const SUB = 'Sub123';
const NOTIFICATION_ID = 'n_a1b2c3d4_0_1_1';

const orderPath = (id: string) => `/checkout/v2/order/${id}/status?details=true`;
const NOTIFY = '/checkout/v2/subscriptions/notify';
const REDEEM = '/checkout/v2/subscriptions/redeem';
const REFUND = '/payments/v2/refund';

const orderNotFound = (id: string) => route(HttpMethod.Get, orderPath(id), { status: 404, json: ERROR_INVALID_MERCHANT_ORDER_ID });
const orderIs = (id: string, json: unknown) => route(HttpMethod.Get, orderPath(id), { json });

const DEBIT_AT = new Date(VALID_AFTER + 24 * HOUR).toISOString();

describe('notifyCharge', () => {
  const input = { subscriptionId: SUB, notificationId: NOTIFICATION_ID, amount: 100, debitAt: DEBIT_AT };

  it('asks for the order, then POSTs /checkout/v2/subscriptions/notify: STANDARD retries, autoDebit false, the notification id as merchantOrderId [SC-NOTIFY]', async () => {
    const t = makeProvider([orderNotFound(NOTIFICATION_ID), route(HttpMethod.Post, NOTIFY, { json: NOTIFY_RESPONSE_SC_NOTIFY })]);
    const notification = await t.provider.notifyCharge({ ...input, invoiceNumber: 'INV-2026-11' });

    const [read, post] = t.apiCalls();
    expect(read).toMatchObject({ method: 'GET', url: `${SANDBOX_API}${orderPath(NOTIFICATION_ID)}` });
    expect(post).toMatchObject({ method: 'POST', url: `${SANDBOX_API}${NOTIFY}` });
    expect(post?.headers).toMatchObject({ authorization: O_BEARER(), 'content-type': 'application/json' });
    expect(post?.json).toEqual({
      merchantOrderId: NOTIFICATION_ID,
      amount: 100,
      paymentFlow: {
        type: 'SUBSCRIPTION_CHECKOUT_REDEMPTION',
        merchantSubscriptionId: SUB,
        redemptionRetryStrategy: 'STANDARD',
        autoDebit: false,
      },
    });
    expect(notification).toMatchObject({
      provider: Provider.PhonePe,
      id: NOTIFICATION_ID,
      subscriptionId: SUB,
      accepted: true,
      providerStatus: 'NOTIFICATION_IN_PROGRESS',
      amount: 100,
      debitAt: DEBIT_AT,
      invoiceNumber: 'INV-2026-11',
      // The scheduler debits with THIS id.
      chargeId: NOTIFICATION_ID,
    });
    expect(notification.raw).toMatchObject({ orderId: NOTIFY_RESPONSE_SC_NOTIFY.orderId });
  });

  it('production URL', async () => {
    const t = makeProvider(
      [
        { method: HttpMethod.Get, url: `${PRODUCTION_API}${orderPath(NOTIFICATION_ID)}`, status: 404, json: ERROR_INVALID_MERCHANT_ORDER_ID },
        { method: HttpMethod.Post, url: `${PRODUCTION_API}${NOTIFY}`, json: NOTIFY_RESPONSE_SC_NOTIFY },
      ],
      { environment: Environment.Live },
    );
    await t.provider.notifyCharge(input);
    expect(t.apiCalls().map((call) => call.url)).toEqual([`${PRODUCTION_API}${orderPath(NOTIFICATION_ID)}`, `${PRODUCTION_API}${NOTIFY}`]);
  });

  it.each([
    ['NOTIFICATION_IN_PROGRESS', true],
    ['NOTIFIED', true],
    // Not a state of the docs: not accepted, and visible.
    ['NOTIFICATION_FAILED', false],
    ['SOMETHING_NEW', false],
  ])('a response in state %s is accepted: %s', async (state, accepted) => {
    const t = makeProvider([orderNotFound(NOTIFICATION_ID), route(HttpMethod.Post, NOTIFY, { json: { ...NOTIFY_RESPONSE_SC_NOTIFY, state } })]);
    const notification = await t.provider.notifyCharge(input);
    expect(notification.accepted).toBe(accepted);
    expect(notification.providerStatus).toBe(state);
  });

  it('sent again with the same id after PhonePe already holds that notification: returned, NOT sent twice', async () => {
    const t = makeProvider([orderIs(NOTIFICATION_ID, NOTIFIED)]);
    const notification = await t.provider.notifyCharge(input);
    expect(notification).toMatchObject({ accepted: true, providerStatus: 'NOTIFIED', chargeId: NOTIFICATION_ID });
    expect(t.apiCalls().map((call) => call.method)).toEqual(['GET']);
  });

  it('an order PhonePe holds under that id with another amount is CONFLICT: a notification id is never reused', async () => {
    const t = makeProvider([orderIs(NOTIFICATION_ID, NOTIFIED)]);
    const error = await rejection(() => t.provider.notifyCharge({ ...input, amount: 200 }));
    expect(error.code).toBe(ErrorCode.Conflict);
    expect(t.apiCalls()).toHaveLength(1);
  });

  it('an order that is already a debit under that id is CONFLICT', async () => {
    const t = makeProvider([orderIs(NOTIFICATION_ID, { ...NOTIFIED, state: 'COMPLETED' })]);
    expect((await rejection(() => t.provider.notifyCharge(input))).code).toBe(ErrorCode.Conflict);
  });

  it('an order of another subscription under that id is CONFLICT', async () => {
    const t = makeProvider([orderIs(NOTIFICATION_ID, NOTIFIED)]);
    expect((await rejection(() => t.provider.notifyCharge({ ...input, subscriptionId: 'Other' }))).code).toBe(ErrorCode.Conflict);
  });

  it.each([
    [ERROR_INVALID_SUBSCRIPTION_STATE, 400, ErrorCode.ProviderError],
    [ERROR_RECURRENCE_LIMIT_BREACHED, 400, ErrorCode.Validation],
    [ERROR_DUPLICATE_TXN_REQUEST, 400, ErrorCode.Conflict],
    [ERROR_BAD_REQUEST, 400, ErrorCode.Validation],
    [{ code: 'SUBSCRIPTION_NOT_FOUND', message: 'Subscription setup entry not found' }, 404, ErrorCode.NotFound],
  ])('PhonePe refuses the notification with %j (HTTP %i): %s', async (body, status, code) => {
    const t = makeProvider([orderNotFound(NOTIFICATION_ID), route(HttpMethod.Post, NOTIFY, { status, json: body })]);
    const error = await rejection(() => t.provider.notifyCharge(input));
    expect(error.code).toBe(code);
    expect(error.providerCode).toBe(body.code);
  });

  it('a dropped connection and a 5xx on the notify are OUTCOME_UNKNOWN: it may have been sent', async () => {
    const dropped = makeProvider([orderNotFound(NOTIFICATION_ID), route(HttpMethod.Post, NOTIFY, { networkError: true })]);
    expect((await rejection(() => dropped.provider.notifyCharge(input))).code).toBe(ErrorCode.OutcomeUnknown);
    const failed = makeProvider([orderNotFound(NOTIFICATION_ID), route(HttpMethod.Post, NOTIFY, { status: 500, json: ERROR_INTERNAL_SERVER_ERROR })]);
    expect((await rejection(() => failed.provider.notifyCharge(input))).code).toBe(ErrorCode.OutcomeUnknown);
  });

  it('refuses an amount under 100 paise, a bad id or a bad subscription id before any request', async () => {
    for (const bad of [{ amount: 99 }, { notificationId: 'has space' }, { notificationId: 'x'.repeat(64) }, { subscriptionId: 'a/b' }]) {
      const t = makeProvider([]);
      expect((await rejection(() => t.provider.notifyCharge({ ...input, ...bad }))).code).toBe(ErrorCode.Validation);
      expect(t.calls).toHaveLength(0);
    }
  });

  it('a 401 on the notify drops the token and re-runs the whole flow once, read first (so nothing is sent twice)', async () => {
    const t = makeProvider(
      [
        orderNotFound(NOTIFICATION_ID),
        route(HttpMethod.Post, NOTIFY, { status: 401, json: { code: 'UNAUTHORIZED', message: 'x' } }),
        { method: HttpMethod.Post, url: SANDBOX_TOKEN_URL, json: tokenBody(NOW.getTime(), 'fresh-token') },
        orderNotFound(NOTIFICATION_ID),
        route(HttpMethod.Post, NOTIFY, { json: NOTIFY_RESPONSE_SC_NOTIFY }),
      ],
      { tokens: 1 },
    );
    const notification = await t.provider.notifyCharge(input);
    expect(notification.accepted).toBe(true);
    expect(t.apiCalls().map((call) => `${call.method} ${call.headers.authorization}`)).toEqual([
      `GET ${O_BEARER()}`,
      `POST ${O_BEARER()}`,
      `GET ${O_BEARER('fresh-token')}`,
      `POST ${O_BEARER('fresh-token')}`,
    ]);
  });

  it('...and when the repeat finds the notification already there (the first POST did get through), it sends nothing more', async () => {
    const t = makeProvider(
      [
        orderNotFound(NOTIFICATION_ID),
        route(HttpMethod.Post, NOTIFY, { status: 401, json: { code: 'UNAUTHORIZED', message: 'x' } }),
        { method: HttpMethod.Post, url: SANDBOX_TOKEN_URL, json: tokenBody(NOW.getTime(), 'fresh-token') },
        orderIs(NOTIFICATION_ID, NOTIFIED),
      ],
      { tokens: 1 },
    );
    expect((await t.provider.notifyCharge(input)).accepted).toBe(true);
    expect(t.apiCalls().filter((call) => call.method === 'POST')).toHaveLength(1);
  });
});

describe('createCharge (the redemption)', () => {
  const input = { subscriptionId: SUB, chargeId: NOTIFICATION_ID, amount: 100 };
  /** Two hours into the notification's window. */
  const inWindow = (t: ReturnType<typeof makeProvider>) => t.clock.set(VALID_AFTER + 2 * HOUR);

  it('reads the notification, then POSTs /checkout/v2/subscriptions/redeem with the SAME merchantOrderId and nothing else [SC-EXEC]', async () => {
    const t = makeProvider([orderIs(NOTIFICATION_ID, NOTIFIED), route(HttpMethod.Post, REDEEM, { json: REDEEM_RESPONSE_SC_EXEC })]);
    inWindow(t);
    const charge = await t.provider.createCharge(input);

    const [read, post] = t.apiCalls();
    expect(read).toMatchObject({ method: 'GET', url: `${SANDBOX_API}${orderPath(NOTIFICATION_ID)}` });
    expect(post).toMatchObject({ method: 'POST', url: `${SANDBOX_API}${REDEEM}` });
    expect(post?.headers).toMatchObject({ authorization: O_BEARER(), 'content-type': 'application/json' });
    expect(post?.json).toEqual({ merchantOrderId: NOTIFICATION_ID });
    expect(charge).toMatchObject({
      provider: Provider.PhonePe,
      id: NOTIFICATION_ID,
      reference: NOTIFICATION_ID,
      subscriptionId: SUB,
      kind: ChargeKind.Recurring,
      status: ChargeStatus.Pending,
      providerStatus: 'PENDING',
      amount: 100,
      currency: Currency.INR,
      paymentMethod: PaymentMethod.Upi,
    });
    // PhonePe's transaction id is kept.
    expect(charge.raw).toMatchObject({ transactionId: REDEEM_RESPONSE_SC_EXEC.transactionId });
  });

  it('production URL', async () => {
    const t = makeProvider(
      [
        { method: HttpMethod.Get, url: `${PRODUCTION_API}${orderPath(NOTIFICATION_ID)}`, json: NOTIFIED },
        { method: HttpMethod.Post, url: `${PRODUCTION_API}${REDEEM}`, json: REDEEM_RESPONSE_SC_EXEC },
      ],
      { environment: Environment.Live },
    );
    inWindow(t);
    await t.provider.createCharge(input);
    expect(t.apiCalls()[1]?.url).toBe(`${PRODUCTION_API}${REDEEM}`);
  });

  it.each([
    ['PENDING', ChargeStatus.Pending],
    ['COMPLETED', ChargeStatus.Succeeded],
    ['FAILED', ChargeStatus.Failed],
    ['SOMETHING_NEW', ChargeStatus.Pending],
  ])('a redeem answer in state %s is %s', async (state, status) => {
    const t = makeProvider([orderIs(NOTIFICATION_ID, NOTIFIED), route(HttpMethod.Post, REDEEM, { json: { ...REDEEM_RESPONSE_SC_EXEC, state } })]);
    inWindow(t);
    const charge = await t.provider.createCharge(input);
    expect(charge.status).toBe(status);
    expect(charge.providerStatus).toBe(state);
    expect(charge.paidAt).toBe(status === ChargeStatus.Succeeded ? t.clock.now.toISOString() : undefined);
  });

  it('safe to repeat: when PhonePe already holds the redemption, that debit is returned and nothing is sent', async () => {
    const t = makeProvider([orderIs('M2771', REDEMPTION_ORDER_COMPLETED_A_REDORDER)]);
    const charge = await t.provider.createCharge({ subscriptionId: 'MS0352112', chargeId: 'M2771', amount: 100 });
    expect(charge).toMatchObject({ id: 'M2771', status: ChargeStatus.Succeeded, amount: 100, paidAt: new Date(1780289199068).toISOString() });
    expect(t.apiCalls().map((call) => call.method)).toEqual(['GET']);

    const failed = makeProvider([orderIs('M2771', REDEMPTION_ORDER_FAILED)]);
    const failedCharge = await failed.provider.createCharge({ subscriptionId: 'MS0352112', chargeId: 'M2771', amount: 100 });
    expect(failedCharge.status).toBe(ChargeStatus.Failed);
    expect(failed.apiCalls()).toHaveLength(1);

    const pending = makeProvider([orderIs('M2771', { ...REDEMPTION_ORDER_COMPLETED_A_REDORDER, state: 'PENDING', paymentDetails: [] })]);
    expect((await pending.provider.createCharge({ subscriptionId: 'MS0352112', chargeId: 'M2771', amount: 100 })).status).toBe(ChargeStatus.Pending);
    expect(pending.apiCalls()).toHaveLength(1);
  });

  it('too early (before validAfter): CONFLICT with the NOT_STARTED code, nothing sent. Not a code the scheduler counts as a failed debit', async () => {
    const t = makeProvider([orderIs(NOTIFICATION_ID, NOTIFIED)]);
    t.clock.set(VALID_AFTER - HOUR);
    const error = await rejection(() => t.provider.createCharge(input));
    expect(error).toMatchObject({ code: ErrorCode.Conflict, providerCode: 'SUBSCRIPTION_DEBIT_EXECUTE_INTERVAL_NOT_STARTED' });
    expect(t.apiCalls()).toHaveLength(1);
  });

  it('too early as PhonePe says it (its clock is ahead of ours): the same CONFLICT', async () => {
    const t = makeProvider([orderIs(NOTIFICATION_ID, NOTIFIED), route(HttpMethod.Post, REDEEM, { status: 400, json: ERROR_INTERVAL_NOT_STARTED })]);
    inWindow(t);
    const error = await rejection(() => t.provider.createCharge(input));
    expect(error).toMatchObject({ code: ErrorCode.Conflict, providerCode: 'SUBSCRIPTION_DEBIT_EXECUTE_INTERVAL_NOT_STARTED' });
  });

  it('a notification still being delivered (NOTIFICATION_IN_PROGRESS) cannot be redeemed yet: CONFLICT, nothing sent', async () => {
    const t = makeProvider([orderIs(NOTIFICATION_ID, { ...NOTIFIED, state: 'NOTIFICATION_IN_PROGRESS' })]);
    inWindow(t);
    expect((await rejection(() => t.provider.createCharge(input))).code).toBe(ErrorCode.Conflict);
    expect(t.apiCalls()).toHaveLength(1);
  });

  it('window expired (after validUpto): PROVIDER_ERROR with the EXPIRED code, nothing sent: a definite failure, the debit can never happen', async () => {
    const t = makeProvider([orderIs(NOTIFICATION_ID, NOTIFIED)]);
    t.clock.set(VALID_UPTO + HOUR);
    const error = await rejection(() => t.provider.createCharge(input));
    expect(error).toMatchObject({ code: ErrorCode.ProviderError, providerCode: 'SUBSCRIPTION_DEBIT_EXECUTE_INTERVAL_EXPIRED' });
    expect(t.apiCalls()).toHaveLength(1);
  });

  it('window expired as PhonePe says it: the same PROVIDER_ERROR', async () => {
    const t = makeProvider([orderIs(NOTIFICATION_ID, NOTIFIED), route(HttpMethod.Post, REDEEM, { status: 400, json: ERROR_INTERVAL_EXPIRED })]);
    inWindow(t);
    expect((await rejection(() => t.provider.createCharge(input))).code).toBe(ErrorCode.ProviderError);
  });

  it.each([
    [ERROR_INVALID_SUBSCRIPTION_STATE, ErrorCode.ProviderError],
    [ERROR_MANDATE_REDEMPTION_SKIPPED, ErrorCode.ProviderError],
    [ERROR_DUPLICATE_TXN_REQUEST, ErrorCode.Conflict],
    [{ code: 'INVALID_TRANSACTION_ID', message: 'transactionId is invalid (send the same as of notification)' }, ErrorCode.Validation],
  ])('subscription not active / skipped / duplicate: %j is %s', async (body, code) => {
    const t = makeProvider([orderIs(NOTIFICATION_ID, NOTIFIED), route(HttpMethod.Post, REDEEM, { status: 400, json: body })]);
    inWindow(t);
    const error = await rejection(() => t.provider.createCharge(input));
    expect(error.code).toBe(code);
    expect(error.providerCode).toBe(body.code);
  });

  it('a dropped connection or a 5xx on the redeem is OUTCOME_UNKNOWN: the debit may have been raised', async () => {
    const dropped = makeProvider([orderIs(NOTIFICATION_ID, NOTIFIED), route(HttpMethod.Post, REDEEM, { networkError: true })]);
    inWindow(dropped);
    expect((await rejection(() => dropped.provider.createCharge(input))).code).toBe(ErrorCode.OutcomeUnknown);
    const failed = makeProvider([orderIs(NOTIFICATION_ID, NOTIFIED), route(HttpMethod.Post, REDEEM, { status: 502, text: 'Bad Gateway' })]);
    inWindow(failed);
    expect((await rejection(() => failed.provider.createCharge(input))).code).toBe(ErrorCode.OutcomeUnknown);
  });

  it('a documented PhonePe code on a 5xx does not turn a possibly-executed write into a definite refusal', async () => {
    const t = makeProvider([orderIs(NOTIFICATION_ID, NOTIFIED), route(HttpMethod.Post, REDEEM, { status: 500, json: ERROR_INVALID_SUBSCRIPTION_STATE })]);
    inWindow(t);
    expect((await rejection(() => t.provider.createCharge(input))).code).toBe(ErrorCode.OutcomeUnknown);
  });

  it('no notification under that id: NOT_FOUND, nothing sent', async () => {
    const t = makeProvider([orderNotFound(NOTIFICATION_ID)]);
    expect((await rejection(() => t.provider.createCharge(input))).code).toBe(ErrorCode.NotFound);
    expect(t.apiCalls()).toHaveLength(1);
  });

  it('the amount is fixed by the notification: a different requested amount is VALIDATION and nothing is sent', async () => {
    const t = makeProvider([orderIs(NOTIFICATION_ID, NOTIFIED)]);
    inWindow(t);
    const error = await rejection(() => t.provider.createCharge({ ...input, amount: 49900 }));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(error.message).toMatch(/fixed by the notification/);
    expect(t.apiCalls()).toHaveLength(1);
  });

  it('a notification of another subscription is never redeemed for this one: VALIDATION', async () => {
    const t = makeProvider([orderIs(NOTIFICATION_ID, NOTIFIED)]);
    inWindow(t);
    expect((await rejection(() => t.provider.createCharge({ ...input, subscriptionId: 'Other' }))).code).toBe(ErrorCode.Validation);
    expect(t.apiCalls()).toHaveLength(1);
  });

  it('a mandate setup order is not a notification: VALIDATION', async () => {
    const t = makeProvider([orderIs('ST_Sub123', SETUP_ORDER_PENDING)]);
    const error = await rejection(() => t.provider.createCharge({ subscriptionId: SUB, chargeId: 'ST_Sub123', amount: 200 }));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(t.apiCalls()).toHaveLength(1);
  });

  it('refuses an illegal id before any request', async () => {
    const t = makeProvider([]);
    expect((await rejection(() => t.provider.createCharge({ ...input, chargeId: 'bad id' }))).code).toBe(ErrorCode.Validation);
    expect(t.calls).toHaveLength(0);
  });

  it('a 401 on the redeem drops the token and re-runs the flow once: read again, redeem once', async () => {
    const t = makeProvider(
      [
        orderIs(NOTIFICATION_ID, NOTIFIED),
        route(HttpMethod.Post, REDEEM, { status: 401, json: { code: 'UNAUTHORIZED', message: 'x' } }),
        { method: HttpMethod.Post, url: SANDBOX_TOKEN_URL, json: tokenBody(VALID_AFTER + 2 * HOUR, 'fresh-token') },
        orderIs(NOTIFICATION_ID, NOTIFIED),
        route(HttpMethod.Post, REDEEM, { json: REDEEM_RESPONSE_SC_EXEC }),
      ],
      { tokens: 1 },
    );
    inWindow(t);
    const charge = await t.provider.createCharge(input);
    expect(charge.status).toBe(ChargeStatus.Pending);
    expect(t.apiCalls().filter((call) => call.method === 'POST')).toHaveLength(2);
  });

  it('...and when the repeat finds the debit already raised, it does not redeem again', async () => {
    const t = makeProvider(
      [
        orderIs(NOTIFICATION_ID, NOTIFIED),
        route(HttpMethod.Post, REDEEM, { status: 401, json: { code: 'UNAUTHORIZED', message: 'x' } }),
        { method: HttpMethod.Post, url: SANDBOX_TOKEN_URL, json: tokenBody(VALID_AFTER + 2 * HOUR, 'fresh-token') },
        orderIs(NOTIFICATION_ID, { ...NOTIFIED, state: 'PENDING', paymentDetails: [] }),
      ],
      { tokens: 1 },
    );
    inWindow(t);
    expect((await t.provider.createCharge(input)).status).toBe(ChargeStatus.Pending);
    expect(t.apiCalls().filter((call) => call.method === 'POST')).toHaveLength(1);
  });
});

describe('getCharge', () => {
  const inWindow = (t: ReturnType<typeof makeProvider>) => t.clock.set(VALID_AFTER + 2 * HOUR);

  it('an order PhonePe has never seen is NOT_FOUND [G-ORDER case 6]', async () => {
    const t = makeProvider([orderNotFound(NOTIFICATION_ID)]);
    const error = await rejection(() => t.provider.getCharge(SUB, NOTIFICATION_ID));
    expect(error).toMatchObject({ code: ErrorCode.NotFound, providerCode: 'INVALID_MERCHANT_ORDER_ID' });
  });

  it('a bare 404 does not prove the debit is unknown: PROVIDER_ERROR, never NOT_FOUND', async () => {
    const t = makeProvider([route(HttpMethod.Get, orderPath(NOTIFICATION_ID), { status: 404, text: 'Not Found' })]);
    const error = await rejection(() => t.provider.getCharge(SUB, NOTIFICATION_ID));
    expect(error.code).toBe(ErrorCode.ProviderError);
  });

  it('an order lookup that fails any other way is not NOT_FOUND either', async () => {
    const t = makeProvider([route(HttpMethod.Get, orderPath(NOTIFICATION_ID), { status: 500, json: ERROR_INTERNAL_SERVER_ERROR })]);
    const error = await rejection(() => t.provider.getCharge(SUB, NOTIFICATION_ID));
    expect(error.code).toBe(ErrorCode.ProviderUnavailable);
  });

  it('GET /checkout/v2/order/{id}/status?details=true: the verbatim [A-REDORDER] COMPLETED order, keeping PhonePe\'s transaction id in raw', async () => {
    const t = makeProvider([orderIs('M2771', REDEMPTION_ORDER_COMPLETED_A_REDORDER)]);
    const charge = await t.provider.getCharge('MS0352112', 'M2771');
    expect(t.apiCalls()[0]).toMatchObject({ method: 'GET', url: `${SANDBOX_API}${orderPath('M2771')}` });
    expect(charge).toMatchObject({
      id: 'M2771',
      reference: 'M2771',
      subscriptionId: 'MS0352112',
      kind: ChargeKind.Recurring,
      status: ChargeStatus.Succeeded,
      providerStatus: 'COMPLETED',
      amount: 100,
      paidAt: new Date(1780289199068).toISOString(),
      paymentMethod: PaymentMethod.Upi,
    });
    expect(charge.failureCode).toBeUndefined();
    expect(charge.raw).toMatchObject({ paymentDetails: [{ transactionId: 'OM2606011016390665335021V' }] });
  });

  it('a failed debit keeps the error code and the detailed error code', async () => {
    const t = makeProvider([orderIs('M2771', REDEMPTION_ORDER_FAILED)]);
    const charge = await t.provider.getCharge('MS0352112', 'M2771');
    expect(charge).toMatchObject({
      status: ChargeStatus.Failed,
      failureCode: 'INSUFFICIENT_BALANCE',
      failureReason: 'INSUFFICIENT_BALANCE (detailed error code Z9)',
    });
    expect(charge.paidAt).toBeUndefined();
  });

  it('a failed order without its own error fields takes the LATEST attempt\'s', async () => {
    const order = {
      ...REDEMPTION_ORDER_FAILED,
      errorCode: undefined,
      detailedErrorCode: undefined,
      paymentDetails: [
        { transactionId: 'OM_A', paymentMode: 'UPI_AUTO_PAY', timestamp: 1000, amount: 100, state: 'FAILED', errorCode: 'INVALID_MPIN', detailedErrorCode: 'ZM' },
        { transactionId: 'OM_B', paymentMode: 'UPI_AUTO_PAY', timestamp: 2000, amount: 100, state: 'FAILED', errorCode: 'INSUFFICIENT_BALANCE', detailedErrorCode: 'Z9' },
      ],
    };
    const t = makeProvider([orderIs('M2771', order)]);
    expect((await t.provider.getCharge('MS0352112', 'M2771')).failureCode).toBe('INSUFFICIENT_BALANCE');
  });

  it('a completed order with a failed first attempt and a completed retry is paid at the COMPLETED attempt', async () => {
    const order = {
      ...REDEMPTION_ORDER_COMPLETED_A_REDORDER,
      paymentDetails: [
        { transactionId: 'OM_A', timestamp: 1000, amount: 100, state: 'FAILED', errorCode: 'INVALID_MPIN', detailedErrorCode: 'ZM' },
        { transactionId: 'OM_B', timestamp: 5000, amount: 100, state: 'COMPLETED' },
        { transactionId: 'OM_C', timestamp: 9000, amount: 100, state: 'FAILED' },
      ],
    };
    const t = makeProvider([orderIs('M2771', order)]);
    const charge = await t.provider.getCharge('MS0352112', 'M2771');
    expect(charge.status).toBe(ChargeStatus.Succeeded);
    expect(charge.paidAt).toBe(new Date(5000).toISOString());
    expect(charge.failureCode).toBeUndefined();
  });

  it.each([
    ['PENDING', ChargeStatus.Pending],
    ['COMPLETED', ChargeStatus.Succeeded],
    ['FAILED', ChargeStatus.Failed],
    // A state PhonePe adds later is never final: pending, verbatim.
    ['SOMETHING_NEW', ChargeStatus.Pending],
    ['constructor', ChargeStatus.Pending],
  ])('order state %s is %s', async (state, status) => {
    const t = makeProvider([orderIs('M2771', { ...REDEMPTION_ORDER_COMPLETED_A_REDORDER, state, paymentDetails: [] })]);
    const charge = await t.provider.getCharge('MS0352112', 'M2771');
    expect(charge.status).toBe(status);
    expect(charge.providerStatus).toBe(state);
  });

  it('only the NOTIFICATION exists (NOTIFIED, inside its window): NOT_FOUND, because no debit has been raised', async () => {
    const t = makeProvider([orderIs(NOTIFICATION_ID, NOTIFIED)]);
    inWindow(t);
    const error = await rejection(() => t.provider.getCharge(SUB, NOTIFICATION_ID));
    expect(error).toMatchObject({ code: ErrorCode.NotFound, providerCode: 'NOTIFIED' });
  });

  it('...also while the notification is still NOTIFICATION_IN_PROGRESS', async () => {
    const t = makeProvider([orderIs(NOTIFICATION_ID, { ...NOTIFIED, state: 'NOTIFICATION_IN_PROGRESS' })]);
    inWindow(t);
    expect((await rejection(() => t.provider.getCharge(SUB, NOTIFICATION_ID))).code).toBe(ErrorCode.NotFound);
  });

  it('a notification whose window closed without a redemption is a FAILED debit (the debit can never happen)', async () => {
    const t = makeProvider([orderIs(NOTIFICATION_ID, NOTIFIED)]);
    t.clock.set(VALID_UPTO + HOUR);
    const charge = await t.provider.getCharge(SUB, NOTIFICATION_ID);
    expect(charge).toMatchObject({
      id: NOTIFICATION_ID,
      status: ChargeStatus.Failed,
      failureCode: 'SUBSCRIPTION_DEBIT_EXECUTE_INTERVAL_EXPIRED',
      amount: 100,
    });
  });

  it('a setup order is a charge too: TRANSACTION is the upfront amount, PENNY_DROP the verification', async () => {
    const upfront = makeProvider([orderIs('ST_Sub123', SETUP_ORDER_COMPLETED_SC_ORDER)]);
    expect(await upfront.provider.getCharge(SUB, 'ST_Sub123')).toMatchObject({ kind: ChargeKind.Upfront, status: ChargeStatus.Succeeded, amount: 100 });
    const penny = makeProvider([orderIs('ST_Sub123', { ...SETUP_ORDER_PENDING, state: 'COMPLETED', amount: 200 })]);
    expect(await penny.provider.getCharge(SUB, 'ST_Sub123')).toMatchObject({ kind: ChargeKind.Authorization, status: ChargeStatus.Succeeded, amount: 200 });
  });

  it('an order of another subscription: VALIDATION', async () => {
    const t = makeProvider([orderIs('M2771', REDEMPTION_ORDER_COMPLETED_A_REDORDER)]);
    expect((await rejection(() => t.provider.getCharge('Sub123', 'M2771'))).code).toBe(ErrorCode.Validation);
  });

  it('an order without an amount cannot be a charge: UNEXPECTED_RESPONSE', async () => {
    const t = makeProvider([orderIs('M2771', { ...REDEMPTION_ORDER_COMPLETED_A_REDORDER, amount: null, paymentDetails: [] })]);
    expect((await rejection(() => t.provider.getCharge('MS0352112', 'M2771'))).code).toBe(ErrorCode.UnexpectedResponse);
  });
});

describe('refundCharge', () => {
  const refundInput = { chargeId: 'M2771', refundId: 'refund_1', amount: 100 };

  it('POST /payments/v2/refund with merchantRefundId, originalMerchantOrderId (the charge id) and the amount in paise [SC-REFUND]', async () => {
    const t = makeProvider([route(HttpMethod.Post, REFUND, { json: REFUND_RESPONSE_SC_REFUND })]);
    const refund = await t.provider.refundCharge({ ...refundInput, subscriptionId: 'MS0352112', reason: 'duplicate' });
    const [post] = t.apiCalls();
    expect(post).toMatchObject({ method: 'POST', url: `${SANDBOX_API}${REFUND}` });
    expect(post?.headers.authorization).toBe(O_BEARER());
    expect(post?.json).toEqual({ merchantRefundId: 'refund_1', originalMerchantOrderId: 'M2771', amount: 100 });
    expect(refund).toMatchObject({
      provider: Provider.PhonePe,
      id: 'OMR2604141058374994494413V',
      reference: 'refund_1',
      chargeId: 'M2771',
      subscriptionId: 'MS0352112',
      status: 'pending',
      providerStatus: 'PENDING',
      amount: 100,
      currency: Currency.INR,
    });
  });

  it('production URL', async () => {
    const t = makeProvider([{ method: HttpMethod.Post, url: `${PRODUCTION_API}${REFUND}`, json: REFUND_RESPONSE_SC_REFUND }], { environment: Environment.Live });
    await t.provider.refundCharge(refundInput);
    expect(t.apiCalls()[0]?.url).toBe(`${PRODUCTION_API}${REFUND}`);
  });

  it('without an amount the whole debit is refunded: its amount is read from the order first', async () => {
    const t = makeProvider([orderIs('M2771', REDEMPTION_ORDER_COMPLETED_A_REDORDER), route(HttpMethod.Post, REFUND, { json: REFUND_RESPONSE_SC_REFUND })]);
    await t.provider.refundCharge({ chargeId: 'M2771', refundId: 'refund_1' });
    expect(t.apiCalls().map((call) => call.method)).toEqual(['GET', 'POST']);
    expect((t.apiCalls()[1]?.json as { amount: number }).amount).toBe(100);
  });

  it('without an amount, a debit that is not COMPLETED cannot be refunded: VALIDATION; one PhonePe does not know: NOT_FOUND', async () => {
    const failed = makeProvider([orderIs('M2771', REDEMPTION_ORDER_FAILED)]);
    expect((await rejection(() => failed.provider.refundCharge({ chargeId: 'M2771', refundId: 'refund_1' }))).code).toBe(ErrorCode.Validation);
    const unknown = makeProvider([orderNotFound('M2771')]);
    expect((await rejection(() => unknown.provider.refundCharge({ chargeId: 'M2771', refundId: 'refund_1' }))).code).toBe(ErrorCode.NotFound);
    expect(failed.apiCalls().every((call) => call.method === 'GET')).toBe(true);
  });

  it.each([
    ['PENDING', 'pending'],
    ['CONFIRMED', 'pending'],
    ['ACCEPTED', 'pending'],
    ['COMPLETED', 'succeeded'],
    ['FAILED', 'failed'],
    ['SOMETHING_NEW', 'pending'],
  ])('refund state %s is %s', async (state, status) => {
    const t = makeProvider([route(HttpMethod.Post, REFUND, { json: { ...REFUND_RESPONSE_SC_REFUND, state } })]);
    const refund = await t.provider.refundCharge(refundInput);
    expect(refund.status).toBe(status);
    expect(refund.providerStatus).toBe(state);
  });

  it.each([
    ['EXCESS_REFUND_AMOUNT', ErrorCode.Validation],
    ['REFUND_NOT_ALLOWED', ErrorCode.Validation],
    ['REFUND_FOR_TXN_OLDER_THAN_LIMIT', ErrorCode.Validation],
    ['BF_034', ErrorCode.ProviderError],
  ])('PhonePe refuses with %s: %s', async (code, expected) => {
    const t = makeProvider([route(HttpMethod.Post, REFUND, { status: 400, json: { code, message: 'x' } })]);
    const error = await rejection(() => t.provider.refundCharge(refundInput));
    expect(error).toMatchObject({ code: expected, providerCode: code });
  });

  it('a dropped connection on the refund is OUTCOME_UNKNOWN', async () => {
    const t = makeProvider([route(HttpMethod.Post, REFUND, { networkError: true })]);
    expect((await rejection(() => t.provider.refundCharge(refundInput))).code).toBe(ErrorCode.OutcomeUnknown);
  });

  it('refuses illegal ids before any request', async () => {
    const t = makeProvider([]);
    expect((await rejection(() => t.provider.refundCharge({ ...refundInput, refundId: 'bad id' }))).code).toBe(ErrorCode.Validation);
    expect((await rejection(() => t.provider.refundCharge({ ...refundInput, chargeId: 'bad/id' }))).code).toBe(ErrorCode.Validation);
    expect(t.calls).toHaveLength(0);
  });

  it('a 401 on the refund drops the token and surfaces AUTH, without repeating the write', async () => {
    const t = makeProvider([route(HttpMethod.Post, REFUND, { status: 401, json: { code: 'UNAUTHORIZED', message: 'x' } })]);
    expect((await rejection(() => t.provider.refundCharge(refundInput))).code).toBe(ErrorCode.Auth);
    expect(t.apiCalls()).toHaveLength(1);
  });
});
