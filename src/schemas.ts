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
 *
 * Explanations are schema metadata (`.describe(...)`), not comments, because
 * only metadata reaches the OpenAPI document and the generated clients.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const ProviderSchema = z.enum(Provider).describe('A supported payment gateway.');
export const CurrencySchema = z.enum(Currency).describe('ISO 4217 currency code. Only INR is supported.');
export const SubscriptionStatusSchema = z
  .enum(SubscriptionStatus)
  .describe(
    'Normalised subscription lifecycle. Each gateway\'s own status is preserved verbatim in `providerStatus`. ' +
      '`cancelled`, `completed`, `expired` and `failed` are terminal.',
  );
export const ChargeStatusSchema = z.enum(ChargeStatus).describe('Normalised status of a charge (one debit).');
export const ChargeKindSchema = z
  .enum(ChargeKind)
  .describe(
    '`authorization` is the small verification debit taken when the mandate is set up, `recurring` is a debit for ' +
      'a billing cycle, `upfront` is a one-off amount such as a setup fee or add-on.',
  );
export const RefundStatusSchema = z.enum(RefundStatus).describe('Status of a refund.');
export const PaymentMethodSchema = z
  .enum(PaymentMethod)
  .describe(
    '`upi` is a UPI Autopay mandate, `card` a card standing instruction, `enach` an eNACH e-mandate on a bank ' +
      'account, `physical_nach` a paper NACH mandate.',
  );
export const SchedulingModeSchema = z
  .enum(SchedulingMode)
  .describe(
    'Who decides when each recurring debit happens: `gateway` raises every charge on the plan\'s schedule, ' +
      '`merchant` means the merchant (this library\'s scheduler) raises each charge.',
  );
export const EventTypeSchema = z
  .enum(EventType)
  .describe('Normalised webhook / lifecycle event. `unknown` is a verified event this library does not normalise; inspect `raw`.');
export const EnvironmentSchema = z.enum(Environment).describe('`test` is the gateway sandbox, `live` is real money.');
export const IntervalUnitSchema = z.enum(IntervalUnit).describe('Unit of a billing interval.');
export const CancelModeSchema = z
  .enum(CancelMode)
  .describe('`immediately` stops now with no further charges; `at_period_end` keeps the current paid period, then stops.');
export const ChangeTimingSchema = z
  .enum(ChangeTiming)
  .describe('When a subscription change takes effect: `immediately`, or `at_period_end` (the next cycle boundary).');
export const CheckoutKindSchema = z
  .enum(CheckoutKind)
  .describe('How the customer\'s browser or app completes mandate authorisation; the `kind` of a `CheckoutInstruction`.');

export const PaiseSchema = z.number().int().nonnegative().describe('A non-negative integer amount in paise.');
export type Paise = z.infer<typeof PaiseSchema>;

export const PositivePaiseSchema = z.number().int().positive().describe('A strictly positive integer amount in paise.');

export const IsoDateTimeSchema = z.iso
  .datetime({ offset: true })
  .describe('An ISO-8601 instant with a timezone offset or `Z`.');
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

export const MetadataSchema = z
  .record(z.string(), z.string())
  .describe('Free-form string key/value pairs stored with the object where the gateway supports it.');
export type Metadata = z.infer<typeof MetadataSchema>;

/** The untouched gateway payload. Optional: JSON drops `undefined`, so a client may not receive it. */
function rawField(what: string) {
  return z.unknown().optional().describe(what);
}
const RAW_RESPONSE = 'The gateway\'s response, untouched. Absent when the gateway returned no body.';

export const BillingIntervalSchema = z
  .object({
    unit: IntervalUnitSchema.describe('The unit of the interval.'),
    count: z
      .number()
      .int()
      .min(1)
      .describe('Bill every `count` units: `{ unit: \'month\', count: 3 }` is quarterly.'),
  })
  .describe('How often a plan bills.');
export type BillingInterval = z.infer<typeof BillingIntervalSchema>;

export const CustomerSchema = z
  .object({
    id: z.string().min(1).optional().describe('The gateway\'s customer id, where one exists.'),
    name: z.string().min(1).optional().describe('The customer\'s name.'),
    email: z.email().optional().describe('The customer\'s e-mail address.'),
    phone: z
      .string()
      .regex(/^\+?[0-9]{10,15}$/)
      .optional()
      .describe('Mobile number; 10 digits or E.164. Adapters format it for their gateway.'),
  })
  .describe('A customer: identity and contact details.');
