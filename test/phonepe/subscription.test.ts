import { describe, expect, it } from 'vitest';
import {
  CancelMode,
  CheckoutKind,
  Currency,
  Environment,
  ErrorCode,
  HttpMethod,
  IntervalUnit,
  PaymentMethod,
  Provider,
  SchedulingMode,
  SubscriptionStatus,
} from '../../src/constants.js';
import { frequencyFor, returnUrlFor, setupOrderIdFor } from '../../src/providers/phonepe/index.js';
import {
  ERROR_INVALID_MERCHANT_ORDER_ID,
  ERROR_SUBSCRIPTION_NOT_FOUND,
  SETUP_ORDER_COMPLETED_SC_ORDER,
  SETUP_ORDER_FAILED_A_ORDER,
  SETUP_ORDER_PENDING,
  SETUP_RESPONSE_SC_SETUP,
  SUBSCRIPTION_STATUS_A_SUBSTATUS,
  SUBSCRIPTION_STATUS_PAUSED,
  SUBSCRIPTION_STATUS_SC_SUBSTATUS,
} from './fixtures.js';
import {
  CUSTOMER,
  DAY,
  MONTHLY_PLAN,
  NOW,
  O_BEARER,
  PRODUCTION_API,
  RETURN_URL,
  SANDBOX_API,
  makeProvider,
  noContent,
  rejection,
  route,
} from './helpers.js';

const PAY = '/checkout/v2/pay';
const REF = 'sub_ref_1';
const SETUP_ORDER = 'ST_sub_ref_1';
const statusPath = (id: string) => `/checkout/v2/subscriptions/${id}/status`;
const orderPath = (id: string) => `/checkout/v2/order/${id}/status?details=true`;
const cancelPath = (id: string) => `/checkout/v2/subscriptions/${id}/cancel`;

/** Calendar maths written out independently of the adapter: +29 years from NOW keeps the wall-clock time. */
const IN_29_YEARS_MS = Date.UTC(2055, 10, 17, 5, 0, 0);
const IN_30_YEARS_MS = Date.UTC(2056, 10, 17, 5, 0, 0);

const payRoute = () => route(HttpMethod.Post, PAY, { json: SETUP_RESPONSE_SC_SETUP });

