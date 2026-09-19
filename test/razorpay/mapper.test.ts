import { describe, expect, it } from 'vitest';
import {
  ChargeKind,
  ChargeStatus,
  ErrorCode,
  IntervalUnit,
  PaymentMethod,
  RefundStatus,
  SubscriptionStatus,
} from '../../src/constants.js';
import { ChargeSchema, PlanSchema, RefundSchema, SubscriptionSchema, type ParsedCreatePlanInput } from '../../src/schemas.js';
import {
  RazorpayInvoiceStatus,
  RazorpayNoteKey,
  RazorpayPaymentStatus,
  RazorpayRefundStatus,
  RazorpaySubscriptionStatus,
} from '../../src/providers/razorpay/constants.js';
import {
  INVOICE_STATUS_MAP,
  PAYMENT_STATUS_MAP,
  REFUND_STATUS_MAP,
  SUBSCRIPTION_STATUS_MAP,
  UNKNOWN_CHARGE_STATUS,
  UNKNOWN_SUBSCRIPTION_STATUS,
  buildCheckout,
  buildNotes,
  buildPlanRequest,
  cyclesInYears,
  describeErrorBody,
  mapInvoiceToCharge,
  mapInvoicesToCharges,
  mapPaymentToCharge,
  mapPlan,
  mapRefund,
  mapSubscription,
  mapSubscriptionStatus,
  planToInterval,
  readNotes,
  wholeCyclesBetween,
} from '../../src/providers/razorpay/mapper.js';
import {
  RazorpayErrorBodySchema,
  RazorpayInvoiceCollectionSchema,
  RazorpayInvoiceEntitySchema,
  RazorpayPaymentEntitySchema,
  RazorpayPlanEntitySchema,
  RazorpayRefundEntitySchema,
  RazorpaySubscriptionEntitySchema,
} from '../../src/providers/razorpay/schemas.js';

/*
 * Pure-mapper tests. Fixtures are the verbatim sample payloads from the
 * Razorpay documentation (see the page named above each one). Where the docs
 * have no sample (refund entity, payment entity outside webhooks) the shape
 * follows the official Node SDK types and is built inline and labelled.
 */

/** Verbatim sample, Razorpay docs: api__payments__subscriptions__fetch-subscription-id.md (success sample). */
const FETCH_SUBSCRIPTION_RESPONSE = String.raw`{
  "id": "sub_00000000000001",
  "entity": "subscription",
  "plan_id": "plan_00000000000001",
  "customer_id": "cust_D00000000000001",
  "status": "active",
  "current_start": 1577355871,
  "current_end": 1582655400,
  "ended_at": null,
  "quantity": 1,
  "notes":{
    "notes_key_1": "Tea, Earl Grey, Hot",
    "notes_key_2": "Tea, Earl Grey… decaf."
  },
  "charge_at": 1577385991,
  "start_at": 1577385991,
  "end_at": 1603737000,
  "auth_attempts": 0,
  "total_count": 6,
  "paid_count": 1,
  "customer_notify": true,
  "created_at": 1577356081,
  "expire_by": 1577485991,
  "short_url": "https://rzp.io/i/z3b1R61A9",
  "has_scheduled_changes": false,
  "change_scheduled_at": null,
  "source": "api",
  "offer_id":"offer_JHD834hjbxzhd38d",
  "remaining_count": 5
}`;

/** Verbatim sample, Razorpay docs: api__payments__subscriptions__pause-subscription.md (success sample). */
const PAUSE_RESPONSE = String.raw`{
  "id": "sub_00000000000001",
  "entity": "subscription",
  "plan_id": "plan_00000000000001",
  "status": "paused",
  "current_start": null,
  "current_end": null,
  "ended_at": null,
  "quantity": 1,
  "notes":{
    "notes_key_1":"Tea, Earl Grey, Hot",
    "notes_key_2":"Tea, Earl Grey… decaf."
  },
  "charge_at": null,
  "start_at": 1580626111,
  "end_at": 1583433000,
  "auth_attempts": 0,
  "total_count": 6,
  "paid_count": 0,
  "customer_notify": true,
  "created_at": 1580280581,
  "paused_at": 1590280581,
  "expire_by": 1580626111,
  "pause_initiated_by": "self",
  "short_url": "https://rzp.io/i/z3b1R61A9",
  "has_scheduled_changes": false,
  "change_scheduled_at": null,
  "source": "api",
  "offer_id":"offer_JHD834hjbxzhd38d",
  "remaining_count": 6
}`;

/** Verbatim sample, Razorpay docs: api__payments__subscriptions__create-plan.md (success sample). */
const CREATE_PLAN_RESPONSE = String.raw`{
  "id":"plan_00000000000001",
  "entity":"plan",
  "interval":1,
  "period":"weekly",
  "item":{
    "id":"item_00000000000001",
    "active":true,
    "name":"Test plan - Weekly",
    "description":"Description for the test plan - Weekly",
    "amount":69900,
    "unit_amount":69900,
    "currency":"INR",
    "type":"plan",
    "unit":null,
    "tax_inclusive":false,
    "hsn_code":null,
    "sac_code":null,
    "tax_rate":null,
    "tax_id":null,
    "tax_group_id":null,
    "created_at":1580219935,
    "updated_at":1580219935
  },
  "notes":{
    "notes_key_1":"Tea, Earl Grey, Hot",
    "notes_key_2":"Tea, Earl Grey… decaf."
  },
  "created_at":1580219935
}`;