export type Customer = z.infer<typeof CustomerSchema>;

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export const CreatePlanInputSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(40)
      .optional()
      .describe('Your own plan id. Used where the gateway lets the merchant choose the id; ignored where the gateway generates one.'),
    name: z.string().min(1).max(100).describe('Plan name.'),
    description: z.string().max(500).optional().describe('Plan description.'),
    amount: PositivePaiseSchema.describe('Amount charged every cycle, in paise.'),
    currency: CurrencySchema.default(Currency.INR).describe('Currency of the plan. Defaults to INR.'),
    interval: BillingIntervalSchema.describe('How often the plan bills.'),
    scheduling: SchedulingModeSchema.optional().describe('Who raises each charge. Defaults to the gateway\'s native mode.'),
    maxAmount: PositivePaiseSchema.optional().describe(
      'Ceiling the mandate allows per debit, in paise. Defaults to `amount`. Set it higher to leave room for upgrades or add-ons.',
    ),
    maxCycles: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Number of cycles after which the plan ends. Omit for open-ended.'),
    metadata: MetadataSchema.optional().describe('Free-form key/value pairs stored with the plan.'),
  })
  .refine((plan) => plan.maxAmount === undefined || plan.maxAmount >= plan.amount, {
    error: 'maxAmount must be at least amount: the mandate ceiling cannot be below the recurring charge',
    path: ['maxAmount'],
  })
  .describe('Details of a billing plan to create.');
export type CreatePlanInput = z.input<typeof CreatePlanInputSchema>;
export type ParsedCreatePlanInput = z.output<typeof CreatePlanInputSchema>;

export const PlanSchema = z
  .object({
    provider: ProviderSchema.describe('The gateway that holds the plan.'),
    id: z.string().describe('The plan id to pass back to this library.'),
    name: z.string().describe('Plan name.'),
    description: z.string().optional().describe('Plan description.'),
    amount: PaiseSchema.describe('Amount charged every cycle, in paise.'),
    currency: CurrencySchema.describe('Currency of the plan.'),
    interval: BillingIntervalSchema.optional().describe('How often the plan bills, where known.'),
    scheduling: SchedulingModeSchema.describe('Who raises each charge.'),
    maxAmount: PaiseSchema.optional().describe('Ceiling the mandate allows per debit, in paise.'),
    maxCycles: z.number().int().optional().describe('Number of cycles after which the plan ends, where limited.'),
    providerStatus: z.string().optional().describe('The gateway\'s own plan status, verbatim, where it has one.'),
    createdAt: IsoDateTimeSchema.optional().describe('When the plan was created.'),
    metadata: MetadataSchema.optional().describe('Key/value pairs stored with the plan.'),
    raw: rawField(RAW_RESPONSE),
  })
  .describe('A billing plan.');
export type Plan = z.infer<typeof PlanSchema>;

// ---------------------------------------------------------------------------
// Checkout (mandate authorisation by the customer)
// ---------------------------------------------------------------------------

export const RedirectCheckoutSchema = z
  .object({
    kind: z.literal(CheckoutKind.Redirect).describe('Discriminator: send the customer to `url`.'),
    url: z.url().describe('The page to send the customer to.'),
  })
  .describe('Authorise by redirecting the customer to a URL.');

export const FormPostCheckoutSchema = z
  .object({
    kind: z.literal(CheckoutKind.FormPost).describe('Discriminator: auto-submit an HTML form to `url`.'),
    url: z.url().describe('The URL the form is posted to.'),
    fields: z
      .record(z.string(), z.string())
      .describe('Post these fields exactly as given; they are covered by a hash.'),
  })
  .describe('Authorise by auto-submitting an HTML form to the gateway.');

export const RazorpayCheckoutSchema = z
  .object({
    kind: z.literal(CheckoutKind.RazorpayCheckout).describe('Discriminator: open Razorpay Standard Checkout.'),
    keyId: z.string().describe('The Razorpay key id to open Checkout with.'),
    subscriptionId: z.string().describe('The Razorpay subscription id to authorise.'),
    hostedUrl: z.url().optional().describe('Razorpay-hosted authorisation page, usable instead of the JS checkout.'),
    callbackUrl: z
      .url()
      .optional()
      .describe('Where Razorpay Checkout redirects after authorisation (its `callback_url` option).'),
    prefill: CustomerSchema.optional().describe('Customer details to prefill in the checkout form.'),
  })
  .describe('Authorise with Razorpay Standard Checkout.');

