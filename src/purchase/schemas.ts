import { z } from 'zod';
import { ChannelPolicy, ErrorCode, GATEWAY_ID_PATTERN, MAX_GATEWAY_ID_LENGTH } from '../constants.js';
import { RoutingDecisionSchema } from '../routing/schemas.js';
import {
  BillingIntervalSchema,
  CheckoutInstructionSchema,
  CheckoutResultSchema,
  CustomerSchema,
  ExternalTransactionRefundSchema,
  ExternalTransactionReportSchema,
  IsoDateTimeSchema,
  MetadataSchema,
  PaiseSchema,
  PaymentMethodSchema,
  PlatformSchema,
  PositivePaiseSchema,
  ProductKindSchema,
  ProviderSchema,
  SalesChannelSchema,
  SchedulingModeSchema,
  StoreProductSchema,
} from '../schemas.js';
import {
  AttemptOutcome,
  EntitlementStatus,
  FlushOutcome,
  ReportKind,
  ReportStatus,
  SessionStatus,
} from './constants.js';

/**
 * Schemas of purchase sessions, platform policy, entitlements and the report queue. Every field carries a
 * `describe()` because these schemas are published in the OpenAPI document.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const SessionStatusSchema = z
  .enum(SessionStatus)
  .describe(
    '`open` (the customer has not come back from checkout), `awaiting_payment` (paid or approved but not confirmed yet, ' +
      'or the gateway checkout of a user choice billing purchase is under way), `completed`, `failed` (a verification ' +
      'said not paid; a later payment still completes it) or `expired` (a payment confirmed afterwards still completes it).',
  );

export const EntitlementStatusSchema = z
  .enum(EntitlementStatus)
  .describe(
    '`active`, `trialing` and `past_due` give access; `paused`, `halted`, `cancelled`, `expired` and `refunded` do not. ' +
      'A subscription cancelled at the end of its period stays `active` with `cancelAtPeriodEnd` set until the period ends.',
  );

export const ReportKindSchema = z
  .enum(ReportKind)
  .describe('`transaction` reports a purchase, a free trial or a renewal to Google; `refund` reports a refund.');

export const ReportStatusSchema = z
  .enum(ReportStatus)
  .describe('`queued` (waiting to be sent), `sent` (Google accepted it) or `rejected` (Google refused it as invalid; never retried).');

export const FlushOutcomeSchema = z
  .enum(FlushOutcome)
  .describe(
    'What a flush did with a report: `sent`, `retrying` (failed, tried again after a backoff), `blocked` (waiting for the ' +
      'report it refers to), `rejected` (invalid, never retried) or `no_reporter` (nothing configured to send with).',
  );

export const AttemptOutcomeSchema = z.enum(AttemptOutcome).describe('`created` or `failed`.');

// ---------------------------------------------------------------------------
// Catalog and policy
// ---------------------------------------------------------------------------

export const ProductPlanSchema = z
  .object({
    description: z.string().max(500).optional().describe('Plan description.'),
    scheduling: SchedulingModeSchema.optional().describe('Who raises each charge. Defaults to the gateway\'s native mode.'),
    maxAmount: PositivePaiseSchema.optional().describe(
      'Ceiling the mandate allows per debit, in paise. Defaults to the product `amount`.',
    ),
    maxCycles: z.number().int().positive().optional().describe('Number of cycles after which the plan ends. Omit for open-ended.'),
    metadata: MetadataSchema.optional().describe('Free-form key/value pairs stored with the plan.'),
  })
  .describe(
    'Extra plan fields passed to a gateway when a subscription of the product is created. The name, amount and interval ' +
      'come from the product.',
  );
export type ProductPlan = z.infer<typeof ProductPlanSchema>;

export const ProductSchema = z
  .object({
    key: z.string().min(1).max(60).describe('Your product key. Purchases, sessions and entitlements refer to it.'),
    kind: ProductKindSchema.describe('`subscription` or `one_time`.'),
    name: z.string().min(1).max(100).describe('Product name, shown to the customer by the gateways.'),
    amount: PositivePaiseSchema.describe('Price on gateways in paise, tax included.'),
    interval: BillingIntervalSchema.optional().describe('How often a subscription bills. Required for subscriptions.'),
    trialDays: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Free trial length in days on gateways (only gateways that support trials are chosen). Stores use their own offers.'),
    taxRateBps: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'Tax included in `amount`, in basis points (1800 is 18%). Required for products sold through Google Play user ' +
          'choice billing: reports to Google split the charge into a pre-tax amount and tax.',
      ),
    physicalGoods: z
      .boolean()
      .optional()
      .describe('True: the product is never sold through app store billing and goes to the gateways on every platform.'),
    platforms: z
      .array(PlatformSchema)
      .min(1)
      .optional()
      .describe('The platforms the product is sold on. Omit for all of them.'),
    paymentMethods: z
      .array(PaymentMethodSchema)
      .min(1)
      .optional()
      .describe(
        'Restrict gateway purchases of the product to these payment methods. Only gateways that offer one of them are ' +
          'chosen, and the gateway is told to offer only these. Omit to allow every method the gateway supports.',
      ),
    appStore: StoreProductSchema.optional().describe('The product in App Store Connect. Required to sell on iOS.'),
    googlePlay: StoreProductSchema.optional().describe(
      'The product in Play Console. Required to sell on Android when the policy is `store` or `user_choice`.',
    ),
    plan: ProductPlanSchema.optional().describe('Extra plan fields for gateway subscriptions, such as `maxAmount`.'),
  })
  .describe('A product you sell, with its price and where it lives in each store.');
export type Product = z.infer<typeof ProductSchema>;

export const PlatformPolicySchema = z
  .object({
    ios: z
      .literal(ChannelPolicy.Store)
      .default(ChannelPolicy.Store)
      .describe('iOS: App Store only.'),
    android: z
      .enum([ChannelPolicy.Store, ChannelPolicy.UserChoice, ChannelPolicy.Gateways])
      .default(ChannelPolicy.Store)
      .describe(
        'Android: `store` (Google Play only), `user_choice` (Google Play with its choice screen offering a gateway, ' +
          'reported to Google) or `gateways` (apps distributed outside Google Play).',
      ),
    web: z
      .literal(ChannelPolicy.Gateways)
      .default(ChannelPolicy.Gateways)
      .describe('Web: payment gateways only.'),
  })
  .describe('Where purchases on each platform may be taken.');
export type PlatformPolicy = z.output<typeof PlatformPolicySchema>;
export type PlatformPolicyInput = z.input<typeof PlatformPolicySchema>;

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const PurchaseOptionSchema = z
  .object({
    channel: SalesChannelSchema.describe('`store` for an app store, `gateway` for a payment gateway.'),
    provider: ProviderSchema.describe('The provider that holds the purchase.'),
    checkout: CheckoutInstructionSchema.describe('What the browser or device must do to pay.'),
    handle: z
      .string()
      .describe(
        'The id the provider returned when the purchase was created: the id to expect back from the checkout. ' +
          'For a store it is the account token.',
      ),
    routing: RoutingDecisionSchema.optional().describe('Why this gateway was chosen. Present on gateway options.'),
    hostedUrl: z
      .url()
      .optional()
      .describe(
        'A page that performs this option\'s checkout step, for a client that cannot run the browser helper (the Android ' +
          'alternative path opens it in a browser tab). Present on gateway options when the service serves a hosted checkout.',
      ),
  })
  .describe('One way the customer can pay for the session.');
export type PurchaseOption = z.infer<typeof PurchaseOptionSchema>;

export const PurchaseAttemptSchema = z
  .object({
    provider: ProviderSchema.describe('The gateway that was tried.'),
    outcome: AttemptOutcomeSchema.describe('Whether the gateway created the order or mandate.'),
    at: IsoDateTimeSchema.describe('When the attempt was made.'),
    errorCode: z.string().optional().describe('The error code of a failed attempt.'),
    message: z.string().optional().describe('The error message of a failed attempt.'),
  })
  .describe('One gateway tried while creating the purchase.');
export type PurchaseAttempt = z.infer<typeof PurchaseAttemptSchema>;

const ReferenceSchema = z
  .string()
  .min(1)
  .max(MAX_GATEWAY_ID_LENGTH)
  .regex(GATEWAY_ID_PATTERN)
  .describe(
    `Your own id for the purchase: at most ${MAX_GATEWAY_ID_LENGTH} characters of letters, digits, \`_\` and \`-\`, the ` +
      'tightest limit among the gateways. Retrying a start with the same reference and customer returns the same session.',
  );

export const PurchaseSessionSchema = z
  .object({
    id: z.string().describe('The session id. Unguessable: whoever holds it can complete the session.'),
    platform: PlatformSchema.describe('The platform the customer buys on.'),
    product: z.string().describe('The key of the product.'),
    policy: z
      .enum(ChannelPolicy)
      .describe('The channel policy the session was resolved with: `store`, `user_choice` or `gateways`.'),
    status: SessionStatusSchema.describe('Where the session is.'),
    customerRef: z.string().describe('Your id for the customer.'),
    reference: ReferenceSchema,
    returnUrl: z
      .url()
      .optional()
      .describe('Where the customer is sent when the purchase is done: the `returnUrl` given to `start`.'),
    options: z.array(PurchaseOptionSchema).describe('How the customer can pay. A `user_choice` session has the Google Play option first and the gateway option once the customer chose the alternative.'),
    attempts: z.array(PurchaseAttemptSchema).describe('Every gateway tried while creating the gateway option, in order.'),
    externalTransactionToken: z
      .string()
      .optional()
      .describe('Set when the customer chose the alternative payment on Google\'s screen.'),
    createdAt: IsoDateTimeSchema.describe('When the session was created.'),
    expiresAt: IsoDateTimeSchema.describe('When an unpaid session expires.'),
    completedAt: IsoDateTimeSchema.optional().describe('When the session completed.'),
    subscriptionId: z.string().optional().describe('The provider\'s subscription id, once the purchase is confirmed.'),
    paymentId: z.string().optional().describe('The provider\'s payment id, once the purchase is confirmed.'),
    provider: ProviderSchema.optional().describe('The provider the purchase was confirmed at.'),
  })
  .describe('A purchase in progress or done: where the customer may pay and how it ended.');
export type PurchaseSession = z.infer<typeof PurchaseSessionSchema>;

/** What the store keeps for a session: the public session plus what later steps need. */
export const PurchaseSessionRecordSchema = PurchaseSessionSchema.extend({
  customer: CustomerSchema.describe('The paying customer, as given to `start`.'),
  kind: ProductKindSchema.describe('Whether the product is a subscription or a one-time purchase.'),
  amount: PositivePaiseSchema.describe('The price of the product when the session started, in paise, tax included.'),
  taxRateBps: z.number().int().nonnegative().optional().describe('The tax rate of the product when the session started.'),
  trial: z.boolean().describe('True when the product has a free trial.'),
  initialChargeId: z
    .string()
    .optional()
    .describe('The paid charge or payment the first Google report states, if it states one. Every other charge is a renewal.'),
  initialReportId: z.string().optional().describe('The id of the first report queued for the session.'),
}).describe('A purchase session as stored.');
export type PurchaseSessionRecord = z.infer<typeof PurchaseSessionRecordSchema>;

