import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  CancelMode,
  ChargeKind,
  ChargeStatus,
  CheckoutKind,
  Environment,
  ErrorCode,
  HttpMethod,
  IntervalUnit,
  PaymentMethod,
  Provider,
  RefundStatus,
  SchedulingMode,
  SubscriptionStatus,
} from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import type { ProviderOptions } from '../../src/provider.js';
import { CashfreeProvider, cashfree } from '../../src/providers/cashfree/index.js';
import { mockFetch, type MockRoute, type RecordedCall } from '../helpers/mock-fetch.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const CLIENT_ID = 'test_client_id_123';
const CLIENT_SECRET = 'test_client_secret_ZZ9_do_not_leak';
const WEBHOOK_SECRET = 'whsec_do_not_leak_987';
const SANDBOX = 'https://sandbox.cashfree.com/pg';
const PRODUCTION = 'https://api.cashfree.com/pg';
/** 2026-11-17 10:30 IST. */
const NOW = new Date('2026-11-17T05:00:00.000Z');

/** Retries must not sleep for real. */
class TestCashfree extends CashfreeProvider {
  constructor(config: ConstructorParameters<typeof CashfreeProvider>[0], options?: ProviderOptions) {
    super(config, options);
    this.http.sleep = async () => {};
  }
}

function setup(routes: MockRoute[], overrides: Partial<ConstructorParameters<typeof CashfreeProvider>[0]> = {}, options: ProviderOptions = {}) {
  const mock = mockFetch(routes);
  const provider = new TestCashfree(
    { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, environment: Environment.Test, ...overrides },
    { fetch: mock.fetch, now: () => NOW, ...options },
  );
  return { provider, ...mock };
}

async function rejection(promise: Promise<unknown>): Promise<SubscriptionError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SubscriptionError);
    return error as SubscriptionError;
  }
  throw new Error('expected the promise to reject');
}

function body(call: RecordedCall | undefined): Record<string, unknown> {
  expect(call).toBeDefined();
  return (call?.json ?? {}) as Record<string, unknown>;
}

function onlyCall(calls: RecordedCall[]): RecordedCall {
  expect(calls).toHaveLength(1);
  return calls[0] as RecordedCall;
}

const CUSTOMER = { name: 'Sushane Yadav', email: 'sushane.yadav@abc.com', phone: '9999999999' };
const PLAN_INPUT = {
  name: 'Premium Monthly',
  amount: 49900,
  interval: { unit: IntervalUnit.Month, count: 1 },
};

// ---------------------------------------------------------------------------
// Fixtures. Each names its source in the fact sheet (ref/facts/cashfree.md).
// ---------------------------------------------------------------------------

/** [openapi] PlanEntity.example */
const PLAN_ENTITY_EXAMPLE = {
  plan_currency: 'INR',
  plan_id: '144436-03471-JD_TEST',
  plan_interval_type: 'WEEK',
  plan_intervals: 1,
  plan_max_amount: 1,
  plan_max_cycles: 4,
  plan_name: 'abscede',
  plan_note: 'lsdkdn',
  plan_recurring_amount: 1,
  plan_status: 'ACTIVE',
  plan_type: 'PERIODIC',
};

/** [guide:hosted-checkout] create plan response (ON_DEMAND). */
const PLAN_ON_DEMAND_RESPONSE = {
  plan_currency: 'INR',
  plan_id: 'plan_cashfree_sbox',
  plan_interval_type: null,
  plan_intervals: null,
  plan_max_amount: 100,
  plan_max_cycles: null,
  plan_name: 'Premium_10',
  plan_note: 'Test Plan Cashfree',
  plan_recurring_amount: 0,
  plan_status: 'ACTIVE',
  plan_type: 'ON_DEMAND',
};

/** [guide:hosted-checkout] create subscription response (ON_DEMAND, INITIALIZED). */
const SUBSCRIPTION_CREATE_ON_DEMAND = {
  authorization_details: {
    authorization_amount: 1,
    authorization_amount_refund: true,
    authorization_reference: null,
    authorization_time: null,
    authorization_status: null,
    payment_id: null,
    payment_method: null,
    instrument_id: null,
  },
  cf_subscription_id: '604456',
  customer_details: {
    customer_name: 'Sushane Yadav',
    customer_email: 'sushane.yadav@abc.com',
    customer_phone: '9999999999',
    customer_bank_account_holder_name: 'Sushane Yadav',
    customer_bank_account_number: '010080198715',
    customer_bank_ifsc: 'ICIC0001008',
    customer_bank_code: 'ICIC',
    customer_bank_account_type: 'SAVINGS',
  },
  plan_details: {
    plan_id: 'plan_cashfree_sbox',
    plan_name: 'Premium_10',
    plan_type: 'ON_DEMAND',
    plan_max_cycles: null,
    plan_recurring_amount: 0,
    plan_max_amount: 100,
    plan_interval_type: null,
    plan_intervals: null,
    plan_currency: 'INR',
    plan_note: null,
    plan_status: null,
  },
  subscription_expiry_time: '2028-12-25T01:15:22+05:30',
  subscription_first_charge_time: null,
  subscription_id: 'create-ondemand-subs-12',
  subscription_meta: {
    return_url: 'https://wa.me/8473222?textPayment%20Successfull',
  },
  subscription_payment_splits: null,
  subscription_session_id:
    'sub_session_0KnQeY5a63YSnrlk-unL2CuQHV1n4ghoo-laNrHiEL1qgWiytwC_ELZOxjl1AmRm53vh8XT9iTyBECN5KgjAnsu9L9cfzfbCG96rM4T_rZs02q6vsopg3RFXstNZppmlhOytuNMpayment',
  subscription_status: 'INITIALIZED',
  subscription_tags: {
    subscription_note: 'test create subs',
  },
};

/** [guide:hosted-checkout] fetch subscription response after a UPI authorisation (ACTIVE). */
const SUBSCRIPTION_FETCH_ACTIVE = {
  authorization_details: {
    authorization_amount: 1,
    authorization_amount_refund: true,
    authorization_reference: 'J7iuqUTKXxoNS17u5oBq4n24jYFAV5@upi',
    authorization_time: '2024-11-25T22:05:25+05:30',
    authorization_status: 'ACTIVE',
    payment_id: '513463',
    payment_method: 'upi',
    instrument_id: null,
  },
  cf_subscription_id: '604456',
  customer_details: {
    customer_name: 'Sushane Yadav',
    customer_email: 'sushane.yadav@abc.com',
    customer_phone: '9999999999',
    customer_bank_account_holder_name: 'Sushane Yadav',
    customer_bank_account_number: '010080198715',
    customer_bank_ifsc: 'ICIC0001008',
    customer_bank_code: 'ICIC',
    customer_bank_account_type: 'SAVINGS',
  },
  plan_details: {
    plan_id: 'plan_cashfree_sbox',
    plan_name: 'Premium_10',
    plan_type: 'ON_DEMAND',
    plan_max_cycles: null,
    plan_recurring_amount: 0,
    plan_max_amount: 100,
    plan_interval_type: null,
    plan_intervals: null,
    plan_currency: 'INR',
    plan_note: null,
    plan_status: null,
  },
  subscription_expiry_time: '2028-12-25T01:15:22+05:30',
  subscription_first_charge_time: null,
  subscription_id: 'create-ondemand-subs-12',
  subscription_meta: {
    return_url: 'https://wa.me/8473222?textPayment%20Successfull',
  },
  subscription_payment_splits: null,
  subscription_session_id:
    'sub_session_8NDk6JTfSb9elrakgfn8VE_1j_pJ7zEWdWJefDha68ddBjapy6AjlxLLYoObqxLvDYF1nysfWCbu11wPeJmQbub00dadRUs7rPIf1nc33-4F85BNjZV0_3uOdt7rDMkPUesto0wpayment',
  subscription_status: 'ACTIVE',
  subscription_tags: {
    subscription_note: 'test create subs',
  },
};

/** [openapi] SubscriptionEntity.example (note `authorisation_details` with an "s" and the object-shaped `payment_method`). */
const SUBSCRIPTION_ENTITY_EXAMPLE = {
  authorisation_details: {
    authorization_amount: 1,
    authorization_amount_refund: false,
    authorization_reference: '',
    authorization_time: '2025-06-01T23:47:52+05:30',
    authorization_status: 'INITIALIZED',
    payment_id: '97877',
    payment_group: 'enach',
    payment_method: {
      enach: {
        channel: 'link',
        auth_mode: 'NetBanking',
        account_type: 'SAVINGS',
        account_number: '123456789012',
        account_ifsc: 'SBIN0000123',
        account_holder_name: 'John Doe',
        account_bank_code: 'SBIN',
      },
    },
  },
  cf_subscription_id: '4',
  customer_details: {
    customer_name: 'John Doe',
    customer_email: 'test@gmail.com',
    customer_phone: '9900755700',
    customer_bank_account_holder_name: '',
    customer_bank_account_number: '',
    customer_bank_ifsc: '',
    customer_bank_code: '',
    customer_bank_account_type: '',
  },
  next_schedule_date: null,
  plan_details: {
    plan_id: 'od-20k-plan',
    plan_name: 'On demand plan for 20000 max amount',
    plan_type: 'ON_DEMAND',
    plan_max_cycles: 0,
    plan_recurring_amount: 0,
    plan_max_amount: 20000,
    plan_interval_type: '',
    plan_intervals: 0,
    plan_currency: 'INR',
    plan_note: '',
    plan_status: '',
  },
  subscription_expiry_time: '2100-01-01T05:29:59+05:30',
  subscription_first_charge_time: '',
  subscription_id: 'SUB0028',
  subscription_meta: {
    return_url: '',
  },
  subscription_note: '',
  subscription_session_id: 'subs_token_tc9JCN4MzUIJ',
  subscription_payment_splits: null,
  subscription_status: 'INITIALIZED',
  subscription_tags: null,
};

/**
 * Derived from the [guide:hosted-checkout] create response with `plan_details`
 * changed to a PERIODIC monthly plan: the sources contain no verbatim PERIODIC
 * subscription response.
 */
function periodicResponse(overrides: Record<string, unknown> = {}) {
  return {
    ...SUBSCRIPTION_CREATE_ON_DEMAND,
    subscription_id: 'sub_ref_1',
    subscription_expiry_time: '2028-12-24T19:45:22+05:30',
    plan_details: {
      plan_id: 'plan_inline_1',
      plan_name: 'Premium Monthly',
      plan_type: 'PERIODIC',
      plan_max_cycles: null,
      plan_recurring_amount: 499,
      plan_max_amount: 499,
      plan_interval_type: 'MONTH',
      plan_intervals: 1,
      plan_currency: 'INR',
      plan_note: null,
      plan_status: null,
    },
    ...overrides,
  };
}

