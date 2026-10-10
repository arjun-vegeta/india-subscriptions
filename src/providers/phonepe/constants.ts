import {
  ChargeStatus,
  Environment,
  ErrorCode,
  IntervalUnit,
  PaymentMethod,
  PaymentStatus,
  RefundStatus,
  SubscriptionStatus,
} from '../../constants.js';

/**
 * PhonePe Payment Gateway constants for the Standard Checkout family of endpoints (`/checkout/v2/...`): "Autopay"
 * (UPI mandates) and one-time payments. Every string sent to or received from PhonePe is named here; JSON field names live in
 * `schemas.ts`. Source tags are those of the fact sheet: [SC-SETUP] standard-checkout setup page, [SC-ORDER] order
 * status, [SC-SUBSTATUS] subscription status, [SC-NOTIFY] / [SC-EXEC] redemption notify / execute, [SC-CANCEL],
 * [SC-REFUND], [SC-WEBHOOK], [A-AUTH] token API, [A-ERR] Autopay error codes, [G-ERR] common errors, [G-ORDER] generic
 * order status, [G-UATCHECK] UAT checklist, [SDK-*] the official SDKs.
 */

// ---------------------------------------------------------------------------
// Hosts, paths, authentication
// ---------------------------------------------------------------------------

/** The PG host every Autopay API except the token call is under. [A-INTRO "Environments", A-GOLIVE, SDK BaseUrl] */
export const PHONEPE_BASE_URLS: Record<Environment, string> = {
  [Environment.Test]: 'https://api-preprod.phonepe.com/apis/pg-sandbox',
  [Environment.Live]: 'https://api.phonepe.com/apis/pg',
};

/** The OAuth token endpoint. Production lives under a different host than the PG APIs. [A-AUTH, SC-AUTH] */
export const PHONEPE_TOKEN_URLS: Record<Environment, string> = {
  [Environment.Test]: 'https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token',
  [Environment.Live]: 'https://api.phonepe.com/apis/identity-manager/v1/oauth/token',
};

const enc = encodeURIComponent;

/** Paths relative to the PG host. The Standard Checkout family is used throughout. [SC-SETUP, SC-ORDER, ...] */
export const PhonePePath = {
  /** `POST` mandate setup (hosted checkout). [SC-SETUP] */
  Pay: '/checkout/v2/pay',
  /** `GET` status of any order (setup, notification, redemption). [SC-ORDER, SC-NOTIFSTATUS, SC-REDORDER] */
  orderStatus: (merchantOrderId: string) => `/checkout/v2/order/${enc(merchantOrderId)}/status`,
  /** `GET` status of a mandate. [SC-SUBSTATUS] */
  subscriptionStatus: (merchantSubscriptionId: string) => `/checkout/v2/subscriptions/${enc(merchantSubscriptionId)}/status`,
  /** `POST` the mandatory pre-debit notification. [SC-NOTIFY] */
  Notify: '/checkout/v2/subscriptions/notify',
  /** `POST` the debit, after the notification. [SC-EXEC] */
  Redeem: '/checkout/v2/subscriptions/redeem',
  /** `POST` (no body) cancels a mandate; answers 204. [SC-CANCEL] */
  cancelSubscription: (merchantSubscriptionId: string) => `/checkout/v2/subscriptions/${enc(merchantSubscriptionId)}/cancel`,
  /** `POST` a refund. [SC-REFUND] */
  Refund: '/payments/v2/refund',
  /** `GET` a refund. [A-REFUND, SDK refund status] */
  refundStatus: (merchantRefundId: string) => `/payments/v2/refund/${enc(merchantRefundId)}/status`,
} as const;

/** `?details=true`: "return all attempt details under paymentDetails list". [SC-ORDER] */
export const PHONEPE_DETAILS_QUERY = 'details';
export const PHONEPE_DETAILS_ALL = 'true';
/** `?errorContext=true`: "To receive the errorContext block with error details if the state is FAILED". [SCP-STATUS] */
export const PHONEPE_ERROR_CONTEXT_QUERY = 'errorContext';
export const PHONEPE_ERROR_CONTEXT_ALL = 'true';

/** The token is sent as `Authorization: O-Bearer <access_token>`; plain `Bearer` is not the documented form. [A-AUTH, SDK TokenService] */
export const PHONEPE_AUTH_SCHEME = 'O-Bearer';