describe('createSubscription: the setup request', () => {
  it('trial: POST /checkout/v2/pay as a PENNY_DROP of 200 paise, with the exact documented body [SC-SETUP]', async () => {
    const t = makeProvider([payRoute()]);
    const subscription = await t.provider.createSubscription({
      reference: REF,
      plan: { ...MONTHLY_PLAN },
      customer: CUSTOMER,
      returnUrl: RETURN_URL,
      trial: { days: 7 },
    });

    const [call] = t.apiCalls();
    expect(call).toMatchObject({ method: 'POST', url: `${SANDBOX_API}${PAY}` });
    expect(call?.headers).toMatchObject({ authorization: O_BEARER(), 'content-type': 'application/json' });
    expect(call?.json).toEqual({
      merchantOrderId: SETUP_ORDER,
      amount: 200,
      paymentFlow: {
        type: 'SUBSCRIPTION_CHECKOUT_SETUP',
        merchantUrls: { redirectUrl: `${RETURN_URL}?merchantSubscriptionId=${REF}` },
        subscriptionDetails: {
          subscriptionType: 'RECURRING',
          merchantSubscriptionId: REF,
          authWorkflowType: 'PENNY_DROP',
          amountType: 'FIXED',
          maxAmount: 49900,
          frequency: 'MONTHLY',
          productType: 'UPI_MANDATE',
          expireAt: IN_29_YEARS_MS,
        },
      },
    });
    // No order expiry was asked for, so none is sent; no metadata, so no metaInfo.
    expect(call?.json).not.toHaveProperty('expireAfter');
    expect(call?.json).not.toHaveProperty('metaInfo');

    expect(subscription).toMatchObject({
      provider: Provider.PhonePe,
      id: REF,
      reference: REF,
      status: SubscriptionStatus.Created,
      providerStatus: 'PENDING',
      scheduling: SchedulingMode.Merchant,
      amount: 49900,
      maxAmount: 49900,
      currency: Currency.INR,
      interval: { unit: IntervalUnit.Month, count: 1 },
      createdAt: NOW.toISOString(),
      startAt: new Date(NOW.getTime() + 7 * DAY).toISOString(),
      trialEndsAt: new Date(NOW.getTime() + 7 * DAY).toISOString(),
      mandateEndsAt: new Date(IN_29_YEARS_MS).toISOString(),
      paymentMethod: PaymentMethod.Upi,
      customer: CUSTOMER,
    });
    // PhonePe's redirectUrl, byte for byte: "you must use this exactly as received, without modifications".
    expect(subscription.checkout).toEqual({ kind: CheckoutKind.Redirect, url: SETUP_RESPONSE_SC_SETUP.redirectUrl });
    expect(subscription.raw).toMatchObject({ orderId: SETUP_RESPONSE_SC_SETUP.orderId });
  });

  it('upfront amount: a TRANSACTION whose amount is the upfront amount', async () => {
    const t = makeProvider([payRoute()]);
    const subscription = await t.provider.createSubscription({
      reference: REF,
      plan: { ...MONTHLY_PLAN },
      customer: CUSTOMER,
      returnUrl: RETURN_URL,
      upfrontAmount: 29900,
      startAt: new Date(NOW.getTime() + 30 * DAY).toISOString(),
    });
    const body = t.apiCalls()[0]?.json as { amount: number; paymentFlow: { subscriptionDetails: Record<string, unknown> } };
    expect(body.amount).toBe(29900);
    expect(body.paymentFlow.subscriptionDetails).toMatchObject({ authWorkflowType: 'TRANSACTION', maxAmount: 49900 });
    expect(subscription.startAt).toBe(new Date(NOW.getTime() + 30 * DAY).toISOString());
    expect(subscription.trialEndsAt).toBeUndefined();
  });

  it('no trial and no upfront: still a PENNY_DROP, and the first debit is "now" (a notification and 24 hours of notice come first)', async () => {
    const t = makeProvider([payRoute()]);
    const subscription = await t.provider.createSubscription({ reference: REF, plan: { ...MONTHLY_PLAN }, customer: CUSTOMER, returnUrl: RETURN_URL });
    expect((t.apiCalls()[0]?.json as { amount: number }).amount).toBe(200);
    expect(subscription.startAt).toBe(NOW.toISOString());
  });

  it('a larger plan maxAmount makes the mandate VARIABLE with that cap; an equal one stays FIXED', async () => {
    const variable = makeProvider([payRoute()]);
    const sub = await variable.provider.createSubscription({
      reference: REF,
      plan: { ...MONTHLY_PLAN, maxAmount: 99900 },
      customer: CUSTOMER,
      returnUrl: RETURN_URL,
    });
    expect(
      (variable.apiCalls()[0]?.json as { paymentFlow: { subscriptionDetails: Record<string, unknown> } }).paymentFlow.subscriptionDetails,
    ).toMatchObject({ amountType: 'VARIABLE', maxAmount: 99900 });
    expect(sub.maxAmount).toBe(99900);
    expect(sub.amount).toBe(49900);

    const fixed = makeProvider([payRoute()]);
    await fixed.provider.createSubscription({
      reference: REF,
      plan: { ...MONTHLY_PLAN, maxAmount: 49900 },
      customer: CUSTOMER,
      returnUrl: RETURN_URL,
    });
    expect(
      (fixed.apiCalls()[0]?.json as { paymentFlow: { subscriptionDetails: Record<string, unknown> } }).paymentFlow.subscriptionDetails.amountType,
    ).toBe('FIXED');
  });

  it('production: POST https://api.phonepe.com/apis/pg/checkout/v2/pay', async () => {
    const t = makeProvider([{ method: HttpMethod.Post, url: `${PRODUCTION_API}${PAY}`, json: SETUP_RESPONSE_SC_SETUP }], { environment: Environment.Live });
    await t.provider.createSubscription({ reference: REF, plan: { ...MONTHLY_PLAN }, customer: CUSTOMER, returnUrl: RETURN_URL });
    expect(t.apiCalls()[0]?.url).toBe(`${PRODUCTION_API}${PAY}`);
  });

  it('generates a subscription id when no reference is given, and derives the setup order id from it', async () => {
    const t = makeProvider([payRoute()]);
    const subscription = await t.provider.createSubscription({ plan: { ...MONTHLY_PLAN }, customer: CUSTOMER, returnUrl: RETURN_URL });
    expect(subscription.id).toBe('sub_00000001');
    expect(subscription.reference).toBe('sub_00000001');
    expect((t.apiCalls()[0]?.json as { merchantOrderId: string }).merchantOrderId).toBe(setupOrderIdFor('sub_00000001'));
    expect(setupOrderIdFor('sub_00000001')).toBe('ST_sub_00000001');
  });

  it('the default redirectUrl of the config is used when the input has none; an existing query is kept and the id is added', async () => {
    const t = makeProvider([payRoute(), payRoute()], { config: { redirectUrl: 'https://merchant.example/back?src=autopay' } });
    await t.provider.createSubscription({ reference: REF, plan: { ...MONTHLY_PLAN }, customer: CUSTOMER });
    const sent = (t.apiCalls()[0]?.json as { paymentFlow: { merchantUrls: { redirectUrl: string } } }).paymentFlow.merchantUrls.redirectUrl;
    expect(new URL(sent).searchParams.get('src')).toBe('autopay');
    expect(new URL(sent).searchParams.get('merchantSubscriptionId')).toBe(REF);
    // The caller's returnUrl wins over the config's.
    await t.provider.createSubscription({ reference: 'sub_ref_2', plan: { ...MONTHLY_PLAN }, customer: CUSTOMER, returnUrl: RETURN_URL });
    expect((t.apiCalls()[1]?.json as { paymentFlow: { merchantUrls: { redirectUrl: string } } }).paymentFlow.merchantUrls.redirectUrl).toBe(
      `${RETURN_URL}?merchantSubscriptionId=sub_ref_2`,
    );
  });

  it('returnUrlFor replaces a subscription id parameter the URL already has (a caller cannot point the return at another subscription)', () => {
    expect(returnUrlFor(`${RETURN_URL}?merchantSubscriptionId=evil`, REF)).toBe(`${RETURN_URL}?merchantSubscriptionId=${REF}`);
  });

  it('sends udf1-udf15 metadata as metaInfo and keeps every other metadata key on the returned subscription only', async () => {
    const t = makeProvider([payRoute()]);
    const subscription = await t.provider.createSubscription({
      reference: REF,
      plan: { ...MONTHLY_PLAN },
      customer: CUSTOMER,
      returnUrl: RETURN_URL,
      metadata: { udf1: 'order 77', udf12: 'short_value-1', plan_code: 'pro' },
    });
    expect((t.apiCalls()[0]?.json as { metaInfo: unknown }).metaInfo).toEqual({ udf1: 'order 77', udf12: 'short_value-1' });
    expect(subscription.metadata).toEqual({ udf1: 'order 77', udf12: 'short_value-1', plan_code: 'pro' });
  });

  it('maps authorizeBy to expireAfter in seconds', async () => {
    const t = makeProvider([payRoute()]);
    await t.provider.createSubscription({
      reference: REF,
      plan: { ...MONTHLY_PLAN },
      customer: CUSTOMER,
      returnUrl: RETURN_URL,
      authorizeBy: new Date(NOW.getTime() + 20 * 60 * 1000).toISOString(),
    });
    expect((t.apiCalls()[0]?.json as { expireAfter: number }).expireAfter).toBe(1200);
  });
});

