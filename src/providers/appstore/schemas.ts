import { z } from 'zod';
import { Environment } from '../../constants.js';
import { AppStoreResultKey, JWS_ALGORITHM } from './constants.js';

/**
 * Zod schemas for everything the App Store sends or receives. JSON field names appear here once. Responses and signed payloads
 * are tolerant: only the fields the adapter reads are required, the rest is optional, and unknown fields are kept. Apple
 * documents most numbers as `int64` / `int32`; the schemas take JSON numbers.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** A key made in App Store Connect: its id and the `.p8` file (PKCS #8, PEM). */
export const AppStoreKeySchema = z.object({
  /** The key id shown next to the key in App Store Connect. */
  keyId: z.string().min(1, { error: 'keyId is required' }),
  /** The text of the `.p8` file. Never logged, never put in an error or in `raw`. */
  privateKey: z.string().min(1, { error: 'privateKey is required' }),
});

export const AppStoreConfigSchema = z
  .object({
    /** The app's bundle id (the `bid` claim of every API token; compared with the signed data). */
    bundleId: z.string().min(1, { error: 'bundleId is required' }),
    /** The issuer id from the Keys page of App Store Connect (the `iss` claim). */
    issuerId: z.string().min(1, { error: 'issuerId is required' }),
    /** The id of the In-App Purchase key that signs API requests. */
    keyId: z.string().min(1, { error: 'keyId is required' }),
    /** The text of that key's `.p8` file. Never logged, never put in an error or in `raw`. */
    privateKey: z.string().min(1, { error: 'privateKey is required' }),
    /** `test` calls Apple's sandbox, `live` calls production. */
    environment: z.enum(Environment, { error: 'environment must be "test" or "live"' }),
    /**
     * The app's Apple id (App Store Connect, App Information). Production notifications name it and it is checked against this
     * value; sandbox notifications omit it. Required when `environment` is `live`.
     */
    appAppleId: z
      .union([z.number().int().positive(), z.string().regex(/^\d+$/, { error: 'appAppleId must be digits' }).transform(Number)], {
        error: 'appAppleId must be a number',
      })
      .optional(),
    /**
     * The key that signs promotional offers; needed only to sell a subscription with `storeProduct.offerId`. It may be the
     * same key as above.
     */
    promotionalOfferKey: AppStoreKeySchema.optional(),
    /**
     * PEM certificates that replace Apple Root CA - G3 as the trusted root. For tests with a private certificate authority;
     * leave it out in production.
     */
    rootCertificates: z.array(z.string().min(1)).min(1, { error: 'rootCertificates must not be empty' }).optional(),
  })
  .refine((config) => config.environment !== Environment.Live || config.appAppleId !== undefined, {
    error: 'appAppleId is required when environment is "live": production notifications are checked against it',
    path: ['appAppleId'],
  });
export type AppStoreConfig = z.input<typeof AppStoreConfigSchema>;
export type ParsedAppStoreConfig = z.output<typeof AppStoreConfigSchema>;

// ---------------------------------------------------------------------------
// Checkout result: what the device sends back
// ---------------------------------------------------------------------------