/** [guide:hosted-checkout] raise-a-charge response (ON_DEMAND, `INITIALIZED`). */
const CHARGE_RESPONSE = {
  action: null,
  cf_payment_id: '513474',
  channel: null,
  data: null,
  payment_amount: 10,
  payment_id: 'test-payment-subs-07',
  payment_method: null,
  payment_status: 'INITIALIZED',
  payment_type: 'CHARGE',
  subscription_id: 'create-ondemand-subs-12',
};

/** [openapi] SubscriptionPaymentEntity.example (an AUTH payment that succeeded; its ₹1 is refunded). */
const PAYMENT_ENTITY_EXAMPLE = {
  authorization_details: {
    authorization_amount: 1,
    authorization_amount_refund: true,
    start_time: '2024-04-18T16:40:00',
    authorization_reference: 'osduh20ijegaoinfbBjuweod31@upi',
    authorization_time: '2025-06-01T16:45:00',
    authorization_status: 'ACTIVE',
    payment_id: 'test-payment-id',
    payment_group: 'upi',
    payment_method: {
      upi: {
        channel: 'collect',
        upi_id: 'test@upi',
        upi_instrument: 'upiInstrument',
        upi_instrument_number: '1234567890',
        upi_payer_account_number: '039861903074',
        upi_payer_ifsc: 'SBIN0001234',
      },
    },
  },
  cf_payment_id: '123456',
  cf_txn_id: '123456',
  cf_order_id: '123456',
  cf_subscription_id: '7891011',
  failure_details: {
    failure_reason: '',
  },
  payment_amount: 1,
  payment_id: 'test-payment-id',
  payment_initiated_date: '2025-06-01T22:14:58+0530',
  payment_remarks: 'authpayment',
  payment_schedule_date: '',
  payment_status: 'SUCCESS',
  payment_type: 'AUTH',
  retry_attempts: 0,
  subscription_id: 'test-subscription-id',
};

/** [guide:custom-checkout__mobile__android-subscription-element] list response. */
const PAYMENT_LIST_SAMPLE = [
  {
    cf_payment_id: '123456',
    cf_subscription_id: '7891011',
    payment_id: 'your-payment-id',
    payment_amount: 1,
    payment_status: 'SUCCESS',
    payment_type: 'AUTH',
    payment_initiated_date: '2025-06-01T22:14:58+0530',
    subscription_id: 'your-subscription-id',
    retry_attempts: 0,
    failure_details: {
      failure_reason: '',
    },
  },
];

/** [openapi] SubscriptionPaymentRefundEntity.example */
const REFUND_ENTITY_EXAMPLE = {
  payment_id: 'pay8643',
  cf_payment_id: '863782648',
  refund_id: 'refund2',
  cf_refund_id: 'ref_212',
  refund_amount: 100,
  refund_note: 'test',
  refund_speed: 'INSTANT',
  refund_status: 'INITIALIZED',
};

// ---------------------------------------------------------------------------
// Config, factory, capabilities
// ---------------------------------------------------------------------------

describe('configuration', () => {
  it('the factory returns a CashfreeProvider', () => {
    const provider = cashfree({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, environment: Environment.Test });
    expect(provider).toBeInstanceOf(CashfreeProvider);
    expect(provider.name).toBe(Provider.Cashfree);
  });

  it('sends the sandbox host, auth and version headers for the test environment', async () => {
    const { provider, calls } = setup([{ method: HttpMethod.Get, url: `${SANDBOX}/plans/plan_cashfree_sbox`, json: PLAN_ON_DEMAND_RESPONSE }]);
    await provider.getPlan('plan_cashfree_sbox');
    const call = onlyCall(calls);
    expect(call.method).toBe('GET');
    expect(call.url).toBe(`${SANDBOX}/plans/plan_cashfree_sbox`);
    expect(call.headers['x-client-id']).toBe(CLIENT_ID);
    expect(call.headers['x-client-secret']).toBe(CLIENT_SECRET);
    // Default version: [openapi parameters.apiVersionHeader default] 2026-01-01.
    expect(call.headers['x-api-version']).toBe('2026-01-01');
    expect(call.headers.accept).toBe('application/json');
    expect(call.headers['content-type']).toBeUndefined();
  });

  it('sends the production host for the live environment', async () => {
    const { provider, calls } = setup(
      [{ method: HttpMethod.Get, url: `${PRODUCTION}/plans/plan_cashfree_sbox`, json: PLAN_ON_DEMAND_RESPONSE }],
      { environment: Environment.Live },
    );
    await provider.getPlan('plan_cashfree_sbox');
    expect(onlyCall(calls).url).toBe(`${PRODUCTION}/plans/plan_cashfree_sbox`);
  });

  it('honours apiVersion and baseUrl overrides (trailing slash stripped)', async () => {
    const { provider, calls } = setup(
      [{ method: HttpMethod.Get, url: 'https://proxy.example.test/pg/plans/p1', json: PLAN_ON_DEMAND_RESPONSE }],
      { apiVersion: '2025-01-01', baseUrl: 'https://proxy.example.test/pg/' },
    );
    await provider.getPlan('p1');
    expect(onlyCall(calls).headers['x-api-version']).toBe('2025-01-01');
  });

  it.each([
    ['missing clientId', { clientId: '' }, 'clientId'],
    ['missing clientSecret', { clientSecret: '' }, 'clientSecret'],
    ['unknown environment', { environment: 'staging' }, 'environment'],
    ['malformed apiVersion', { apiVersion: '2026/01/01' }, 'apiVersion'],
    ['malformed baseUrl', { baseUrl: 'not a url' }, 'baseUrl'],
    ['empty webhookSecret', { webhookSecret: '' }, 'webhookSecret'],
  ])('rejects %s with CONFIG', (_label, patch, field) => {
    let error: unknown;
    try {
      cashfree({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, environment: Environment.Test, ...patch } as never);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SubscriptionError);
    expect((error as SubscriptionError).code).toBe(ErrorCode.Config);
    expect((error as SubscriptionError).message).toContain(field);
    expect((error as SubscriptionError).message).not.toContain(CLIENT_SECRET);
  });

  it('rejects a config that is not an object, without echoing it', () => {
    expect(() => cashfree(undefined as never)).toThrowError(expect.objectContaining({ code: ErrorCode.Config }));
  });

  it('does not expose secrets through serialisation or inspection of the provider', () => {
    const provider = cashfree({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      webhookSecret: WEBHOOK_SECRET,
      environment: Environment.Test,
    });
    for (const text of [JSON.stringify(provider), inspect(provider, { depth: 5, showHidden: true }), String(provider)]) {
      expect(text).not.toContain(CLIENT_SECRET);
      expect(text).not.toContain(WEBHOOK_SECRET);
    }
  });
});

