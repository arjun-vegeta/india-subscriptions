import { describe, expect, it } from 'vitest';
import {
  ChargeKind,
  ChargeStatus,
  CheckoutKind,
  Environment,
  ErrorCode,
  IntervalUnit,
  PaymentMethod,
  RefundStatus,
  SchedulingMode,
  SubscriptionStatus,
} from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import {
  CASHFREE_TO_INTERVAL_UNIT,
  CashfreeAuthorizationStatus,
  CashfreeIntervalType,
  CashfreePaymentStatus,
  CashfreePaymentType,
  CashfreeRefundStatus,
  CashfreeSubscriptionStatus,
  METHOD_TO_PAYMENT_METHOD,
  PAYMENT_STATUS_MAP,
  PAYMENT_TYPE_MAP,
  REFUND_STATUS_MAP,
  SUBSCRIPTION_STATUS_MAP,
} from '../../src/providers/cashfree/constants.js';
import {
  checkoutOf,
  mapCharge,
  mapPaymentMethod,
  mapPaymentStatus,
  mapPlan,
  mapRefund,
  mapRefundStatus,
  mapSubscription,
  mapSubscriptionStatus,
  parseCashfreeTime,
  schedulingOfPlanType,
} from '../../src/providers/cashfree/mapper.js';
import {
  CashfreePaymentSchema,
  CashfreePlanSchema,
  CashfreeRefundSchema,
  CashfreeSubscriptionSchema,
} from '../../src/providers/cashfree/schemas.js';

const NOW = new Date('2026-11-17T05:00:00.000Z');

describe('status tables', () => {
  it.each([
    ['INITIALIZED', SubscriptionStatus.Created],
    ['BANK_APPROVAL_PENDING', SubscriptionStatus.PendingAuthorization],
    ['ACTIVE', SubscriptionStatus.Active],
    ['ON_HOLD', SubscriptionStatus.Halted],
    ['PAUSED', SubscriptionStatus.Paused],
    ['CUSTOMER_PAUSED', SubscriptionStatus.Paused],
    ['COMPLETED', SubscriptionStatus.Completed],
    ['CANCELLED', SubscriptionStatus.Cancelled],
    ['CUSTOMER_CANCELLED', SubscriptionStatus.Cancelled],
    ['EXPIRED', SubscriptionStatus.Expired],
    ['LINK_EXPIRED', SubscriptionStatus.Expired],
    ['CARD_EXPIRED', SubscriptionStatus.Expired],
  ])('subscription_status %s', (status, expected) => {
    expect(mapSubscriptionStatus(status)).toBe(expected);
  });

  it('covers every documented subscription status, and the table has nothing else', () => {
    expect(Object.keys(SUBSCRIPTION_STATUS_MAP).sort()).toEqual(Object.values(CashfreeSubscriptionStatus).sort());
  });

  it('matches case-insensitively (the FAQ spells card_expired in lower case) and ignores padding', () => {
    expect(mapSubscriptionStatus('card_expired')).toBe(SubscriptionStatus.Expired);
    expect(mapSubscriptionStatus(' Active ')).toBe(SubscriptionStatus.Active);
  });

  it('falls back to the non-charging Created for a status it does not know, including prototype keys', () => {
    for (const status of ['ACTION_REQUIRED', '', 'constructor', '__proto__', 'toString']) {
      expect(mapSubscriptionStatus(status)).toBe(SubscriptionStatus.Created);
    }
  });

  it.each([
    ['INITIALIZED', ChargeStatus.Scheduled],
    ['PENDING', ChargeStatus.Pending],
    ['SUCCESS', ChargeStatus.Succeeded],
    ['FAILED', ChargeStatus.Failed],
    ['CANCELLED', ChargeStatus.Cancelled],
    ['USER_DROPPED', ChargeStatus.Pending],
    ['NEW_STATE', ChargeStatus.Pending],
  ])('payment_status %s', (status, expected) => {
    expect(mapPaymentStatus(status)).toBe(expected);
  });

  it('covers every documented payment status', () => {
    expect(Object.keys(PAYMENT_STATUS_MAP).sort()).toEqual(Object.values(CashfreePaymentStatus).sort());
  });

  it.each([
    ['INITIALIZED', RefundStatus.Pending],
    ['PENDING', RefundStatus.Pending],
    ['SUCCESS', RefundStatus.Succeeded],
    ['FAILED', RefundStatus.Failed],
    ['CANCEL', RefundStatus.Failed],
    ['CANCELLED', RefundStatus.Failed],
    ['ACTIVE', RefundStatus.Pending],
  ])('refund_status %s', (status, expected) => {
    expect(mapRefundStatus(status)).toBe(expected);
  });

  it('covers every documented refund status', () => {
    expect(Object.keys(REFUND_STATUS_MAP).sort()).toEqual(Object.values(CashfreeRefundStatus).sort());
  });

  it('maps payment_type', () => {
    expect(PAYMENT_TYPE_MAP[CashfreePaymentType.Auth]).toBe(ChargeKind.Authorization);
    expect(PAYMENT_TYPE_MAP[CashfreePaymentType.Charge]).toBe(ChargeKind.Recurring);
  });

  it.each([
    ['upi', PaymentMethod.Upi],
    ['UPI', PaymentMethod.Upi],
    ['card', PaymentMethod.Card],
    ['debit_card', PaymentMethod.Card],
    ['DEBIT_CARD', PaymentMethod.Card],
    ['credit_card', PaymentMethod.Card],
    ['enach', PaymentMethod.ENach],
    ['pnach', PaymentMethod.PhysicalNach],
    ['wallet', undefined],
    ['', undefined],
    [null, undefined],
    ['constructor', undefined],
  ])('payment method %s', (method, expected) => {
    expect(mapPaymentMethod(method)).toBe(expected);
  });

  it('knows every method key and interval type', () => {
    expect(Object.keys(METHOD_TO_PAYMENT_METHOD)).toHaveLength(6);
    expect(Object.values(CashfreeIntervalType).map((type) => CASHFREE_TO_INTERVAL_UNIT[type])).toEqual([
      IntervalUnit.Day,
      IntervalUnit.Week,
      IntervalUnit.Month,
      IntervalUnit.Year,
    ]);
    expect(Object.values(CashfreeAuthorizationStatus)).toContain('ACTIVE');
  });

  it('derives the scheduling mode from the plan type', () => {
    expect(schedulingOfPlanType('ON_DEMAND')).toBe(SchedulingMode.Merchant);
    expect(schedulingOfPlanType('on_demand')).toBe(SchedulingMode.Merchant);
    expect(schedulingOfPlanType('PERIODIC')).toBe(SchedulingMode.Gateway);
    expect(schedulingOfPlanType(null)).toBe(SchedulingMode.Gateway);
    expect(schedulingOfPlanType(undefined)).toBe(SchedulingMode.Gateway);
  });
});

