import { ErrorCode, EventType, PaymentStatus, SubscriptionStatus } from '../../constants.js';

/**
 * Google Play constants: the Google Play Developer API (`androidpublisher`), real-time developer notifications over
 * Cloud Pub/Sub, and the OAuth and OIDC endpoints around them. Every string sent to or received from Google is named here;
 * JSON field names live in `schemas.ts`. Each constant cites the documentation page it comes from:
 *
 * - [API] https://developers.google.com/android-publisher/api-ref/rest/v3/ (the page of the method or resource)
 * - [RTDN] https://developer.android.com/google/play/billing/rtdn-reference
 * - [LIFECYCLE] https://developer.android.com/google/play/billing/lifecycle/subscriptions
 * - [INTEGRATE] https://developer.android.com/google/play/billing/integrate
 * - [EXTERNAL] https://developer.android.com/google/play/billing/outside-gpb-backend
 * - [PUSH-AUTH] https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions
 * - [SA-OAUTH] https://developers.google.com/identity/protocols/oauth2/service-account
 * - [OIDC] https://developers.google.com/identity/openid-connect/openid-connect
 */

// ---------------------------------------------------------------------------
// Hosts, paths, OAuth
// ---------------------------------------------------------------------------

/** The Developer API host and version. The reference names one host; purchases by licence testers are read from it too. [API] */
export const GOOGLE_PLAY_API_URL = 'https://androidpublisher.googleapis.com/androidpublisher/v3';

/** The OAuth scope every `androidpublisher` method requires. [API] */
export const GOOGLE_PLAY_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

/** Where the signed JWT is exchanged for an access token, and the `aud` of that JWT. [SA-OAUTH] */
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** `grant_type` of the token request. [SA-OAUTH] */
export const GOOGLE_JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

/** The `alg` of both the service account assertion [SA-OAUTH] and Pub/Sub push tokens [PUSH-AUTH]. */
export const JWT_ALGORITHM = 'RS256';
/** The Node.js name of RSASSA-PKCS1-v1_5 with SHA-256, the RS256 signature. [SA-OAUTH] */
export const RS256_NODE_ALGORITHM = 'RSA-SHA256';
/** The `typ` of the assertion header. [SA-OAUTH] */
export const JWT_TYPE = 'JWT';

/** Lifetime of the assertion: "a maximum of 1 hour after the issued time". [SA-OAUTH] */
export const ASSERTION_LIFETIME_SECONDS = 3600;

/** Renew an access token this long before its `expires_in` runs out; a token living less than twice this is renewed at half its life. */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** Lifetime assumed when the token response carries no `expires_in`. [SA-OAUTH] documents 3600 in its sample. */
export const TOKEN_FALLBACK_LIFETIME_SECONDS = 3600;

/** The token type of the access token, sent as `Authorization: Bearer <token>`. [SA-OAUTH] */
export const BEARER_SCHEME = 'Bearer';

/** HTTP status of a refused access token; the call was not processed, so repeating it with a new token is safe. */
export const HTTP_UNAUTHORIZED = 401;
/** HTTP statuses that mean "Google holds no such purchase any more": 404 notFound, 410 purchaseTokenNoLongerValid / subscriptionNoLongerAvailable. [API] */
export const HTTP_NOT_FOUND = 404;
export const HTTP_GONE = 410;

const enc = encodeURIComponent;

