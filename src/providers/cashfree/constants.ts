import {
  ChargeKind,
  ChargeStatus,
  Environment,
  EventType,
  IntervalUnit,
  PaymentMethod,
  PaymentStatus,
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

/** `x-idempotency-key` is `format: UUID` [openapi parameters.idempotencyKey]. */
export const IDEMPOTENCY_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  /** Create an order [orders-create]. */
  Orders: '/orders',
  /** Get an order [orders-get]. */
  order: (orderId: string) => `/orders/${enc(orderId)}`,
  /** Payment attempts of an order [payments-for-order]. */
  orderPayments: (orderId: string) => `/orders/${enc(orderId)}/payments`,
  /** Create a refund (POST) or list the refunds (GET) of an order [refund-create] [refunds-list]. */
  orderRefunds: (orderId: string) => `/orders/${enc(orderId)}/refunds`,
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

/** The payment methods a Cashfree subscription can be authorised with; net banking and wallets are one-time payment methods. */
export type CashfreeMandateMethod = Exclude<PaymentMethod, typeof PaymentMethod.NetBanking | typeof PaymentMethod.Wallet>;

export const PAYMENT_METHOD_TO_REQUEST_METHOD: Record<CashfreeMandateMethod, CashfreeRequestMethod> = {
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

// ---------------------------------------------------------------------------
// One-time payments: orders, payment attempts, refunds
// Source tags are the one-time fact sheet's: [orders-create], [orders-get],
// [payments-for-order], [refund-create], [refunds-list], [web], [webhooks-payments],
// [webhooks-refunds], [lifecycle], [idem].
// ---------------------------------------------------------------------------

/** `Payment.id` is the Cashfree `order_id`: every order, payment-list and refund endpoint is keyed on it. */
export const GENERATED_ORDER_ID_PREFIX = 'order_';
/** Customer id derived from the phone number when the caller supplies none; Cashfree requires a `customer_id`. */
export const DERIVED_CUSTOMER_ID_PREFIX = 'cust_';

/** `order_id`: 3-45 characters, "alphanumeric characters, underscores (_), and hyphens (-)" [orders-create]. */
export const ORDER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
export const ORDER_ID_MIN_LENGTH = 3;
export const ORDER_ID_MAX_LENGTH = 45;

/** `customer_id`: "alphanumeric", 3-50 [orders-create]; the samples also use `_` and `-`. */
export const CUSTOMER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
export const CUSTOMER_ID_MIN_LENGTH = 3;
export const CUSTOMER_ID_MAX_LENGTH = 50;

/** `customer_name` 3-100 and `customer_email` 3-100 [orders-create]. */
export const CUSTOMER_NAME_MIN_LENGTH = 3;
export const CUSTOMER_NAME_MAX_LENGTH = 100;
export const CUSTOMER_EMAIL_MIN_LENGTH = 3;
export const CUSTOMER_EMAIL_MAX_LENGTH = 100;

/** `order_note` 3-200 [orders-create]. */
export const ORDER_NOTE_MIN_LENGTH = 3;
export const ORDER_NOTE_MAX_LENGTH = 200;

/** `order_tags`: "A maximum of 10 tags can be added" (the schema says 15; the stricter text is used), values 1-255. */
export const MAX_ORDER_TAGS = 10;
export const ORDER_TAG_VALUE_MIN_LENGTH = 1;
export const ORDER_TAG_VALUE_MAX_LENGTH = 255;

/** `order_amount` has `minimum: 1` (one rupee) [orders-create]. */
export const MIN_ORDER_PAISE = 100;

/** `return_url`: "Maximum URL length: 250 characters" [orders-create]. */
export const RETURN_URL_MAX_LENGTH = 250;
/**
 * The query parameter that carries the order id back to the merchant. Cashfree documents no parameters of its own on the
 * return URL and says to "add context of the order in your return URL"; every sample uses `?order_id=` [web].
 */
export const RETURN_URL_ORDER_ID_PARAM = 'order_id';

/** `refund_id`: 3-40 alphanumeric; the samples contain `_` and `-` [refund-create]. */
export const REFUND_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
export const REFUND_ID_MIN_LENGTH = 3;
export const REFUND_ID_MAX_LENGTH = 40;
/** `refund_note` 3-100 [refund-create]. */
export const REFUND_NOTE_MIN_LENGTH = 3;
export const REFUND_NOTE_MAX_LENGTH = 100;

/** `order_status` [orders-create] [lifecycle]. */
export const CashfreeOrderStatus = {
  Active: 'ACTIVE',
  Paid: 'PAID',
  Expired: 'EXPIRED',
  Terminated: 'TERMINATED',
  TerminationRequested: 'TERMINATION_REQUESTED',
} as const;
export type CashfreeOrderStatus = (typeof CashfreeOrderStatus)[keyof typeof CashfreeOrderStatus];

/**
 * The order decides the payment's status, not any one attempt: a customer may retry a failed attempt until the order ends
 * [idem]. ACTIVE is `created` (the adapter reads it as `pending` when an attempt is in flight, and `getPayment` keeps its
 * failed attempts in `raw`). EXPIRED means nothing was paid in time and no attempt can start [lifecycle]. TERMINATED is
 * "Once terminated, customers can no longer pay for this order" and is `cancelled`. TERMINATION_REQUESTED can still turn
 * into a success [lifecycle], so it is `pending`.
 */
export const ORDER_STATUS_MAP: Record<CashfreeOrderStatus, PaymentStatus> = {
  [CashfreeOrderStatus.Active]: PaymentStatus.Created,
  [CashfreeOrderStatus.Paid]: PaymentStatus.Succeeded,
  [CashfreeOrderStatus.Expired]: PaymentStatus.Failed,
  [CashfreeOrderStatus.Terminated]: PaymentStatus.Cancelled,
  [CashfreeOrderStatus.TerminationRequested]: PaymentStatus.Pending,
};

/**
 * An `order_status` Cashfree adds tomorrow maps to `Pending`: money may or may not have moved, so it must neither unlock
 * anything (`Succeeded`) nor end the payment (`Failed`). Callers re-fetch it. The verbatim value stays in `providerStatus`.
 */
export const UNKNOWN_ORDER_STATUS_FALLBACK: PaymentStatus = PaymentStatus.Pending;

/** `payment_status` of one payment attempt [payments-for-order] [lifecycle]. */
export const CashfreeAttemptStatus = {
  Success: 'SUCCESS',
  NotAttempted: 'NOT_ATTEMPTED',
  Failed: 'FAILED',
  UserDropped: 'USER_DROPPED',
  Void: 'VOID',
  Cancelled: 'CANCELLED',
  Pending: 'PENDING',
  Flagged: 'FLAGGED',
} as const;
export type CashfreeAttemptStatus = (typeof CashfreeAttemptStatus)[keyof typeof CashfreeAttemptStatus];

/**
 * An attempt's status as a payment status (used for webhook events, which describe one attempt). NOT_ATTEMPTED is the
 * "initial state for a payment attempt": nothing has moved yet. PENDING and FLAGGED are in flight ("Do not fulfil orders
 * in this state"; FLAGGED waits for the merchant to approve or reject). CANCELLED is a reversal of a late success, VOID a
 * capture that was explicitly not taken, USER_DROPPED an abandoned attempt: none of them holds money.
 */
export const ATTEMPT_STATUS_MAP: Record<CashfreeAttemptStatus, PaymentStatus> = {
  [CashfreeAttemptStatus.Success]: PaymentStatus.Succeeded,
  [CashfreeAttemptStatus.NotAttempted]: PaymentStatus.Created,
  [CashfreeAttemptStatus.Failed]: PaymentStatus.Failed,
  [CashfreeAttemptStatus.UserDropped]: PaymentStatus.Cancelled,
  [CashfreeAttemptStatus.Void]: PaymentStatus.Cancelled,
  [CashfreeAttemptStatus.Cancelled]: PaymentStatus.Cancelled,
  [CashfreeAttemptStatus.Pending]: PaymentStatus.Pending,
  [CashfreeAttemptStatus.Flagged]: PaymentStatus.Pending,
};

/** An unrecognised attempt status is treated as in flight; see `UNKNOWN_ORDER_STATUS_FALLBACK`. */
export const UNKNOWN_ATTEMPT_STATUS_FALLBACK: PaymentStatus = PaymentStatus.Pending;

/** `payment_group` values and the unified method they belong to [payments-for-order]. Groups with no unified method are left out. */
export const PAYMENT_GROUP_TO_METHOD: Record<string, PaymentMethod> = {
  upi: PaymentMethod.Upi,
  upi_credit_card: PaymentMethod.Upi,
  upi_ppi: PaymentMethod.Upi,
  upi_ppi_offline: PaymentMethod.Upi,
  credit_card: PaymentMethod.Card,
  debit_card: PaymentMethod.Card,
  prepaid_card: PaymentMethod.Card,
  credit_card_emi: PaymentMethod.Card,
  debit_card_emi: PaymentMethod.Card,
  net_banking: PaymentMethod.NetBanking,
  wallet: PaymentMethod.Wallet,
};

/** Keys of the `payment_method` object [payments-for-order] and the unified method each implies when `payment_group` is absent. */
export const PAYMENT_METHOD_KEY_TO_METHOD: Record<string, PaymentMethod> = {
  upi: PaymentMethod.Upi,
  card: PaymentMethod.Card,
  emi: PaymentMethod.Card,
  netbanking: PaymentMethod.NetBanking,
};

/** `order_meta.payment_methods_filters.methods.action`: "It accepts value of ALLOW" [orders-create]. */
export const CashfreeFilterAction = {
  Allow: 'ALLOW',
} as const;
export type CashfreeFilterAction = (typeof CashfreeFilterAction)[keyof typeof CashfreeFilterAction];

/** The filter values the documentation lists under their own names [orders-create]. */
export const CashfreeFilterMethod = {
  Upi: 'upi',
  CreditCard: 'credit_card',
  DebitCard: 'debit_card',
  PrepaidCard: 'prepaid_card',
  NetBanking: 'netbanking',
  Wallet: 'wallet',
} as const;
export type CashfreeFilterMethod = (typeof CashfreeFilterMethod)[keyof typeof CashfreeFilterMethod];

/** What a one-time payment can be restricted to. A card is every kind of card the checkout offers. */
export const ORDER_PAYMENT_METHODS = [
  PaymentMethod.Upi,
  PaymentMethod.Card,
  PaymentMethod.NetBanking,
  PaymentMethod.Wallet,
] as const;
export type OrderPaymentMethod = (typeof ORDER_PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_TO_FILTER_VALUES: Record<OrderPaymentMethod, CashfreeFilterMethod[]> = {
  [PaymentMethod.Upi]: [CashfreeFilterMethod.Upi],
  [PaymentMethod.Card]: [CashfreeFilterMethod.CreditCard, CashfreeFilterMethod.DebitCard, CashfreeFilterMethod.PrepaidCard],
  [PaymentMethod.NetBanking]: [CashfreeFilterMethod.NetBanking],
  [PaymentMethod.Wallet]: [CashfreeFilterMethod.Wallet],
};

/** `refund_status` of an order refund [refund-create]. */
export const CashfreeOrderRefundStatus = {
  Success: 'SUCCESS',
  Pending: 'PENDING',
  PendingApproval: 'PENDING_APPROVAL',
  Cancelled: 'CANCELLED',
  OnHold: 'ONHOLD',
  Rejected: 'REJECTED',
} as const;
export type CashfreeOrderRefundStatus = (typeof CashfreeOrderRefundStatus)[keyof typeof CashfreeOrderRefundStatus];

export const ORDER_REFUND_STATUS_MAP: Record<CashfreeOrderRefundStatus, RefundStatus> = {
  [CashfreeOrderRefundStatus.Success]: RefundStatus.Succeeded,
  [CashfreeOrderRefundStatus.Pending]: RefundStatus.Pending,
  [CashfreeOrderRefundStatus.PendingApproval]: RefundStatus.Pending,
  [CashfreeOrderRefundStatus.OnHold]: RefundStatus.Pending,
  [CashfreeOrderRefundStatus.Cancelled]: RefundStatus.Failed,
  [CashfreeOrderRefundStatus.Rejected]: RefundStatus.Failed,
};

/** An unrecognised refund status is unresolved, not failed: the money may still move. */
export const UNKNOWN_ORDER_REFUND_STATUS_FALLBACK: RefundStatus = RefundStatus.Pending;

/**
 * Webhook event for a refund's status. A cancelled refund is "unable to successfully refund to customer even after
 * multiple attempts" [webhooks-refunds]. A status that is still moving is not an outcome, so it stays `unknown`.
 */
export const ORDER_REFUND_EVENT_MAP: Record<CashfreeOrderRefundStatus, EventType> = {
  [CashfreeOrderRefundStatus.Success]: EventType.RefundSucceeded,
  [CashfreeOrderRefundStatus.Cancelled]: EventType.RefundFailed,
  [CashfreeOrderRefundStatus.Rejected]: EventType.RefundFailed,
  [CashfreeOrderRefundStatus.Pending]: EventType.Unknown,
  [CashfreeOrderRefundStatus.PendingApproval]: EventType.Unknown,
  [CashfreeOrderRefundStatus.OnHold]: EventType.Unknown,
};

/**
 * `type` of the payment-gateway webhooks [webhooks-payments] [webhooks-refunds]. Every subscription webhook type starts
 * with `SUBSCRIPTION_`, so the two families never share a name.
 */
export const CashfreeOrderWebhookEvent = {
  PaymentSuccess: 'PAYMENT_SUCCESS_WEBHOOK',
  PaymentFailed: 'PAYMENT_FAILED_WEBHOOK',
  PaymentUserDropped: 'PAYMENT_USER_DROPPED_WEBHOOK',
  PaymentCharges: 'PAYMENT_CHARGES_WEBHOOK',
  RefundStatus: 'REFUND_STATUS_WEBHOOK',
  AutoRefundStatus: 'AUTO_REFUND_STATUS_WEBHOOK',
} as const;
export type CashfreeOrderWebhookEvent = (typeof CashfreeOrderWebhookEvent)[keyof typeof CashfreeOrderWebhookEvent];

/**
 * A failed or abandoned attempt is `payment.failed`: the order stays payable until it ends [idem], so the event reports
 * the attempt and `getPayment` is the source of truth for the order. The charges webhook only reports fees, and the
 * auto-refund webhook refunds an extra payment, not the order's own payment, so those stay `unknown`.
 */
export const ORDER_PAYMENT_EVENT_MAP: Record<string, EventType> = {
  [CashfreeOrderWebhookEvent.PaymentSuccess]: EventType.PaymentSucceeded,
  [CashfreeOrderWebhookEvent.PaymentFailed]: EventType.PaymentFailed,
  [CashfreeOrderWebhookEvent.PaymentUserDropped]: EventType.PaymentFailed,
  [CashfreeOrderWebhookEvent.PaymentCharges]: EventType.Unknown,
};