describe('createSubscription: the mandate validity (expireAt)', () => {
  const expireAtOf = (t: ReturnType<typeof makeProvider>) =>
    (t.apiCalls()[0]?.json as { paymentFlow: { subscriptionDetails: { expireAt: number } } }).paymentFlow.subscriptionDetails.expireAt;

  it('mandateEndsAt is sent as epoch milliseconds and returned', async () => {
    const t = makeProvider([payRoute()]);
    const endsAt = '2028-03-01T00:00:00.000Z';
    const subscription = await t.provider.createSubscription({
      reference: REF,
      plan: { ...MONTHLY_PLAN },
      customer: CUSTOMER,
      returnUrl: RETURN_URL,
      mandateEndsAt: endsAt,
    });
    expect(expireAtOf(t)).toBe(Date.parse(endsAt));
    expect(subscription.mandateEndsAt).toBe(endsAt);
  });

  it('totalCycles: the last debit date plus 7 days of grace for retries', async () => {
    const t = makeProvider([payRoute()]);
    const subscription = await t.provider.createSubscription({
      reference: REF,
      plan: { ...MONTHLY_PLAN },
      customer: CUSTOMER,
      returnUrl: RETURN_URL,
      startAt: '2026-12-01T05:00:00.000Z',
      totalCycles: 12,
    });
    // 12 monthly debits from 1 Dec 2026: the last is 1 Nov 2027; + 7 days.
    expect(expireAtOf(t)).toBe(Date.UTC(2027, 10, 8, 5, 0, 0));
    expect(subscription.totalCycles).toBe(12);
    expect(subscription.mandateEndsAt).toBe('2027-11-08T05:00:00.000Z');
  });

  it('the plan maxCycles counts as totalCycles', async () => {
    const t = makeProvider([payRoute()]);
    await t.provider.createSubscription({
      reference: REF,
      plan: { ...MONTHLY_PLAN, maxCycles: 3 },
      customer: CUSTOMER,
      returnUrl: RETURN_URL,
      startAt: '2026-12-01T05:00:00.000Z',
    });
    expect(expireAtOf(t)).toBe(Date.UTC(2027, 1, 8, 5, 0, 0));
  });

  it('no end: 29 years, one inside the documented maximum of 30', async () => {
    const t = makeProvider([payRoute()]);
    await t.provider.createSubscription({ reference: REF, plan: { ...MONTHLY_PLAN }, customer: CUSTOMER, returnUrl: RETURN_URL });
    expect(expireAtOf(t)).toBe(IN_29_YEARS_MS);
    expect(IN_29_YEARS_MS).toBeLessThan(IN_30_YEARS_MS);
  });
});

