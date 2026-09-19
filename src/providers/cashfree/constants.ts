import {
  ChargeKind,
  ChargeStatus,
  Environment,
  EventType,
  IntervalUnit,
  PaymentMethod,
  RefundStatus,
  SchedulingMode,
  SubscriptionStatus,
} from '../../constants.js';

/**
 * Cashfree Payments (Subscriptions) constants. Every string that is sent to or
 * received from Cashfree is named here; JSON field names live in `schemas.ts`.
 * Sources are the fact sheet's tags: [openapi] = openapi-v2026-01-01.yaml,
 * [guide:x] / [api:x] = the documentation pages.
 */

// ---------------------------------------------------------------------------
// Hosts, versions, headers
// ---------------------------------------------------------------------------

/** [openapi servers] [sdk:api.ts] */
export const CASHFREE_BASE_URLS: Record<Environment, string> = {
  [Environment.Test]: 'https://sandbox.cashfree.com/pg',
  [Environment.Live]: 'https://api.cashfree.com/pg',
};

/** [openapi parameters.apiVersionHeader default] [sdk:api.ts XApiVersion] */
export const CASHFREE_API_VERSION = '2026-01-01';

/** `YYYY-MM-DD` [openapi parameters.apiVersionHeader]. */
export const API_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const CashfreeHeader = {
  ClientId: 'x-client-id',
  ClientSecret: 'x-client-secret',
  ApiVersion: 'x-api-version',
  IdempotencyKey: 'x-idempotency-key',
  /** [guide:webhook-signature] */
  WebhookSignature: 'x-webhook-signature',
  /** [guide:webhook-signature] */
  WebhookTimestamp: 'x-webhook-timestamp',
} as const;
export type CashfreeHeader = (typeof CashfreeHeader)[keyof typeof CashfreeHeader];

// ---------------------------------------------------------------------------
// Endpoints (relative to the base URL) [openapi]
// ---------------------------------------------------------------------------

const enc = encodeURIComponent;

export const CashfreePath = {
  Plans: '/plans',
  plan: (planId: string) => `/plans/${enc(planId)}`,
  Subscriptions: '/subscriptions',
  subscription: (subscriptionId: string) => `/subscriptions/${enc(subscriptionId)}`,
  manageSubscription: (subscriptionId: string) => `/subscriptions/${enc(subscriptionId)}/manage`,
  /** Raise a charge (`payment_type: CHARGE`) or create an auth. */
  Pay: '/subscriptions/pay',
  payments: (subscriptionId: string) => `/subscriptions/${enc(subscriptionId)}/payments`,
  payment: (subscriptionId: string, paymentId: string) =>
    `/subscriptions/${enc(subscriptionId)}/payments/${enc(paymentId)}`,
  refunds: (subscriptionId: string) => `/subscriptions/${enc(subscriptionId)}/refunds`,
} as const;

// ---------------------------------------------------------------------------
// Enumerations Cashfree sends or receives
// ---------------------------------------------------------------------------

export const CashfreePlanType = {
  Periodic: 'PERIODIC',
  OnDemand: 'ON_DEMAND',
} as const;
export type CashfreePlanType = (typeof CashfreePlanType)[keyof typeof CashfreePlanType];

/** Who raises each charge: PERIODIC = Cashfree, ON_DEMAND = the merchant. [openapi plan_type] */
export const SCHEDULING_TO_PLAN_TYPE: Record<SchedulingMode, CashfreePlanType> = {
  [SchedulingMode.Gateway]: CashfreePlanType.Periodic,
  [SchedulingMode.Merchant]: CashfreePlanType.OnDemand,
};

export const CashfreeIntervalType = {
  Day: 'DAY',
  Week: 'WEEK',
  Month: 'MONTH',
  Year: 'YEAR',
} as const;
export type CashfreeIntervalType = (typeof CashfreeIntervalType)[keyof typeof CashfreeIntervalType];

export const INTERVAL_UNIT_TO_CASHFREE: Record<IntervalUnit, CashfreeIntervalType> = {
  [IntervalUnit.Day]: CashfreeIntervalType.Day,
  [IntervalUnit.Week]: CashfreeIntervalType.Week,
  [IntervalUnit.Month]: CashfreeIntervalType.Month,
  [IntervalUnit.Year]: CashfreeIntervalType.Year,
};

