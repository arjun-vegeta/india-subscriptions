import { z } from 'zod';
import { Environment } from '../../constants.js';
import {
  PAYTM_CURRENCY,
  PAYTM_CUST_ID_PATTERN,
  PAYTM_DEBIT_REASON_MAX_LENGTH,
  PAYTM_DEFAULT_DEBIT_REASON,
  PAYTM_DEFAULT_MANDATE_YEARS,
  PAYTM_MERCHANT_KEY_BYTES,
  PAYTM_ORDER_ID_MAX_LENGTH,
  PAYTM_ORDER_ID_PATTERN,
  PAYTM_REFERENCE_ID_MAX_LENGTH,
  PAYTM_REQUEST_TYPE_PAYMENT,
  PAYTM_REQUEST_TYPE_SUBSCRIPTION,
  PAYTM_TXN_TYPE_REFUND,
  PaytmAmountType,
  PaytmChannelId,
  PaytmEnableRetry,
  PaytmFrequencyUnit,
  PaytmMandateType,
  PaytmModifyStatus,
  PaytmPaymentModeName,
} from './constants.js';

/**
 * Zod schemas for everything Paytm sends or receives. Field names appear here once. Requests are strict about what this
 * adapter sends; responses are tolerant: only the fields the adapter reads are required, the rest is `.nullish()`, and
 * Paytm's inconsistencies are absorbed on the way in (numbers sent as strings and strings as numbers, `resultInfo`
 * keyed `resultStatus`/`resultCode`/`resultMsg` on some APIs and `status`/`code`/`message` on others, `AUTHORISED` /
 * `AUTHORIZED`, `mId` / `mid`).
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const optionalUrl = (what: string) => z.url({ error: `${what} must be a valid URL` }).optional();

export const PaytmConfigSchema = z.object({
  /** Merchant id (different for staging and production). */
  mid: z.string().min(1, { error: 'mid is required' }),
  /**
   * Merchant key: the AES-128 key of the checksum, exactly 16 bytes. Never logged, never put in an error, in `raw`, or in a
   * returned checkout field.
   */
  merchantKey: z
    .string()
    .min(1, { error: 'merchantKey is required' })
    .refine((key) => Buffer.byteLength(key, 'utf8') === PAYTM_MERCHANT_KEY_BYTES, {
      error: `merchantKey must be exactly ${PAYTM_MERCHANT_KEY_BYTES} bytes long: it is the AES-128 key of Paytm's checksum`,
    }),
  /** `websiteName`: `WEBSTAGING` on staging, `DEFAULT` on production, or the name Paytm gave you. */
  website: z.string().min(1, { error: 'website is required (WEBSTAGING on staging, DEFAULT on production)' }),
  /** `test` calls the staging hosts, `live` the production hosts. */
  environment: z.enum(Environment, { error: 'environment must be "test" or "live"' }),
  /** Default `callbackUrl` when a subscription has no `returnUrl`; without either, Paytm uses the URL configured for `website`. */
  callbackUrl: optionalUrl('callbackUrl'),
  /** `head.channelId` of the Theia-style APIs (`WEB` or `WAP`). Omitted by default. */
  channelId: z.enum(PaytmChannelId, { error: 'channelId must be "WEB" or "WAP"' }).optional(),
  /** `head.clientId`: only needed when the merchant has more than one key. */
  clientId: z.string().min(1, { error: 'clientId must not be empty' }).optional(),
  /**
   * `subscriptionGraceDays` to send for merchant-collected subscriptions. Default: the days between the start date and the
   * first debit plus room for the scheduler's retries, capped by what the cycle length and the payment modes allow.
   */
  graceDays: z.number().int().min(0).max(365).optional(),
  /** `subscriptionRetryCount` of merchant-collected subscriptions. Default 3. */
  retryCount: z.number().int().min(1).max(10).optional(),
  /** Years a subscription without an end date stays valid: Paytm requires `subscriptionExpiryDate`. Default 5. */
  mandateYears: z.number().int().min(1).max(30).default(PAYTM_DEFAULT_MANDATE_YEARS),
  /** The reason shown to the customer in the pre-debit notification. Default "Subscription renewal". */
  debitReason: z
    .string()
    .min(1)
    .max(PAYTM_DEBIT_REASON_MAX_LENGTH, { error: `debitReason is at most ${PAYTM_DEBIT_REASON_MAX_LENGTH} characters` })
    .default(PAYTM_DEFAULT_DEBIT_REASON),
  /** Overrides the host `secure(stage).paytmpayments.com`: Initiate Transaction, subscription create, renew, pre-notify, status, cancel, pause. */
  subscriptionBaseUrl: optionalUrl('subscriptionBaseUrl'),
  /** Overrides the host of the Transaction Status API (`securegw(-stage).paytmpayments.in`). */
  transactionStatusBaseUrl: optionalUrl('transactionStatusBaseUrl'),
  /** Overrides the host of the Refund API (`securegw(-stage).paytmpayments.in`). */
  refundBaseUrl: optionalUrl('refundBaseUrl'),
  /** Overrides the host customers are sent to for authorisation (`showPaymentPage`); defaults to the subscription host, NOT its override. */
  checkoutBaseUrl: optionalUrl('checkoutBaseUrl'),
});
export type PaytmConfig = z.input<typeof PaytmConfigSchema>;
export type ParsedPaytmConfig = z.output<typeof PaytmConfigSchema>;

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/** Paytm sends numbers as strings and strings as numbers; read both as text. */
const TextSchema = z.union([z.string(), z.number()]).transform(String);
const OptionalTextSchema = TextSchema.nullish();
const OptionalStringSchema = z.string().nullish();

