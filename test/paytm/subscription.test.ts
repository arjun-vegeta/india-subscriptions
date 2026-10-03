import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CheckoutKind,
  ErrorCode,
  GATEWAY_STATUS_UNAVAILABLE,
  PaymentMethod,
  SchedulingMode,
  SubscriptionStatus,
  CancelMode,
} from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import {
  CALLBACK_URL,
  CUSTOMER,
  KEY,
  MID,
  MONTHLY_PLAN,
  NOW,
  PRODUCTION,
  RETURN_URL,
  STAGING,
  makeProvider,
  reply,
  sent,
  statusAnswer,
} from './helpers.js';

const CREATE_URL = `${STAGING}/subscription/create?mid=${MID}&orderId=ORDER_1`;
const STATUS_URL = `${STAGING}/subscription/checkStatus`;
const MODIFY_URL = `${STAGING}/subscription/subscription/status/modify`;
const CANCEL_URL = `${STAGING}/subscription/cancel`;

/** Initiate Subscription success, verbatim [init-sub / api_response SUCCESS]. */
const INITIATE_SUCCESS = {
  head: {
    responseTimestamp: '1567159599647',
    version: 'v1',
    signature: 'YYXL8Kh8s8idlsvHqw04s3c98VWZWRklspaLHx1jWoM9H143P3eL/pxFIJvcs2VI4VmNOyIOTDMZEH2reN364Oq06Ca58/C21/VC8MmjSjc=',
  },
  body: {
    resultInfo: { resultStatus: 'S', resultCode: '0000', resultMsg: 'Success' },
    txnToken: 'aec17f1f674e4f1685d4feb9262f1d731567159599645',
    subscriptionId: '33621',
    isPromoCodeValid: false,
    authenticated: false,
  },
};

/** Initiate Subscription failure, verbatim [init-sub / api_response FAIL]. */
const INITIATE_FAIL_4001 = {
  head: { requestId: null, responseTimestamp: '1567159555926', version: 'v1' },
  body: { resultInfo: { resultStatus: 'F', resultCode: '4001', resultMsg: 'Invalid Frequency Unit' }, extraParamsMap: null },
};

const createRoute = { url: CREATE_URL, json: INITIATE_SUCCESS };

/** The body the adapter sends for the default merchant-collected monthly plan created at NOW (10:30 IST, 17 Nov 2026). */
const MERCHANT_BODY = {
  requestType: 'NATIVE_SUBSCRIPTION',
  mid: MID,
  websiteName: 'WEBSTAGING',
  orderId: 'ORDER_1',
  txnAmount: { value: '0', currency: 'INR' },
  userInfo: { custId: 'CUST_001', mobile: '9876543210', email: 'ashish@example.com', firstName: 'Ashish', lastName: 'Kumar' },
  subscriptionAmountType: 'VARIABLE',
  subscriptionMaxAmount: '499.00',
  autoRenewal: false,
  autoRetry: false,
  subscriptionFrequencyUnit: 'MONTH',
  subscriptionStartDate: '2026-11-17',
  subscriptionGraceDays: '2',
  subscriptionExpiryDate: '2031-11-17',
  subscriptionEnableRetry: '1',
  subscriptionRetryCount: '3',
};

const BASE_INPUT = { reference: 'ORDER_1', plan: { ...MONTHLY_PLAN }, customer: CUSTOMER };

async function errorOf(promise: Promise<unknown>): Promise<SubscriptionError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SubscriptionError);
    return error as SubscriptionError;
  }
  throw new Error('expected the call to fail');
}

