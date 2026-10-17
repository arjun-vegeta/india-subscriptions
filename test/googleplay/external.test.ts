import { describe, expect, it } from 'vitest';
import { ErrorCode, HttpMethod } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import { ExternalTransactionRecordSchema } from '../../src/schemas.js';
import { EXTERNAL_CREATE_RESPONSE_SAMPLE, EXTERNAL_REFUND_RESPONSE_SAMPLE } from './fixtures.js';
import { P, makeProvider, route } from './helpers.js';

const BASE = 'https://androidpublisher.googleapis.com/androidpublisher/v3';
const CREATE = `${P}/externalTransactions`;
const query = (id: string) => `?externalTransactionId=${id}`;
const created = (id: string, overrides: Record<string, unknown> = {}) => ({ ...EXTERNAL_CREATE_RESPONSE_SAMPLE, externalTransactionId: id, ...overrides });

/** A first purchase: 499.50 rupees before tax, 89.91 tax, made at 2026-11-22T12:45:00Z by a customer in Kerala. */
const firstSubscription = {
  externalTransactionId: '123-456-789',
  externalTransactionToken: 'my_token',
  productKind: 'subscription' as const,
  amount: 49950,
  taxAmount: 8991,
  transactionTime: '2026-11-22T12:45:00Z',
  state: 'Kerala',
};

describe('reportExternalTransaction: a first purchase [outside-gpb-backend, "Report an initial transaction"]', () => {
  it('a subscription: recurringTransaction with the device token, amounts in micros, userTaxAddress IN + the state', async () => {
    const t = makeProvider([route(HttpMethod.Post, CREATE, { json: created('123-456-789') }, query('123-456-789'))]);
    const record = await t.provider.reportExternalTransaction(firstSubscription);
    const [call] = t.apiCalls();
    expect(call).toMatchObject({ method: 'POST', url: `${BASE}${CREATE}?externalTransactionId=123-456-789` });
    expect(call?.headers['content-type']).toBe('application/json');
    expect(call?.json).toEqual({
      originalPreTaxAmount: { currency: 'INR', priceMicros: '499500000' },
      originalTaxAmount: { currency: 'INR', priceMicros: '89910000' },
      transactionTime: '2026-11-22T12:45:00.000Z',
      recurringTransaction: { externalTransactionToken: 'my_token', externalSubscription: { subscriptionType: 'RECURRING' } },
      userTaxAddress: { regionCode: 'IN', administrativeArea: 'KERALA' },
    });
    expect(ExternalTransactionRecordSchema.parse(record)).toBeTruthy();
    expect(record).toMatchObject({ externalTransactionId: '123-456-789', state: 'TRANSACTION_REPORTED' });
    expect(record.raw).toMatchObject({ packageName: 'com.example.app' });
  });

  it('a one-time product: oneTimeTransaction with the token', async () => {
    const t = makeProvider([route(HttpMethod.Post, CREATE, { json: created('ot-1') }, query('ot-1'))]);
    await t.provider.reportExternalTransaction({ ...firstSubscription, externalTransactionId: 'ot-1', productKind: 'one_time', amount: 9900, taxAmount: 1510 });
    expect(t.apiCalls()[0]?.json).toEqual({
      originalPreTaxAmount: { currency: 'INR', priceMicros: '99000000' },
      originalTaxAmount: { currency: 'INR', priceMicros: '15100000' },
      transactionTime: '2026-11-22T12:45:00.000Z',
      oneTimeTransaction: { externalTransactionToken: 'my_token' },
      userTaxAddress: { regionCode: 'IN', administrativeArea: 'KERALA' },
    });
  });
});

describe('reportExternalTransaction: a free trial [outside-gpb-backend: reported as a zero-value transaction]', () => {
  it('amount and tax 0 are sent as "0", with the token, as the guide\'s Kerala example', async () => {
    const t = makeProvider([route(HttpMethod.Post, CREATE, { json: created('123-456-789') }, query('123-456-789'))]);
    await t.provider.reportExternalTransaction({ ...firstSubscription, amount: 0, taxAmount: 0, transactionTime: '2023-11-01T12:45:00Z' });
    expect(t.apiCalls()[0]?.json).toEqual({
      originalPreTaxAmount: { priceMicros: '0', currency: 'INR' },
      originalTaxAmount: { priceMicros: '0', currency: 'INR' },
      transactionTime: '2023-11-01T12:45:00.000Z',
      recurringTransaction: { externalTransactionToken: 'my_token', externalSubscription: { subscriptionType: 'RECURRING' } },
      userTaxAddress: { regionCode: 'IN', administrativeArea: 'KERALA' },
    });
  });
});