/** Verbatim sample, Razorpay docs: api__payments__subscriptions__fetch-invoices.md (India sample). */
const INVOICES_RESPONSE = String.raw`{
  "entity": "collection",
  "count": 2,
  "items": [
    {
      "id": "inv_00000000000003",
      "entity": "invoice",
      "receipt": null,
      "invoice_number": null,
      "customer_id": "cust_00000000000001",
      "customer_details": {
        "id": "cust_00000000000001",
        "name": null,
        "email": "<email>",
        "contact": "<phone>",
        "gstin": null,
        "billing_address": null,
        "shipping_address": null,
        "customer_name": null,
        "customer_email": "<email>",
        "customer_contact": "<phone>"
      },
      "order_id": "order_00000000000002",
      "subscription_id": "sub_00000000000001",
      "line_items": [
        {
          "id": "li_00000000000003",
          "item_id": null,
          "ref_id": null,
          "ref_type": null,
          "name": "Monthly Plan",
          "description": null,
          "amount": 99900,
          "unit_amount": 99900,
          "gross_amount": 99900,
          "tax_amount": 0,
          "taxable_amount": 99900,
          "net_amount": 99900,
          "currency": "INR",
          "type": "plan",
          "tax_inclusive": false,
          "hsn_code": null,
          "sac_code": null,
          "tax_rate": null,
          "unit": null,
          "quantity": 1,
          "taxes": []
        }
      ],
      "payment_id": "pay_00000000000002",
      "status": "paid",
      "expire_by": null,
      "issued_at": 1593344888,
      "paid_at": 1593344889,
      "cancelled_at": null,
      "expired_at": null,
      "sms_status": null,
      "email_status": null,
      "date": 1593344888,
      "terms": null,
      "partial_payment": false,
      "gross_amount": 99900,
      "tax_amount": 0,
      "taxable_amount": 99900,
      "amount": 99900,
      "amount_paid": 99900,
      "amount_due": 0,
      "currency": "INR",
      "currency_symbol": "₹",
      "description": null,
      "notes": [],
      "comment": null,
      "short_url": "https://rzp.io/i/Ys4feGqEp",
      "view_less": true,
      "billing_start": 1594405800,
      "billing_end": 1597084200,
      "type": "invoice",
      "group_taxes_discounts": false,
      "created_at": 1593344888,
      "idempotency_key": null
    },
    {
      "id": "inv_00000000000001",
      "entity": "invoice",
      "receipt": null,
      "invoice_number": null,
      "customer_id": "cust_00000000000001",
      "customer_details": {
        "id": "cust_00000000000001",
        "name": null,
        "email": "<email>",
        "contact": "<phone>",
        "gstin": null,
        "billing_address": null,
        "shipping_address": null,
        "customer_name": null,
        "customer_email": "<email>",
        "customer_contact": "<phone>"
      },
      "order_id": "order_00000000000001",
      "subscription_id": "sub_00000000000001",
      "line_items": [
        {
          "id": "li_00000000000001",
          "item_id": null,
          "ref_id": null,
          "ref_type": null,
          "name": "Monthly Plan",
          "description": null,
          "amount": 99900,
          "unit_amount": 99900,
          "gross_amount": 99900,
          "tax_amount": 0,
          "taxable_amount": 99900,
          "net_amount": 99900,
          "currency": "INR",
          "type": "plan",
          "tax_inclusive": false,
          "hsn_code": null,
          "sac_code": null,
          "tax_rate": null,
          "unit": null,
          "quantity": 1,
          "taxes": []
        },
        {
          "id": "li_00000000000002",
          "item_id": null,
          "ref_id": null,
          "ref_type": null,
          "name": "Delivery charges",
          "description": null,
          "amount": 30000,
          "unit_amount": 30000,
          "gross_amount": 30000,
          "tax_amount": 0,
          "taxable_amount": 30000,
          "net_amount": 30000,
          "currency": "INR",
          "type": "addon",
          "tax_inclusive": false,
          "hsn_code": null,
          "sac_code": null,
          "tax_rate": null,
          "unit": null,
          "quantity": 1,
          "taxes": []
        }
      ],
      "payment_id": "pay_00000000000001",
      "status": "paid",
      "expire_by": null,
      "issued_at": 1591878130,
      "paid_at": 1591878210,
      "cancelled_at": null,
      "expired_at": null,
      "sms_status": null,
      "email_status": null,
      "date": 1591878130,
      "terms": null,
      "partial_payment": false,
      "gross_amount": 129900,
      "tax_amount": 0,
      "taxable_amount": 129900,
      "amount": 129900,
      "amount_paid": 129900,
      "amount_due": 0,
      "currency": "INR",
      "currency_symbol": "₹",
      "description": null,
      "notes": [],
      "comment": null,
      "short_url": "https://rzp.io/i/nt5k3df",
      "view_less": true,
      "billing_start": 1591878205,
      "billing_end": 1594405800,
      "type": "invoice",
      "group_taxes_discounts": false,
      "created_at": 1591878130,
      "idempotency_key": null
    }
  ]
}`;