describe('createSubscription: merchant-collected (the default)', () => {
  it('sends the Initiate Subscription request: autoRenewal false, VARIABLE with the ceiling, start today, grace days, no Paytm retries', async () => {
    const { provider, calls } = makeProvider([createRoute]);
    const subscription = await provider.createSubscription({ ...BASE_INPUT, returnUrl: RETURN_URL });
    expect(calls).toHaveLength(1);
    const request = sent(calls[0] as never);
    expect(request.url.href).toBe(CREATE_URL);
    // Dialect A head: the signature only (no tokenType).
    expect(Object.keys(request.head)).toEqual(['signature']);
    expect(request.body).toEqual({ ...MERCHANT_BODY, callbackUrl: RETURN_URL });
    expect(subscription).toMatchObject({
      provider: 'paytm',
      id: '33621',
      reference: 'ORDER_1',
      status: SubscriptionStatus.Created,
      providerStatus: 'INIT',
      scheduling: SchedulingMode.Merchant,
      amount: 49900,
      maxAmount: 49900,
      currency: 'INR',
      interval: { unit: 'month', count: 1 },
      startAt: NOW.toISOString(),
      createdAt: NOW.toISOString(),
      customer: { id: 'CUST_001', name: 'Ashish Kumar', email: 'ashish@example.com', phone: '+919876543210' },
    });
    expect(subscription.mandateEndsAt).toBe('2031-11-16T18:30:00.000Z');
    expect(subscription.trialEndsAt).toBeUndefined();
    expect(subscription.raw).toEqual(INITIATE_SUCCESS.body);
  });

  it('returns the documented show-payment-page form with mid, orderId and the txnToken', async () => {
    const { provider } = makeProvider([createRoute]);
    const subscription = await provider.createSubscription(BASE_INPUT);
    expect(subscription.checkout).toEqual({
      kind: CheckoutKind.FormPost,
      url: `${STAGING}/theia/api/v1/showPaymentPage?mid=${MID}&orderId=ORDER_1`,
      fields: { mid: MID, orderId: 'ORDER_1', txnToken: 'aec17f1f674e4f1685d4feb9262f1d731567159599645' },
    });
  });

  it('omits callbackUrl without a returnUrl or a config default (Paytm then uses the URL of the website), and uses the config default when set', async () => {
    const first = makeProvider([createRoute]);
    await first.provider.createSubscription(BASE_INPUT);
    expect(sent(first.calls[0] as never).body).not.toHaveProperty('callbackUrl');
    const second = makeProvider([createRoute], { callbackUrl: CALLBACK_URL });
    await second.provider.createSubscription(BASE_INPUT);
    expect(sent(second.calls[0] as never).body.callbackUrl).toBe(CALLBACK_URL);
    const third = makeProvider([createRoute], { callbackUrl: CALLBACK_URL });
    await third.provider.createSubscription({ ...BASE_INPUT, returnUrl: RETURN_URL });
    expect(sent(third.calls[0] as never).body.callbackUrl).toBe(RETURN_URL);
  });

  it('a free trial: the first amount is "0", the first debit is the trial end, and the grace days cover the days to it plus the retries', async () => {
    const { provider, calls } = makeProvider([createRoute]);
    const subscription = await provider.createSubscription({ ...BASE_INPUT, trial: { days: 14 } });
    const body = sent(calls[0] as never).body;
    expect(body).toMatchObject({
      txnAmount: { value: '0', currency: 'INR' },
      subscriptionAmountType: 'VARIABLE',
      subscriptionMaxAmount: '499.00',
      subscriptionStartDate: '2026-11-17',
      subscriptionGraceDays: '16',
      autoRenewal: false,
    });
    expect(subscription.startAt).toBe('2026-12-01T05:00:00.000Z');
    expect(subscription.trialEndsAt).toBe('2026-12-01T05:00:00.000Z');
  });

  it('caps the grace days by the cycle length (a 40-day trial on a monthly plan asks for 28)', async () => {
    const { provider, calls } = makeProvider([createRoute]);
    await provider.createSubscription({ ...BASE_INPUT, trial: { days: 40 } });
    expect(sent(calls[0] as never).body.subscriptionGraceDays).toBe('28');
  });

  it('config.graceDays and config.retryCount override the derived values (still capped by the cycle)', async () => {
    const { provider, calls } = makeProvider([createRoute], { graceDays: 5, retryCount: 2 });
    await provider.createSubscription(BASE_INPUT);
    const body = sent(calls[0] as never).body;
    expect(body.subscriptionGraceDays).toBe('5');
    expect(body.subscriptionRetryCount).toBe('2');
    const weekly = makeProvider([createRoute], { graceDays: 30 });
    await weekly.provider.createSubscription({ ...BASE_INPUT, plan: { ...MONTHLY_PLAN, interval: { unit: 'week', count: 1 } } });
    expect(sent(weekly.calls[0] as never).body.subscriptionGraceDays).toBe('7');
  });

  it('startAt without a trial delays the first debit but is not a trial', async () => {
    const { provider, calls } = makeProvider([createRoute]);
    const subscription = await provider.createSubscription({ ...BASE_INPUT, startAt: '2026-11-27T05:00:00.000Z' });
    expect(sent(calls[0] as never).body).toMatchObject({ subscriptionStartDate: '2026-11-17', subscriptionGraceDays: '12' });
    expect(subscription.startAt).toBe('2026-11-27T05:00:00.000Z');
    expect(subscription.trialEndsAt).toBeUndefined();
  });

  it('an upfront amount is sent as txnAmount in rupees', async () => {
    const { provider, calls } = makeProvider([createRoute]);
    await provider.createSubscription({ ...BASE_INPUT, upfrontAmount: 9950 });
    expect(sent(calls[0] as never).body.txnAmount).toEqual({ value: '99.50', currency: 'INR' });
  });

  it('subscriptionMaxAmount is the plan ceiling when maxAmount is set', async () => {
    const { provider, calls } = makeProvider([createRoute]);
    const subscription = await provider.createSubscription({ ...BASE_INPUT, plan: { ...MONTHLY_PLAN, maxAmount: 99900 } });
    expect(sent(calls[0] as never).body.subscriptionMaxAmount).toBe('999.00');
    expect(subscription).toMatchObject({ amount: 49900, maxAmount: 99900 });
  });

  it('derives the expiry from the cycle count (last due date plus the retry buffer), from mandateEndsAt, or a 5-year default', async () => {
    const counted = makeProvider([createRoute]);
    await counted.provider.createSubscription({ ...BASE_INPUT, totalCycles: 3, trial: { days: 14 } });
    // Last due: 1 Dec + 2 months = 1 Feb 2027; + 3 days.
    expect(sent(counted.calls[0] as never).body.subscriptionExpiryDate).toBe('2027-02-04');
    const ends = makeProvider([createRoute]);
    const subscription = await ends.provider.createSubscription({ ...BASE_INPUT, mandateEndsAt: '2028-01-31T10:00:00+05:30' });
    expect(sent(ends.calls[0] as never).body.subscriptionExpiryDate).toBe('2028-01-31');
    expect(subscription.mandateEndsAt).toBe('2028-01-31T10:00:00+05:30');
    const years = makeProvider([createRoute], { mandateYears: 2 });
    await years.provider.createSubscription(BASE_INPUT);
    expect(sent(years.calls[0] as never).body.subscriptionExpiryDate).toBe('2028-11-17');
    expect((await makeProvider([createRoute]).provider.createSubscription({ ...BASE_INPUT, totalCycles: 12 })).totalCycles).toBe(12);
  });

  it('maps each payment method to Paytm modes, adds mandateType for eNACH, and sends no grace days, retries or upfront for eNACH only', async () => {
    const { provider, calls } = makeProvider([createRoute, createRoute, createRoute]);
    await provider.createSubscription({ ...BASE_INPUT, paymentMethods: [PaymentMethod.Upi, PaymentMethod.Card] });
    expect(sent(calls[0] as never).body.enablePaymentMode).toEqual([{ mode: 'UPI' }, { mode: 'CREDIT_CARD' }, { mode: 'DEBIT_CARD' }]);
    expect(sent(calls[0] as never).body).not.toHaveProperty('mandateType');

    await provider.createSubscription({ ...BASE_INPUT, paymentMethods: [PaymentMethod.ENach] });
    const enach = sent(calls[1] as never).body;
    expect(enach).toMatchObject({ enablePaymentMode: [{ mode: 'BANK_MANDATE' }], mandateType: 'E_MANDATE', subscriptionEnableRetry: '0', autoRetry: false });
    expect(enach).not.toHaveProperty('subscriptionGraceDays');
    expect(enach).not.toHaveProperty('subscriptionRetryCount');

    // eNACH among other methods keeps the retry fields, and still asks for an e-mandate.
    await provider.createSubscription({ ...BASE_INPUT, paymentMethods: [PaymentMethod.ENach, PaymentMethod.Upi] });
    expect(sent(calls[2] as never).body).toMatchObject({ mandateType: 'E_MANDATE', subscriptionEnableRetry: '1', subscriptionGraceDays: '2' });
  });

  it('cards only: the grace days are capped at 3', async () => {
    const { provider, calls } = makeProvider([createRoute]);
    await provider.createSubscription({ ...BASE_INPUT, paymentMethods: [PaymentMethod.Card], trial: { days: 14 } });
    expect(sent(calls[0] as never).body.subscriptionGraceDays).toBe('3');
  });

  it('notifyCustomer maps to communicationManager (absent otherwise: the scheduler sends the pre-debit notification itself)', async () => {
    const { provider, calls } = makeProvider([createRoute, createRoute]);
    await provider.createSubscription(BASE_INPUT);
    expect(sent(calls[0] as never).body).not.toHaveProperty('communicationManager');
    await provider.createSubscription({ ...BASE_INPUT, notifyCustomer: true });
    expect(sent(calls[1] as never).body.communicationManager).toBe(true);
  });

  it('echoes metadata, ignores fields Paytm has no equivalent for, and never sends them', async () => {
    const { provider, calls } = makeProvider([createRoute]);
    const subscription = await provider.createSubscription({
      ...BASE_INPUT,
      metadata: { team: 'growth' },
      idempotencyKey: 'k1',
      upfrontLabel: 'Setup fee',
      authorizeBy: '2026-11-20T00:00:00Z',
    });
    expect(subscription.metadata).toEqual({ team: 'growth' });
    expect(JSON.stringify(sent(calls[0] as never).body)).not.toMatch(/growth|k1|Setup fee/);
  });

  it('generates an order id when there is no reference, within Paytm\'s rules', async () => {
    const { provider, calls } = makeProvider([{ url: /\/subscription\/create/, json: INITIATE_SUCCESS }]);
    const subscription = await provider.createSubscription({ plan: { ...MONTHLY_PLAN }, customer: CUSTOMER });
    expect(subscription.reference).toBe('sub_gen1');
    expect(new URL((calls[0] as { url: string }).url).searchParams.get('orderId')).toBe('sub_gen1');
    expect(sent(calls[0] as never).body.orderId).toBe('sub_gen1');
  });

  it('the default id generator makes 28-character ids of letters, digits and _', async () => {
    const { provider } = makeProvider([{ url: /\/subscription\/create/, json: INITIATE_SUCCESS }], {}, { generateId: undefined });
    const subscription = await provider.createSubscription({ plan: { ...MONTHLY_PLAN }, customer: CUSTOMER });
    expect(subscription.reference).toMatch(/^sub_[0-9a-f]{24}$/);
  });
});