// ---------------------------------------------------------------------------
// Entitlements
// ---------------------------------------------------------------------------

export const EntitlementItemSchema = z
  .object({
    product: z.string().describe('The key of the product.'),
    kind: ProductKindSchema.describe('`subscription` or `one_time`.'),
    provider: ProviderSchema.describe('The provider that holds the purchase.'),
    channel: SalesChannelSchema.describe('`store` or `gateway`.'),
    platform: PlatformSchema.describe('The platform the customer bought on.'),
    subscriptionId: z.string().optional().describe('The provider\'s subscription id.'),
    paymentId: z.string().optional().describe('The provider\'s payment id.'),
    status: EntitlementStatusSchema.describe('What the customer has.'),
    active: z.boolean().describe('True when the item gives access now.'),
    cancelAtPeriodEnd: z.boolean().optional().describe('True when the subscription ends at the end of the current period.'),
    currentPeriodEnd: IsoDateTimeSchema.optional().describe('End of the current paid period, where known.'),
    updatedAt: IsoDateTimeSchema.describe('When the item last changed.'),
  })
  .describe('One purchase the customer owns or owned.');
export type EntitlementItem = z.infer<typeof EntitlementItemSchema>;

export const EntitlementsSchema = z
  .object({
    customerRef: z.string().describe('Your id for the customer.'),
    active: z.boolean().describe('True when at least one item gives access now.'),
    items: z.array(EntitlementItemSchema).describe('Every purchase of the customer, newest change first, including ended ones.'),
  })
  .describe('What a customer owns, across app stores and gateways.');