describe('createSubscription: frequency', () => {
  it.each([
    [IntervalUnit.Day, 1, 'DAILY'],
    [IntervalUnit.Week, 1, 'WEEKLY'],
    [IntervalUnit.Day, 7, 'WEEKLY'],
    [IntervalUnit.Week, 2, 'FORTNIGHTLY'],
    [IntervalUnit.Day, 14, 'FORTNIGHTLY'],
    [IntervalUnit.Month, 1, 'MONTHLY'],
    [IntervalUnit.Month, 3, 'QUARTERLY'],
    [IntervalUnit.Month, 6, 'HALFYEARLY'],
    [IntervalUnit.Month, 12, 'YEARLY'],
    [IntervalUnit.Year, 1, 'YEARLY'],
    // No exact PhonePe frequency: ON_DEMAND ("as presented"). BIMONTHLY is deliberately never sent: its meaning is ambiguous.
    [IntervalUnit.Month, 2, 'ON_DEMAND'],
    [IntervalUnit.Month, 4, 'ON_DEMAND'],
    [IntervalUnit.Day, 5, 'ON_DEMAND'],
    [IntervalUnit.Day, 30, 'ON_DEMAND'],
    [IntervalUnit.Week, 3, 'ON_DEMAND'],
    [IntervalUnit.Year, 2, 'ON_DEMAND'],
  ] as const)('%s x %i is %s', (unit, count, expected) => {
    expect(frequencyFor({ unit, count })).toBe(expected);
  });

  it('is what the request carries', async () => {
    const t = makeProvider([payRoute()]);
    await t.provider.createSubscription({
      reference: REF,
      plan: { ...MONTHLY_PLAN, interval: { unit: IntervalUnit.Week, count: 2 } },
      customer: CUSTOMER,
      returnUrl: RETURN_URL,
    });
    expect((t.apiCalls()[0]?.json as { paymentFlow: { subscriptionDetails: { frequency: string } } }).paymentFlow.subscriptionDetails.frequency).toBe('FORTNIGHTLY');
  });
});

describe('createSubscription: input the adapter refuses before any request', () => {
  const base = { reference: REF, plan: { ...MONTHLY_PLAN }, customer: CUSTOMER, returnUrl: RETURN_URL };

  async function refused(input: Record<string, unknown>, code: ErrorCode, messagePart?: RegExp) {
    const t = makeProvider([]);
    const error = await rejection(() => t.provider.createSubscription({ ...base, ...input } as never));
    expect(error.code).toBe(code);
    if (messagePart) expect(error.message).toMatch(messagePart);
    expect(t.calls).toHaveLength(0);
  }

  it('a string plan id: VALIDATION (PhonePe has no plan API)', () => refused({ plan: 'plan_123' }, ErrorCode.Validation, /plan API/));
  it('a gateway-scheduled plan: UNSUPPORTED', () => refused({ plan: { ...MONTHLY_PLAN, scheduling: SchedulingMode.Gateway } }, ErrorCode.Unsupported));
  it('quantity above 1: UNSUPPORTED', () => refused({ quantity: 2 }, ErrorCode.Unsupported));
  it('payment methods without UPI: VALIDATION', () => refused({ paymentMethods: [PaymentMethod.Card] }, ErrorCode.Validation, /UPI/));
  it('a plan amount under 100 paise (the notify minimum): VALIDATION', () => refused({ plan: { ...MONTHLY_PLAN, amount: 99 } }, ErrorCode.Validation, /100 paise/));
  it('a mandate ceiling above INR 15,000: VALIDATION', () => refused({ plan: { ...MONTHLY_PLAN, maxAmount: 1_500_001 } }, ErrorCode.Validation, /1500000/));
  it('an upfront amount under 100 paise: VALIDATION', () => refused({ upfrontAmount: 99 }, ErrorCode.Validation, /100 paise/));
  it('a reference with characters outside [A-Za-z0-9_-]: VALIDATION', () => refused({ reference: 'sub 1!' }, ErrorCode.Validation));
  it('a reference longer than 60 characters (the setup order id would exceed 63): VALIDATION', () =>
    refused({ reference: 'x'.repeat(61) }, ErrorCode.Validation));
  it('authorizeBy under 300 seconds away: VALIDATION', () =>
    refused({ authorizeBy: new Date(NOW.getTime() + 60_000).toISOString() }, ErrorCode.Validation, /300 to 3600/));
  it('authorizeBy over an hour away: VALIDATION (not silently shortened)', () =>
    refused({ authorizeBy: new Date(NOW.getTime() + 2 * 3600_000).toISOString() }, ErrorCode.Validation, /300 to 3600/));
  it('a mandate end more than 30 years away: VALIDATION', () =>
    refused({ mandateEndsAt: new Date(IN_30_YEARS_MS + DAY).toISOString() }, ErrorCode.Validation, /30 years/));
  it('a mandate end in the past: VALIDATION', () => refused({ mandateEndsAt: '2020-01-01T00:00:00.000Z' }, ErrorCode.Validation));
  it('totalCycles that would outlive 30 years: VALIDATION', () =>
    refused({ plan: { ...MONTHLY_PLAN, interval: { unit: IntervalUnit.Day, count: 1 } }, totalCycles: 20000 }, ErrorCode.Validation, /30 years/));
  it('metadata in a udf field that is too long: VALIDATION', () => refused({ metadata: { udf11: 'x'.repeat(51) } }, ErrorCode.Validation));
  it('metadata in a short udf field with characters outside the allowed set: VALIDATION', () => refused({ metadata: { udf13: 'bad/value' } }, ErrorCode.Validation));
  it('trial together with startAt: VALIDATION', () =>
    refused({ trial: { days: 3 }, startAt: new Date(NOW.getTime() + 5 * DAY).toISOString() }, ErrorCode.Validation));

  it('no returnUrl anywhere: VALIDATION', async () => {
    const t = makeProvider([], { config: { redirectUrl: undefined } });
    const error = await rejection(() => t.provider.createSubscription({ reference: REF, plan: { ...MONTHLY_PLAN }, customer: CUSTOMER }));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(error.message).toMatch(/returnUrl/);
    expect(t.calls).toHaveLength(0);
  });

  it('a refusal by PhonePe is mapped: BAD_REQUEST is VALIDATION and carries the PhonePe code', async () => {
    const t = makeProvider([route(HttpMethod.Post, PAY, { status: 400, json: { code: 'BAD_REQUEST', message: 'Please check the inputs you have provided.' } })]);
    const error = await rejection(() => t.provider.createSubscription(base));
    expect(error).toMatchObject({ code: ErrorCode.Validation, providerCode: 'BAD_REQUEST', httpStatus: 400 });
  });

  it('a dropped connection on the setup is OUTCOME_UNKNOWN (the order may exist)', async () => {
    const t = makeProvider([route(HttpMethod.Post, PAY, { networkError: true })]);
    expect((await rejection(() => t.provider.createSubscription(base))).code).toBe(ErrorCode.OutcomeUnknown);
  });

  it('a response without a usable redirectUrl: UNEXPECTED_RESPONSE', async () => {
    const t = makeProvider([route(HttpMethod.Post, PAY, { json: { orderId: 'OMO1', state: 'PENDING' } })]);
    expect((await rejection(() => t.provider.createSubscription(base))).code).toBe(ErrorCode.UnexpectedResponse);
  });
});