describe('capabilities', () => {
  it('describes what Cashfree can do', () => {
    const { provider } = setup([]);
    expect(provider.capabilities).toEqual({
      provider: Provider.Cashfree,
      scheduling: [SchedulingMode.Gateway, SchedulingMode.Merchant],
      gatewayPlans: true,
      trial: true,
      upfrontAmount: true,
      quantity: false,
      pause: true,
      resume: true,
      cancelAtPeriodEnd: false,
      changePlan: true,
      merchantCharges: true,
      merchantPreDebitNotification: false,
      // Cut-off table [guide:charge]: 48 h lead always lands on T+2; 13 days satisfies both "T+14" and "less than 14 days".
      merchantChargeLeadHours: 48,
      merchantChargeMaxAheadHours: 312,
      listCharges: true,
      refunds: true,
      signedWebhooks: true,
      idempotencyKeys: true,
      paymentMethods: [PaymentMethod.Upi, PaymentMethod.Card, PaymentMethod.ENach],
    });
  });

  it('leaves notifyCharge unsupported: Cashfree sends the pre-debit notification itself', async () => {
    const { provider, calls } = setup([]);
    const error = await rejection(
      provider.notifyCharge({
        subscriptionId: 's1',
        notificationId: 'n1',
        amount: 100,
        debitAt: '2026-12-01T10:00:00+05:30',
      }),
    );
    expect(error.code).toBe(ErrorCode.Unsupported);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

describe('createPlan', () => {
  it('posts a PERIODIC plan in rupees and normalises the response', async () => {
    const { provider, calls } = setup([{ method: HttpMethod.Post, url: `${SANDBOX}/plans`, json: PLAN_ENTITY_EXAMPLE }]);
    const plan = await provider.createPlan({
      id: 'plan_12345',
      name: 'Plan 12345',
      description: 'Test Plan',
      amount: 1000,
      maxAmount: 10000,
      maxCycles: 10,
      interval: { unit: IntervalUnit.Week, count: 2 },
    });
    const call = onlyCall(calls);
    expect(call.method).toBe('POST');
    expect(call.headers['content-type']).toBe('application/json');
    // [openapi] CreatePlanRequest.example, field for field.
    expect(call.json).toEqual({
      plan_id: 'plan_12345',
      plan_name: 'Plan 12345',
      plan_type: 'PERIODIC',
      plan_currency: 'INR',
      plan_recurring_amount: 10,
      plan_max_amount: 100,
      plan_max_cycles: 10,
      plan_intervals: 2,
      plan_interval_type: 'WEEK',
      plan_note: 'Test Plan',
    });
    // The response is the spec's PlanEntity example, so its id differs from the request's.
    expect(plan).toMatchObject({
      provider: Provider.Cashfree,
      id: '144436-03471-JD_TEST',
      name: 'abscede',
      description: 'lsdkdn',
      amount: 100,
      maxAmount: 100,
      maxCycles: 4,
      currency: 'INR',
      interval: { unit: IntervalUnit.Week, count: 1 },
      scheduling: SchedulingMode.Gateway,
      providerStatus: 'ACTIVE',
    });
    expect(plan.raw).toMatchObject({ plan_id: '144436-03471-JD_TEST' });
  });

  it('maps Merchant scheduling to an ON_DEMAND plan and echoes the amount and interval Cashfree does not store', async () => {
    const { provider, calls } = setup([{ method: HttpMethod.Post, url: `${SANDBOX}/plans`, json: PLAN_ON_DEMAND_RESPONSE }]);
    const plan = await provider.createPlan({
      id: 'plan_cashfree_sbox',
      name: 'Premium_10',
      description: 'Test Plan Cashfree',
      amount: 10000,
      interval: { unit: IntervalUnit.Month, count: 1 },
      scheduling: SchedulingMode.Merchant,
    });
    // [guide:hosted-checkout] ON_DEMAND create-plan request: no recurring amount, no interval fields.
    expect(onlyCall(calls).json).toEqual({
      plan_id: 'plan_cashfree_sbox',
      plan_name: 'Premium_10',
      plan_type: 'ON_DEMAND',
      plan_currency: 'INR',
      plan_max_amount: 100,
      plan_note: 'Test Plan Cashfree',
    });
    expect(plan).toMatchObject({
      id: 'plan_cashfree_sbox',
      scheduling: SchedulingMode.Merchant,
      amount: 10000,
      maxAmount: 10000,
      interval: { unit: IntervalUnit.Month, count: 1 },
    });
  });

  it('defaults maxAmount to amount and generates a valid plan id', async () => {
    const { provider, calls } = setup([{ method: HttpMethod.Post, url: `${SANDBOX}/plans`, json: PLAN_ENTITY_EXAMPLE }]);
    await provider.createPlan({ name: 'P', amount: 49950, interval: { unit: IntervalUnit.Day, count: 7 } });
    const sent = body(onlyCall(calls));
    expect(sent.plan_max_amount).toBe(499.5);
    expect(sent.plan_recurring_amount).toBe(499.5);
    expect(sent.plan_interval_type).toBe('DAY');
    expect(sent.plan_id).toMatch(/^plan_[0-9a-f]{32}$/);
    expect((sent.plan_id as string).length).toBeLessThanOrEqual(40);
  });

  it('uses the production URL for the live environment', async () => {
    const { provider, calls } = setup(
      [{ method: HttpMethod.Post, url: `${PRODUCTION}/plans`, json: PLAN_ENTITY_EXAMPLE }],
      { environment: Environment.Live },
    );
    await provider.createPlan({ name: 'P', amount: 100, interval: { unit: IntervalUnit.Year, count: 1 } });
    expect(onlyCall(calls).url).toBe(`${PRODUCTION}/plans`);
    expect(body(onlyCall(calls)).plan_interval_type).toBe('YEAR');
  });

  it('rejects a plan name longer than Cashfree allows (40) before any request', async () => {
    const { provider, calls } = setup([]);
    const error = await rejection(provider.createPlan({ name: 'x'.repeat(41), amount: 100, interval: { unit: IntervalUnit.Month, count: 1 } }));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(calls).toHaveLength(0);
  });

  it('rejects a plan id with characters Cashfree does not allow', async () => {
    const { provider, calls } = setup([]);
    const error = await rejection(provider.createPlan({ id: 'bad id!', name: 'P', amount: 100, interval: { unit: IntervalUnit.Month, count: 1 } }));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(calls).toHaveLength(0);
  });

  it('is not retried when the response is lost (a plan id may already exist)', async () => {
    const { provider, calls } = setup([{ method: HttpMethod.Post, url: `${SANDBOX}/plans`, networkError: true }]);
    const error = await rejection(provider.createPlan({ name: 'P', amount: 100, interval: { unit: IntervalUnit.Month, count: 1 } }));
    expect(error.code).toBe(ErrorCode.OutcomeUnknown);
    expect(calls).toHaveLength(1);
  });
});

describe('getPlan', () => {
  it('fetches the plan by id', async () => {
    const { provider, calls } = setup([{ method: HttpMethod.Get, url: `${SANDBOX}/plans/plan_cashfree_sbox`, json: PLAN_ON_DEMAND_RESPONSE }]);
    const plan = await provider.getPlan('plan_cashfree_sbox');
    expect(onlyCall(calls).method).toBe('GET');
    // ON_DEMAND: Cashfree stores a recurring amount of 0 and the ceiling in plan_max_amount.
    expect(plan).toMatchObject({
      id: 'plan_cashfree_sbox',
      scheduling: SchedulingMode.Merchant,
      amount: 0,
      maxAmount: 10000,
      description: 'Test Plan Cashfree',
    });
    expect(plan.interval).toBeUndefined();
    expect(plan.maxCycles).toBeUndefined();
  });

  it('maps 404 to NOT_FOUND', async () => {
    const { provider } = setup([
      { method: HttpMethod.Get, url: `${SANDBOX}/plans/nope`, status: 404, json: { message: 'something is not found', code: 'something_not_found', type: 'invalid_request_error' } },
    ]);
    const error = await rejection(provider.getPlan('nope'));
    expect(error.code).toBe(ErrorCode.NotFound);
  });
});

// ---------------------------------------------------------------------------
// createSubscription
// ---------------------------------------------------------------------------

describe('createSubscription', () => {
  it('creates a gateway-scheduled subscription with an inline plan and the minimum, refunded authorisation', async () => {
    const { provider, calls } = setup([
      { method: HttpMethod.Post, url: `${SANDBOX}/subscriptions`, json: periodicResponse() },
    ]);
    const subscription = await provider.createSubscription({
      reference: 'sub_ref_1',
      plan: { ...PLAN_INPUT, maxAmount: 49900 },
      customer: { ...CUSTOMER, phone: '+919999999999' },
      returnUrl: 'https://merchant.example/return',
      mandateEndsAt: '2028-12-24T14:15:22Z',
      authorizeBy: '2026-11-17T12:00:00+05:30',
      metadata: { order: 'A-1' },
      notifyCustomer: true,
    });
    const call = onlyCall(calls);
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${SANDBOX}/subscriptions`);
    expect(call.headers['x-idempotency-key']).toBeUndefined();
    expect(call.json).toEqual({
      subscription_id: 'sub_ref_1',
      customer_details: {
        customer_name: 'Sushane Yadav',
        customer_email: 'sushane.yadav@abc.com',
        customer_phone: '9999999999',
      },
      // The OpenAPI request schema names the periodic amount `plan_amount` here.
      plan_details: {
        plan_name: 'Premium Monthly',
        plan_type: 'PERIODIC',
        plan_currency: 'INR',
        plan_amount: 499,
        plan_max_amount: 499,
        plan_intervals: 1,
        plan_interval_type: 'MONTH',
      },
      // §5.3: no upfrontAmount -> minimum verification amount, refunded automatically.
      authorization_details: { authorization_amount: 1, authorization_amount_refund: true },
      subscription_meta: {
        return_url: 'https://merchant.example/return',
        notification_channel: ['EMAIL', 'SMS'],
        session_id_expiry: '2026-11-17T12:00:00+05:30',
      },
      // Explicit +05:30 offset: the guide sample shows `Z` expiries being shifted.
      subscription_expiry_time: '2028-12-24T19:45:22+05:30',
      subscription_tags: { order: 'A-1' },
    });
    expect(subscription).toMatchObject({
      provider: Provider.Cashfree,
      id: 'sub_ref_1',
      reference: 'sub_ref_1',
      planId: 'plan_inline_1',
      status: SubscriptionStatus.Created,
      providerStatus: 'INITIALIZED',
      scheduling: SchedulingMode.Gateway,
      amount: 49900,
      maxAmount: 49900,
      interval: { unit: IntervalUnit.Month, count: 1 },
      mandateEndsAt: '2028-12-24T14:15:22.000Z',
      checkout: {
        kind: CheckoutKind.CashfreeCheckout,
        sessionId: SUBSCRIPTION_CREATE_ON_DEMAND.subscription_session_id,
        environment: Environment.Test,
      },
    });
    expect(subscription.raw).toMatchObject({ cf_subscription_id: '604456' });
  });

  it('puts the live environment in the checkout instruction and uses the production URL', async () => {
    const { provider, calls } = setup(
      [{ method: HttpMethod.Post, url: `${PRODUCTION}/subscriptions`, json: periodicResponse() }],
      { environment: Environment.Live },
    );
    const subscription = await provider.createSubscription({ reference: 'sub_ref_1', plan: PLAN_INPUT, customer: CUSTOMER });
    expect(onlyCall(calls).url).toBe(`${PRODUCTION}/subscriptions`);
    expect(subscription.checkout).toMatchObject({ kind: CheckoutKind.CashfreeCheckout, environment: Environment.Live });
  });

  it('sends subscription_first_charge_time for a free trial and reports the first charge in startAt', async () => {
    const { provider, calls } = setup([
      {
        method: HttpMethod.Post,
        url: `${SANDBOX}/subscriptions`,
        json: periodicResponse({ subscription_first_charge_time: '2026-11-24T10:30:00+05:30' }),
      },
    ]);
    const subscription = await provider.createSubscription({
      reference: 'sub_ref_1',
      plan: PLAN_INPUT,
      customer: CUSTOMER,
      trial: { days: 7 },
    });
    const sent = body(onlyCall(calls));
    // 7 days from 2026-11-17 10:30 IST, with an explicit IST offset.
    expect(sent.subscription_first_charge_time).toBe('2026-11-24T10:30:00+05:30');
    expect(sent.authorization_details).toEqual({ authorization_amount: 1, authorization_amount_refund: true });
    expect(subscription.status).toBe(SubscriptionStatus.Created);
    expect(subscription.startAt).toBe('2026-11-24T05:00:00.000Z');
  });

  it('accepts an absolute trial end and a startAt, and does not enforce any trial window itself', async () => {
    const trialEnd = '2027-03-01T00:00:00+05:30';
    const { provider, calls } = setup([
      { method: HttpMethod.Post, url: `${SANDBOX}/subscriptions`, json: periodicResponse() },
      { method: HttpMethod.Post, url: `${SANDBOX}/subscriptions`, json: periodicResponse() },
    ]);
    await provider.createSubscription({ reference: 'a', plan: PLAN_INPUT, customer: CUSTOMER, trial: { endsAt: trialEnd } });
    await provider.createSubscription({ reference: 'b', plan: PLAN_INPUT, customer: CUSTOMER, startAt: '2026-12-25T09:00:00+05:30' });
    expect(body(calls[0]).subscription_first_charge_time).toBe('2027-03-01T00:00:00+05:30');
    expect(body(calls[1]).subscription_first_charge_time).toBe('2026-12-25T09:00:00+05:30');
  });

  it('surfaces Cashfree\'s own error for an unclear trial window instead of pre-empting it', async () => {
    const { provider } = setup([
      {
        method: HttpMethod.Post,
        url: `${SANDBOX}/subscriptions`,
        status: 400,
        json: { message: 'first charge date outside window', code: 'request_failed', type: 'invalid_request_error' },
      },
    ]);
    const error = await rejection(
      provider.createSubscription({ reference: 'sub_ref_1', plan: PLAN_INPUT, customer: CUSTOMER, trial: { days: 90 } }),
    );
    expect(error.code).toBe(ErrorCode.Validation);
    expect(error.providerCode).toBe('request_failed');
  });

  it('rejects mandateEndsAt before a days-based trial ends', async () => {
    const { provider, calls } = setup([]);
    const error = await rejection(
      provider.createSubscription({
        reference: 'sub_ref_1',
        plan: PLAN_INPUT,
        customer: CUSTOMER,
        trial: { days: 30 },
        mandateEndsAt: '2026-11-20T00:00:00+05:30',
      }),
    );
    expect(error.code).toBe(ErrorCode.Validation);
    expect(calls).toHaveLength(0);
  });

  it('collects an upfront amount as the non-refunded authorisation amount, restricted to UPI and card', async () => {
    const { provider, calls } = setup([{ method: HttpMethod.Post, url: `${SANDBOX}/subscriptions`, json: periodicResponse() }]);
    await provider.createSubscription({
      reference: 'sub_ref_1',
      plan: PLAN_INPUT,
      customer: CUSTOMER,
      upfrontAmount: 49950,
    });
    expect(body(onlyCall(calls)).authorization_details).toEqual({
      authorization_amount: 499.5,
      authorization_amount_refund: false,
      payment_methods: ['upi', 'card'],
    });
  });

  it('keeps an explicit UPI/card paymentMethods list when collecting an upfront amount', async () => {
    const { provider, calls } = setup([{ method: HttpMethod.Post, url: `${SANDBOX}/subscriptions`, json: periodicResponse() }]);
    await provider.createSubscription({
      reference: 'sub_ref_1',
      plan: PLAN_INPUT,
      customer: CUSTOMER,
      upfrontAmount: 10000,
      paymentMethods: [PaymentMethod.Card],
    });
    expect(body(onlyCall(calls)).authorization_details).toEqual({
      authorization_amount: 100,
      authorization_amount_refund: false,
      payment_methods: ['card'],
    });
  });

  it('refuses an upfront amount on eNACH, which always authorises for 0', async () => {
    const { provider, calls } = setup([]);
    for (const paymentMethods of [[PaymentMethod.ENach], [PaymentMethod.Upi, PaymentMethod.ENach]]) {
      const error = await rejection(
        provider.createSubscription({ reference: 'r', plan: PLAN_INPUT, customer: CUSTOMER, upfrontAmount: 10000, paymentMethods }),
      );
      expect(error.code).toBe(ErrorCode.Unsupported);
    }
    expect(calls).toHaveLength(0);
  });

  it('sends a zero, unrefunded authorisation for an eNACH-only mandate', async () => {
    const { provider, calls } = setup([{ method: HttpMethod.Post, url: `${SANDBOX}/subscriptions`, json: periodicResponse() }]);
    await provider.createSubscription({ reference: 'sub_ref_1', plan: PLAN_INPUT, customer: CUSTOMER, paymentMethods: [PaymentMethod.ENach] });
    expect(body(onlyCall(calls)).authorization_details).toEqual({
      authorization_amount: 0,
      authorization_amount_refund: false,
      payment_methods: ['enach'],
    });
  });

  it('keeps the minimum refunded authorisation when eNACH is one of several methods', async () => {
    const { provider, calls } = setup([{ method: HttpMethod.Post, url: `${SANDBOX}/subscriptions`, json: periodicResponse() }]);
    await provider.createSubscription({
      reference: 'sub_ref_1',
      plan: PLAN_INPUT,
      customer: CUSTOMER,
      paymentMethods: [PaymentMethod.Upi, PaymentMethod.ENach, PaymentMethod.Card],
    });
    expect(body(onlyCall(calls)).authorization_details).toEqual({
      authorization_amount: 1,
      authorization_amount_refund: true,
      payment_methods: ['upi', 'enach', 'card'],
    });
  });

  it('creates a merchant-scheduled subscription: ON_DEMAND plan, no first-charge time, schedule data returned', async () => {
    const { provider, calls } = setup([
      {
        method: HttpMethod.Post,
        url: `${SANDBOX}/subscriptions`,
        json: { ...SUBSCRIPTION_CREATE_ON_DEMAND, subscription_id: 'sub_ref_1' },
      },
    ]);
    const subscription = await provider.createSubscription({
      reference: 'sub_ref_1',
      plan: { ...PLAN_INPUT, scheduling: SchedulingMode.Merchant, maxAmount: 99900 },
      customer: CUSTOMER,
      totalCycles: 12,
      trial: { days: 14 },
    });
    const sent = body(onlyCall(calls));
    expect(sent.plan_details).toEqual({
      plan_name: 'Premium Monthly',
      plan_type: 'ON_DEMAND',
      plan_currency: 'INR',
      plan_max_amount: 999,
      plan_max_cycles: 12,
    });
    // Only valid for PERIODIC plans, so never sent for ON_DEMAND.
    expect(sent).not.toHaveProperty('subscription_first_charge_time');
    expect(subscription).toMatchObject({
      id: 'sub_ref_1',
      scheduling: SchedulingMode.Merchant,
      status: SubscriptionStatus.Created,
      // The scheduler registers from these: amount, interval, startAt (trial end), totalCycles.
      amount: 49900,
      interval: { unit: IntervalUnit.Month, count: 1 },
      startAt: '2026-12-01T05:00:00.000Z',
      totalCycles: 12,
    });
    expect(subscription.checkout?.kind).toBe(CheckoutKind.CashfreeCheckout);
  });

  it('uses now as the first charge instant for a merchant-scheduled subscription without a trial', async () => {
    const { provider } = setup([
      { method: HttpMethod.Post, url: `${SANDBOX}/subscriptions`, json: { ...SUBSCRIPTION_CREATE_ON_DEMAND, subscription_id: 'sub_ref_1' } },
    ]);
    const subscription = await provider.createSubscription({
      reference: 'sub_ref_1',
      plan: { ...PLAN_INPUT, scheduling: SchedulingMode.Merchant },
      customer: CUSTOMER,
    });
    expect(subscription.startAt).toBe(NOW.toISOString());
    expect(subscription.totalCycles).toBeUndefined();
  });

  it('returns startAt for a merchant-scheduled startAt too', async () => {
    const { provider, calls } = setup([
      { method: HttpMethod.Post, url: `${SANDBOX}/subscriptions`, json: { ...SUBSCRIPTION_CREATE_ON_DEMAND, subscription_id: 'sub_ref_1' } },
    ]);
    const subscription = await provider.createSubscription({
      reference: 'sub_ref_1',
      plan: { ...PLAN_INPUT, scheduling: SchedulingMode.Merchant },
      customer: CUSTOMER,
      startAt: '2026-12-25T09:00:00+05:30',
    });
    expect(subscription.startAt).toBe('2026-12-25T03:30:00.000Z');
    expect(body(onlyCall(calls))).not.toHaveProperty('subscription_first_charge_time');
  });

  it('uses an existing PERIODIC plan id: reads the plan, then sends only plan_id', async () => {
    const { provider, calls } = setup([
      { method: HttpMethod.Get, url: `${SANDBOX}/plans/plan_inline_1`, json: PLAN_ENTITY_EXAMPLE },
      { method: HttpMethod.Post, url: `${SANDBOX}/subscriptions`, json: periodicResponse() },
    ]);
    const subscription = await provider.createSubscription({ reference: 'sub_ref_1', plan: 'plan_inline_1', customer: CUSTOMER });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${SANDBOX}/plans/plan_inline_1`,
      `POST ${SANDBOX}/subscriptions`,
    ]);
    expect(body(calls[1]).plan_details).toEqual({ plan_id: 'plan_inline_1' });
    expect(subscription.planId).toBe('plan_inline_1');
  });

  it('refuses an existing ON_DEMAND plan id: the scheduler needs an interval, and nothing is created', async () => {
    const { provider, calls } = setup([
      { method: HttpMethod.Get, url: `${SANDBOX}/plans/plan_cashfree_sbox`, json: PLAN_ON_DEMAND_RESPONSE },
    ]);
    const error = await rejection(provider.createSubscription({ reference: 'r', plan: 'plan_cashfree_sbox', customer: CUSTOMER }));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(error.message).toMatch(/interval/);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
  });

  it('generates a subscription id when none is given', async () => {
    const { provider, calls } = setup([{ method: HttpMethod.Post, url: `${SANDBOX}/subscriptions`, json: periodicResponse() }]);
    await provider.createSubscription({ plan: PLAN_INPUT, customer: CUSTOMER });
    expect(body(onlyCall(calls)).subscription_id).toMatch(/^sub_[0-9a-f]{32}$/);
  });

  it('sends x-idempotency-key and retries only then', async () => {
    const { provider, calls } = setup([
      { method: HttpMethod.Post, url: `${SANDBOX}/subscriptions`, status: 503, json: { message: 'unavailable', code: 'internal_error', type: 'api_error' } },
      { method: HttpMethod.Post, url: `${SANDBOX}/subscriptions`, json: periodicResponse() },
    ]);
    const subscription = await provider.createSubscription({
      reference: 'sub_ref_1',
      plan: PLAN_INPUT,
      customer: CUSTOMER,
      idempotencyKey: '47bf8872-46fe-11ee-be56-0242ac120002',
    });
    expect(subscription.id).toBe('sub_ref_1');
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.headers['x-idempotency-key'])).toEqual([
      '47bf8872-46fe-11ee-be56-0242ac120002',
      '47bf8872-46fe-11ee-be56-0242ac120002',
    ]);
  });

  it('does not retry a create without an idempotency key: a 503 is OUTCOME_UNKNOWN', async () => {
    const { provider, calls } = setup([
      { method: HttpMethod.Post, url: `${SANDBOX}/subscriptions`, status: 503, json: { message: 'unavailable', code: 'internal_error', type: 'api_error' } },
    ]);
    const error = await rejection(provider.createSubscription({ reference: 'sub_ref_1', plan: PLAN_INPUT, customer: CUSTOMER }));
    expect(error.code).toBe(ErrorCode.OutcomeUnknown);
    expect(calls).toHaveLength(1);
  });

  it('maps 422 idempotency_error to CONFLICT', async () => {
    const { provider } = setup([
      {
        method: HttpMethod.Post,
        url: `${SANDBOX}/subscriptions`,
        status: 422,
        // [openapi] IdempotencyError
        json: { message: 'something is not found', code: 'request_invalid', type: 'idempotency_error' },
      },
    ]);
    const error = await rejection(
      provider.createSubscription({ reference: 'sub_ref_1', plan: PLAN_INPUT, customer: CUSTOMER, idempotencyKey: 'k' }),
    );
    expect(error.code).toBe(ErrorCode.Conflict);
    expect(error.providerCode).toBe('request_invalid');
  });

  it('requires customer email and phone, naming the missing field', async () => {
    const { provider, calls } = setup([]);
    const noEmail = await rejection(provider.createSubscription({ plan: PLAN_INPUT, customer: { phone: '9999999999' } }));
    expect(noEmail.code).toBe(ErrorCode.Validation);
    expect(noEmail.message).toContain('customer.email');
    const noPhone = await rejection(provider.createSubscription({ plan: PLAN_INPUT, customer: { email: 'a@b.co' } }));
    expect(noPhone.code).toBe(ErrorCode.Validation);
    expect(noPhone.message).toContain('customer.phone');
    const foreign = await rejection(provider.createSubscription({ plan: PLAN_INPUT, customer: { email: 'a@b.co', phone: '+14155550123' } }));
    expect(foreign.code).toBe(ErrorCode.Validation);
    expect(foreign.message).toContain('customer.phone');
    expect(calls).toHaveLength(0);
  });

  it('accepts +91 and 91 prefixed phone numbers as 10 digits', async () => {
    const { provider, calls } = setup([
      { method: HttpMethod.Post, url: `${SANDBOX}/subscriptions`, json: periodicResponse() },
      { method: HttpMethod.Post, url: `${SANDBOX}/subscriptions`, json: periodicResponse() },
    ]);
    await provider.createSubscription({ plan: PLAN_INPUT, customer: { email: 'a@b.co', phone: '+919876543210' } });
    await provider.createSubscription({ plan: PLAN_INPUT, customer: { email: 'a@b.co', phone: '919876543210' } });
    const phones = calls.map((call) => (body(call).customer_details as Record<string, unknown>).customer_phone);
    expect(phones).toEqual(['9876543210', '9876543210']);
  });

  it.each([
    ['quantity other than 1', { quantity: 2, plan: PLAN_INPUT }],
    ['totalCycles with an existing plan id', { totalCycles: 12, plan: 'plan_inline_1' }],
    ['an upfront label', { upfrontLabel: 'Setup fee', upfrontAmount: 10000, plan: PLAN_INPUT }],
    ['suppressing customer notifications', { notifyCustomer: false, plan: PLAN_INPUT }],
    ['physical NACH', { paymentMethods: [PaymentMethod.PhysicalNach], plan: PLAN_INPUT }],
  ])('throws UNSUPPORTED for %s before any request', async (_label, extra) => {
    const { provider, calls } = setup([]);
    const error = await rejection(provider.createSubscription({ customer: CUSTOMER, ...extra }));
    expect(error.code).toBe(ErrorCode.Unsupported);
    expect(calls).toHaveLength(0);
  });

  it('accepts quantity 1', async () => {
    const { provider } = setup([{ method: HttpMethod.Post, url: `${SANDBOX}/subscriptions`, json: periodicResponse() }]);
    await expect(provider.createSubscription({ reference: 'sub_ref_1', quantity: 1, plan: PLAN_INPUT, customer: CUSTOMER })).resolves.toBeDefined();
  });

  it('maps totalCycles with an inline plan to plan_max_cycles and rejects disagreeing limits', async () => {
    const { provider, calls } = setup([{ method: HttpMethod.Post, url: `${SANDBOX}/subscriptions`, json: periodicResponse() }]);
    await provider.createSubscription({ reference: 'sub_ref_1', plan: PLAN_INPUT, customer: CUSTOMER, totalCycles: 6 });
    expect((body(onlyCall(calls)).plan_details as Record<string, unknown>).plan_max_cycles).toBe(6);
    const error = await rejection(
      provider.createSubscription({ reference: 'r', plan: { ...PLAN_INPUT, maxCycles: 3 }, customer: CUSTOMER, totalCycles: 6 }),
    );
    expect(error.code).toBe(ErrorCode.Validation);
  });

  it('rejects more than 10 metadata tags', async () => {
    const { provider, calls } = setup([]);
    const metadata = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, 'v']));
    const error = await rejection(provider.createSubscription({ plan: PLAN_INPUT, customer: CUSTOMER, metadata }));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(calls).toHaveLength(0);
  });

  it('fails loudly when the response has no session id', async () => {
    const { provider } = setup([
      { method: HttpMethod.Post, url: `${SANDBOX}/subscriptions`, json: { ...periodicResponse(), subscription_session_id: null } },
    ]);
    const error = await rejection(provider.createSubscription({ reference: 'sub_ref_1', plan: PLAN_INPUT, customer: CUSTOMER }));
    expect(error.code).toBe(ErrorCode.UnexpectedResponse);
  });

  it('fails loudly on a response without subscription_status', async () => {
    const { provider } = setup([
      { method: HttpMethod.Post, url: `${SANDBOX}/subscriptions`, json: { subscription_id: 'x', subscription_session_id: 's' } },
    ]);
    const error = await rejection(provider.createSubscription({ reference: 'x', plan: PLAN_INPUT, customer: CUSTOMER }));
    expect(error.code).toBe(ErrorCode.UnexpectedResponse);
  });
});

