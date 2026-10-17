import { z } from 'zod';
import { Environment } from '../../constants.js';
import {
  ExternalSubscriptionType,
  GoogleCancellationType,
  GooglePlayResultKey,
  MAX_EXTERNAL_TRANSACTION_ID_LENGTH,
} from './constants.js';

/**
 * Zod schemas for everything Google sends or receives. JSON field names appear here once. Requests are strict about what
 * this adapter sends; responses and notifications are tolerant: only the fields the adapter reads are required, the rest
 * is `.nullish()` (Google's samples print `null` for absent objects), and every status or type is read as a plain string
 * or number and translated through a lookup table in `constants.ts`.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** An Android package name: dot-separated Java identifiers, at least two segments (for example `com.some.thing`). */
const PACKAGE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

export const GooglePlayConfigSchema = z
  .object({
    /** The app's package name, as in Play Console. Every call and every notification is scoped to it. */
    packageName: z
      .string()
      .regex(PACKAGE_NAME_PATTERN, { error: 'packageName must be an Android package name such as com.example.app' }),
    /** `client_email` of the service account key (JSON). The account needs Play Console access to the app. */
    clientEmail: z.email({ error: 'clientEmail must be the service account e-mail address' }),
    /** `private_key` of the service account key (PEM). Never logged, never put in an error or in `raw`. */
    privateKey: z.string().min(1, { error: 'privateKey is required' }),
    /** `private_key_id` of the key; sent as the `kid` of the assertion. Optional. */
    privateKeyId: z.string().min(1, { error: 'privateKeyId must not be empty' }).optional(),
    /**
     * `live` refuses to grant anything for a test purchase (one made by a licence tester, which Google does not charge);
     * `test` accepts them. The Developer API has one host: both environments call it.
     */
    environment: z.enum(Environment, { error: 'environment must be "test" or "live"' }),
    /**
     * Push authentication of the Pub/Sub subscription: the audience the subscription was created with, and the e-mail of
     * its push authentication service account. Set both or neither. When set, every webhook must carry a Google-signed
     * OIDC token with exactly this audience and e-mail.
     */
    pushAudience: z.string().min(1, { error: 'pushAudience must not be empty' }).optional(),
    pushServiceAccountEmail: z.email({ error: 'pushServiceAccountEmail must be an e-mail address' }).optional(),
    /**
     * Without push authentication a webhook cannot be told from a forgery, so it is refused. Set this only when the
     * route is protected some other way (a private network, a secret path). The notification content is then still
     * checked against Google by fetching the purchase, which is what the documentation asks every integration to do.
     */
    acceptUnauthenticatedWebhooks: z.boolean().default(false),
    /**
     * `refundCharge` / `refundPayment` call `orders.refund` with `revoke=true`: access ends with the refund, and for a
     * subscription all future payments stop. Set false to refund the money only.
     */
    revokeOnRefund: z.boolean().default(true),
    /** Product ids of consumable one-time products: `verifyPayment` consumes these instead of acknowledging them. */
    consumableProductIds: z.array(z.string().min(1)).default([]),
  })
  .refine((config) => (config.pushAudience === undefined) === (config.pushServiceAccountEmail === undefined), {
    error: 'pushAudience and pushServiceAccountEmail go together: set both to authenticate pushes, or neither',
    path: ['pushAudience'],
  });
export type GooglePlayConfig = z.input<typeof GooglePlayConfigSchema>;
export type ParsedGooglePlayConfig = z.output<typeof GooglePlayConfigSchema>;

// ---------------------------------------------------------------------------
// OAuth token, API errors
// ---------------------------------------------------------------------------

export const GoogleTokenResponseSchema = z.looseObject({
  access_token: z.string().min(1),
  expires_in: z.number().positive().nullish(),
  token_type: z.string().nullish(),
});
export type GoogleTokenResponse = z.infer<typeof GoogleTokenResponseSchema>;

/** The OAuth token endpoint's error body. */
export const GoogleTokenErrorSchema = z.looseObject({
  error: z.string().nullish(),
  error_description: z.string().nullish(),
});

/** The standard Google API error body. */
export const GoogleApiErrorSchema = z.looseObject({
  error: z
    .looseObject({
      code: z.number().nullish(),
      message: z.string().nullish(),
      status: z.string().nullish(),
      errors: z.array(z.looseObject({ reason: z.string().nullish(), message: z.string().nullish() })).nullish(),
    })
    .nullish(),
});