describe('getSubscription: the status endpoint', () => {
  it('GET /checkout/v2/subscriptions/{id}/status: the verbatim [SC-SUBSTATUS] sample', async () => {
    const t = makeProvider([route(HttpMethod.Get, statusPath('Sub123'), { json: SUBSCRIPTION_STATUS_SC_SUBSTATUS })]);
    const subscription = await t.provider.getSubscription('Sub123');
    expect(t.apiCalls()[0]).toMatchObject({ method: 'GET', url: `${SANDBOX_API}${statusPath('Sub123')}` });
    expect(t.apiCalls()[0]?.headers.authorization).toBe(O_BEARER());
    expect(subscription).toMatchObject({
      provider: Provider.PhonePe,
      id: 'Sub123',
      reference: 'Sub123',
      status: SubscriptionStatus.Active,
      providerStatus: 'ACTIVE',
      scheduling: SchedulingMode.Merchant,
      maxAmount: 100,
      currency: Currency.INR,
      mandateEndsAt: new Date(1779689282000).toISOString(),
      paymentMethod: PaymentMethod.Upi,
    });
    // ON_DEMAND has no exact interval.
    expect(subscription.interval).toBeUndefined();
    expect(subscription.raw).toMatchObject({ subscriptionId: 'OMS2604141037458806131949V' });
  });

  it('the verbatim [A-SUBSTATUS] sample, and a named frequency gives the interval back', async () => {
    const t = makeProvider([
      route(HttpMethod.Get, statusPath('MS27'), { json: SUBSCRIPTION_STATUS_A_SUBSTATUS }),
      route(HttpMethod.Get, statusPath('MS27'), { json: { ...SUBSCRIPTION_STATUS_A_SUBSTATUS, frequency: 'QUARTERLY' } }),
    ]);
    expect((await t.provider.getSubscription('MS27')).status).toBe(SubscriptionStatus.Active);
    expect((await t.provider.getSubscription('MS27')).interval).toEqual({ unit: IntervalUnit.Month, count: 3 });
  });

  it('accepts maxAmount as a number or as a numeric string (the pages print both)', async () => {
    const t = makeProvider([route(HttpMethod.Get, statusPath('MS27'), { json: { ...SUBSCRIPTION_STATUS_A_SUBSTATUS, maxAmount: '4900' } })]);
    expect((await t.provider.getSubscription('MS27')).maxAmount).toBe(4900);
  });

  it.each([
    ['ACTIVATION_IN_PROGRESS', SubscriptionStatus.PendingAuthorization],
    ['ACTIVE', SubscriptionStatus.Active],
    ['PAUSE_IN_PROGRESS', SubscriptionStatus.Paused],
    ['PAUSED', SubscriptionStatus.Paused],
    ['UNPAUSE_IN_PROGRESS', SubscriptionStatus.Paused],
    ['CANCEL_IN_PROGRESS', SubscriptionStatus.Cancelled],
    ['CANCELLED', SubscriptionStatus.Cancelled],
    ['REVOKE_IN_PROGRESS', SubscriptionStatus.Cancelled],
    ['REVOKED', SubscriptionStatus.Cancelled],
    ['EXPIRED', SubscriptionStatus.Expired],
    ['FAILED', SubscriptionStatus.Failed],
    // A state PhonePe adds tomorrow: visible verbatim, and mapped to the one status nothing acts on.
    ['SOMETHING_NEW', SubscriptionStatus.PendingAuthorization],
    ['constructor', SubscriptionStatus.PendingAuthorization],
  ])('state %s is %s, and stays verbatim in providerStatus', async (state, expected) => {
    const t = makeProvider([route(HttpMethod.Get, statusPath('Sub123'), { json: { ...SUBSCRIPTION_STATUS_SC_SUBSTATUS, state } })]);
    const subscription = await t.provider.getSubscription('Sub123');
    expect(subscription.status).toBe(expected);
    expect(subscription.providerStatus).toBe(state);
  });

  it('a paused mandate keeps its pause dates in raw', async () => {
    const t = makeProvider([route(HttpMethod.Get, statusPath('MS27'), { json: SUBSCRIPTION_STATUS_PAUSED })]);
    const subscription = await t.provider.getSubscription('MS27');
    expect(subscription.status).toBe(SubscriptionStatus.Paused);
    expect(subscription.raw).toMatchObject({ pauseStartDate: 1708798426196, pauseEndDate: 1708885799000 });
  });

  it('production URL', async () => {
    const t = makeProvider([{ method: HttpMethod.Get, url: `${PRODUCTION_API}${statusPath('Sub123')}`, json: SUBSCRIPTION_STATUS_SC_SUBSTATUS }], {
      environment: Environment.Live,
    });
    await t.provider.getSubscription('Sub123');
    expect(t.apiCalls()[0]?.url).toBe(`${PRODUCTION_API}${statusPath('Sub123')}`);
  });

  it('a subscription id the adapter could not have created: VALIDATION, no request', async () => {
    const t = makeProvider([]);
    expect((await rejection(() => t.provider.getSubscription('has/slash'))).code).toBe(ErrorCode.Validation);
    expect(t.calls).toHaveLength(0);
  });

  it('a response without a state: UNEXPECTED_RESPONSE', async () => {
    const t = makeProvider([route(HttpMethod.Get, statusPath('Sub123'), { json: { merchantSubscriptionId: 'Sub123' } })]);
    expect((await rejection(() => t.provider.getSubscription('Sub123'))).code).toBe(ErrorCode.UnexpectedResponse);
  });
});