/** Paths below `GOOGLE_PLAY_API_URL`. [API] */
export const GooglePlayPath = {
  /** `GET` a subscription purchase (source of truth for subscription state). [API purchases.subscriptionsv2.get] */
  subscription: (packageName: string, token: string) =>
    `/applications/${enc(packageName)}/purchases/subscriptionsv2/tokens/${enc(token)}`,
  /** `POST` (body `cancellationContext`) stops the renewals. [API purchases.subscriptionsv2.cancel] */
  cancelSubscription: (packageName: string, token: string) =>
    `/applications/${enc(packageName)}/purchases/subscriptionsv2/tokens/${enc(token)}:cancel`,
  /** `POST` acknowledges a subscription purchase. [API purchases.subscriptions.acknowledge] */
  acknowledgeSubscription: (packageName: string, productId: string, token: string) =>
    `/applications/${enc(packageName)}/purchases/subscriptions/${enc(productId)}/tokens/${enc(token)}:acknowledge`,
  /** `GET` a one-time product purchase. [API purchases.productsv2.getproductpurchasev2] */
  product: (packageName: string, token: string) =>
    `/applications/${enc(packageName)}/purchases/productsv2/tokens/${enc(token)}`,
  /** `POST` acknowledges a one-time product purchase. [API purchases.products.acknowledge] */
  acknowledgeProduct: (packageName: string, productId: string, token: string) =>
    `/applications/${enc(packageName)}/purchases/products/${enc(productId)}/tokens/${enc(token)}:acknowledge`,
  /** `POST` consumes a one-time product purchase (also acknowledges it). [API purchases.products.consume] */
  consumeProduct: (packageName: string, productId: string, token: string) =>
    `/applications/${enc(packageName)}/purchases/products/${enc(productId)}/tokens/${enc(token)}:consume`,
  /** `GET` an order. [API orders.get] */
  order: (packageName: string, orderId: string) => `/applications/${enc(packageName)}/orders/${enc(orderId)}`,
  /** `POST` refunds an order in full. [API orders.refund] */
  refundOrder: (packageName: string, orderId: string) => `/applications/${enc(packageName)}/orders/${enc(orderId)}:refund`,
  /** `POST` creates an external transaction (the id travels in the query). [API externaltransactions.createexternaltransaction] */
  externalTransactions: (packageName: string) => `/applications/${enc(packageName)}/externalTransactions`,
  /** `GET` an external transaction. [API externaltransactions.getexternaltransaction] */
  externalTransaction: (packageName: string, externalTransactionId: string) =>
    `/applications/${enc(packageName)}/externalTransactions/${enc(externalTransactionId)}`,
  /** `POST` refunds an external transaction. [API externaltransactions.refundexternaltransaction] */
  refundExternalTransaction: (packageName: string, externalTransactionId: string) =>
    `/applications/${enc(packageName)}/externalTransactions/${enc(externalTransactionId)}:refund`,
} as const;

/** `?revoke=true` of `orders.refund`: end access and future payments with the refund. [API orders.refund] */
export const REVOKE_QUERY = 'revoke';
export const REVOKE_QUERY_VALUE = 'true';
/** `?externalTransactionId=` of `externaltransactions.createexternaltransaction`. [API] */
export const EXTERNAL_TRANSACTION_ID_QUERY = 'externalTransactionId';

// ---------------------------------------------------------------------------
// Purchase states
// ---------------------------------------------------------------------------

/** `SubscriptionPurchaseV2.subscriptionState`. [API purchases.subscriptionsv2] */
export const GoogleSubscriptionState = {
  Unspecified: 'SUBSCRIPTION_STATE_UNSPECIFIED',
  Pending: 'SUBSCRIPTION_STATE_PENDING',
  Active: 'SUBSCRIPTION_STATE_ACTIVE',
  Paused: 'SUBSCRIPTION_STATE_PAUSED',
  InGracePeriod: 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
  OnHold: 'SUBSCRIPTION_STATE_ON_HOLD',
  Canceled: 'SUBSCRIPTION_STATE_CANCELED',
  Expired: 'SUBSCRIPTION_STATE_EXPIRED',
  PendingPurchaseCanceled: 'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED',
} as const;
export type GoogleSubscriptionState = (typeof GoogleSubscriptionState)[keyof typeof GoogleSubscriptionState];