describe('createSubscription: customer mapping', () => {
  it('derives a stable custId from the order id when the customer has none: a digest, with only characters Paytm allows', async () => {
    const { provider, calls } = makeProvider([createRoute, createRoute]);
    const { id: _id, ...anonymous } = CUSTOMER;
    const first = await provider.createSubscription({ ...BASE_INPUT, customer: anonymous });
    await provider.createSubscription({ ...BASE_INPUT, customer: anonymous });
    const expected = `cust_${createHash('sha256').update('ORDER_1').digest('hex').slice(0, 24)}`;
    expect((sent(calls[0] as never).body.userInfo as { custId: string }).custId).toBe(expected);
    expect((sent(calls[1] as never).body.userInfo as { custId: string }).custId).toBe(expected);
    expect(first.customer?.id).toBe(expected);
  });

  it('normalises +91, 91 and plain 10-digit numbers, splits the name, and sends only what is given', async () => {
    const { provider, calls } = makeProvider([createRoute, createRoute, createRoute]);
    await provider.createSubscription({ ...BASE_INPUT, customer: { id: 'c1', phone: '919876543210' } });
    await provider.createSubscription({ ...BASE_INPUT, customer: { id: 'c1', phone: '9876543210', name: 'Madonna' } });
    await provider.createSubscription({ ...BASE_INPUT, customer: { id: 'c1', name: 'Anna Maria van der Berg' } });
    expect(sent(calls[0] as never).body.userInfo).toEqual({ custId: 'c1', mobile: '9876543210' });
    expect(sent(calls[1] as never).body.userInfo).toEqual({ custId: 'c1', mobile: '9876543210', firstName: 'Madonna' });
    expect(sent(calls[2] as never).body.userInfo).toEqual({ custId: 'c1', firstName: 'Anna', lastName: 'Maria van der Berg' });
  });

  it('rejects a customer id Paytm\'s custId cannot hold, and a phone that is not a 10-digit Indian mobile, before any request', async () => {
    const { provider, calls } = makeProvider([]);
    expect(await errorOf(provider.createSubscription({ ...BASE_INPUT, customer: { id: 'cust-1' } }))).toMatchObject({ code: ErrorCode.Validation });
    expect(await errorOf(provider.createSubscription({ ...BASE_INPUT, customer: { id: 'c1', phone: '+4412345678901' } }))).toMatchObject({
      code: ErrorCode.Validation,
    });
    expect(calls).toHaveLength(0);
  });
});

describe('createSubscription: local rejections, before any request', () => {
  const rejected = async (input: Parameters<ReturnType<typeof makeProvider>['provider']['createSubscription']>[0], code: ErrorCode, text?: RegExp) => {
    const { provider, calls } = makeProvider([]);
    const error = await errorOf(provider.createSubscription(input));
    expect(error.code).toBe(code);
    if (text) expect(error.message).toMatch(text);
    expect(calls).toHaveLength(0);
    return error;
  };

  it('a plan id (there is no plan API), quantity above 1, paper mandates, a bad order id', async () => {
    await rejected({ ...BASE_INPUT, plan: 'plan_123' }, ErrorCode.Validation, /plan API/);
    await rejected({ ...BASE_INPUT, quantity: 2 }, ErrorCode.Unsupported);
    await rejected({ ...BASE_INPUT, paymentMethods: [PaymentMethod.PhysicalNach] }, ErrorCode.Validation, /paper/);
    await rejected({ ...BASE_INPUT, reference: 'a|b' }, ErrorCode.Validation, /order id/);
    await rejected({ ...BASE_INPUT, reference: 'x'.repeat(51) }, ErrorCode.Validation, /order id/);
  });

  it('an interval Paytm has no unit for, listing the ones it has', async () => {
    for (const interval of [{ unit: 'day', count: 3 }, { unit: 'week', count: 2 }, { unit: 'month', count: 5 }, { unit: 'year', count: 2 }]) {
      await rejected({ ...BASE_INPUT, plan: { ...MONTHLY_PLAN, interval } }, ErrorCode.Validation, /no multiplier/);
    }
  });

  it('eNACH only with an upfront amount (Paytm 4001: "Txn Amount can not be non-zero in case of Bank Mandates")', async () => {
    await rejected({ ...BASE_INPUT, paymentMethods: [PaymentMethod.ENach], upfrontAmount: 100 }, ErrorCode.Validation, /eNACH/);
  });

  it('an upfront amount above what Paytm allows: the renewal amount for UPI / e-mandates, the ceiling for cards', async () => {
    await rejected({ ...BASE_INPUT, plan: { ...MONTHLY_PLAN, maxAmount: 99900 }, upfrontAmount: 100000 }, ErrorCode.Validation, /ceiling/);
    const { provider, calls } = makeProvider([createRoute]);
    await provider.createSubscription({ ...BASE_INPUT, plan: { ...MONTHLY_PLAN, maxAmount: 99900 }, upfrontAmount: 90000, paymentMethods: [PaymentMethod.Card] });
    expect(calls).toHaveLength(1);
  });

  it('UPI as the only method with a daily plan (UPI Autopay has no DAY frequency)', async () => {
    await rejected(
      { ...BASE_INPUT, plan: { ...MONTHLY_PLAN, interval: { unit: 'day', count: 1 } }, paymentMethods: [PaymentMethod.Upi] },
      ErrorCode.Validation,
      /UPI Autopay does not support/,
    );
  });

  it('a trial that is not in the future, and both trial and startAt', async () => {
    await rejected({ ...BASE_INPUT, trial: { endsAt: '2026-01-01T00:00:00Z' } }, ErrorCode.Validation);
    await rejected({ ...BASE_INPUT, trial: { days: 3 }, startAt: '2026-12-01T00:00:00Z' }, ErrorCode.Validation);
  });
});