export type Entitlements = z.infer<typeof EntitlementsSchema>;

/** What the store keeps for an entitlement item. */
export const EntitlementRecordSchema = EntitlementItemSchema.omit({ active: true })
  .extend({
    id: z.string().describe('The entitlement id, derived from the provider and the subscription or payment id.'),
    customerRef: z.string().describe('Your id for the customer.'),
    sessionId: z.string().describe('The session that created the item.'),
    amount: PaiseSchema.describe('What the customer paid for a one-time purchase, in paise.'),
    refundedAmount: PaiseSchema.optional().describe('What was refunded so far, in paise.'),
    lastEventAt: IsoDateTimeSchema.optional().describe('The newest event applied; older events are ignored.'),
    lastChargeId: z.string().optional().describe('The last charge a `subscription.charged` event reported.'),
    refundIds: z.array(z.string()).optional().describe('The refunds already counted in `refundedAmount`.'),
  })
  .describe('An entitlement item as stored.');
export type EntitlementRecord = z.infer<typeof EntitlementRecordSchema>;

// ---------------------------------------------------------------------------
// Report queue
// ---------------------------------------------------------------------------

export const ReportErrorSchema = z
  .object({
    code: z.string().describe('The error code of the last failed attempt.'),
    message: z.string().describe('The error message of the last failed attempt.'),
  })
  .describe('Why the last attempt to send a report failed.');

