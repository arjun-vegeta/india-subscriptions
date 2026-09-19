import { z } from 'zod';
import { Environment } from '../../constants.js';
import {
  ConsentHashLayout,
  DEFAULT_CONSENT_HASH_LAYOUT,
  PAYU_BILLING_CURRENCY,
  PAYU_DATE_PATTERN,
  PayUBillingCycle,
} from './constants.js';

/**
 * Zod schemas for everything PayU sends or receives. JSON / form field names
 * appear here once. Requests are strict about what this adapter sends;
 * responses are tolerant: only the fields the adapter reads are required, the
 * rest is `.nullish()`, and PayU's inconsistent field casing
 * (`authpayuid` / `authPayuId` / `authPayuid`) is accepted on the way in.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const PayUConfigSchema = z.object({
  /** Merchant key. */
  key: z.string().min(1, { error: 'key is required' }),
  /** Merchant salt. Never logged, never put in an error or in a returned form field. */
  salt: z.string().min(1, { error: 'salt is required' }),
  /** `test` calls test.payu.in, `live` calls secure.payu.in / info.payu.in. */
  environment: z.enum(Environment, { error: 'environment must be "test" or "live"' }),
  /** Default `surl` (success return URL) when a subscription has no `returnUrl`. */
  successUrl: z.url({ error: 'successUrl must be a valid URL' }).optional(),
  /** Default `furl` (failure return URL) when a subscription has no `returnUrl`; falls back to `successUrl`. */
  failureUrl: z.url({ error: 'failureUrl must be a valid URL' }).optional(),
  /**
   * Layout of the consent-request hash. The docs print three variants of the
   * pipe count between `udf5` and `si_details` (see `ConsentHashLayout`).
   * Defaults to the standard six-pipe layout; switch to `four_pipes` or
   * `five_pipes` if PayU's test environment rejects the default with a hash error.
   */
  consentHashLayout: z.enum(ConsentHashLayout).default(DEFAULT_CONSENT_HASH_LAYOUT),
  /**
   * PayU documents no signature for the eNACH cancellation webhook and the
   * refund webhook. By default those are returned as `unknown` events and
   * never change billing state. Set this only when you restrict the webhook
   * route to PayU's published source IPs; they are then normalised.
   */
  acceptUnsignedWebhooks: z.boolean().default(false),
  /** Overrides the `_payment` URL (a proxy or mock server). */
  paymentUrl: z.url({ error: 'paymentUrl must be a valid URL' }).optional(),
  /** Overrides the postservice URL, including `?form=2`. */
  apiUrl: z.url({ error: 'apiUrl must be a valid URL' }).optional(),
});
export type PayUConfig = z.input<typeof PayUConfigSchema>;
export type ParsedPayUConfig = z.output<typeof PayUConfigSchema>;

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/** PayU sends numbers as strings and strings as numbers; read both as text. */
const TextSchema = z.union([z.string(), z.number()]).transform(String);
const OptionalTextSchema = TextSchema.nullish();
/** Any JSON object, for sniffing which kind of webhook arrived before its own schema is applied. */
export const PayULooseRecordSchema = z.record(z.string(), z.unknown());

/** A postservice envelope `status`: 1 / 0 as number or string, or a bank code / mandate status string. */
const StatusSchema = z.union([z.string(), z.number()]);

// ---------------------------------------------------------------------------
// Consent request (`_payment`) [§2, §3]
// ---------------------------------------------------------------------------

export const PayUSiDetailsSchema = z
  .object({
    /** Per-debit ceiling in rupees, "XX.XX". */
    billingAmount: z.string().regex(/^\d+\.\d{2}$/, { error: 'billingAmount must look like 499.00' }),
    billingCurrency: z.literal(PAYU_BILLING_CURRENCY),
    billingCycle: z.enum(PayUBillingCycle),
    billingInterval: z.number().int().min(1),
    /** `YYYY-MM-DD`, IST. */
    paymentStartDate: z.string().regex(PAYU_DATE_PATTERN),
    /** `YYYY-MM-DD`, IST. */
    paymentEndDate: z.string().regex(PAYU_DATE_PATTERN),
  })
  .refine((details) => details.paymentEndDate > details.paymentStartDate, {
    error: 'paymentEndDate must be after paymentStartDate',
    path: ['paymentEndDate'],
  });