/** `grant_type` of the token request. [A-AUTH] */
export const PHONEPE_GRANT_TYPE = 'client_credentials';

/**
 * Renew the token this long before its expiry. "Schedule renewal 3-5 minutes before its actual expiry" [G-UATCHECK];
 * the longest of those is used. A token that lives less than twice this is renewed at half its life instead.
 */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Epoch values above this are milliseconds (1e12 ms is 2001; 1e12 s is the year 33,658). */
export const EPOCH_MILLISECONDS_THRESHOLD = 1e12;
/** Epoch seconds above this (2001-09-09) are timestamps; smaller numbers are read as a lifetime in seconds. */
export const EPOCH_SECONDS_THRESHOLD = 1e9;

/** A token response without any expiry is cached for this long only. (ASSUMPTION: [A-AUTH] says `expires_in` is null in its sample.) */
export const TOKEN_FALLBACK_LIFETIME_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Enumerations PhonePe sends or receives
// ---------------------------------------------------------------------------

/** `paymentFlow.type` of the Standard Checkout calls. [SC-SETUP, SC-NOTIFY] */
export const PhonePePaymentFlowType = {
  CheckoutSetup: 'SUBSCRIPTION_CHECKOUT_SETUP',
  CheckoutRedemption: 'SUBSCRIPTION_CHECKOUT_REDEMPTION',
  /** The API-integration variant's names, which the status pages and webhooks also print. [A-ORDER, SC-WEBHOOK] */
  Setup: 'SUBSCRIPTION_SETUP',
  Redemption: 'SUBSCRIPTION_REDEMPTION',
  /** `paymentFlow.type` of a one-time payment: "Valued allowed = [PG_CHECKOUT]". [SCP-CREATE] */
  PgCheckout: 'PG_CHECKOUT',
  /** What the order status page prints for a payment's flow (its CREDIT_LINE sample). [SCP-STATUS] */
  Pg: 'PG',
} as const;
export type PhonePePaymentFlowType = (typeof PhonePePaymentFlowType)[keyof typeof PhonePePaymentFlowType];

/** Payment-flow types that mean "this order is a mandate setup". */
export const SETUP_FLOW_TYPES: readonly string[] = [PhonePePaymentFlowType.CheckoutSetup, PhonePePaymentFlowType.Setup];
/** Payment-flow types that mean "this order is a redemption (notification and debit)". */
export const REDEMPTION_FLOW_TYPES: readonly string[] = [
  PhonePePaymentFlowType.CheckoutRedemption,
  PhonePePaymentFlowType.Redemption,
];

/** Payment-flow types that mean "this order is a one-time payment" (an order with no `paymentFlow` at all is one as well). */
export const PAYMENT_FLOW_TYPES: readonly string[] = [PhonePePaymentFlowType.PgCheckout, PhonePePaymentFlowType.Pg];

/** `subscriptionType`: the only value. [SC-SETUP] */
export const PhonePeSubscriptionType = { Recurring: 'RECURRING' } as const;

/**
 * `productType`. Required on the mobile, TPV and paylink pages and in the Try-it body of the web page, absent from its
 * table; sent on every setup. (ASSUMPTION, fact sheet section 12.3.)
 */
export const PhonePeProductType = { UpiMandate: 'UPI_MANDATE' } as const;

export const PhonePeAuthWorkflowType = {
  /** First debit taken at setup (amount >= 100 paise or the first debit amount). */
  Transaction: 'TRANSACTION',
  /** A fixed INR 2 verification. The docs' constraint text writes "PENNY DROP"; samples, SDKs and webhooks use `PENNY_DROP`. [SC-SETUP, SDK] */
  PennyDrop: 'PENNY_DROP',
} as const;
export type PhonePeAuthWorkflowType = (typeof PhonePeAuthWorkflowType)[keyof typeof PhonePeAuthWorkflowType];

export const PhonePeAmountType = {
  Fixed: 'FIXED',
  /** `maxAmount` is then the cap per debit. */
  Variable: 'VARIABLE',
} as const;
export type PhonePeAmountType = (typeof PhonePeAmountType)[keyof typeof PhonePeAmountType];