export const ReportRecordSchema = z
  .object({
    id: z.string().describe('The report id. For a transaction it is the external transaction id; ids are deterministic, so queueing a report twice stores it once.'),
    kind: ReportKindSchema.describe('A transaction or a refund.'),
    status: ReportStatusSchema.describe('Where the report is.'),
    sessionId: z.string().describe('The purchase session the report belongs to.'),
    customerRef: z.string().describe('Your id for the customer.'),
    product: z.string().describe('The key of the product.'),
    transaction: ExternalTransactionReportSchema.optional().describe('What to send to Google, for a `transaction`.'),
    refund: ExternalTransactionRefundSchema.optional().describe('What to send to Google, for a `refund`.'),
    dependsOn: z
      .string()
      .optional()
      .describe('The id of the report that must be sent first: the first transaction of a renewal, the transaction a refund refers to.'),
    sourceId: z.string().optional().describe('The charge, payment or refund id that caused the report.'),
    createdAt: IsoDateTimeSchema.describe('When the report was queued.'),
    dueBy: IsoDateTimeSchema.describe('When Google must have it: 24 hours after the transaction time.'),
    attempts: z.number().int().nonnegative().describe('How many times sending was attempted.'),
    nextAttemptAt: IsoDateTimeSchema.describe('The earliest the next attempt may start.'),
    lastAttemptAt: IsoDateTimeSchema.optional().describe('When the last attempt started.'),
    lastError: ReportErrorSchema.optional().describe('Why the last attempt failed.'),
    leaseToken: z.string().optional().describe('The flush that currently owns the report.'),
    leaseUntil: IsoDateTimeSchema.optional().describe('When that flush loses the report if it has not saved it.'),
    sentAt: IsoDateTimeSchema.optional().describe('When Google accepted the report.'),
  })
  .describe('A report owed to Google, as stored in the outbox.');