export const CASHFREE_TO_INTERVAL_UNIT: Record<CashfreeIntervalType, IntervalUnit> = {
  [CashfreeIntervalType.Day]: IntervalUnit.Day,
  [CashfreeIntervalType.Week]: IntervalUnit.Week,
  [CashfreeIntervalType.Month]: IntervalUnit.Month,
  [CashfreeIntervalType.Year]: IntervalUnit.Year,
};

/** `subscription_status` values [guide:create]. */
export const CashfreeSubscriptionStatus = {
  Initialized: 'INITIALIZED',
  BankApprovalPending: 'BANK_APPROVAL_PENDING',
  Active: 'ACTIVE',
  OnHold: 'ON_HOLD',
  Paused: 'PAUSED',
  CustomerPaused: 'CUSTOMER_PAUSED',
  Completed: 'COMPLETED',
  CustomerCancelled: 'CUSTOMER_CANCELLED',
  Cancelled: 'CANCELLED',
  Expired: 'EXPIRED',
  LinkExpired: 'LINK_EXPIRED',
  CardExpired: 'CARD_EXPIRED',
} as const;
export type CashfreeSubscriptionStatus = (typeof CashfreeSubscriptionStatus)[keyof typeof CashfreeSubscriptionStatus];

export const SUBSCRIPTION_STATUS_MAP: Record<CashfreeSubscriptionStatus, SubscriptionStatus> = {
  [CashfreeSubscriptionStatus.Initialized]: SubscriptionStatus.Created,
  [CashfreeSubscriptionStatus.BankApprovalPending]: SubscriptionStatus.PendingAuthorization,
  // ACTIVE becomes Trialing in the mapper while the first charge is still in the future.
  [CashfreeSubscriptionStatus.Active]: SubscriptionStatus.Active,
  [CashfreeSubscriptionStatus.OnHold]: SubscriptionStatus.Halted,
  [CashfreeSubscriptionStatus.Paused]: SubscriptionStatus.Paused,
  [CashfreeSubscriptionStatus.CustomerPaused]: SubscriptionStatus.Paused,
  [CashfreeSubscriptionStatus.Completed]: SubscriptionStatus.Completed,
  [CashfreeSubscriptionStatus.CustomerCancelled]: SubscriptionStatus.Cancelled,
  [CashfreeSubscriptionStatus.Cancelled]: SubscriptionStatus.Cancelled,
  [CashfreeSubscriptionStatus.Expired]: SubscriptionStatus.Expired,
  [CashfreeSubscriptionStatus.LinkExpired]: SubscriptionStatus.Expired,
  [CashfreeSubscriptionStatus.CardExpired]: SubscriptionStatus.Expired,
};

/**
 * A `subscription_status` Cashfree adds tomorrow maps to `Created`. That is the
 * safe direction: `Created` is a non-charging state, so a scheduler that sees
 * it waits instead of raising debits. The verbatim value stays in `providerStatus`.
 */
export const UNKNOWN_SUBSCRIPTION_STATUS_FALLBACK: SubscriptionStatus = SubscriptionStatus.Created;

/** `payment_status` values [guide:charge]. */
export const CashfreePaymentStatus = {
  Initialized: 'INITIALIZED',
  Pending: 'PENDING',
  Success: 'SUCCESS',
  Failed: 'FAILED',
  Cancelled: 'CANCELLED',
} as const;
export type CashfreePaymentStatus = (typeof CashfreePaymentStatus)[keyof typeof CashfreePaymentStatus];

export const PAYMENT_STATUS_MAP: Record<CashfreePaymentStatus, ChargeStatus> = {
  [CashfreePaymentStatus.Initialized]: ChargeStatus.Scheduled,
  [CashfreePaymentStatus.Pending]: ChargeStatus.Pending,
  [CashfreePaymentStatus.Success]: ChargeStatus.Succeeded,
  [CashfreePaymentStatus.Failed]: ChargeStatus.Failed,
  [CashfreePaymentStatus.Cancelled]: ChargeStatus.Cancelled,
};

