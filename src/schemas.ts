import { z } from 'zod';
import {
  CancelMode,
  ChangeTiming,
  ChargeKind,
  ChargeStatus,
  CheckoutKind,
  Currency,
  Environment,
  EventType,
  IntervalUnit,
  PaymentMethod,
  Provider,
  RefundStatus,
  SchedulingMode,
  SubscriptionStatus,
} from './constants.js';

/**
 * The unified, gateway-neutral model. These schemas are the single source of
 * truth: TypeScript types are inferred from them, inputs are validated with
 * them at runtime, and the OpenAPI document for other languages is generated
 * from them. Everything here is plain JSON:
 *
 * - amounts are integers in paise (₹499 is 49900),
 * - instants are ISO-8601 strings with an offset ("2026-11-17T10:30:00+05:30"
 *   or "...Z"),
 * - enumerations come from `constants.ts`.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const ProviderSchema = z.enum(Provider);
export const CurrencySchema = z.enum(Currency);
export const SubscriptionStatusSchema = z.enum(SubscriptionStatus);
export const ChargeStatusSchema = z.enum(ChargeStatus);
export const ChargeKindSchema = z.enum(ChargeKind);
export const RefundStatusSchema = z.enum(RefundStatus);
export const PaymentMethodSchema = z.enum(PaymentMethod);
export const SchedulingModeSchema = z.enum(SchedulingMode);
export const EventTypeSchema = z.enum(EventType);
export const EnvironmentSchema = z.enum(Environment);

/** A non-negative integer amount in paise. */
export const PaiseSchema = z.number().int().nonnegative();
export type Paise = z.infer<typeof PaiseSchema>;

/** A strictly positive integer amount in paise. */
export const PositivePaiseSchema = z.number().int().positive();

/** An ISO-8601 instant with a timezone offset or `Z`. */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

export const MetadataSchema = z.record(z.string(), z.string());
export type Metadata = z.infer<typeof MetadataSchema>;

export const BillingIntervalSchema = z.object({
  unit: z.enum(IntervalUnit),
  /** Bill every `count` units: `{ unit: 'month', count: 3 }` is quarterly. */
  count: z.number().int().min(1),
});
export type BillingInterval = z.infer<typeof BillingIntervalSchema>;

export const CustomerSchema = z.object({
  /** The gateway's customer id, where one exists. */
  id: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  email: z.email().optional(),
  /** Mobile number; 10 digits or E.164. Adapters format it for their gateway. */
  phone: z
    .string()
    .regex(/^\+?[0-9]{10,15}$/)
    .optional(),
});
export type Customer = z.infer<typeof CustomerSchema>;

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export const CreatePlanInputSchema = z
  .object({
  /**
   * Your own plan id. Used where the gateway lets the merchant choose the id;
   * ignored where the gateway generates one.
   */
  id: z.string().min(1).max(40).optional(),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  /** Amount charged every cycle, in paise. */
  amount: PositivePaiseSchema,
  currency: CurrencySchema.default(Currency.INR),
  interval: BillingIntervalSchema,
  /** Who raises each charge. Defaults to the gateway's native mode. */
  scheduling: SchedulingModeSchema.optional(),
  /**
   * Ceiling the mandate allows per debit, in paise. Defaults to `amount`.
   * Set it higher to leave room for upgrades or add-ons.
   */
  maxAmount: PositivePaiseSchema.optional(),
  /** Number of cycles after which the plan ends. Omit for open-ended. */
  maxCycles: z.number().int().positive().optional(),
  metadata: MetadataSchema.optional(),
})
  .refine((plan) => plan.maxAmount === undefined || plan.maxAmount >= plan.amount, {
    error: 'maxAmount must be at least amount: the mandate ceiling cannot be below the recurring charge',
    path: ['maxAmount'],
  });
export type CreatePlanInput = z.input<typeof CreatePlanInputSchema>;
export type ParsedCreatePlanInput = z.output<typeof CreatePlanInputSchema>;

export const PlanSchema = z.object({
  provider: ProviderSchema,
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  amount: PaiseSchema,
  currency: CurrencySchema,
  interval: BillingIntervalSchema.optional(),
  scheduling: SchedulingModeSchema,
  maxAmount: PaiseSchema.optional(),
  maxCycles: z.number().int().optional(),
  /** The gateway's own plan status, verbatim, where it has one. */
  providerStatus: z.string().optional(),
  createdAt: IsoDateTimeSchema.optional(),
  metadata: MetadataSchema.optional(),
  /** The gateway's response, untouched. */
  raw: z.unknown(),
});
export type Plan = z.infer<typeof PlanSchema>;

