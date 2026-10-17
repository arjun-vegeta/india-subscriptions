import {
  ChargeStatus,
  Environment,
  EventType,
  PaymentStatus,
  SubscriptionStatus,
} from '../../constants.js';

/**
 * Apple App Store constants: the App Store Server API (version 1.25), App Store Server Notifications V2 and the signed
 * data (JWS) both return. Every string sent to or received from Apple is named here; JSON field names live in
 * `schemas.ts`. Documentation pages are cited by their path under https://developer.apple.com/documentation/ ,
 * for example [appstoreserverapi/status].
 */

// ---------------------------------------------------------------------------
// Hosts, paths, authentication
// ---------------------------------------------------------------------------

/**
 * `test` is Apple's sandbox, `live` is production. [appstoreserverapi, "Test using the sandbox environment"; the
 * recommended domains per the App Store Server API changelog, server update 2026/05/05]
 */
export const APPSTORE_BASE_URLS: Record<Environment, string> = {
  [Environment.Test]: 'https://api.storekit-sandbox.apple.com',
  [Environment.Live]: 'https://api.storekit.apple.com',
};

const enc = encodeURIComponent;

/** Paths relative to the host. `/inApps` is case-sensitive. [appstoreserverapi, the endpoint pages] */
export const AppStorePath = {
  /** `GET` the status of every subscription of the customer. [appstoreserverapi/get-all-subscription-statuses] */
  subscriptionStatuses: (anyTransactionId: string) => `/inApps/v1/subscriptions/${enc(anyTransactionId)}`,
  /** `GET` one transaction. [appstoreserverapi/get-transaction-info] */
  transaction: (transactionId: string) => `/inApps/v1/transactions/${enc(transactionId)}`,
  /** `GET` the transaction history, up to 20 per page. [appstoreserverapi/get-transaction-history] */
  history: (anyTransactionId: string) => `/inApps/v2/history/${enc(anyTransactionId)}`,
} as const;

/** The `Authorization` scheme for the signed token. [appstoreserverapi/generating-json-web-tokens-for-api-requests] */
export const APPSTORE_AUTH_SCHEME = 'Bearer';

/** JWT header `alg` and `typ`, and the `aud` claim. [appstoreserverapi/generating-json-web-tokens-for-api-requests] */
export const API_TOKEN_ALGORITHM = 'ES256';
export const API_TOKEN_TYPE = 'JWT';
export const API_TOKEN_AUDIENCE = 'appstoreconnect-v1';

/**
 * Lifetime of the token this adapter signs. Apple rejects tokens that expire more than 60 minutes after `iat`; a token is
 * made for each request, so a short life is enough (Apple's own library uses 5 minutes).
 */
export const API_TOKEN_LIFETIME_SECONDS = 5 * 60;

/** Query parameters of Get Transaction History and their values. [appstoreserverapi/get-transaction-history] */
export const HISTORY_QUERY_PRODUCT_TYPE = 'productType';
export const HISTORY_QUERY_SORT = 'sort';
export const HISTORY_QUERY_REVISION = 'revision';
export const HISTORY_SORT_DESCENDING = 'DESCENDING';
/** The `productType` filter value of auto-renewable subscriptions. [appstoreserverapi/get-transaction-history] */
export const HISTORY_PRODUCT_TYPE_AUTO_RENEWABLE = 'AUTO_RENEWABLE';

/** Each history page holds at most 20 transactions. [appstoreserverapi/historyresponse] */
export const HISTORY_PAGE_SIZE = 20;
/** Most history pages `listCharges` reads for one call (20 per page), so a call cannot run away on a long history. */
export const MAX_HISTORY_PAGES = 10;
/** Charges `listCharges` returns when the caller gives no limit. */
export const DEFAULT_LIST_CHARGES_LIMIT = 20;

/** The longest error text kept in a message. */
export const MAX_ERROR_TEXT = 500;

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