export type PayUSiDetails = z.output<typeof PayUSiDetailsSchema>;

/** The form posted to `_payment`: every value is a string. */
export const PayUConsentFormSchema = z.object({
  key: z.string().min(1),
  txnid: z.string().min(1),
  amount: z.string().min(1),
  productinfo: z.string().min(1),
  firstname: z.string().min(1),
  email: z.string().min(1),
  phone: z.string().min(1),
  surl: z.url(),
  furl: z.url(),
  api_version: z.string(),
  si: z.string(),
  si_details: z.string(),
  free_trial: z.string().optional(),
  hash: z.string().min(1),
});
export type PayUConsentForm = z.output<typeof PayUConsentFormSchema>;

// ---------------------------------------------------------------------------
// Consent response (`surl` / `furl` / payment webhook) [§2.3]
// ---------------------------------------------------------------------------

/**
 * The fields PayU posts to `surl` / `furl` and to the payment webhook. Only what
 * the reverse hash and the outcome decision need is required; the rest of the
 * (large) payload is kept as it came.
 */
export const PayUPaymentResponseSchema = z.looseObject({
  status: TextSchema,
  txnid: TextSchema,
  amount: TextSchema,
  key: OptionalTextSchema,
  productinfo: OptionalTextSchema,
  firstname: OptionalTextSchema,
  email: OptionalTextSchema,
  udf1: OptionalTextSchema,
  udf2: OptionalTextSchema,
  udf3: OptionalTextSchema,
  udf4: OptionalTextSchema,
  udf5: OptionalTextSchema,
  /** Present only when convenience fees were charged. */
  additional_charges: OptionalTextSchema,
  additionalCharges: OptionalTextSchema,
  hash: OptionalTextSchema,
  mihpayid: OptionalTextSchema,
  mode: OptionalTextSchema,
  PG_TYPE: OptionalTextSchema,
  unmappedstatus: OptionalTextSchema,
  payment_source: OptionalTextSchema,
  bankcode: OptionalTextSchema,
  cardToken: OptionalTextSchema,
  card_token: OptionalTextSchema,
  addedon: OptionalTextSchema,
  error: OptionalTextSchema,
  error_Message: OptionalTextSchema,
  field9: OptionalTextSchema,
});
export type PayUPaymentResponse = z.output<typeof PayUPaymentResponseSchema>;

// ---------------------------------------------------------------------------
// Postservice envelope and errors [§1.6]
// ---------------------------------------------------------------------------

/** What every postservice answer may carry, success or failure. */
export const PayUEnvelopeSchema = z.looseObject({
  status: StatusSchema.nullish(),
  msg: z.string().nullish(),
  message: z.string().nullish(),
  Message: z.string().nullish(),
  errorCode: OptionalTextSchema,
  errorMessage: z.string().nullish(),
  action: z.string().nullish(),
});
export type PayUEnvelope = z.output<typeof PayUEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Pre-debit (`pre_debit_SI`) [§5]
// ---------------------------------------------------------------------------

export const PayUPreDebitVar1Schema = z.object({
  authpayuid: z.string().min(1),
  requestId: z.string().min(1),
  /** Rupees, "XX.XX". */
  amount: z.string().min(1),
  /** `YYYY-MM-DD`, IST. */
  debitDate: z.string().regex(PAYU_DATE_PATTERN),
  invoiceDisplayNumber: z.string().min(1),
});
export type PayUPreDebitVar1 = z.output<typeof PayUPreDebitVar1Schema>;

export const PayUPreDebitResponseSchema = PayUEnvelopeSchema.extend({
  /** Cards only: "an acknowledgment ID". */
  invoiceid: OptionalTextSchema,
  invoiceId: OptionalTextSchema,
  amount: OptionalTextSchema,
  invoiceStatus: z.string().nullish(),
  approvedStatus: z.string().nullish(),
});
export type PayUPreDebitResponse = z.output<typeof PayUPreDebitResponseSchema>;

