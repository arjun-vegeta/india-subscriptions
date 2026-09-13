import { z } from 'zod';
import { Environment } from '../../constants.js';
import { rupeesToPaise } from '../../money.js';
import {
  API_VERSION_PATTERN,
  CASHFREE_API_VERSION,
  CashfreeIntervalType,
  CashfreeNotificationChannel,
  CashfreeMethod,
  CashfreePlanType,
  CashfreePaymentType,
  ManageAction,
  MAX_SUBSCRIPTION_TAGS,
  PLAN_ID_PATTERN,
  PLAN_NAME_MAX_LENGTH,
  RETURN_URL_SUBSCRIPTION_ID_PARAM,
  SUBSCRIPTION_ID_MAX_LENGTH,
  SUBSCRIPTION_ID_PATTERN,
} from './constants.js';

/**
 * Zod schemas for Cashfree's payloads. Responses are `looseObject`s with only
 * the fields the adapter reads required: Cashfree omits and nulls fields
 * freely, and its docs contradict themselves in places (see the fact sheet,
 * section 12). Every documented variant is accepted here and normalised in
 * `mapper.ts`:
 *
 * - `authorisation_details` (spec, SDK) vs `authorization_details` (samples, webhooks)
 * - `payment_method` as an object keyed by method, or as a plain string
 * - camelCase `authorizationStatus` etc. in 2023-08-01 webhooks
 * - `failure_details.failure_reason` vs `failureDetails.failureReason`
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const CashfreeConfigSchema = z.object({
  /** Cashfree `x-client-id` (the dashboard's AppId). */
  clientId: z.string().min(1, { error: 'clientId is required' }),
  /** Cashfree `x-client-secret` (the dashboard's SecretKey). Never logged or put in errors. */
  clientSecret: z.string().min(1, { error: 'clientSecret is required' }),
  /** `test` calls the sandbox host, `live` the production host. */
  environment: z.enum(Environment),
  /** `x-api-version`. Defaults to the current version. */
  apiVersion: z
    .string()
    .regex(API_VERSION_PATTERN, { error: 'apiVersion must look like YYYY-MM-DD' })
    .default(CASHFREE_API_VERSION),
  /**
   * Secret that signs webhooks. Defaults to `clientSecret`, which is what
   * Cashfree's own SDK verifies with (`PGVerifyWebhookSignature`); the docs
   * only say "your secret key". Partner-level webhooks use the partner API key.
   */
  webhookSecret: z.string().min(1, { error: 'webhookSecret must not be empty' }).optional(),
  /** Overrides the host, e.g. for a proxy or a mock server. Include the `/pg` prefix. */
  baseUrl: z.url({ error: 'baseUrl must be a valid URL' }).optional(),
});
export type CashfreeConfig = z.input<typeof CashfreeConfigSchema>;
export type ParsedCashfreeConfig = z.output<typeof CashfreeConfigSchema>;

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

/** A rupee amount as Cashfree sends it: a JSON number (`399.00`) or, rarely, a string. */
const AmountSchema = z.union([z.number(), z.string()]).refine(
  (value) => {
    const paise = rupeesToPaise(value);
    return paise !== undefined && paise >= 0;
  },
  { error: 'not a valid non-negative rupee amount' },
);

/** Cashfree ids are typed string but a few endpoints document numbers. */
const IdSchema = z.union([z.string(), z.number()]);

const LooseRecordSchema = z.record(z.string(), z.unknown());

// ---------------------------------------------------------------------------
// Requests (what this adapter sends)
// ---------------------------------------------------------------------------

const planRequestFields = {
  plan_name: z.string().min(1).max(PLAN_NAME_MAX_LENGTH),
  plan_type: z.enum(CashfreePlanType),
  plan_currency: z.string().min(1).optional(),
  plan_max_amount: z.number().positive(),
  plan_max_cycles: z.number().int().positive().optional(),
  plan_intervals: z.number().int().positive().optional(),
  plan_interval_type: z.enum(CashfreeIntervalType).optional(),
  plan_note: z.string().min(1).optional(),
};

/** `POST /plans` [openapi CreatePlanRequest]. The amount field is `plan_recurring_amount` here. */
export const CashfreeCreatePlanRequestSchema = z
  .object({
    plan_id: z.string().min(1).max(40).regex(PLAN_ID_PATTERN),
    ...planRequestFields,
    plan_recurring_amount: z.number().positive().optional(),
  })
  .refine(
    (plan) =>
      plan.plan_type !== CashfreePlanType.Periodic ||
      (plan.plan_recurring_amount !== undefined &&
        plan.plan_intervals !== undefined &&
        plan.plan_interval_type !== undefined),
    { error: 'PERIODIC plans need plan_recurring_amount, plan_intervals and plan_interval_type' },
  );