/** `errorCode` of Apple's error bodies. [appstoreserverapi/error-codes and each error page] */
export const AppStoreErrorCode = {
  InvalidAppIdentifier: 4000002,
  InvalidTransactionId: 4000006,
  AccountNotFound: 4040001,
  AccountNotFoundRetryable: 4040002,
  AppNotFound: 4040003,
  AppNotFoundRetryable: 4040004,
  OriginalTransactionIdNotFound: 4040005,
  OriginalTransactionIdNotFoundRetryable: 4040006,
  TransactionIdNotFound: 4040010,
  RateLimitExceeded: 4290000,
  GeneralInternal: 5000000,
  GeneralInternalRetryable: 5000001,
} as const;
export type AppStoreErrorCode = (typeof AppStoreErrorCode)[keyof typeof AppStoreErrorCode];

/**
 * Apple's "Errors to retry": the answer is HTTP 404 or 500 but asking again later may succeed, so they are not
 * `NOT_FOUND`. [appstoreserverapi/error-codes, "Errors to retry"]
 */
export const RETRYABLE_ERROR_CODES: readonly number[] = [
  AppStoreErrorCode.AccountNotFoundRetryable,
  AppStoreErrorCode.AppNotFoundRetryable,
  AppStoreErrorCode.OriginalTransactionIdNotFoundRetryable,
  AppStoreErrorCode.GeneralInternalRetryable,
];

// ---------------------------------------------------------------------------
// Statuses and enumerations of the payloads
// ---------------------------------------------------------------------------

/** `status` of an auto-renewable subscription. [appstoreserverapi/status] */
export const AppStoreSubscriptionStatus = {
  Active: 1,
  Expired: 2,
  BillingRetry: 3,
  GracePeriod: 4,
  Revoked: 5,
} as const;
export type AppStoreSubscriptionStatus = (typeof AppStoreSubscriptionStatus)[keyof typeof AppStoreSubscriptionStatus];

/**
 * Apple's status onto the unified status. Expired is refined by the expiration intent (`EXPIRATION_INTENT_STATUS`).
 * A status Apple adds later falls back to `expired` (`UNKNOWN_SUBSCRIPTION_STATUS`): access is never granted for a state
 * this adapter does not know; `providerStatus` still carries the number.
 */
export const SUBSCRIPTION_STATUS_MAP: Record<AppStoreSubscriptionStatus, SubscriptionStatus> = {
  [AppStoreSubscriptionStatus.Active]: SubscriptionStatus.Active,
  [AppStoreSubscriptionStatus.Expired]: SubscriptionStatus.Expired,
  // Billing retry without a grace period: the customer has no access, Apple keeps retrying for up to 60 days.
  [AppStoreSubscriptionStatus.BillingRetry]: SubscriptionStatus.PastDue,
  // Billing Grace Period: "Continue to provide access". [appstoreservernotifications/notificationtype, DID_FAIL_TO_RENEW]
  [AppStoreSubscriptionStatus.GracePeriod]: SubscriptionStatus.PastDue,
  [AppStoreSubscriptionStatus.Revoked]: SubscriptionStatus.Cancelled,
};
export const UNKNOWN_SUBSCRIPTION_STATUS: SubscriptionStatus = SubscriptionStatus.Expired;

/** `expirationIntent` of the renewal info. [appstoreserverapi/expirationintent] */
export const ExpirationIntent = {
  CustomerCancelled: 1,
  BillingError: 2,
  PriceIncreaseNotConsented: 3,
  ProductUnavailable: 4,
  Other: 5,
} as const;
export type ExpirationIntent = (typeof ExpirationIntent)[keyof typeof ExpirationIntent];

/**
 * Why an expired subscription ended, as a unified status. The customer cancelled: `cancelled`. The billing retry period ended
 * without a payment: `halted` (retries exhausted). Any other reason, or none: `expired`.
 */
export const EXPIRATION_INTENT_STATUS: Record<ExpirationIntent, SubscriptionStatus> = {
  [ExpirationIntent.CustomerCancelled]: SubscriptionStatus.Cancelled,
  [ExpirationIntent.BillingError]: SubscriptionStatus.Halted,
  [ExpirationIntent.PriceIncreaseNotConsented]: SubscriptionStatus.Expired,
  [ExpirationIntent.ProductUnavailable]: SubscriptionStatus.Expired,
  [ExpirationIntent.Other]: SubscriptionStatus.Expired,
};