describe('getSubscription before the customer has authorised: the setup order answers', () => {
  const notFound = () => route(HttpMethod.Get, statusPath(REF), { status: 404, json: ERROR_SUBSCRIPTION_NOT_FOUND });

  it('a setup order still PENDING is `created`', async () => {
    const t = makeProvider([notFound(), route(HttpMethod.Get, orderPath(SETUP_ORDER), { json: SETUP_ORDER_PENDING })]);
    const subscription = await t.provider.getSubscription(REF);
    expect(subscription).toMatchObject({ id: REF, reference: REF, status: SubscriptionStatus.Created, providerStatus: 'PENDING' });
    expect(t.apiCalls().map((call) => call.url)).toEqual([`${SANDBOX_API}${statusPath(REF)}`, `${SANDBOX_API}${orderPath(SETUP_ORDER)}`]);
  });

  it('a FAILED setup order is `failed` (an unfinished setup is failed by PhonePe after its time limit)', async () => {
    const t = makeProvider([notFound(), route(HttpMethod.Get, orderPath(SETUP_ORDER), { json: SETUP_ORDER_FAILED_A_ORDER })]);
    expect((await t.provider.getSubscription(REF)).status).toBe(SubscriptionStatus.Failed);
  });

  it('a COMPLETED setup order whose mandate is not visible yet is `pending_authorization`', async () => {
    const t = makeProvider([notFound(), route(HttpMethod.Get, orderPath(SETUP_ORDER), { json: SETUP_ORDER_COMPLETED_SC_ORDER })]);
    expect((await t.provider.getSubscription(REF)).status).toBe(SubscriptionStatus.PendingAuthorization);
  });

  it('a setup order state PhonePe adds later is `pending_authorization`, verbatim in providerStatus', async () => {
    const t = makeProvider([notFound(), route(HttpMethod.Get, orderPath(SETUP_ORDER), { json: { ...SETUP_ORDER_PENDING, state: 'EXPIRED' } })]);
    const subscription = await t.provider.getSubscription(REF);
    expect(subscription).toMatchObject({ status: SubscriptionStatus.PendingAuthorization, providerStatus: 'EXPIRED' });
  });

  it('neither the mandate nor the setup order exists: NOT_FOUND', async () => {
    const t = makeProvider([
      notFound(),
      route(HttpMethod.Get, orderPath(SETUP_ORDER), { status: 404, json: ERROR_INVALID_MERCHANT_ORDER_ID }),
    ]);
    const error = await rejection(() => t.provider.getSubscription(REF));
    expect(error.code).toBe(ErrorCode.NotFound);
  });

  it('other failures of the status call are not hidden by the fallback', async () => {
    const t = makeProvider([route(HttpMethod.Get, statusPath(REF), { status: 400, json: { code: 'BAD_REQUEST', message: 'x' } })]);
    expect((await rejection(() => t.provider.getSubscription(REF))).code).toBe(ErrorCode.Validation);
    expect(t.apiCalls()).toHaveLength(1);
  });
});

