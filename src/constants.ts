/**
 * Every string that carries meaning lives here as a typed constant.
 * Code elsewhere must reference these (`SubscriptionStatus.Active`), never the
 * bare literal (`'active'`).
 *
 * Each constant is an `as const` object plus a union type of the same name, so
 * `SubscriptionStatus` works both as a value namespace and as a type.
 */

export const Provider = {
  Razorpay: 'razorpay',
  Cashfree: 'cashfree',
  PayU: 'payu',
} as const;
export type Provider = (typeof Provider)[keyof typeof Provider];

export const Currency = {
  INR: 'INR',
} as const;
export type Currency = (typeof Currency)[keyof typeof Currency];

export const IntervalUnit = {
  Day: 'day',
  Week: 'week',
  Month: 'month',
  Year: 'year',
} as const;
export type IntervalUnit = (typeof IntervalUnit)[keyof typeof IntervalUnit];

/** Who decides when each recurring debit happens. */
export const SchedulingMode = {
  /** The gateway raises every charge on the plan's schedule. */
  Gateway: 'gateway',
  /** The merchant (this library's scheduler) raises each charge. */
  Merchant: 'merchant',
} as const;
export type SchedulingMode = (typeof SchedulingMode)[keyof typeof SchedulingMode];

/**
 * Normalised subscription lifecycle. Each gateway's own status is preserved
 * verbatim in `Subscription.providerStatus`.
 */
export const SubscriptionStatus = {
  /** Created, the customer has not authorised the mandate yet. */
  Created: 'created',
  /** The customer approved; the bank or NPCI has not confirmed the mandate yet. */
  PendingAuthorization: 'pending_authorization',
  /** Mandate is live and the first charge is scheduled for the future (free trial or delayed start). */
  Trialing: 'trialing',
  /** Mandate is live and charges are being collected. */
  Active: 'active',
  /** A charge failed and is being retried; the subscription is still alive. */
  PastDue: 'past_due',
  /** Retries are exhausted; no further automatic charges until the merchant or customer acts. */
  Halted: 'halted',
  /** Charging is paused by the merchant or the customer; can be resumed. */
  Paused: 'paused',
  /** Ended by the merchant, the customer or the bank. Terminal. */
  Cancelled: 'cancelled',
  /** All billing cycles were collected. Terminal. */
  Completed: 'completed',
  /** The authorisation link or the mandate lapsed. Terminal. */
  Expired: 'expired',
  /** Mandate setup was rejected or failed. Terminal. */
  Failed: 'failed',
} as const;
export type SubscriptionStatus = (typeof SubscriptionStatus)[keyof typeof SubscriptionStatus];

export const TERMINAL_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  SubscriptionStatus.Cancelled,
  SubscriptionStatus.Completed,
  SubscriptionStatus.Expired,
  SubscriptionStatus.Failed,
];

export const ChargeStatus = {
  /** Scheduled or announced to the customer (pre-debit notification), not yet attempted. */
  Scheduled: 'scheduled',
  /** Sent to the bank; final result not known yet. */
  Pending: 'pending',
  Succeeded: 'succeeded',
  Failed: 'failed',
  Cancelled: 'cancelled',
  Refunded: 'refunded',
  PartiallyRefunded: 'partially_refunded',
} as const;
export type ChargeStatus = (typeof ChargeStatus)[keyof typeof ChargeStatus];

export const ChargeKind = {
  /** The small verification debit taken when the mandate is set up. */
  Authorization: 'authorization',
  /** A recurring debit for a billing cycle. */
  Recurring: 'recurring',
  /** A one-off amount such as a setup fee or add-on. */
  Upfront: 'upfront',
} as const;
export type ChargeKind = (typeof ChargeKind)[keyof typeof ChargeKind];

export const RefundStatus = {
  Pending: 'pending',
  Succeeded: 'succeeded',
  Failed: 'failed',
} as const;
export type RefundStatus = (typeof RefundStatus)[keyof typeof RefundStatus];

export const PaymentMethod = {
  /** UPI Autopay mandate. */
  Upi: 'upi',
  /** Card standing instruction (e-mandate on card). */
  Card: 'card',
  /** eNACH / e-mandate on a bank account (net banking, debit card or Aadhaar authenticated). */
  ENach: 'enach',
  /** Paper NACH mandate. */
  PhysicalNach: 'physical_nach',
} as const;
export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod];