/** `autoRenewStatus`. [appstoreserverapi/autorenewstatus] */
export const AutoRenewStatus = {
  Off: 0,
  On: 1,
} as const;

/** `environment` of the payloads. [appstoreserverapi/environment] */
export const AppStoreEnvironment = {
  Sandbox: 'Sandbox',
  Production: 'Production',
} as const;
export type AppStoreEnvironment = (typeof AppStoreEnvironment)[keyof typeof AppStoreEnvironment];

/** The Apple environment each shared `Environment` talks to. */
export const APPSTORE_ENVIRONMENTS: Record<Environment, AppStoreEnvironment> = {
  [Environment.Test]: AppStoreEnvironment.Sandbox,
  [Environment.Live]: AppStoreEnvironment.Production,
};

/** `type` of a transaction. [appstoreserverapi/type] */
export const AppStoreProductType = {
  AutoRenewableSubscription: 'Auto-Renewable Subscription',
  NonConsumable: 'Non-Consumable',
  Consumable: 'Consumable',
  NonRenewingSubscription: 'Non-Renewing Subscription',
} as const;
export type AppStoreProductType = (typeof AppStoreProductType)[keyof typeof AppStoreProductType];

/** `offerDiscountType`. [appstoreserverapi/offerdiscounttype] */
export const OfferDiscountType = {
  FreeTrial: 'FREE_TRIAL',
  PayAsYouGo: 'PAY_AS_YOU_GO',
  PayUpFront: 'PAY_UP_FRONT',
  OneTime: 'ONE_TIME',
} as const;

/** `revocationType`. [appstoreserverapi/revocationtype] */
export const RevocationType = {
  RefundFull: 'REFUND_FULL',
  RefundProrated: 'REFUND_PRORATED',
  FamilyRevoke: 'FAMILY_REVOKE',
  AssignmentRevoke: 'ASSIGNMENT_REVOKE',
} as const;

/** `providerStatus` of a transaction that was not revoked. The payload has no status of its own for it. */
export const TRANSACTION_STATUS_PURCHASED = 'PURCHASED';
/** `providerStatus` of a revoked transaction whose payload names no `revocationType`. */
export const TRANSACTION_STATUS_REVOKED = 'REVOKED';
/** `providerStatus` of what `createSubscription` / `createPayment` return: nothing has been bought yet. */
export const STATUS_NOT_PURCHASED = 'not_purchased';

/** `revocationPercentage` is in milliunits of a percent: 100000 is the whole transaction. [appstoreserverapi/jwstransactiondecodedpayload] */
export const REVOCATION_PERCENTAGE_FULL = 100_000;

/**
 * Transaction status for a revoked transaction: a full or unspecified refund is `refunded`, a prorated refund
 * `partially_refunded`, and a revocation that returned no money (Family Sharing, a group assignment) `cancelled`.
 */
export const REVOCATION_PAYMENT_STATUS: Record<string, PaymentStatus> = {
  [RevocationType.RefundFull]: PaymentStatus.Refunded,
  [RevocationType.RefundProrated]: PaymentStatus.PartiallyRefunded,
  [RevocationType.FamilyRevoke]: PaymentStatus.Cancelled,
  [RevocationType.AssignmentRevoke]: PaymentStatus.Cancelled,
};
/** The same, for a charge. */
export const REVOCATION_CHARGE_STATUS: Record<string, ChargeStatus> = {
  [RevocationType.RefundFull]: ChargeStatus.Refunded,
  [RevocationType.RefundProrated]: ChargeStatus.PartiallyRefunded,
  [RevocationType.FamilyRevoke]: ChargeStatus.Cancelled,
  [RevocationType.AssignmentRevoke]: ChargeStatus.Cancelled,
};
/** The revocation types that returned money to the customer. */
export const REFUND_REVOCATION_TYPES: readonly string[] = [RevocationType.RefundFull, RevocationType.RefundProrated];