// ---------------------------------------------------------------------------
// Checkout (mandate authorisation by the customer)
// ---------------------------------------------------------------------------

export const RedirectCheckoutSchema = z.object({
  kind: z.literal(CheckoutKind.Redirect),
  url: z.url(),
});

export const FormPostCheckoutSchema = z.object({
  kind: z.literal(CheckoutKind.FormPost),
  url: z.url(),
  /** Post these fields exactly as given; they are covered by a hash. */
  fields: z.record(z.string(), z.string()),
});

export const RazorpayCheckoutSchema = z.object({
  kind: z.literal(CheckoutKind.RazorpayCheckout),
  keyId: z.string(),
  subscriptionId: z.string(),
  /** Razorpay-hosted authorisation page, usable instead of the JS checkout. */
  hostedUrl: z.url().optional(),
  /** Where Razorpay Checkout redirects after authorisation (its `callback_url` option). */
  callbackUrl: z.url().optional(),
  /** Customer details to prefill in the checkout form. */
  prefill: CustomerSchema.optional(),
});

export const CashfreeCheckoutSchema = z.object({
  kind: z.literal(CheckoutKind.CashfreeCheckout),
  sessionId: z.string(),
  environment: EnvironmentSchema,
});

export const CheckoutInstructionSchema = z.discriminatedUnion('kind', [
  RedirectCheckoutSchema,
  FormPostCheckoutSchema,
  RazorpayCheckoutSchema,
  CashfreeCheckoutSchema,
]);
export type CheckoutInstruction = z.infer<typeof CheckoutInstructionSchema>;

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

/** Free trial: the mandate is set up now, the first charge happens when the trial ends. */
export const TrialSchema = z
  .object({
    /** Trial length in days from now. */
    days: z.number().int().positive().optional(),
    /** Or an exact instant at which the trial ends. */
    endsAt: IsoDateTimeSchema.optional(),
  })
  .refine((trial) => (trial.days === undefined) !== (trial.endsAt === undefined), {
    error: 'trial needs exactly one of days or endsAt',
  });
export type Trial = z.infer<typeof TrialSchema>;

export const CreateSubscriptionInputSchema = z
  .object({
    /**
     * Your own id for this subscription. Sent to the gateway where it accepts a
     * merchant reference, and echoed back on `Subscription.reference`.
     */
    reference: z.string().min(1).max(60).optional(),
    /** An existing plan id, or plan details to create inline. */
    plan: z.union([z.string().min(1), CreatePlanInputSchema]),
    customer: CustomerSchema,
    /** Units of the plan billed each cycle. Defaults to 1. */
    quantity: z.number().int().positive().optional(),
    /** Total number of recurring charges. Omit to bill until cancelled, where the gateway allows. */
    totalCycles: z.number().int().positive().optional(),
    /** Free trial. Mutually exclusive with `startAt`. */
    trial: TrialSchema.optional(),
    /** Delay the first recurring charge to this instant without calling it a trial. */
    startAt: IsoDateTimeSchema.optional(),
    /** One-off amount collected together with the authorisation (setup fee or first payment), in paise. */
    upfrontAmount: PositivePaiseSchema.optional(),
    /** Label shown to the customer for the upfront amount. */
    upfrontLabel: z.string().min(1).max(100).optional(),
    /** Restrict the mandate to these payment methods. Omit to allow all the gateway supports. */
    paymentMethods: z.array(PaymentMethodSchema).min(1).optional(),
    /** Deadline for the customer to authorise the mandate. */
    authorizeBy: IsoDateTimeSchema.optional(),
    /** When the mandate itself should lapse. */
    mandateEndsAt: IsoDateTimeSchema.optional(),
    /** Where the gateway sends the customer after authorisation. */
    returnUrl: z.url().optional(),
    /** Let the gateway send its own SMS/email to the customer. */
    notifyCustomer: z.boolean().optional(),
    metadata: MetadataSchema.optional(),
    /** Makes the create call safe to retry, where the gateway supports idempotency keys. */
    idempotencyKey: z.string().min(1).max(255).optional(),
  })
  .refine((input) => !(input.trial && input.startAt), {
    error: 'Pass either trial or startAt, not both: both set the date of the first charge',
  })
  .refine(
    (input) => {
      const firstCharge = input.startAt ?? input.trial?.endsAt;
      if (!firstCharge || !input.mandateEndsAt) return true;
      return Date.parse(input.mandateEndsAt) > Date.parse(firstCharge);
    },
    { error: 'mandateEndsAt must be after the first charge date', path: ['mandateEndsAt'] },
  )
  .refine(
    (input) => {
      const firstCharge = input.startAt ?? input.trial?.endsAt;
      if (!firstCharge || !input.authorizeBy) return true;
      return Date.parse(input.authorizeBy) <= Date.parse(firstCharge);
    },
    { error: 'authorizeBy must not be after the first charge date', path: ['authorizeBy'] },
  );