// ---------------------------------------------------------------------------
// getSubscription
// ---------------------------------------------------------------------------

describe('getSubscription', () => {
  it('normalises an ACTIVE merchant-scheduled subscription (string payment_method, no recurring amount)', async () => {
    const { provider, calls } = setup([
      { method: HttpMethod.Get, url: `${SANDBOX}/subscriptions/create-ondemand-subs-12`, json: SUBSCRIPTION_FETCH_ACTIVE },
    ]);
    const subscription = await provider.getSubscription('create-ondemand-subs-12');
    expect(onlyCall(calls).method).toBe('GET');
    expect(subscription).toMatchObject({
      id: 'create-ondemand-subs-12',
      reference: 'create-ondemand-subs-12',
      planId: 'plan_cashfree_sbox',
      status: SubscriptionStatus.Active,
      providerStatus: 'ACTIVE',
      scheduling: SchedulingMode.Merchant,
      maxAmount: 10000,
      currency: 'INR',
      mandateEndsAt: '2028-12-24T19:45:22.000Z',
      paymentMethod: PaymentMethod.Upi,
      customer: { name: 'Sushane Yadav', email: 'sushane.yadav@abc.com', phone: '9999999999' },
      metadata: { subscription_note: 'test create subs' },
    });
    // Nothing to report: an ON_DEMAND plan bills nothing by itself.
    expect(subscription.amount).toBeUndefined();
    expect(subscription.interval).toBeUndefined();
    expect(subscription.checkout).toBeUndefined();
  });

  it('reads the spec\'s `authorisation_details` spelling and an object-shaped payment_method', async () => {
    const { provider } = setup([{ method: HttpMethod.Get, url: `${SANDBOX}/subscriptions/SUB0028`, json: SUBSCRIPTION_ENTITY_EXAMPLE }]);
    const subscription = await provider.getSubscription('SUB0028');
    expect(subscription).toMatchObject({
      status: SubscriptionStatus.Created,
      paymentMethod: PaymentMethod.ENach,
      maxAmount: 2000000,
      scheduling: SchedulingMode.Merchant,
      mandateEndsAt: '2099-12-31T23:59:59.000Z',
    });
    // plan_max_cycles: 0, plan_intervals: 0, "" first-charge time: all mean "none".
    expect(subscription.totalCycles).toBeUndefined();
    expect(subscription.startAt).toBeUndefined();
    // An unauthorised subscription hands back its (fresh) session id so checkout can be reopened.
    expect(subscription.checkout).toMatchObject({ kind: CheckoutKind.CashfreeCheckout, sessionId: 'subs_token_tc9JCN4MzUIJ' });
  });

  it('reports Trialing with trialEndsAt while the first charge is still ahead, Active afterwards', async () => {
    const trial = periodicResponse({ subscription_status: 'ACTIVE', subscription_first_charge_time: '2026-11-24T10:30:00+05:30', next_schedule_date: '2026-11-24T00:00:00+05:30' });
    const past = periodicResponse({ subscription_status: 'ACTIVE', subscription_first_charge_time: '2026-11-10T10:30:00+05:30' });
    const { provider } = setup([
      { method: HttpMethod.Get, url: `${SANDBOX}/subscriptions/sub_ref_1`, json: trial },
      { method: HttpMethod.Get, url: `${SANDBOX}/subscriptions/sub_ref_1`, json: past },
    ]);
    const trialing = await provider.getSubscription('sub_ref_1');
    expect(trialing).toMatchObject({
      status: SubscriptionStatus.Trialing,
      providerStatus: 'ACTIVE',
      trialEndsAt: '2026-11-24T05:00:00.000Z',
      startAt: '2026-11-24T05:00:00.000Z',
      nextChargeAt: '2026-11-23T18:30:00.000Z',
      amount: 49900,
    });
    const active = await provider.getSubscription('sub_ref_1');
    expect(active.status).toBe(SubscriptionStatus.Active);
    expect(active.trialEndsAt).toBeUndefined();
  });

  it('percent-encodes ids in the path (subscription ids may contain spaces)', async () => {
    const { provider, calls } = setup([
      { method: HttpMethod.Get, url: `${SANDBOX}/subscriptions/my%20sub%2F1`, json: { ...SUBSCRIPTION_FETCH_ACTIVE, subscription_id: 'my sub/1' } },
    ]);
    const subscription = await provider.getSubscription('my sub/1');
    expect(onlyCall(calls).url).toBe(`${SANDBOX}/subscriptions/my%20sub%2F1`);
    expect(subscription.id).toBe('my sub/1');
  });

  it('keeps an unknown status verbatim and falls back to the non-charging Created', async () => {
    const { provider } = setup([
      { method: HttpMethod.Get, url: `${SANDBOX}/subscriptions/create-ondemand-subs-12`, json: { ...SUBSCRIPTION_FETCH_ACTIVE, subscription_status: 'ACTION_REQUIRED' } },
    ]);
    const subscription = await provider.getSubscription('create-ondemand-subs-12');
    expect(subscription.providerStatus).toBe('ACTION_REQUIRED');
    expect(subscription.status).toBe(SubscriptionStatus.Created);
  });

  it('retries a read after a 5xx and succeeds', async () => {
    const { provider, calls } = setup([
      { method: HttpMethod.Get, url: `${SANDBOX}/subscriptions/create-ondemand-subs-12`, status: 502, text: 'bad gateway' },
      { method: HttpMethod.Get, url: `${SANDBOX}/subscriptions/create-ondemand-subs-12`, json: SUBSCRIPTION_FETCH_ACTIVE },
    ]);
    await provider.getSubscription('create-ondemand-subs-12');
    expect(calls).toHaveLength(2);
  });

  it('rejects an empty id without a request', async () => {
    const { provider, calls } = setup([]);
    const error = await rejection(provider.getSubscription(''));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Manage actions
// ---------------------------------------------------------------------------

describe('cancelSubscription', () => {
  it('sends the CANCEL action', async () => {
    const { provider, calls } = setup([
      {
        method: HttpMethod.Post,
        url: `${SANDBOX}/subscriptions/create-ondemand-subs-12/manage`,
        json: { ...SUBSCRIPTION_FETCH_ACTIVE, subscription_status: 'CANCELLED' },
      },
    ]);
    const subscription = await provider.cancelSubscription('create-ondemand-subs-12');
    const call = onlyCall(calls);
    expect(call.method).toBe('POST');
    // No verbatim CANCEL sample exists; the shape follows [openapi] ManageSubscriptionRequest.
    expect(call.json).toEqual({ subscription_id: 'create-ondemand-subs-12', action: 'CANCEL' });
    expect(subscription.status).toBe(SubscriptionStatus.Cancelled);
    expect(subscription.providerStatus).toBe('CANCELLED');
  });

  it('accepts an explicit immediate mode and refuses cancel-at-period-end', async () => {
    const { provider, calls } = setup([
      { method: HttpMethod.Post, url: `${SANDBOX}/subscriptions/s1/manage`, json: { ...SUBSCRIPTION_FETCH_ACTIVE, subscription_id: 's1', subscription_status: 'CANCELLED' } },
    ]);
    await provider.cancelSubscription('s1', { mode: CancelMode.Immediately });
    const error = await rejection(provider.cancelSubscription('s1', { mode: CancelMode.AtPeriodEnd }));
    expect(error.code).toBe(ErrorCode.Unsupported);
    expect(calls).toHaveLength(1);
  });

  it('is not retried on a dropped connection', async () => {
    const { provider, calls } = setup([{ method: HttpMethod.Post, url: `${SANDBOX}/subscriptions/s1/manage`, networkError: true }]);
    const error = await rejection(provider.cancelSubscription('s1'));
    expect(error.code).toBe(ErrorCode.OutcomeUnknown);
    expect(calls).toHaveLength(1);
  });
});

describe('pauseSubscription / resumeSubscription', () => {
  it('pauses a PERIODIC subscription with the PAUSE action (after reading its plan type)', async () => {
    const { provider, calls } = setup([
      { method: HttpMethod.Get, url: `${SANDBOX}/subscriptions/sub_ref_1`, json: periodicResponse({ subscription_status: 'ACTIVE' }) },
      { method: HttpMethod.Post, url: `${SANDBOX}/subscriptions/sub_ref_1/manage`, json: periodicResponse({ subscription_status: 'PAUSED' }) },
    ]);
    const subscription = await provider.pauseSubscription('sub_ref_1');
    expect(calls[1]?.json).toEqual({ subscription_id: 'sub_ref_1', action: 'PAUSE' });
    expect(subscription.status).toBe(SubscriptionStatus.Paused);
  });

  it('leaves pause of a merchant-scheduled (ON_DEMAND) subscription to the scheduler: no manage call', async () => {
    const { provider, calls } = setup([
      { method: HttpMethod.Get, url: `${SANDBOX}/subscriptions/create-ondemand-subs-12`, json: SUBSCRIPTION_FETCH_ACTIVE },
    ]);
    const subscription = await provider.pauseSubscription('create-ondemand-subs-12');
    expect(calls).toHaveLength(1);
    expect(subscription.scheduling).toBe(SchedulingMode.Merchant);
    expect(subscription.status).toBe(SubscriptionStatus.Active);
  });

  it('refuses a scheduled resume (resumeAt)', async () => {
    const { provider, calls } = setup([]);
    const error = await rejection(provider.pauseSubscription('s1', { resumeAt: '2026-12-01T00:00:00+05:30' }));
    expect(error.code).toBe(ErrorCode.Unsupported);
    expect(calls).toHaveLength(0);
  });

  it('resumes with ACTIVATE and next_scheduled_time (date part, IST) from nextChargeAt', async () => {
    const { provider, calls } = setup([
      { method: HttpMethod.Get, url: `${SANDBOX}/subscriptions/sub_ref_1`, json: periodicResponse({ subscription_status: 'PAUSED' }) },
      { method: HttpMethod.Post, url: `${SANDBOX}/subscriptions/sub_ref_1/manage`, json: periodicResponse({ subscription_status: 'ACTIVE' }) },
    ]);
    const subscription = await provider.resumeSubscription('sub_ref_1', { nextChargeAt: '2026-12-01T10:00:00+05:30' });
    // [guide:faq] ACTIVATE sample uses "2026-10-01T00:00:00+05:30": midnight IST of the date.
    expect(calls[1]?.json).toEqual({
      subscription_id: 'sub_ref_1',
      action: 'ACTIVATE',
      action_details: { next_scheduled_time: '2026-12-01T00:00:00+05:30' },
    });
    expect(subscription.status).toBe(SubscriptionStatus.Active);
  });

  it('takes the IST date when nextChargeAt is a late-evening UTC instant', async () => {
    const { provider, calls } = setup([
      { method: HttpMethod.Get, url: `${SANDBOX}/subscriptions/sub_ref_1`, json: periodicResponse({ subscription_status: 'PAUSED' }) },
      { method: HttpMethod.Post, url: `${SANDBOX}/subscriptions/sub_ref_1/manage`, json: periodicResponse({ subscription_status: 'ACTIVE' }) },
    ]);
    await provider.resumeSubscription('sub_ref_1', { nextChargeAt: '2026-12-01T20:00:00Z' });
    expect((body(calls[1]).action_details as Record<string, unknown>).next_scheduled_time).toBe('2026-12-02T00:00:00+05:30');
  });

  it('requires nextChargeAt to resume a PERIODIC subscription (ACTIVATE needs next_scheduled_time)', async () => {
    const { provider, calls } = setup([
      { method: HttpMethod.Get, url: `${SANDBOX}/subscriptions/sub_ref_1`, json: periodicResponse({ subscription_status: 'PAUSED' }) },
    ]);
    const error = await rejection(provider.resumeSubscription('sub_ref_1'));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(error.message).toContain('nextChargeAt');
    expect(calls).toHaveLength(1);
  });

  it('leaves resume of a merchant-scheduled subscription to the scheduler, with or without nextChargeAt', async () => {
    const { provider, calls } = setup([
      { method: HttpMethod.Get, url: `${SANDBOX}/subscriptions/create-ondemand-subs-12`, json: SUBSCRIPTION_FETCH_ACTIVE },
    ]);
    const subscription = await provider.resumeSubscription('create-ondemand-subs-12');
    expect(subscription.scheduling).toBe(SchedulingMode.Merchant);
    expect(calls).toHaveLength(1);
  });
});

describe('updateSubscription', () => {
  it('changes plan with CHANGE_PLAN', async () => {
    const { provider, calls } = setup([
      { method: HttpMethod.Get, url: `${SANDBOX}/subscriptions/Demo_Subscription`, json: periodicResponse({ subscription_id: 'Demo_Subscription', subscription_status: 'ACTIVE' }) },
      { method: HttpMethod.Post, url: `${SANDBOX}/subscriptions/Demo_Subscription/manage`, json: periodicResponse({ subscription_id: 'Demo_Subscription', subscription_status: 'ACTIVE' }) },
    ]);
    await provider.updateSubscription('Demo_Subscription', { planId: 'new-plan-1' });
    // [openapi] ManageSubscriptionRequest.example
    expect(calls[1]?.json).toEqual({
      subscription_id: 'Demo_Subscription',
      action: 'CHANGE_PLAN',
      action_details: { plan_id: 'new-plan-1' },
    });
  });

  it.each([
    ['quantity', { quantity: 2 }],
    ['mandateEndsAt', { mandateEndsAt: '2030-01-01T00:00:00+05:30' }],
    ['timing at period end', { planId: 'p2', timing: 'at_period_end' as const }],
    ['notifyCustomer', { planId: 'p2', notifyCustomer: true }],
  ])('throws UNSUPPORTED for %s without any request', async (_label, input) => {
    const { provider, calls } = setup([]);
    const error = await rejection(provider.updateSubscription('s1', input));
    expect(error.code).toBe(ErrorCode.Unsupported);
    expect(calls).toHaveLength(0);
  });

  it('throws UNSUPPORTED for amount, nextChargeAt and remainingCycles on a gateway-scheduled subscription', async () => {
    const inputs = [{ amount: 100 }, { nextChargeAt: '2026-12-01T00:00:00+05:30' }, { remainingCycles: 3 }];
    for (const input of inputs) {
      const { provider, calls } = setup([
        { method: HttpMethod.Get, url: `${SANDBOX}/subscriptions/sub_ref_1`, json: periodicResponse({ subscription_status: 'ACTIVE' }) },
      ]);
      const error = await rejection(provider.updateSubscription('sub_ref_1', input));
      expect(error.code).toBe(ErrorCode.Unsupported);
      expect(calls.every((call) => call.method === 'GET')).toBe(true);
    }
  });

  it('refuses a plan change on a merchant-scheduled subscription', async () => {
    const { provider, calls } = setup([
      { method: HttpMethod.Get, url: `${SANDBOX}/subscriptions/create-ondemand-subs-12`, json: SUBSCRIPTION_FETCH_ACTIVE },
    ]);
    const error = await rejection(provider.updateSubscription('create-ondemand-subs-12', { planId: 'p2' }));
    expect(error.code).toBe(ErrorCode.Unsupported);
    expect(calls).toHaveLength(1);
  });

  it('leaves amount updates of a merchant-scheduled subscription to the scheduler, but enforces the mandate ceiling', async () => {
    const { provider, calls } = setup([
      { method: HttpMethod.Get, url: `${SANDBOX}/subscriptions/create-ondemand-subs-12`, json: SUBSCRIPTION_FETCH_ACTIVE },
      { method: HttpMethod.Get, url: `${SANDBOX}/subscriptions/create-ondemand-subs-12`, json: SUBSCRIPTION_FETCH_ACTIVE },
    ]);
    // plan_max_amount is 100 rupees = 10000 paise.
    const ok = await provider.updateSubscription('create-ondemand-subs-12', { amount: 10000 });
    expect(ok.scheduling).toBe(SchedulingMode.Merchant);
    const error = await rejection(provider.updateSubscription('create-ondemand-subs-12', { amount: 10001 }));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Charges
// ---------------------------------------------------------------------------

describe('createCharge', () => {
  it('raises a CHARGE payment with rupees and an IST schedule date', async () => {
    const { provider, calls } = setup([{ method: HttpMethod.Post, url: `${SANDBOX}/subscriptions/pay`, json: CHARGE_RESPONSE }]);
    const charge = await provider.createCharge({
      subscriptionId: 'create-ondemand-subs-12',
      chargeId: 'test-payment-subs-07',
      amount: 1000,
      scheduledAt: '2026-11-20T10:00:00+05:30',
      description: '2nd EMI payment',
    });
    const call = onlyCall(calls);
    expect(call.method).toBe('POST');
    // [openapi] examples.create_subscription_charge, [guide:hosted-checkout] charge request.
    expect(call.json).toEqual({
      subscription_id: 'create-ondemand-subs-12',
      payment_id: 'test-payment-subs-07',
      payment_type: 'CHARGE',
      payment_amount: 10,
      payment_schedule_date: '2026-11-20T00:00:00+05:30',
      payment_remarks: '2nd EMI payment',
    });
    expect(charge).toMatchObject({
      provider: Provider.Cashfree,
      id: 'test-payment-subs-07',
      reference: 'test-payment-subs-07',
      subscriptionId: 'create-ondemand-subs-12',
      kind: ChargeKind.Recurring,
      status: ChargeStatus.Scheduled,
      providerStatus: 'INITIALIZED',
      amount: 1000,
      scheduledAt: '2026-11-19T18:30:00.000Z',
    });
    expect(charge.paidAt).toBeUndefined();
  });

  it('takes the IST calendar date of scheduledAt', async () => {
    const { provider, calls } = setup([{ method: HttpMethod.Post, url: `${SANDBOX}/subscriptions/pay`, json: CHARGE_RESPONSE }]);
    // 20:00 UTC on the 20th is 01:30 IST on the 21st.
    await provider.createCharge({ subscriptionId: 's', chargeId: 'c', amount: 1000, scheduledAt: '2026-11-20T20:00:00Z' });
    expect(body(onlyCall(calls)).payment_schedule_date).toBe('2026-11-21T00:00:00+05:30');
  });

  it('defaults the schedule date to T+1 before 21:00 IST and T+2 after (UPI/card cut-off)', async () => {
    const mock = mockFetch([
      { method: HttpMethod.Post, url: `${SANDBOX}/subscriptions/pay`, json: CHARGE_RESPONSE },
      { method: HttpMethod.Post, url: `${SANDBOX}/subscriptions/pay`, json: CHARGE_RESPONSE },
    ]);
    const config = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, environment: Environment.Test };
    // 10:30 IST and 21:30 IST on 2026-11-17.
    for (const at of ['2026-11-17T05:00:00.000Z', '2026-11-17T16:00:00.000Z']) {
      const provider = new TestCashfree(config, { fetch: mock.fetch, now: () => new Date(at) });
      await provider.createCharge({ subscriptionId: 's', chargeId: `c-${at}`, amount: 1000 });
    }
    expect(mock.calls.map((call) => body(call).payment_schedule_date)).toEqual([
      '2026-11-18T00:00:00+05:30',
      '2026-11-19T00:00:00+05:30',
    ]);
  });

  it('converts paise to rupees without float drift', async () => {
    const { provider, calls } = setup([{ method: HttpMethod.Post, url: `${SANDBOX}/subscriptions/pay`, json: { ...CHARGE_RESPONSE, payment_amount: 499.99 } }]);
    const charge = await provider.createCharge({ subscriptionId: 's', chargeId: 'c', amount: 49999, scheduledAt: '2026-11-20T10:00:00+05:30' });
    expect(body(onlyCall(calls)).payment_amount).toBe(499.99);
    expect(charge.amount).toBe(49999);
  });

  it('reports a dropped connection as OUTCOME_UNKNOWN and never retries it', async () => {
    const { provider, calls } = setup([{ method: HttpMethod.Post, url: `${SANDBOX}/subscriptions/pay`, networkError: true }]);
    const error = await rejection(provider.createCharge({ subscriptionId: 's', chargeId: 'c', amount: 1000 }));
    expect(error.code).toBe(ErrorCode.OutcomeUnknown);
    expect(calls).toHaveLength(1);
  });

  it('reports a 5xx on a charge as OUTCOME_UNKNOWN (the debit may have been created)', async () => {
    const { provider, calls } = setup([
      { method: HttpMethod.Post, url: `${SANDBOX}/subscriptions/pay`, status: 504, text: 'gateway timeout' },
    ]);
    const error = await rejection(provider.createCharge({ subscriptionId: 's', chargeId: 'c', amount: 1000 }));
    expect(error.code).toBe(ErrorCode.OutcomeUnknown);
    expect(error.httpStatus).toBe(504);
    expect(calls).toHaveLength(1);
  });

  it('maps a refused charge (reused payment_id, subscription not ACTIVE) to a non-retryable VALIDATION error', async () => {
    const { provider } = setup([
      {
        method: HttpMethod.Post,
        url: `${SANDBOX}/subscriptions/pay`,
        status: 400,
        json: { message: 'payment_id already exists', code: 'request_failed', type: 'invalid_request_error' },
      },
    ]);
    const error = await rejection(provider.createCharge({ subscriptionId: 's', chargeId: 'c', amount: 1000 }));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('payment_id already exists');
  });
});

describe('getCharge', () => {
  it('fetches the payment by merchant payment_id and normalises it', async () => {
    const { provider, calls } = setup([
      { method: HttpMethod.Get, url: `${SANDBOX}/subscriptions/test-subscription-id/payments/test-payment-id`, json: PAYMENT_ENTITY_EXAMPLE },
    ]);
    const charge = await provider.getCharge('test-subscription-id', 'test-payment-id');
    expect(onlyCall(calls).method).toBe('GET');
    expect(charge).toMatchObject({
      id: 'test-payment-id',
      subscriptionId: 'test-subscription-id',
      // AUTH whose ₹1 is refunded automatically: the verification debit.
      kind: ChargeKind.Authorization,
      status: ChargeStatus.Succeeded,
      providerStatus: 'SUCCESS',
      amount: 100,
      paymentMethod: PaymentMethod.Upi,
    });
    expect(charge.failureReason).toBeUndefined();
    expect(charge.scheduledAt).toBeUndefined();
  });

  it('treats an AUTH payment that is kept (not refunded) as the upfront amount', async () => {
    const kept = {
      ...PAYMENT_ENTITY_EXAMPLE,
      payment_amount: 499,
      authorization_details: { ...PAYMENT_ENTITY_EXAMPLE.authorization_details, authorization_amount: 499, authorization_amount_refund: false },
    };
    const { provider } = setup([
      { method: HttpMethod.Get, url: `${SANDBOX}/subscriptions/test-subscription-id/payments/test-payment-id`, json: kept },
    ]);
    const charge = await provider.getCharge('test-subscription-id', 'test-payment-id');
    expect(charge.kind).toBe(ChargeKind.Upfront);
    expect(charge.amount).toBe(49900);
  });

  it('keeps the failure reason of a failed charge', async () => {
    const failed = {
      ...PAYMENT_ENTITY_EXAMPLE,
      payment_type: 'CHARGE',
      payment_status: 'FAILED',
      failure_details: { failure_reason: 'DEBIT FAILED | Insufficient Funds In Customer (Remitter) Account' },
    };
    const { provider } = setup([
      { method: HttpMethod.Get, url: `${SANDBOX}/subscriptions/test-subscription-id/payments/test-payment-id`, json: failed },
    ]);
    const charge = await provider.getCharge('test-subscription-id', 'test-payment-id');
    expect(charge).toMatchObject({
      kind: ChargeKind.Recurring,
      status: ChargeStatus.Failed,
      failureReason: 'DEBIT FAILED | Insufficient Funds In Customer (Remitter) Account',
    });
  });

  it('fails loudly on a payment without an amount', async () => {
    const { provider } = setup([
      { method: HttpMethod.Get, url: `${SANDBOX}/subscriptions/s/payments/p`, json: { payment_id: 'p', payment_status: 'SUCCESS' } },
    ]);
    const error = await rejection(provider.getCharge('s', 'p'));
    expect(error.code).toBe(ErrorCode.UnexpectedResponse);
  });
});

describe('listCharges', () => {
  it('lists the subscription payments', async () => {
    const { provider, calls } = setup([
      { method: HttpMethod.Get, url: `${SANDBOX}/subscriptions/your-subscription-id/payments`, json: PAYMENT_LIST_SAMPLE },
    ]);
    const charges = await provider.listCharges('your-subscription-id');
    expect(onlyCall(calls).method).toBe('GET');
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({
      id: 'your-payment-id',
      subscriptionId: 'your-subscription-id',
      kind: ChargeKind.Authorization,
      status: ChargeStatus.Succeeded,
      amount: 100,
    });
  });

  it('orders newest first by payment_initiated_date and applies limit to the newest', async () => {
    const entry = (id: string, date: string) => ({ ...PAYMENT_LIST_SAMPLE[0], payment_id: id, payment_initiated_date: date });
    const list = [
      entry('old', '2026-01-01T10:00:00+05:30'),
      entry('newest', '2026-03-01T10:00:00'),
      entry('middle', '2026-02-01T10:00:00+0530'),
    ];
    const { provider } = setup([
      { method: HttpMethod.Get, url: `${SANDBOX}/subscriptions/s/payments`, json: list },
      { method: HttpMethod.Get, url: `${SANDBOX}/subscriptions/s/payments`, json: list },
    ]);
    expect((await provider.listCharges('s')).map((charge) => charge.id)).toEqual(['newest', 'middle', 'old']);
    expect((await provider.listCharges('s', { limit: 2 })).map((charge) => charge.id)).toEqual(['newest', 'middle']);
  });

  it('returns an empty list for an empty array', async () => {
    const { provider } = setup([{ method: HttpMethod.Get, url: `${SANDBOX}/subscriptions/s/payments`, json: [] }]);
    await expect(provider.listCharges('s')).resolves.toEqual([]);
  });

  it('fails loudly when the body is not an array', async () => {
    const { provider } = setup([{ method: HttpMethod.Get, url: `${SANDBOX}/subscriptions/s/payments`, json: { data: [] } }]);
    const error = await rejection(provider.listCharges('s'));
    expect(error.code).toBe(ErrorCode.UnexpectedResponse);
  });
});

describe('refundCharge', () => {
  it('creates a partial refund under the subscription, in rupees', async () => {
    const { provider, calls } = setup([
      { method: HttpMethod.Post, url: `${SANDBOX}/subscriptions/test-subs-id/refunds`, json: REFUND_ENTITY_EXAMPLE },
    ]);
    const refund = await provider.refundCharge({
      subscriptionId: 'test-subs-id',
      chargeId: 'test-payment-id',
      refundId: 'dummy-test-refund-id',
      amount: 1000,
      reason: 'full refund',
    });
    const call = onlyCall(calls);
    expect(call.method).toBe('POST');
    // [openapi] CreateSubscriptionRefundRequest.example (refund_speed and cf_payment_id are left to Cashfree).
    expect(call.json).toEqual({
      subscription_id: 'test-subs-id',
      payment_id: 'test-payment-id',
      refund_id: 'dummy-test-refund-id',
      refund_amount: 10,
      refund_note: 'full refund',
    });
    // [openapi] SubscriptionPaymentRefundEntity.example: refund_amount 100 rupees.
    expect(refund).toMatchObject({
      provider: Provider.Cashfree,
      id: 'refund2',
      reference: 'refund2',
      chargeId: 'pay8643',
      subscriptionId: 'test-subs-id',
      status: RefundStatus.Pending,
      providerStatus: 'INITIALIZED',
      amount: 10000,
    });
  });

  it('refunds the full charge by reading its amount first', async () => {
    const { provider, calls } = setup([
      { method: HttpMethod.Get, url: `${SANDBOX}/subscriptions/test-subs-id/payments/test-payment-id`, json: { ...PAYMENT_ENTITY_EXAMPLE, payment_amount: 499 } },
      { method: HttpMethod.Post, url: `${SANDBOX}/subscriptions/test-subs-id/refunds`, json: { ...REFUND_ENTITY_EXAMPLE, refund_amount: 499, payment_id: 'test-payment-id' } },
    ]);
    const refund = await provider.refundCharge({ subscriptionId: 'test-subs-id', chargeId: 'test-payment-id', refundId: 'r1' });
    expect(calls.map((call) => call.method)).toEqual(['GET', 'POST']);
    expect(body(calls[1]).refund_amount).toBe(499);
    expect(refund.amount).toBe(49900);
  });

  it('requires subscriptionId', async () => {
    const { provider, calls } = setup([]);
    const error = await rejection(provider.refundCharge({ chargeId: 'c', refundId: 'r', amount: 100 }));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(error.message).toContain('subscriptionId');
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['SUCCESS', RefundStatus.Succeeded],
    ['FAILED', RefundStatus.Failed],
    ['CANCEL', RefundStatus.Failed],
    ['PENDING', RefundStatus.Pending],
    ['INITIALIZED', RefundStatus.Pending],
    ['SOMETHING_NEW', RefundStatus.Pending],
  ])('maps refund status %s', async (status, expected) => {
    const { provider } = setup([
      { method: HttpMethod.Post, url: `${SANDBOX}/subscriptions/s/refunds`, json: { ...REFUND_ENTITY_EXAMPLE, refund_status: status } },
    ]);
    const refund = await provider.refundCharge({ subscriptionId: 's', chargeId: 'c', refundId: 'r', amount: 100 });
    expect(refund.status).toBe(expected);
    expect(refund.providerStatus).toBe(status);
  });

  it('is not retried when the response is lost', async () => {
    const { provider, calls } = setup([{ method: HttpMethod.Post, url: `${SANDBOX}/subscriptions/s/refunds`, networkError: true }]);
    const error = await rejection(provider.refundCharge({ subscriptionId: 's', chargeId: 'c', refundId: 'r', amount: 100 }));
    expect(error.code).toBe(ErrorCode.OutcomeUnknown);
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// verifyCheckout
// ---------------------------------------------------------------------------

/** [api:redirection-payload-after-authorization] sample payload. */
const RETURN_URL_SAMPLE = {
  cf_subReferenceId: 1234567,
  cf_subscriptionId: 'sub_test_123',
  cf_authAmount: 1.0,
  cf_referenceId: 987654321,
  cf_status: 'ACTIVE',
  cf_message: 'Subscription authorised successfully',
  signature: 'calculated_signature_here',
  cf_umrn: 'UMRN1234567890',
  cf_checkoutStatus: 'SUCCESS',
  cf_mode: 'SBC_UPI',
  cf_subscriptionPaymentId: 'pay_test_123',
  cf_umn: 'UMN1234567890',
};

describe('verifyCheckout', () => {
  it('uses only the subscription id from the query and reports authorized from the fetched status', async () => {
    const { provider, calls } = setup([
      { method: HttpMethod.Get, url: `${SANDBOX}/subscriptions/sub_test_123`, json: { ...SUBSCRIPTION_FETCH_ACTIVE, subscription_id: 'sub_test_123' } },
    ]);
    const verification = await provider.verifyCheckout(RETURN_URL_SAMPLE);
    expect(onlyCall(calls).method).toBe('GET');
    expect(verification).toMatchObject({
      provider: Provider.Cashfree,
      subscriptionId: 'sub_test_123',
      reference: 'sub_test_123',
      authorized: true,
      status: SubscriptionStatus.Active,
    });
  });

  it('does not believe the query: a success-looking return for a subscription that is still INITIALIZED is not authorized', async () => {
    const { provider } = setup([
      { method: HttpMethod.Get, url: `${SANDBOX}/subscriptions/sub_test_123`, json: { ...SUBSCRIPTION_FETCH_ACTIVE, subscription_id: 'sub_test_123', subscription_status: 'INITIALIZED' } },
    ]);
    const verification = await provider.verifyCheckout(RETURN_URL_SAMPLE);
    expect(verification.authorized).toBe(false);
    expect(verification.status).toBe(SubscriptionStatus.Created);
  });

  it('does not report authorized for BANK_APPROVAL_PENDING (Cashfree rejects debits until ACTIVE) but exposes the status', async () => {
    const { provider } = setup([
      { method: HttpMethod.Get, url: `${SANDBOX}/subscriptions/sub_test_123`, json: { ...SUBSCRIPTION_FETCH_ACTIVE, subscription_id: 'sub_test_123', subscription_status: 'BANK_APPROVAL_PENDING' } },
    ]);
    const verification = await provider.verifyCheckout(RETURN_URL_SAMPLE);
    expect(verification.authorized).toBe(false);
    expect(verification.status).toBe(SubscriptionStatus.PendingAuthorization);
  });

  it('works for a trial: ACTIVE with a future first charge is authorized', async () => {
    const { provider } = setup([
      { method: HttpMethod.Get, url: `${SANDBOX}/subscriptions/sub_ref_1`, json: periodicResponse({ subscription_status: 'ACTIVE', subscription_first_charge_time: '2026-11-24T10:30:00+05:30' }) },
    ]);
    const verification = await provider.verifyCheckout({ cf_subscriptionId: 'sub_ref_1' });
    expect(verification.authorized).toBe(true);
    expect(verification.status).toBe(SubscriptionStatus.Trialing);
  });

  it('accepts only the subscription id, even when the rest of the query is missing', async () => {
    const { provider, calls } = setup([
      { method: HttpMethod.Get, url: `${SANDBOX}/subscriptions/sub_ref_1`, json: periodicResponse({ subscription_status: 'ACTIVE' }) },
    ]);
    await provider.verifyCheckout({ cf_subscriptionId: 'sub_ref_1', signature: 'forged' });
    expect(calls[0]?.url).toBe(`${SANDBOX}/subscriptions/sub_ref_1`);
  });

  it('requires cf_subscriptionId', async () => {
    const { provider, calls } = setup([]);
    for (const result of [{}, { cf_subscriptionId: '' }, { subscription_id: 'x' }]) {
      const error = await rejection(provider.verifyCheckout(result));
      expect(error.code).toBe(ErrorCode.Validation);
    }
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

describe('error mapping', () => {
  const READ = { method: HttpMethod.Get, url: `${SANDBOX}/subscriptions/s1` } as const;

  it.each([
    // [openapi] components.schemas error examples
    [400, { message: 'bad URL, please check API documentation', code: 'request_failed', type: 'invalid_request_error' }, ErrorCode.Validation, 'request_failed'],
    [401, { message: 'authentication Failed', code: 'request_failed', type: 'authentication_error' }, ErrorCode.Auth, 'request_failed'],
    [404, { message: 'something is not found', code: 'something_not_found', type: 'invalid_request_error' }, ErrorCode.NotFound, 'something_not_found'],
    [429, { message: 'Too many requests from IP. Check headers', code: 'request_failed', type: 'rate_limit_error' }, ErrorCode.RateLimited, 'request_failed'],
  ])('maps a %i spec error body', async (status, json, code, providerCode) => {
    const { provider } = setup([{ ...READ, status, json }], {}, { maxRetries: 0 });
    const error = await rejection(provider.getSubscription('s1'));
    expect(error.code).toBe(code);
    expect(error.providerCode).toBe(providerCode);
    expect(error.httpStatus).toBe(status);
    expect(error.message).toContain((json as { message: string }).message);
    expect(error.raw).toEqual(json);
  });

  it('maps a 500 on a read to PROVIDER_UNAVAILABLE after retries', async () => {
    const body500 = { message: 'internal Server Error', code: 'internal_error', type: 'api_error' };
    const { provider, calls } = setup([
      { ...READ, status: 500, json: body500 },
      { ...READ, status: 500, json: body500 },
      { ...READ, status: 500, json: body500 },
    ]);
    const error = await rejection(provider.getSubscription('s1'));
    expect(error.code).toBe(ErrorCode.ProviderUnavailable);
    expect(error.providerCode).toBe('internal_error');
    expect(error.retryable).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('reads the legacy { status, subCode, message } body', async () => {
    const { provider } = setup([
      {
        ...READ,
        status: 400,
        // [extra:charge-subscription] / [api:error-codes] legacy error format.
        json: { status: 'ERROR', subCode: '400', message: 'Unable to charge subscription | subscription is not active' },
      },
    ]);
    const error = await rejection(provider.getSubscription('s1'));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(error.providerCode).toBe('400');
    expect(error.message).toContain('Unable to charge subscription | subscription is not active');
  });

  it('adds the legacy reason to the message', async () => {
    const { provider } = setup([
      // [api:error-codes] error body.
      { ...READ, status: 400, json: { status: 'ERROR', subCode: '400', message: 'Error description', reason: 'Detailed error reason' } },
    ]);
    const error = await rejection(provider.getSubscription('s1'));
    expect(error.message).toContain('Error description (Detailed error reason)');
  });

  it('copes with a non-JSON error body', async () => {
    const { provider } = setup([{ ...READ, status: 403, text: '<html>Forbidden</html>' }]);
    const error = await rejection(provider.getSubscription('s1'));
    expect(error.code).toBe(ErrorCode.Auth);
    expect(error.message).toContain('Forbidden');
    expect(error.providerCode).toBeUndefined();
  });

  it('copes with an empty error body', async () => {
    const { provider } = setup([{ ...READ, status: 404 }]);
    const error = await rejection(provider.getSubscription('s1'));
    expect(error.code).toBe(ErrorCode.NotFound);
    expect(error.message).toContain('no error body');
  });

  it('copes with an error body that carries only a code', async () => {
    const { provider } = setup([{ ...READ, status: 400, json: { code: 'plan_id_missing' } }]);
    const error = await rejection(provider.getSubscription('s1'));
    expect(error.providerCode).toBe('plan_id_missing');
  });

  it('reports a success status with a non-JSON body as UNEXPECTED_RESPONSE', async () => {
    const { provider } = setup([{ ...READ, text: 'OK' }]);
    const error = await rejection(provider.getSubscription('s1'));
    expect(error.code).toBe(ErrorCode.UnexpectedResponse);
  });

  it('reports a dropped read as NETWORK after retries', async () => {
    const { provider, calls } = setup([
      { ...READ, networkError: true },
      { ...READ, networkError: true },
      { ...READ, networkError: true },
    ]);
    const error = await rejection(provider.getSubscription('s1'));
    expect(error.code).toBe(ErrorCode.Network);
    expect(calls).toHaveLength(3);
  });

  it('never puts the client secret or webhook secret into an error', async () => {
    const attempts: Array<() => Promise<unknown>> = [];
    const failing = (route: MockRoute, run: (provider: CashfreeProvider) => Promise<unknown>) => {
      const { provider } = setup([route], { webhookSecret: WEBHOOK_SECRET }, { maxRetries: 0 });
      attempts.push(() => run(provider));
    };
    const authBody = { message: 'authentication Failed', code: 'request_failed', type: 'authentication_error' };
    failing({ ...READ, status: 401, json: authBody }, (p) => p.getSubscription('s1'));
    failing({ method: HttpMethod.Post, url: `${SANDBOX}/subscriptions/pay`, networkError: true }, (p) =>
      p.createCharge({ subscriptionId: 's', chargeId: 'c', amount: 100 }),
    );
    failing({ method: HttpMethod.Post, url: `${SANDBOX}/subscriptions/s1/manage`, status: 500, json: authBody }, (p) => p.cancelSubscription('s1'));
    failing({ ...READ, text: 'not json' }, (p) => p.getSubscription('s1'));
    for (const attempt of attempts) {
      const error = await rejection(attempt());
      const everything = [
        error.message,
        error.stack ?? '',
        JSON.stringify(error),
        JSON.stringify(error.raw ?? null),
        inspect(error, { depth: 6, showHidden: true }),
      ].join('\n');
      expect(everything).not.toContain(CLIENT_SECRET);
      expect(everything).not.toContain(WEBHOOK_SECRET);
    }
  });
});