describe('createSubscription: Paytm-collected (plan.scheduling = gateway)', () => {
  const GATEWAY_PLAN = { ...MONTHLY_PLAN, scheduling: SchedulingMode.Gateway };
  /** One month from NOW: exactly one cycle away, which UPI accepts. */
  const NEXT_CYCLE = '2026-12-17T05:00:00.000Z';

  it('sends autoRenewal true, FIX with the renewal amount, the first debit date as the start date, and Paytm\'s documented retry defaults', async () => {
    const { provider, calls } = makeProvider([createRoute]);
    const subscription = await provider.createSubscription({ ...BASE_INPUT, plan: GATEWAY_PLAN, startAt: NEXT_CYCLE });
    expect(sent(calls[0] as never).body).toEqual({
      requestType: 'NATIVE_SUBSCRIPTION',
      mid: MID,
      websiteName: 'WEBSTAGING',
      orderId: 'ORDER_1',
      txnAmount: { value: '0', currency: 'INR' },
      userInfo: MERCHANT_BODY.userInfo,
      subscriptionAmountType: 'FIX',
      renewalAmount: '499.00',
      autoRenewal: true,
      autoRetry: true,
      communicationManager: true,
      subscriptionFrequencyUnit: 'MONTH',
      subscriptionStartDate: '2026-12-17',
      subscriptionGraceDays: '2',
      subscriptionExpiryDate: '2031-12-17',
      subscriptionEnableRetry: '1',
      subscriptionRetryCount: '3',
    });
    expect(subscription).toMatchObject({ scheduling: SchedulingMode.Gateway, amount: 49900, maxAmount: 49900, startAt: NEXT_CYCLE });
  });

  it('starts today when there is no trial or startAt; an upfront amount may be taken now; notifyCustomer false is honoured', async () => {
    const { provider, calls } = makeProvider([createRoute]);
    await provider.createSubscription({ ...BASE_INPUT, plan: GATEWAY_PLAN, upfrontAmount: 49900, notifyCustomer: false });
    expect(sent(calls[0] as never).body).toMatchObject({
      subscriptionStartDate: '2026-11-17',
      txnAmount: { value: '499.00', currency: 'INR' },
      communicationManager: false,
    });
  });

  it('expires one day after the last due date when there is a cycle count', async () => {
    const { provider, calls } = makeProvider([createRoute]);
    await provider.createSubscription({ ...BASE_INPUT, plan: GATEWAY_PLAN, totalCycles: 12 });
    // 12 cycles from 17 Nov 2026: the last is due on 17 Oct 2027.
    expect(sent(calls[0] as never).body.subscriptionExpiryDate).toBe('2027-10-18');
  });

  it('eNACH only: no auto-retry fields, because bank mandates support none', async () => {
    const { provider, calls } = makeProvider([createRoute]);
    await provider.createSubscription({ ...BASE_INPUT, plan: GATEWAY_PLAN, paymentMethods: [PaymentMethod.ENach], startAt: '2026-12-05T05:00:00Z' });
    const body = sent(calls[0] as never).body;
    expect(body).toMatchObject({ autoRenewal: true, autoRetry: false, subscriptionEnableRetry: '0', mandateType: 'E_MANDATE' });
    expect(body).not.toHaveProperty('subscriptionGraceDays');
  });

  it('allows an arbitrary first debit date when UPI is not among the payment methods', async () => {
    const { provider, calls } = makeProvider([createRoute]);
    await provider.createSubscription({ ...BASE_INPUT, plan: GATEWAY_PLAN, paymentMethods: [PaymentMethod.Card], startAt: '2026-12-05T05:00:00Z' });
    expect(sent(calls[0] as never).body.subscriptionStartDate).toBe('2026-12-05');
  });

  it('rejects what Paytm cannot auto-renew, saying why and suggesting merchant scheduling: variable amounts', async () => {
    const { provider, calls } = makeProvider([]);
    const error = await errorOf(provider.createSubscription({ ...BASE_INPUT, plan: { ...GATEWAY_PLAN, maxAmount: 99900 } }));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(error.message).toMatch(/fixed amounts only/);
    expect(error.message).toMatch(/merchant scheduling/);
    expect(calls).toHaveLength(0);
  });

  it('rejects a daily frequency', async () => {
    const { provider } = makeProvider([]);
    const error = await errorOf(
      provider.createSubscription({ ...BASE_INPUT, plan: { ...GATEWAY_PLAN, interval: { unit: 'day', count: 1 } } }),
    );
    expect(error).toMatchObject({ code: ErrorCode.Validation });
    expect(error.message).toMatch(/daily/);
    expect(error.message).toMatch(/merchant scheduling/);
  });

  it('rejects a first debit that is neither today nor exactly one cycle away when UPI may be used', async () => {
    const { provider, calls } = makeProvider([]);
    for (const startAt of ['2026-11-18T05:00:00.000Z', '2026-12-05T05:00:00.000Z', '2026-12-18T05:00:00.000Z', '2027-01-17T05:00:00.000Z']) {
      const error = await errorOf(provider.createSubscription({ ...BASE_INPUT, plan: GATEWAY_PLAN, startAt }));
      expect(error.code).toBe(ErrorCode.Validation);
      expect(error.message).toMatch(/UPI Autopay/);
      expect(error.message).toMatch(/merchant scheduling/);
    }
    expect(calls).toHaveLength(0);
  });

  it('takes the unit of a bi-monthly plan from the plan: two months is the UPI-safe date, one month is not', async () => {
    const { provider, calls } = makeProvider([createRoute]);
    const plan = { ...GATEWAY_PLAN, interval: { unit: 'month', count: 2 } };
    await errorOf(provider.createSubscription({ ...BASE_INPUT, plan, startAt: NEXT_CYCLE }));
    await provider.createSubscription({ ...BASE_INPUT, plan, startAt: '2027-01-17T05:00:00.000Z' });
    expect(sent(calls[0] as never).body).toMatchObject({ subscriptionFrequencyUnit: 'BI_MONTHLY', subscriptionStartDate: '2027-01-17' });
  });
});

describe('createSubscription: frequency units', () => {
  const cases: [string, { unit: string; count: number }][] = [
    ['DAY', { unit: 'day', count: 1 }],
    ['WEEK', { unit: 'week', count: 1 }],
    ['MONTH', { unit: 'month', count: 1 }],
    ['BI_MONTHLY', { unit: 'month', count: 2 }],
    ['QUARTER', { unit: 'month', count: 3 }],
    ['SEMI_ANNUALLY', { unit: 'month', count: 6 }],
    ['YEAR', { unit: 'month', count: 12 }],
    ['YEAR', { unit: 'year', count: 1 }],
  ];
  for (const [unit, interval] of cases) {
    it(`${interval.count} ${interval.unit} is ${unit}`, async () => {
      const { provider, calls } = makeProvider([createRoute]);
      await provider.createSubscription({ ...BASE_INPUT, plan: { ...MONTHLY_PLAN, interval } });
      expect(sent(calls[0] as never).body.subscriptionFrequencyUnit).toBe(unit);
    });
  }
});