/** `frequency` values. [SC-SETUP, SDK frequency enum] */
export const PhonePeFrequency = {
  Daily: 'DAILY',
  Weekly: 'WEEKLY',
  Monthly: 'MONTHLY',
  Fortnightly: 'FORTNIGHTLY',
  BiMonthly: 'BIMONTHLY',
  Quarterly: 'QUARTERLY',
  HalfYearly: 'HALFYEARLY',
  Yearly: 'YEARLY',
  OnDemand: 'ON_DEMAND',
} as const;
export type PhonePeFrequency = (typeof PhonePeFrequency)[keyof typeof PhonePeFrequency];

/**
 * Plan intervals PhonePe has an EXACT frequency for. Anything else (every 5 days, every 4 months, ...) is sent as
 * `ON_DEMAND`, which the mandate treats as "as presented": no recurrence rule is enforced by the bank.
 *
 * Deliberately absent: `BIMONTHLY`. UPI documents use the word for both "every two months" and "twice a month" and the
 * PhonePe pages do not say which; two-monthly plans are sent as `ON_DEMAND` rather than guessed. (ASSUMPTION.)
 */
export const FREQUENCY_BY_INTERVAL: readonly { unit: IntervalUnit; count: number; frequency: PhonePeFrequency }[] = [
  { unit: IntervalUnit.Day, count: 1, frequency: PhonePeFrequency.Daily },
  { unit: IntervalUnit.Week, count: 1, frequency: PhonePeFrequency.Weekly },
  { unit: IntervalUnit.Day, count: 7, frequency: PhonePeFrequency.Weekly },
  { unit: IntervalUnit.Week, count: 2, frequency: PhonePeFrequency.Fortnightly },
  { unit: IntervalUnit.Day, count: 14, frequency: PhonePeFrequency.Fortnightly },
  { unit: IntervalUnit.Month, count: 1, frequency: PhonePeFrequency.Monthly },
  { unit: IntervalUnit.Month, count: 3, frequency: PhonePeFrequency.Quarterly },
  { unit: IntervalUnit.Month, count: 6, frequency: PhonePeFrequency.HalfYearly },
  { unit: IntervalUnit.Month, count: 12, frequency: PhonePeFrequency.Yearly },
  { unit: IntervalUnit.Year, count: 1, frequency: PhonePeFrequency.Yearly },
];

/** The reverse, for a status response: the interval a named frequency stands for (never for `ON_DEMAND` / `BIMONTHLY`). */
export const INTERVAL_BY_FREQUENCY: Partial<Record<PhonePeFrequency, { unit: IntervalUnit; count: number }>> = {
  [PhonePeFrequency.Daily]: { unit: IntervalUnit.Day, count: 1 },
  [PhonePeFrequency.Weekly]: { unit: IntervalUnit.Week, count: 1 },
  [PhonePeFrequency.Fortnightly]: { unit: IntervalUnit.Week, count: 2 },
  [PhonePeFrequency.Monthly]: { unit: IntervalUnit.Month, count: 1 },
  [PhonePeFrequency.Quarterly]: { unit: IntervalUnit.Month, count: 3 },
  [PhonePeFrequency.HalfYearly]: { unit: IntervalUnit.Month, count: 6 },
  [PhonePeFrequency.Yearly]: { unit: IntervalUnit.Year, count: 1 },
};

/** `redemptionRetryStrategy`. `STANDARD` (the default) lets PhonePe retry inside its 48 hour window. [SC-NOTIFY, SC-EXEC] */
export const PhonePeRetryStrategy = {
  Standard: 'STANDARD',
  Custom: 'CUSTOM',
} as const;
export type PhonePeRetryStrategy = (typeof PhonePeRetryStrategy)[keyof typeof PhonePeRetryStrategy];

/** Mandate (subscription) states. [SC-SUBSTATUS] */
export const PhonePeSubscriptionState = {
  ActivationInProgress: 'ACTIVATION_IN_PROGRESS',
  Active: 'ACTIVE',
  Expired: 'EXPIRED',
  Failed: 'FAILED',
  CancelInProgress: 'CANCEL_IN_PROGRESS',
  Cancelled: 'CANCELLED',
  RevokeInProgress: 'REVOKE_IN_PROGRESS',
  Revoked: 'REVOKED',
  PauseInProgress: 'PAUSE_IN_PROGRESS',
  Paused: 'PAUSED',
  UnpauseInProgress: 'UNPAUSE_IN_PROGRESS',
} as const;
export type PhonePeSubscriptionState = (typeof PhonePeSubscriptionState)[keyof typeof PhonePeSubscriptionState];