/**
 * Unified status of each Google subscription state. A state Google adds later is `pending_authorization`: it grants no
 * access, and `providerStatus` shows it verbatim. `CANCELED` and `EXPIRED` are refined by `mapSubscriptionStatus`
 * (a canceled subscription is still paid until `expiryTime`; an expired one that was canceled or revoked is `cancelled`).
 */
export const SUBSCRIPTION_STATUS_BY_STATE: Record<GoogleSubscriptionState, SubscriptionStatus> = {
  [GoogleSubscriptionState.Unspecified]: SubscriptionStatus.PendingAuthorization,
  [GoogleSubscriptionState.Pending]: SubscriptionStatus.PendingAuthorization,
  [GoogleSubscriptionState.Active]: SubscriptionStatus.Active,
  [GoogleSubscriptionState.Paused]: SubscriptionStatus.Paused,
  [GoogleSubscriptionState.InGracePeriod]: SubscriptionStatus.PastDue,
  [GoogleSubscriptionState.OnHold]: SubscriptionStatus.Halted,
  [GoogleSubscriptionState.Canceled]: SubscriptionStatus.Cancelled,
  [GoogleSubscriptionState.Expired]: SubscriptionStatus.Expired,
  [GoogleSubscriptionState.PendingPurchaseCanceled]: SubscriptionStatus.Failed,
};
export const SUBSCRIPTION_STATUS_FALLBACK: SubscriptionStatus = SubscriptionStatus.PendingAuthorization;

/** `acknowledgementState` of both purchase resources. [API purchases.subscriptionsv2, purchases.productsv2] */
export const GoogleAcknowledgementState = {
  Unspecified: 'ACKNOWLEDGEMENT_STATE_UNSPECIFIED',
  Pending: 'ACKNOWLEDGEMENT_STATE_PENDING',
  Acknowledged: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
} as const;
export type GoogleAcknowledgementState = (typeof GoogleAcknowledgementState)[keyof typeof GoogleAcknowledgementState];

/** `ProductPurchaseV2.purchaseStateContext.purchaseState`. [API purchases.productsv2] */
export const GoogleProductPurchaseState = {
  Unspecified: 'PURCHASE_STATE_UNSPECIFIED',
  Purchased: 'PURCHASED',
  Cancelled: 'CANCELLED',
  Pending: 'PENDING',
} as const;
export type GoogleProductPurchaseState = (typeof GoogleProductPurchaseState)[keyof typeof GoogleProductPurchaseState];

/** Unified status of each one-time purchase state. An unknown state is `pending`: it grants nothing. */
export const PAYMENT_STATUS_BY_PURCHASE_STATE: Record<GoogleProductPurchaseState, PaymentStatus> = {
  [GoogleProductPurchaseState.Unspecified]: PaymentStatus.Pending,
  [GoogleProductPurchaseState.Purchased]: PaymentStatus.Succeeded,
  [GoogleProductPurchaseState.Cancelled]: PaymentStatus.Cancelled,
  [GoogleProductPurchaseState.Pending]: PaymentStatus.Pending,
};
export const PAYMENT_STATUS_FALLBACK: PaymentStatus = PaymentStatus.Pending;

/** `productOfferDetails.consumptionState`. [API purchases.productsv2] */
export const GoogleConsumptionState = {
  Unspecified: 'CONSUMPTION_STATE_UNSPECIFIED',
  YetToBeConsumed: 'CONSUMPTION_STATE_YET_TO_BE_CONSUMED',
  Consumed: 'CONSUMPTION_STATE_CONSUMED',
} as const;
export type GoogleConsumptionState = (typeof GoogleConsumptionState)[keyof typeof GoogleConsumptionState];

/** `Order.state`. [API orders] */
export const GoogleOrderState = {
  Unspecified: 'STATE_UNSPECIFIED',
  Pending: 'PENDING',
  Processed: 'PROCESSED',
  Canceled: 'CANCELED',
  PendingRefund: 'PENDING_REFUND',
  PartiallyRefunded: 'PARTIALLY_REFUNDED',
  Refunded: 'REFUNDED',
} as const;
export type GoogleOrderState = (typeof GoogleOrderState)[keyof typeof GoogleOrderState];