export type CreateSubscriptionInput = z.input<typeof CreateSubscriptionInputSchema>;
export type ParsedCreateSubscriptionInput = z.output<typeof CreateSubscriptionInputSchema>;

export const SubscriptionSchema = z.object({
  provider: ProviderSchema,
  /** The identifier to pass back to this library for every later call. */
  id: z.string(),
  /** Your own reference, where one was supplied. */
  reference: z.string().optional(),
  planId: z.string().optional(),
  status: SubscriptionStatusSchema,
  /** The gateway's own status, verbatim. */
  providerStatus: z.string(),
  scheduling: SchedulingModeSchema,
  customer: CustomerSchema.optional(),
  quantity: z.number().int().optional(),
  /** Recurring amount per cycle in paise, where known. */
  amount: PaiseSchema.optional(),
  /** Mandate ceiling per debit in paise, where known. */
  maxAmount: PaiseSchema.optional(),
  currency: CurrencySchema.optional(),
  interval: BillingIntervalSchema.optional(),
  totalCycles: z.number().int().optional(),
  paidCycles: z.number().int().optional(),
  remainingCycles: z.number().int().optional(),
  createdAt: IsoDateTimeSchema.optional(),
  /** When the first recurring charge is or was due. */
  startAt: IsoDateTimeSchema.optional(),
  /** Set while `status` is `trialing`: when the trial ends and the first charge is due. */
  trialEndsAt: IsoDateTimeSchema.optional(),
  currentPeriodStart: IsoDateTimeSchema.optional(),
  currentPeriodEnd: IsoDateTimeSchema.optional(),
  nextChargeAt: IsoDateTimeSchema.optional(),
  endedAt: IsoDateTimeSchema.optional(),
  mandateEndsAt: IsoDateTimeSchema.optional(),
  /** True when a cancellation is scheduled for the end of the current period. */
  cancelAtPeriodEnd: z.boolean().optional(),
  paymentMethod: PaymentMethodSchema.optional(),
  /** Present on freshly created subscriptions: what the customer must do to authorise. */
  checkout: CheckoutInstructionSchema.optional(),
  metadata: MetadataSchema.optional(),
  /** The gateway's response, untouched. */
  raw: z.unknown(),
});
export type Subscription = z.infer<typeof SubscriptionSchema>;

export const CancelSubscriptionOptionsSchema = z.object({
  mode: z.enum(CancelMode).default(CancelMode.Immediately),
});
export type CancelSubscriptionOptions = z.input<typeof CancelSubscriptionOptionsSchema>;

export const PauseSubscriptionOptionsSchema = z.object({
  /** Resume automatically at this instant, where the gateway supports it. */
  resumeAt: IsoDateTimeSchema.optional(),
});
export type PauseSubscriptionOptions = z.input<typeof PauseSubscriptionOptionsSchema>;

export const ResumeSubscriptionOptionsSchema = z.object({
  /** Date of the next charge after resuming, where the gateway needs one. */
  nextChargeAt: IsoDateTimeSchema.optional(),
});
export type ResumeSubscriptionOptions = z.input<typeof ResumeSubscriptionOptionsSchema>;

