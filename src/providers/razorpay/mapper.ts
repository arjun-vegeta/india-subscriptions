/**
 * Pure translation between Razorpay payloads and the gateway-neutral model.
 * No I/O, no clock: everything here is deterministic and unit-testable.
 */
import {
  ChargeKind,
  ChargeStatus,
  Currency,
  CheckoutKind,
  ErrorCode,
  EventType,
  IntervalUnit,
  PaymentMethod,
  PaymentStatus,
  Provider,
  RefundStatus,
  SchedulingMode,
  SubscriptionStatus,
  TERMINAL_SUBSCRIPTION_STATUSES,
} from '../../constants.js';
import { SubscriptionError, invalid, parseResponse, unsupported } from '../../errors.js';
import type {
  BillingInterval,
  Charge,
  CheckoutInstruction,
  Customer,
  Metadata,
  ParsedCreatePaymentInput,
  ParsedCreatePlanInput,
  Payment,
  Plan,
  Refund,
  Subscription,
  SubscriptionEvent,
} from '../../schemas.js';
import { CustomerSchema } from '../../schemas.js';
import { assertInterval, cycleStart, unixToIso } from '../../time.js';
import {
  RAZORPAY_MAX_NOTES,
  RAZORPAY_MAX_RECEIPT_CHARS,
  RAZORPAY_MIN_DAILY_INTERVAL,
  RAZORPAY_NOT_APPLICABLE,
  RAZORPAY_RECEIPT_PATTERN,
  RAZORPAY_RESERVED_NOTE_KEYS,
  RazorpayLineItemType,
  RazorpayNoteKey,
  RazorpayOrderStatus,
  RazorpayOneTimeMethodName,
  RazorpayPaymentMethodName,
  RazorpayPaymentRefundStatus,
  RazorpayPaymentStatus,
  RazorpayPaymentWebhookEvent,
  RazorpayPlanPeriod,
  RazorpayInvoiceStatus,
  RazorpayRefundStatus,
  RazorpayRefundWebhookEvent,
  RazorpaySubscriptionStatus,
  RazorpayWebhookEvent,
} from './constants.js';
import {
  RazorpayOrderEntitySchema,
  RazorpayPaymentEntitySchema,
  RazorpayRefundEntitySchema,
  RazorpaySubscriptionEntitySchema,
  type RazorpayCreateOrderRequest,
  type RazorpayCreatePlanRequest,
  type RazorpayErrorBodySchema,
  type RazorpayInvoiceEntity,
  type RazorpayOrderEntity,
  type RazorpayPaymentEntity,
  type RazorpayPlanEntity,
  type RazorpayRefundEntity,
  type RazorpaySubscriptionEntity,
  type RazorpayWebhookBody,
} from './schemas.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Lookup tables (Record<GatewayStatus, UnifiedStatus> with a documented fallback)
// ---------------------------------------------------------------------------

/**
 * `authenticated` is the one judgement call: the mandate is authorised and the
 * first charge is still ahead (a trial or a delayed `start_at`), so it maps to
 * Trialing. For an immediate-start subscription `authenticated` may be visible
 * briefly before the first charge (fact sheet 12.1 #4); Trialing is still the
 * accurate reading ("mandate live, first charge in the future").
 */
export const SUBSCRIPTION_STATUS_MAP: Record<RazorpaySubscriptionStatus, SubscriptionStatus> = {
  [RazorpaySubscriptionStatus.Created]: SubscriptionStatus.Created,
  [RazorpaySubscriptionStatus.Authenticated]: SubscriptionStatus.Trialing,
  [RazorpaySubscriptionStatus.Active]: SubscriptionStatus.Active,
  [RazorpaySubscriptionStatus.Pending]: SubscriptionStatus.PastDue,
  [RazorpaySubscriptionStatus.Halted]: SubscriptionStatus.Halted,
  [RazorpaySubscriptionStatus.Paused]: SubscriptionStatus.Paused,
  [RazorpaySubscriptionStatus.Cancelled]: SubscriptionStatus.Cancelled,
  [RazorpaySubscriptionStatus.Completed]: SubscriptionStatus.Completed,
  [RazorpaySubscriptionStatus.Expired]: SubscriptionStatus.Expired,
};

/**
 * A status Razorpay adds tomorrow becomes `created`: not live (no service
 * should be granted on it) and not terminal (nothing is torn down). The
 * original string is always preserved in `providerStatus`.
 */
export const UNKNOWN_SUBSCRIPTION_STATUS = SubscriptionStatus.Created;

export const INVOICE_STATUS_MAP: Record<RazorpayInvoiceStatus, ChargeStatus> = {
  [RazorpayInvoiceStatus.Draft]: ChargeStatus.Scheduled,
  /** Issued means a charge is attempted or retried and has not succeeded yet. */
  [RazorpayInvoiceStatus.Issued]: ChargeStatus.Pending,
  [RazorpayInvoiceStatus.PartiallyPaid]: ChargeStatus.Pending,
  [RazorpayInvoiceStatus.Paid]: ChargeStatus.Succeeded,
  [RazorpayInvoiceStatus.Cancelled]: ChargeStatus.Cancelled,
  [RazorpayInvoiceStatus.Deleted]: ChargeStatus.Cancelled,
  /** An invoice that lapsed unpaid is a failed collection. */
  [RazorpayInvoiceStatus.Expired]: ChargeStatus.Failed,
};

export const PAYMENT_STATUS_MAP: Record<RazorpayPaymentStatus, ChargeStatus> = {
  [RazorpayPaymentStatus.Created]: ChargeStatus.Pending,
  [RazorpayPaymentStatus.Authorized]: ChargeStatus.Pending,
  [RazorpayPaymentStatus.Captured]: ChargeStatus.Succeeded,
  [RazorpayPaymentStatus.Refunded]: ChargeStatus.Refunded,
  [RazorpayPaymentStatus.Failed]: ChargeStatus.Failed,
};

