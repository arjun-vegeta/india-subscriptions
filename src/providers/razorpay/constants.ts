/**
 * Razorpay-specific constants: endpoints, headers, statuses, event names and
 * the documented limits. Every value cites its source in the Razorpay
 * subscription docs or the official Node SDK (razorpay-node 2.9.8).
 */
import { ErrorCode } from '../../constants.js';

/** Same host for test and live; the mode follows the API key pair. */
export const RAZORPAY_BASE_URL = 'https://api.razorpay.com';

const enc = encodeURIComponent;

/** Paths relative to the base URL. Ids are percent-encoded. */
export const RazorpayEndpoint = {
  plans: '/v1/plans',
  plan: (planId: string) => `/v1/plans/${enc(planId)}`,
  subscriptions: '/v1/subscriptions',
  subscription: (subscriptionId: string) => `/v1/subscriptions/${enc(subscriptionId)}`,
  cancelSubscription: (subscriptionId: string) => `/v1/subscriptions/${enc(subscriptionId)}/cancel`,
  pauseSubscription: (subscriptionId: string) => `/v1/subscriptions/${enc(subscriptionId)}/pause`,
  resumeSubscription: (subscriptionId: string) => `/v1/subscriptions/${enc(subscriptionId)}/resume`,
  /** Invoices of a subscription are listed with `?subscription_id=` (fact sheet 2.3.12). */
  invoices: '/v1/invoices',
  invoice: (invoiceId: string) => `/v1/invoices/${enc(invoiceId)}`,
  payment: (paymentId: string) => `/v1/payments/${enc(paymentId)}`,
  /** SDK `payments.refund` (fact sheet section 10); the refund API is not in the docs set. */
  refundPayment: (paymentId: string) => `/v1/payments/${enc(paymentId)}/refund`,
} as const;

/** Lower-case request header names Razorpay sends on webhooks. */
export const RazorpayHeader = {
  Signature: 'x-razorpay-signature',
  EventId: 'x-razorpay-event-id',
} as const;

/** Subscription `status`. `paused` is missing from every documented enum but is real (fact sheet 12.1 #1). */
export const RazorpaySubscriptionStatus = {
  Created: 'created',
  Authenticated: 'authenticated',
  Active: 'active',
  Pending: 'pending',
  Halted: 'halted',
  Paused: 'paused',
  Cancelled: 'cancelled',
  Completed: 'completed',
  Expired: 'expired',
} as const;
export type RazorpaySubscriptionStatus = (typeof RazorpaySubscriptionStatus)[keyof typeof RazorpaySubscriptionStatus];

/** Plan `period`. `quarterly` is accepted on create but omitted from response docs (12.1 #5). */
export const RazorpayPlanPeriod = {
  Daily: 'daily',
  Weekly: 'weekly',
  Monthly: 'monthly',
  Quarterly: 'quarterly',
  Yearly: 'yearly',
} as const;
export type RazorpayPlanPeriod = (typeof RazorpayPlanPeriod)[keyof typeof RazorpayPlanPeriod];

/** `schedule_change_at` on update. */
export const RazorpayScheduleChangeAt = {
  Now: 'now',
  CycleEnd: 'cycle_end',
} as const;
export type RazorpayScheduleChangeAt = (typeof RazorpayScheduleChangeAt)[keyof typeof RazorpayScheduleChangeAt];

/** The only documented value of `pause_at`. */
export const RazorpayPauseAt = { Now: 'now' } as const;
/** The only documented value of `resume_at`. */
export const RazorpayResumeAt = { Now: 'now' } as const;

export const RazorpayInvoiceStatus = {
  Draft: 'draft',
  Issued: 'issued',
  PartiallyPaid: 'partially_paid',
  Paid: 'paid',
  Expired: 'expired',
  Cancelled: 'cancelled',
  Deleted: 'deleted',
} as const;
export type RazorpayInvoiceStatus = (typeof RazorpayInvoiceStatus)[keyof typeof RazorpayInvoiceStatus];

/** Invoice line item `type`. */
export const RazorpayLineItemType = {
  Plan: 'plan',
  Addon: 'addon',
} as const;
export type RazorpayLineItemType = (typeof RazorpayLineItemType)[keyof typeof RazorpayLineItemType];

/** Payment `status` (SDK payments.d.ts). */
export const RazorpayPaymentStatus = {
  Created: 'created',
  Authorized: 'authorized',
  Captured: 'captured',
  Refunded: 'refunded',
  Failed: 'failed',
} as const;
export type RazorpayPaymentStatus = (typeof RazorpayPaymentStatus)[keyof typeof RazorpayPaymentStatus];

/** Payment `refund_status` (SDK payments.d.ts; JSON null when nothing was refunded). */
export const RazorpayPaymentRefundStatus = {
  Partial: 'partial',
  Full: 'full',
} as const;
export type RazorpayPaymentRefundStatus = (typeof RazorpayPaymentRefundStatus)[keyof typeof RazorpayPaymentRefundStatus];

/** Refund `status` (SDK refunds.d.ts). */
export const RazorpayRefundStatus = {
  Pending: 'pending',
  Processed: 'processed',
  Failed: 'failed',
} as const;
export type RazorpayRefundStatus = (typeof RazorpayRefundStatus)[keyof typeof RazorpayRefundStatus];

/**
 * `payment_method` / payment `method` names. The docs name "card, emandate, or
 * UPI" without stating exact casing (2.3.3), so lookups are case-insensitive.
 */