describe('parseCashfreeTime', () => {
  it.each([
    // Forms that appear in Cashfree's own samples ([openapi], [guide:webhooks]); no offset means IST.
    ['2025-06-01T23:47:52+05:30', '2025-06-01T18:17:52.000Z'],
    ['2025-06-01T16:45:00', '2025-06-01T11:15:00.000Z'],
    ['2025-06-01T22:14:58+0530', '2025-06-01T16:44:58.000Z'],
    ['2024-07-20', '2024-07-19T18:30:00.000Z'],
    ['2025-06-01T10:20:12Z', '2025-06-01T10:20:12.000Z'],
    ['2025-06-01T10:20:12.250Z', '2025-06-01T10:20:12.250Z'],
    ['  2025-06-01T16:45:00  ', '2025-06-01T11:15:00.000Z'],
  ])('%s', (input, expected) => {
    expect(parseCashfreeTime(input)?.toISOString()).toBe(expected);
  });

  it.each([[''], ['   '], [null], [undefined], [12345], ['not a date'], ['2025-02-30']])('treats %j as no date', (input) => {
    expect(parseCashfreeTime(input)).toBeUndefined();
  });
});

describe('mapSubscription', () => {
  const entity = (overrides: Record<string, unknown> = {}) =>
    CashfreeSubscriptionSchema.parse({
      subscription_id: 'sub_1',
      subscription_status: 'ACTIVE',
      plan_details: {
        plan_id: 'plan_1',
        plan_type: 'PERIODIC',
        plan_recurring_amount: 199,
        plan_max_amount: 199,
        plan_intervals: 1,
        plan_interval_type: 'MONTH',
        plan_max_cycles: 12,
        plan_currency: 'INR',
      },
      subscription_first_charge_time: '2026-11-20T00:00:00',
      ...overrides,
    });

  it('is Trialing until the first charge time, and exactly at it is Active', () => {
    const before = mapSubscription(entity(), { now: NOW });
    expect(before).toMatchObject({
      status: SubscriptionStatus.Trialing,
      trialEndsAt: '2026-11-19T18:30:00.000Z',
      startAt: '2026-11-19T18:30:00.000Z',
      amount: 19900,
      totalCycles: 12,
      interval: { unit: IntervalUnit.Month, count: 1 },
    });
    const atFirstCharge = mapSubscription(entity(), { now: new Date('2026-11-19T18:30:00.000Z') });
    expect(atFirstCharge.status).toBe(SubscriptionStatus.Active);
    expect(atFirstCharge.trialEndsAt).toBeUndefined();
  });

  it('is never Trialing for a non-ACTIVE status or an ON_DEMAND plan', () => {
    expect(mapSubscription(entity({ subscription_status: 'PAUSED' }), { now: NOW }).status).toBe(SubscriptionStatus.Paused);
    const onDemand = mapSubscription(
      entity({ plan_details: { plan_id: 'p', plan_type: 'ON_DEMAND', plan_max_amount: 500, plan_recurring_amount: 0 } }),
      { now: NOW },
    );
    expect(onDemand.status).toBe(SubscriptionStatus.Active);
    expect(onDemand.amount).toBeUndefined();
  });

  it('defaults plan_intervals to 1 and ignores unknown interval types', () => {
    const noCount = mapSubscription(
      entity({ plan_details: { plan_type: 'PERIODIC', plan_interval_type: 'WEEK', plan_intervals: 0 } }),
      { now: NOW },
    );
    expect(noCount.interval).toEqual({ unit: IntervalUnit.Week, count: 1 });
    const unknown = mapSubscription(entity({ plan_details: { plan_type: 'PERIODIC', plan_interval_type: 'FORTNIGHT' } }), { now: NOW });
    expect(unknown.interval).toBeUndefined();
  });

  it('prefers `authorization_details` and falls back to `authorisation_details`', () => {
    const both = mapSubscription(
      entity({
        authorization_details: { payment_group: 'upi' },
        authorisation_details: { payment_group: 'enach' },
      }),
      { now: NOW },
    );
    expect(both.paymentMethod).toBe(PaymentMethod.Upi);
  });

  it('reads the method from the first key of an object payment_method, else from payment_group', () => {
    const fromObject = mapSubscription(entity({ authorization_details: { payment_method: { card: { card_number: 'XXXXXXXXXXXX2123' } } } }), { now: NOW });
    expect(fromObject.paymentMethod).toBe(PaymentMethod.Card);
    const fromGroup = mapSubscription(entity({ authorization_details: { payment_method: null, payment_group: 'debit_card' } }), { now: NOW });
    expect(fromGroup.paymentMethod).toBe(PaymentMethod.Card);
  });

  it('keeps only string tags as metadata', () => {
    const subscription = mapSubscription(entity({ subscription_tags: { a: 'x', b: 2, c: null } }), { now: NOW });
    expect(subscription.metadata).toEqual({ a: 'x' });
    expect(mapSubscription(entity({ subscription_tags: {} }), { now: NOW }).metadata).toBeUndefined();
  });

  it('puts the raw entity in raw and never invents fields', () => {
    const subscription = mapSubscription(entity(), { now: NOW });
    expect(subscription.raw).toMatchObject({ subscription_id: 'sub_1' });
    expect(subscription.createdAt).toBeUndefined();
    expect(subscription.paidCycles).toBeUndefined();
    expect(subscription.remainingCycles).toBeUndefined();
  });

  it('applies overrides for merchant-scheduled data Cashfree does not hold', () => {
    const subscription = mapSubscription(
      entity({ plan_details: { plan_type: 'ON_DEMAND', plan_max_amount: 500 }, subscription_first_charge_time: null }),
      {
        now: NOW,
        overrides: { amount: 49900, interval: { unit: IntervalUnit.Month, count: 3 }, totalCycles: 4, startAt: NOW },
      },
    );
    expect(subscription).toMatchObject({
      amount: 49900,
      interval: { unit: IntervalUnit.Month, count: 3 },
      totalCycles: 4,
      startAt: NOW.toISOString(),
    });
  });

  it('builds checkout only when a session id is present', () => {
    expect(checkoutOf({ subscription_session_id: 'sess' }, Environment.Live)).toEqual({
      kind: CheckoutKind.CashfreeCheckout,
      sessionId: 'sess',
      environment: Environment.Live,
    });
    expect(checkoutOf({ subscription_session_id: '' }, Environment.Live)).toBeUndefined();
    expect(checkoutOf({}, Environment.Live)).toBeUndefined();
  });
});