// ---------------------------------------------------------------------------
// Notifications V2
// ---------------------------------------------------------------------------

/** `notificationType`. [appstoreservernotifications/notificationtype] */
export const NotificationType = {
  ConsumptionRequest: 'CONSUMPTION_REQUEST',
  DidChangeRenewalPref: 'DID_CHANGE_RENEWAL_PREF',
  DidChangeRenewalStatus: 'DID_CHANGE_RENEWAL_STATUS',
  DidFailToRenew: 'DID_FAIL_TO_RENEW',
  DidRenew: 'DID_RENEW',
  Expired: 'EXPIRED',
  ExternalPurchaseToken: 'EXTERNAL_PURCHASE_TOKEN',
  GracePeriodExpired: 'GRACE_PERIOD_EXPIRED',
  MetadataUpdate: 'METADATA_UPDATE',
  Migration: 'MIGRATION',
  OfferRedeemed: 'OFFER_REDEEMED',
  OneTimeCharge: 'ONE_TIME_CHARGE',
  PriceChange: 'PRICE_CHANGE',
  PriceIncrease: 'PRICE_INCREASE',
  Refund: 'REFUND',
  RefundDeclined: 'REFUND_DECLINED',
  RefundReversed: 'REFUND_REVERSED',
  RenewalExtended: 'RENEWAL_EXTENDED',
  RenewalExtension: 'RENEWAL_EXTENSION',
  RescindConsent: 'RESCIND_CONSENT',
  Revoke: 'REVOKE',
  Subscribed: 'SUBSCRIBED',
  Test: 'TEST',
  UnclaimSeats: 'UNCLAIM_SEATS',
} as const;
export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType];

/** `subtype`. [appstoreservernotifications/subtype] */
export const NotificationSubtype = {
  Accepted: 'ACCEPTED',
  ActiveTokenReminder: 'ACTIVE_TOKEN_REMINDER',
  AutoRenewDisabled: 'AUTO_RENEW_DISABLED',
  AutoRenewEnabled: 'AUTO_RENEW_ENABLED',
  BillingRecovery: 'BILLING_RECOVERY',
  BillingRetry: 'BILLING_RETRY',
  Created: 'CREATED',
  DecreaseQuantity: 'DECREASE_QUANTITY',
  Downgrade: 'DOWNGRADE',
  Failure: 'FAILURE',
  GracePeriod: 'GRACE_PERIOD',
  IncreaseQuantity: 'INCREASE_QUANTITY',
  InitialBuy: 'INITIAL_BUY',
  Pending: 'PENDING',
  PriceIncrease: 'PRICE_INCREASE',
  ProductNotForSale: 'PRODUCT_NOT_FOR_SALE',
  Resubscribe: 'RESUBSCRIBE',
  Seats: 'SEATS',
  Summary: 'SUMMARY',
  Upgrade: 'UPGRADE',
  Unreported: 'UNREPORTED',
  Voluntary: 'VOLUNTARY',
} as const;
export type NotificationSubtype = (typeof NotificationSubtype)[keyof typeof NotificationSubtype];

/** Separator of a table key built from a type and a subtype. */
export const NOTIFICATION_KEY_SEPARATOR = ':';

/** The table key of a notification: `TYPE` or `TYPE:SUBTYPE`. */
export function notificationKey(type: string, subtype?: string): string {
  return subtype ? `${type}${NOTIFICATION_KEY_SEPARATOR}${subtype}` : type;
}