export const CashfreeCheckoutSchema = z
  .object({
    kind: z.literal(CheckoutKind.CashfreeCheckout).describe('Discriminator: call Cashfree.js `subscriptionsCheckout`.'),
    sessionId: z.string().describe('The subscription session id to pass to Cashfree.js.'),
    environment: EnvironmentSchema.describe('Which Cashfree environment to initialise Cashfree.js with.'),
  })
  .describe('Authorise with Cashfree.js `subscriptionsCheckout`.');

export const CheckoutInstructionSchema = z
  .discriminatedUnion('kind', [
    RedirectCheckoutSchema,
    FormPostCheckoutSchema,
    RazorpayCheckoutSchema,
    CashfreeCheckoutSchema,
  ])
  .describe('What the customer\'s browser or app must do to authorise the mandate; branch on `kind`.');
export type CheckoutInstruction = z.infer<typeof CheckoutInstructionSchema>;

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export const TrialSchema = z
  .object({
    days: z.number().int().positive().optional().describe('Trial length in days from now.'),
    endsAt: IsoDateTimeSchema.optional().describe('Or an exact instant at which the trial ends.'),
  })
  .refine((trial) => (trial.days === undefined) !== (trial.endsAt === undefined), {
    error: 'trial needs exactly one of days or endsAt',
  })
  .describe('Free trial: the mandate is set up now, the first charge happens when the trial ends. Pass exactly one of `days` or `endsAt`.');
export type Trial = z.infer<typeof TrialSchema>;