describe('createSubscription: Paytm\'s answers', () => {
  const failures: [string, unknown, ErrorCode][] = [
    ['4001 Invalid Frequency Unit (the docs sample)', INITIATE_FAIL_4001, ErrorCode.Validation],
    ['4004 max amount too high for the paymodes', reply({ resultInfo: { resultStatus: 'F', resultCode: '4004', resultMsg: 'Max amount is greater than the permissible amount limit for available paymodes' } }), ErrorCode.Validation],
    ['00000900 amount above the max', reply({ resultInfo: { resultStatus: 'F', resultCode: '00000900', resultMsg: 'Transaction amount cannot be greater than the max amount set against the subscription' } }), ErrorCode.Validation],
    ['2005 invalid checksum', reply({ resultInfo: { resultStatus: 'F', resultCode: '2005', resultMsg: 'Checksum provided is invalid' } }), ErrorCode.Auth],
    ['2009 duplicate order id in progress', reply({ resultInfo: { resultStatus: 'F', resultCode: '2009', resultMsg: 'Duplicate request, with same orderId is already in progress' } }), ErrorCode.Conflict],
    ['2022 paymode not enabled', reply({ resultInfo: { resultStatus: 'F', resultCode: '2022', resultMsg: 'Paymode selected is not enabled for your merchant account' } }), ErrorCode.Config],
    ['U 900 system error (outcome unknown)', reply({ resultInfo: { resultStatus: 'U', resultCode: '900', resultMsg: 'System error' } }), ErrorCode.OutcomeUnknown],
    ['an unlisted failure code', reply({ resultInfo: { resultStatus: 'F', resultCode: '7777', resultMsg: 'new error' } }), ErrorCode.ProviderError],
    ['no resultInfo at all', reply({}), ErrorCode.OutcomeUnknown],
  ];
  for (const [name, answer, code] of failures) {
    it(`HTTP 200 with ${name} is ${code}`, async () => {
      const { provider } = makeProvider([{ url: CREATE_URL, json: answer }]);
      const error = await errorOf(provider.createSubscription(BASE_INPUT));
      expect(error.code).toBe(code);
      expect(error.provider).toBe('paytm');
      expect(error.raw).toBeDefined();
    });
  }

  it('keeps Paytm\'s code verbatim as providerCode and its message in the error', async () => {
    const { provider } = makeProvider([{ url: CREATE_URL, json: INITIATE_FAIL_4001 }]);
    const error = await errorOf(provider.createSubscription(BASE_INPUT));
    expect(error.providerCode).toBe('4001');
    expect(error.message).toContain('Invalid Frequency Unit');
    expect(error.raw).toEqual(INITIATE_FAIL_4001.body);
  });

  it('a success without a subscriptionId or txnToken is UNEXPECTED_RESPONSE that warns the subscription may exist', async () => {
    const answer = reply({ resultInfo: { resultStatus: 'S', resultCode: '0000', resultMsg: 'Success' } });
    const { provider } = makeProvider([{ url: CREATE_URL, json: answer }]);
    const error = await errorOf(provider.createSubscription(BASE_INPUT));
    expect(error.code).toBe(ErrorCode.UnexpectedResponse);
    expect(error.message).toMatch(/may exist/);
  });

  it('a dropped connection is OUTCOME_UNKNOWN, as is an HTTP 502 on this write', async () => {
    const dropped = makeProvider([{ url: CREATE_URL, networkError: true }]);
    expect((await errorOf(dropped.provider.createSubscription(BASE_INPUT))).code).toBe(ErrorCode.OutcomeUnknown);
    const bad = makeProvider([{ url: CREATE_URL, status: 502, text: 'bad gateway' }]);
    expect((await errorOf(bad.provider.createSubscription(BASE_INPUT))).code).toBe(ErrorCode.OutcomeUnknown);
  });

  it('an HTTP error status carries Paytm\'s message and code when its body has them', async () => {
    const { provider } = makeProvider([
      { url: CREATE_URL, status: 400, json: reply({ resultInfo: { resultStatus: 'F', resultCode: '1007', resultMsg: 'Missing mandatory element' } }) },
    ]);
    const error = await errorOf(provider.createSubscription(BASE_INPUT));
    expect(error).toMatchObject({ code: ErrorCode.Validation, providerCode: '1007', httpStatus: 400 });
    expect(error.message).toContain('Missing mandatory element');
  });

  it('a body that is not JSON is UNEXPECTED_RESPONSE', async () => {
    const { provider } = makeProvider([{ url: CREATE_URL, text: '<html>gateway</html>' }]);
    expect((await errorOf(provider.createSubscription(BASE_INPUT))).code).toBe(ErrorCode.UnexpectedResponse);
  });
});

describe('hosts', () => {
  it('production calls secure.paytmpayments.com, with the production show-payment-page URL', async () => {
    const { provider, calls } = makeProvider(
      [{ url: `${PRODUCTION}/subscription/create?mid=${MID}&orderId=ORDER_1`, json: INITIATE_SUCCESS }],
      { environment: 'live', website: 'DEFAULT' },
    );
    const subscription = await provider.createSubscription(BASE_INPUT);
    expect((calls[0] as { url: string }).url).toBe(`${PRODUCTION}/subscription/create?mid=${MID}&orderId=ORDER_1`);
    expect(sent(calls[0] as never).body.websiteName).toBe('DEFAULT');
    expect(subscription.checkout).toMatchObject({ url: `${PRODUCTION}/theia/api/v1/showPaymentPage?mid=${MID}&orderId=ORDER_1` });
  });

  it('base URL overrides apply to their own host family; the checkout host follows its own override only', async () => {
    const { provider, calls } = makeProvider(
      [{ url: `https://proxy.example/subscription/create?mid=${MID}&orderId=ORDER_1`, json: INITIATE_SUCCESS }],
      { subscriptionBaseUrl: 'https://proxy.example/', checkoutBaseUrl: 'https://pay.example' },
    );
    const subscription = await provider.createSubscription(BASE_INPUT);
    expect((calls[0] as { url: string }).url).toBe(`https://proxy.example/subscription/create?mid=${MID}&orderId=ORDER_1`);
    expect(subscription.checkout).toMatchObject({ url: `https://pay.example/theia/api/v1/showPaymentPage?mid=${MID}&orderId=ORDER_1` });
    const plain = makeProvider([{ url: /proxy\.example/, json: INITIATE_SUCCESS }], { subscriptionBaseUrl: 'https://proxy.example' });
    expect((await plain.provider.createSubscription(BASE_INPUT)).checkout).toMatchObject({ url: `${STAGING}/theia/api/v1/showPaymentPage?mid=${MID}&orderId=ORDER_1` });
  });

  it('clientId and channelId go into the head of the Theia-style APIs; clientId and tokenType into the subscription-service heads', async () => {
    const { provider, calls } = makeProvider(
      [createRoute, { url: STATUS_URL, json: statusAnswer() }],
      { clientId: 'C11', channelId: 'WEB' },
    );
    await provider.createSubscription(BASE_INPUT);
    await provider.getSubscription('130010');
    expect(Object.keys(sent(calls[0] as never).head)).toEqual(['clientId', 'channelId', 'signature']);
    expect(sent(calls[0] as never).head).toMatchObject({ clientId: 'C11', channelId: 'WEB' });
    expect(Object.keys(sent(calls[1] as never).head)).toEqual(['tokenType', 'clientId', 'signature']);
    expect(sent(calls[1] as never).head).toMatchObject({ tokenType: 'AES', clientId: 'C11' });
  });
});