/** `PartialRefundEvent.state`. [API orders] */
export const GooglePartialRefundState = {
  Pending: 'PENDING',
  Processed: 'PROCESSED_SUCCESSFULLY',
} as const;

/** The cancellation types of `subscriptionsv2.cancel`. [API purchases.subscriptionsv2.cancel] */
export const GoogleCancellationType = {
  /** "Cannot be restored. It stops the subscription's next payment": the unified cancel. */
  DeveloperRequestedStopPayments: 'DEVELOPER_REQUESTED_STOP_PAYMENTS',
  /** "Can be restored. It only stops the subscription's next renewal." */
  UserRequestedStopRenewals: 'USER_REQUESTED_STOP_RENEWALS',
} as const;

/** The value of a boolean flag in `metadata`, which holds strings only. */
export const METADATA_TRUE = 'true';

/** Keys this adapter adds to `Subscription.metadata` and `Payment.metadata`; every value is a string. */
export const GooglePlayMetadataKey = {
  ProductId: 'productId',
  BasePlanId: 'basePlanId',
  OfferId: 'offerId',
  RegionCode: 'regionCode',
  LatestOrderId: 'latestOrderId',
  LinkedPurchaseToken: 'linkedPurchaseToken',
  Etag: 'etag',
  AcknowledgementState: 'acknowledgementState',
  TestPurchase: 'testPurchase',
  CurrencyCode: 'currencyCode',
  OrderId: 'orderId',
  OrderState: 'orderState',
} as const;

/** `providerStatus` of a subscription or payment that was made by `createSubscription` / `createPayment`: nothing has been bought yet. */
export const NOT_PURCHASED_STATUS = 'not_purchased';

// ---------------------------------------------------------------------------
// Checkout result
// ---------------------------------------------------------------------------

/**
 * The keys the device sends back to `verifyCheckout` / `verifyPayment`, read from the `Purchase` the Play Billing
 * Library returns (`purchaseToken`, and the product id of the item bought). `consumable` is added by the merchant's
 * server, which knows the product: the docs do not say how a backend learns whether a product is consumable. [INTEGRATE]
 */
export const GooglePlayResultKey = {
  PurchaseToken: 'purchaseToken',
  ProductId: 'productId',
  Consumable: 'consumable',
} as const;

// ---------------------------------------------------------------------------
// Real-time developer notifications
// ---------------------------------------------------------------------------

/** `SubscriptionNotification.notificationType`. Numbers 14 to 16 are not listed by [RTDN]. */
export const SubscriptionNotificationType = {
  Recovered: 1,
  Renewed: 2,
  Canceled: 3,
  Purchased: 4,
  OnHold: 5,
  InGracePeriod: 6,
  Restarted: 7,
  PriceChangeConfirmed: 8,
  Deferred: 9,
  Paused: 10,
  PauseScheduleChanged: 11,
  Revoked: 12,
  Expired: 13,
  ItemsChanged: 17,
  CancellationScheduled: 18,
  PriceChangeUpdated: 19,
  PendingPurchaseCanceled: 20,
  PlanTransitionUpdated: 21,
  PriceStepUpConsentUpdated: 22,
} as const;
export type SubscriptionNotificationType = (typeof SubscriptionNotificationType)[keyof typeof SubscriptionNotificationType];

