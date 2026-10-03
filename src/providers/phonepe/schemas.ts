import { z } from 'zod';
import { Environment } from '../../constants.js';
import {
  EXPIRE_AFTER_MAX_SECONDS,
  EXPIRE_AFTER_MIN_SECONDS,
  MAX_MANDATE_PAISE,
  MAX_MERCHANT_ID_LENGTH,
  MERCHANT_ID_PATTERN,
  MIN_NOTIFY_PAISE,
  MIN_TRANSACTION_SETUP_PAISE,
  PENNY_DROP_AMOUNT_PAISE,
  PHONEPE_GRANT_TYPE,
  PhonePeAmountType,
  PhonePeAuthWorkflowType,
  PhonePeFrequency,
  PhonePePaymentFlowType,
  PhonePeProductType,
  PhonePeRetryStrategy,
  PhonePeSubscriptionType,
  RETURN_SUBSCRIPTION_ID_PARAM,
  UDF_KEY_PATTERN,
  UDF_LONG_COUNT,
  UDF_LONG_MAX_LENGTH,
  UDF_SHORT_MAX_LENGTH,
  UDF_SHORT_PATTERN,
} from './constants.js';

/**
 * Zod schemas for everything PhonePe sends or receives. JSON and form field names appear here once. Requests are strict
 * about what this adapter sends (the documented limits are part of the schema); responses are tolerant: only the fields
 * the adapter reads are required, the rest is `.nullish()`, and numbers PhonePe documents as `Long` are also accepted
 * as numeric strings (the pages print `maxAmount` as a String in one place and a Long in another).
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const PhonePeConfigSchema = z
  .object({
    /** Client id from the PhonePe Business Dashboard (Developer Settings). */
    clientId: z.string().min(1, { error: 'clientId is required' }),
    /** Client secret. Never logged, never put in an error or in `raw`. */
    clientSecret: z.string().min(1, { error: 'clientSecret is required' }),
    /** `client_version` shared with the credentials (a number such as 1 or a string). */
    clientVersion: z
      .union([z.string().min(1), z.number().int().positive()], { error: 'clientVersion is required' })
      .transform(String),
    /** `test` calls the PhonePe sandbox (UAT), `live` calls production. */
    environment: z.enum(Environment, { error: 'environment must be "test" or "live"' }),
    /** Username of the webhook (Business Dashboard, "SHA (Username & Password)"); needed only for `parseWebhook`. */
    webhookUsername: z.string().min(1, { error: 'webhookUsername must not be empty' }).optional(),
    /** Password of the webhook. Needed only for `parseWebhook`. Never logged. */
    webhookPassword: z.string().min(1, { error: 'webhookPassword must not be empty' }).optional(),
    /** Default `redirectUrl` when a subscription has no `returnUrl`. */
    redirectUrl: z.url({ error: 'redirectUrl must be a valid URL' }).optional(),
    /** Overrides the PG host (a proxy or mock server), without a trailing path. */
    apiUrl: z.url({ error: 'apiUrl must be a valid URL' }).optional(),
    /** Overrides the OAuth token URL. */
    tokenUrl: z.url({ error: 'tokenUrl must be a valid URL' }).optional(),
  })
  .refine((config) => (config.webhookUsername === undefined) === (config.webhookPassword === undefined), {
    error: 'webhookUsername and webhookPassword must be given together',
    path: ['webhookPassword'],
  });
export type PhonePeConfig = z.input<typeof PhonePeConfigSchema>;
export type ParsedPhonePeConfig = z.output<typeof PhonePeConfigSchema>;

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/** `Long` fields: a JSON number, or a numeric string. */
const LongSchema = z.union([z.number(), z.string().trim().regex(/^-?\d+$/).transform(Number)]);

const MerchantIdSchema = z
  .string()
  .min(1)
  .max(MAX_MERCHANT_ID_LENGTH)
  .regex(MERCHANT_ID_PATTERN, { error: 'only letters, digits, "_" and "-" are allowed' });

