import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CheckoutKind, Currency, Environment, IntervalUnit, PaymentMethod, SchedulingMode } from '../../src/constants.js';
import * as schemas from '../../src/schemas.js';
import {
  CheckoutInstructionSchema,
  CreatePlanInputSchema,
  CreateSubscriptionInputSchema,
  IsoDateTimeSchema,
  PaiseSchema,
  PositivePaiseSchema,
  UpdateSubscriptionInputSchema,
} from '../../src/schemas.js';

const minimal = {
  plan: 'plan_123',
  customer: { email: 'asha@example.com' },
};

const withPlan = (plan: Record<string, unknown>) => ({ ...minimal, plan });

function issuePaths(result: z.ZodSafeParseResult<unknown>): string[] {
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

describe('exported schemas are exportable to JSON Schema / OpenAPI', () => {
  const entries = Object.entries(schemas).filter(([, value]) => value instanceof z.ZodType) as Array<[string, z.ZodType]>;

  it('finds a meaningful number of schemas to check', () => {
    expect(entries.length).toBeGreaterThan(40);
    expect(entries.map(([name]) => name)).toEqual(expect.arrayContaining(['CreateSubscriptionInputSchema', 'CheckoutInstructionSchema', 'SubscriptionEventSchema']));
  });

  it('every export named *Schema is a Zod schema', () => {
    const notSchemas = Object.entries(schemas)
      .filter(([name]) => name.endsWith('Schema'))
      .filter(([, value]) => !(value instanceof z.ZodType))
      .map(([name]) => name);
    expect(notSchemas).toEqual([]);
  });

  it.each(entries)('%s converts with z.toJSONSchema (output)', (_name, schema) => {
    const json = z.toJSONSchema(schema);
    expect(typeof json).toBe('object');
    expect(json).not.toBeNull();
  });

  it.each(entries)('%s converts with z.toJSONSchema (input side, for request bodies)', (_name, schema) => {
    expect(() => z.toJSONSchema(schema, { io: 'input' })).not.toThrow();
  });

  it('the generated schema for a create-subscription request requires plan and customer', () => {
    const json = z.toJSONSchema(CreateSubscriptionInputSchema, { io: 'input' }) as { required?: string[]; properties?: Record<string, unknown> };
    expect(json.required).toEqual(expect.arrayContaining(['plan', 'customer']));
    expect(Object.keys(json.properties ?? {})).toEqual(expect.arrayContaining(['trial', 'startAt', 'upfrontAmount']));
  });
});

describe('primitives', () => {
  it('PaiseSchema: non-negative integers only', () => {
    expect(PaiseSchema.safeParse(0).success).toBe(true);
    expect(PaiseSchema.safeParse(49900).success).toBe(true);
    for (const bad of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, '5', null, Number.MAX_SAFE_INTEGER + 1]) {
      expect(PaiseSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('PositivePaiseSchema rejects zero', () => {
    expect(PositivePaiseSchema.safeParse(1).success).toBe(true);
    expect(PositivePaiseSchema.safeParse(0).success).toBe(false);
  });

  it('IsoDateTimeSchema needs a time and an offset (or Z)', () => {
    for (const good of ['2026-11-17T10:30:00+05:30', '2026-11-17T05:00:00Z', '2026-11-17T05:00:00.123Z', '2026-11-17T05:00:00-08:00']) {
      expect(IsoDateTimeSchema.safeParse(good).success, good).toBe(true);
    }
    for (const bad of ['2026-11-17', '2026-11-17T10:30:00', '17/11/2026', 'tomorrow', '2026-02-30T00:00:00Z', '2026-11-17T25:00:00Z', '', 1763355000, null]) {
      expect(IsoDateTimeSchema.safeParse(bad).success, String(bad)).toBe(false);
    }
  });
});

describe('CreateSubscriptionInputSchema', () => {
  it('accepts a minimal valid input', () => {
    const result = CreateSubscriptionInputSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  it('accepts a plan given inline and applies the INR default through the union', () => {
    const result = CreateSubscriptionInputSchema.safeParse({
      ...minimal,
      plan: { name: 'Pro', amount: 49900, interval: { unit: IntervalUnit.Month, count: 1 } },
    });
    expect(result.success).toBe(true);
    if (result.success && typeof result.data.plan === 'object') expect(result.data.plan.currency).toBe(Currency.INR);
  });

  it('accepts a fully populated input', () => {
    const result = CreateSubscriptionInputSchema.safeParse({
      reference: 'order-1',
      plan: 'plan_123',
      customer: { id: 'cust_1', name: 'Asha', email: 'asha@example.com', phone: '+919876543210' },
      quantity: 2,
      totalCycles: 12,
      trial: { days: 7 },
      upfrontAmount: 9900,
      upfrontLabel: 'Setup fee',
      paymentMethods: [PaymentMethod.Upi, PaymentMethod.Card],
      authorizeBy: '2026-12-01T00:00:00Z',
      mandateEndsAt: '2027-12-01T00:00:00+05:30',
      returnUrl: 'https://shop.example.com/return',
      notifyCustomer: true,
      metadata: { orderId: '42' },
      idempotencyKey: 'idem-1',
    });
    expect(result.success).toBe(true);
  });

  it('accepts startAt alone and trial alone', () => {
    expect(CreateSubscriptionInputSchema.safeParse({ ...minimal, startAt: '2026-12-01T00:00:00Z' }).success).toBe(true);
    expect(CreateSubscriptionInputSchema.safeParse({ ...minimal, trial: { days: 14 } }).success).toBe(true);
    expect(CreateSubscriptionInputSchema.safeParse({ ...minimal, trial: { endsAt: '2026-12-01T00:00:00Z' } }).success).toBe(true);
  });

  it('rejects trial together with startAt', () => {
    expect(CreateSubscriptionInputSchema.safeParse({ ...minimal, trial: { days: 7 }, startAt: '2026-12-01T00:00:00Z' }).success).toBe(false);
    expect(
      CreateSubscriptionInputSchema.safeParse({ ...minimal, trial: { endsAt: '2026-12-01T00:00:00Z' }, startAt: '2026-12-02T00:00:00Z' }).success,
    ).toBe(false);
  });

  it('rejects a trial with both days and endsAt, or with neither', () => {
    const both = CreateSubscriptionInputSchema.safeParse({ ...minimal, trial: { days: 7, endsAt: '2026-12-01T00:00:00Z' } });
    const neither = CreateSubscriptionInputSchema.safeParse({ ...minimal, trial: {} });
    expect(both.success).toBe(false);
    expect(neither.success).toBe(false);
    expect(issuePaths(both)).toContain('trial');
    expect(JSON.stringify(neither)).toContain('exactly one of days or endsAt');
  });

  it.each([0, -1, 1.5])('rejects trial.days %s', (days) => {
    expect(CreateSubscriptionInputSchema.safeParse({ ...minimal, trial: { days } }).success).toBe(false);
  });

  it.each([
    ['zero upfrontAmount', { upfrontAmount: 0 }],
    ['fractional upfrontAmount', { upfrontAmount: 99.5 }],
    ['negative upfrontAmount', { upfrontAmount: -1 }],
    ['zero quantity', { quantity: 0 }],
    ['fractional quantity', { quantity: 1.5 }],
    ['zero totalCycles', { totalCycles: 0 }],
    ['empty paymentMethods', { paymentMethods: [] }],
    ['unknown payment method', { paymentMethods: ['cheque'] }],
    ['non-URL returnUrl', { returnUrl: 'not a url' }],
    ['relative returnUrl', { returnUrl: '/return' }],
    ['date-only startAt', { startAt: '2026-12-01' }],
    ['offset-less authorizeBy', { authorizeBy: '2026-12-01T00:00:00' }],
    ['non-ISO mandateEndsAt', { mandateEndsAt: '1 Dec 2026' }],
    ['non-string metadata value', { metadata: { a: 1 } }],
    ['empty reference', { reference: '' }],
    ['overlong reference', { reference: 'x'.repeat(61) }],
    ['empty idempotencyKey', { idempotencyKey: '' }],
  ])('rejects %s', (_label, patch) => {
    expect(CreateSubscriptionInputSchema.safeParse({ ...minimal, ...patch }).success).toBe(false);
  });

  it.each([
    ['missing plan', { customer: minimal.customer }],
    ['missing customer', { plan: 'plan_1' }],
    ['empty plan id', { plan: '', customer: minimal.customer }],
    ['non-object', 'x'],
    ['null', null],
  ])('rejects %s', (_label, input) => {
    expect(CreateSubscriptionInputSchema.safeParse(input).success).toBe(false);
  });

  it.each(['plainaddress', 'a@', '@b.co', 'a b@c.co', 'a@b', ''])('rejects customer email %j', (email) => {
    const result = CreateSubscriptionInputSchema.safeParse({ ...minimal, customer: { email } });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('customer.email');
  });

  it.each(['9876543210', '+919876543210', '919876543210'])('accepts customer phone %s', (phone) => {
    expect(CreateSubscriptionInputSchema.safeParse({ ...minimal, customer: { phone } }).success).toBe(true);
  });

  it.each(['98765', '98765-43210', '+91 98765 43210', 'abcdefghij', '', '+9198765432101234567', '(987)6543210'])(
    'rejects customer phone %j',
    (phone) => {
      const result = CreateSubscriptionInputSchema.safeParse({ ...minimal, customer: { phone } });
      expect(result.success).toBe(false);
      expect(issuePaths(result)).toContain('customer.phone');
    },
  );

  it('rejects a non-integer or zero amount on an inline plan, reporting the path', () => {
    for (const amount of [0, 499.5, -100, Number.NaN]) {
      const result = CreateSubscriptionInputSchema.safeParse(withPlan({ name: 'Pro', amount, interval: { unit: 'month', count: 1 } }));
      expect(result.success, String(amount)).toBe(false);
    }
  });

  it('strips unknown keys rather than passing them through', () => {
    const result = CreateSubscriptionInputSchema.safeParse({ ...minimal, surprise: 1 });
    expect(result.success).toBe(true);
    if (result.success) expect('surprise' in result.data).toBe(false);
  });
});

describe('CreatePlanInputSchema', () => {
  const base = { name: 'Pro', amount: 49900, interval: { unit: IntervalUnit.Month, count: 1 } };

  it('defaults currency to INR', () => {
    const result = CreatePlanInputSchema.parse(base);
    expect(result.currency).toBe(Currency.INR);
  });

  it('accepts an explicit INR and all optional fields', () => {
    const result = CreatePlanInputSchema.safeParse({
      ...base,
      id: 'pro_monthly',
      description: 'Pro plan',
      currency: Currency.INR,
      scheduling: SchedulingMode.Merchant,
      maxAmount: 100000,
      maxCycles: 12,
      metadata: { tier: 'pro' },
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ['unsupported currency', { currency: 'USD' }],
    ['zero amount', { amount: 0 }],
    ['fractional amount (499.5 is rupees, not paise)', { amount: 499.5 }],
    ['negative amount', { amount: -1 }],
    ['string amount', { amount: '49900' }],
    ['zero maxAmount', { maxAmount: 0 }],
    ['fractional maxAmount', { maxAmount: 10.5 }],
    ['zero maxCycles', { maxCycles: 0 }],
    ['empty name', { name: '' }],
    ['overlong name', { name: 'x'.repeat(101) }],
    ['overlong id', { id: 'x'.repeat(41) }],
    ['interval count 0', { interval: { unit: 'month', count: 0 } }],
    ['interval count 1.5', { interval: { unit: 'month', count: 1.5 } }],
    ['unknown interval unit', { interval: { unit: 'fortnight', count: 1 } }],
    ['unknown scheduling', { scheduling: 'whenever' }],
    ['missing interval', { interval: undefined }],
  ])('rejects %s', (_label, patch) => {
    expect(CreatePlanInputSchema.safeParse({ ...base, ...patch }).success).toBe(false);
  });

  // DEFECT (src/schemas.ts, CreatePlanInputSchema): maxAmount is documented as "the ceiling the
  // mandate allows per debit ... Set it higher to leave room", yet nothing checks
  // maxAmount >= amount. { amount: 50000, maxAmount: 100 } validates, and would create a mandate
  // under which every recurring debit exceeds its own ceiling and fails at the bank.
  it('rejects a maxAmount lower than the plan amount', () => {
    expect(CreatePlanInputSchema.safeParse({ ...base, amount: 50000, maxAmount: 100 }).success).toBe(false);
  });

  it('accepts maxAmount equal to or above amount', () => {
    expect(CreatePlanInputSchema.safeParse({ ...base, amount: 50000, maxAmount: 50000 }).success).toBe(true);
    expect(CreatePlanInputSchema.safeParse({ ...base, amount: 50000, maxAmount: 90000 }).success).toBe(true);
  });
});

describe('UpdateSubscriptionInputSchema', () => {
  it('rejects an empty update', () => {
    const result = UpdateSubscriptionInputSchema.safeParse({});
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain('Nothing to update');
  });

  it('rejects an update that only sets options (timing / notifyCustomer)', () => {
    expect(UpdateSubscriptionInputSchema.safeParse({ timing: 'at_period_end' }).success).toBe(false);
    expect(UpdateSubscriptionInputSchema.safeParse({ notifyCustomer: true }).success).toBe(false);
  });

  it('rejects an update where every field is explicitly undefined', () => {
    expect(UpdateSubscriptionInputSchema.safeParse({ planId: undefined, quantity: undefined }).success).toBe(false);
  });

  it.each([
    { planId: 'plan_2' },
    { quantity: 3 },
    { remainingCycles: 5 },
    { amount: 59900 },
    { nextChargeAt: '2026-12-01T00:00:00Z' },
    { mandateEndsAt: '2027-12-01T00:00:00Z' },
  ])('accepts a single change %j and defaults timing to immediately', (patch) => {
    const result = UpdateSubscriptionInputSchema.safeParse(patch);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.timing).toBe('immediately');
  });

  it.each([
    { quantity: 0 },
    { quantity: 1.5 },
    { amount: 0 },
    { amount: 99.5 },
    { remainingCycles: 0 },
    { planId: '' },
    { nextChargeAt: '2026-12-01' },
    { timing: 'later', quantity: 1 },
  ])('rejects invalid value %j', (patch) => {
    expect(UpdateSubscriptionInputSchema.safeParse(patch).success).toBe(false);
  });
});

describe('CheckoutInstructionSchema', () => {
  const examples = {
    [CheckoutKind.Redirect]: { kind: CheckoutKind.Redirect, url: 'https://pay.example.com/auth/1' },
    [CheckoutKind.FormPost]: { kind: CheckoutKind.FormPost, url: 'https://secure.example.com/_payment', fields: { key: 'k', hash: 'h' } },
    [CheckoutKind.RazorpayCheckout]: { kind: CheckoutKind.RazorpayCheckout, keyId: 'rzp_test_1', subscriptionId: 'sub_1' },
    [CheckoutKind.CashfreeCheckout]: { kind: CheckoutKind.CashfreeCheckout, sessionId: 'session_1', environment: Environment.Test },
  };

  it.each(Object.entries(examples))('accepts %s', (_kind, value) => {
    const result = CheckoutInstructionSchema.safeParse(value);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(value);
  });

  it('covers every CheckoutKind constant', () => {
    expect(Object.keys(examples).sort()).toEqual(Object.values(CheckoutKind).sort());
  });

  it('accepts the optional Razorpay hostedUrl but rejects a malformed one', () => {
    expect(CheckoutInstructionSchema.safeParse({ ...examples[CheckoutKind.RazorpayCheckout], hostedUrl: 'https://rzp.io/i/abc' }).success).toBe(true);
    expect(CheckoutInstructionSchema.safeParse({ ...examples[CheckoutKind.RazorpayCheckout], hostedUrl: 'rzp.io' }).success).toBe(false);
  });

  it('rejects an unknown or missing discriminator', () => {
    expect(CheckoutInstructionSchema.safeParse({ kind: 'carrier_pigeon', url: 'https://x.test' }).success).toBe(false);
    expect(CheckoutInstructionSchema.safeParse({ url: 'https://x.test' }).success).toBe(false);
    expect(CheckoutInstructionSchema.safeParse(null).success).toBe(false);
  });

  it.each([
    ['redirect without url', { kind: CheckoutKind.Redirect }],
    ['redirect with a bad url', { kind: CheckoutKind.Redirect, url: 'nope' }],
    ['form_post without fields', { kind: CheckoutKind.FormPost, url: 'https://x.test' }],
    ['form_post with a non-string field', { kind: CheckoutKind.FormPost, url: 'https://x.test', fields: { a: 1 } }],
    ['razorpay_checkout without subscriptionId', { kind: CheckoutKind.RazorpayCheckout, keyId: 'k' }],
    ['cashfree_checkout with an unknown environment', { kind: CheckoutKind.CashfreeCheckout, sessionId: 's', environment: 'staging' }],
    ['cashfree_checkout without sessionId', { kind: CheckoutKind.CashfreeCheckout, environment: Environment.Live }],
  ])('rejects %s', (_label, value) => {
    expect(CheckoutInstructionSchema.safeParse(value).success).toBe(false);
  });

  it('does not let one kind borrow another kind\'s fields', () => {
    const result = CheckoutInstructionSchema.safeParse({ kind: CheckoutKind.Redirect, url: 'https://x.test', fields: { a: 'b' } });
    expect(result.success).toBe(true);
    if (result.success) expect('fields' in result.data).toBe(false);
  });
});