export const RazorpayPaymentMethodName = {
  Card: 'card',
  Upi: 'upi',
  Emandate: 'emandate',
  Nach: 'nach',
} as const;
export type RazorpayPaymentMethodName = (typeof RazorpayPaymentMethodName)[keyof typeof RazorpayPaymentMethodName];

/** Subscription webhook events (fact sheet 9.1). There is no `subscription.created` or `subscription.expired`. */
export const RazorpayWebhookEvent = {
  Authenticated: 'subscription.authenticated',
  Activated: 'subscription.activated',
  Charged: 'subscription.charged',
  Completed: 'subscription.completed',
  Updated: 'subscription.updated',
  Pending: 'subscription.pending',
  Halted: 'subscription.halted',
  Cancelled: 'subscription.cancelled',
  Paused: 'subscription.paused',
  Resumed: 'subscription.resumed',
} as const;
export type RazorpayWebhookEvent = (typeof RazorpayWebhookEvent)[keyof typeof RazorpayWebhookEvent];

/**
 * Razorpay has no merchant reference, merchant plan id or per-plan cycle cap,
 * so this adapter keeps them in `notes` under these keys and reads them back.
 * The keys are reserved: caller metadata may not use them.
 */
export const RazorpayNoteKey = {
  /** `CreateSubscriptionInput.reference`, read back into `Subscription.reference`. */
  Reference: 'india_subscriptions_reference',
  /** `CreatePlanInput.id`: Razorpay generates its own plan id, so the requested one is only recorded. */
  RequestedPlanId: 'india_subscriptions_plan_id',
  /** `CreatePlanInput.maxCycles`: Razorpay plans have no cycle cap; used as the default `total_count`. */
  PlanMaxCycles: 'india_subscriptions_plan_max_cycles',
  /** `RefundInput.refundId`, also sent as the refund `receipt`. */
  RefundReference: 'india_subscriptions_refund_id',
  RefundReason: 'india_subscriptions_refund_reason',
} as const;
export type RazorpayNoteKey = (typeof RazorpayNoteKey)[keyof typeof RazorpayNoteKey];

/** Keys callers may not use in `metadata`: the adapter owns them. */
export const RAZORPAY_RESERVED_NOTE_KEYS: readonly string[] = Object.values(RazorpayNoteKey);

/**
 * Optional extra key a caller may add to the checkout result passed to
 * `verifyCheckout`: the subscription id read from the caller's own storage.
 * The docs say to sign with the stored id, "Do not use the
 * razorpay_subscription_id returned by Checkout" (fact sheet 6.4).
 */
export const RAZORPAY_EXPECTED_SUBSCRIPTION_ID_KEY = 'expected_subscription_id';

/** Id prefixes (fact sheet 1.7). */
export const RazorpayIdPrefix = {
  Payment: 'pay_',
  Invoice: 'inv_',
} as const;

// ---------------------------------------------------------------------------
// Documented limits
// ---------------------------------------------------------------------------

/** "maximum of 15 key-value pairs" (create plan / create subscription). */
export const RAZORPAY_MAX_NOTES = 15;
/** "For daily plans, the minimum value should be 7." (API page; the product page says "greater than 7", 12.1 #6). */
export const RAZORPAY_MIN_DAILY_INTERVAL = 7;
/** "The amount must be at least INR 1.00." */
export const RAZORPAY_MIN_AMOUNT_PAISE = 100;
/** "The amount must be valid integer between 0 and 4294967295." */
export const RAZORPAY_MAX_AMOUNT_PAISE = 4_294_967_295;
/** Maximum `count` on list endpoints. */
export const RAZORPAY_PAGE_SIZE = 100;
/** Safety stop when paging invoices; a subscription cannot plausibly have more pages than this. */
export const RAZORPAY_MAX_INVOICE_PAGES = 50;

/**
 * Default length of a "bill until cancelled" subscription. The docs
 * contradict each other on the maximum duration (12.1 #7): 100 years (API
 * pages), 30 years (Dashboard page), 10 years (checkout error table: "Currently,
 * you can only charge a Subscription for up to 10 years."). The most
 * conservative of the three is the default.
 */
export const RAZORPAY_DEFAULT_DURATION_YEARS = 10;
/** Upper bound accepted for `defaultDurationYears`: the largest figure the docs state. */
export const RAZORPAY_MAX_DURATION_YEARS = 100;

/** Label of the upfront add-on when the caller gives none. */
export const RAZORPAY_DEFAULT_UPFRONT_LABEL = 'Upfront amount';

/** Razorpay writes the literal "NA" into error fields it does not fill (fact sheet 1.9). */
export const RAZORPAY_NOT_APPLICABLE = 'NA';

/**
 * Razorpay answers most failures with HTTP 400 and `BAD_REQUEST_ERROR`, so the
 * generic status mapping would call a missing id or a bad key a validation
 * error. The only machine-readable signal is the description text (fact sheet
 * 1.9), so these documented descriptions refine a 400 into a precise code.
 * Order matters: the first match wins. "The requested URL was not found on the
 * server." (Subscriptions feature not enabled) deliberately matches nothing.
 */
export const RAZORPAY_ERROR_DESCRIPTION_RULES: readonly { readonly pattern: RegExp; readonly code: ErrorCode }[] = [
  { pattern: /api key.*invalid|key\/secret.*invalid|authentication failed/i, code: ErrorCode.Auth },
  { pattern: /another subscription operation is in progress/i, code: ErrorCode.Conflict },
  { pattern: /could not be found|id provided does not exist|is not a valid id/i, code: ErrorCode.NotFound },
];