describe('reportExternalTransaction: a renewal [outside-gpb-backend, "Report subsequent transactions"]', () => {
  it('a new id in the query, initialExternalTransactionId in the body and no token', async () => {
    const t = makeProvider([route(HttpMethod.Post, CREATE, { json: created('abc-def-ghi') }, query('abc-def-ghi'))]);
    await t.provider.reportExternalTransaction({
      externalTransactionId: 'abc-def-ghi',
      initialExternalTransactionId: '123-456-789',
      productKind: 'subscription',
      amount: 49950,
      taxAmount: 8991,
      transactionTime: '2026-12-22T12:45:00+05:30',
      state: 'KERALA',
    });
    const [call] = t.apiCalls();
    expect(call?.url).toBe(`${BASE}${CREATE}?externalTransactionId=abc-def-ghi`);
    expect(call?.json).toEqual({
      originalPreTaxAmount: { currency: 'INR', priceMicros: '499500000' },
      originalTaxAmount: { currency: 'INR', priceMicros: '89910000' },
      transactionTime: '2026-12-22T07:15:00.000Z',
      recurringTransaction: { initialExternalTransactionId: '123-456-789', externalSubscription: { subscriptionType: 'RECURRING' } },
      userTaxAddress: { regionCode: 'IN', administrativeArea: 'KERALA' },
    });
    expect(JSON.stringify(call?.json)).not.toContain('externalTransactionToken');
  });
});

describe('reportExternalTransaction: what is refused before any call', () => {
  const refused = async (input: Record<string, unknown>) => {
    const t = makeProvider([], { tokens: 0 });
    const error = await t.provider.reportExternalTransaction({ ...firstSubscription, ...input } as never).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SubscriptionError);
    expect(error).toMatchObject({ code: ErrorCode.Validation });
    expect(t.calls).toHaveLength(0);
    return (error as Error).message;
  };

  it('a state Google does not list', async () => {
    expect(await refused({ state: 'Atlantis' })).toMatch(/administrativeArea/);
  });
  it('an id Google would reject: more than 63 characters or characters outside A-Z a-z 0-9 _ -', async () => {
    expect(await refused({ externalTransactionId: 'x'.repeat(64) })).toMatch(/1 to 63/);
    expect(await refused({ externalTransactionId: 'order 7' })).toMatch(/1 to 63/);
    expect(await refused({ externalTransactionToken: undefined, initialExternalTransactionId: 'a b' })).toMatch(/1 to 63/);
  });
  it('neither or both of the token and the initial id', async () => {
    await refused({ externalTransactionToken: undefined });
    await refused({ initialExternalTransactionId: '123-456-789' });
  });
  it('a one-time purchase that refers to an earlier transaction', async () => {
    expect(await refused({ productKind: 'one_time', externalTransactionToken: undefined, initialExternalTransactionId: 'first' })).toMatch(/device/);
  });
  it('amounts that are not whole paise', async () => {
    await refused({ amount: 10.5 });
    await refused({ taxAmount: -1 });
  });
  it('a transaction time that is not a date', async () => {
    await refused({ transactionTime: 'yesterday' });
  });

  it.each([
    ['Jammu & Kashmir', 'JAMMU AND KASHMIR'],
    ['  tamil   nadu ', 'TAMIL NADU'],
    ['Dadra and Nagar Haveli and Daman and Diu', 'DADRA AND NAGAR HAVELI AND DAMAN AND DIU'],
    ['Delhi', 'DELHI'],
  ])('the state "%s" is sent as %s', async (state, area) => {
    const t = makeProvider([route(HttpMethod.Post, CREATE, { json: created('123-456-789') }, query('123-456-789'))]);
    await t.provider.reportExternalTransaction({ ...firstSubscription, state });
    expect((t.apiCalls()[0]?.json as { userTaxAddress: { administrativeArea: string } }).userTaxAddress.administrativeArea).toBe(area);
  });
});