const RupeeStringSchema = z.string().regex(/^\d+(\.\d{2})?$/, { error: 'an amount in rupees such as 499.00' });
const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: 'a date as YYYY-MM-DD' });
const DaysSchema = z.string().regex(/^\d{1,3}$/, { error: 'a number of days' });
const OrderIdSchema = z
  .string()
  .min(1)
  .max(PAYTM_ORDER_ID_MAX_LENGTH)
  .regex(PAYTM_ORDER_ID_PATTERN, { error: 'letters, digits and @ . _ - only' });

const TxnAmountSchema = z.object({
  value: RupeeStringSchema,
  currency: z.literal(PAYTM_CURRENCY),
});

/** `{resultInfo}` in both of Paytm's spellings; every field optional, classified by `mapper.ts`. */
export const PaytmResultInfoSchema = z.looseObject({
  resultStatus: OptionalTextSchema,
  resultCode: OptionalTextSchema,
  resultMsg: OptionalStringSchema,
  status: OptionalTextSchema,
  code: OptionalTextSchema,
  message: OptionalStringSchema,
});
export type PaytmResultInfo = z.output<typeof PaytmResultInfoSchema>;

/** An error answer (HTTP 4xx/5xx) read only far enough to quote Paytm's message and code. */
export const PaytmErrorEnvelopeSchema = z.looseObject({
  body: z.looseObject({ resultInfo: PaytmResultInfoSchema.nullish() }).nullish(),
});

/** A response is `{ head, body }`; the adapter reads `body` only. */
export function paytmEnvelope<S extends z.ZodType>(body: S) {
  return z.looseObject({ head: z.unknown().optional(), body });
}

// ---------------------------------------------------------------------------
// Initiate Subscription [init-sub]
// ---------------------------------------------------------------------------

