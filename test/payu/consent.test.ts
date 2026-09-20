import { describe, expect, it } from 'vitest';
import { CheckoutKind, Environment, ErrorCode, SchedulingMode, SubscriptionStatus } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import { ConsentHashLayout } from '../../src/providers/payu/index.js';
import { CUSTOMER, MONTHLY_PLAN, NOW, SALT, SUCCESS_URL, FAILURE_URL, TEST_PAYMENT_URL, expectedConsentHash, makeProvider } from './helpers.js';

async function failure(run: () => Promise<unknown>): Promise<SubscriptionError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(SubscriptionError);
    return error as SubscriptionError;
  }
  throw new Error('expected an error');
}

/** Source of the field set and order: reference__payment-consent-transaction-payu-hosted ("Sample request (HTML form)"). */
const EXPECTED_FIELD_ORDER = [
  'key',
  'txnid',
  'amount',
  'productinfo',
  'firstname',
  'email',
  'phone',
  'surl',
  'furl',
  'api_version',
  'si_details',
  'si',
  'free_trial',
  'hash',
];

describe('createSubscription: the consent form', () => {
  it('makes no network call and returns a signed form post', async () => {
    const { provider, calls } = makeProvider();
    const subscription = await provider.createSubscription({ plan: { ...MONTHLY_PLAN }, customer: CUSTOMER });
    expect(calls).toHaveLength(0);

    expect(subscription).toMatchObject({
      provider: 'payu',
      id: 'sub_00000000000000000001',
      reference: 'sub_00000000000000000001',
      status: SubscriptionStatus.Created,
      scheduling: SchedulingMode.Merchant,
      amount: 49900,
      maxAmount: 49900,
      currency: 'INR',
      interval: { unit: 'month', count: 1 },
      startAt: NOW.toISOString(),
      customer: CUSTOMER,
    });
    expect(subscription.checkout).toMatchObject({ kind: CheckoutKind.FormPost, url: TEST_PAYMENT_URL });
    expect(subscription.trialEndsAt).toBeUndefined();
  });

  it('without a trial or upfront amount: a free-trial consent of INR 2.00 with free_trial=1', async () => {
    const { provider } = makeProvider();
    const { checkout } = await provider.createSubscription({ plan: { ...MONTHLY_PLAN }, customer: CUSTOMER });
    if (checkout?.kind !== CheckoutKind.FormPost) throw new Error('expected a form post');
    const fields = checkout.fields;

    expect(Object.keys(fields)).toEqual(EXPECTED_FIELD_ORDER);
    expect(fields).toMatchObject({
      key: 'BmTY3G',
      txnid: 'sub_00000000000000000001',
      amount: '2.00',
      productinfo: 'Pro monthly',
      firstname: 'Ashish Kumar',
      email: 'ashish@example.com',
      phone: '9876543210',
      surl: SUCCESS_URL,
      furl: FAILURE_URL,
      api_version: '7',
      si: '1',
      free_trial: '1',
    });
    expect(Object.values(fields).every((value) => typeof value === 'string')).toBe(true);
    // 2026-11-17 is "now" in IST; the default horizon is five years.
    expect(fields.si_details).toBe(
      '{"billingAmount":"499.00","billingCurrency":"INR","billingCycle":"MONTHLY","billingInterval":1,"paymentStartDate":"2026-11-17","paymentEndDate":"2031-11-17"}',
    );
  });

  it('the hash covers the exact si_details string that is posted (default six-pipe layout)', async () => {
    const { provider } = makeProvider();
    const { checkout } = await provider.createSubscription({ plan: { ...MONTHLY_PLAN }, customer: CUSTOMER });
    if (checkout?.kind !== CheckoutKind.FormPost) throw new Error('expected a form post');
    const f = checkout.fields as Record<string, string>;
    const expected = expectedConsentHash(
      { txnid: f.txnid!, amount: f.amount!, productinfo: f.productinfo!, firstname: f.firstname!, email: f.email!, si_details: f.si_details! },
      6,
    );
    expect(f.hash).toBe(expected);
    // Same value after the form's round trip through URL encoding (what the browser posts).
    const posted = Object.fromEntries(new URLSearchParams(new URLSearchParams(f).toString()));
    expect(posted.si_details).toBe(f.si_details);
  });

  it.each([
    [ConsentHashLayout.SixPipes, 6],
    [ConsentHashLayout.FivePipes, 5],
    [ConsentHashLayout.FourPipes, 4],
  ] as const)('consentHashLayout %s changes only the hash', async (layout, pipes) => {
    const reference = await makeProvider().provider.createSubscription({ plan: { ...MONTHLY_PLAN }, customer: CUSTOMER });
    const { provider } = makeProvider([], { consentHashLayout: layout });
    const { checkout } = await provider.createSubscription({ plan: { ...MONTHLY_PLAN }, customer: CUSTOMER });
    if (checkout?.kind !== CheckoutKind.FormPost || reference.checkout?.kind !== CheckoutKind.FormPost) throw new Error('form post');
    const f = checkout.fields as Record<string, string>;
    expect(f.hash).toBe(
      expectedConsentHash(
        { txnid: f.txnid!, amount: f.amount!, productinfo: f.productinfo!, firstname: f.firstname!, email: f.email!, si_details: f.si_details! },
        pipes,
      ),
    );
    expect({ ...f, hash: '' }).toEqual({ ...reference.checkout.fields, hash: '' });
  });

  it('a trial delays paymentStartDate to the first debit and ends the trial then', async () => {
    const { provider } = makeProvider();
    const subscription = await provider.createSubscription({
      plan: { ...MONTHLY_PLAN },
      customer: CUSTOMER,
      trial: { days: 7 },
      totalCycles: 12,
    });
    if (subscription.checkout?.kind !== CheckoutKind.FormPost) throw new Error('form post');
    expect(subscription.trialEndsAt).toBe('2026-11-24T05:00:00.000Z');
    expect(subscription.startAt).toBe('2026-11-24T05:00:00.000Z');
    expect(subscription.totalCycles).toBe(12);
    // First debit 2026-11-24; the twelfth is 2027-10-24; plus seven days of retry grace.
    expect(JSON.parse(subscription.checkout.fields.si_details!)).toMatchObject({
      paymentStartDate: '2026-11-24',
      paymentEndDate: '2027-10-31',
    });
    expect(subscription.checkout.fields.amount).toBe('2.00');
    expect(subscription.checkout.fields.free_trial).toBe('1');
  });

  it('an upfront amount is charged by the consent transaction and sends no free_trial', async () => {
    const { provider } = makeProvider();
    const subscription = await provider.createSubscription({
      plan: { ...MONTHLY_PLAN },
      customer: CUSTOMER,
      upfrontAmount: 19950,
      upfrontLabel: 'Setup fee',
    });
    if (subscription.checkout?.kind !== CheckoutKind.FormPost) throw new Error('form post');
    expect(subscription.checkout.fields.amount).toBe('199.50');
    expect(subscription.checkout.fields).not.toHaveProperty('free_trial');
    expect(subscription.checkout.fields.si).toBe('1');
  });

  it('billingAmount is the per-debit ceiling: maxAmount when given', async () => {
    const { provider } = makeProvider();
    const subscription = await provider.createSubscription({
      plan: { ...MONTHLY_PLAN, maxAmount: 150000 },
      customer: CUSTOMER,
    });
    if (subscription.checkout?.kind !== CheckoutKind.FormPost) throw new Error('form post');
    expect(JSON.parse(subscription.checkout.fields.si_details!).billingAmount).toBe('1500.00');
    expect(subscription.amount).toBe(49900);
    expect(subscription.maxAmount).toBe(150000);
  });

  it.each([
    [{ unit: 'day', count: 3 }, 'DAILY', 3],
    [{ unit: 'week', count: 2 }, 'WEEKLY', 2],
    [{ unit: 'month', count: 3 }, 'MONTHLY', 3],
    [{ unit: 'year', count: 1 }, 'YEARLY', 1],
  ] as const)('interval %j becomes billingCycle %s / billingInterval %i', async (interval, cycle, count) => {
    const { provider } = makeProvider();
    const subscription = await provider.createSubscription({
      plan: { name: 'Plan', amount: 10000, interval },
      customer: CUSTOMER,
    });
    if (subscription.checkout?.kind !== CheckoutKind.FormPost) throw new Error('form post');
    expect(JSON.parse(subscription.checkout.fields.si_details!)).toMatchObject({ billingCycle: cycle, billingInterval: count });
  });

  it('mandateEndsAt becomes paymentEndDate as an IST calendar date', async () => {
    const { provider } = makeProvider();
    const subscription = await provider.createSubscription({
      plan: { ...MONTHLY_PLAN },
      customer: CUSTOMER,
      // 00:30 on 1 April in IST.
      mandateEndsAt: '2027-03-31T19:00:00.000Z',
      totalCycles: 99,
    });
    if (subscription.checkout?.kind !== CheckoutKind.FormPost) throw new Error('form post');
    expect(JSON.parse(subscription.checkout.fields.si_details!).paymentEndDate).toBe('2027-04-01');
    expect(subscription.mandateEndsAt).toBe('2027-03-31T19:00:00.000Z');
  });

  it('a mandate that ends before its first debit is a VALIDATION error', async () => {
    const { provider } = makeProvider();
    const error = await failure(() =>
      provider.createSubscription({
        plan: { ...MONTHLY_PLAN },
        customer: CUSTOMER,
        trial: { days: 30 },
        mandateEndsAt: '2026-11-20T00:00:00.000Z',
      }),
    );
    expect(error.code).toBe(ErrorCode.Validation);
    expect(error.message).toContain('paymentEndDate');
  });

  it('a startAt in the future is the first debit date', async () => {
    const { provider } = makeProvider();
    const subscription = await provider.createSubscription({
      plan: { ...MONTHLY_PLAN },
      customer: CUSTOMER,
      startAt: '2026-12-01T00:00:00.000Z',
    });
    if (subscription.checkout?.kind !== CheckoutKind.FormPost) throw new Error('form post');
    expect(subscription.startAt).toBe('2026-12-01T00:00:00.000Z');
    expect(subscription.trialEndsAt).toBeUndefined();
    expect(JSON.parse(subscription.checkout.fields.si_details!).paymentStartDate).toBe('2026-12-01');
  });

  it('uses the supplied reference as txnid', async () => {
    const { provider } = makeProvider();
    const subscription = await provider.createSubscription({
      reference: 'order_2026-11-17_A',
      plan: { ...MONTHLY_PLAN },
      customer: CUSTOMER,
    });
    expect(subscription.id).toBe('order_2026-11-17_A');
    expect(subscription.reference).toBe('order_2026-11-17_A');
    if (subscription.checkout?.kind !== CheckoutKind.FormPost) throw new Error('form post');
    expect(subscription.checkout.fields.txnid).toBe('order_2026-11-17_A');
  });

  it('return URLs: returnUrl for both, else the config defaults (furl falls back to successUrl)', async () => {
    const own = await makeProvider().provider.createSubscription({
      plan: { ...MONTHLY_PLAN },
      customer: CUSTOMER,
      returnUrl: 'https://shop.example/return',
    });
    if (own.checkout?.kind !== CheckoutKind.FormPost) throw new Error('form post');
    expect(own.checkout.fields).toMatchObject({ surl: 'https://shop.example/return', furl: 'https://shop.example/return' });

    const onlySuccess = await makeProvider([], { failureUrl: undefined }).provider.createSubscription({
      plan: { ...MONTHLY_PLAN },
      customer: CUSTOMER,
    });
    if (onlySuccess.checkout?.kind !== CheckoutKind.FormPost) throw new Error('form post');
    expect(onlySuccess.checkout.fields).toMatchObject({ surl: SUCCESS_URL, furl: SUCCESS_URL });

    const none = makeProvider([], { successUrl: undefined, failureUrl: undefined }).provider;
    const error = await failure(() => none.createSubscription({ plan: { ...MONTHLY_PLAN }, customer: CUSTOMER }));
    expect(error.code).toBe(ErrorCode.Validation);
  });

  it('the live environment posts to secure.payu.in; paymentUrl overrides both', async () => {
    const live = await makeProvider([], { environment: Environment.Live }).provider.createSubscription({
      plan: { ...MONTHLY_PLAN },
      customer: CUSTOMER,
    });
    expect(live.checkout).toMatchObject({ url: 'https://secure.payu.in/_payment' });
    const custom = await makeProvider([], { paymentUrl: 'https://proxy.example/_payment' }).provider.createSubscription({
      plan: { ...MONTHLY_PLAN },
      customer: CUSTOMER,
    });
    expect(custom.checkout).toMatchObject({ url: 'https://proxy.example/_payment' });
  });

  it('cleans text PayU would strip, so the hashed text is what PayU keeps; formats the phone', async () => {
    const { provider } = makeProvider();
    const subscription = await provider.createSubscription({
      plan: { ...MONTHLY_PLAN, name: 'Pro & Plus: monthly (best)!' },
      customer: { name: "Ashish D'Souza", email: 'ashish@example.com', phone: '+919876543210' },
    });
    if (subscription.checkout?.kind !== CheckoutKind.FormPost) throw new Error('form post');
    expect(subscription.checkout.fields).toMatchObject({
      productinfo: 'Pro Plus monthly best',
      firstname: 'Ashish DSouza',
      phone: '9876543210',
    });
    const f = subscription.checkout.fields as Record<string, string>;
    expect(f.hash).toBe(
      expectedConsentHash(
        { txnid: f.txnid!, amount: f.amount!, productinfo: 'Pro Plus monthly best', firstname: 'Ashish DSouza', email: f.email!, si_details: f.si_details! },
        6,
      ),
    );
  });

  it('never exposes the salt: not in the fields, the subscription, or the provider', async () => {
    const { provider } = makeProvider();
    const subscription = await provider.createSubscription({ plan: { ...MONTHLY_PLAN }, customer: CUSTOMER });
    expect(JSON.stringify(subscription)).not.toContain(SALT);
    expect(JSON.stringify(provider)).not.toContain(SALT);
    expect(Object.keys(subscription.checkout && 'fields' in subscription.checkout ? subscription.checkout.fields : {})).not.toContain('salt');
  });
});