/** `metaInfo`: only `udf1` to `udf15`, within the documented lengths and character set. [SC-SETUP, SDK MetaInfo] */
export const PhonePeMetaInfoSchema = z
  .record(z.string().regex(UDF_KEY_PATTERN, { error: 'metaInfo keys must be udf1 to udf15' }), z.string())
  .superRefine((meta, context) => {
    for (const [key, value] of Object.entries(meta)) {
      const index = Number(key.slice(3));
      const long = index <= UDF_LONG_COUNT;
      if (value.length > (long ? UDF_LONG_MAX_LENGTH : UDF_SHORT_MAX_LENGTH)) {
        context.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} may hold at most ${long ? UDF_LONG_MAX_LENGTH : UDF_SHORT_MAX_LENGTH} characters`,
        });
      } else if (!long && !UDF_SHORT_PATTERN.test(value)) {
        context.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} may contain only letters, digits and _ - + @ . and spaces`,
        });
      }
    }
  });
export type PhonePeMetaInfo = z.output<typeof PhonePeMetaInfoSchema>;

// ---------------------------------------------------------------------------
// Authentication [A-AUTH]
// ---------------------------------------------------------------------------

/** The form body of the token request. */
export const PhonePeTokenRequestSchema = z.object({
  client_id: z.string().min(1),
  client_version: z.string().min(1),
  client_secret: z.string().min(1),
  grant_type: z.literal(PHONEPE_GRANT_TYPE),
});

/** `expires_at` is "token expiry timestamp in epoch" (seconds) in the sample, "validity (in seconds)" in the prose. */
export const PhonePeTokenResponseSchema = z.looseObject({
  access_token: z.string().min(1),
  token_type: z.string().nullish(),
  issued_at: LongSchema.nullish(),
  expires_at: LongSchema.nullish(),
  expires_in: LongSchema.nullish(),
  session_expires_at: LongSchema.nullish(),
});
export type PhonePeTokenResponse = z.output<typeof PhonePeTokenResponseSchema>;

// ---------------------------------------------------------------------------
// Setup [SC-SETUP]
// ---------------------------------------------------------------------------

export const PhonePeSetupRequestSchema = z
  .object({
    merchantOrderId: MerchantIdSchema,
    /** PENNY_DROP: exactly 200 paise; TRANSACTION: at least 100 paise or the first debit amount. */
    amount: z.number().int().positive(),
    paymentFlow: z.object({
      type: z.literal(PhonePePaymentFlowType.CheckoutSetup),
      merchantUrls: z.object({ redirectUrl: z.url() }),
      subscriptionDetails: z.object({
        subscriptionType: z.literal(PhonePeSubscriptionType.Recurring),
        merchantSubscriptionId: MerchantIdSchema,
        authWorkflowType: z.enum(PhonePeAuthWorkflowType),
        amountType: z.enum(PhonePeAmountType),
        /** Paise, at most INR 15,000. */
        maxAmount: z.number().int().positive().max(MAX_MANDATE_PAISE),
        frequency: z.enum(PhonePeFrequency),
        productType: z.literal(PhonePeProductType.UpiMandate),
        /** Mandate expiry, epoch milliseconds. */
        expireAt: z.number().int().positive(),
      }),
    }),
    /** Setup order expiry in seconds. */
    expireAfter: z.number().int().min(EXPIRE_AFTER_MIN_SECONDS).max(EXPIRE_AFTER_MAX_SECONDS).optional(),
    metaInfo: PhonePeMetaInfoSchema.optional(),
  })
  .superRefine((request, context) => {
    const workflow = request.paymentFlow.subscriptionDetails.authWorkflowType;
    if (workflow === PhonePeAuthWorkflowType.PennyDrop && request.amount !== PENNY_DROP_AMOUNT_PAISE) {
      context.addIssue({ code: 'custom', path: ['amount'], message: `a PENNY_DROP setup must be exactly ${PENNY_DROP_AMOUNT_PAISE} paise` });
    }
    if (workflow === PhonePeAuthWorkflowType.Transaction && request.amount < MIN_TRANSACTION_SETUP_PAISE) {
      context.addIssue({
        code: 'custom',
        path: ['amount'],
        message: `a TRANSACTION setup must be at least ${MIN_TRANSACTION_SETUP_PAISE} paise`,
      });
    }
  });