const UserInfoSchema = z.object({
  custId: z.string().min(1).regex(PAYTM_CUST_ID_PATTERN, { error: 'letters, digits and @ ! = _ $ . only' }),
  mobile: z.string().regex(/^\d{10}$/, { error: 'a 10-digit mobile number' }).optional(),
  email: z.email().optional(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
});

const PaymentModeFilterSchema = z.object({ mode: z.enum(PaytmPaymentModeName) });

export const PaytmInitiateRequestSchema = z
  .object({
    requestType: z.literal(PAYTM_REQUEST_TYPE_SUBSCRIPTION),
    mid: z.string().min(1),
    websiteName: z.string().min(1),
    orderId: OrderIdSchema,
    callbackUrl: z.url().optional(),
    txnAmount: TxnAmountSchema,
    userInfo: UserInfoSchema,
    subscriptionAmountType: z.enum(PaytmAmountType),
    subscriptionMaxAmount: RupeeStringSchema.optional(),
    renewalAmount: RupeeStringSchema.optional(),
    autoRenewal: z.boolean(),
    autoRetry: z.boolean(),
    communicationManager: z.boolean().optional(),
    subscriptionFrequencyUnit: z.enum(PaytmFrequencyUnit),
    subscriptionStartDate: DateSchema,
    subscriptionGraceDays: DaysSchema.optional(),
    subscriptionExpiryDate: DateSchema,
    subscriptionEnableRetry: z.enum(PaytmEnableRetry),
    subscriptionRetryCount: DaysSchema.optional(),
    mandateType: z.enum(PaytmMandateType).optional(),
    enablePaymentMode: z.array(PaymentModeFilterSchema).min(1).optional(),
  })
  .refine(
    (body) =>
      body.subscriptionAmountType === PaytmAmountType.Variable
        ? body.subscriptionMaxAmount !== undefined
        : body.renewalAmount !== undefined,
    { error: 'VARIABLE needs subscriptionMaxAmount and FIX needs renewalAmount' },
  );
export type PaytmInitiateRequest = z.output<typeof PaytmInitiateRequestSchema>;

/**
 * Initiate Transaction for a one-time payment [init-txn]: only what this adapter sends. `extendInfo.comments` carries the
 * payment's description.
 */
export const PaytmInitiatePaymentRequestSchema = z.object({
  requestType: z.literal(PAYTM_REQUEST_TYPE_PAYMENT),
  mid: z.string().min(1),
  websiteName: z.string().min(1),
  orderId: OrderIdSchema,
  callbackUrl: z.url().optional(),
  txnAmount: TxnAmountSchema,
  userInfo: UserInfoSchema,
  enablePaymentMode: z.array(PaymentModeFilterSchema).min(1).optional(),
  extendInfo: z.object({ comments: z.string().min(1) }).optional(),
});
export type PaytmInitiatePaymentRequest = z.output<typeof PaytmInitiatePaymentRequestSchema>;

export const PaytmInitiateBodySchema = z.looseObject({
  resultInfo: PaytmResultInfoSchema.nullish(),
  txnToken: OptionalTextSchema,
  subscriptionId: OptionalTextSchema,
  authenticated: z.boolean().nullish(),
});
export const PaytmInitiateResponseSchema = paytmEnvelope(PaytmInitiateBodySchema);

// ---------------------------------------------------------------------------
// Renew Subscription [renew]
// ---------------------------------------------------------------------------

export const PaytmRenewRequestSchema = z.object({
  mid: z.string().min(1),
  orderId: OrderIdSchema,
  txnAmount: TxnAmountSchema,
  subscriptionId: z.string().min(1).max(64),
  debitDate: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, { error: 'a date and time as YYYY-MM-DD HH:mm:ss' }).optional(),
  prenotifyReferenceId: z.string().min(1).max(PAYTM_REFERENCE_ID_MAX_LENGTH).optional(),
  extendInfo: z.object({ comments: z.string().min(1).max(200) }).optional(),
});

export const PaytmRenewBodySchema = z.looseObject({
  resultInfo: PaytmResultInfoSchema.nullish(),
  txnId: OptionalTextSchema,
});
export const PaytmRenewResponseSchema = paytmEnvelope(PaytmRenewBodySchema);

// ---------------------------------------------------------------------------
// Pre-Notify [prenotify]
// ---------------------------------------------------------------------------

export const PaytmPreNotifyRequestSchema = z.object({
  mid: z.string().min(1),
  subsId: z.string().min(1),
  txnAmount: RupeeStringSchema,
  txnDate: z.string().regex(/^\d{2}-\d{2}-\d{4}$/, { error: 'a date as DD-MM-YYYY' }),
  txnMessage: z.string().min(1).max(PAYTM_DEBIT_REASON_MAX_LENGTH),
  referenceId: z.string().min(1).max(PAYTM_REFERENCE_ID_MAX_LENGTH),
  invoiceDisplayNo: z.string().regex(/^[A-Za-z0-9]{1,15}$/, { error: 'at most 15 letters and digits' }).optional(),
});

export const PaytmPreNotifyBodySchema = z.looseObject({
  resultInfo: PaytmResultInfoSchema.nullish(),
  paytmReferenceId: OptionalTextSchema,
});
export const PaytmPreNotifyResponseSchema = paytmEnvelope(PaytmPreNotifyBodySchema);