export const CreateSubscriptionInputSchema = z
  .object({
    reference: z
      .string()
      .min(1)
      .max(60)
      .optional()
      .describe(
        'Your own id for this subscription. Sent to the gateway where it accepts a merchant reference, and echoed back on `Subscription.reference`.',
      ),
    plan: z
      .union([z.string().min(1), CreatePlanInputSchema])
      .describe('An existing plan id, or plan details to create inline.'),
    customer: CustomerSchema.describe('The paying customer.'),
    quantity: z.number().int().positive().optional().describe('Units of the plan billed each cycle. Defaults to 1.'),
    totalCycles: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Total number of recurring charges. Omit to bill until cancelled, where the gateway allows.'),
    trial: TrialSchema.optional().describe('Free trial. Mutually exclusive with `startAt`.'),
    startAt: IsoDateTimeSchema.optional().describe('Delay the first recurring charge to this instant without calling it a trial.'),
    upfrontAmount: PositivePaiseSchema.optional().describe(
      'One-off amount collected together with the authorisation (setup fee or first payment), in paise.',
    ),
    upfrontLabel: z.string().min(1).max(100).optional().describe('Label shown to the customer for the upfront amount.'),
    paymentMethods: z
      .array(PaymentMethodSchema)
      .min(1)
      .optional()
      .describe('Restrict the mandate to these payment methods. Omit to allow all the gateway supports.'),
    authorizeBy: IsoDateTimeSchema.optional().describe('Deadline for the customer to authorise the mandate.'),
    mandateEndsAt: IsoDateTimeSchema.optional().describe('When the mandate itself should lapse.'),
    returnUrl: z.url().optional().describe('Where the gateway sends the customer after authorisation.'),
    notifyCustomer: z.boolean().optional().describe('Let the gateway send its own SMS/email to the customer.'),
    metadata: MetadataSchema.optional().describe('Free-form key/value pairs stored with the subscription.'),
    idempotencyKey: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe('Makes the create call safe to retry, where the gateway supports idempotency keys.'),
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
  .describe('Everything needed to create a subscription.');
export type CreateSubscriptionInput = z.input<typeof CreateSubscriptionInputSchema>;
export type ParsedCreateSubscriptionInput = z.output<typeof CreateSubscriptionInputSchema>;

export const SubscriptionSchema = z
  .object({
    provider: ProviderSchema.describe('The gateway that holds the subscription.'),
    id: z.string().describe('The identifier to pass back to this library for every later call.'),
    reference: z.string().optional().describe('Your own reference, where one was supplied.'),
    planId: z.string().optional().describe('The plan the subscription bills.'),
    status: SubscriptionStatusSchema.describe('Normalised lifecycle status.'),
    providerStatus: z.string().describe('The gateway\'s own status, verbatim.'),
    scheduling: SchedulingModeSchema.describe('Who raises each charge.'),
    customer: CustomerSchema.optional().describe('The paying customer, where known.'),
    quantity: z.number().int().optional().describe('Units of the plan billed each cycle.'),
    amount: PaiseSchema.optional().describe('Recurring amount per cycle in paise, where known.'),
    maxAmount: PaiseSchema.optional().describe('Mandate ceiling per debit in paise, where known.'),
    currency: CurrencySchema.optional().describe('Currency of the subscription.'),
    interval: BillingIntervalSchema.optional().describe('How often the subscription bills, where known.'),
    totalCycles: z.number().int().optional().describe('Total number of recurring charges, where limited.'),
    paidCycles: z.number().int().optional().describe('Number of cycles collected so far.'),
    remainingCycles: z.number().int().optional().describe('Number of cycles still to collect, where limited.'),
    createdAt: IsoDateTimeSchema.optional().describe('When the subscription was created.'),
    startAt: IsoDateTimeSchema.optional().describe('When the first recurring charge is or was due.'),
    trialEndsAt: IsoDateTimeSchema.optional().describe(
      'Set while `status` is `trialing`: when the trial ends and the first charge is due.',
    ),
    currentPeriodStart: IsoDateTimeSchema.optional().describe('Start of the current billing period.'),
    currentPeriodEnd: IsoDateTimeSchema.optional().describe('End of the current billing period.'),
    nextChargeAt: IsoDateTimeSchema.optional().describe('When the next charge is due.'),
    endedAt: IsoDateTimeSchema.optional().describe('When the subscription ended, if it did.'),
    mandateEndsAt: IsoDateTimeSchema.optional().describe('When the mandate lapses.'),
    cancelAtPeriodEnd: z
      .boolean()
      .optional()
      .describe('True when a cancellation is scheduled for the end of the current period.'),
    paymentMethod: PaymentMethodSchema.optional().describe('The payment method the mandate was authorised with.'),
    checkout: CheckoutInstructionSchema.optional().describe(
      'Present on freshly created subscriptions: what the customer must do to authorise.',
    ),
    metadata: MetadataSchema.optional().describe('Key/value pairs stored with the subscription.'),
    raw: rawField(RAW_RESPONSE),
  })
  .describe('A subscription (a recurring-payment mandate) at a gateway.');
export type Subscription = z.infer<typeof SubscriptionSchema>;

export const CancelSubscriptionOptionsSchema = z
  .object({
    mode: CancelModeSchema.default(CancelMode.Immediately).describe('When the cancellation takes effect. Defaults to `immediately`.'),
  })
  .describe('Options for cancelling a subscription.');
export type CancelSubscriptionOptions = z.input<typeof CancelSubscriptionOptionsSchema>;

export const PauseSubscriptionOptionsSchema = z
  .object({
    resumeAt: IsoDateTimeSchema.optional().describe('Resume automatically at this instant, where the gateway supports it.'),
  })
  .describe('Options for pausing a subscription.');
export type PauseSubscriptionOptions = z.input<typeof PauseSubscriptionOptionsSchema>;

export const ResumeSubscriptionOptionsSchema = z
  .object({
    nextChargeAt: IsoDateTimeSchema.optional().describe(
      'Date of the next charge after resuming, where the gateway needs one.',
    ),
  })
  .describe('Options for resuming a paused subscription.');
export type ResumeSubscriptionOptions = z.input<typeof ResumeSubscriptionOptionsSchema>;

export const UpdateSubscriptionInputSchema = z
  .object({
    planId: z.string().min(1).optional().describe('Move to another plan (upgrade or downgrade).'),
    quantity: z.number().int().positive().optional().describe('New number of units billed each cycle.'),
    remainingCycles: z.number().int().positive().optional().describe('New number of cycles still to collect.'),
    amount: PositivePaiseSchema.optional().describe('New amount per cycle in paise, for mandates that are not plan-based.'),
    nextChargeAt: IsoDateTimeSchema.optional().describe('Move the next charge date.'),
    mandateEndsAt: IsoDateTimeSchema.optional().describe('New mandate end date.'),
    timing: ChangeTimingSchema.default(ChangeTiming.Immediately).describe(
      'When the change takes effect. Defaults to `immediately`.',
    ),
    notifyCustomer: z.boolean().optional().describe('Let the gateway notify the customer of the change.'),
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
  )
  .describe('Changes to make to a subscription. Pass at least one field to change.');
export type UpdateSubscriptionInput = z.input<typeof UpdateSubscriptionInputSchema>;
export type ParsedUpdateSubscriptionInput = z.output<typeof UpdateSubscriptionInputSchema>;

// ---------------------------------------------------------------------------
// Charges, pre-debit notifications, refunds
// ---------------------------------------------------------------------------

export const ChargeSchema = z
  .object({
    provider: ProviderSchema.describe('The gateway that holds the charge.'),
    id: z
      .string()
      .describe('The gateway\'s payment id (or your charge id where the gateway keys on that).'),
    reference: z.string().optional().describe('Your own charge id, where one was supplied.'),
    subscriptionId: z.string().optional().describe('The subscription the charge belongs to.'),
    kind: ChargeKindSchema.describe('What the debit is for.'),
    status: ChargeStatusSchema.describe('Normalised charge status.'),
    providerStatus: z.string().optional().describe('The gateway\'s own status, verbatim.'),
    amount: PaiseSchema.describe('Amount of the debit in paise.'),
    currency: CurrencySchema.optional().describe('Currency of the debit.'),
    cycle: z.number().int().optional().describe('1-based billing cycle number, where known.'),
    scheduledAt: IsoDateTimeSchema.optional().describe('When the debit is or was scheduled.'),
    paidAt: IsoDateTimeSchema.optional().describe('When the debit succeeded.'),
    failureCode: z.string().optional().describe('The gateway\'s failure code, where the debit failed.'),
    failureReason: z.string().optional().describe('Human-readable reason the debit failed.'),
    paymentMethod: PaymentMethodSchema.optional().describe('The payment method the debit used.'),
    refundedAmount: PaiseSchema.optional().describe('Amount refunded so far, in paise.'),
    raw: rawField(RAW_RESPONSE),
  })
  .describe('One debit against a mandate.');
export type Charge = z.infer<typeof ChargeSchema>;

export const CreateChargeInputSchema = z
  .object({
    subscriptionId: z.string().min(1).describe('The subscription to debit.'),
    chargeId: z
      .string()
      .min(1)
      .max(50)
      .describe(
        'Your unique id for this debit. Reusing an id must never debit twice, so derive it from the subscription and cycle (the scheduler does).',
      ),
    amount: PositivePaiseSchema.describe('Amount to debit, in paise.'),
    scheduledAt: IsoDateTimeSchema.optional().describe('When to debit. Omit for the earliest the gateway allows.'),
    invoiceNumber: z
      .string()
      .min(1)
      .max(50)
      .optional()
      .describe('Invoice number shown to the customer where the gateway supports it.'),
    description: z.string().max(200).optional().describe('Description of the debit.'),
    customer: CustomerSchema.optional().describe('The paying customer.'),
    metadata: MetadataSchema.optional().describe('Free-form key/value pairs stored with the charge.'),
  })
  .describe('A merchant-raised recurring debit, for gateways/plans the merchant schedules.');
export type CreateChargeInput = z.input<typeof CreateChargeInputSchema>;
export type ParsedCreateChargeInput = z.output<typeof CreateChargeInputSchema>;

export const NotifyChargeInputSchema = z
  .object({
    subscriptionId: z.string().min(1).describe('The subscription that will be debited.'),
    notificationId: z.string().min(1).max(50).describe('Your unique id for this notification.'),
    amount: PositivePaiseSchema.describe('Amount that will be debited, in paise.'),
    debitAt: IsoDateTimeSchema.describe('The date the debit will be attempted.'),
    invoiceNumber: z.string().min(1).max(50).optional().describe('Invoice number to show the customer.'),
  })
  .describe('The advance notice RBI rules require before debiting a mandate.');
export type NotifyChargeInput = z.input<typeof NotifyChargeInputSchema>;
export type ParsedNotifyChargeInput = z.output<typeof NotifyChargeInputSchema>;

export const ChargeNotificationSchema = z
  .object({
    provider: ProviderSchema.describe('The gateway that holds the notification.'),
    id: z.string().describe('The notification id.'),
    subscriptionId: z.string().describe('The subscription that will be debited.'),
    accepted: z.boolean().describe('True when the gateway accepted the notification for delivery.'),
    providerStatus: z.string().optional().describe('The gateway\'s own status, verbatim.'),
    amount: PaiseSchema.describe('Amount that will be debited, in paise.'),
    debitAt: IsoDateTimeSchema.describe('The date the debit will be attempted.'),
    invoiceNumber: z
      .string()
      .optional()
      .describe('Carry this into the matching charge call where the gateway requires it.'),
    raw: rawField(RAW_RESPONSE),
  })
  .describe('The result of sending a pre-debit notification.');
export type ChargeNotification = z.infer<typeof ChargeNotificationSchema>;

export const ListChargesOptionsSchema = z
  .object({
    limit: z.number().int().min(1).max(100).optional().describe('Most charges to return.'),
  })
  .describe('Options for listing the charges of a subscription.');
export type ListChargesOptions = z.input<typeof ListChargesOptionsSchema>;

export const RefundInputSchema = z
  .object({
    subscriptionId: z
      .string()
      .min(1)
      .optional()
      .describe('Required by gateways that scope payments under a subscription.'),
    chargeId: z.string().min(1).describe('The charge to refund.'),
    refundId: z.string().min(1).max(40).describe('Your unique id for this refund.'),
    amount: PositivePaiseSchema.optional().describe('Amount to refund in paise. Omit to refund the full charge.'),
    reason: z.string().max(250).optional().describe('Why the charge is refunded.'),
  })
  .describe('A refund of a charge.');
export type RefundInput = z.input<typeof RefundInputSchema>;
export type ParsedRefundInput = z.output<typeof RefundInputSchema>;

export const RefundSchema = z
  .object({
    provider: ProviderSchema.describe('The gateway that holds the refund.'),
    id: z.string().describe('The gateway\'s refund id.'),
    reference: z.string().optional().describe('Your own refund id, where one was supplied.'),
    chargeId: z.string().describe('The charge that was refunded.'),
    subscriptionId: z.string().optional().describe('The subscription the charge belongs to.'),
    status: RefundStatusSchema.describe('Normalised refund status.'),
    providerStatus: z.string().optional().describe('The gateway\'s own status, verbatim.'),
    amount: PaiseSchema.describe('Amount refunded, in paise.'),
    currency: CurrencySchema.optional().describe('Currency of the refund.'),
    createdAt: IsoDateTimeSchema.optional().describe('When the refund was created.'),
    raw: rawField(RAW_RESPONSE),
  })
  .describe('A refund of a charge.');
export type Refund = z.infer<typeof RefundSchema>;

// ---------------------------------------------------------------------------
// Checkout verification and webhooks
// ---------------------------------------------------------------------------

export const CheckoutResultSchema = z
  .record(z.string(), z.unknown())
  .describe(
    'The data the gateway hands back to the browser or return URL after the customer authorises: Razorpay\'s checkout handler ' +
      'response, the parameters PayU posts to `surl`/`furl`, or the Cashfree return URL query. Pass it on untouched.',
  );
export type CheckoutResult = z.infer<typeof CheckoutResultSchema>;

export const VerifyCheckoutInputSchema = z
  .object({
    result: CheckoutResultSchema.describe('The fields the gateway handed back to the browser or return URL, untouched.'),
    expectedSubscriptionId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'The subscription id (or your reference) that your server stored when it created the subscription. When given, a ' +
          'result that verifies but belongs to a different subscription is rejected, so a customer cannot replay the ' +
          'authorisation of one subscription to unlock another.',
      ),
  })
  .describe('What the HTTP service and the facade accept when verifying a checkout result.');
export type VerifyCheckoutInput = z.infer<typeof VerifyCheckoutInputSchema>;

export const CheckoutVerificationSchema = z
  .object({
    provider: ProviderSchema.describe('The gateway that issued the result.'),
    subscriptionId: z.string().describe('The subscription id to store and use for later calls.'),
    reference: z.string().optional().describe('Your own reference for the subscription, where known.'),
    authorized: z.boolean().describe('True when the customer\'s authorisation succeeded.'),
    status: SubscriptionStatusSchema.optional().describe('The subscription status the result implies, where known.'),
    charge: ChargeSchema.optional().describe('The authorisation or upfront charge, where the result carries one.'),
    raw: rawField('The verified gateway data, untouched. Absent when there is none.'),
  })
  .describe('The outcome of verifying a checkout result.');
export type CheckoutVerification = z.infer<typeof CheckoutVerificationSchema>;

export const WebhookRequestSchema = z
  .object({
    rawBody: z
      .string()
      .describe('The exact bytes of the request body as a string. Do not re-serialise parsed JSON.'),
    headers: z
      .record(z.string(), z.union([z.string(), z.array(z.string())]).optional())
      .describe('The request headers, with lower-case names.'),
  })
  .describe('A webhook request as received from a gateway.');
export type WebhookRequest = z.infer<typeof WebhookRequestSchema>;

export const SubscriptionEventSchema = z
  .object({
    id: z
      .string()
      .describe('Stable id for de-duplication: gateways deliver the same event more than once.'),
    provider: ProviderSchema.describe('The gateway that sent the event.'),
    type: EventTypeSchema.describe('Normalised event type.'),
    providerEventType: z.string().describe('The gateway\'s own event name, verbatim.'),
    occurredAt: IsoDateTimeSchema.optional().describe('When the event happened, where the gateway says.'),
    subscriptionId: z.string().optional().describe('The subscription the event is about.'),
    subscription: SubscriptionSchema.optional().describe('The subscription, where the event carries it.'),
    charge: ChargeSchema.optional().describe('The charge, where the event carries it.'),
    refund: RefundSchema.optional().describe('The refund, where the event carries it.'),
    raw: rawField('The gateway\'s webhook payload, untouched. Absent when there is none.'),
  })
  .describe('A verified, normalised webhook event.');
export type SubscriptionEvent = z.infer<typeof SubscriptionEventSchema>;

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export const CapabilitiesSchema = z
  .object({
    provider: ProviderSchema.describe('The gateway these capabilities describe.'),
    scheduling: z
      .array(SchedulingModeSchema)
      .min(1)
      .describe('Scheduling modes available; the first is the default.'),
    gatewayPlans: z
      .boolean()
      .describe('The gateway stores plan objects (otherwise plans exist only in your code).'),
    trial: z.boolean().describe('Free trials are supported.'),
    upfrontAmount: z.boolean().describe('An upfront amount can be collected with the authorisation.'),
    quantity: z.boolean().describe('A subscription can bill several units of a plan.'),
    pause: z.boolean().describe('A subscription can be paused.'),
    resume: z.boolean().describe('A paused subscription can be resumed.'),
    cancelAtPeriodEnd: z.boolean().describe('A subscription can be cancelled at the end of the paid period.'),
    changePlan: z.boolean().describe('A subscription can move to another plan.'),
    merchantCharges: z.boolean().describe('The merchant can raise debits itself (`createCharge`).'),
    merchantPreDebitNotification: z
      .boolean()
      .describe('The merchant must send the pre-debit notification itself (`notifyCharge`).'),
    merchantChargeLeadHours: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'Hours before the debit date by which a merchant-raised charge must be created (with `scheduledAt` set), for ' +
          'gateways that send the pre-debit notification themselves once the charge exists. Absent or 0 means a charge ' +
          'can be raised on the due date itself.',
      ),
    merchantChargeMaxAheadHours: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Furthest ahead, in hours, that a merchant-raised charge may be scheduled.'),
    listCharges: z.boolean().describe('The charges of a subscription can be listed.'),
    refunds: z.boolean().describe('Charges can be refunded.'),
    signedWebhooks: z.boolean().describe('Webhooks carry a signature this library verifies.'),
    idempotencyKeys: z.boolean().describe('Create calls accept an idempotency key.'),
    paymentMethods: z.array(PaymentMethodSchema).describe('The payment methods mandates can be authorised with.'),
  })
  .describe('What a gateway adapter can do, so callers never have to guess.');
export type Capabilities = z.infer<typeof CapabilitiesSchema>;