/** The unified event of each subscription notification. A type Google adds later is `unknown`. */
export const SUBSCRIPTION_EVENT_BY_NOTIFICATION: Record<SubscriptionNotificationType, EventType> = {
  [SubscriptionNotificationType.Recovered]: EventType.SubscriptionResumed,
  [SubscriptionNotificationType.Renewed]: EventType.SubscriptionCharged,
  /** Refined: a canceled subscription that is still paid for is `subscription.updated`; one that has ended is `subscription.cancelled`. */
  [SubscriptionNotificationType.Canceled]: EventType.SubscriptionUpdated,
  [SubscriptionNotificationType.Purchased]: EventType.SubscriptionActivated,
  [SubscriptionNotificationType.OnHold]: EventType.SubscriptionHalted,
  [SubscriptionNotificationType.InGracePeriod]: EventType.SubscriptionPastDue,
  [SubscriptionNotificationType.Restarted]: EventType.SubscriptionUpdated,
  [SubscriptionNotificationType.PriceChangeConfirmed]: EventType.SubscriptionUpdated,
  [SubscriptionNotificationType.Deferred]: EventType.SubscriptionUpdated,
  [SubscriptionNotificationType.Paused]: EventType.SubscriptionPaused,
  [SubscriptionNotificationType.PauseScheduleChanged]: EventType.SubscriptionUpdated,
  [SubscriptionNotificationType.Revoked]: EventType.SubscriptionCancelled,
  [SubscriptionNotificationType.Expired]: EventType.SubscriptionExpired,
  [SubscriptionNotificationType.ItemsChanged]: EventType.SubscriptionUpdated,
  [SubscriptionNotificationType.CancellationScheduled]: EventType.SubscriptionUpdated,
  [SubscriptionNotificationType.PriceChangeUpdated]: EventType.SubscriptionUpdated,
  [SubscriptionNotificationType.PendingPurchaseCanceled]: EventType.SubscriptionAuthorizationFailed,
  [SubscriptionNotificationType.PlanTransitionUpdated]: EventType.SubscriptionUpdated,
  [SubscriptionNotificationType.PriceStepUpConsentUpdated]: EventType.SubscriptionUpdated,
};

/** The names [RTDN] gives the subscription notification types, for `providerEventType`. */
export const SUBSCRIPTION_NOTIFICATION_NAMES: Record<SubscriptionNotificationType, string> = {
  [SubscriptionNotificationType.Recovered]: 'SUBSCRIPTION_RECOVERED',
  [SubscriptionNotificationType.Renewed]: 'SUBSCRIPTION_RENEWED',
  [SubscriptionNotificationType.Canceled]: 'SUBSCRIPTION_CANCELED',
  [SubscriptionNotificationType.Purchased]: 'SUBSCRIPTION_PURCHASED',
  [SubscriptionNotificationType.OnHold]: 'SUBSCRIPTION_ON_HOLD',
  [SubscriptionNotificationType.InGracePeriod]: 'SUBSCRIPTION_IN_GRACE_PERIOD',
  [SubscriptionNotificationType.Restarted]: 'SUBSCRIPTION_RESTARTED',
  [SubscriptionNotificationType.PriceChangeConfirmed]: 'SUBSCRIPTION_PRICE_CHANGE_CONFIRMED',
  [SubscriptionNotificationType.Deferred]: 'SUBSCRIPTION_DEFERRED',
  [SubscriptionNotificationType.Paused]: 'SUBSCRIPTION_PAUSED',
  [SubscriptionNotificationType.PauseScheduleChanged]: 'SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED',
  [SubscriptionNotificationType.Revoked]: 'SUBSCRIPTION_REVOKED',
  [SubscriptionNotificationType.Expired]: 'SUBSCRIPTION_EXPIRED',
  [SubscriptionNotificationType.ItemsChanged]: 'SUBSCRIPTION_ITEMS_CHANGED',
  [SubscriptionNotificationType.CancellationScheduled]: 'SUBSCRIPTION_CANCELLATION_SCHEDULED',
  [SubscriptionNotificationType.PriceChangeUpdated]: 'SUBSCRIPTION_PRICE_CHANGE_UPDATED',
  [SubscriptionNotificationType.PendingPurchaseCanceled]: 'SUBSCRIPTION_PENDING_PURCHASE_CANCELED',
  [SubscriptionNotificationType.PlanTransitionUpdated]: 'SUBSCRIPTION_PLAN_TRANSITION_UPDATED',
  [SubscriptionNotificationType.PriceStepUpConsentUpdated]: 'SUBSCRIPTION_PRICE_STEP_UP_CONSENT_UPDATED',
};