// ---------------------------------------------------------------------------
// Recurring debit (`si_transaction`) [§6]
// ---------------------------------------------------------------------------

export const PayUSiTransactionVar1Schema = z.object({
  authpayuid: z.string().min(1),
  /** Cards and UPI; must equal the pre-debit's. */
  invoiceDisplayNumber: z.string().min(1).optional(),
  amount: z.string().min(1),
  txnid: z.string().min(1),
  phone: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
});
export type PayUSiTransactionVar1 = z.output<typeof PayUSiTransactionVar1Schema>;

export const PayUDebitDetailSchema = z.looseObject({
  authpayuid: OptionalTextSchema,
  authPayuId: OptionalTextSchema,
  transactionid: OptionalTextSchema,
  amount: OptionalTextSchema,
  /** PayU's id of the debit; often empty while the debit is pending. */
  payuid: OptionalTextSchema,
  status: z.string().nullish(),
  field9: z.string().nullish(),
});
export type PayUDebitDetail = z.output<typeof PayUDebitDetailSchema>;

export const PayUSiTransactionResponseSchema = PayUEnvelopeSchema.extend({
  /** Keyed by the merchant txnid; the combined pre-debit API answers with an empty array. */
  details: z.union([z.record(z.string(), PayUDebitDetailSchema), z.array(z.unknown())]).nullish(),
});
export type PayUSiTransactionResponse = z.output<typeof PayUSiTransactionResponseSchema>;

// ---------------------------------------------------------------------------
// Verify payment (`verify_payment`) [§6.6]
// ---------------------------------------------------------------------------

export const PayUVerifiedTransactionSchema = z.looseObject({
  mihpayid: OptionalTextSchema,
  txnid: OptionalTextSchema,
  status: z.string().nullish(),
  unmappedstatus: z.string().nullish(),
  /** Amount before discount. */
  amt: OptionalTextSchema,
  transaction_amount: OptionalTextSchema,
  net_amount_debit: OptionalTextSchema,
  addedon: OptionalTextSchema,
  mode: OptionalTextSchema,
  PG_TYPE: OptionalTextSchema,
  payment_source: OptionalTextSchema,
  field9: z.string().nullish(),
  error_code: OptionalTextSchema,
  error_Message: z.string().nullish(),
});
export type PayUVerifiedTransaction = z.output<typeof PayUVerifiedTransactionSchema>;

export const PayUVerifyPaymentResponseSchema = PayUEnvelopeSchema.extend({
  transaction_details: z.record(z.string(), PayUVerifiedTransactionSchema).nullish(),
});
export type PayUVerifyPaymentResponse = z.output<typeof PayUVerifyPaymentResponseSchema>;

// ---------------------------------------------------------------------------
// Mandate commands [§7]
// ---------------------------------------------------------------------------

/** `check_mandate_status` and `upi_mandate_status` print `authPayuId`. */
export const PayUMandateVar1CamelSchema = z.object({
  authPayuId: z.string().min(1),
  requestId: z.string().min(1),
});
/** `NB_mandate_status` prints `authpayuid`. */
export const PayUMandateVar1LowerSchema = z.object({
  authpayuid: z.string().min(1),
  requestId: z.string().min(1),
});

export const PayUUpiModifyVar1Schema = z.object({
  requestId: z.string().min(1),
  authPayuId: z.string().min(1),
  /** `YYYY-MM-DD`. */
  endDate: z.string().regex(PAYU_DATE_PATTERN).optional(),
  /** Rupees as a JSON number (the sample sends `"amount": 1`). */
  amount: z.number().positive().optional(),
});
export type PayUUpiModifyVar1 = z.output<typeof PayUUpiModifyVar1Schema>;