describe('verifyCheckout', () => {
  const ACTIVE = { ...SUBSCRIPTION_STATUS_SC_SUBSTATUS, merchantSubscriptionId: REF };

  it('authorised only when the mandate is ACTIVE, read from PhonePe by the id this adapter put in the return URL', async () => {
    const t = makeProvider([route(HttpMethod.Get, statusPath(REF), { json: ACTIVE })]);
    const verification = await t.provider.verifyCheckout({ merchantSubscriptionId: REF, code: 'PAYMENT_SUCCESS', state: 'COMPLETED' });
    expect(verification).toMatchObject({ provider: Provider.PhonePe, subscriptionId: REF, reference: REF, authorized: true, status: SubscriptionStatus.Active });
    expect(t.apiCalls()).toHaveLength(1);
  });

  it('nothing else in the return is trusted: a "success" claim with a mandate still activating is not authorised', async () => {
    const t = makeProvider([route(HttpMethod.Get, statusPath(REF), { json: { ...ACTIVE, state: 'ACTIVATION_IN_PROGRESS' } })]);
    const verification = await t.provider.verifyCheckout({ merchantSubscriptionId: REF, state: 'COMPLETED', code: 'SUCCESS' });
    expect(verification).toMatchObject({ authorized: false, status: SubscriptionStatus.PendingAuthorization });
  });

  it('a customer who came back without finishing: not authorised, `created`', async () => {
    const t = makeProvider([
      route(HttpMethod.Get, statusPath(REF), { status: 404, json: ERROR_SUBSCRIPTION_NOT_FOUND }),
      route(HttpMethod.Get, orderPath(SETUP_ORDER), { json: SETUP_ORDER_PENDING }),
    ]);
    const verification = await t.provider.verifyCheckout({ merchantSubscriptionId: REF });
    expect(verification).toMatchObject({ authorized: false, status: SubscriptionStatus.Created, subscriptionId: REF });
  });

  it.each([
    ['PAUSED', false],
    ['CANCELLED', false],
    ['REVOKED', false],
    ['FAILED', false],
    ['EXPIRED', false],
  ])('a mandate that is %s is not authorised', async (state) => {
    const t = makeProvider([route(HttpMethod.Get, statusPath(REF), { json: { ...ACTIVE, state } })]);
    expect((await t.provider.verifyCheckout({ merchantSubscriptionId: REF })).authorized).toBe(false);
  });

  it('a return without the subscription id is refused: VALIDATION, no request', async () => {
    const t = makeProvider([]);
    const error = await rejection(() => t.provider.verifyCheckout({ code: 'PAYMENT_SUCCESS' }));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(t.calls).toHaveLength(0);
  });

  it('an id that is not even a legal subscription id never reaches PhonePe', async () => {
    const t = makeProvider([]);
    expect((await rejection(() => t.provider.verifyCheckout({ merchantSubscriptionId: '../../x' }))).code).toBe(ErrorCode.Validation);
    expect(t.calls).toHaveLength(0);
  });
});