/**
 * An unrecognised `payment_status` maps to `Pending`: money may or may not
 * have moved, so it must neither count as collected (`Succeeded`) nor trigger
 * a retry (`Failed`, which would risk a double debit). Callers re-fetch it.
 */
export const UNKNOWN_PAYMENT_STATUS_FALLBACK: ChargeStatus = ChargeStatus.Pending;

/** `payment_type` [openapi]. */
export const CashfreePaymentType = {
  Auth: 'AUTH',
  Charge: 'CHARGE',
} as const;
export type CashfreePaymentType = (typeof CashfreePaymentType)[keyof typeof CashfreePaymentType];

export const PAYMENT_TYPE_MAP: Record<CashfreePaymentType, ChargeKind> = {
  [CashfreePaymentType.Auth]: ChargeKind.Authorization,
  [CashfreePaymentType.Charge]: ChargeKind.Recurring,
};

/** An unrecognised `payment_type` is treated as an ordinary debit. */
export const UNKNOWN_PAYMENT_TYPE_FALLBACK: ChargeKind = ChargeKind.Recurring;

/** `refund_status`: "INITIALIZED, SUCCESS, CANCEL, PENDING or FAILED" [openapi]; the webhook text says "cancelled". */
export const CashfreeRefundStatus = {
  Initialized: 'INITIALIZED',
  Success: 'SUCCESS',
  Cancel: 'CANCEL',
  Cancelled: 'CANCELLED',
  Pending: 'PENDING',
  Failed: 'FAILED',
} as const;
export type CashfreeRefundStatus = (typeof CashfreeRefundStatus)[keyof typeof CashfreeRefundStatus];

export const REFUND_STATUS_MAP: Record<CashfreeRefundStatus, RefundStatus> = {
  [CashfreeRefundStatus.Initialized]: RefundStatus.Pending,
  [CashfreeRefundStatus.Success]: RefundStatus.Succeeded,
  [CashfreeRefundStatus.Cancel]: RefundStatus.Failed,
  [CashfreeRefundStatus.Cancelled]: RefundStatus.Failed,
  [CashfreeRefundStatus.Pending]: RefundStatus.Pending,
  [CashfreeRefundStatus.Failed]: RefundStatus.Failed,
};

/** An unrecognised refund status is unresolved, not failed: the money may still move. */
export const UNKNOWN_REFUND_STATUS_FALLBACK: RefundStatus = RefundStatus.Pending;

/** `authorization_status` values seen in docs and samples [guide:create] [guide:webhooks]. */
export const CashfreeAuthorizationStatus = {
  Initialized: 'INITIALIZED',
  Pending: 'PENDING',
  /** The lifecycle table says SUCCESS ... */
  Success: 'SUCCESS',
  /** ... every sample shows ACTIVE for a successful authorisation. */
  Active: 'ACTIVE',
  Failed: 'FAILED',
  DocumentPending: 'DOCUMENT_PENDING',
} as const;
export type CashfreeAuthorizationStatus = (typeof CashfreeAuthorizationStatus)[keyof typeof CashfreeAuthorizationStatus];

/** Payment method keys: request `payment_methods` values, `payment_method` object keys, `payment_group` [openapi]. */
export const CashfreeMethod = {
  Upi: 'upi',
  Card: 'card',
  DebitCard: 'debit_card',
  CreditCard: 'credit_card',
  Enach: 'enach',
  Pnach: 'pnach',
} as const;
export type CashfreeMethod = (typeof CashfreeMethod)[keyof typeof CashfreeMethod];

export const METHOD_TO_PAYMENT_METHOD: Record<CashfreeMethod, PaymentMethod> = {
  [CashfreeMethod.Upi]: PaymentMethod.Upi,
  [CashfreeMethod.Card]: PaymentMethod.Card,
  [CashfreeMethod.DebitCard]: PaymentMethod.Card,
  [CashfreeMethod.CreditCard]: PaymentMethod.Card,
  [CashfreeMethod.Enach]: PaymentMethod.ENach,
  [CashfreeMethod.Pnach]: PaymentMethod.PhysicalNach,
};