/** For both invoices and payments: an unknown status is never reported as success. */
export const UNKNOWN_CHARGE_STATUS = ChargeStatus.Pending;

export const REFUND_STATUS_MAP: Record<RazorpayRefundStatus, RefundStatus> = {
  [RazorpayRefundStatus.Pending]: RefundStatus.Pending,
  [RazorpayRefundStatus.Processed]: RefundStatus.Succeeded,
  [RazorpayRefundStatus.Failed]: RefundStatus.Failed,
};
export const UNKNOWN_REFUND_STATUS = RefundStatus.Pending;

export const PAYMENT_METHOD_MAP: Record<RazorpayPaymentMethodName, PaymentMethod> = {
  [RazorpayPaymentMethodName.Card]: PaymentMethod.Card,
  [RazorpayPaymentMethodName.Upi]: PaymentMethod.Upi,
  [RazorpayPaymentMethodName.Emandate]: PaymentMethod.ENach,
  [RazorpayPaymentMethodName.Nach]: PaymentMethod.PhysicalNach,
};

/**
 * Payment `method` of a one-time payment (Payments entity: `card`, `netbanking`,
 * `wallet`, `emi`, `upi`). A method with no entry (`emi`, `cod`, anything
 * Razorpay adds) leaves `paymentMethod` unset; the gateway's own value stays in `raw`.
 */
export const ONE_TIME_PAYMENT_METHOD_MAP: Record<RazorpayOneTimeMethodName, PaymentMethod> = {
  [RazorpayOneTimeMethodName.Card]: PaymentMethod.Card,
  [RazorpayOneTimeMethodName.Upi]: PaymentMethod.Upi,
  [RazorpayOneTimeMethodName.Netbanking]: PaymentMethod.NetBanking,
  [RazorpayOneTimeMethodName.Wallet]: PaymentMethod.Wallet,
};

/**
 * Payment `status` for a one-time payment. `created` is the customer having
 * submitted the payment ("not processed at this stage") and `authorized` is
 * money approved but not yet captured, so both read as pending. Only `captured`
 * is success.
 */
export const ONE_TIME_PAYMENT_STATUS_MAP: Record<RazorpayPaymentStatus, PaymentStatus> = {
  [RazorpayPaymentStatus.Created]: PaymentStatus.Pending,
  [RazorpayPaymentStatus.Authorized]: PaymentStatus.Pending,
  [RazorpayPaymentStatus.Captured]: PaymentStatus.Succeeded,
  [RazorpayPaymentStatus.Refunded]: PaymentStatus.Refunded,
  [RazorpayPaymentStatus.Failed]: PaymentStatus.Failed,
};

/**
 * Order `status`, used when no payment attempt decides the outcome. `attempted`
 * is a payment tried and not yet captured.
 */
export const ORDER_STATUS_MAP: Record<RazorpayOrderStatus, PaymentStatus> = {
  [RazorpayOrderStatus.Created]: PaymentStatus.Created,
  [RazorpayOrderStatus.Attempted]: PaymentStatus.Pending,
  [RazorpayOrderStatus.Paid]: PaymentStatus.Succeeded,
};

/** For both payments and orders: a status Razorpay adds tomorrow is never reported as success. */
export const UNKNOWN_ONE_TIME_PAYMENT_STATUS = PaymentStatus.Pending;

/** Payment webhook events that mean the payment succeeded or failed (`payment.authorized` is not either). */
export const PAYMENT_WEBHOOK_EVENT_MAP: Record<RazorpayPaymentWebhookEvent, EventType> = {
  [RazorpayPaymentWebhookEvent.Captured]: EventType.PaymentSucceeded,
  [RazorpayPaymentWebhookEvent.OrderPaid]: EventType.PaymentSucceeded,
  [RazorpayPaymentWebhookEvent.Failed]: EventType.PaymentFailed,
};

/** Refund webhook events about a one-time payment. `refund.created` and `refund.speed_changed` stay `unknown`. */
export const REFUND_WEBHOOK_EVENT_MAP: Record<RazorpayRefundWebhookEvent, EventType> = {
  [RazorpayRefundWebhookEvent.Processed]: EventType.RefundSucceeded,
  [RazorpayRefundWebhookEvent.Failed]: EventType.RefundFailed,
};

/** Webhook event name to normalised event. Anything else is `EventType.Unknown`. */
export const WEBHOOK_EVENT_MAP: Record<RazorpayWebhookEvent, EventType> = {
  [RazorpayWebhookEvent.Authenticated]: EventType.SubscriptionAuthorized,
  [RazorpayWebhookEvent.Activated]: EventType.SubscriptionActivated,
  [RazorpayWebhookEvent.Charged]: EventType.SubscriptionCharged,
  [RazorpayWebhookEvent.Completed]: EventType.SubscriptionCompleted,
  [RazorpayWebhookEvent.Updated]: EventType.SubscriptionUpdated,
  [RazorpayWebhookEvent.Pending]: EventType.SubscriptionPastDue,
  [RazorpayWebhookEvent.Halted]: EventType.SubscriptionHalted,
  [RazorpayWebhookEvent.Cancelled]: EventType.SubscriptionCancelled,
  [RazorpayWebhookEvent.Paused]: EventType.SubscriptionPaused,
  [RazorpayWebhookEvent.Resumed]: EventType.SubscriptionResumed,
};