/** Verbatim sample, Razorpay docs: api__payments__subscriptions__cancel-subscription.md (failure sample). */
const CANCEL_EXPIRED_ERROR = String.raw`{
  "error": {
    "code": "BAD_REQUEST_ERROR",
    "description": "Subscription is not cancellable in expired status.",
    "field": "status"
  }
}`;

/** Verbatim sample, Razorpay docs: api__payments__subscriptions__fetch-all-plans.md (failure sample). */
const API_KEY_ERROR = String.raw`{
  "error": {
    "code": "BAD_REQUEST_ERROR",
    "description": "The api key provided is invalid",
    "source": "NA",
    "step": "NA",
    "reason": "NA",
    "metadata": {}
  }
}`;

/** Verbatim sample, Razorpay docs: payments__subscriptions__integration-guide.md (failure response object). */
const CHECKOUT_FAILURE_ERROR = String.raw`{
"code": "BAD_REQUEST_ERROR",
"description": "Payment failed. Please contact the site admin",
"source": "business",
"step": "payment_initiation",
"reason": "amount_less_than_minimum_amount",
"metadata":{
},
"field": "amount"
}`;


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const subscriptionBase = () => RazorpaySubscriptionEntitySchema.parse(JSON.parse(FETCH_SUBSCRIPTION_RESPONSE));
const withStatus = (status: string, extra: Record<string, unknown> = {}) =>
  RazorpaySubscriptionEntitySchema.parse({ ...JSON.parse(FETCH_SUBSCRIPTION_RESPONSE), status, ...extra });
const iso = (unix: number) => new Date(unix * 1000).toISOString();

const paymentEntity = (extra: Record<string, unknown>) =>
  RazorpayPaymentEntitySchema.parse({
    id: 'pay_DEXFWroJ6LikKT',
    entity: 'payment',
    amount: 100000,
    currency: 'INR',
    status: 'captured',
    invoice_id: 'inv_DEXFWVuM6rPqlK',
    method: 'card',
    created_at: 1567690382,
    ...extra,
  });

const invoiceEntity = (extra: Record<string, unknown>) =>
  RazorpayInvoiceEntitySchema.parse({ id: 'inv_x1', status: 'paid', amount: 99900, currency: 'INR', ...extra });

// ---------------------------------------------------------------------------
// Subscription status table
// ---------------------------------------------------------------------------

describe('subscription status mapping', () => {
  const expected: Record<RazorpaySubscriptionStatus, SubscriptionStatus> = {
    created: SubscriptionStatus.Created,
    authenticated: SubscriptionStatus.Trialing,
    active: SubscriptionStatus.Active,
    pending: SubscriptionStatus.PastDue,
    halted: SubscriptionStatus.Halted,
    paused: SubscriptionStatus.Paused,
    cancelled: SubscriptionStatus.Cancelled,
    completed: SubscriptionStatus.Completed,
    expired: SubscriptionStatus.Expired,
  };

  it('has an entry for every status constant, including paused (missing from the documented enum)', () => {
    expect(Object.keys(SUBSCRIPTION_STATUS_MAP).sort()).toEqual(Object.values(RazorpaySubscriptionStatus).sort());
    expect(Object.values(RazorpaySubscriptionStatus)).toHaveLength(9);
  });

  it.each(Object.entries(expected))('maps %s to %s and keeps the verbatim status', (razorpayStatus, unified) => {
    const mapped = mapSubscription(withStatus(razorpayStatus));
    expect(mapped.status).toBe(unified);
    expect(mapped.providerStatus).toBe(razorpayStatus);
    expect(SubscriptionSchema.safeParse(mapped).success).toBe(true);
  });

  it('degrades an unknown status to created without losing it', () => {
    const mapped = mapSubscription(withStatus('suspended_by_regulator'));
    expect(mapped.status).toBe(SubscriptionStatus.Created);
    expect(mapped.providerStatus).toBe('suspended_by_regulator');
    expect(UNKNOWN_SUBSCRIPTION_STATUS).toBe(SubscriptionStatus.Created);
  });

  it('does not treat Object.prototype keys as statuses', () => {
    expect(mapSubscriptionStatus('constructor')).toBe(UNKNOWN_SUBSCRIPTION_STATUS);
    expect(mapSubscriptionStatus('__proto__')).toBe(UNKNOWN_SUBSCRIPTION_STATUS);
  });
});

