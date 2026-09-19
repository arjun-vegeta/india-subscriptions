import { z } from 'zod';
import {
  RAZORPAY_DEFAULT_DURATION_YEARS,
  RAZORPAY_MAX_AMOUNT_PAISE,
  RAZORPAY_MAX_DURATION_YEARS,
  RAZORPAY_MAX_NOTES,
  RAZORPAY_MIN_AMOUNT_PAISE,
  RazorpayPauseAt,
  RazorpayPlanPeriod,
  RazorpayResumeAt,
  RazorpayScheduleChangeAt,
} from './constants.js';

/**
 * Zod schemas for everything exchanged with Razorpay. Response schemas require
 * only what the adapter reads and accept every documented variant (fact sheet
 * section 12); statuses and event names stay plain strings and are translated
 * by lookup tables in `mapper.ts`.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const RazorpayConfigSchema = z.object({
  /** API key id (the checkout `key` option). */
  keyId: z.string().min(1, { error: 'keyId is required' }),
  /** API key secret. Never logged, never put in errors. */
  keySecret: z.string().min(1, { error: 'keySecret is required' }),
  /** Webhook secret from the Dashboard. Needed only by `parseWebhook`. */
  webhookSecret: z.string().min(1).optional(),
  /** Override of `https://api.razorpay.com` (proxies, tests). */
  baseUrl: z.url().optional(),
  /**
   * Length, in years, of a "bill until cancelled" subscription (Razorpay
   * requires a `total_count`). Default 10, the most conservative of the three
   * maximum durations the docs state.
   */
  defaultDurationYears: z
    .number()
    .int()
    .min(1)
    .max(RAZORPAY_MAX_DURATION_YEARS)
    .default(RAZORPAY_DEFAULT_DURATION_YEARS),
});
export type RazorpayConfig = z.input<typeof RazorpayConfigSchema>;
export type ParsedRazorpayConfig = z.output<typeof RazorpayConfigSchema>;

// ---------------------------------------------------------------------------
// Requests (what we send; validated before any network call)
// ---------------------------------------------------------------------------

const RequestNotesSchema = z
  .record(z.string(), z.string())
  .refine((notes) => Object.keys(notes).length <= RAZORPAY_MAX_NOTES, {
    error: `notes may hold at most ${RAZORPAY_MAX_NOTES} key-value pairs`,
  });

const RequestAmountSchema = z
  .number()
  .int()
  .min(RAZORPAY_MIN_AMOUNT_PAISE, { error: 'amount must be at least 100 paise (INR 1.00)' })
  .max(RAZORPAY_MAX_AMOUNT_PAISE, { error: 'amount must not exceed 4294967295 paise' });

export const RazorpayCreatePlanRequestSchema = z.object({
  period: z.enum(RazorpayPlanPeriod),
  interval: z.number().int().min(1),
  item: z.object({
    name: z.string().min(1),
    amount: RequestAmountSchema,
    currency: z.string().min(1),
    description: z.string().optional(),
  }),
  notes: RequestNotesSchema.optional(),
});
export type RazorpayCreatePlanRequest = z.infer<typeof RazorpayCreatePlanRequestSchema>;

/** The 100-paise floor is documented for plan items only; add-ons get the integer and upper-bound checks. */
const AddonAmountSchema = z.number().int().min(1).max(RAZORPAY_MAX_AMOUNT_PAISE);

export const RazorpayCreateSubscriptionRequestSchema = z.object({
  plan_id: z.string().min(1),
  total_count: z.number().int().min(1),
  quantity: z.number().int().min(1).optional(),
  /** Unix seconds. */
  start_at: z.number().int().optional(),
  /** Unix seconds. */
  expire_by: z.number().int().optional(),
  customer_notify: z.boolean().optional(),
  addons: z
    .array(
      z.object({
        item: z.object({
          name: z.string().min(1),
          amount: AddonAmountSchema,
          currency: z.string().min(1),
        }),
      }),
    )
    .optional(),
  notes: RequestNotesSchema.optional(),
});
export type RazorpayCreateSubscriptionRequest = z.infer<typeof RazorpayCreateSubscriptionRequestSchema>;

export const RazorpayCancelRequestSchema = z.object({
  cancel_at_cycle_end: z.boolean(),
});
export type RazorpayCancelRequest = z.infer<typeof RazorpayCancelRequestSchema>;