describe('refundExternalTransaction [refundexternaltransaction]', () => {
  const REFUND = `${P}/externalTransactions/123-456-789:refund`;

  it('a full refund: refundTime and an empty fullRefund', async () => {
    const t = makeProvider([route(HttpMethod.Post, REFUND, { json: EXTERNAL_REFUND_RESPONSE_SAMPLE })]);
    const record = await t.provider.refundExternalTransaction({ externalTransactionId: '123-456-789', refundTime: '2026-11-23T10:00:00Z' });
    expect(t.apiCalls()[0]).toMatchObject({ method: 'POST', url: `${BASE}${REFUND}` });
    expect(t.apiCalls()[0]?.json).toEqual({ refundTime: '2026-11-23T10:00:00.000Z', fullRefund: {} });
    expect(record).toMatchObject({ state: 'TRANSACTION_CANCELED' });
    expect(record.externalTransactionId).toBe('1234567890123456789012345678901234567890123456789012345678901234');
  });

  it('a partial refund: a unique refundId and the pre-tax amount in micros; the tax is not sent', async () => {
    const t = makeProvider([route(HttpMethod.Post, REFUND, { json: created('123-456-789') })]);
    await t.provider.refundExternalTransaction({ externalTransactionId: '123-456-789', refundTime: '2023-10-20T16:43:32.852Z', amount: 10120, taxAmount: 1822 });
    expect(t.apiCalls()[0]?.json).toEqual({
      refundTime: '2023-10-20T16:43:32.852Z',
      partialRefund: { refundId: 'r1697820212852-10120', refundPreTaxAmount: { currency: 'INR', priceMicros: '101200000' } },
    });
  });

  it('refuses a tax amount without an amount, and an unusable id, before any call', async () => {
    const t = makeProvider([], { tokens: 0 });
    await expect(t.provider.refundExternalTransaction({ externalTransactionId: '123-456-789', refundTime: '2026-11-23T10:00:00Z', taxAmount: 5 })).rejects.toMatchObject({ code: ErrorCode.Validation });
    await expect(t.provider.refundExternalTransaction({ externalTransactionId: 'bad id', refundTime: '2026-11-23T10:00:00Z' })).rejects.toMatchObject({ code: ErrorCode.Validation });
    expect(t.calls).toHaveLength(0);
  });
});

describe('the shape of the errors', () => {
  it('Google\'s refusal: the code from the HTTP status, providerCode = Google\'s reason, raw = Google\'s body', async () => {
    const body = { error: { code: 403, message: 'The caller does not have permission', status: 'PERMISSION_DENIED', errors: [{ reason: 'userInsufficientPermission' }] } };
    const t = makeProvider([route(HttpMethod.Post, CREATE, { status: 403, json: body }, query('123-456-789'))]);
    const error = (await t.provider.reportExternalTransaction(firstSubscription).catch((caught: unknown) => caught)) as SubscriptionError;
    expect(error).toBeInstanceOf(SubscriptionError);
    expect(error).toMatchObject({ code: ErrorCode.Auth, provider: 'google_play', httpStatus: 403, providerCode: 'userInsufficientPermission', raw: body });
    expect(error.message).toContain('The caller does not have permission');
    expect(error.retryable).toBe(false);
  });

  it('a rate limit is RATE_LIMITED and retryable', async () => {
    const t = makeProvider([route(HttpMethod.Post, CREATE, { status: 429, json: { error: { message: 'quota', status: 'RESOURCE_EXHAUSTED' } } }, query('123-456-789'))]);
    const error = (await t.provider.reportExternalTransaction(firstSubscription).catch((caught: unknown) => caught)) as SubscriptionError;
    expect(error).toMatchObject({ code: ErrorCode.RateLimited, providerCode: 'RESOURCE_EXHAUSTED' });
    expect(error.retryable).toBe(true);
  });

  it('a 5xx on the create is OUTCOME_UNKNOWN, after Google was asked what it holds', async () => {
    const t = makeProvider([
      route(HttpMethod.Post, CREATE, { status: 503, json: { error: { message: 'down' } } }, query('123-456-789')),
      route(HttpMethod.Get, `${P}/externalTransactions/123-456-789`, { status: 404, json: { error: { message: 'not found' } } }),
    ]);
    await expect(t.provider.reportExternalTransaction(firstSubscription)).rejects.toMatchObject({ code: ErrorCode.OutcomeUnknown });
    expect(t.apiCalls()[1]).toMatchObject({ method: 'GET', url: `${BASE}${P}/externalTransactions/123-456-789` });
  });
});