describe('cancelSubscription', () => {
  const ACTIVE = { ...SUBSCRIPTION_STATUS_SC_SUBSTATUS, merchantSubscriptionId: REF };
  const CANCELLED = { ...ACTIVE, state: 'CANCELLED' };

  it('reads the mandate, POSTs /checkout/v2/subscriptions/{id}/cancel with no body (204), and returns the fetched status [SC-CANCEL]', async () => {
    const t = makeProvider([
      route(HttpMethod.Get, statusPath(REF), { json: ACTIVE }),
      noContent(route(HttpMethod.Post, cancelPath(REF))),
      route(HttpMethod.Get, statusPath(REF), { json: CANCELLED }),
    ]);
    const subscription = await t.provider.cancelSubscription(REF);
    expect(t.apiCalls().map((call) => `${call.method} ${call.url.replace(SANDBOX_API, '')}`)).toEqual([
      `GET ${statusPath(REF)}`,
      `POST ${cancelPath(REF)}`,
      `GET ${statusPath(REF)}`,
    ]);
    const cancel = t.apiCalls()[1];
    expect(cancel?.body).toBeUndefined();
    expect(cancel?.headers.authorization).toBe(O_BEARER());
    expect(subscription).toMatchObject({ id: REF, status: SubscriptionStatus.Cancelled, providerStatus: 'CANCELLED' });
  });

  it('a mandate that is already over is returned without a cancel call, so cancelling twice is safe', async () => {
    for (const state of ['CANCELLED', 'REVOKED', 'EXPIRED']) {
      const t = makeProvider([route(HttpMethod.Get, statusPath(REF), { json: { ...ACTIVE, state } })]);
      const subscription = await t.provider.cancelSubscription(REF);
      expect(subscription.providerStatus).toBe(state);
      expect(t.apiCalls()).toHaveLength(1);
    }
  });

  it('a 204 whose follow-up status cannot be read still returns a cancelled subscription (the 204 is the answer)', async () => {
    const t = makeProvider([
      route(HttpMethod.Get, statusPath(REF), { json: ACTIVE }),
      noContent(route(HttpMethod.Post, cancelPath(REF))),
      route(HttpMethod.Get, statusPath(REF), { status: 500, json: { code: 'INTERNAL_SERVER_ERROR', message: 'down' } }),
    ]);
    const subscription = await t.provider.cancelSubscription(REF);
    expect(subscription).toMatchObject({ id: REF, status: SubscriptionStatus.Cancelled });
  });

  it('a mandate never authorised cannot be cancelled: PhonePe answers NOT_FOUND and that is what surfaces', async () => {
    const t = makeProvider([
      route(HttpMethod.Get, statusPath(REF), { status: 404, json: ERROR_SUBSCRIPTION_NOT_FOUND }),
      route(HttpMethod.Get, orderPath(SETUP_ORDER), { json: SETUP_ORDER_PENDING }),
      route(HttpMethod.Post, cancelPath(REF), { status: 404, json: ERROR_SUBSCRIPTION_NOT_FOUND }),
    ]);
    const error = await rejection(() => t.provider.cancelSubscription(REF));
    expect(error.code).toBe(ErrorCode.NotFound);
  });

  it('a mandate whose setup failed is already dead: returned as failed, nothing to cancel', async () => {
    const t = makeProvider([
      route(HttpMethod.Get, statusPath(REF), { status: 404, json: ERROR_SUBSCRIPTION_NOT_FOUND }),
      route(HttpMethod.Get, orderPath(SETUP_ORDER), { json: SETUP_ORDER_FAILED_A_ORDER }),
    ]);
    expect((await t.provider.cancelSubscription(REF)).status).toBe(SubscriptionStatus.Failed);
    expect(t.apiCalls().every((call) => call.method === 'GET')).toBe(true);
  });

  it('a dropped connection on the cancel is OUTCOME_UNKNOWN', async () => {
    const t = makeProvider([route(HttpMethod.Get, statusPath(REF), { json: ACTIVE }), route(HttpMethod.Post, cancelPath(REF), { networkError: true })]);
    expect((await rejection(() => t.provider.cancelSubscription(REF))).code).toBe(ErrorCode.OutcomeUnknown);
  });

  it('a 401 on the cancel drops the token and surfaces AUTH; it is not repeated (cancel idempotency is not documented)', async () => {
    const t = makeProvider(
      [
        route(HttpMethod.Get, statusPath(REF), { json: ACTIVE }),
        route(HttpMethod.Post, cancelPath(REF), { status: 401, json: { code: 'UNAUTHORIZED', message: 'x' } }),
      ],
      { tokens: 1 },
    );
    expect((await rejection(() => t.provider.cancelSubscription(REF))).code).toBe(ErrorCode.Auth);
    expect(t.apiCalls().filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('at the end of the period: UNSUPPORTED, no request', async () => {
    const t = makeProvider([]);
    expect((await rejection(() => t.provider.cancelSubscription(REF, { mode: CancelMode.AtPeriodEnd }))).code).toBe(ErrorCode.Unsupported);
    expect(t.calls).toHaveLength(0);
  });
});

describe('operations PhonePe does not have', () => {
  it.each([
    ['createPlan', (p: ReturnType<typeof makeProvider>['provider']) => p.createPlan({ name: 'x', amount: 100, interval: { unit: IntervalUnit.Month, count: 1 } })],
    ['getPlan', (p: ReturnType<typeof makeProvider>['provider']) => p.getPlan('plan_1')],
    ['pauseSubscription', (p: ReturnType<typeof makeProvider>['provider']) => p.pauseSubscription(REF)],
    ['resumeSubscription', (p: ReturnType<typeof makeProvider>['provider']) => p.resumeSubscription(REF)],
    ['updateSubscription', (p: ReturnType<typeof makeProvider>['provider']) => p.updateSubscription(REF, { amount: 100 })],
    ['listCharges', (p: ReturnType<typeof makeProvider>['provider']) => p.listCharges(REF)],
  ])('%s is UNSUPPORTED and makes no request', async (_name, call) => {
    const t = makeProvider([]);
    expect((await rejection(() => call(t.provider))).code).toBe(ErrorCode.Unsupported);
    expect(t.calls).toHaveLength(0);
  });
});