describe('mapSubscription', () => {
  it('maps the fetch-subscription sample: timestamps, counts, ids, quantity', () => {
    const mapped = mapSubscription(subscriptionBase());
    expect(mapped).toMatchObject({
      provider: 'razorpay',
      id: 'sub_00000000000001',
      planId: 'plan_00000000000001',
      status: 'active',
      providerStatus: 'active',
      scheduling: 'gateway',
      customer: { id: 'cust_D00000000000001' },
      quantity: 1,
      totalCycles: 6,
      paidCycles: 1,
      remainingCycles: 5,
      createdAt: iso(1577356081),
      startAt: iso(1577385991),
      currentPeriodStart: iso(1577355871),
      currentPeriodEnd: iso(1582655400),
      nextChargeAt: iso(1577385991),
      // end_at is read as the scheduled end of the last cycle.
      mandateEndsAt: iso(1603737000),
      metadata: { notes_key_1: 'Tea, Earl Grey, Hot', notes_key_2: 'Tea, Earl Grey… decaf.' },
    });
    expect(mapped.endedAt).toBeUndefined();
    expect(mapped.trialEndsAt).toBeUndefined();
    expect(mapped.cancelAtPeriodEnd).toBeUndefined();
    expect(mapped.raw).toMatchObject({ id: 'sub_00000000000001', short_url: 'https://rzp.io/i/z3b1R61A9' });
  });

  it('sets trialEndsAt from charge_at for authenticated, falling back to start_at', () => {
    const authenticated = mapSubscription(withStatus('authenticated', { charge_at: 1593109800, start_at: 1593109801 }));
    expect(authenticated.status).toBe(SubscriptionStatus.Trialing);
    expect(authenticated.trialEndsAt).toBe(iso(1593109800));
    const noCharge = mapSubscription(withStatus('authenticated', { charge_at: null, start_at: 1593109801 }));
    expect(noCharge.trialEndsAt).toBe(iso(1593109801));
    const neither = mapSubscription(withStatus('authenticated', { charge_at: null, start_at: null }));
    expect(neither.trialEndsAt).toBeUndefined();
  });

  it('reads paused fields: charge_at null leaves nextChargeAt unset', () => {
    const mapped = mapSubscription(RazorpaySubscriptionEntitySchema.parse(JSON.parse(PAUSE_RESPONSE)));
    expect(mapped.status).toBe(SubscriptionStatus.Paused);
    expect(mapped.nextChargeAt).toBeUndefined();
    expect(mapped.currentPeriodStart).toBeUndefined();
  });

  it('accepts remaining_count as a string (SDK type) and a number (API)', () => {
    expect(mapSubscription(withStatus('active', { remaining_count: '5' })).remainingCycles).toBe(5);
    expect(mapSubscription(withStatus('active', { remaining_count: 5 })).remainingCycles).toBe(5);
    expect(mapSubscription(withStatus('active', { remaining_count: 'five' })).remainingCycles).toBeUndefined();
  });

  it('accepts customer_notify as boolean, 0/1 or a string without failing', () => {
    for (const flag of [true, false, 1, 0, '1', '0']) {
      expect(RazorpaySubscriptionEntitySchema.safeParse({ ...JSON.parse(FETCH_SUBSCRIPTION_RESPONSE), customer_notify: flag }).success).toBe(true);
    }
  });

  it('treats empty notes ([]) as no metadata, and hides the adapter-reserved keys', () => {
    expect(mapSubscription(withStatus('active', { notes: [] })).metadata).toBeUndefined();
    const mapped = mapSubscription(
      withStatus('active', { notes: { [RazorpayNoteKey.Reference]: 'order-17', color: 'red', count: 3 } }),
    );
    expect(mapped.reference).toBe('order-17');
    expect(mapped.metadata).toEqual({ color: 'red', count: '3' });
  });

  it('maps the payment method case-insensitively and leaves unknown ones unset', () => {
    expect(mapSubscription(withStatus('active', { payment_method: 'card' })).paymentMethod).toBe(PaymentMethod.Card);
    expect(mapSubscription(withStatus('active', { payment_method: 'UPI' })).paymentMethod).toBe(PaymentMethod.Upi);
    expect(mapSubscription(withStatus('active', { payment_method: 'emandate' })).paymentMethod).toBe(PaymentMethod.ENach);
    expect(mapSubscription(withStatus('active', { payment_method: 'nach' })).paymentMethod).toBe(PaymentMethod.PhysicalNach);
    expect(mapSubscription(withStatus('active', { payment_method: 'wallet' })).paymentMethod).toBeUndefined();
    expect(mapSubscription(withStatus('active', { payment_method: null })).paymentMethod).toBeUndefined();
  });

  it('keeps well-formed customer parts and drops malformed ones', () => {
    const mapped = mapSubscription(
      withStatus('active', { customer_email: 'gaurav.kumar@example.com', customer_contact: '+919876543210' }),
    );
    expect(mapped.customer).toEqual({ id: 'cust_D00000000000001', email: 'gaurav.kumar@example.com', phone: '+919876543210' });
    const bad = mapSubscription(withStatus('active', { customer_email: 'not-an-email', customer_contact: 'call me' }));
    expect(bad.customer).toEqual({ id: 'cust_D00000000000001' });
  });

  it('computes amount from the plan and quantity when the plan is known, in integer paise', () => {
    const plan = { amount: 69900, interval: { unit: IntervalUnit.Month, count: 1 } };
    const mapped = mapSubscription(withStatus('active', { quantity: 5 }), { plan });
    expect(mapped.amount).toBe(349500);
    expect(mapped.currency).toBe('INR');
    expect(mapped.interval).toEqual({ unit: 'month', count: 1 });
    expect(mapSubscription(subscriptionBase()).amount).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

describe('plan mapping', () => {
  const plan = (extra: Record<string, unknown> = {}) =>
    RazorpayPlanEntitySchema.parse({ ...JSON.parse(CREATE_PLAN_RESPONSE), ...extra });

  it('maps the create-plan sample', () => {
    const mapped = mapPlan(plan());
    expect(mapped).toMatchObject({
      provider: 'razorpay',
      id: 'plan_00000000000001',
      name: 'Test plan - Weekly',
      description: 'Description for the test plan - Weekly',
      amount: 69900,
      currency: 'INR',
      interval: { unit: 'week', count: 1 },
      scheduling: 'gateway',
      createdAt: iso(1580219935),
    });
    expect(PlanSchema.safeParse(mapped).success).toBe(true);
  });

  it.each([
    ['daily', 7, { unit: 'day', count: 7 }],
    ['weekly', 2, { unit: 'week', count: 2 }],
    ['monthly', 1, { unit: 'month', count: 1 }],
    ['monthly', 3, { unit: 'month', count: 3 }],
    ['quarterly', 1, { unit: 'month', count: 3 }],
    ['quarterly', 2, { unit: 'month', count: 6 }],
    ['yearly', 1, { unit: 'year', count: 1 }],
  ])('reads period %s x %i as %j', (period, interval, expected) => {
    expect(planToInterval(period, interval)).toEqual(expected);
  });

  it('leaves the interval unset for a period it does not know', () => {
    expect(planToInterval('fortnightly', 1)).toBeUndefined();
    expect(mapPlan(plan({ period: 'fortnightly' })).interval).toBeUndefined();
  });

  it('reads the unit_amount when amount is absent, and refuses a payload with neither', () => {
    const base = JSON.parse(CREATE_PLAN_RESPONSE);
    const noAmount = plan({ item: { ...base.item, amount: undefined } });
    expect(mapPlan(noAmount).amount).toBe(69900);
    const neither = plan({ item: { ...base.item, amount: undefined, unit_amount: undefined } });
    expect(() => mapPlan(neither)).toThrowError(expect.objectContaining({ code: ErrorCode.UnexpectedResponse }));
  });

  it('refuses a plan that is not an exact number of paise', () => {
    const base = JSON.parse(CREATE_PLAN_RESPONSE);
    expect(() => mapPlan(plan({ item: { ...base.item, amount: 699.5 } }))).toThrowError(
      expect.objectContaining({ code: ErrorCode.UnexpectedResponse }),
    );
  });

  it('is UNSUPPORTED for a plan in another currency', () => {
    const base = JSON.parse(CREATE_PLAN_RESPONSE);
    expect(() => mapPlan(plan({ item: { ...base.item, currency: 'USD' } }))).toThrowError(
      expect.objectContaining({ code: ErrorCode.Unsupported }),
    );
  });

  it('reads maxCycles back from the notes and hides reserved keys from metadata', () => {
    const mapped = mapPlan(
      plan({ notes: { [RazorpayNoteKey.PlanMaxCycles]: '24', [RazorpayNoteKey.RequestedPlanId]: 'gold', tier: 'x' } }),
    );
    expect(mapped.maxCycles).toBe(24);
    expect(mapped.metadata).toEqual({ tier: 'x' });
  });
});

describe('buildPlanRequest', () => {
  const input = (extra: Partial<ParsedCreatePlanInput> = {}): ParsedCreatePlanInput => ({
    name: 'Gold',
    amount: 49900,
    currency: 'INR',
    interval: { unit: IntervalUnit.Month, count: 1 },
    ...extra,
  });

  it('sends a quarterly schedule as monthly x 3, not as the quarterly period', () => {
    expect(buildPlanRequest(input({ interval: { unit: IntervalUnit.Month, count: 3 } }))).toMatchObject({
      period: 'monthly',
      interval: 3,
    });
  });

  it('enforces the daily minimum of 7 and states the limit', () => {
    expect(() => buildPlanRequest(input({ interval: { unit: IntervalUnit.Day, count: 6 } }))).toThrowError(
      expect.objectContaining({ code: ErrorCode.Validation, message: expect.stringContaining('at least 7 days') }),
    );
    expect(buildPlanRequest(input({ interval: { unit: IntervalUnit.Day, count: 7 } }))).toMatchObject({ period: 'daily', interval: 7 });
  });

  it('refuses metadata that uses a reserved key or pushes notes past 15', () => {
    expect(() => buildPlanRequest(input({ metadata: { [RazorpayNoteKey.Reference]: 'x' } }))).toThrowError(
      expect.objectContaining({ code: ErrorCode.Validation }),
    );
    const many = Object.fromEntries(Array.from({ length: 15 }, (_, index) => [`k${index}`, 'v']));
    expect(buildPlanRequest(input({ metadata: many })).notes).toHaveProperty('k14');
    // 15 caller keys leave no room for the plan id the adapter records.
    expect(() => buildPlanRequest(input({ metadata: many, id: 'gold' }))).toThrowError(
      expect.objectContaining({ code: ErrorCode.Validation, message: expect.stringContaining('15') }),
    );
  });

  it('records the requested id and maxCycles in notes, and sends neither id nor maxAmount as fields', () => {
    const request = buildPlanRequest(input({ id: 'gold-monthly', maxCycles: 12, maxAmount: 99900 }));
    expect(request.notes).toEqual({
      [RazorpayNoteKey.RequestedPlanId]: 'gold-monthly',
      [RazorpayNoteKey.PlanMaxCycles]: '12',
    });
    expect(Object.keys(request).sort()).toEqual(['interval', 'item', 'notes', 'period']);
  });
});

// ---------------------------------------------------------------------------
// Whole-cycle arithmetic
// ---------------------------------------------------------------------------

describe('wholeCyclesBetween', () => {
  const month = { unit: IntervalUnit.Month, count: 1 } as const;

  it('anchors month steps on the first charge day (31 Jan, 28 Feb, 31 Mar)', () => {
    const anchor = new Date('2026-01-31T00:00:00+05:30');
    expect(wholeCyclesBetween(anchor, new Date('2026-03-31T00:00:00+05:30'), month)).toBe(2);
    expect(wholeCyclesBetween(anchor, new Date('2026-03-30T23:59:59+05:30'), month)).toBe(1);
    expect(wholeCyclesBetween(anchor, new Date('2026-02-28T00:00:00+05:30'), month)).toBe(1);
  });

  it('counts exactly zero before the first full cycle and when the end precedes the anchor', () => {
    const anchor = new Date('2026-01-01T00:00:00+05:30');
    expect(wholeCyclesBetween(anchor, new Date('2026-01-31T23:59:59+05:30'), month)).toBe(0);
    expect(wholeCyclesBetween(anchor, anchor, month)).toBe(0);
    expect(wholeCyclesBetween(anchor, new Date('2025-12-01T00:00:00+05:30'), month)).toBe(0);
  });

  it('handles day, week and year units', () => {
    const anchor = new Date('2026-01-01T00:00:00Z');
    const day7 = { unit: IntervalUnit.Day, count: 7 } as const;
    expect(wholeCyclesBetween(anchor, new Date('2026-01-29T00:00:00Z'), day7)).toBe(4);
    expect(wholeCyclesBetween(anchor, new Date('2026-01-28T23:59:59Z'), day7)).toBe(3);
    const week2 = { unit: IntervalUnit.Week, count: 2 } as const;
    expect(wholeCyclesBetween(anchor, new Date('2026-01-29T00:00:00Z'), week2)).toBe(2);
    const leapAnchor = new Date('2024-02-29T00:00:00+05:30');
    const year = { unit: IntervalUnit.Year, count: 1 } as const;
    expect(wholeCyclesBetween(leapAnchor, new Date('2025-02-27T23:59:59+05:30'), year)).toBe(0);
    expect(wholeCyclesBetween(leapAnchor, new Date('2025-02-28T00:00:00+05:30'), year)).toBe(1);
  });

  it('is exact over a long horizon', () => {
    const anchor = new Date('2026-01-01T00:00:00Z');
    expect(wholeCyclesBetween(anchor, new Date(anchor.getTime() + 36_500 * 86_400_000), { unit: IntervalUnit.Day, count: 1 })).toBe(36_500);
  });

  it('cyclesInYears counts whole cycles in N years', () => {
    const anchor = new Date('2026-01-01T00:00:00Z');
    expect(cyclesInYears(anchor, 10, month)).toBe(120);
    expect(cyclesInYears(anchor, 10, { unit: IntervalUnit.Year, count: 1 })).toBe(10);
    expect(cyclesInYears(anchor, 10, { unit: IntervalUnit.Year, count: 3 })).toBe(3);
    expect(cyclesInYears(anchor, 10, { unit: IntervalUnit.Year, count: 11 })).toBe(0);
    // 10 years from 2026-01-01 span 3652 days (leap days in 2028 and 2032).
    expect(cyclesInYears(anchor, 10, { unit: IntervalUnit.Day, count: 7 })).toBe(Math.floor(3652 / 7));
    expect(cyclesInYears(anchor, 10, { unit: IntervalUnit.Week, count: 1 })).toBe(Math.floor(3652 / 7));
  });
});

// ---------------------------------------------------------------------------
// Charges
// ---------------------------------------------------------------------------

describe('invoice -> charge', () => {
  const collection = () => RazorpayInvoiceCollectionSchema.parse(JSON.parse(INVOICES_RESPONSE));

  it('maps both sample invoices; id is the payment id, reference the invoice id', () => {
    const [newer, older] = mapInvoicesToCharges(collection().items, { subscriptionId: 'sub_00000000000001', complete: true });
    expect(older).toMatchObject({
      provider: 'razorpay',
      id: 'pay_00000000000001',
      reference: 'inv_00000000000001',
      subscriptionId: 'sub_00000000000001',
      kind: ChargeKind.Recurring,
      status: ChargeStatus.Succeeded,
      providerStatus: 'paid',
      // The invoice total: 99900 plan + 30000 add-on.
      amount: 129900,
      currency: 'INR',
      cycle: 1,
      scheduledAt: iso(1591878130),
      paidAt: iso(1591878210),
    });
    expect(newer).toMatchObject({
      id: 'pay_00000000000002',
      reference: 'inv_00000000000003',
      amount: 99900,
      cycle: 2,
      paidAt: iso(1593344889),
    });
    expect(ChargeSchema.safeParse(older).success).toBe(true);
  });

  it('numbers cycles by billing period, not by list order, and only for a complete list', () => {
    const items = collection().items;
    const shuffled = [items[1]!, items[0]!];
    const partial = mapInvoicesToCharges(items, { subscriptionId: 's', complete: false });
    expect(partial.every((charge) => charge.cycle === undefined)).toBe(true);
    const complete = mapInvoicesToCharges(shuffled, { subscriptionId: 's', complete: true });
    expect(complete.map((charge) => [charge.reference, charge.cycle])).toEqual([
      ['inv_00000000000001', 1],
      ['inv_00000000000003', 2],
    ]);
  });

  it('falls back to the invoice id when there is no payment yet', () => {
    const charge = mapInvoiceToCharge(invoiceEntity({ status: 'issued', payment_id: null, issued_at: 1593344888, paid_at: null }));
    expect(charge).toMatchObject({ id: 'inv_x1', reference: 'inv_x1', status: ChargeStatus.Pending, providerStatus: 'issued' });
    expect(charge.paidAt).toBeUndefined();
  });

  it('marks an invoice that only holds an add-on as an upfront charge with no cycle', () => {
    const charge = mapInvoiceToCharge(invoiceEntity({ line_items: [{ type: 'addon', amount: 30000 }] }), { cycle: 1 });
    expect(charge.kind).toBe(ChargeKind.Upfront);
    expect(charge.cycle).toBeUndefined();
  });

  it.each([
    ['draft', ChargeStatus.Scheduled],
    ['issued', ChargeStatus.Pending],
    ['partially_paid', ChargeStatus.Pending],
    ['paid', ChargeStatus.Succeeded],
    ['cancelled', ChargeStatus.Cancelled],
    ['deleted', ChargeStatus.Cancelled],
    ['expired', ChargeStatus.Failed],
  ])('maps invoice status %s to %s', (status, expected) => {
    expect(mapInvoiceToCharge(invoiceEntity({ status })).status).toBe(expected);
  });

  it('never reports an unknown invoice status as a success, and keeps it verbatim', () => {
    const charge = mapInvoiceToCharge(invoiceEntity({ status: 'reversed' }));
    expect(charge.status).toBe(ChargeStatus.Pending);
    expect(charge.providerStatus).toBe('reversed');
    expect(UNKNOWN_CHARGE_STATUS).toBe(ChargeStatus.Pending);
  });

  it('covers every documented invoice status constant', () => {
    expect(Object.keys(INVOICE_STATUS_MAP).sort()).toEqual(Object.values(RazorpayInvoiceStatus).sort());
  });

  it('refuses a fractional or negative invoice amount', () => {
    expect(() => mapInvoiceToCharge(invoiceEntity({ amount: 99900.5 }))).toThrowError(
      expect.objectContaining({ code: ErrorCode.UnexpectedResponse }),
    );
    expect(() => mapInvoiceToCharge(invoiceEntity({ amount: -1 }))).toThrowError(
      expect.objectContaining({ code: ErrorCode.UnexpectedResponse }),
    );
  });
});

describe('payment -> charge', () => {
  it('covers every payment status constant', () => {
    expect(Object.keys(PAYMENT_STATUS_MAP).sort()).toEqual(Object.values(RazorpayPaymentStatus).sort());
  });

  it.each([
    ['created', ChargeStatus.Pending],
    ['authorized', ChargeStatus.Pending],
    ['captured', ChargeStatus.Succeeded],
    ['refunded', ChargeStatus.Refunded],
    ['failed', ChargeStatus.Failed],
  ])('maps payment status %s to %s', (status, expected) => {
    expect(mapPaymentToCharge(paymentEntity({ status })).status).toBe(expected);
  });

  it('keeps an unknown payment status verbatim and pending', () => {
    const charge = mapPaymentToCharge(paymentEntity({ status: 'chargeback' }));
    expect(charge.status).toBe(ChargeStatus.Pending);
    expect(charge.providerStatus).toBe('chargeback');
  });

  it('reads captured with refunds as partially refunded or refunded', () => {
    const partial = mapPaymentToCharge(paymentEntity({ amount_refunded: 25000, refund_status: 'partial' }));
    expect(partial).toMatchObject({ status: ChargeStatus.PartiallyRefunded, refundedAmount: 25000, amount: 100000 });
    const full = mapPaymentToCharge(paymentEntity({ amount_refunded: 100000, refund_status: 'full' }));
    expect(full.status).toBe(ChargeStatus.Refunded);
    const byAmount = mapPaymentToCharge(paymentEntity({ amount_refunded: 100000, refund_status: null }));
    expect(byAmount.status).toBe(ChargeStatus.Refunded);
    const none = mapPaymentToCharge(paymentEntity({ amount_refunded: 0, refund_status: null }));
    expect(none).toMatchObject({ status: ChargeStatus.Succeeded, refundedAmount: 0 });
  });

  it('reads a failed payment: code and reason', () => {
    const charge = mapPaymentToCharge(
      paymentEntity({ status: 'failed', error_code: 'BAD_REQUEST_ERROR', error_description: 'Payment processing failed because of incorrect OTP.' }),
    );
    expect(charge).toMatchObject({
      status: ChargeStatus.Failed,
      failureCode: 'BAD_REQUEST_ERROR',
      failureReason: 'Payment processing failed because of incorrect OTP.',
    });
    expect(charge.paidAt).toBeUndefined();
  });

  it('calls a payment with an invoice recurring and one without the authorisation payment', () => {
    expect(mapPaymentToCharge(paymentEntity({})).kind).toBe(ChargeKind.Recurring);
    expect(mapPaymentToCharge(paymentEntity({ invoice_id: null })).kind).toBe(ChargeKind.Authorization);
  });

  it('maps method, amount in paise, currency and the invoice reference', () => {
    const charge = mapPaymentToCharge(paymentEntity({ method: 'upi' }), { subscriptionId: 'sub_1' });
    expect(charge).toMatchObject({
      id: 'pay_DEXFWroJ6LikKT',
      reference: 'inv_DEXFWVuM6rPqlK',
      subscriptionId: 'sub_1',
      amount: 100000,
      currency: 'INR',
      paymentMethod: PaymentMethod.Upi,
      paidAt: iso(1567690382),
    });
    expect(ChargeSchema.safeParse(charge).success).toBe(true);
  });

  it('accepts captured as the string "1", as webhooks send it', () => {
    expect(RazorpayPaymentEntitySchema.safeParse({ id: 'pay_1', amount: 1, status: 'captured', captured: '1' }).success).toBe(true);
  });
});

describe('refund mapping', () => {
  const refund = (extra: Record<string, unknown>) =>
    RazorpayRefundEntitySchema.parse({
      id: 'rfnd_FP8QHiV938haTz',
      entity: 'refund',
      amount: 5000,
      currency: 'INR',
      payment_id: 'pay_29QQoUBi66xm2f',
      receipt: 'refund-1',
      status: 'processed',
      created_at: 1600000000,
      ...extra,
    });

  it.each([
    ['pending', RefundStatus.Pending],
    ['processed', RefundStatus.Succeeded],
    ['failed', RefundStatus.Failed],
  ])('maps refund status %s to %s', (status, expected) => {
    expect(mapRefund(refund({ status }), { chargeId: 'pay_29QQoUBi66xm2f' }).status).toBe(expected);
  });

  it('covers every refund status constant and degrades an unknown one to pending', () => {
    expect(Object.keys(REFUND_STATUS_MAP).sort()).toEqual(Object.values(RazorpayRefundStatus).sort());
    const mapped = mapRefund(refund({ status: 'reversed' }), { chargeId: 'pay_1' });
    expect(mapped.status).toBe(RefundStatus.Pending);
    expect(mapped.providerStatus).toBe('reversed');
  });

  it('maps ids, amount, reference and creation time', () => {
    const mapped = mapRefund(refund({}), { chargeId: 'pay_fallback' });
    expect(mapped).toMatchObject({
      provider: 'razorpay',
      id: 'rfnd_FP8QHiV938haTz',
      reference: 'refund-1',
      chargeId: 'pay_29QQoUBi66xm2f',
      amount: 5000,
      currency: 'INR',
      createdAt: iso(1600000000),
    });
    expect(RefundSchema.safeParse(mapped).success).toBe(true);
  });
});

describe('error body', () => {
  it('uses the description, code as providerCode, and field/reason when they carry information', () => {
    const body = RazorpayErrorBodySchema.parse(JSON.parse(CANCEL_EXPIRED_ERROR));
    expect(describeErrorBody(body)).toEqual({
      message: 'Subscription is not cancellable in expired status. (field: status)',
      providerCode: 'BAD_REQUEST_ERROR',
    });
    const checkout = RazorpayErrorBodySchema.parse({ error: JSON.parse(CHECKOUT_FAILURE_ERROR) });
    expect(describeErrorBody(checkout).message).toBe(
      'Payment failed. Please contact the site admin (field: amount, reason: amount_less_than_minimum_amount)',
    );
  });

  it('ignores the literal "NA" that Razorpay writes into unfilled fields', () => {
    const body = RazorpayErrorBodySchema.parse(JSON.parse(API_KEY_ERROR));
    expect(describeErrorBody(body)).toEqual({ message: 'The api key provided is invalid', providerCode: 'BAD_REQUEST_ERROR' });
  });
});

describe('notes helpers', () => {
  it('buildNotes returns undefined when there is nothing to send', () => {
    expect(buildNotes(undefined, {})).toBeUndefined();
    expect(buildNotes({}, { [RazorpayNoteKey.Reference]: undefined })).toBeUndefined();
  });

  it('readNotes tolerates arrays, numbers and junk', () => {
    expect(readNotes([])).toEqual({});
    expect(readNotes(null)).toEqual({});
    expect(readNotes({ a: 'x', b: 2, c: { nested: true }, d: null })).toEqual({ a: 'x', b: '2' });
  });
});

describe('buildCheckout', () => {
  it('returns the Razorpay checkout instruction with prefill but without the gateway customer id', () => {
    const checkout = buildCheckout({
      keyId: 'key_1',
      subscriptionId: 'sub_1',
      shortUrl: 'https://rzp.io/rzp/Dqdqx3h',
      callbackUrl: 'https://shop.example.com/return',
      customer: { id: 'cust_1', name: 'Asha', email: 'asha@example.com', phone: '9876543210' },
    });
    expect(checkout).toEqual({
      kind: 'razorpay_checkout',
      keyId: 'key_1',
      subscriptionId: 'sub_1',
      hostedUrl: 'https://rzp.io/rzp/Dqdqx3h',
      callbackUrl: 'https://shop.example.com/return',
      prefill: { name: 'Asha', email: 'asha@example.com', phone: '9876543210' },
    });
  });

  it('omits hostedUrl when short_url is null or malformed and prefill when there is no customer detail', () => {
    const checkout = buildCheckout({ keyId: 'k', subscriptionId: 's', shortUrl: null, customer: {} });
    expect(checkout.kind).toBe('razorpay_checkout');
    expect(checkout).toMatchObject({ hostedUrl: undefined, prefill: undefined });
    expect(buildCheckout({ keyId: 'k', subscriptionId: 's', shortUrl: 'not a url' })).toMatchObject({ hostedUrl: undefined });
  });
});