export const UpdateSubscriptionInputSchema = z
  .object({
    /** Move to another plan (upgrade or downgrade). */
    planId: z.string().min(1).optional(),
    quantity: z.number().int().positive().optional(),
    remainingCycles: z.number().int().positive().optional(),
    /** New amount per cycle in paise, for mandates that are not plan-based. */
    amount: PositivePaiseSchema.optional(),
    /** Move the next charge date. */
    nextChargeAt: IsoDateTimeSchema.optional(),
    /** New mandate end date. */
    mandateEndsAt: IsoDateTimeSchema.optional(),
    timing: z.enum(ChangeTiming).default(ChangeTiming.Immediately),
    notifyCustomer: z.boolean().optional(),
  })
  .refine(
    (input) =>
      input.planId !== undefined ||
      input.quantity !== undefined ||
      input.remainingCycles !== undefined ||
      input.amount !== undefined ||
      input.nextChargeAt !== undefined ||
      input.mandateEndsAt !== undefined,
    { error: 'Nothing to update: pass at least one field to change' },
  );
export type UpdateSubscriptionInput = z.input<typeof UpdateSubscriptionInputSchema>;
export type ParsedUpdateSubscriptionInput = z.output<typeof UpdateSubscriptionInputSchema>;

// ---------------------------------------------------------------------------
// Charges, pre-debit notifications, refunds
// ---------------------------------------------------------------------------

export const ChargeSchema = z.object({
  provider: ProviderSchema,
  /** The gateway's payment id (or your charge id where the gateway keys on that). */
  id: z.string(),
  /** Your own charge id, where one was supplied. */
  reference: z.string().optional(),
  subscriptionId: z.string().optional(),
  kind: ChargeKindSchema,
  status: ChargeStatusSchema,
  providerStatus: z.string().optional(),
  amount: PaiseSchema,
  currency: CurrencySchema.optional(),
  /** 1-based billing cycle number, where known. */
  cycle: z.number().int().optional(),
  scheduledAt: IsoDateTimeSchema.optional(),
  paidAt: IsoDateTimeSchema.optional(),
  failureCode: z.string().optional(),
  failureReason: z.string().optional(),
  paymentMethod: PaymentMethodSchema.optional(),
  refundedAmount: PaiseSchema.optional(),
  raw: z.unknown(),
});
export type Charge = z.infer<typeof ChargeSchema>;

/** A merchant-raised recurring debit, for gateways/plans the merchant schedules. */
export const CreateChargeInputSchema = z.object({
  subscriptionId: z.string().min(1),
  /**
   * Your unique id for this debit. Reusing an id must never debit twice, so
   * derive it from the subscription and cycle (the scheduler does).
   */
  chargeId: z.string().min(1).max(50),
  amount: PositivePaiseSchema,
  /** When to debit. Omit for the earliest the gateway allows. */
  scheduledAt: IsoDateTimeSchema.optional(),
  /** Invoice number shown to the customer where the gateway supports it. */
  invoiceNumber: z.string().min(1).max(50).optional(),
  description: z.string().max(200).optional(),
  customer: CustomerSchema.optional(),
  metadata: MetadataSchema.optional(),
});
export type CreateChargeInput = z.input<typeof CreateChargeInputSchema>;
export type ParsedCreateChargeInput = z.output<typeof CreateChargeInputSchema>;

/** The advance notice RBI rules require before debiting a mandate. */
export const NotifyChargeInputSchema = z.object({
  subscriptionId: z.string().min(1),
  /** Your unique id for this notification. */
  notificationId: z.string().min(1).max(50),
  amount: PositivePaiseSchema,
  /** The date the debit will be attempted. */
  debitAt: IsoDateTimeSchema,
  invoiceNumber: z.string().min(1).max(50).optional(),
});
export type NotifyChargeInput = z.input<typeof NotifyChargeInputSchema>;
export type ParsedNotifyChargeInput = z.output<typeof NotifyChargeInputSchema>;

export const ChargeNotificationSchema = z.object({
  provider: ProviderSchema,
  id: z.string(),
  subscriptionId: z.string(),
  /** True when the gateway accepted the notification for delivery. */
  accepted: z.boolean(),
  providerStatus: z.string().optional(),
  amount: PaiseSchema,
  debitAt: IsoDateTimeSchema,
  /** Carry this into the matching charge call where the gateway requires it. */
  invoiceNumber: z.string().optional(),
  raw: z.unknown(),
});
export type ChargeNotification = z.infer<typeof ChargeNotificationSchema>;

export const ListChargesOptionsSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
});
export type ListChargesOptions = z.input<typeof ListChargesOptionsSchema>;