describe('getSubscription: Fetch Subscription Status', () => {
  /** Fetch Subscription Status success, verbatim [fetch-status / api_response SUCCESS]. */
  const FETCH_SAMPLE = {
    head: { timestamp: '1622535154823', signature: '', tokenType: 'AES', clientId: '1234' },
    body: {
      resultInfo: { code: '3006', message: 'SUCCESS', status: 'SUCCESS' },
      subsId: '130010',
      status: 'ACTIVE',
      orderId: '202106011340240058',
      upfrontTxnId: '20210601111212800110168214101167593',
      subsPaymentInstDetails: { bankName: 'WALLET', paymentMode: 'PPI', ppiType: 'Y' },
      lastOrderId: '202106011340240058',
      lastOrderStatus: 'SUCCESS',
      lastOrderCreationDate: '2021-06-01 13:43:01.43',
      lastOrderAmount: '30',
      amountType: 'VARIABLE',
      maxAmount: '10.0',
      mid: 'SUBS1200924977956513',
      frequencyUnit: 'MONTH',
      frequency: '1',
      merchantName: 'bharat chudhary',
      expiryDate: '2021-09-30 00:00:00',
      createdDate: '2021-06-01 13:40:30',
      updatedDate: '2021-06-01 13:43:28',
      custId: 'akanksha123',
      custEmailId: 'sourav2.singh@gmail.com',
      custMobileNo: '7978818256',
      upfrontTxnAmount: '30.00',
      planId: '5693',
      linkDetails: { linkId: '156741', linkNotes: 'This is a business link payment', expiryDate: '05/09/2021 00:00:00', shortUrl: 'https://paytm.me/2-ee2fY' },
      planName: 'JGFLg67GHT',
    },
  };

  it('sends {mid, subsId} with the subscription-service head (tokenType AES) and maps the docs sample', async () => {
    const { provider, calls } = makeProvider([{ url: STATUS_URL, json: FETCH_SAMPLE }]);
    const subscription = await provider.getSubscription('130010');
    const request = sent(calls[0] as never);
    expect(request.url.href).toBe(STATUS_URL);
    expect(request.head).toEqual({ tokenType: 'AES', signature: expect.any(String) });
    expect(request.body).toEqual({ mid: MID, subsId: '130010' });
    expect(subscription).toMatchObject({
      provider: 'paytm',
      id: '130010',
      reference: '202106011340240058',
      planId: '5693',
      status: SubscriptionStatus.Active,
      providerStatus: 'ACTIVE',
      scheduling: SchedulingMode.Merchant,
      maxAmount: 1000,
      currency: 'INR',
      interval: { unit: 'month', count: 1 },
      createdAt: '2021-06-01T08:10:30.000Z',
      mandateEndsAt: '2021-09-29T18:30:00.000Z',
      customer: { id: 'akanksha123', email: 'sourav2.singh@gmail.com', phone: '7978818256' },
    });
    // Paytm Wallet (PPI) has no unified payment method; a VARIABLE subscription has no fixed amount.
    expect(subscription.paymentMethod).toBeUndefined();
    expect(subscription.amount).toBeUndefined();
    expect(subscription.raw).toEqual(FETCH_SAMPLE.body);
  });

  const statuses: [string, SubscriptionStatus][] = [
    ['INIT', SubscriptionStatus.Created],
    ['IN_AUTHORIZATION', SubscriptionStatus.PendingAuthorization],
    ['AUTHORISED', SubscriptionStatus.PendingAuthorization],
    ['AUTHORIZED', SubscriptionStatus.PendingAuthorization],
    ['CONFIRMED', SubscriptionStatus.PendingAuthorization],
    ['ACTIVE', SubscriptionStatus.Active],
    ['SUSPENDED', SubscriptionStatus.Paused],
    ['EXPIRED', SubscriptionStatus.Expired],
    ['REJECT', SubscriptionStatus.Cancelled],
    ['CLOSED', SubscriptionStatus.Expired],
    ['AUTHORIZATION_FAILED', SubscriptionStatus.Failed],
    ['active', SubscriptionStatus.Active],
  ];
  for (const [paytmStatus, expected] of statuses) {
    it(`status ${paytmStatus} is ${expected}`, async () => {
      const { provider } = makeProvider([{ url: STATUS_URL, json: statusAnswer({ status: paytmStatus }) }]);
      const subscription = await provider.getSubscription('130010');
      expect(subscription.status).toBe(expected);
      expect(subscription.providerStatus).toBe(paytmStatus);
    });
  }

  it('an unknown status waits (pending_authorization: neither bills nor cancels anything) and stays visible verbatim', async () => {
    const { provider } = makeProvider([{ url: STATUS_URL, json: statusAnswer({ status: 'QUANTUM_SUSPENDED' }) }]);
    expect(await provider.getSubscription('130010')).toMatchObject({ status: SubscriptionStatus.PendingAuthorization, providerStatus: 'QUANTUM_SUSPENDED' });
  });

  it('a missing status is the same fallback with a placeholder providerStatus', async () => {
    const { provider } = makeProvider([{ url: STATUS_URL, json: statusAnswer({ status: undefined }) }]);
    expect(await provider.getSubscription('130010')).toMatchObject({ status: SubscriptionStatus.PendingAuthorization, providerStatus: 'UNKNOWN' });
  });

  it('a FIX subscription is Paytm-collected, and its cap is its amount', async () => {
    const { provider } = makeProvider([{ url: STATUS_URL, json: statusAnswer({ amountType: 'FIX', maxAmount: '499.00' }) }]);
    expect(await provider.getSubscription('130010')).toMatchObject({ scheduling: SchedulingMode.Gateway, amount: 49900, maxAmount: 49900 });
  });

  const intervals: [string, string | undefined, { unit: string; count: number } | undefined][] = [
    ['DAY', '1', { unit: 'day', count: 1 }],
    ['WEEK', '1', { unit: 'week', count: 1 }],
    ['FORTNIGHT', '1', { unit: 'week', count: 2 }],
    ['MONTH', '1', { unit: 'month', count: 1 }],
    ['MONTH', '3', { unit: 'month', count: 3 }],
    ['BI_MONTHLY', '1', { unit: 'month', count: 2 }],
    ['QUARTER', '1', { unit: 'month', count: 3 }],
    ['SEMI_ANNUALLY', '1', { unit: 'month', count: 6 }],
    ['YEAR', '1', { unit: 'year', count: 1 }],
    ['YEAR', undefined, { unit: 'year', count: 1 }],
    ['ONDEMAND', '1', undefined],
    ['ONETIME', '1', undefined],
  ];
  for (const [unit, frequency, expected] of intervals) {
    it(`frequency ${unit} x ${frequency ?? '(none)'} is ${expected ? `${expected.count} ${expected.unit}` : 'no interval'}`, async () => {
      const { provider } = makeProvider([{ url: STATUS_URL, json: statusAnswer({ frequencyUnit: unit, frequency }) }]);
      expect((await provider.getSubscription('130010')).interval).toEqual(expected);
    });
  }

  const modes: [string, string | undefined, PaymentMethod | undefined][] = [
    ['UPI', undefined, PaymentMethod.Upi],
    ['CC', undefined, PaymentMethod.Card],
    ['DC', undefined, PaymentMethod.Card],
    ['CREDIT_CARD', undefined, PaymentMethod.Card],
    ['BANK_MANDATE', 'E_MANDATE', PaymentMethod.ENach],
    ['BANK_MANDATE', 'PAPER_MANDATE', PaymentMethod.PhysicalNach],
    ['PPI', undefined, undefined],
    ['PAYTM_DIGITAL_CREDIT', undefined, undefined],
  ];
  for (const [mode, mandateType, expected] of modes) {
    it(`payment mode ${mode}${mandateType ? ` (${mandateType})` : ''} is ${expected ?? 'no unified method'}`, async () => {
      const { provider } = makeProvider([
        { url: STATUS_URL, json: statusAnswer({ subsPaymentInstDetails: { paymentMode: mode, mandateType } }) },
      ]);
      expect((await provider.getSubscription('130010')).paymentMethod).toBe(expected);
    });
  }

  it('falls back to payMode when the instrument details have no mode', async () => {
    const { provider } = makeProvider([{ url: STATUS_URL, json: statusAnswer({ subsPaymentInstDetails: undefined, payMode: 'UPI' }) }]);
    expect((await provider.getSubscription('130010')).paymentMethod).toBe(PaymentMethod.Upi);
  });

  it('an ended subscription has endedAt (its last update); a live one does not', async () => {
    const dead = makeProvider([{ url: STATUS_URL, json: statusAnswer({ status: 'REJECT' }) }]);
    expect((await dead.provider.getSubscription('130010')).endedAt).toBe('2026-11-17T05:05:00.000Z');
    const live = makeProvider([{ url: STATUS_URL, json: statusAnswer() }]);
    expect((await live.provider.getSubscription('130010')).endedAt).toBeUndefined();
  });

  it('exposes the next retry time as nextChargeAt, and drops an e-mail or phone that is not valid', async () => {
    const { provider } = makeProvider([
      {
        url: STATUS_URL,
        json: statusAnswer({
          subsNextRetry: { attemptedTime: '2026-11-18 09:00:00' },
          subsRetryDetails: { totalRetryCount: '3', retriesLeft: '2' },
          custEmailId: 'not-an-email',
          custMobileNo: '12',
        }),
      },
    ]);
    const subscription = await provider.getSubscription('130010');
    expect(subscription.nextChargeAt).toBe('2026-11-18T03:30:00.000Z');
    expect(subscription.customer).toEqual({ id: 'CUST_001' });
  });

  it('tolerates retry blocks of an unexpected shape instead of failing the read', async () => {
    const { provider } = makeProvider([{ url: STATUS_URL, json: statusAnswer({ subsNextRetry: ['x'], subsLastRetryDone: 7 }) }]);
    expect((await provider.getSubscription('130010')).status).toBe(SubscriptionStatus.Active);
  });

  it('numbers Paytm sends as numbers are read (maxAmount 499, frequency 1, subsId as a number)', async () => {
    const { provider } = makeProvider([{ url: STATUS_URL, json: statusAnswer({ maxAmount: 499, frequency: 1, subsId: 130010 }) }]);
    expect(await provider.getSubscription('130010')).toMatchObject({ id: '130010', maxAmount: 49900, interval: { unit: 'month', count: 1 } });
  });

  it('3004 Subscription Not Found is NOT_FOUND; 3045 is VALIDATION; 3005 is PROVIDER_ERROR; the Cancel-style swapped result is not mistaken for success', async () => {
    const answers: [Record<string, string>, ErrorCode][] = [
      [{ code: '3004', message: 'Subscription Not Found', status: 'FAILURE' }, ErrorCode.NotFound],
      [{ code: '3045', message: 'Both orderId and subscriptionId cannot be null', status: 'FAILURE' }, ErrorCode.Validation],
      [{ code: '3005', message: 'Some error occured', status: 'FAILURE' }, ErrorCode.ProviderError],
      [{ code: '3018', message: 'cust id sent in request is not in correspondance with the cust id for which subscription was created', status: 'FAILURE' }, ErrorCode.Validation],
      [{ resultCode: '3004', resultMsg: 'Subscription Not Found', resultStatus: 'FAILURE' }, ErrorCode.NotFound],
    ];
    for (const [resultInfo, code] of answers) {
      const { provider } = makeProvider([{ url: STATUS_URL, json: reply({ resultInfo }) }]);
      const error = await errorOf(provider.getSubscription('130010'));
      expect(error.code).toBe(code);
      expect(error.providerCode).toBe(resultInfo.code ?? resultInfo.resultCode);
    }
  });

  it('a read is retried on a transient failure (it is idempotent) and a blank id is refused locally', async () => {
    const { provider, calls } = makeProvider(
      [
        { url: STATUS_URL, status: 503, text: 'busy' },
        { url: STATUS_URL, json: statusAnswer() },
      ],
      {},
      { maxRetries: 1 },
    );
    const sleeper = provider as unknown as { http: { sleep: (ms: number) => Promise<void> } };
    sleeper.http.sleep = async () => undefined;
    expect((await provider.getSubscription('130010')).status).toBe(SubscriptionStatus.Active);
    expect(calls).toHaveLength(2);
    expect((await errorOf(makeProvider([]).provider.getSubscription('  '))).code).toBe(ErrorCode.Validation);
  });
});