// ---------------------------------------------------------------------------
// Fetch Subscription Status [fetch-status]
// ---------------------------------------------------------------------------

export const PaytmStatusRequestSchema = z.object({
  mid: z.string().min(1),
  subsId: z.string().min(1),
});

const InstrumentSchema = z.looseObject({
  bankName: OptionalStringSchema,
  paymentMode: OptionalStringSchema,
  mandateType: OptionalStringSchema,
  ppiType: OptionalStringSchema,
});

const LastRetrySchema = z.looseObject({ status: OptionalStringSchema, attemptedTime: OptionalTextSchema });
const NextRetrySchema = z.looseObject({ attemptedTime: OptionalTextSchema });
const RetryDetailsSchema = z.looseObject({ totalRetryCount: OptionalTextSchema, retriesLeft: OptionalTextSchema });

export const PaytmStatusBodySchema = z.looseObject({
  resultInfo: PaytmResultInfoSchema.nullish(),
  subsId: OptionalTextSchema,
  payMode: OptionalStringSchema,
  status: OptionalStringSchema,
  subStatus: OptionalStringSchema,
  activationDate: OptionalTextSchema,
  orderId: OptionalTextSchema,
  subsPaymentInstDetails: InstrumentSchema.nullish().catch(undefined),
  subsLastRetryDone: LastRetrySchema.nullish().catch(undefined),
  subsNextRetry: NextRetrySchema.nullish().catch(undefined),
  subsRetryDetails: RetryDetailsSchema.nullish().catch(undefined),
  lastOrderId: OptionalTextSchema,
  lastOrderStatus: OptionalStringSchema,
  lastOrderCreationDate: OptionalTextSchema,
  lastOrderAmount: OptionalTextSchema,
  amountType: OptionalStringSchema,
  maxAmount: OptionalTextSchema,
  mid: OptionalTextSchema,
  frequencyUnit: OptionalStringSchema,
  frequency: OptionalTextSchema,
  merchantName: OptionalStringSchema,
  expiryDate: OptionalTextSchema,
  createdDate: OptionalTextSchema,
  updatedDate: OptionalTextSchema,
  custId: OptionalTextSchema,
  custEmailId: OptionalStringSchema,
  custMobileNo: OptionalTextSchema,
  upfrontTxnAmount: OptionalTextSchema,
  upfrontTxnId: OptionalTextSchema,
  pauseStartDate: OptionalTextSchema,
  pauseEndDate: OptionalTextSchema,
  planId: OptionalTextSchema,
});
export type PaytmStatusBody = z.output<typeof PaytmStatusBodySchema>;
export const PaytmStatusResponseSchema = paytmEnvelope(PaytmStatusBodySchema);

// ---------------------------------------------------------------------------
// Pause / Resume [pause] and Cancel [cancel]
// ---------------------------------------------------------------------------

export const PaytmModifyRequestSchema = z.object({
  mid: z.string().min(1),
  subsId: z.string().min(1),
  status: z.enum(PaytmModifyStatus),
});

export const PaytmCancelRequestSchema = z.object({
  mid: z.string().min(1),
  subsId: z.string().min(1),
});

/** Pause/Resume and Cancel answer with a `resultInfo` and, for Cancel, a few echoed fields (`mId` in the sample). */
export const PaytmActionBodySchema = z.looseObject({
  resultInfo: PaytmResultInfoSchema.nullish(),
  subsId: OptionalTextSchema,
  custId: OptionalTextSchema,
  expiryDate: OptionalTextSchema,
});
export const PaytmActionResponseSchema = paytmEnvelope(PaytmActionBodySchema);

// ---------------------------------------------------------------------------
// Transaction Status [txn-status]
// ---------------------------------------------------------------------------

export const PaytmTxnStatusRequestSchema = z.object({
  mid: z.string().min(1),
  orderId: OrderIdSchema,
});