describe('createSubscription: rejected input', () => {
  it('a string plan id is VALIDATION and says PayU has no plan API', async () => {
    const error = await failure(() => makeProvider().provider.createSubscription({ plan: 'plan_123', customer: CUSTOMER }));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(error.message).toContain('no plan API');
    expect(error.message).toContain('inline');
  });

  it.each([
    ['name', { email: CUSTOMER.email, phone: CUSTOMER.phone }, 'customer.name'],
    ['email', { name: CUSTOMER.name, phone: CUSTOMER.phone }, 'customer.email'],
    ['phone', { name: CUSTOMER.name, email: CUSTOMER.email }, 'customer.phone'],
  ])('a customer without %s is VALIDATION naming it', async (_field, customer, named) => {
    const error = await failure(() => makeProvider().provider.createSubscription({ plan: { ...MONTHLY_PLAN }, customer }));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(error.message).toContain(named);
  });

  it.each([
    ['a txnid longer than 25 characters', 'x'.repeat(26)],
    ['a txnid with characters outside letters, digits, _ and -', 'order #1'],
  ])('%s is VALIDATION', async (_label, reference) => {
    const error = await failure(() => makeProvider().provider.createSubscription({ reference, plan: { ...MONTHLY_PLAN }, customer: CUSTOMER }));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(error.message).toContain('txnid');
  });

  it('an e-mail with a character PayU strips is VALIDATION, never silently changed', async () => {
    const error = await failure(() =>
      makeProvider().provider.createSubscription({
        plan: { ...MONTHLY_PLAN },
        customer: { ...CUSTOMER, email: 'ashish+shop@example.com' },
      }),
    );
    expect(error.code).toBe(ErrorCode.Validation);
    expect(error.message).toContain('customer.email');
  });

  it('a name with no characters PayU keeps is VALIDATION', async () => {
    const error = await failure(() =>
      makeProvider().provider.createSubscription({ plan: { ...MONTHLY_PLAN }, customer: { ...CUSTOMER, name: 'आशीष' } }),
    );
    expect(error.code).toBe(ErrorCode.Validation);
    expect(error.message).toContain('firstname');
  });

  it('gateway scheduling and quantity are UNSUPPORTED', async () => {
    const { provider } = makeProvider();
    expect((await failure(() => provider.createSubscription({ plan: { ...MONTHLY_PLAN, scheduling: 'gateway' }, customer: CUSTOMER }))).code).toBe(
      ErrorCode.Unsupported,
    );
    expect((await failure(() => provider.createSubscription({ plan: { ...MONTHLY_PLAN }, customer: CUSTOMER, quantity: 2 }))).code).toBe(
      ErrorCode.Unsupported,
    );
  });

  it('shared input rules still apply: trial and startAt together are VALIDATION', async () => {
    const error = await failure(() =>
      makeProvider().provider.createSubscription({
        plan: { ...MONTHLY_PLAN },
        customer: CUSTOMER,
        trial: { days: 3 },
        startAt: '2026-12-01T00:00:00.000Z',
      }),
    );
    expect(error.code).toBe(ErrorCode.Validation);
  });
});