// ---------------------------------------------------------------------------
// Checkout result
// ---------------------------------------------------------------------------

export const GooglePlayResultSchema = z.looseObject({
  [GooglePlayResultKey.PurchaseToken]: z.string().min(1, { error: 'purchaseToken is required' }),
  [GooglePlayResultKey.ProductId]: z.string().min(1).optional(),
  [GooglePlayResultKey.Consumable]: z.boolean().optional(),
});
export type GooglePlayResult = z.infer<typeof GooglePlayResultSchema>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** `google.type.Money`: whole units as a string (an int64) and nanos. */
export const GoogleMoneySchema = z.looseObject({
  currencyCode: z.string().min(1),
  units: z.union([z.string(), z.number()]).nullish(),
  nanos: z.number().int().nullish(),
});
export type GoogleMoney = z.infer<typeof GoogleMoneySchema>;

/** `Price` of the external transactions API: `priceMicros` is an int64 as a string. */
export const GooglePriceSchema = z.looseObject({
  currency: z.string().min(1),
  priceMicros: z.union([z.string(), z.number()]),
});

const ExternalAccountIdentifiersSchema = z.looseObject({
  externalAccountId: z.string().nullish(),
  obfuscatedExternalAccountId: z.string().nullish(),
  obfuscatedExternalProfileId: z.string().nullish(),
});

const SubscriptionLineItemSchema = z.looseObject({
  productId: z.string(),
  expiryTime: z.string().nullish(),
  latestSuccessfulOrderId: z.string().nullish(),
  autoRenewingPlan: z
    .looseObject({
      autoRenewEnabled: z.boolean().nullish(),
      recurringPrice: GoogleMoneySchema.nullish(),
      installmentDetails: z
        .looseObject({
          initialCommittedPaymentsCount: z.number().int().nullish(),
          remainingCommittedPaymentsCount: z.number().int().nullish(),
          pendingCancellation: z.looseObject({}).nullish(),
        })
        .nullish(),
    })
    .nullish(),
  prepaidPlan: z.looseObject({ allowExtendAfterTime: z.string().nullish() }).nullish(),
  offerDetails: z
    .looseObject({
      basePlanId: z.string().nullish(),
      offerId: z.string().nullish(),
      offerTags: z.array(z.string()).nullish(),
    })
    .nullish(),
  offerPhase: z
    .looseObject({
      freeTrial: z.looseObject({}).nullish(),
      introductoryPrice: z.looseObject({}).nullish(),
      basePrice: z.looseObject({}).nullish(),
      prorationPeriod: z.looseObject({}).nullish(),
    })
    .nullish(),
});
export type GoogleSubscriptionLineItem = z.infer<typeof SubscriptionLineItemSchema>;

/** `SubscriptionPurchaseV2`. Only `subscriptionState` and `lineItems` are required. */
export const GoogleSubscriptionPurchaseSchema = z.looseObject({
  kind: z.string().nullish(),
  regionCode: z.string().nullish(),
  lineItems: z.array(SubscriptionLineItemSchema),
  startTime: z.string().nullish(),
  subscriptionState: z.string(),
  latestOrderId: z.string().nullish(),
  linkedPurchaseToken: z.string().nullish(),
  pausedStateContext: z.looseObject({ autoResumeTime: z.string().nullish() }).nullish(),
  canceledStateContext: z
    .looseObject({
      userInitiatedCancellation: z.looseObject({ cancelTime: z.string().nullish() }).nullish(),
      systemInitiatedCancellation: z.looseObject({}).nullish(),
      developerInitiatedCancellation: z.looseObject({}).nullish(),
      replacementCancellation: z.looseObject({}).nullish(),
    })
    .nullish(),
  testPurchase: z.looseObject({}).nullish(),
  acknowledgementState: z.string().nullish(),
  externalAccountIdentifiers: ExternalAccountIdentifiersSchema.nullish(),
  etag: z.string().nullish(),
});
export type GoogleSubscriptionPurchase = z.infer<typeof GoogleSubscriptionPurchaseSchema>;