export const PayUMandateStatusResponseSchema = PayUEnvelopeSchema.extend({
  authpayuid: OptionalTextSchema,
  authPayuId: OptionalTextSchema,
  /** The billing amount echoed back, rupees. */
  amount: OptionalTextSchema,
  mandateStartDate: z.string().nullish(),
  mandateEndDate: z.string().nullish(),
  deletedon: z.string().nullish(),
});
export type PayUMandateStatusResponse = z.output<typeof PayUMandateStatusResponseSchema>;

/** `mandate_revoke`, `upi_mandate_revoke`, `upi_mandate_modify`. */
export const PayUMandateActionResponseSchema = PayUEnvelopeSchema.extend({
  authpayuid: OptionalTextSchema,
});
export type PayUMandateActionResponse = z.output<typeof PayUMandateActionResponseSchema>;

// ---------------------------------------------------------------------------
// Refunds [§11]
// ---------------------------------------------------------------------------

export const PayURefundVar9Schema = z.object({
  refundDetails: z.object({ remarks: z.string() }),
});

export const PayURefundResponseSchema = PayUEnvelopeSchema.extend({
  request_id: OptionalTextSchema,
  bank_ref_num: OptionalTextSchema,
  mihpayid: OptionalTextSchema,
  error_code: OptionalTextSchema,
});
export type PayURefundResponse = z.output<typeof PayURefundResponseSchema>;

// ---------------------------------------------------------------------------
// Webhooks [§10]
// ---------------------------------------------------------------------------

const MandateSiDetailsSchema = z.looseObject({
  billingAmount: OptionalTextSchema,
  paymentStartDate: z.string().nullish(),
  paymentEndDate: z.string().nullish(),
});

/** Card mandate modified / cancelled by the issuer. Signed. */
export const PayUCardMandateWebhookSchema = z.looseObject({
  status: z.string(),
  authPayuId: OptionalTextSchema,
  authpayuid: OptionalTextSchema,
  authpayuId: OptionalTextSchema,
  notificationType: z.string(),
  si_details: MandateSiDetailsSchema.nullish(),
  message: z.string().nullish(),
  eventDate: z.string().nullish(),
  key: OptionalTextSchema,
  udf1: OptionalTextSchema,
  udf2: OptionalTextSchema,
  udf3: OptionalTextSchema,
  udf4: OptionalTextSchema,
  udf5: OptionalTextSchema,
  hash: OptionalTextSchema,
});
export type PayUCardMandateWebhook = z.output<typeof PayUCardMandateWebhookSchema>;

/** UPI mandate paused / unpaused / revoked in the customer's PSP app. Signed. */
export const PayUUpiMandateWebhookSchema = z.looseObject({
  status: z.string(),
  authpayuid: OptionalTextSchema,
  authPayuId: OptionalTextSchema,
  action: z.string(),
  dateTime: z.string().nullish(),
  amount: OptionalTextSchema,
  endDate: z.string().nullish(),
  mandateNumber: z.string().nullish(),
  key: OptionalTextSchema,
  hash: OptionalTextSchema,
});
export type PayUUpiMandateWebhook = z.output<typeof PayUUpiMandateWebhookSchema>;

/** eNACH mandate cancellation. PayU documents no signature. */
export const PayUEnachCancellationWebhookSchema = z.looseObject({
  statusCode: z.union([z.number(), z.string()]).nullish(),
  notificationType: z.string(),
  status: z.string(),
  authPayuId: OptionalTextSchema,
  authpayuid: OptionalTextSchema,
  authPayuid: OptionalTextSchema,
  key: OptionalTextSchema,
});
export type PayUEnachCancellationWebhook = z.output<typeof PayUEnachCancellationWebhookSchema>;

/** Refund status callback. PayU documents no signature. */
export const PayURefundWebhookSchema = z.looseObject({
  action: z.string(),
  status: z.string(),
  mihpayid: OptionalTextSchema,
  request_id: OptionalTextSchema,
  token: OptionalTextSchema,
  merchantTxnId: OptionalTextSchema,
  amt: OptionalTextSchema,
  key: OptionalTextSchema,
  remark: z.string().nullish(),
});
export type PayURefundWebhook = z.output<typeof PayURefundWebhookSchema>;