/** What this adapter can send in `authorization_details.payment_methods`. */
export type CashfreeRequestMethod =
  | typeof CashfreeMethod.Upi
  | typeof CashfreeMethod.Card
  | typeof CashfreeMethod.Enach
  | typeof CashfreeMethod.Pnach;

export const PAYMENT_METHOD_TO_REQUEST_METHOD: Record<PaymentMethod, CashfreeRequestMethod> = {
  [PaymentMethod.Upi]: CashfreeMethod.Upi,
  [PaymentMethod.Card]: CashfreeMethod.Card,
  [PaymentMethod.ENach]: CashfreeMethod.Enach,
  [PaymentMethod.PhysicalNach]: CashfreeMethod.Pnach,
};

/**
 * Methods the hosted Cashfree checkout offers: "cards, UPI AutoPay, and eNACH"
 * [guide:hosted-checkout]. Physical NACH needs a separate document-upload flow
 * this adapter does not implement.
 */
export const SUPPORTED_PAYMENT_METHODS: PaymentMethod[] = [PaymentMethod.Upi, PaymentMethod.Card, PaymentMethod.ENach];

/** Methods that collect no authorisation amount: "For eNACH, authorization_amount is always 0" [openapi]. */
export const ZERO_AUTHORIZATION_METHODS: PaymentMethod[] = [PaymentMethod.ENach, PaymentMethod.PhysicalNach];

/** Methods an upfront amount can be collected on (UPI and card take a real authorisation amount). */
export const UPFRONT_CAPABLE_METHODS: PaymentMethod[] = [PaymentMethod.Upi, PaymentMethod.Card];

export const ManageAction = {
  Cancel: 'CANCEL',
  Pause: 'PAUSE',
  Activate: 'ACTIVATE',
  ChangePlan: 'CHANGE_PLAN',
} as const;
export type ManageAction = (typeof ManageAction)[keyof typeof ManageAction];

export const CashfreeNotificationChannel = {
  Sms: 'SMS',
  Email: 'EMAIL',
} as const;
export type CashfreeNotificationChannel = (typeof CashfreeNotificationChannel)[keyof typeof CashfreeNotificationChannel];

// ---------------------------------------------------------------------------
// Authorisation amount rules (fact sheet §5.3-5.5)
// ---------------------------------------------------------------------------

/**
 * Minimum authorisation amount for UPI and cards, in paise: "For UPI and card,
 * the minimum value is ₹1" [openapi]. Cashfree takes ₹1 even when ₹0 is sent
 * for UPI [guide:faq].
 */
export const MIN_VERIFICATION_PAISE = 100;

/** eNACH and physical NACH collect nothing at authorisation. */
export const ZERO_AUTHORIZATION_PAISE = 0;

// ---------------------------------------------------------------------------
// Limits and identifier rules [openapi]
// ---------------------------------------------------------------------------

export const PLAN_NAME_MAX_LENGTH = 40;
/** "Only alpha-numerics, dot, hyphen and underscore allowed", max 40. */
export const PLAN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
/** "alphanumeric characters, underscore, dot, hyphen, and space", max 250. */
export const SUBSCRIPTION_ID_PATTERN = /^[A-Za-z0-9_. -]+$/;
export const SUBSCRIPTION_ID_MAX_LENGTH = 250;
/** "You can include up to 10 entries as string key-value pairs." */
export const MAX_SUBSCRIPTION_TAGS = 10;

export const GENERATED_PLAN_ID_PREFIX = 'plan_';
export const GENERATED_SUBSCRIPTION_ID_PREFIX = 'sub_';

// ---------------------------------------------------------------------------
// Merchant-raised charge timing (fact sheet §8.2 cut-off table)
// ---------------------------------------------------------------------------

/**
 * UPI Autopay and Indian cards cannot be debited the same day; T+1 is allowed
 * only when raised before 21:00 IST on T, and T+2..T+14 always. A charge
 * created 48 hours before its debit date therefore lands on T+2 whatever the
 * time of day, which is legal for every method. [guide:charge]
 */
export const MERCHANT_CHARGE_LEAD_HOURS = 48;