/**
 * Every notification type and subtype Apple documents, as a unified event. A key with a subtype is looked up first, then the bare
 * type; a pair the table does not hold (a type or subtype Apple adds later) is `unknown`, never an error, and the event still
 * carries the verified `raw` payload. Notes on the choices:
 *
 * - The subscription events apply to auto-renewable subscriptions; the same notifications about another product type are
 *   `unknown` (see `mapNotification`).
 * - `DID_FAIL_TO_RENEW` and `GRACE_PERIOD_EXPIRED` are `subscription.past_due`: billing retry, with or without a grace period, is
 *   the `past_due` status, and `subscription.status` on the event says whether access continues.
 * - The customer turning auto-renew off keeps the paid period running, so it is `subscription.updated` with
 *   `cancelAtPeriodEnd`, not `subscription.cancelled`. A cancelled subscription is one that expired (`EXPIRED`) because the
 *   customer turned it off (`VOLUNTARY`), or that was revoked.
 * - Notifications that carry no subscription or payment (`TEST`, consumption requests, refund declined or reversed,
 *   renewal extension summaries, external purchase tokens, consent, the Advanced Commerce API ones, seat management) are `unknown`.
 *   A refund of seats (`REFUND:SEATS`) is `unknown` too: its amount is a share of a multiseat price the payload does not give.
 */
export const NOTIFICATION_EVENT_MAP: Record<string, EventType> = {
  [notificationKey(NotificationType.Subscribed)]: EventType.SubscriptionActivated,
  [notificationKey(NotificationType.DidRenew)]: EventType.SubscriptionCharged,
  [notificationKey(NotificationType.DidFailToRenew)]: EventType.SubscriptionPastDue,
  [notificationKey(NotificationType.GracePeriodExpired)]: EventType.SubscriptionPastDue,
  [notificationKey(NotificationType.Expired)]: EventType.SubscriptionExpired,
  [notificationKey(NotificationType.Expired, NotificationSubtype.Voluntary)]: EventType.SubscriptionCancelled,
  [notificationKey(NotificationType.Expired, NotificationSubtype.BillingRetry)]: EventType.SubscriptionHalted,
  [notificationKey(NotificationType.Expired, NotificationSubtype.PriceIncrease)]: EventType.SubscriptionExpired,
  [notificationKey(NotificationType.Expired, NotificationSubtype.ProductNotForSale)]: EventType.SubscriptionExpired,
  [notificationKey(NotificationType.DidChangeRenewalStatus)]: EventType.SubscriptionUpdated,
  [notificationKey(NotificationType.DidChangeRenewalPref)]: EventType.SubscriptionUpdated,
  [notificationKey(NotificationType.OfferRedeemed)]: EventType.SubscriptionUpdated,
  [notificationKey(NotificationType.PriceIncrease)]: EventType.SubscriptionUpdated,
  [notificationKey(NotificationType.RenewalExtended)]: EventType.SubscriptionUpdated,
  [notificationKey(NotificationType.Revoke)]: EventType.SubscriptionCancelled,
  [notificationKey(NotificationType.OneTimeCharge)]: EventType.PaymentSucceeded,
  [notificationKey(NotificationType.Refund)]: EventType.RefundSucceeded,
  [notificationKey(NotificationType.Refund, NotificationSubtype.Seats)]: EventType.Unknown,
  [notificationKey(NotificationType.RefundDeclined)]: EventType.Unknown,
  [notificationKey(NotificationType.RefundReversed)]: EventType.Unknown,
  [notificationKey(NotificationType.ConsumptionRequest)]: EventType.Unknown,
  [notificationKey(NotificationType.RenewalExtension)]: EventType.Unknown,
  [notificationKey(NotificationType.RenewalExtension, NotificationSubtype.Summary)]: EventType.Unknown,
  [notificationKey(NotificationType.RenewalExtension, NotificationSubtype.Failure)]: EventType.Unknown,
  [notificationKey(NotificationType.ExternalPurchaseToken)]: EventType.Unknown,
  [notificationKey(NotificationType.MetadataUpdate)]: EventType.Unknown,
  [notificationKey(NotificationType.Migration)]: EventType.Unknown,
  [notificationKey(NotificationType.PriceChange)]: EventType.Unknown,
  [notificationKey(NotificationType.RescindConsent)]: EventType.Unknown,
  [notificationKey(NotificationType.Test)]: EventType.Unknown,
  [notificationKey(NotificationType.UnclaimSeats)]: EventType.Unknown,
};