describe('pause, resume and cancel', () => {
  /** Pause/Resume success, verbatim [pause / api_response SUCCESS]. */
  const MODIFY_SUCCESS = { head: { responseTimestamp: '1549609221581', version: 'v1' }, body: { resultInfo: { status: 'SUCCESS', code: '3006', message: 'SUCCESS' } } };
  /** Pause/Resume failure, verbatim [pause / api_response FAIL]. */
  const MODIFY_FAIL = { head: { responseTimestamp: '1549609221581', version: 'v1' }, body: { resultInfo: { status: 'FAILURE', code: '400', message: 'The MID checksum is not enabled on the given mid' } } };
  /** Cancel success, verbatim [cancel / api_response SUCCESS]: message and status are swapped in the docs' sample. */
  const CANCEL_SUCCESS = {
    head: { version: 'v1', timestamp: '1566989003596' },
    body: {
      resultInfo: { code: '200', message: 'SUCCESS', status: 'Subscription is unsubscribed successfully' },
      mId: 'YOUR_MID_HERE',
      subsId: 'SUBSCRIPTION_ID',
      custId: 'rahul7.verma',
      createdDate: '2019-00-28 00:00:00.0',
      expiryDate: '2019-00-28',
    },
  };

  it('pause sends {mid, subsId, status: SUSPENDED}, then reads the subscription', async () => {
    const { provider, calls } = makeProvider([
      { url: MODIFY_URL, json: MODIFY_SUCCESS },
      { url: STATUS_URL, json: statusAnswer({ status: 'SUSPENDED' }) },
    ]);
    const subscription = await provider.pauseSubscription('130010');
    const request = sent(calls[0] as never);
    expect(request.url.href).toBe(MODIFY_URL);
    expect(request.head).toEqual({ tokenType: 'AES', signature: expect.any(String) });
    expect(request.body).toEqual({ mid: MID, subsId: '130010', status: 'SUSPENDED' });
    expect(subscription).toMatchObject({ status: SubscriptionStatus.Paused, providerStatus: 'SUSPENDED' });
  });

  it('resume sends status ACTIVE', async () => {
    const { provider, calls } = makeProvider([
      { url: MODIFY_URL, json: MODIFY_SUCCESS },
      { url: STATUS_URL, json: statusAnswer() },
    ]);
    const subscription = await provider.resumeSubscription('130010');
    expect(sent(calls[0] as never).body).toEqual({ mid: MID, subsId: '130010', status: 'ACTIVE' });
    expect(subscription.status).toBe(SubscriptionStatus.Active);
  });

  it('a pause that succeeded is not turned into an error when the follow-up read fails', async () => {
    const { provider } = makeProvider([
      { url: MODIFY_URL, json: MODIFY_SUCCESS },
      { url: STATUS_URL, networkError: true },
    ]);
    expect(await provider.pauseSubscription('130010')).toMatchObject({
      id: '130010',
      status: SubscriptionStatus.Paused,
      providerStatus: GATEWAY_STATUS_UNAVAILABLE,
    });
  });

  it('refuses a pause date and a resume date (Paytm\'s APIs take none) without sending anything', async () => {
    const { provider, calls } = makeProvider([]);
    expect((await errorOf(provider.pauseSubscription('130010', { resumeAt: '2026-12-01T00:00:00Z' }))).code).toBe(ErrorCode.Unsupported);
    expect((await errorOf(provider.resumeSubscription('130010', { nextChargeAt: '2026-12-01T00:00:00Z' }))).code).toBe(ErrorCode.Unsupported);
    expect(calls).toHaveLength(0);
  });

  it('a pause Paytm refuses is an error with its code', async () => {
    const { provider } = makeProvider([{ url: MODIFY_URL, json: MODIFY_FAIL }]);
    const error = await errorOf(provider.pauseSubscription('130010'));
    expect(error).toMatchObject({ code: ErrorCode.Validation, providerCode: '400' });
    expect(error.message).toContain('The MID checksum is not enabled');
  });

  it('a pause whose answer is lost is OUTCOME_UNKNOWN', async () => {
    const { provider } = makeProvider([{ url: MODIFY_URL, networkError: true }]);
    expect((await errorOf(provider.pauseSubscription('130010'))).code).toBe(ErrorCode.OutcomeUnknown);
  });

  it('cancel succeeds on code 200 (the docs\' sample has message and status swapped) and returns the cancelled subscription', async () => {
    const { provider, calls } = makeProvider([
      { url: CANCEL_URL, json: CANCEL_SUCCESS },
      { url: STATUS_URL, json: statusAnswer({ status: 'REJECT' }) },
    ]);
    const subscription = await provider.cancelSubscription('130010');
    const request = sent(calls[0] as never);
    expect(request.url.href).toBe(CANCEL_URL);
    expect(request.head).toEqual({ tokenType: 'AES', signature: expect.any(String) });
    expect(request.body).toEqual({ mid: MID, subsId: '130010' });
    expect(subscription.status).toBe(SubscriptionStatus.Cancelled);
  });

  it('cancelling at the end of the period is unsupported, and nothing is sent', async () => {
    const { provider, calls } = makeProvider([]);
    expect((await errorOf(provider.cancelSubscription('130010', { mode: CancelMode.AtPeriodEnd }))).code).toBe(ErrorCode.Unsupported);
    expect(calls).toHaveLength(0);
  });

  it('cancelling again is safe: when Paytm refuses, an already-ended subscription is returned as it is', async () => {
    const { provider } = makeProvider([
      { url: CANCEL_URL, json: reply({ resultInfo: { code: '400', message: 'already unsubscribed', status: 'FAILURE' } }) },
      { url: STATUS_URL, json: statusAnswer({ status: 'REJECT' }) },
    ]);
    expect((await provider.cancelSubscription('130010')).status).toBe(SubscriptionStatus.Cancelled);
  });

  it('a cancel with a lost answer reads the state: ended is success, still live is OUTCOME_UNKNOWN', async () => {
    const ended = makeProvider([
      { url: CANCEL_URL, networkError: true },
      { url: STATUS_URL, json: statusAnswer({ status: 'REJECT' }) },
    ]);
    expect((await ended.provider.cancelSubscription('130010')).status).toBe(SubscriptionStatus.Cancelled);
    const live = makeProvider([
      { url: CANCEL_URL, networkError: true },
      { url: STATUS_URL, json: statusAnswer() },
    ]);
    expect((await errorOf(live.provider.cancelSubscription('130010'))).code).toBe(ErrorCode.OutcomeUnknown);
  });

  it('a refused cancel of a live subscription is the refusal', async () => {
    const { provider } = makeProvider([
      { url: CANCEL_URL, json: reply({ resultInfo: { code: '400', message: 'The SSO Validation Failed.', status: 'FAILURE' } }) },
      { url: STATUS_URL, json: statusAnswer() },
    ]);
    expect(await errorOf(provider.cancelSubscription('130010'))).toMatchObject({ code: ErrorCode.Validation, providerCode: '400' });
  });

  it('a cancel that succeeded survives a failing follow-up read', async () => {
    const { provider } = makeProvider([
      { url: CANCEL_URL, json: CANCEL_SUCCESS },
      { url: STATUS_URL, status: 500, text: 'oops' },
    ]);
    expect(await provider.cancelSubscription('130010')).toMatchObject({ status: SubscriptionStatus.Cancelled, providerStatus: GATEWAY_STATUS_UNAVAILABLE });
  });
});