export const PaytmTxnStatusBodySchema = z.looseObject({
  resultInfo: PaytmResultInfoSchema.nullish(),
  txnId: OptionalTextSchema,
  bankTxnId: OptionalTextSchema,
  orderId: OptionalTextSchema,
  txnAmount: OptionalTextSchema,
  txnType: OptionalStringSchema,
  gatewayName: OptionalStringSchema,
  bankName: OptionalStringSchema,
  mid: OptionalTextSchema,
  paymentMode: OptionalStringSchema,
  refundAmt: OptionalTextSchema,
  txnDate: OptionalTextSchema,
  subsId: OptionalTextSchema,
});
export type PaytmTxnStatusBody = z.output<typeof PaytmTxnStatusBodySchema>;
export const PaytmTxnStatusResponseSchema = paytmEnvelope(PaytmTxnStatusBodySchema);

// ---------------------------------------------------------------------------
// Refund [refund]
// ---------------------------------------------------------------------------

export const PaytmRefundRequestSchema = z.object({
  mid: z.string().min(1),
  txnType: z.literal(PAYTM_TXN_TYPE_REFUND),
  orderId: OrderIdSchema,
  txnId: z.string().min(1).max(64),
  refId: z.string().min(1).max(PAYTM_ORDER_ID_MAX_LENGTH),
  refundAmount: RupeeStringSchema,
  comments: z.string().min(1).max(500).optional(),
});

export const PaytmRefundBodySchema = z.looseObject({
  resultInfo: PaytmResultInfoSchema.nullish(),
  mid: OptionalTextSchema,
  orderId: OptionalTextSchema,
  refId: OptionalTextSchema,
  refundId: OptionalTextSchema,
  txnId: OptionalTextSchema,
  txnTimestamp: OptionalTextSchema,
  refundAmount: OptionalTextSchema,
});
export const PaytmRefundResponseSchema = paytmEnvelope(PaytmRefundBodySchema);

// ---------------------------------------------------------------------------
// Callback and webhooks [§4.3, §10]
// ---------------------------------------------------------------------------

/** A key-value post as the HTTP layer hands it over: every field is text (a JSON key-value body may carry null). */
export const PaytmFormSchema = z.record(z.string(), z.string().nullable());
export type PaytmForm = z.output<typeof PaytmFormSchema>;

/** What Paytm posts to `callbackUrl` after the customer authorised (cards, wallet, UPI and e-mandates). [sub-js] [auth-sub] */
export const PaytmCallbackSchema = z.looseObject({
  ORDERID: z.string().min(1),
  STATUS: OptionalStringSchema,
  SUBS_ID: OptionalTextSchema,
  MID: OptionalStringSchema,
  TXNID: OptionalStringSchema,
  BANKTXNID: OptionalStringSchema,
  TXNAMOUNT: OptionalTextSchema,
  CURRENCY: OptionalStringSchema,
  PAYMENTMODE: OptionalStringSchema,
  TXNDATE: OptionalStringSchema,
  RESPCODE: OptionalTextSchema,
  RESPMSG: OptionalStringSchema,
  MANDATE_TYPE: OptionalStringSchema,
});
export type PaytmCallback = z.output<typeof PaytmCallbackSchema>;

/** Subscription Status webhook. [wh-sub-status] */
export const PaytmSubscriptionWebhookSchema = z.looseObject({
  SUBS_ID: z.string().min(1),
  STATUS: z.string().min(1),
  ORDERID: OptionalStringSchema,
  MID: OptionalStringSchema,
  CUSTID: OptionalStringSchema,
  PAYMENTMODE: OptionalStringSchema,
  BANKNAME: OptionalStringSchema,
  EXPIRYDATE: OptionalStringSchema,
  UPDATEDDATE: OptionalStringSchema,
  CREATEDDATE: OptionalStringSchema,
  FREQUENCYUNIT: OptionalStringSchema,
  FREQUENCY: OptionalTextSchema,
  MAXAMOUNT: OptionalTextSchema,
  UPFRONTTXNAMOUNT: OptionalTextSchema,
  UPFRONTTXNID: OptionalStringSchema,
  AMOUNTTYPE: OptionalStringSchema,
  MERCHANTNAME: OptionalStringSchema,
  CUSTMOBILE: OptionalTextSchema,
  CUSTEMAILID: OptionalStringSchema,
  /** The docs print the field as `subStatus` in one sample and `SUBSTATUS` in another. */
  subStatus: OptionalStringSchema,
  SUBSTATUS: OptionalStringSchema,
  MANDATETYPE: OptionalStringSchema,
  PAUSESTARTDATE: OptionalStringSchema,
  PAUSEENDDATE: OptionalStringSchema,
});
export type PaytmSubscriptionWebhook = z.output<typeof PaytmSubscriptionWebhookSchema>;