export type ReportRecord = z.infer<typeof ReportRecordSchema>;

export const FlushOptionsSchema = z
  .object({
    limit: z.number().int().min(1).max(500).optional().describe('Most reports to send in this flush. Defaults to 50.'),
  })
  .describe('Options for sending queued reports.');
export type FlushOptions = z.input<typeof FlushOptionsSchema>;

export const FlushEntrySchema = z
  .object({
    id: z.string().describe('The report id.'),
    kind: ReportKindSchema.describe('A transaction or a refund.'),
    outcome: FlushOutcomeSchema.optional().describe('What the flush did with the report. Absent for an overdue report this flush did not try.'),
    attempts: z.number().int().nonnegative().describe('Attempts made so far, including this one.'),
    dueBy: IsoDateTimeSchema.describe('When Google must have the report.'),
    overdue: z.boolean().describe('True when the report was not sent by `dueBy`.'),
    errorCode: z.string().optional().describe('The error code of a failed attempt.'),
    errorMessage: z.string().optional().describe('The error message of a failed attempt.'),
  })
  .describe('What a flush did with one report.');
export type FlushEntry = z.infer<typeof FlushEntrySchema>;

export const FlushResultSchema = z
  .object({
    sent: z.number().int().nonnegative().describe('Reports Google accepted in this flush.'),
    retrying: z.number().int().nonnegative().describe('Reports whose attempt failed and that stay queued with a backoff.'),
    blocked: z.number().int().nonnegative().describe('Reports waiting for an earlier report to be sent.'),
    rejected: z.number().int().nonnegative().describe('Reports Google refused as invalid. They are not retried.'),
    skipped: z.number().int().nonnegative().describe('Reports left queued because no reporter is configured.'),
    entries: z.array(FlushEntrySchema).describe('One entry per report this flush looked at.'),
    overdue: z
      .array(FlushEntrySchema)
      .describe('Every queued report past its `dueBy`, whether or not this flush tried it. Page someone when this is not empty.'),
  })
  .describe('The outcome of sending queued reports to Google.');
export type FlushResult = z.infer<typeof FlushResultSchema>;

// ---------------------------------------------------------------------------
// Method inputs
// ---------------------------------------------------------------------------

export const StartPurchaseInputSchema = z
  .object({
    platform: PlatformSchema.describe('The platform the customer buys on.'),
    product: z.string().min(1).describe('The key of the product.'),
    customer: CustomerSchema.describe(
      'The paying customer. `state` is required when the platform policy is `user_choice`, because the purchase is then reported to Google.',
    ),
    customerRef: z.string().min(1).max(128).describe('Your id for the customer: entitlements are kept under it.'),
    reference: ReferenceSchema.optional(),
    returnUrl: z.url().optional().describe('Where a gateway sends the customer after paying.'),
  })
  .describe('Everything needed to start a purchase.');
export type StartPurchaseInput = z.input<typeof StartPurchaseInputSchema>;

export const ChooseAlternativeInputSchema = z
  .object({
    externalTransactionToken: z
      .string()
      .min(1)
      .describe('The token Google gave the app when the customer chose the alternative on its choice screen.'),
  })
  .describe('The customer\'s choice of the alternative payment on Google\'s screen.');
export type ChooseAlternativeInput = z.input<typeof ChooseAlternativeInputSchema>;

export const CompletePurchaseInputSchema = z
  .object({
    provider: ProviderSchema.describe('The provider the customer paid at.'),
    result: CheckoutResultSchema.describe('What the provider handed back to the browser or device, untouched.'),
  })
  .describe('The result of a checkout, to complete a purchase session with.');
export type CompletePurchaseInput = z.input<typeof CompletePurchaseInputSchema>;

/** The code a gateway error is recorded with when it carries none. */
export const UNKNOWN_ERROR_CODE = ErrorCode.Internal;