/** The checkout result of the device: the JWS of the transaction StoreKit returned. */
export const AppStoreCheckoutResultSchema = z.looseObject({
  [AppStoreResultKey.SignedTransaction]: z.string().min(1, { error: 'signedTransaction must not be empty' }),
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const AppStoreErrorBodySchema = z.looseObject({
  errorCode: z.number().nullish(),
  errorMessage: z.string().nullish(),
});
export type AppStoreErrorBody = z.output<typeof AppStoreErrorBodySchema>;

// ---------------------------------------------------------------------------
// Signed data
// ---------------------------------------------------------------------------

/** The JWS header. [appstoreserverapi/jwsdecodedheader] */
export const JwsHeaderSchema = z.looseObject({
  alg: z.literal(JWS_ALGORITHM),
  x5c: z.array(z.string().min(1)),
});
export type JwsHeader = z.output<typeof JwsHeaderSchema>;

/** `JWSTransactionDecodedPayload`. [appstoreserverapi/jwstransactiondecodedpayload] */
export const TransactionPayloadSchema = z.looseObject({
  transactionId: z.string().min(1),
  originalTransactionId: z.string().min(1),
  // Checked against the config after the signature verifies; a payload that omits them fails that check.
  bundleId: z.string().nullish(),
  environment: z.string().nullish(),
  productId: z.string().min(1),
  type: z.string().nullish(),
  purchaseDate: z.number().nullish(),
  originalPurchaseDate: z.number().nullish(),
  expiresDate: z.number().nullish(),
  signedDate: z.number().nullish(),
  quantity: z.number().nullish(),
  /** The price multiplied by 1000 (milliunits of `currency`). */
  price: z.number().int().nullish(),
  currency: z.string().nullish(),
  storefront: z.string().nullish(),
  appAccountToken: z.string().nullish(),
  offerType: z.number().nullish(),
  offerIdentifier: z.string().nullish(),
  offerDiscountType: z.string().nullish(),
  revocationDate: z.number().nullish(),
  revocationReason: z.number().nullish(),
  revocationType: z.string().nullish(),
  revocationPercentage: z.number().nullish(),
  transactionReason: z.string().nullish(),
  inAppOwnershipType: z.string().nullish(),
  subscriptionGroupIdentifier: z.string().nullish(),
});
export type TransactionPayload = z.output<typeof TransactionPayloadSchema>;

/** `JWSRenewalInfoDecodedPayload`. [appstoreserverapi/jwsrenewalinfodecodedpayload] */
export const RenewalInfoPayloadSchema = z.looseObject({
  originalTransactionId: z.string().nullish(),
  environment: z.string().nullish(),
  productId: z.string().nullish(),
  autoRenewProductId: z.string().nullish(),
  autoRenewStatus: z.number().nullish(),
  expirationIntent: z.number().nullish(),
  isInBillingRetryPeriod: z.boolean().nullish(),
  gracePeriodExpiresDate: z.number().nullish(),
  renewalDate: z.number().nullish(),
  /** In milliunits of `currency`. */
  renewalPrice: z.number().int().nullish(),
  currency: z.string().nullish(),
  offerType: z.number().nullish(),
  offerIdentifier: z.string().nullish(),
  offerDiscountType: z.string().nullish(),
  appAccountToken: z.string().nullish(),
  signedDate: z.number().nullish(),
});
export type RenewalInfoPayload = z.output<typeof RenewalInfoPayloadSchema>;

// ---------------------------------------------------------------------------
// Server API responses
// ---------------------------------------------------------------------------

/** `lastTransactionsItem`. [appstoreserverapi/lasttransactionsitem] */
export const LastTransactionSchema = z.looseObject({
  originalTransactionId: z.string().min(1),
  status: z.number(),
  signedRenewalInfo: z.string().nullish(),
  signedTransactionInfo: z.string().min(1),
});
export type LastTransaction = z.output<typeof LastTransactionSchema>;

/** `StatusResponse`. [appstoreserverapi/statusresponse] */
export const StatusResponseSchema = z.looseObject({
  environment: z.string().nullish(),
  bundleId: z.string().nullish(),
  appAppleId: z.number().nullish(),
  data: z
    .array(
      z.looseObject({
        subscriptionGroupIdentifier: z.string().nullish(),
        lastTransactions: z.array(LastTransactionSchema).nullish(),
      }),
    )
    .nullish(),
});
export type StatusResponse = z.output<typeof StatusResponseSchema>;

/** `TransactionInfoResponse`. [appstoreserverapi/transactioninforesponse] */
export const TransactionInfoResponseSchema = z.looseObject({
  signedTransactionInfo: z.string().min(1),
});

/** `HistoryResponse`. [appstoreserverapi/historyresponse] */
export const HistoryResponseSchema = z.looseObject({
  environment: z.string().nullish(),
  bundleId: z.string().nullish(),
  hasMore: z.boolean().nullish(),
  revision: z.string().nullish(),
  signedTransactions: z.array(z.string().min(1)).nullish(),
});
export type HistoryResponse = z.output<typeof HistoryResponseSchema>;

// ---------------------------------------------------------------------------
// Notifications V2
// ---------------------------------------------------------------------------

/** The body of a notification POST. [appstoreservernotifications/responsebodyv2] */
export const NotificationBodySchema = z.looseObject({
  signedPayload: z.string().min(1),
});

/** `data`. [appstoreservernotifications/data] */
export const NotificationDataSchema = z.looseObject({
  appAppleId: z.number().nullish(),
  bundleId: z.string().nullish(),
  environment: z.string().nullish(),
  status: z.number().nullish(),
  signedTransactionInfo: z.string().nullish(),
  signedRenewalInfo: z.string().nullish(),
});
export type NotificationData = z.output<typeof NotificationDataSchema>;

/**
 * The objects of a notification other than `data` that name the app. They have no signed transaction; they matter here only
 * because the bundle id and the environment they carry are checked like those of `data`.
 */
export const NotificationAppInfoSchema = z.looseObject({
  appAppleId: z.number().nullish(),
  bundleId: z.string().nullish(),
  environment: z.string().nullish(),
});

/** `externalPurchaseToken`: no `environment`; a sandbox token's id starts with `SANDBOX`. [appstoreservernotifications/externalpurchasetoken] */
export const NotificationExternalTokenSchema = z.looseObject({
  externalPurchaseId: z.string().min(1),
  appAppleId: z.number().nullish(),
  bundleId: z.string().nullish(),
});

/** `responseBodyV2DecodedPayload`. [appstoreservernotifications/responsebodyv2decodedpayload] */
export const NotificationPayloadSchema = z.looseObject({
  notificationType: z.string().min(1),
  subtype: z.string().nullish(),
  notificationUUID: z.string().min(1),
  signedDate: z.number().nullish(),
  version: z.string().nullish(),
  data: NotificationDataSchema.nullish(),
  summary: NotificationAppInfoSchema.nullish(),
  appData: NotificationAppInfoSchema.nullish(),
  unclaimInfo: NotificationAppInfoSchema.nullish(),
  externalPurchaseToken: NotificationExternalTokenSchema.nullish(),
});
export type NotificationPayload = z.output<typeof NotificationPayloadSchema>;