/**
 * Mandate state to normalised status. Pause is customer-only; a mandate that is being paused or un-paused is not
 * debitable, so every pause state is `paused`. A mandate being cancelled or revoked is already as good as gone.
 * A state PhonePe adds later falls back to `UNKNOWN_SUBSCRIPTION_STATUS` (it is also kept verbatim in `providerStatus`).
 */
export const SUBSCRIPTION_STATE_TO_STATUS: Record<PhonePeSubscriptionState, SubscriptionStatus> = {
  [PhonePeSubscriptionState.ActivationInProgress]: SubscriptionStatus.PendingAuthorization,
  [PhonePeSubscriptionState.Active]: SubscriptionStatus.Active,
  [PhonePeSubscriptionState.PauseInProgress]: SubscriptionStatus.Paused,
  [PhonePeSubscriptionState.Paused]: SubscriptionStatus.Paused,
  [PhonePeSubscriptionState.UnpauseInProgress]: SubscriptionStatus.Paused,
  [PhonePeSubscriptionState.CancelInProgress]: SubscriptionStatus.Cancelled,
  [PhonePeSubscriptionState.Cancelled]: SubscriptionStatus.Cancelled,
  [PhonePeSubscriptionState.RevokeInProgress]: SubscriptionStatus.Cancelled,
  [PhonePeSubscriptionState.Revoked]: SubscriptionStatus.Cancelled,
  [PhonePeSubscriptionState.Expired]: SubscriptionStatus.Expired,
  [PhonePeSubscriptionState.Failed]: SubscriptionStatus.Failed,
};

/**
 * What an unknown mandate state becomes: "pending authorisation", the one status on which neither the scheduler nor
 * the facade acts (it neither activates a schedule nor cancels one). The state itself stays visible in `providerStatus`.
 */
export const UNKNOWN_SUBSCRIPTION_STATUS: SubscriptionStatus = SubscriptionStatus.PendingAuthorization;

/** Order states. Setup and redemption orders share them; the two notification states exist only before the debit. [SC-ORDER, SC-NOTIFSTATUS, SC-REDORDER] */
export const PhonePeOrderState = {
  Pending: 'PENDING',
  Completed: 'COMPLETED',
  Failed: 'FAILED',
  NotificationInProgress: 'NOTIFICATION_IN_PROGRESS',
  Notified: 'NOTIFIED',
} as const;
export type PhonePeOrderState = (typeof PhonePeOrderState)[keyof typeof PhonePeOrderState];

/** The states of a notification that has not been redeemed (yet). */
export const NOTIFICATION_STATES: readonly string[] = [PhonePeOrderState.NotificationInProgress, PhonePeOrderState.Notified];
/** The states of an order that was redeemed: PhonePe holds a debit for it. */
export const REDEEMED_STATES: readonly string[] = [PhonePeOrderState.Pending, PhonePeOrderState.Completed, PhonePeOrderState.Failed];

/** Order state to charge status. An unknown order state is `PENDING` (never final, never a failure). */
export const ORDER_STATE_TO_CHARGE_STATUS: Record<PhonePeOrderState, ChargeStatus> = {
  [PhonePeOrderState.Pending]: ChargeStatus.Pending,
  [PhonePeOrderState.Completed]: ChargeStatus.Succeeded,
  [PhonePeOrderState.Failed]: ChargeStatus.Failed,
  [PhonePeOrderState.NotificationInProgress]: ChargeStatus.Scheduled,
  [PhonePeOrderState.Notified]: ChargeStatus.Scheduled,
};
export const UNKNOWN_CHARGE_STATUS: ChargeStatus = ChargeStatus.Pending;

/**
 * What the SETUP ORDER says about a mandate the status endpoint does not know yet (the docs describe that endpoint as
 * "after it has been set up" and say nothing about the time before): the customer has not finished (`PENDING`) is
 * `created`; the setup failed or expired is `failed`; the setup completed but the mandate is not visible yet is
 * `pending_authorization`. (ASSUMPTION: fact sheet section 3.4 / 6.)
 */
export const SETUP_ORDER_STATE_TO_STATUS: Partial<Record<PhonePeOrderState, SubscriptionStatus>> = {
  [PhonePeOrderState.Pending]: SubscriptionStatus.Created,
  [PhonePeOrderState.Completed]: SubscriptionStatus.PendingAuthorization,
  [PhonePeOrderState.Failed]: SubscriptionStatus.Failed,
};