/** `OneTimeProductNotification.notificationType`. [RTDN] */
export const OneTimeNotificationType = {
  Purchased: 1,
  Canceled: 2,
} as const;
export type OneTimeNotificationType = (typeof OneTimeNotificationType)[keyof typeof OneTimeNotificationType];

export const ONE_TIME_EVENT_BY_NOTIFICATION: Record<OneTimeNotificationType, EventType> = {
  [OneTimeNotificationType.Purchased]: EventType.PaymentSucceeded,
  [OneTimeNotificationType.Canceled]: EventType.PaymentFailed,
};

export const ONE_TIME_NOTIFICATION_NAMES: Record<OneTimeNotificationType, string> = {
  [OneTimeNotificationType.Purchased]: 'ONE_TIME_PRODUCT_PURCHASED',
  [OneTimeNotificationType.Canceled]: 'ONE_TIME_PRODUCT_CANCELED',
};

/** `VoidedPurchaseNotification.productType`. [RTDN] */
export const VoidedProductType = {
  Subscription: 1,
  OneTime: 2,
} as const;
export type VoidedProductType = (typeof VoidedProductType)[keyof typeof VoidedProductType];

/** `VoidedPurchaseNotification.refundType`. [RTDN] */
export const VoidedRefundType = {
  FullRefund: 1,
  QuantityBasedPartialRefund: 2,
} as const;
export type VoidedRefundType = (typeof VoidedRefundType)[keyof typeof VoidedRefundType];

export const VOIDED_REFUND_NAMES: Record<VoidedRefundType, string> = {
  [VoidedRefundType.FullRefund]: 'REFUND_TYPE_FULL_REFUND',
  [VoidedRefundType.QuantityBasedPartialRefund]: 'REFUND_TYPE_QUANTITY_BASED_PARTIAL_REFUND',
};

/** `providerEventType` of the notifications that are not subscription, one-time or voided purchase notifications. */
export const ProviderEventName = {
  Voided: 'VOIDED_PURCHASE',
  PendingRefundReview: 'PENDING_REFUND_REVIEW',
  Test: 'TEST_NOTIFICATION',
  /** A notification for another app than the configured package. */
  PackageMismatch: 'PACKAGE_NAME_MISMATCH',
  /** A notification with none of the documented payloads. */
  Unrecognised: 'UNRECOGNISED_NOTIFICATION',
  /** The old subscription a `linkedPurchaseToken` names, ended by the new purchase. */
  LinkedPurchaseReplaced: 'LINKED_PURCHASE_REPLACED',
} as const;

/** Suffix of the id of the second event a purchase with a `linkedPurchaseToken` produces: the Pub/Sub message id stays the id of the first. */
export const LINKED_EVENT_ID_SUFFIX = ':replaced';

// ---------------------------------------------------------------------------
// Pub/Sub push authentication
// ---------------------------------------------------------------------------

/** Google's OIDC signing keys (the `jwks_uri` of the discovery document). [OIDC] */
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

/** The `iss` values of a Google ID token. [OIDC, PUSH-AUTH Go sample] */
export const GOOGLE_ISSUERS: readonly string[] = ['https://accounts.google.com', 'accounts.google.com'];

/** The scheme of the push request's `Authorization` header. [PUSH-AUTH] */
export const PUSH_AUTH_SCHEME = 'Bearer';