describe('unsupported operations', () => {
  it('updateSubscription, createPlan, getPlan and listCharges are UNSUPPORTED and send nothing', async () => {
    const { provider, calls } = makeProvider([]);
    for (const call of [
      () => provider.updateSubscription('130010', { amount: 100 }),
      () => provider.createPlan({ name: 'x', amount: 100, interval: { unit: 'month', count: 1 } }),
      () => provider.getPlan('p'),
      () => provider.listCharges('130010'),
    ]) {
      expect((await errorOf(call())).code).toBe(ErrorCode.Unsupported);
    }
    expect(calls).toHaveLength(0);
  });

  it('an empty update is VALIDATION, not UNSUPPORTED (the input is checked first)', async () => {
    const { provider } = makeProvider([]);
    expect((await errorOf(provider.updateSubscription('130010', {}))).code).toBe(ErrorCode.Validation);
  });
});

describe('the merchant key never leaks', () => {
  it('is not in the provider, its JSON, a created subscription, its checkout fields or raw, or any error', async () => {
    const { provider } = makeProvider([createRoute, { url: STATUS_URL, json: reply({ resultInfo: { code: '3005', message: 'Some error occured', status: 'FAILURE' } }) }]);
    const subscription = await provider.createSubscription(BASE_INPUT);
    expect(JSON.stringify(subscription)).not.toContain(KEY);
    expect(JSON.stringify(subscription.checkout)).not.toContain(KEY);
    expect(JSON.stringify(provider)).not.toContain(KEY);
    expect(JSON.stringify(Object.entries(provider))).not.toContain(KEY);
    expect(String(provider)).not.toContain(KEY);
    const error = await errorOf(provider.getSubscription('130010'));
    expect(error.message).not.toContain(KEY);
    expect(JSON.stringify(error)).not.toContain(KEY);
    expect(JSON.stringify(error.raw)).not.toContain(KEY);
  });

  it('is not in a config error, and a key of the wrong length is a CONFIG error', async () => {
    for (const merchantKey of ['too-short', 'this-key-is-way-too-long-for-aes-128']) {
      let message = '';
      try {
        makeProvider([], { merchantKey });
      } catch (error) {
        expect((error as SubscriptionError).code).toBe(ErrorCode.Config);
        message = (error as Error).message;
      }
      expect(message).toMatch(/merchantKey/);
      expect(message).not.toContain(merchantKey);
    }
  });
});

describe('config and capabilities', () => {
  it('rejects a missing mid, website, an unknown environment, and bad URLs, with CONFIG', () => {
    const bad: Record<string, unknown>[] = [
      { mid: '' },
      { website: '' },
      { environment: 'staging' },
      { callbackUrl: 'not a url' },
      { subscriptionBaseUrl: 'nope' },
      { transactionStatusBaseUrl: 'nope' },
      { refundBaseUrl: 'nope' },
      { channelId: 'MOBILE' },
      { graceDays: -1 },
      { debitReason: 'x'.repeat(51) },
    ];
    for (const override of bad) {
      expect(() => makeProvider([], override as never), JSON.stringify(override)).toThrowError(expect.objectContaining({ code: ErrorCode.Config }));
    }
    expect(() => makeProvider([], { mid: undefined } as never)).toThrowError(expect.objectContaining({ code: ErrorCode.Config }));
  });

  it('declares what it can do: merchant scheduling first, then Paytm\'s own', () => {
    const { provider } = makeProvider([]);
    expect(provider.name).toBe('paytm');
    expect(provider.capabilities).toEqual({
      provider: 'paytm',
      scheduling: [SchedulingMode.Merchant, SchedulingMode.Gateway],
      gatewayPlans: false,
      trial: true,
      upfrontAmount: true,
      quantity: false,
      pause: true,
      resume: true,
      cancelAtPeriodEnd: false,
      changePlan: false,
      merchantCharges: true,
      merchantPreDebitNotification: true,
      listCharges: false,
      refunds: true,
      signedWebhooks: true,
      idempotencyKeys: false,
      paymentMethods: [PaymentMethod.Upi, PaymentMethod.Card, PaymentMethod.ENach],
    });
  });
});