/**
 * Furthest ahead a charge may be scheduled. The table allows T+14, the FAQ
 * says "less than 14 days from the request date"; T+13 satisfies both
 * readings. [guide:charge] [guide:faq]
 */
export const MERCHANT_CHARGE_MAX_AHEAD_HOURS = 13 * 24;

/** With no `scheduledAt`, a charge raised at or after this IST hour cannot use T+1 on UPI or cards. */
export const SAME_DAY_CUTOFF_IST_HOUR = 21;

// ---------------------------------------------------------------------------
// Return URL [api:redirection-payload-after-authorization]
// ---------------------------------------------------------------------------

/** The only return-URL parameter that is used: the merchant `subscription_id`. */
export const RETURN_URL_SUBSCRIPTION_ID_PARAM = 'cf_subscriptionId';

// ---------------------------------------------------------------------------
// Webhooks [guide:webhooks]
// ---------------------------------------------------------------------------

export const CashfreeWebhookEvent = {
  SubscriptionStatusChanged: 'SUBSCRIPTION_STATUS_CHANGED',
  SubscriptionAuthStatus: 'SUBSCRIPTION_AUTH_STATUS',
  PaymentNotificationInitiated: 'SUBSCRIPTION_PAYMENT_NOTIFICATION_INITIATED',
  PaymentSuccess: 'SUBSCRIPTION_PAYMENT_SUCCESS',
  PaymentFailed: 'SUBSCRIPTION_PAYMENT_FAILED',
  PaymentCancelled: 'SUBSCRIPTION_PAYMENT_CANCELLED',
  RefundStatus: 'SUBSCRIPTION_REFUND_STATUS',
  CardExpiryReminder: 'SUBSCRIPTION_CARD_EXPIRY_REMINDER',
  ControlledNotificationStatus: 'SUBSCRIPTION_CONTROLLED_NOTIFICATION_STATUS',
  ControlledExecutionStatus: 'SUBSCRIPTION_CONTROLLED_EXECUTION_STATUS',
} as const;
export type CashfreeWebhookEvent = (typeof CashfreeWebhookEvent)[keyof typeof CashfreeWebhookEvent];

/**
 * Event for a `SUBSCRIPTION_STATUS_CHANGED` webhook, by the new status.
 *
 * `Authorized` and `Activated` both make a billing scheduler start raising
 * debits, and Cashfree rejects debits on a mandate that is not ACTIVE. So
 * only ACTIVE maps to `Activated`; BANK_APPROVAL_PENDING (customer done, bank
 * not yet, 24-48 h for eNACH) is `Updated`.
 */
export const STATUS_EVENT_MAP: Record<CashfreeSubscriptionStatus, EventType> = {
  [CashfreeSubscriptionStatus.Initialized]: EventType.SubscriptionUpdated,
  [CashfreeSubscriptionStatus.BankApprovalPending]: EventType.SubscriptionUpdated,
  [CashfreeSubscriptionStatus.Active]: EventType.SubscriptionActivated,
  [CashfreeSubscriptionStatus.OnHold]: EventType.SubscriptionHalted,
  [CashfreeSubscriptionStatus.Paused]: EventType.SubscriptionPaused,
  [CashfreeSubscriptionStatus.CustomerPaused]: EventType.SubscriptionPaused,
  [CashfreeSubscriptionStatus.Completed]: EventType.SubscriptionCompleted,
  [CashfreeSubscriptionStatus.CustomerCancelled]: EventType.SubscriptionCancelled,
  [CashfreeSubscriptionStatus.Cancelled]: EventType.SubscriptionCancelled,
  [CashfreeSubscriptionStatus.Expired]: EventType.SubscriptionExpired,
  [CashfreeSubscriptionStatus.LinkExpired]: EventType.SubscriptionExpired,
  [CashfreeSubscriptionStatus.CardExpired]: EventType.SubscriptionExpired,
};

/** `type` of the 422 body: "Different request body with the same idempotent key" [openapi IdempotencyError]. */
export const CASHFREE_IDEMPOTENCY_ERROR_TYPE = 'idempotency_error';

/** Length of the body hash used as an event id for event types that carry no entity id. */
export const EVENT_ID_HASH_LENGTH = 32;