export const RazorpayPauseRequestSchema = z.object({ pause_at: z.enum(RazorpayPauseAt) });
export type RazorpayPauseRequest = z.infer<typeof RazorpayPauseRequestSchema>;

export const RazorpayResumeRequestSchema = z.object({ resume_at: z.enum(RazorpayResumeAt) });
export type RazorpayResumeRequest = z.infer<typeof RazorpayResumeRequestSchema>;

export const RazorpayUpdateRequestSchema = z.object({
  plan_id: z.string().min(1).optional(),
  quantity: z.number().int().min(1).optional(),
  remaining_count: z.number().int().min(1).optional(),
  start_at: z.number().int().optional(),
  schedule_change_at: z.enum(RazorpayScheduleChangeAt).optional(),
  customer_notify: z.boolean().optional(),
});
export type RazorpayUpdateRequest = z.infer<typeof RazorpayUpdateRequestSchema>;

export const RazorpayRefundRequestSchema = z.object({
  amount: z.number().int().min(1).optional(),
  receipt: z.string().min(1).optional(),
  notes: RequestNotesSchema.optional(),
});
export type RazorpayRefundRequest = z.infer<typeof RazorpayRefundRequestSchema>;

/** Query of `GET /v1/invoices` for one subscription. */
export const RazorpayInvoiceQuerySchema = z.object({
  subscription_id: z.string().min(1),
  count: z.number().int().min(1).max(100),
  skip: z.number().int().min(0),
});

// ---------------------------------------------------------------------------
// Checkout handler response
// ---------------------------------------------------------------------------

/** What Razorpay Checkout returns to the handler / callback after authorisation. */
export const RazorpayCheckoutResponseSchema = z.object({
  razorpay_payment_id: z.string().min(1, { error: 'razorpay_payment_id is required' }),
  razorpay_subscription_id: z.string().min(1, { error: 'razorpay_subscription_id is required' }),
  razorpay_signature: z.string().min(1, { error: 'razorpay_signature is required' }),
});
export type RazorpayCheckoutResponse = z.infer<typeof RazorpayCheckoutResponseSchema>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/**
 * `notes` is `[]` when empty and an object otherwise (fact sheet 1.7); values
 * are strings or numbers (SDK `IMap<string | number>`).
 */
const NotesSchema = z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]);

/** An integer that the SDK types as a string (`remaining_count`) but the API sends as a number. */
const CountSchema = z.union([z.number(), z.string()]);

/** `customer_notify` is documented as boolean, and the error text says `1`/`0` are accepted too. */
const NotifyFlagSchema = z.union([z.boolean(), z.number(), z.string()]);

export const RazorpayPlanEntitySchema = z.looseObject({
  id: z.string(),
  entity: z.string().nullish(),
  period: z.string(),
  interval: z.number(),
  item: z.looseObject({
    id: z.string().nullish(),
    name: z.string(),
    description: z.string().nullish(),
    amount: z.number().nullish(),
    unit_amount: z.number().nullish(),
    currency: z.string().nullish(),
  }),
  notes: NotesSchema.nullish(),
  created_at: z.number().nullish(),
});
export type RazorpayPlanEntity = z.infer<typeof RazorpayPlanEntitySchema>;

export const RazorpaySubscriptionEntitySchema = z.looseObject({
  id: z.string(),
  entity: z.string().nullish(),
  plan_id: z.string().nullish(),
  customer_id: z.string().nullish(),
  customer_email: z.string().nullish(),
  customer_contact: z.string().nullish(),
  status: z.string(),
  current_start: z.number().nullish(),
  current_end: z.number().nullish(),
  ended_at: z.number().nullish(),
  charge_at: z.number().nullish(),
  start_at: z.number().nullish(),
  end_at: z.number().nullish(),
  created_at: z.number().nullish(),
  expire_by: z.number().nullish(),
  paused_at: z.number().nullish(),
  change_scheduled_at: z.number().nullish(),
  quantity: z.number().nullish(),
  auth_attempts: z.number().nullish(),
  total_count: CountSchema.nullish(),
  paid_count: CountSchema.nullish(),
  remaining_count: CountSchema.nullish(),
  notes: NotesSchema.nullish(),
  customer_notify: NotifyFlagSchema.nullish(),
  short_url: z.string().nullish(),
  has_scheduled_changes: z.boolean().nullish(),
  payment_method: z.string().nullish(),
  offer_id: z.string().nullish(),
  source: z.string().nullish(),
  pause_initiated_by: z.string().nullish(),
  cancel_initiated_by: z.string().nullish(),
  type: z.number().nullish(),
});
export type RazorpaySubscriptionEntity = z.infer<typeof RazorpaySubscriptionEntitySchema>;