describe('mapPlan', () => {
  it('maps a PERIODIC plan', () => {
    const plan = mapPlan(
      CashfreePlanSchema.parse({
        plan_id: 'p',
        plan_name: 'N',
        plan_type: 'PERIODIC',
        plan_recurring_amount: 499.5,
        plan_max_amount: '1000.00',
        plan_intervals: 3,
        plan_interval_type: 'MONTH',
        plan_max_cycles: 0,
        plan_currency: 'INR',
      }),
    );
    expect(plan).toMatchObject({
      amount: 49950,
      maxAmount: 100000,
      interval: { unit: IntervalUnit.Month, count: 3 },
      scheduling: SchedulingMode.Gateway,
      currency: 'INR',
    });
    expect(plan.maxCycles).toBeUndefined();
  });

  it('rejects an amount that is not a rupee amount', () => {
    expect(CashfreePlanSchema.safeParse({ plan_id: 'p', plan_max_amount: 'lots' }).success).toBe(false);
    expect(CashfreePlanSchema.safeParse({ plan_id: 'p', plan_max_amount: -5 }).success).toBe(false);
  });
});

describe('mapCharge', () => {
  const payment = (overrides: Record<string, unknown> = {}) =>
    CashfreePaymentSchema.parse({
      payment_id: 'pay_1',
      payment_status: 'SUCCESS',
      payment_amount: 19.99,
      payment_type: 'CHARGE',
      subscription_id: 'sub_1',
      ...overrides,
    });

  it('converts rupees to exact paise', () => {
    expect(mapCharge(payment()).amount).toBe(1999);
    expect(mapCharge(payment({ payment_amount: 1998.9999999999998 })).amount).toBe(199900);
    expect(mapCharge(payment({ payment_amount: '0.10' })).amount).toBe(10);
    expect(mapCharge(payment({ payment_amount: 0 })).amount).toBe(0);
  });

  it('classifies AUTH by whether Cashfree keeps the authorisation amount', () => {
    const base = { payment_type: 'AUTH', payment_amount: 1 };
    expect(mapCharge(payment({ ...base, authorization_details: { authorization_amount_refund: true } })).kind).toBe(ChargeKind.Authorization);
    expect(mapCharge(payment({ ...base, authorization_details: { authorization_amount_refund: false } })).kind).toBe(ChargeKind.Upfront);
    expect(mapCharge(payment({ ...base, authorization_details: { authorizationAmountRefund: false } })).kind).toBe(ChargeKind.Upfront);
    // eNACH authorises for 0: nothing is kept.
    expect(mapCharge(payment({ ...base, payment_amount: 0, authorization_details: { authorization_amount_refund: false } })).kind).toBe(ChargeKind.Authorization);
    // Unknown whether it is refunded: the safe reading is the verification debit.
    expect(mapCharge(payment(base)).kind).toBe(ChargeKind.Authorization);
  });

  it('treats an unknown payment_type as an ordinary debit', () => {
    expect(mapCharge(payment({ payment_type: 'DEBIT_CARD' })).kind).toBe(ChargeKind.Recurring);
    expect(mapCharge(payment({ payment_type: null })).kind).toBe(ChargeKind.Recurring);
  });

  it('reports paidAt only for a succeeded payment', () => {
    const paidAt = new Date('2026-11-17T01:00:00.000Z');
    expect(mapCharge(payment(), { paidAt }).paidAt).toBe('2026-11-17T01:00:00.000Z');
    expect(mapCharge(payment({ payment_status: 'FAILED' }), { paidAt }).paidAt).toBeUndefined();
  });

  it('reads the failure reason from both spellings, and from a plain string', () => {
    expect(mapCharge(payment({ failure_details: { failure_reason: 'A' } })).failureReason).toBe('A');
    expect(mapCharge(payment({ failureDetails: { failureReason: 'B' } })).failureReason).toBe('B');
    expect(mapCharge(payment({ failure_details: 'C' })).failureReason).toBe('C');
    expect(mapCharge(payment({ failure_details: { failure_reason: '' } })).failureReason).toBeUndefined();
  });

  it('reads the payment method from the create-charge field when there is no authorisation block', () => {
    expect(mapCharge(payment({ payment_method: 'upi' })).paymentMethod).toBe(PaymentMethod.Upi);
    expect(mapCharge(payment({ payment_method: { enach: {} } })).paymentMethod).toBe(PaymentMethod.ENach);
  });

  it('accepts a numeric cf_payment_id and a missing subscription id (falls back to the caller\'s)', () => {
    const charge = mapCharge(payment({ cf_payment_id: 123, subscription_id: null }), { subscriptionId: 'sub_fallback' });
    expect(charge.subscriptionId).toBe('sub_fallback');
  });
});

describe('mapRefund', () => {
  it('maps a refund and uses fallbacks for omitted ids and amounts', () => {
    const refund = mapRefund(CashfreeRefundSchema.parse({ refund_id: 'r1', refund_status: 'SUCCESS' }), {
      chargeId: 'c1',
      subscriptionId: 's1',
      amountPaise: 500,
    });
    expect(refund).toMatchObject({ id: 'r1', chargeId: 'c1', subscriptionId: 's1', amount: 500, status: RefundStatus.Succeeded });
  });

  it('fails loudly when the refund has no payment id or amount anywhere', () => {
    const parsed = CashfreeRefundSchema.parse({ refund_id: 'r1', refund_status: 'SUCCESS' });
    for (const options of [{ amountPaise: 1 }, { chargeId: 'c' }]) {
      let error: unknown;
      try {
        mapRefund(parsed, options);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(SubscriptionError);
      expect((error as SubscriptionError).code).toBe(ErrorCode.UnexpectedResponse);
    }
  });
});