export type CashfreeCreatePlanRequest = z.infer<typeof CashfreeCreatePlanRequestSchema>;

const customerRequestSchema = z.object({
  customer_name: z.string().min(1).optional(),
  customer_email: z.string().min(1),
  customer_phone: z.string().min(1),
});

/**
 * Plan inside `POST /subscriptions`: either just a `plan_id`, or the inline
 * plan. The OpenAPI request schema names the periodic amount `plan_amount`
 * here (and `plan_recurring_amount` in `POST /plans` and in every response).
 */
const inlinePlanRequestSchema = z.object({
  plan_id: z.string().min(1).max(40).regex(PLAN_ID_PATTERN).optional(),
  ...planRequestFields,
  plan_name: planRequestFields.plan_name.optional(),
  plan_type: planRequestFields.plan_type.optional(),
  plan_max_amount: planRequestFields.plan_max_amount.optional(),
  plan_amount: z.number().positive().optional(),
});

export const CashfreeCreateSubscriptionRequestSchema = z.object({
  subscription_id: z.string().min(1).max(SUBSCRIPTION_ID_MAX_LENGTH).regex(SUBSCRIPTION_ID_PATTERN),
  customer_details: customerRequestSchema,
  plan_details: inlinePlanRequestSchema,
  authorization_details: z
    .object({
      authorization_amount: z.number().nonnegative(),
      authorization_amount_refund: z.boolean(),
      payment_methods: z.array(z.enum(CashfreeMethod)).min(1).optional(),
    })
    .optional(),
  subscription_meta: z
    .object({
      return_url: z.url().optional(),
      notification_channel: z.array(z.enum(CashfreeNotificationChannel)).min(1).optional(),
      session_id_expiry: z.string().min(1).optional(),
    })
    .optional(),
  subscription_expiry_time: z.string().min(1).optional(),
  subscription_first_charge_time: z.string().min(1).optional(),
  subscription_tags: z
    .record(z.string(), z.string())
    .refine((tags) => Object.keys(tags).length <= MAX_SUBSCRIPTION_TAGS, {
      error: `Cashfree accepts at most ${MAX_SUBSCRIPTION_TAGS} subscription tags`,
    })
    .optional(),
});
export type CashfreeCreateSubscriptionRequest = z.infer<typeof CashfreeCreateSubscriptionRequestSchema>;

/** `POST /subscriptions/{id}/manage` [openapi ManageSubscriptionRequest]. */
export const CashfreeManageSubscriptionRequestSchema = z
  .object({
    subscription_id: z.string().min(1),
    action: z.enum(ManageAction),
    action_details: z
      .object({
        next_scheduled_time: z.string().min(1).optional(),
        plan_id: z.string().min(1).optional(),
      })
      .optional(),
  })
  .refine((body) => body.action !== ManageAction.Activate || body.action_details?.next_scheduled_time !== undefined, {
    error: 'ACTIVATE needs action_details.next_scheduled_time',
  })
  .refine((body) => body.action !== ManageAction.ChangePlan || body.action_details?.plan_id !== undefined, {
    error: 'CHANGE_PLAN needs action_details.plan_id',
  });
export type CashfreeManageSubscriptionRequest = z.infer<typeof CashfreeManageSubscriptionRequestSchema>;

/** `POST /subscriptions/pay` with `payment_type: CHARGE` [openapi CreateSubscriptionPaymentRequest]. */
export const CashfreeChargeRequestSchema = z.object({
  subscription_id: z.string().min(1),
  payment_id: z.string().min(1).max(50),
  payment_type: z.literal(CashfreePaymentType.Charge),
  payment_amount: z.number().positive(),
  payment_schedule_date: z.string().min(1),
  payment_remarks: z.string().min(1).optional(),
});
export type CashfreeChargeRequest = z.infer<typeof CashfreeChargeRequestSchema>;

/** `POST /subscriptions/{id}/refunds` [openapi CreateSubscriptionRefundRequest]. */
export const CashfreeRefundRequestSchema = z.object({
  subscription_id: z.string().min(1),
  payment_id: z.string().min(1),
  refund_id: z.string().min(1).max(40),
  refund_amount: z.number().positive(),
  refund_note: z.string().min(1).optional(),
});
export type CashfreeRefundRequest = z.infer<typeof CashfreeRefundRequestSchema>;

/** The Cashfree return URL query: only the merchant subscription id is read, and only to look the subscription up. */
export const CashfreeReturnParamsSchema = z.looseObject({
  [RETURN_URL_SUBSCRIPTION_ID_PARAM]: z.union([z.string().min(1), z.number()]),
});

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