const ProductLineItemSchema = z.looseObject({
  productId: z.string(),
  productOfferDetails: z
    .looseObject({
      offerId: z.string().nullish(),
      purchaseOptionId: z.string().nullish(),
      quantity: z.number().int().nullish(),
      refundableQuantity: z.number().int().nullish(),
      consumptionState: z.string().nullish(),
    })
    .nullish(),
});
export type GoogleProductLineItem = z.infer<typeof ProductLineItemSchema>;

/** `ProductPurchaseV2`. Only the line items are required. */
export const GoogleProductPurchaseSchema = z.looseObject({
  kind: z.string().nullish(),
  productLineItem: z.array(ProductLineItemSchema),
  purchaseStateContext: z.looseObject({ purchaseState: z.string().nullish() }).nullish(),
  testPurchaseContext: z.looseObject({ fopType: z.string().nullish() }).nullish(),
  orderId: z.string().nullish(),
  obfuscatedExternalAccountId: z.string().nullish(),
  obfuscatedExternalProfileId: z.string().nullish(),
  regionCode: z.string().nullish(),
  purchaseCompletionTime: z.string().nullish(),
  acknowledgementState: z.string().nullish(),
});
export type GoogleProductPurchase = z.infer<typeof GoogleProductPurchaseSchema>;

const RefundDetailsSchema = z.looseObject({
  total: GoogleMoneySchema.nullish(),
  tax: GoogleMoneySchema.nullish(),
});

/** `Order`. Only the order id is required. */
export const GoogleOrderSchema = z.looseObject({
  orderId: z.string(),
  purchaseToken: z.string().nullish(),
  state: z.string().nullish(),
  createTime: z.string().nullish(),
  total: GoogleMoneySchema.nullish(),
  tax: GoogleMoneySchema.nullish(),
  lineItems: z
    .array(
      z.looseObject({
        productId: z.string().nullish(),
        subscriptionDetails: z
          .looseObject({
            basePlanId: z.string().nullish(),
            offerId: z.string().nullish(),
            offerPhaseDetails: z.looseObject({ freeTrialDetails: z.looseObject({}).nullish() }).nullish(),
          })
          .nullish(),
      }),
    )
    .nullish(),
  orderHistory: z
    .looseObject({
      processedEvent: z.looseObject({ eventTime: z.string().nullish() }).nullish(),
      cancellationEvent: z.looseObject({ eventTime: z.string().nullish() }).nullish(),
      refundEvent: z.looseObject({ eventTime: z.string().nullish(), refundDetails: RefundDetailsSchema.nullish() }).nullish(),
      partialRefundEvents: z
        .array(
          z.looseObject({
            processTime: z.string().nullish(),
            state: z.string().nullish(),
            refundDetails: RefundDetailsSchema.nullish(),
          }),
        )
        .nullish(),
    })
    .nullish(),
});
export type GoogleOrder = z.infer<typeof GoogleOrderSchema>;

/** `ExternalTransaction` as returned by create, get and refund. */
export const GoogleExternalTransactionSchema = z.looseObject({
  packageName: z.string().nullish(),
  externalTransactionId: z.string().nullish(),
  transactionState: z.string().nullish(),
  originalPreTaxAmount: GooglePriceSchema.nullish(),
  originalTaxAmount: GooglePriceSchema.nullish(),
  currentPreTaxAmount: GooglePriceSchema.nullish(),
  currentTaxAmount: GooglePriceSchema.nullish(),
});
export type GoogleExternalTransaction = z.infer<typeof GoogleExternalTransactionSchema>;

// ---------------------------------------------------------------------------
// Requests (strict: what this adapter sends)
// ---------------------------------------------------------------------------

export const GoogleCancelRequestSchema = z.object({
  cancellationContext: z.object({
    etag: z.string().optional(),
    cancellationType: z.enum(GoogleCancellationType),
  }),
});

/** An acknowledge request with no payload: the documented body is optional. */
export const GoogleAcknowledgeRequestSchema = z.object({});

const PriceRequestSchema = z.object({ currency: z.string().min(1), priceMicros: z.string().regex(/^\d+$/) });