/** Keys are cached "using the cache directives of the HTTP response" [OIDC]; this is used when the response names none. */
export const JWKS_DEFAULT_MAX_AGE_SECONDS = 3600;
/** The shortest a key set is cached, so a response with `max-age=0` cannot make every webhook fetch it. */
export const JWKS_MIN_MAX_AGE_SECONDS = 60;
/** An unknown `kid` refetches the key set (Google rotates keys), at most this often. */
export const JWKS_REFETCH_INTERVAL_MS = 60 * 1000;
/** Clock skew tolerated when checking `exp` and `iat` of a push token. */
export const PUSH_TOKEN_CLOCK_SKEW_SECONDS = 60;
export const CACHE_CONTROL_HEADER = 'cache-control';
export const MAX_AGE_PATTERN = /(?:^|[\s,])max-age=(\d+)/i;

/** The RSA key type of a JWK. */
export const JWK_KEY_TYPE_RSA = 'RSA';
export const JWK_FORMAT = 'jwk';

// ---------------------------------------------------------------------------
// Currency and money
// ---------------------------------------------------------------------------

/** `Money.nanos` per paise: 1 INR = 100 paise = 10^9 nanos. [API Money] */
export const NANOS_PER_PAISE = 10_000_000n;
export const PAISE_PER_UNIT = 100n;
/** `Price.priceMicros` per paise: 1 INR = 100 paise = 10^6 micros. [EXTERNAL] */
export const MICROS_PER_PAISE = 10_000n;

// ---------------------------------------------------------------------------
// External transactions
// ---------------------------------------------------------------------------

/** "1-63 characters and valid characters are /a-zA-Z0-9_-/". [API externaltransactions.createexternaltransaction] */
export const EXTERNAL_TRANSACTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,63}$/;
export const MAX_EXTERNAL_TRANSACTION_ID_LENGTH = 63;

/** `regionCode` of every transaction: India. [API ExternalTransactionAddress] */
export const REGION_CODE_INDIA = 'IN';

/** `ExternalSubscription.subscriptionType`. [API externaltransactions] */
export const ExternalSubscriptionType = {
  Recurring: 'RECURRING',
  Prepaid: 'PREPAID',
} as const;

/** `ExternalTransaction.transactionState`. [API externaltransactions] */
export const ExternalTransactionState = {
  Unspecified: 'TRANSACTION_STATE_UNSPECIFIED',
  Reported: 'TRANSACTION_REPORTED',
  Canceled: 'TRANSACTION_CANCELED',
} as const;

/** `administrativeArea` must be one of these: "Only required for transactions in India. Valid values are ...". [API ExternalTransactionAddress] */
export const INDIAN_ADMINISTRATIVE_AREAS: readonly string[] = [
  'ANDAMAN AND NICOBAR ISLANDS',
  'ANDHRA PRADESH',
  'ARUNACHAL PRADESH',
  'ASSAM',
  'BIHAR',
  'CHANDIGARH',
  'CHHATTISGARH',
  'DADRA AND NAGAR HAVELI',
  'DADRA AND NAGAR HAVELI AND DAMAN AND DIU',
  'DAMAN AND DIU',
  'DELHI',
  'GOA',
  'GUJARAT',
  'HARYANA',
  'HIMACHAL PRADESH',
  'JAMMU AND KASHMIR',
  'JHARKHAND',
  'KARNATAKA',
  'KERALA',
  'LADAKH',
  'LAKSHADWEEP',
  'MADHYA PRADESH',
  'MAHARASHTRA',
  'MANIPUR',
  'MEGHALAYA',
  'MIZORAM',
  'NAGALAND',
  'ODISHA',
  'PUDUCHERRY',
  'PUNJAB',
  'RAJASTHAN',
  'SIKKIM',
  'TAMIL NADU',
  'TELANGANA',
  'TRIPURA',
  'UTTAR PRADESH',
  'UTTARAKHAND',
  'WEST BENGAL',
];

/** Error codes after which the adapter asks Google whether an external transaction call took effect: the answer is lost, or the id is already used. */
export const EXTERNAL_RECONCILE_CODES: readonly ErrorCode[] = [ErrorCode.OutcomeUnknown, ErrorCode.Conflict];

/** Longest text of a Google error put into an error message. */
export const MAX_ERROR_TEXT = 500;