describe('reporting twice is safe', () => {
  const GET = `${P}/externalTransactions/123-456-789`;
  const held = created('123-456-789', { originalPreTaxAmount: { currency: 'INR', priceMicros: '499500000' } });

  it('an unanswered create that Google did record is returned as reported', async () => {
    const t = makeProvider([
      { method: HttpMethod.Post, url: `${BASE}${CREATE}?externalTransactionId=123-456-789`, networkError: true },
      route(HttpMethod.Get, GET, { json: held }),
    ]);
    const record = await t.provider.reportExternalTransaction(firstSubscription);
    expect(record).toMatchObject({ externalTransactionId: '123-456-789', state: 'TRANSACTION_REPORTED' });
  });

  it('an id that is taken (409) by the same transaction is returned as reported', async () => {
    const t = makeProvider([
      route(HttpMethod.Post, CREATE, { status: 409, json: { error: { message: 'exists', status: 'ALREADY_EXISTS' } } }, query('123-456-789')),
      route(HttpMethod.Get, GET, { json: held }),
    ]);
    await expect(t.provider.reportExternalTransaction(firstSubscription)).resolves.toMatchObject({ state: 'TRANSACTION_REPORTED' });
  });

  it('an id that is taken by a transaction of another amount stays a CONFLICT', async () => {
    const other = created('123-456-789', { originalPreTaxAmount: { currency: 'INR', priceMicros: '1' } });
    const t = makeProvider([
      route(HttpMethod.Post, CREATE, { status: 409, json: { error: { message: 'exists' } } }, query('123-456-789')),
      route(HttpMethod.Get, GET, { json: other }),
    ]);
    await expect(t.provider.reportExternalTransaction(firstSubscription)).rejects.toMatchObject({ code: ErrorCode.Conflict });
  });

  it('a full refund whose answer was lost is recognised when the transaction shows as cancelled', async () => {
    const REFUND = `${BASE}${GET}:refund`;
    const t = makeProvider([
      { method: HttpMethod.Post, url: REFUND, networkError: true },
      route(HttpMethod.Get, GET, { json: { ...held, transactionState: 'TRANSACTION_CANCELED' } }),
    ]);
    await expect(t.provider.refundExternalTransaction({ externalTransactionId: '123-456-789', refundTime: '2026-11-23T10:00:00Z' })).resolves.toMatchObject({ state: 'TRANSACTION_CANCELED' });
  });

  it('a partial refund whose answer was lost is recognised when the current amount shows it', async () => {
    const REFUND = `${BASE}${GET}:refund`;
    const after = { ...held, currentPreTaxAmount: { currency: 'INR', priceMicros: '398300000' } };
    const t = makeProvider([{ method: HttpMethod.Post, url: REFUND, networkError: true }, route(HttpMethod.Get, GET, { json: after })]);
    await expect(
      t.provider.refundExternalTransaction({ externalTransactionId: '123-456-789', refundTime: '2023-10-20T16:43:32.852Z', amount: 10120 }),
    ).resolves.toBeTruthy();
  });

  it('a partial refund the transaction does not show stays OUTCOME_UNKNOWN', async () => {
    const REFUND = `${BASE}${GET}:refund`;
    const t = makeProvider([{ method: HttpMethod.Post, url: REFUND, networkError: true }, route(HttpMethod.Get, GET, { json: { ...held, currentPreTaxAmount: held.originalPreTaxAmount } })]);
    await expect(
      t.provider.refundExternalTransaction({ externalTransactionId: '123-456-789', refundTime: '2023-10-20T16:43:32.852Z', amount: 10120 }),
    ).rejects.toMatchObject({ code: ErrorCode.OutcomeUnknown });
  });
});