function lookup<V>(table: Record<string, V>, key: string | null | undefined): V | undefined {
  if (key === null || key === undefined) return undefined;
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

export function mapSubscriptionStatus(status: string): SubscriptionStatus {
  return lookup(SUBSCRIPTION_STATUS_MAP, status) ?? UNKNOWN_SUBSCRIPTION_STATUS;
}

export function mapOneTimePaymentMethod(method: string | null | undefined): PaymentMethod | undefined {
  return method ? lookup(ONE_TIME_PAYMENT_METHOD_MAP, method.toLowerCase()) : undefined;
}

export function mapPaymentMethod(method: string | null | undefined): PaymentMethod | undefined {
  return method ? lookup(PAYMENT_METHOD_MAP, method.toLowerCase()) : undefined;
}

// ---------------------------------------------------------------------------
// Small value helpers
// ---------------------------------------------------------------------------

/** `remaining_count` is a string in the SDK types and a number in the API; accept both. */
export function toCount(value: number | string | null | undefined): number | undefined {
  if (typeof value === 'number') return Number.isInteger(value) ? value : undefined;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

/** Money must be an exact non-negative integer number of paise; anything else is a changed payload. */
function paise(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SubscriptionError(
      ErrorCode.UnexpectedResponse,
      `${Provider.Razorpay} returned ${what} that is not a whole number of paise: ${String(value)}`,
      { provider: Provider.Razorpay },
    );
  }
  return value;
}

function inrOrUndefined(currency: string | null | undefined): Currency | undefined {
  return currency === Currency.INR ? Currency.INR : undefined;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  return value ? value : undefined;
}

function validUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    new URL(value);
    return value;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Notes (metadata, reference and the other values Razorpay has no field for)
// ---------------------------------------------------------------------------

/** `notes` is `[]` when empty and an object otherwise; values may be numbers. */
export function readNotes(notes: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (typeof notes !== 'object' || notes === null || Array.isArray(notes)) return result;
  for (const [key, value] of Object.entries(notes)) {
    if (typeof value === 'string') result[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) result[key] = String(value);
  }
  return result;
}

/** Caller metadata with the adapter's reserved keys removed; undefined when nothing is left. */
export function metadataFromNotes(notes: Record<string, string>): Metadata | undefined {
  const metadata: Metadata = {};
  for (const [key, value] of Object.entries(notes)) {
    if (!RAZORPAY_RESERVED_NOTE_KEYS.includes(key)) metadata[key] = value;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/**
 * Builds the outgoing `notes`: caller metadata plus the adapter's reserved
 * entries. Rejects reserved keys in metadata and more than 15 pairs, so
 * Razorpay never has to.
 */
export function buildNotes(
  metadata: Metadata | undefined,
  reserved: Partial<Record<RazorpayNoteKey, string | undefined>>,
): Record<string, string> | undefined {
  const notes: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (RAZORPAY_RESERVED_NOTE_KEYS.includes(key)) {
      throw invalid(`metadata key "${key}" is reserved by the Razorpay adapter; use another key`, Provider.Razorpay);
    }
    notes[key] = value;
  }
  for (const [key, value] of Object.entries(reserved)) {
    if (value !== undefined) notes[key] = value;
  }
  const count = Object.keys(notes).length;
  if (count > RAZORPAY_MAX_NOTES) {
    throw invalid(
      `Razorpay allows at most ${RAZORPAY_MAX_NOTES} notes per object and this request needs ${count} ` +
        '(metadata plus the entries this adapter adds for reference, plan id and cycle cap)',
      Provider.Razorpay,
    );
  }
  return count > 0 ? notes : undefined;
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

const PERIOD_FOR_UNIT: Record<IntervalUnit, RazorpayPlanPeriod> = {
  [IntervalUnit.Day]: RazorpayPlanPeriod.Daily,
  [IntervalUnit.Week]: RazorpayPlanPeriod.Weekly,
  [IntervalUnit.Month]: RazorpayPlanPeriod.Monthly,
  [IntervalUnit.Year]: RazorpayPlanPeriod.Yearly,
};

/**
 * `{ unit, count }` maps one-to-one onto `period` + `interval`. A quarterly
 * schedule is therefore sent as `monthly` with `interval: 3`, not as the
 * `quarterly` period (which the response docs and the SDK types omit).
 */
export function buildPlanRequest(input: ParsedCreatePlanInput): RazorpayCreatePlanRequest {
  assertInterval(input.interval);
  if (input.interval.unit === IntervalUnit.Day && input.interval.count < RAZORPAY_MIN_DAILY_INTERVAL) {
    throw invalid(
      `Razorpay daily plans need an interval of at least ${RAZORPAY_MIN_DAILY_INTERVAL} days, got ${input.interval.count}. ` +
        'Use a weekly plan for 7-day billing or longer day counts for daily plans.',
      Provider.Razorpay,
    );
  }
  const notes = buildNotes(input.metadata, {
    [RazorpayNoteKey.RequestedPlanId]: input.id,
    [RazorpayNoteKey.PlanMaxCycles]: input.maxCycles === undefined ? undefined : String(input.maxCycles),
  });
  return {
    period: PERIOD_FOR_UNIT[input.interval.unit],
    interval: input.interval.count,
    item: {
      name: input.name,
      amount: input.amount,
      currency: input.currency,
      description: input.description,
    },
    notes,
  };
}

/** The inverse of `buildPlanRequest`; a `quarterly` plan is three months per interval. */
export function planToInterval(period: string, interval: number): BillingInterval | undefined {
  if (!Number.isInteger(interval) || interval < 1) return undefined;
  switch (period) {
    case RazorpayPlanPeriod.Daily:
      return { unit: IntervalUnit.Day, count: interval };
    case RazorpayPlanPeriod.Weekly:
      return { unit: IntervalUnit.Week, count: interval };
    case RazorpayPlanPeriod.Monthly:
      return { unit: IntervalUnit.Month, count: interval };
    case RazorpayPlanPeriod.Quarterly:
      return { unit: IntervalUnit.Month, count: interval * 3 };
    case RazorpayPlanPeriod.Yearly:
      return { unit: IntervalUnit.Year, count: interval };
    default:
      return undefined;
  }
}

/** What the subscription mapper and `total_count` derivation need to know about a plan. */
export interface PlanContext {
  /** Plan amount per unit, in paise. */
  amount: number;
  interval?: BillingInterval;
  /** `maxCycles` recorded in the plan's notes by this adapter. */
  maxCycles?: number;
}

export function planContext(entity: RazorpayPlanEntity): PlanContext {
  const amount = entity.item.amount ?? entity.item.unit_amount;
  if (amount === null || amount === undefined) {
    throw new SubscriptionError(ErrorCode.UnexpectedResponse, `${Provider.Razorpay} returned a plan without an amount`, {
      provider: Provider.Razorpay,
      raw: entity,
    });
  }
  const notes = readNotes(entity.notes);
  return {
    amount: paise(amount, 'a plan amount'),
    interval: planToInterval(entity.period, entity.interval),
    maxCycles: toCount(notes[RazorpayNoteKey.PlanMaxCycles]),
  };
}

export function mapPlan(entity: RazorpayPlanEntity): Plan {
  const currency = entity.item.currency ?? Currency.INR;
  if (currency !== Currency.INR) {
    throw unsupported(Provider.Razorpay, `plans in ${currency}`, 'this library models INR only');
  }
  const context = planContext(entity);
  const notes = readNotes(entity.notes);
  return {
    provider: Provider.Razorpay,
    id: entity.id,
    name: entity.item.name,
    description: nonEmpty(entity.item.description),
    amount: context.amount,
    currency: Currency.INR,
    interval: context.interval,
    scheduling: SchedulingMode.Gateway,
    maxCycles: context.maxCycles,
    createdAt: unixToIso(entity.created_at),
    metadata: metadataFromNotes(notes),
    raw: entity,
  };
}

// ---------------------------------------------------------------------------
// Whole-cycle arithmetic for `total_count`
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** The shortest possible span of one interval, used as a search bound. */
function minIntervalMs(interval: BillingInterval): number {
  switch (interval.unit) {
    case IntervalUnit.Day:
      return interval.count * DAY_MS;
    case IntervalUnit.Week:
      return interval.count * 7 * DAY_MS;
    case IntervalUnit.Month:
      return interval.count * 28 * DAY_MS;
    case IntervalUnit.Year:
      return interval.count * 365 * DAY_MS;
  }
}

/**
 * Number of whole billing cycles that fit between `anchor` (the first charge)
 * and `end`: the largest `n` with `cycleStart(anchor, interval, n) <= end`.
 * Month and year steps are anchored (31 Jan, 28 Feb, 31 Mar), as in `time.ts`.
 */
export function wholeCyclesBetween(anchor: Date, end: Date, interval: BillingInterval): number {
  assertInterval(interval);
  const span = end.getTime() - anchor.getTime();
  if (span < 0) return 0;
  let low = 0; // cycleStart(low) <= end always holds for 0
  let high = Math.floor(span / minIntervalMs(interval)) + 1; // cycleStart(high) > end by construction
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (cycleStart(anchor, interval, middle).getTime() <= end.getTime()) low = middle;
    else high = middle;
  }
  return low;
}

/** Whole cycles in `years` years starting at `anchor`. */
export function cyclesInYears(anchor: Date, years: number, interval: BillingInterval): number {
  const end = cycleStart(anchor, { unit: IntervalUnit.Year, count: 1 }, years);
  return wholeCyclesBetween(anchor, end, interval);
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export interface SubscriptionMapOptions {
  /** The plan, when the caller already has it; fills `amount` and `interval`. */
  plan?: PlanContext;
  /** Set by `cancelSubscription` when the cancellation was requested for the cycle end. */
  cancelAtPeriodEnd?: boolean;
  checkout?: CheckoutInstruction;
}

/** Keeps only the parts that satisfy the neutral schema; a malformed contact is dropped, not forwarded. */
function validCustomer(candidate: { id?: string; email?: string; phone?: string }): Customer | undefined {
  const parts: Customer = {};
  for (const key of ['id', 'email', 'phone'] as const) {
    const value = candidate[key];
    if (value === undefined) continue;
    const check = CustomerSchema.safeParse({ [key]: value });
    if (check.success) parts[key] = value;
  }
  return Object.keys(parts).length > 0 ? parts : undefined;
}

function mapCustomer(entity: RazorpaySubscriptionEntity): Customer | undefined {
  return validCustomer({
    id: nonEmpty(entity.customer_id),
    email: nonEmpty(entity.customer_email),
    phone: nonEmpty(entity.customer_contact),
  });
}

export function mapSubscription(entity: RazorpaySubscriptionEntity, options: SubscriptionMapOptions = {}): Subscription {
  const status = mapSubscriptionStatus(entity.status);
  const notes = readNotes(entity.notes);
  const quantity = entity.quantity ?? undefined;
  const plan = options.plan;
  return {
    provider: Provider.Razorpay,
    id: entity.id,
    reference: notes[RazorpayNoteKey.Reference],
    planId: nonEmpty(entity.plan_id),
    status,
    providerStatus: entity.status,
    scheduling: SchedulingMode.Gateway,
    customer: mapCustomer(entity),
    quantity,
    amount: plan ? paise(plan.amount * (quantity ?? 1), 'a subscription amount') : undefined,
    currency: plan ? Currency.INR : undefined,
    interval: plan?.interval,
    totalCycles: toCount(entity.total_count),
    paidCycles: toCount(entity.paid_count),
    remainingCycles: toCount(entity.remaining_count),
    createdAt: unixToIso(entity.created_at),
    startAt: unixToIso(entity.start_at),
    /** `authenticated` means the first charge is still ahead: it happens at `charge_at` (== `start_at`). */
    trialEndsAt: status === SubscriptionStatus.Trialing ? unixToIso(entity.charge_at ?? entity.start_at) : undefined,
    currentPeriodStart: unixToIso(entity.current_start),
    currentPeriodEnd: unixToIso(entity.current_end),
    nextChargeAt: unixToIso(entity.charge_at),
    endedAt: unixToIso(entity.ended_at),
    /**
     * `end_at` is the scheduled end of the last cycle, pre-computed by Razorpay
     * at creation (fact sheet 2.3.1). The docs also call it the time the
     * subscription "ended" (2.3.4); the samples show future values, so it is
     * read as the scheduled end.
     */
    mandateEndsAt: unixToIso(entity.end_at),
    cancelAtPeriodEnd: options.cancelAtPeriodEnd,
    paymentMethod: mapPaymentMethod(entity.payment_method),
    checkout: options.checkout,
    metadata: metadataFromNotes(notes),
    raw: entity,
  };
}

/** Checkout instruction for Razorpay Standard Checkout (`subscription_id` option). */
export function buildCheckout(params: {
  keyId: string;
  subscriptionId: string;
  shortUrl?: string | null;
  callbackUrl?: string;
  customer?: Customer;
}): CheckoutInstruction {
  const { customer } = params;
  const prefill: Customer = {};
  if (customer?.name) prefill.name = customer.name;
  if (customer?.email) prefill.email = customer.email;
  if (customer?.phone) prefill.phone = customer.phone;
  return {
    kind: CheckoutKind.RazorpayCheckout,
    keyId: params.keyId,
    subscriptionId: params.subscriptionId,
    hostedUrl: validUrl(params.shortUrl),
    callbackUrl: params.callbackUrl,
    prefill: Object.keys(prefill).length > 0 ? prefill : undefined,
  };
}

// ---------------------------------------------------------------------------
// Charges
// ---------------------------------------------------------------------------

function hasLineType(invoice: RazorpayInvoiceEntity, type: RazorpayLineItemType): boolean {
  return (invoice.line_items ?? []).some((line) => line.type === type);
}

/** An invoice with no line items listed is assumed to bill the plan. */
function billsPlan(invoice: RazorpayInvoiceEntity): boolean {
  return invoice.line_items == null || invoice.line_items.length === 0 || hasLineType(invoice, RazorpayLineItemType.Plan);
}

function invoiceSortKey(invoice: RazorpayInvoiceEntity): number {
  return invoice.billing_start ?? invoice.date ?? invoice.created_at ?? 0;
}

/**
 * 1-based cycle number of each plan-billing invoice, by billing period start.
 * Only meaningful when `invoices` is the subscription's complete list.
 */
function cycleNumbers(invoices: readonly RazorpayInvoiceEntity[]): Map<string, number> {
  const numbers = new Map<string, number>();
  const ordered = invoices
    .filter(billsPlan)
    .sort((a, b) => invoiceSortKey(a) - invoiceSortKey(b) || a.id.localeCompare(b.id));
  ordered.forEach((invoice, index) => numbers.set(invoice.id, index + 1));
  return numbers;
}

export interface InvoiceChargeOptions {
  subscriptionId?: string;
  /** 1-based cycle, when the caller could derive it. */
  cycle?: number;
}

/**
 * One invoice is one charge. `id` is the payment id when the invoice has one
 * (so `refundCharge` can use it directly) and the invoice id otherwise.
 * `amount` is the invoice total, which includes any upfront add-on line.
 */
export function mapInvoiceToCharge(invoice: RazorpayInvoiceEntity, options: InvoiceChargeOptions = {}): Charge {
  const plan = billsPlan(invoice);
  const kind = plan ? ChargeKind.Recurring : hasLineType(invoice, RazorpayLineItemType.Addon) ? ChargeKind.Upfront : ChargeKind.Recurring;
  return {
    provider: Provider.Razorpay,
    id: nonEmpty(invoice.payment_id) ?? invoice.id,
    reference: invoice.id,
    subscriptionId: nonEmpty(invoice.subscription_id) ?? options.subscriptionId,
    kind,
    status: lookup(INVOICE_STATUS_MAP, invoice.status) ?? UNKNOWN_CHARGE_STATUS,
    providerStatus: invoice.status,
    amount: paise(invoice.amount, 'an invoice amount'),
    currency: inrOrUndefined(invoice.currency),
    cycle: plan ? options.cycle : undefined,
    scheduledAt: unixToIso(invoice.issued_at ?? invoice.date),
    paidAt: unixToIso(invoice.paid_at),
    raw: invoice,
  };
}

/**
 * Maps a subscription's invoices to charges. Cycle numbers are derived only
 * when `complete` is true (the list is known to hold every invoice), because a
 * partial page cannot say which cycle an invoice is.
 */
export function mapInvoicesToCharges(
  invoices: readonly RazorpayInvoiceEntity[],
  options: { subscriptionId: string; complete: boolean },
): Charge[] {
  const cycles = options.complete ? cycleNumbers(invoices) : new Map<string, number>();
  return invoices.map((invoice) =>
    mapInvoiceToCharge(invoice, { subscriptionId: options.subscriptionId, cycle: cycles.get(invoice.id) }),
  );
}

export interface PaymentChargeOptions {
  subscriptionId?: string;
}

/**
 * A payment is the money movement. The payment entity does not say which kind
 * of charge it was, so: a payment that belongs to an invoice is a recurring
 * charge; one with no invoice is the authorisation payment (the workflow page:
 * a future-start subscription without an upfront amount raises no invoice for
 * its authorisation transaction, fact sheet 4.2). An upfront payment that has
 * an invoice therefore reads as Recurring; the invoice listing tells them apart.
 */
export function mapPaymentToCharge(payment: RazorpayPaymentEntity, options: PaymentChargeOptions = {}): Charge {
  let status = lookup(PAYMENT_STATUS_MAP, payment.status) ?? UNKNOWN_CHARGE_STATUS;
  const amount = paise(payment.amount, 'a payment amount');
  const refunded = payment.amount_refunded ?? 0;
  if (payment.status === RazorpayPaymentStatus.Captured) {
    if (payment.refund_status === RazorpayPaymentRefundStatus.Full || (refunded > 0 && refunded >= amount)) {
      status = ChargeStatus.Refunded;
    } else if (payment.refund_status === RazorpayPaymentRefundStatus.Partial || refunded > 0) {
      status = ChargeStatus.PartiallyRefunded;
    }
  }
  const settled = payment.status === RazorpayPaymentStatus.Captured || payment.status === RazorpayPaymentStatus.Refunded;
  const failed = status === ChargeStatus.Failed;
  return {
    provider: Provider.Razorpay,
    id: payment.id,
    reference: nonEmpty(payment.invoice_id),
    subscriptionId: options.subscriptionId,
    kind: payment.invoice_id ? ChargeKind.Recurring : ChargeKind.Authorization,
    status,
    providerStatus: payment.status,
    amount,
    currency: inrOrUndefined(payment.currency),
    /** Payments are auto-captured, so creation time is the closest documented timestamp to the capture. */
    paidAt: settled ? unixToIso(payment.created_at) : undefined,
    failureCode: failed || payment.error_code ? nonEmpty(payment.error_code) : undefined,
    failureReason: failed || payment.error_code ? nonEmpty(payment.error_description ?? payment.error_reason) : undefined,
    paymentMethod: mapPaymentMethod(payment.method),
    refundedAmount: payment.amount_refunded == null ? undefined : paise(payment.amount_refunded, 'a refunded amount'),
    raw: payment,
  };
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

export function mapRefund(
  entity: RazorpayRefundEntity,
  fallback: { chargeId: string; amount?: number; reference?: string },
): Refund {
  const amount = entity.amount ?? fallback.amount;
  if (amount === undefined) {
    throw new SubscriptionError(ErrorCode.UnexpectedResponse, `${Provider.Razorpay} returned a refund without an amount`, {
      provider: Provider.Razorpay,
      raw: entity,
    });
  }
  return {
    provider: Provider.Razorpay,
    id: entity.id,
    reference: nonEmpty(entity.receipt) ?? fallback.reference,
    chargeId: nonEmpty(entity.payment_id) ?? fallback.chargeId,
    status: lookup(REFUND_STATUS_MAP, entity.status) ?? UNKNOWN_REFUND_STATUS,
    providerStatus: entity.status,
    amount: paise(amount, 'a refund amount'),
    currency: inrOrUndefined(entity.currency),
    createdAt: unixToIso(entity.created_at),
    raw: entity,
  };
}

// ---------------------------------------------------------------------------
// One-time payments (Orders API)
// ---------------------------------------------------------------------------

/**
 * `Payment.id` is the Razorpay order id. A payment id (`pay_...`) only exists
 * once the customer has paid, but `createPayment` has to return an id that
 * `getPayment` and `refundPayment` accept from then on, and that webhooks
 * about the payment carry: the order is the only Razorpay object that exists
 * at all three moments. The payment ids of the attempts stay in `raw`.
 *
 * Razorpay has a place for: the amount (`amount`), your idempotency key
 * (`receipt`, which Razorpay treats as an idempotency key), and `notes` for
 * the reference, the description and the metadata. It has none for a payment
 * method restriction or an expiry on the order, so those are refused.
 */
export function buildOrderRequest(input: ParsedCreatePaymentInput): RazorpayCreateOrderRequest {
  if (input.paymentMethods !== undefined) {
    throw unsupported(
      Provider.Razorpay,
      'restricting payment methods on a payment',
      'the Orders API has no such parameter; choose the methods in the Dashboard (Payment Configuration) or in the Checkout options',
    );
  }
  if (input.expiresAt !== undefined) {
    throw unsupported(Provider.Razorpay, 'an expiry time on a payment', 'an order has no expiry parameter');
  }
  const key = input.idempotencyKey;
  if (key !== undefined && (key.length > RAZORPAY_MAX_RECEIPT_CHARS || !RAZORPAY_RECEIPT_PATTERN.test(key))) {
    throw invalid(
      `idempotencyKey is sent as the order receipt, which Razorpay limits to ${RAZORPAY_MAX_RECEIPT_CHARS} printable ASCII characters`,
      Provider.Razorpay,
    );
  }
  const notes = buildNotes(input.metadata, {
    [RazorpayNoteKey.PaymentReference]: input.reference,
    [RazorpayNoteKey.PaymentDescription]: input.description,
  });
  return { amount: input.amount, currency: Currency.INR, receipt: key, notes };
}

/** Checkout instruction for Standard Checkout with an order (`order_id` option). */
export function buildOrderCheckout(params: {
  keyId: string;
  orderId: string;
  amount: number;
  callbackUrl?: string;
  customer?: Customer;
}): CheckoutInstruction {
  return {
    kind: CheckoutKind.RazorpayCheckout,
    keyId: params.keyId,
    orderId: params.orderId,
    amount: params.amount,
    callbackUrl: params.callbackUrl,
    prefill: prefillFrom(params.customer),
  };
}

function prefillFrom(customer: Customer | undefined): Customer | undefined {
  const prefill: Customer = {};
  if (customer?.name) prefill.name = customer.name;
  if (customer?.email) prefill.email = customer.email;
  if (customer?.phone) prefill.phone = customer.phone;
  return Object.keys(prefill).length > 0 ? prefill : undefined;
}

const SETTLED_STATUSES: readonly PaymentStatus[] = [
  PaymentStatus.Succeeded,
  PaymentStatus.Refunded,
  PaymentStatus.PartiallyRefunded,
];

/** The status of one payment attempt, with the refund state of a captured payment folded in. */
export function mapAttemptStatus(payment: RazorpayPaymentEntity): PaymentStatus {
  const status = lookup(ONE_TIME_PAYMENT_STATUS_MAP, payment.status) ?? UNKNOWN_ONE_TIME_PAYMENT_STATUS;
  if (payment.status !== RazorpayPaymentStatus.Captured) return status;
  const refunded = payment.amount_refunded ?? 0;
  if (payment.refund_status === RazorpayPaymentRefundStatus.Full || (refunded > 0 && refunded >= payment.amount)) {
    return PaymentStatus.Refunded;
  }
  if (payment.refund_status === RazorpayPaymentRefundStatus.Partial || refunded > 0) return PaymentStatus.PartiallyRefunded;
  return status;
}

/** True for a payment that took the customer's money: captured, or captured and since refunded. */
export function isSettledAttempt(payment: RazorpayPaymentEntity): boolean {
  return payment.status === RazorpayPaymentStatus.Captured || payment.status === RazorpayPaymentStatus.Refunded;
}

/**
 * The attempt that decides an order's outcome: the one that took the money;
 * else an authorised one; else the most recent. A failed attempt does not close
 * an order, so a later attempt can still change the result.
 */
export function pickAttempt(attempts: readonly RazorpayPaymentEntity[]): RazorpayPaymentEntity | undefined {
  const settled = attempts.find(isSettledAttempt);
  if (settled) return settled;
  const authorized = attempts.find((attempt) => attempt.status === RazorpayPaymentStatus.Authorized);
  if (authorized) return authorized;
  // Array.prototype.sort is stable, so attempts with the same timestamp keep the order Razorpay listed them in.
  return [...attempts].sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0)).at(-1);
}

interface PaymentParts {
  orderId: string;
  order?: RazorpayOrderEntity;
  attempts: readonly RazorpayPaymentEntity[];
  checkout?: CheckoutInstruction;
  customer?: Customer;
}

function composePayment(parts: PaymentParts): Payment {
  const { orderId, order, attempts } = parts;
  const attempt = pickAttempt(attempts);
  const orderStatus = order ? (lookup(ORDER_STATUS_MAP, order.status) ?? UNKNOWN_ONE_TIME_PAYMENT_STATUS) : undefined;

  let status: PaymentStatus;
  let providerStatus: string;
  if (attempt) {
    status = mapAttemptStatus(attempt);
    providerStatus = attempt.status;
  } else if (order && orderStatus) {
    status = orderStatus;
    providerStatus = order.status;
  } else {
    throw new SubscriptionError(ErrorCode.UnexpectedResponse, `${Provider.Razorpay} returned no order or payment for ${orderId}`, {
      provider: Provider.Razorpay,
    });
  }
  // The order is the record of whether it was paid: a payment list read a moment earlier must not contradict it.
  let paidByOrderOnly = false;
  if (order && orderStatus === PaymentStatus.Succeeded && !SETTLED_STATUSES.includes(status)) {
    status = PaymentStatus.Succeeded;
    providerStatus = order.status;
    paidByOrderOnly = true;
  }

  const settledAttempt = attempt && isSettledAttempt(attempt) && !paidByOrderOnly ? attempt : undefined;
  // The order's notes are the ones this library wrote; a webhook without the order falls back to the payment's.
  const notes = readNotes(order ? order.notes : attempt?.notes);
  const failed = status === PaymentStatus.Failed && attempt !== undefined;
  const refundedAmount =
    settledAttempt === undefined
      ? undefined
      : paise(
          settledAttempt.amount_refunded ?? (settledAttempt.status === RazorpayPaymentStatus.Refunded ? settledAttempt.amount : 0),
          'a refunded amount',
        );
  const amount = order?.amount ?? attempt?.amount;
  return {
    provider: Provider.Razorpay,
    id: orderId,
    reference: notes[RazorpayNoteKey.PaymentReference],
    status,
    providerStatus,
    amount: paise(amount ?? 0, 'an order amount'),
    currency: inrOrUndefined(order?.currency ?? attempt?.currency),
    refundedAmount,
    paymentMethod: mapOneTimePaymentMethod(attempt?.method),
    customer: parts.customer ?? validCustomer({ email: nonEmpty(attempt?.email), phone: nonEmpty(attempt?.contact) }),
    createdAt: unixToIso(order?.created_at ?? attempt?.created_at),
    /** Payments are auto-captured, so creation time is the closest documented timestamp to the capture. */
    paidAt: settledAttempt ? unixToIso(settledAttempt.created_at) : undefined,
    failureCode: failed ? nonEmpty(attempt.error_code) : undefined,
    failureReason: failed ? nonEmpty(attempt.error_description ?? attempt.error_reason) : undefined,
    checkout: parts.checkout,
    metadata: metadataFromNotes(notes),
    raw: { order, payments: attempts },
  };
}

/** A freshly created order: nothing has been attempted yet. */
export function mapCreatedPayment(
  order: RazorpayOrderEntity,
  options: { checkout: CheckoutInstruction; customer?: Customer },
): Payment {
  return composePayment({ orderId: order.id, order, attempts: [], checkout: options.checkout, customer: options.customer });
}

/** `getPayment`: the order plus every payment attempt made against it. */
export function mapOrderPayment(order: RazorpayOrderEntity, attempts: readonly RazorpayPaymentEntity[]): Payment {
  return composePayment({ orderId: order.id, order, attempts });
}

/** A payment entity from a webhook; `order` is present on `order.paid`. */
export function mapWebhookPayment(payment: RazorpayPaymentEntity & { order_id: string }, order?: RazorpayOrderEntity): Payment {
  return composePayment({ orderId: payment.order_id, order, attempts: [payment] });
}

/** A refund of a one-time payment: `chargeId` and `paymentId` are both the payment's id (the order id). */
export function mapPaymentRefund(
  entity: RazorpayRefundEntity,
  fallback: { paymentId: string; amount?: number; reference?: string },
): Refund {
  const refund = mapRefund(entity, { chargeId: fallback.paymentId, amount: fallback.amount, reference: fallback.reference });
  return { ...refund, chargeId: fallback.paymentId, paymentId: fallback.paymentId };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** One readable line from Razorpay's error body, including `field` and `reason` when it fills them. */
export function describeErrorBody(body: z.infer<typeof RazorpayErrorBodySchema>): { message: string; providerCode?: string } {
  const { code, description, field, reason } = body.error;
  const details: string[] = [];
  if (field && field !== RAZORPAY_NOT_APPLICABLE) details.push(`field: ${field}`);
  if (reason && reason !== RAZORPAY_NOT_APPLICABLE) details.push(`reason: ${reason}`);
  const base = description && description.length > 0 ? description : 'no description given';
  return {
    message: details.length > 0 ? `${base} (${details.join(', ')})` : base,
    providerCode: nonEmpty(code),
  };
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export function isSubscriptionWebhookEvent(name: string): name is RazorpayWebhookEvent {
  return lookup(WEBHOOK_EVENT_MAP, name) !== undefined;
}

/**
 * Event id used for de-duplication: the `x-razorpay-event-id` header, which
 * Razorpay documents as unique per event. Without it, a deterministic id is
 * built from the event name, the subscription (or payment) id and the event
 * timestamp, so a redelivered event keeps the same id.
 */
export function webhookEventId(body: RazorpayWebhookBody, headerEventId: string | undefined): string {
  if (headerEventId) return headerEventId;
  const holder = (value: unknown): string | undefined => {
    if (typeof value !== 'object' || value === null) return undefined;
    const id = (value as { id?: unknown }).id;
    return typeof id === 'string' ? id : undefined;
  };
  const entityId =
    holder(body.payload.subscription?.entity) ??
    holder(body.payload.refund?.entity) ??
    holder(body.payload.payment?.entity) ??
    '';
  const timestamp = body.created_at ?? body.payload.created_at ?? '';
  return `${body.event}:${entityId}:${timestamp}`;
}

/** The two fields that tell a one-time payment from a subscription debit. */
const ONE_TIME_PAYMENT_PROBE = z.looseObject({
  order_id: z.string().min(1),
  invoice_id: z.union([z.null(), z.literal('')]).optional(),
});

/**
 * The payment entity of an event when the event is about a one-time payment,
 * otherwise undefined. The documented samples show a one-time payment as a
 * payment with an `order_id` and no `invoice_id`, in a payload with no
 * `subscription`; every payment inside a subscription sample has an invoice.
 */
function oneTimePaymentEntity(body: RazorpayWebhookBody): (RazorpayPaymentEntity & { order_id: string }) | undefined {
  if (body.payload.subscription != null) return undefined;
  const raw = body.payload.payment?.entity;
  if (!ONE_TIME_PAYMENT_PROBE.safeParse(raw).success) return undefined;
  const payment = parseResponse(RazorpayPaymentEntitySchema, raw, `${body.event} payment entity`, Provider.Razorpay);
  return payment.order_id ? { ...payment, order_id: payment.order_id } : undefined;
}

type EventBase = Pick<SubscriptionEvent, 'id' | 'provider' | 'providerEventType' | 'occurredAt' | 'raw'>;

/**
 * Events about a one-time payment: `payment.captured`, `order.paid` and
 * `payment.failed` become `payment.succeeded` / `payment.failed`, and
 * `refund.processed` / `refund.failed` become `refund.succeeded` /
 * `refund.failed`. Anything else, including every event about a subscription
 * debit, is left to the caller (`unknown`).
 */
function mapOneTimeWebhookEvent(body: RazorpayWebhookBody, base: EventBase): SubscriptionEvent | undefined {
  const paymentType = lookup(PAYMENT_WEBHOOK_EVENT_MAP, body.event);
  const refundType = lookup(REFUND_WEBHOOK_EVENT_MAP, body.event);
  if (paymentType === undefined && refundType === undefined) return undefined;

  const paymentEntity = oneTimePaymentEntity(body);
  if (!paymentEntity) return undefined;
  const orderRaw = body.payload.order?.entity;
  const order =
    orderRaw === undefined || orderRaw === null
      ? undefined
      : parseResponse(RazorpayOrderEntitySchema, orderRaw, `${body.event} order entity`, Provider.Razorpay);
  const payment = mapWebhookPayment(paymentEntity, order);

  if (paymentType !== undefined) return { ...base, type: paymentType, paymentId: payment.id, payment };

  const refund = mapPaymentRefund(
    parseResponse(RazorpayRefundEntitySchema, body.payload.refund?.entity, `${body.event} refund entity`, Provider.Razorpay),
    { paymentId: payment.id },
  );
  return { ...base, type: refundType ?? EventType.Unknown, paymentId: payment.id, payment, refund };
}

/**
 * Normalises one verified webhook body. Subscription events carry the
 * subscription entity and, when a payment attempt preceded the event, the
 * payment entity. Events about a one-time payment are mapped by
 * `mapOneTimeWebhookEvent`. Every other event is returned as
 * `EventType.Unknown`, raw untouched.
 */
export function mapWebhookEvent(body: RazorpayWebhookBody, headerEventId: string | undefined): SubscriptionEvent {
  const base = {
    id: webhookEventId(body, headerEventId),
    provider: Provider.Razorpay,
    providerEventType: body.event,
    occurredAt: unixToIso(body.created_at ?? body.payload.created_at),
    raw: body,
  };
  const type = lookup(WEBHOOK_EVENT_MAP, body.event);
  if (type === undefined) return mapOneTimeWebhookEvent(body, base) ?? { ...base, type: EventType.Unknown };

  const subscriptionEntity = parseResponse(
    RazorpaySubscriptionEntitySchema,
    body.payload.subscription?.entity,
    `${body.event} subscription entity`,
    Provider.Razorpay,
  );
  const subscription = mapSubscription(subscriptionEntity);
  const paymentRaw = body.payload.payment?.entity;
  const charge =
    paymentRaw === undefined || paymentRaw === null
      ? undefined
      : mapPaymentToCharge(
          parseResponse(RazorpayPaymentEntitySchema, paymentRaw, `${body.event} payment entity`, Provider.Razorpay),
          { subscriptionId: subscriptionEntity.id },
        );
  return { ...base, type, subscriptionId: subscriptionEntity.id, subscription, charge };
}

/** True when the unified status ends the subscription's life. */
export function isTerminal(status: SubscriptionStatus): boolean {
  return TERMINAL_SUBSCRIPTION_STATUSES.includes(status);
}