/** Payment Status webhook: one debit (a renewal or the upfront payment). No subscription id is documented. [wh-payment] */
export const PaytmPaymentWebhookSchema = z.looseObject({
  ORDERID: z.string().min(1),
  STATUS: z.string().min(1),
  MID: OptionalStringSchema,
  TXNID: OptionalStringSchema,
  TXNAMOUNT: OptionalTextSchema,
  PAYMENTMODE: OptionalStringSchema,
  CURRENCY: OptionalStringSchema,
  TXNDATE: OptionalStringSchema,
  RESPCODE: OptionalTextSchema,
  RESPMSG: OptionalStringSchema,
  GATEWAYNAME: OptionalStringSchema,
  BANKTXNID: OptionalStringSchema,
  BANKNAME: OptionalStringSchema,
});
export type PaytmPaymentWebhook = z.output<typeof PaytmPaymentWebhookSchema>;

/** Pre-Notify callback. [wh-prenotify] */
export const PaytmPreNotifyWebhookSchema = z.looseObject({
  REFERENCEID: z.string().min(1),
  NOTIFICATIONSTATUS: z.string().min(1),
  TXNMESSAGE: OptionalStringSchema,
  NOTIFICATIONSTATUSCODE: OptionalTextSchema,
  NOTIFICATIONSTATUSMESSAGE: OptionalStringSchema,
  TXNDATE: OptionalStringSchema,
  NOTIFICATIONDATE: OptionalStringSchema,
});
export type PaytmPreNotifyWebhook = z.output<typeof PaytmPreNotifyWebhookSchema>;

/** Refund ARN webhook (key-value). [wh-refund-arn] */
export const PaytmRefundArnWebhookSchema = z.looseObject({
  ORDERID: z.string().min(1),
  REFID: z.string().min(1),
  REFUNDID: OptionalStringSchema,
  MID: OptionalStringSchema,
  TXNID: OptionalStringSchema,
  TXNAMOUNT: OptionalTextSchema,
  REFUNDAMOUNT: OptionalTextSchema,
  REFUNDDATETIME: OptionalStringSchema,
  PAYMENTMODE: OptionalStringSchema,
  ARN: OptionalStringSchema,
  RRN: OptionalStringSchema,
});
export type PaytmRefundArnWebhook = z.output<typeof PaytmRefundArnWebhookSchema>;

/** The JSON refund webhooks: `{ head: { signature }, body }`. [wh-accept-refund] [wh-success-refund] */
export const PaytmRefundWebhookBodySchema = z.looseObject({
  orderId: z.string().min(1),
  refId: z.string().min(1),
  refundId: OptionalTextSchema,
  txnId: OptionalTextSchema,
  txnAmount: OptionalTextSchema,
  refundAmount: OptionalTextSchema,
  totalRefundAmount: OptionalTextSchema,
  mid: OptionalTextSchema,
  status: OptionalStringSchema,
  source: OptionalStringSchema,
  txnTimestamp: OptionalTextSchema,
  acceptRefundTimestamp: OptionalTextSchema,
  userCreditInitiateTimestamp: OptionalTextSchema,
  merchantRefundRequestTimestamp: OptionalTextSchema,
  refundDetailInfoList: z.unknown().optional(),
  rejectRefundReasonCode: OptionalTextSchema,
  rejectRefundReasonMessage: OptionalStringSchema,
});
export type PaytmRefundWebhookBody = z.output<typeof PaytmRefundWebhookBodySchema>;

export const PaytmRefundWebhookSchema = z.looseObject({
  head: z.looseObject({ signature: OptionalStringSchema }).nullish(),
  body: PaytmRefundWebhookBodySchema,
});

/** The shape of a JSON body, enough to tell the refund webhooks from a key-value body sent as JSON. */
export const PaytmJsonEnvelopeSchema = z.looseObject({
  head: z.looseObject({ signature: OptionalStringSchema }).nullish(),
  body: z.record(z.string(), z.unknown()),
});