/** Refund states. `CONFIRMED` and `ACCEPTED` are in the UAT checklist / legacy webhook list as "still in progress". [A-REFUND, G-UATCHECK, SDK CallbackType] */
export const PhonePeRefundState = {
  Pending: 'PENDING',
  Confirmed: 'CONFIRMED',
  Accepted: 'ACCEPTED',
  Completed: 'COMPLETED',
  Failed: 'FAILED',
} as const;
export type PhonePeRefundState = (typeof PhonePeRefundState)[keyof typeof PhonePeRefundState];

/** A refund state PhonePe adds later is `pending`: a refund is never reported final on a guess. */
export const REFUND_STATE_TO_STATUS: Record<PhonePeRefundState, RefundStatus> = {
  [PhonePeRefundState.Pending]: RefundStatus.Pending,
  [PhonePeRefundState.Confirmed]: RefundStatus.Pending,
  [PhonePeRefundState.Accepted]: RefundStatus.Pending,
  [PhonePeRefundState.Completed]: RefundStatus.Succeeded,
  [PhonePeRefundState.Failed]: RefundStatus.Failed,
};
export const UNKNOWN_REFUND_STATUS: RefundStatus = RefundStatus.Pending;

// ---------------------------------------------------------------------------
// One-time payments (Standard Checkout) [SCP-*]
//
// Source tags: [SCP-CREATE] /payment-gateway/website-integration/standard-checkout/api-integration/api-reference/create-payment,
// [SCP-STATUS] .../order-status, [SCP-REFUND] .../refund, [SCP-WEBHOOK] .../webhook, [SCP-CHECKLIST]
// /payment-gateway/uat-testing-go-live/uat-checklist, [SCP-TROUBLE] .../troubleshooting.
// ---------------------------------------------------------------------------

/** The instrument types `paymentModeConfig` accepts. [SCP-CREATE] */
export const PhonePePaymentMode = {
  UpiIntent: 'UPI_INTENT',
  UpiQr: 'UPI_QR',
  NetBanking: 'NET_BANKING',
  Card: 'CARD',
} as const;
export type PhonePePaymentMode = (typeof PhonePePaymentMode)[keyof typeof PhonePePaymentMode];

/** `paymentMode` of an attempt: the four above plus the ones only the status page prints. [SCP-STATUS] */
export const PhonePeAttemptMode = {
  ...PhonePePaymentMode,
  UpiCollect: 'UPI_COLLECT',
} as const;

/** `cardTypes` of a `CARD` entry. [SCP-CREATE] */
export const PhonePeCardType = {
  Debit: 'DEBIT_CARD',
  Credit: 'CREDIT_CARD',
} as const;
export type PhonePeCardType = (typeof PhonePeCardType)[keyof typeof PhonePeCardType];

/**
 * The payment methods a one-time payment can be limited to, and what PhonePe is told to show for each. A card entry names
 * both card types, so credit and debit cards are both offered. `wallet` has no instrument type in `paymentModeConfig`, so
 * it is refused; the mandate methods (`enach`, `physical_nach`) are not payments.
 */
export const PAYMENT_MODES_BY_METHOD: Partial<Record<PaymentMethod, readonly { type: PhonePePaymentMode; cardTypes?: readonly PhonePeCardType[] }[]>> = {
  [PaymentMethod.Upi]: [{ type: PhonePePaymentMode.UpiIntent }, { type: PhonePePaymentMode.UpiQr }],
  [PaymentMethod.Card]: [{ type: PhonePePaymentMode.Card, cardTypes: [PhonePeCardType.Debit, PhonePeCardType.Credit] }],
  [PaymentMethod.NetBanking]: [{ type: PhonePePaymentMode.NetBanking }],
};

/** What `capabilities.oneTimePaymentMethods` reports: the keys of the table above. */
export const ONE_TIME_PAYMENT_METHODS: readonly PaymentMethod[] = [PaymentMethod.Upi, PaymentMethod.Card, PaymentMethod.NetBanking];

/** The payment method an attempt's `paymentMode` stands for. A mode not in the table (`CREDIT_LINE`, a new one) leaves `paymentMethod` unset. */
export const PAYMENT_METHOD_BY_MODE: Record<string, PaymentMethod> = {
  [PhonePeAttemptMode.UpiIntent]: PaymentMethod.Upi,
  [PhonePeAttemptMode.UpiQr]: PaymentMethod.Upi,
  [PhonePeAttemptMode.UpiCollect]: PaymentMethod.Upi,
  [PhonePeAttemptMode.Card]: PaymentMethod.Card,
  [PhonePeAttemptMode.NetBanking]: PaymentMethod.NetBanking,
};