const InvoiceLineItemSchema = z.looseObject({
  id: z.string().nullish(),
  name: z.string().nullish(),
  type: z.string().nullish(),
  amount: z.number().nullish(),
  quantity: z.number().nullish(),
});

export const RazorpayInvoiceEntitySchema = z.looseObject({
  id: z.string(),
  entity: z.string().nullish(),
  subscription_id: z.string().nullish(),
  payment_id: z.string().nullish(),
  order_id: z.string().nullish(),
  status: z.string(),
  amount: z.number(),
  amount_paid: z.number().nullish(),
  amount_due: z.number().nullish(),
  currency: z.string().nullish(),
  line_items: z.array(InvoiceLineItemSchema).nullish(),
  billing_start: z.number().nullish(),
  billing_end: z.number().nullish(),
  issued_at: z.number().nullish(),
  paid_at: z.number().nullish(),
  date: z.number().nullish(),
  created_at: z.number().nullish(),
  short_url: z.string().nullish(),
});
export type RazorpayInvoiceEntity = z.infer<typeof RazorpayInvoiceEntitySchema>;

export const RazorpayInvoiceCollectionSchema = z.looseObject({
  entity: z.string().nullish(),
  count: z.number().nullish(),
  items: z.array(RazorpayInvoiceEntitySchema),
});
export type RazorpayInvoiceCollection = z.infer<typeof RazorpayInvoiceCollectionSchema>;

export const RazorpayPaymentEntitySchema = z.looseObject({
  id: z.string(),
  entity: z.string().nullish(),
  amount: z.number(),
  currency: z.string().nullish(),
  status: z.string(),
  order_id: z.string().nullish(),
  invoice_id: z.string().nullish(),
  method: z.string().nullish(),
  amount_refunded: z.number().nullish(),
  /** JSON null, or the SDK's string-typed 'null' / 'partial' / 'full'. */
  refund_status: z.string().nullish(),
  /** `"1"` in webhook samples, boolean in the SDK types. */
  captured: z.union([z.boolean(), z.string(), z.number()]).nullish(),
  description: z.string().nullish(),
  error_code: z.string().nullish(),
  error_description: z.string().nullish(),
  error_reason: z.string().nullish(),
  created_at: z.number().nullish(),
});
export type RazorpayPaymentEntity = z.infer<typeof RazorpayPaymentEntitySchema>;

export const RazorpayRefundEntitySchema = z.looseObject({
  id: z.string(),
  entity: z.string().nullish(),
  /** Optional in the SDK type; the adapter falls back to the requested amount. */
  amount: z.number().nullish(),
  currency: z.string().nullish(),
  payment_id: z.string().nullish(),
  receipt: z.string().nullish(),
  status: z.string(),
  created_at: z.number().nullish(),
});
export type RazorpayRefundEntity = z.infer<typeof RazorpayRefundEntitySchema>;

/** `{ error: { code, description, field?, source?, step?, reason?, metadata? } }` (fact sheet 1.9). */
export const RazorpayErrorBodySchema = z.looseObject({
  error: z.looseObject({
    code: z.string().nullish(),
    description: z.string().nullish(),
    field: z.string().nullish(),
    source: z.string().nullish(),
    step: z.string().nullish(),
    reason: z.string().nullish(),
  }),
});

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

const WebhookEntityHolderSchema = z.looseObject({ entity: z.unknown() });

/**
 * The envelope only. Entities stay `unknown` here and are validated against
 * their own schemas for the events this adapter normalises, so an event type
 * Razorpay adds tomorrow does not make the whole webhook fail.
 * `created_at` is normally top-level but sits inside `payload` in one
 * documented sample (fact sheet 9.1).
 */
export const RazorpayWebhookBodySchema = z.looseObject({
  entity: z.string().nullish(),
  account_id: z.string().nullish(),
  event: z.string(),
  contains: z.array(z.string()).nullish(),
  payload: z.looseObject({
    subscription: WebhookEntityHolderSchema.nullish(),
    payment: WebhookEntityHolderSchema.nullish(),
    created_at: z.number().nullish(),
  }),
  created_at: z.number().nullish(),
});
export type RazorpayWebhookBody = z.infer<typeof RazorpayWebhookBodySchema>;