export const CancelMode = {
  /** Stop now; no further charges. */
  Immediately: 'immediately',
  /** Keep the current paid period, then stop. */
  AtPeriodEnd: 'at_period_end',
} as const;
export type CancelMode = (typeof CancelMode)[keyof typeof CancelMode];

export const ChangeTiming = {
  Immediately: 'immediately',
  AtPeriodEnd: 'at_period_end',
} as const;
export type ChangeTiming = (typeof ChangeTiming)[keyof typeof ChangeTiming];

/** How the customer's browser or app completes mandate authorisation. */
export const CheckoutKind = {
  /** Send the customer to a URL. */
  Redirect: 'redirect',
  /** Auto-submit an HTML form with the given fields to the gateway. */
  FormPost: 'form_post',
  /** Open Razorpay Standard Checkout with a subscription id. */
  RazorpayCheckout: 'razorpay_checkout',
  /** Call Cashfree.js `subscriptionsCheckout` with a session id. */
  CashfreeCheckout: 'cashfree_checkout',
} as const;
export type CheckoutKind = (typeof CheckoutKind)[keyof typeof CheckoutKind];

/** Normalised webhook / lifecycle events. */
export const EventType = {
  SubscriptionAuthorized: 'subscription.authorized',
  SubscriptionAuthorizationFailed: 'subscription.authorization_failed',
  SubscriptionActivated: 'subscription.activated',
  SubscriptionCharged: 'subscription.charged',
  SubscriptionChargeFailed: 'subscription.charge_failed',
  SubscriptionChargeScheduled: 'subscription.charge_scheduled',
  SubscriptionPastDue: 'subscription.past_due',
  SubscriptionHalted: 'subscription.halted',
  SubscriptionPaused: 'subscription.paused',
  SubscriptionResumed: 'subscription.resumed',
  SubscriptionUpdated: 'subscription.updated',
  SubscriptionCancelled: 'subscription.cancelled',
  SubscriptionCompleted: 'subscription.completed',
  SubscriptionExpired: 'subscription.expired',
  RefundSucceeded: 'refund.succeeded',
  RefundFailed: 'refund.failed',
  /** A verified event this library does not normalise; inspect `raw`. */
  Unknown: 'unknown',
} as const;
export type EventType = (typeof EventType)[keyof typeof EventType];

/**
 * Stable error codes. Branch on these, never on messages.
 *
 * `OutcomeUnknown` matters most: a money-moving request was sent but no answer
 * came back. It may or may not have taken effect, so fetch the current state
 * before retrying.
 */
export const ErrorCode = {
  Config: 'CONFIG',
  Validation: 'VALIDATION',
  Unsupported: 'UNSUPPORTED',
  NotFound: 'NOT_FOUND',
  Auth: 'AUTH',
  Conflict: 'CONFLICT',
  RateLimited: 'RATE_LIMITED',
  ProviderError: 'PROVIDER_ERROR',
  ProviderUnavailable: 'PROVIDER_UNAVAILABLE',
  /** The gateway answered with a body this library could not validate. */
  UnexpectedResponse: 'UNEXPECTED_RESPONSE',
  Network: 'NETWORK',
  Timeout: 'TIMEOUT',
  OutcomeUnknown: 'OUTCOME_UNKNOWN',
  SignatureInvalid: 'SIGNATURE_INVALID',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const HttpMethod = {
  Get: 'GET',
  Post: 'POST',
  Patch: 'PATCH',
  Put: 'PUT',
  Delete: 'DELETE',
} as const;
export type HttpMethod = (typeof HttpMethod)[keyof typeof HttpMethod];

export const HeaderName = {
  Authorization: 'authorization',
  ContentType: 'content-type',
  Accept: 'accept',
  UserAgent: 'user-agent',
} as const;
export type HeaderName = (typeof HeaderName)[keyof typeof HeaderName];

export const ContentType = {
  Json: 'application/json',
  Form: 'application/x-www-form-urlencoded',
} as const;
export type ContentType = (typeof ContentType)[keyof typeof ContentType];

export const HashAlgorithm = {
  Sha256: 'sha256',
  Sha512: 'sha512',
} as const;
export type HashAlgorithm = (typeof HashAlgorithm)[keyof typeof HashAlgorithm];

export const DigestEncoding = {
  Hex: 'hex',
  Base64: 'base64',
} as const;
export type DigestEncoding = (typeof DigestEncoding)[keyof typeof DigestEncoding];

export const Environment = {
  /** Gateway sandbox / test mode. */
  Test: 'test',
  /** Live money. */
  Live: 'live',
} as const;
export type Environment = (typeof Environment)[keyof typeof Environment];