const planFields = {
  plan_currency: z.string().nullish(),
  plan_interval_type: z.string().nullish(),
  plan_intervals: z.number().nullish(),
  plan_max_amount: AmountSchema.nullish(),
  plan_max_cycles: z.number().nullish(),
  plan_name: z.string().nullish(),
  plan_note: z.string().nullish(),
  plan_recurring_amount: AmountSchema.nullish(),
  plan_status: z.string().nullish(),
  plan_type: z.string().nullish(),
};

/** `PlanEntity` [openapi]: the response of create / fetch plan. */
export const CashfreePlanSchema = z.looseObject({
  plan_id: z.string(),
  ...planFields,
});
export type CashfreePlan = z.infer<typeof CashfreePlanSchema>;

/** The plan embedded in a subscription or webhook; every field may be missing. */
export const CashfreeEmbeddedPlanSchema = z.looseObject({
  plan_id: z.string().nullish(),
  ...planFields,
});
export type CashfreeEmbeddedPlan = z.infer<typeof CashfreeEmbeddedPlanSchema>;

export const CashfreeCustomerSchema = z.looseObject({
  customer_name: z.string().nullish(),
  customer_email: z.string().nullish(),
  customer_phone: z.string().nullish(),
});

/**
 * `AuthorizationDetails` in every documented spelling. `payment_method` is an
 * object keyed by method in the spec and webhooks (2025+), a string in the
 * guide's 2025-01-01 samples and the 2023-08-01 webhooks. The camelCase keys
 * are the 2023-08-01 `SUBSCRIPTION_STATUS_CHANGED` shape.
 */
export const CashfreeAuthorizationDetailsSchema = z.looseObject({
  authorization_amount: AmountSchema.nullish(),
  authorization_amount_refund: z.boolean().nullish(),
  authorization_reference: z.string().nullish(),
  authorization_time: z.string().nullish(),
  authorization_status: z.string().nullish(),
  payment_id: IdSchema.nullish(),
  payment_group: z.string().nullish(),
  payment_method: z.union([z.string(), LooseRecordSchema]).nullish(),
  authorizationAmount: AmountSchema.nullish(),
  authorizationAmountRefund: z.boolean().nullish(),
  authorizationStatus: z.string().nullish(),
  paymentMethod: z.union([z.string(), LooseRecordSchema]).nullish(),
  paymentId: IdSchema.nullish(),
});
export type CashfreeAuthorizationDetails = z.infer<typeof CashfreeAuthorizationDetailsSchema>;

/** `SubscriptionEntity` [openapi]: create / fetch / manage subscription. */
export const CashfreeSubscriptionSchema = z.looseObject({
  subscription_id: z.string().min(1),
  subscription_status: z.string(),
  cf_subscription_id: IdSchema.nullish(),
  customer_details: CashfreeCustomerSchema.nullish(),
  plan_details: CashfreeEmbeddedPlanSchema.nullish(),
  /** Samples and webhooks spell it with a "z" ... */
  authorization_details: CashfreeAuthorizationDetailsSchema.nullish(),
  /** ... the spec schema and SDK type with an "s". */
  authorisation_details: CashfreeAuthorizationDetailsSchema.nullish(),
  subscription_expiry_time: z.string().nullish(),
  subscription_first_charge_time: z.string().nullish(),
  subscription_meta: z.looseObject({ return_url: z.string().nullish() }).nullish(),
  subscription_note: z.string().nullish(),
  subscription_session_id: z.string().nullish(),
  subscription_tags: LooseRecordSchema.nullish(),
  next_schedule_date: z.string().nullish(),
});
export type CashfreeSubscription = z.infer<typeof CashfreeSubscriptionSchema>;

const FailureDetailsSchema = z.union([
  z.looseObject({ failure_reason: z.string().nullish() }),
  z.looseObject({ failureReason: z.string().nullish() }),
  z.string(),
]);

/**
 * `SubscriptionPaymentEntity` [openapi]: the payments endpoints, the charge
 * response and the payment webhooks (which add `subscription_details`).
 */
export const CashfreePaymentSchema = z.looseObject({
  payment_id: z.string().min(1),
  payment_status: z.string(),
  payment_amount: AmountSchema,
  subscription_id: z.string().nullish(),
  cf_payment_id: IdSchema.nullish(),
  cf_subscription_id: IdSchema.nullish(),
  payment_type: z.string().nullish(),
  payment_currency: z.string().nullish(),
  payment_schedule_date: z.string().nullish(),
  payment_initiated_date: z.string().nullish(),
  payment_remarks: z.string().nullish(),
  retry_attempts: z.number().nullish(),
  authorization_details: CashfreeAuthorizationDetailsSchema.nullish(),
  failure_details: FailureDetailsSchema.nullish(),
  /** 2023-08-01 webhooks use camelCase here. */
  failureDetails: FailureDetailsSchema.nullish(),
  /** `payment_method` on a create-charge response ("Payment method used for the authorisation"); often null. */
  payment_method: z.union([z.string(), LooseRecordSchema]).nullish(),
});
export type CashfreePayment = z.infer<typeof CashfreePaymentSchema>;