/** The event types that are about an auto-renewable subscription; they degrade to `unknown` for another product type. */
export const SUBSCRIPTION_EVENT_TYPES: readonly EventType[] = [
  EventType.SubscriptionActivated,
  EventType.SubscriptionCharged,
  EventType.SubscriptionPastDue,
  EventType.SubscriptionExpired,
  EventType.SubscriptionCancelled,
  EventType.SubscriptionHalted,
  EventType.SubscriptionUpdated,
];

/** An external purchase token whose id starts with this is a sandbox one. [Apple's library, JWS verification] */
export const EXTERNAL_PURCHASE_SANDBOX_PREFIX = 'SANDBOX';

// ---------------------------------------------------------------------------
// Signed data (JWS)
// ---------------------------------------------------------------------------

/** The only `alg` accepted in a JWS header. [appstoreserverapi/jwsdecodedheader] */
export const JWS_ALGORITHM = 'ES256';
/** A JWS compact serialisation has a header, a payload and a signature. */
export const JWS_PART_COUNT = 3;
/** The `x5c` chain: leaf, intermediate, root, "in the following order". [appstoreserverapi/jwsdecodedheader] */
export const X5C_CHAIN_LENGTH = 3;
/** An ES256 signature is `r` and `s`, 32 bytes each. */
export const ES256_SIGNATURE_BYTES = 64;
/** The curve of a leaf key that can verify ES256, as Node names it. */
export const ES256_CURVE = 'prime256v1';
/** Node's name for an elliptic-curve key, and for the raw `r||s` signature form a JWS uses (IEEE P1363). */
export const EC_KEY_TYPE = 'ec';
export const JWS_SIGNATURE_ENCODING = 'ieee-p1363';

/** Certificate validity is checked with this slack on both sides, as Apple's library does. */
export const CERTIFICATE_CLOCK_SKEW_MS = 60_000;

/** Extension of the intermediate: Apple Worldwide Developer Relations. [appstoreserverapi/jwsdecodedheader] */
export const WWDR_INTERMEDIATE_OID = '1.2.840.113635.100.6.2.1';
/** Extension of the leaf: Mac App Store receipt signing (Apple's certification practice statement, 4.11.10). */
export const RECEIPT_SIGNING_LEAF_OID = '1.2.840.113635.100.6.11.1';

/**
 * Apple Root CA - G3, the root of the `x5c` chain, from https://www.apple.com/certificateauthority/AppleRootCA-G3.cer
 * (valid 2014-04-30 to 2039-04-30, EC P-384).
 */
export const APPLE_ROOT_CA_G3_PEM = `-----BEGIN CERTIFICATE-----
MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwS
QXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN
MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBS
b290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9y
aXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49
AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtf
TjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517
IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySr
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gA
MGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4
at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM
6BgD56KyKA==
-----END CERTIFICATE-----
`;

/**
 * SHA-256 fingerprint (hex) of Apple Root CA - G3: the certificate above is pinned to it, and a build that carries a
 * different certificate refuses to start. Apple's certificate authority page does not print fingerprints; this is the
 * fingerprint of the certificate downloaded from the address above.
 */
export const APPLE_ROOT_CA_G3_SHA256 = '63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179';

// ---------------------------------------------------------------------------
// Checkout results and promotional offers
// ---------------------------------------------------------------------------

/**
 * The keys of the checkout result the device sends to `verifyCheckout` / `verifyPayment`: the JWS of the transaction
 * StoreKit returned (`VerificationResult.jwsRepresentation`).
 */
export const AppStoreResultKey = {
  SignedTransaction: 'signedTransaction',
} as const;

/** Joins the parts of a promotional offer signature (U+2063, "invisible separator"). [storekit/generating-a-signature-for-promotional-offers] */
export const OFFER_SIGNATURE_SEPARATOR = '⁣';
/** The promotional offer signature is Base64 of the DER-encoded ECDSA signature. */
export const OFFER_SIGNATURE_ENCODING = 'base64';

/** A UUID, lower or upper case: what an app account token looks like, and what a store id never does. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Milliunits (1/1000 of a currency unit) in one paise: INR 1 = 1000 milliunits = 100 paise. */
export const MILLIUNITS_PER_PAISE = 10;