/**
 * Order state to payment status: "COMPLETED -> Payment Successful, FAILED -> Payment failed, PENDING -> Payment in
 * progress" [SCP-CHECKLIST]. A `PENDING` order with no attempt at all is `created` (see `mapPaymentOrder`). An unknown state is
 * `pending`: never final, never a failure. PhonePe's order status carries no refund information, so `refunded` and
 * `partially_refunded` are never produced, and the states have no cancelled or expired value.
 */
export const ORDER_STATE_TO_PAYMENT_STATUS: Record<PhonePeOrderState, PaymentStatus> = {
  [PhonePeOrderState.Pending]: PaymentStatus.Pending,
  [PhonePeOrderState.Completed]: PaymentStatus.Succeeded,
  [PhonePeOrderState.Failed]: PaymentStatus.Failed,
  [PhonePeOrderState.NotificationInProgress]: PaymentStatus.Pending,
  [PhonePeOrderState.Notified]: PaymentStatus.Pending,
};
export const UNKNOWN_PAYMENT_STATUS: PaymentStatus = PaymentStatus.Pending;

/** `providerStatus` of a payment whose order has just been created: the create call answers `PENDING`. */
export const NEW_PAYMENT_PROVIDER_STATUS = PhonePeOrderState.Pending;

/**
 * What an order is, judged by its payload: a subscription's (setup, notification, redemption) or a one-time payment's.
 * `other` is an order with a `paymentFlow` type this adapter does not know (a payment link, say): never normalised.
 */
export const PhonePeOrderKind = {
  Subscription: 'subscription',
  Payment: 'payment',
  Other: 'other',
} as const;
export type PhonePeOrderKind = (typeof PhonePeOrderKind)[keyof typeof PhonePeOrderKind];

/** `amount` of a payment: "Minimum value = 100" paise. [SCP-CREATE] */
export const MIN_PAYMENT_PAISE = 100;

/** Generated payment ids: `pay_<hex>`. */
export const GENERATED_PAYMENT_ID_PREFIX = 'pay';
export const GENERATED_PAYMENT_ID_RANDOM_BYTES = 12;

/** The query parameter added to the return URL so that the browser's return identifies the payment. */
export const RETURN_PAYMENT_ID_PARAM = 'merchantOrderId';

// ---------------------------------------------------------------------------
// Limits the docs state
// ---------------------------------------------------------------------------

/** `merchantOrderId` and `merchantRefundId`: at most 63 characters of letters, digits, `_` and `-`. [SC-SETUP, SC-NOTIFY, SC-EXEC, A-REFUND] */
export const MAX_MERCHANT_ID_LENGTH = 63;
export const MERCHANT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** The setup order's id is `ST_` + the subscription id, so a subscription id may be at most 63 - 3 = 60 characters. */
export const SETUP_ORDER_ID_PREFIX = 'ST_';
export const MAX_SUBSCRIPTION_ID_LENGTH = MAX_MERCHANT_ID_LENGTH - SETUP_ORDER_ID_PREFIX.length;

/** Generated subscription ids: `sub_<hex>`. */
export const GENERATED_SUBSCRIPTION_ID_PREFIX = 'sub';
export const GENERATED_SUBSCRIPTION_ID_RANDOM_BYTES = 12;
export const ID_PART_SEPARATOR = '_';

/** PENNY_DROP: "the amount should be equal to 200" paise. [SC-SETUP] */
export const PENNY_DROP_AMOUNT_PAISE = 200;
/** TRANSACTION: "greater than or equal to 100 or the first debit amount" paise. [SC-SETUP] */
export const MIN_TRANSACTION_SETUP_PAISE = 100;
/** Notify `amount`: "Min Value: 100 paise". [SC-NOTIFY] */
export const MIN_NOTIFY_PAISE = 100;
/** `maxAmount`: "Max Limit: 1500000 paisa (i.e., INR 15,000)". [SC-SETUP] */
export const MAX_MANDATE_PAISE = 1_500_000;

/** `expireAfter`: setup order expiry in seconds, "Min 300, Max 3600". [SC-SETUP] */
export const EXPIRE_AFTER_MIN_SECONDS = 300;
export const EXPIRE_AFTER_MAX_SECONDS = 3600;