export const RefundInputSchema = z.object({
  /** Required by gateways that scope payments under a subscription. */
  subscriptionId: z.string().min(1).optional(),
  chargeId: z.string().min(1),
  /** Your unique id for this refund. */
  refundId: z.string().min(1).max(40),
  /** Amount to refund in paise. Omit to refund the full charge. */
  amount: PositivePaiseSchema.optional(),
  reason: z.string().max(250).optional(),
});
export type RefundInput = z.input<typeof RefundInputSchema>;
export type ParsedRefundInput = z.output<typeof RefundInputSchema>;

export const RefundSchema = z.object({
  provider: ProviderSchema,
  id: z.string(),
  reference: z.string().optional(),
  chargeId: z.string(),
  subscriptionId: z.string().optional(),
  status: RefundStatusSchema,
  providerStatus: z.string().optional(),
  amount: PaiseSchema,
  currency: CurrencySchema.optional(),
  createdAt: IsoDateTimeSchema.optional(),
  raw: z.unknown(),
});
export type Refund = z.infer<typeof RefundSchema>;

// ---------------------------------------------------------------------------
// Checkout verification and webhooks
// ---------------------------------------------------------------------------

/**
 * The data the gateway hands back to the browser or return URL after the
 * customer authorises: Razorpay's checkout handler response, the parameters
 * PayU posts to `surl`/`furl`, or the Cashfree return URL query.
 */
export const CheckoutResultSchema = z.record(z.string(), z.unknown());
export type CheckoutResult = z.infer<typeof CheckoutResultSchema>;

export const CheckoutVerificationSchema = z.object({
  provider: ProviderSchema,
  /** The subscription id to store and use for later calls. */
  subscriptionId: z.string(),
  reference: z.string().optional(),
  /** True when the customer's authorisation succeeded. */
  authorized: z.boolean(),
  status: SubscriptionStatusSchema.optional(),
  charge: ChargeSchema.optional(),
  raw: z.unknown(),
});
export type CheckoutVerification = z.infer<typeof CheckoutVerificationSchema>;

export const WebhookRequestSchema = z.object({
  /** The exact bytes of the request body as a string. Do not re-serialise parsed JSON. */
  rawBody: z.string(),
  headers: z.record(z.string(), z.union([z.string(), z.array(z.string())]).optional()),
});
export type WebhookRequest = z.infer<typeof WebhookRequestSchema>;

export const SubscriptionEventSchema = z.object({
  /** Stable id for de-duplication: gateways deliver the same event more than once. */
  id: z.string(),
  provider: ProviderSchema,
  type: EventTypeSchema,
  /** The gateway's own event name, verbatim. */
  providerEventType: z.string(),
  occurredAt: IsoDateTimeSchema.optional(),
  subscriptionId: z.string().optional(),
  subscription: SubscriptionSchema.optional(),
  charge: ChargeSchema.optional(),
  refund: RefundSchema.optional(),
  raw: z.unknown(),
});
export type SubscriptionEvent = z.infer<typeof SubscriptionEventSchema>;

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/** What a gateway adapter can do, so callers never have to guess. */
export const CapabilitiesSchema = z.object({
  provider: ProviderSchema,
  /** Scheduling modes available; the first is the default. */
  scheduling: z.array(SchedulingModeSchema).min(1),
  /** The gateway stores plan objects (otherwise plans exist only in your code). */
  gatewayPlans: z.boolean(),
  trial: z.boolean(),
  upfrontAmount: z.boolean(),
  quantity: z.boolean(),
  pause: z.boolean(),
  resume: z.boolean(),
  cancelAtPeriodEnd: z.boolean(),
  changePlan: z.boolean(),
  /** The merchant can raise debits itself (`createCharge`). */
  merchantCharges: z.boolean(),
  /** The merchant must send the pre-debit notification itself (`notifyCharge`). */
  merchantPreDebitNotification: z.boolean(),
  /**
   * Hours before the debit date by which a merchant-raised charge must be
   * created (with `scheduledAt` set), for gateways that send the pre-debit
   * notification themselves once the charge exists. Absent or 0 means a
   * charge can be raised on the due date itself.
   */
  merchantChargeLeadHours: z.number().int().nonnegative().optional(),
  /** Furthest ahead, in hours, that a merchant-raised charge may be scheduled. */
  merchantChargeMaxAheadHours: z.number().int().positive().optional(),
  listCharges: z.boolean(),
  refunds: z.boolean(),
  /** Webhooks carry a signature this library verifies. */
  signedWebhooks: z.boolean(),
  idempotencyKeys: z.boolean(),
  paymentMethods: z.array(PaymentMethodSchema),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;