export const CashfreePaymentListSchema = z.array(CashfreePaymentSchema);

/** `SubscriptionPaymentRefundEntity` [openapi]; also the data of `SUBSCRIPTION_REFUND_STATUS`. */
export const CashfreeRefundSchema = z.looseObject({
  refund_id: z.string().min(1),
  refund_status: z.string(),
  payment_id: z.string().nullish(),
  cf_payment_id: IdSchema.nullish(),
  cf_refund_id: IdSchema.nullish(),
  refund_amount: AmountSchema.nullish(),
  refund_note: z.string().nullish(),
  refund_speed: z.string().nullish(),
  failure_details: z.union([z.string(), LooseRecordSchema]).nullish(),
});
export type CashfreeRefund = z.infer<typeof CashfreeRefundSchema>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Error body. The 2026-01-01 spec declares `{ message, code, type, help }`;
 * the error-codes page (and the legacy `/api/v2` API) use
 * `{ status, subCode, message, reason }`. Both are read, either may be absent.
 */
export const CashfreeErrorBodySchema = z.looseObject({
  message: z.string().nullish(),
  code: z.union([z.string(), z.number()]).nullish(),
  type: z.string().nullish(),
  help: z.string().nullish(),
  status: z.union([z.string(), z.number()]).nullish(),
  subCode: z.union([z.string(), z.number()]).nullish(),
  reason: z.string().nullish(),
});
export type CashfreeErrorBody = z.infer<typeof CashfreeErrorBodySchema>;

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/** Every webhook: `{ data, event_time, type }` [guide:webhooks]. */
export const CashfreeWebhookEnvelopeSchema = z.looseObject({
  type: z.string().min(1),
  event_time: z.string().nullish(),
  data: LooseRecordSchema,
});
export type CashfreeWebhookEnvelope = z.infer<typeof CashfreeWebhookEnvelopeSchema>;

const WebhookSubscriptionDetailsSchema = z.looseObject({
  subscription_id: z.string().min(1),
  subscription_status: z.string(),
  cf_subscription_id: IdSchema.nullish(),
  subscription_expiry_time: z.string().nullish(),
  subscription_first_charge_time: z.string().nullish(),
  subscription_tags: LooseRecordSchema.nullish(),
  next_schedule_date: z.string().nullish(),
});

/** `SUBSCRIPTION_STATUS_CHANGED` data (2025-01-01 and 2023-08-01 shapes). */
export const CashfreeStatusWebhookDataSchema = z.looseObject({
  subscription_details: WebhookSubscriptionDetailsSchema,
  customer_details: CashfreeCustomerSchema.nullish(),
  plan_details: CashfreeEmbeddedPlanSchema.nullish(),
  authorization_details: CashfreeAuthorizationDetailsSchema.nullish(),
});
export type CashfreeStatusWebhookData = z.infer<typeof CashfreeStatusWebhookDataSchema>;

/**
 * Data of the payment webhooks (`SUBSCRIPTION_AUTH_STATUS`,
 * `SUBSCRIPTION_PAYMENT_*`). 2026-01-01 adds `subscription_details`.
 */
export const CashfreePaymentWebhookDataSchema = CashfreePaymentSchema.extend({
  subscription_id: z.string().min(1),
  subscription_details: WebhookSubscriptionDetailsSchema.partial().nullish(),
});
export type CashfreePaymentWebhookData = z.infer<typeof CashfreePaymentWebhookDataSchema>;

/** Data of `SUBSCRIPTION_REFUND_STATUS`; it carries no subscription id. */
export const CashfreeRefundWebhookDataSchema = CashfreeRefundSchema;

/** Best-effort read of the events this adapter does not normalise, only to find the subscription id. */
export const CashfreeLooseEventDataSchema = z.looseObject({
  subscription_id: z.string().nullish(),
  notification_id: z.string().nullish(),
  execution_id: z.string().nullish(),
  cf_notification_id: IdSchema.nullish(),
  cf_execution_id: IdSchema.nullish(),
  notification_status: z.string().nullish(),
  execution_status: z.string().nullish(),
  subscription_status_webhook: z
    .looseObject({
      subscription_details: z.looseObject({ subscription_id: z.string().nullish() }).nullish(),
    })
    .nullish(),
});