export type PhonePeSetupRequest = z.output<typeof PhonePeSetupRequestSchema>;

export const PhonePePayResponseSchema = z.looseObject({
  orderId: z.string().nullish(),
  state: z.string(),
  /** "You must use this exactly as received, without modifications." */
  redirectUrl: z.url(),
  expireAt: LongSchema.nullish(),
});
export type PhonePePayResponse = z.output<typeof PhonePePayResponseSchema>;

/** What the customer's browser brings back to the return URL: only the id this adapter added is read. */
export const PhonePeReturnParamsSchema = z.looseObject({
  [RETURN_SUBSCRIPTION_ID_PARAM]: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Orders (setup, notification, redemption) [SC-ORDER, SC-NOTIFSTATUS, SC-REDORDER]
// ---------------------------------------------------------------------------

const RailSchema = z.looseObject({
  type: z.string().nullish(),
  utr: z.string().nullish(),
  umn: z.string().nullish(),
  vpa: z.string().nullish(),
});

/** One payment attempt of an order. */
export const PhonePeAttemptSchema = z.looseObject({
  transactionId: z.string().nullish(),
  paymentMode: z.string().nullish(),
  timestamp: LongSchema.nullish(),
  amount: LongSchema.nullish(),
  state: z.string().nullish(),
  errorCode: z.string().nullish(),
  detailedErrorCode: z.string().nullish(),
  rail: RailSchema.nullish(),
});
export type PhonePeAttempt = z.output<typeof PhonePeAttemptSchema>;

/** `paymentFlow` of an order or of a webhook payload (all variants: setup, notification, redemption). */
export const PhonePeFlowSchema = z.looseObject({
  type: z.string().nullish(),
  merchantSubscriptionId: z.string().nullish(),
  /** PhonePe's own mandate id (`OMS...`), present once the setup order is complete. */
  subscriptionId: z.string().nullish(),
  authWorkflowType: z.string().nullish(),
  amountType: z.string().nullish(),
  maxAmount: LongSchema.nullish(),
  frequency: z.string().nullish(),
  expireAt: LongSchema.nullish(),
  redemptionRetryStrategy: z.string().nullish(),
  autoDebit: z.boolean().nullish(),
  /** The execution window of a notified redemption, epoch milliseconds. */
  validAfter: LongSchema.nullish(),
  validUpto: LongSchema.nullish(),
  notifiedAt: LongSchema.nullish(),
});
export type PhonePeFlow = z.output<typeof PhonePeFlowSchema>;

const orderShape = {
  orderId: z.string().nullish(),
  merchantOrderId: z.string().nullish(),
  merchantId: z.string().nullish(),
  currency: z.string().nullish(),
  amount: LongSchema.nullish(),
  expireAt: LongSchema.nullish(),
  errorCode: z.string().nullish(),
  detailedErrorCode: z.string().nullish(),
  paymentFlow: PhonePeFlowSchema.nullish(),
  paymentDetails: z.array(PhonePeAttemptSchema).nullish(),
};

export const PhonePeOrderSchema = z.looseObject({ ...orderShape, state: z.string() });
export type PhonePeOrder = z.output<typeof PhonePeOrderSchema>;

// ---------------------------------------------------------------------------
// Subscription status [SC-SUBSTATUS]
// ---------------------------------------------------------------------------

const subscriptionShape = {
  merchantSubscriptionId: z.string().nullish(),
  /** PhonePe's own mandate id (`OMS...`). The page calls it "provided by the merchant"; it is not. */
  subscriptionId: z.string().nullish(),
  authWorkflowType: z.string().nullish(),
  amountType: z.string().nullish(),
  currency: z.string().nullish(),
  maxAmount: LongSchema.nullish(),
  frequency: z.string().nullish(),
  expireAt: LongSchema.nullish(),
  pauseStartDate: LongSchema.nullish(),
  pauseEndDate: LongSchema.nullish(),
};

export const PhonePeSubscriptionStatusSchema = z.looseObject({
  ...subscriptionShape,
  state: z.string(),
  productType: z.string().nullish(),
  authInstrumentType: z.string().nullish(),
});
export type PhonePeSubscriptionStatus = z.output<typeof PhonePeSubscriptionStatusSchema>;

// ---------------------------------------------------------------------------
// Notify and redeem [SC-NOTIFY, SC-EXEC]
// ---------------------------------------------------------------------------

export const PhonePeNotifyRequestSchema = z.object({
  merchantOrderId: MerchantIdSchema,
  /** "Min Value: 100 paise". */
  amount: z.number().int().min(MIN_NOTIFY_PAISE),
  paymentFlow: z.object({
    type: z.literal(PhonePePaymentFlowType.CheckoutRedemption),
    merchantSubscriptionId: MerchantIdSchema,
    redemptionRetryStrategy: z.enum(PhonePeRetryStrategy),
    autoDebit: z.boolean(),
  }),
});
export type PhonePeNotifyRequest = z.output<typeof PhonePeNotifyRequestSchema>;

export const PhonePeNotifyResponseSchema = z.looseObject({
  orderId: z.string().nullish(),
  state: z.string(),
  expireAt: LongSchema.nullish(),
});
export type PhonePeNotifyResponse = z.output<typeof PhonePeNotifyResponseSchema>;

export const PhonePeRedeemRequestSchema = z.object({
  /** "Pass the same merchantOrderId used in the Notify request." */
  merchantOrderId: MerchantIdSchema,
});

export const PhonePeRedeemResponseSchema = z.looseObject({
  transactionId: z.string().nullish(),
  state: z.string(),
});
export type PhonePeRedeemResponse = z.output<typeof PhonePeRedeemResponseSchema>;

// ---------------------------------------------------------------------------
// Refunds [SC-REFUND, A-REFUND]
// ---------------------------------------------------------------------------

export const PhonePeRefundRequestSchema = z.object({
  merchantRefundId: MerchantIdSchema,
  originalMerchantOrderId: MerchantIdSchema,
  amount: z.number().int().positive(),
});
export type PhonePeRefundRequest = z.output<typeof PhonePeRefundRequestSchema>;

export const PhonePeRefundResponseSchema = z.looseObject({
  refundId: z.string().min(1),
  currency: z.string().nullish(),
  amount: LongSchema.nullish(),
  state: z.string(),
});
export type PhonePeRefundResponse = z.output<typeof PhonePeRefundResponseSchema>;

// ---------------------------------------------------------------------------
// Errors [A-ERR, G-ORDER]
// ---------------------------------------------------------------------------

/** `{"code": "...", "message": "..."}`; the Python SDK also reads `errorCode` for auth responses. */
export const PhonePeErrorBodySchema = z.looseObject({
  code: z.string().nullish(),
  errorCode: z.string().nullish(),
  message: z.string().nullish(),
});
export type PhonePeErrorBody = z.output<typeof PhonePeErrorBodySchema>;

// ---------------------------------------------------------------------------
// Webhooks [SC-WEBHOOK, A-WEBHOOK]
// ---------------------------------------------------------------------------

/**
 * The `payload` of every webhook this adapter reads: an order (setup, notification, redemption), a mandate state change
 * (the fields sit directly in the payload) or a refund. Everything is optional; the mapper decides per event what must
 * be present.
 */
export const PhonePeWebhookPayloadSchema = z.looseObject({
  ...orderShape,
  ...subscriptionShape,
  state: z.string().nullish(),
  merchantRefundId: z.string().nullish(),
  originalMerchantOrderId: z.string().nullish(),
  refundId: z.string().nullish(),
  timestamp: LongSchema.nullish(),
});
export type PhonePeWebhookPayload = z.output<typeof PhonePeWebhookPayloadSchema>;

export const PhonePeWebhookSchema = z.looseObject({
  /** Deprecated by PhonePe ("use the event parameter"); read for nothing. */
  type: z.string().nullish(),
  event: z.string().min(1),
  payload: PhonePeWebhookPayloadSchema,
});
export type PhonePeWebhook = z.output<typeof PhonePeWebhookSchema>;