/** `expireAt` of a mandate: "Max value: 30 Years". [SC-SETUP] */
export const MAX_MANDATE_VALIDITY_YEARS = 30;
/**
 * A mandate with no end gets this validity (one year inside the documented maximum, so calendar arithmetic and clock
 * differences can never exceed it). PhonePe's own default is 30 years [A-SETUP], not stated for Standard Checkout.
 */
export const DEFAULT_MANDATE_VALIDITY_YEARS = 29;
/**
 * A mandate for `totalCycles` cycles lasts this many days beyond its last debit date, so that retries of the last cycle
 * (a fresh notification, 24 hours of notice, three attempts) still find a live mandate.
 */
export const MANDATE_END_GRACE_DAYS = 7;

/** `metaInfo`: `udf1` to `udf10` up to 256 characters, `udf11` to `udf15` up to 50 of `[A-Za-z0-9_\-+@. ]`. [SC-SETUP, SDK MetaInfo] */
export const UDF_COUNT = 15;
export const UDF_LONG_COUNT = 10;
export const UDF_LONG_MAX_LENGTH = 256;
export const UDF_SHORT_MAX_LENGTH = 50;
export const UDF_SHORT_PATTERN = /^[a-zA-Z0-9_\- @.+]*$/;
export const UDF_KEY_PATTERN = /^udf([1-9]|1[0-5])$/;

/** The query parameter added to the return URL so that the browser's return identifies the subscription. */
export const RETURN_SUBSCRIPTION_ID_PARAM = 'merchantSubscriptionId';

// ---------------------------------------------------------------------------
// Webhooks [SC-WEBHOOK, A-WEBHOOK]
// ---------------------------------------------------------------------------

/** The `event` of a webhook body. Key on this, not on `type` ("will be deprecated"). */
export const PhonePeEvent = {
  SetupCompleted: 'subscription.setup.order.completed',
  SetupFailed: 'subscription.setup.order.failed',
  CheckoutOrderCompleted: 'checkout.order.completed',
  CheckoutOrderFailed: 'checkout.order.failed',
  Paused: 'subscription.paused',
  Unpaused: 'subscription.unpaused',
  Revoked: 'subscription.revoked',
  Cancelled: 'subscription.cancelled',
  NotificationCompleted: 'subscription.notification.completed',
  NotificationFailed: 'subscription.notification.failed',
  RedemptionOrderCompleted: 'subscription.redemption.order.completed',
  RedemptionOrderFailed: 'subscription.redemption.order.failed',
  RedemptionTransactionCompleted: 'subscription.redemption.transaction.completed',
  RedemptionTransactionFailed: 'subscription.redemption.transaction.failed',
  RefundCompleted: 'pg.refund.completed',
  RefundFailed: 'pg.refund.failed',
  RefundAccepted: 'pg.refund.accepted',
} as const;
export type PhonePeEvent = (typeof PhonePeEvent)[keyof typeof PhonePeEvent];

/** Separates the parts of an event id. */
export const EVENT_ID_SEPARATOR = ':';
/** The parts of an event id that PhonePe supplies no value for. */
export const EVENT_ID_EMPTY = '-';

// ---------------------------------------------------------------------------
// Errors [A-ERR, G-ORDER, G-CREATE]
// ---------------------------------------------------------------------------

/** `code` values of an error body this adapter recognises. */
export const PhonePeErrorCode = {
  BadRequest: 'BAD_REQUEST',
  InvalidExpiry: 'INVALID_EXPIRY',
  /** "No entry found for given merchant order id". [G-ORDER case 6] */
  InvalidMerchantOrderId: 'INVALID_MERCHANT_ORDER_ID',
  SubscriptionNotFound: 'SUBSCRIPTION_NOT_FOUND',
  /** "Debit transaction id is duplicate. Use another unique one." [A-ERR] */
  DuplicateTxnRequest: 'DUPLICATE_TXN_REQUEST',
  InvalidTransactionId: 'INVALID_TRANSACTION_ID',
  /** "Execution interval hasn't yet started (24 hours after notification)". [A-ERR] */
  ExecuteIntervalNotStarted: 'SUBSCRIPTION_DEBIT_EXECUTE_INTERVAL_NOT_STARTED',
  ExecuteIntervalExpired: 'SUBSCRIPTION_DEBIT_EXECUTE_INTERVAL_EXPIRED',
  InvalidSubscriptionState: 'INVALID_SUBSCRIPTION_STATE',
  MandateRedemptionSkipped: 'MANDATE_REDEMPTION_SKIPPED',
  RecurrenceLimitBreached: 'SUBSCRIPTION_RECURRENCE_LIMIT_BREACHED',
  RefundOlderThanLimit: 'REFUND_FOR_TXN_OLDER_THAN_LIMIT',
  ExcessRefundAmount: 'EXCESS_REFUND_AMOUNT',
  InvalidRefundRequestFields: 'INVALID_REFUND_REQUEST_FIELDS',
  TxnAmountMismatchRefund: 'TXN_AMOUNT_MISMATCH_REFUND',
  RefundNotAllowed: 'REFUND_NOT_ALLOWED',
  RefundBreached: 'BF_034',
} as const;
export type PhonePeErrorCode = (typeof PhonePeErrorCode)[keyof typeof PhonePeErrorCode];