export const GoogleExternalTransactionRequestSchema = z.object({
  originalPreTaxAmount: PriceRequestSchema,
  originalTaxAmount: PriceRequestSchema,
  transactionTime: z.string(),
  userTaxAddress: z.object({ regionCode: z.string().length(2), administrativeArea: z.string().min(1) }),
  oneTimeTransaction: z.object({ externalTransactionToken: z.string().min(1) }).optional(),
  recurringTransaction: z
    .object({
      externalTransactionToken: z.string().min(1).optional(),
      initialExternalTransactionId: z.string().min(1).max(MAX_EXTERNAL_TRANSACTION_ID_LENGTH).optional(),
      externalSubscription: z.object({ subscriptionType: z.enum(ExternalSubscriptionType) }),
    })
    .optional(),
});
export type GoogleExternalTransactionRequest = z.infer<typeof GoogleExternalTransactionRequestSchema>;

export const GoogleExternalRefundRequestSchema = z.object({
  refundTime: z.string(),
  partialRefund: z.object({ refundId: z.string().min(1), refundPreTaxAmount: PriceRequestSchema }).optional(),
  fullRefund: z.object({}).optional(),
});
export type GoogleExternalRefundRequest = z.infer<typeof GoogleExternalRefundRequestSchema>;

// ---------------------------------------------------------------------------
// Notifications (Pub/Sub push)
// ---------------------------------------------------------------------------

/** The body of a push request, wrapped. [https://cloud.google.com/pubsub/docs/push] */
export const PubSubPushSchema = z.looseObject({
  message: z.looseObject({
    data: z.string(),
    messageId: z.string().min(1).nullish(),
    message_id: z.string().min(1).nullish(),
    publishTime: z.string().nullish(),
    attributes: z.record(z.string(), z.string()).nullish(),
  }),
  subscription: z.string().nullish(),
});
export type PubSubPush = z.infer<typeof PubSubPushSchema>;

/** `eventTimeMillis` is a long, printed as a string in the documentation's samples. */
const MillisSchema = z.union([z.string(), z.number()]);

/** `DeveloperNotification`. Notification types are numbers, translated through tables in `constants.ts`. [RTDN] */
export const DeveloperNotificationSchema = z.looseObject({
  version: z.string().nullish(),
  packageName: z.string().min(1),
  eventTimeMillis: MillisSchema.nullish(),
  subscriptionNotification: z
    .looseObject({ version: z.string().nullish(), notificationType: z.number().int(), purchaseToken: z.string().min(1) })
    .nullish(),
  oneTimeProductNotification: z
    .looseObject({
      version: z.string().nullish(),
      notificationType: z.number().int(),
      purchaseToken: z.string().min(1),
      sku: z.string().nullish(),
    })
    .nullish(),
  voidedPurchaseNotification: z
    .looseObject({
      purchaseToken: z.string().min(1),
      orderId: z.string().min(1),
      productType: z.number().int().nullish(),
      refundType: z.number().int().nullish(),
    })
    .nullish(),
  pendingRefundReviewNotification: z
    .looseObject({ pendingRefundToken: z.string().nullish(), orderId: z.string().nullish(), refundReason: z.number().int().nullish() })
    .nullish(),
  testNotification: z.looseObject({ version: z.string().nullish() }).nullish(),
});
export type DeveloperNotification = z.infer<typeof DeveloperNotificationSchema>;

// ---------------------------------------------------------------------------
// Push authentication (OIDC token, JWKS)
// ---------------------------------------------------------------------------

export const JwtHeaderSchema = z.looseObject({ alg: z.string(), kid: z.string().nullish(), typ: z.string().nullish() });

/** The claims of a Pub/Sub push token. [https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions] */
export const PushTokenClaimsSchema = z.looseObject({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  iat: z.number().nullish(),
  email: z.string().nullish(),
  email_verified: z.union([z.boolean(), z.string()]).nullish(),
});
export type PushTokenClaims = z.infer<typeof PushTokenClaimsSchema>;

export const JwkSchema = z.looseObject({
  kty: z.string(),
  kid: z.string(),
  /** The RSA modulus and exponent; keys of another type (EC) do not have them and are skipped. */
  n: z.string().nullish(),
  e: z.string().nullish(),
  alg: z.string().nullish(),
  use: z.string().nullish(),
});
export type Jwk = z.infer<typeof JwkSchema>;

export const JwksSchema = z.looseObject({ keys: z.array(JwkSchema) });