/**
 * How each documented PhonePe error code maps. The table is consulted only for HTTP statuses below 500: a 5xx on a
 * write may have been processed, so it keeps the status-derived code (`OUTCOME_UNKNOWN` for writes).
 *
 * The scheduler treats `PROVIDER_ERROR`, `VALIDATION`, `UNSUPPORTED`, `NOT_FOUND`, `AUTH` and `CONFIG` from a FIRST
 * `createCharge` as "the gateway refused, no debit exists" and anything else (`CONFLICT` included) as "ask `getCharge`".
 * So:
 *  - "too early" is `CONFLICT`: nothing was debited and the debit can still happen, so it must not burn an attempt;
 *  - "window expired", "mandate not active", "redemption skipped" are `PROVIDER_ERROR`: the debit can never happen with
 *    this notification, the attempt failed, and the scheduler retries with a fresh notification;
 *  - a duplicate order id is `CONFLICT`: the debit may already exist, so the scheduler reconciles instead of retrying.
 */
export const ERROR_CODE_BY_PHONEPE_CODE: Record<PhonePeErrorCode, ErrorCode> = {
  [PhonePeErrorCode.BadRequest]: ErrorCode.Validation,
  [PhonePeErrorCode.InvalidExpiry]: ErrorCode.Validation,
  [PhonePeErrorCode.InvalidMerchantOrderId]: ErrorCode.NotFound,
  [PhonePeErrorCode.SubscriptionNotFound]: ErrorCode.NotFound,
  [PhonePeErrorCode.DuplicateTxnRequest]: ErrorCode.Conflict,
  [PhonePeErrorCode.InvalidTransactionId]: ErrorCode.Validation,
  [PhonePeErrorCode.ExecuteIntervalNotStarted]: ErrorCode.Conflict,
  [PhonePeErrorCode.ExecuteIntervalExpired]: ErrorCode.ProviderError,
  [PhonePeErrorCode.InvalidSubscriptionState]: ErrorCode.ProviderError,
  [PhonePeErrorCode.MandateRedemptionSkipped]: ErrorCode.ProviderError,
  [PhonePeErrorCode.RecurrenceLimitBreached]: ErrorCode.Validation,
  [PhonePeErrorCode.RefundOlderThanLimit]: ErrorCode.Validation,
  [PhonePeErrorCode.ExcessRefundAmount]: ErrorCode.Validation,
  [PhonePeErrorCode.InvalidRefundRequestFields]: ErrorCode.Validation,
  [PhonePeErrorCode.TxnAmountMismatchRefund]: ErrorCode.Validation,
  [PhonePeErrorCode.RefundNotAllowed]: ErrorCode.Validation,
  [PhonePeErrorCode.RefundBreached]: ErrorCode.ProviderError,
};

/** The codes that prove an ORDER does not exist at PhonePe. A bare 404 is not enough for `getCharge` (see the adapter). */
export const ORDER_NOT_FOUND_CODES: readonly string[] = [PhonePeErrorCode.InvalidMerchantOrderId];

/** The most characters of a PhonePe error message put into an error. */
export const MAX_ERROR_TEXT = 300;

// ---------------------------------------------------------------------------
// Synthetic status text (never sent to PhonePe)
// ---------------------------------------------------------------------------

/** `providerStatus` of a subscription whose cancel call answered 204 but whose status could not be read afterwards. */
export const CANCEL_ACCEPTED_STATUS = PhonePeSubscriptionState.Cancelled;
