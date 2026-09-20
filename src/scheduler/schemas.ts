import { z } from 'zod';
import { Currency, ErrorCode } from '../constants.js';
import {
  BillingIntervalSchema,
  CurrencySchema,
  CustomerSchema,
  ChargeStatusSchema,
  IsoDateTimeSchema,
  MetadataSchema,
  PaiseSchema,
  PositivePaiseSchema,
  ProviderSchema,
} from '../schemas.js';
import {
  CycleStatus,
  DEFAULT_LOCK_TTL_MS,
  DEFAULT_LOCK_WAIT_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MIN_NOTICE_HOURS,
  DEFAULT_NOTIFY_LEAD_HOURS,
  DEFAULT_RETRY_INTERVAL_HOURS,
  DEFAULT_TICK_CONCURRENCY,
  DEFAULT_TICK_LIMIT,
  ScheduleStatus,
  ScheduleStatusReason,
  SchedulerEventType,
} from './constants.js';

/**
 * Everything the scheduler persists is plain JSON: ISO-8601 strings for
 * instants, integer paise for money, constants for statuses. Any database
 * (a JSONB column, a DynamoDB item, a Redis hash of JSON) can store these
 * records unchanged.
 *
 * Instants the scheduler itself writes (`nextActionAt`, `createdAt`, ...) are
 * always UTC `toISOString()` values, so they also sort correctly as strings.
 */

export const ScheduleStatusSchema = z
  .enum(ScheduleStatus)
  .describe(
    'Lifecycle of one scheduled subscription: pending_authorization (nothing is billed yet), active, paused, ' +
      'halted (retries exhausted), cancelled or completed (all cycles collected or the mandate ended).',
  );
export const ScheduleStatusReasonSchema = z
  .enum(ScheduleStatusReason)
  .describe('Why a schedule is in its current status, for dashboards and audit logs.');
export const CycleStatusSchema = z
  .enum(CycleStatus)
  .describe('Where one billing cycle is in its notify, charge and confirm state machine.');
export const SchedulerEventTypeSchema = z
  .enum(SchedulerEventType)
  .describe('What happened to a schedule, as reported to the `onEvent` listener.');
export const ErrorCodeSchema = z
  .enum(ErrorCode)
  .describe('Stable error code of this library. Branch on it, never on the message.');

const HoursSchema = z.number().nonnegative();

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** Billing policy of one schedule, fixed at registration (defaults come from the scheduler's options). */
export const SchedulePolicySchema = z
  .object({
    notifyLeadHours: HoursSchema.describe('Send the pre-debit notification this many hours before the due instant.'),
    minNoticeHours: HoursSchema.describe('Minimum gap in hours between an accepted notification and the debit.'),
    maxAttempts: z
      .number()
      .int()
      .min(1)
      .describe('Debit attempts per cycle before the cycle fails and the schedule halts.'),
    retryIntervalHours: HoursSchema.describe('Hours to wait between a failed attempt and the next one.'),
    chargeLeadHours: HoursSchema.optional().describe(
      'For gateways that want the charge raised days before the debit (Cashfree on-demand): raise it at least this many ' +
        "hours ahead. The effective lead is the larger of this and the gateway's own `merchantChargeLeadHours`.",
    ),
    authorizationTimeoutHours: z
      .number()
      .positive()
      .optional()
      .describe(
        'A schedule still awaiting authorisation this many hours after it was registered is cancelled by `tick()`. ' +
          'Omit for no timeout. A customer who authorises later still revives it.',
      ),
  })
  .describe('Billing policy of one schedule, fixed at registration.');
export type SchedulePolicy = z.infer<typeof SchedulePolicySchema>;

export const SchedulePolicyOverridesSchema = SchedulePolicySchema.partial().describe(
  'Per-schedule overrides of the scheduler-wide policy defaults.',
);
export type SchedulePolicyOverrides = z.infer<typeof SchedulePolicyOverridesSchema>;

/** The scheduler's configuration values (policy defaults and lock timing). */
export const SchedulerConfigSchema = z
  .object({
    notifyLeadHours: HoursSchema.default(DEFAULT_NOTIFY_LEAD_HOURS).describe(
      'Default hours before the due instant at which the pre-debit notification is sent.',
    ),
    minNoticeHours: HoursSchema.default(DEFAULT_MIN_NOTICE_HOURS).describe(
      'Default minimum gap in hours between an accepted notification and the debit.',
    ),
    maxAttempts: z
      .number()
      .int()
      .min(1)
      .default(DEFAULT_MAX_ATTEMPTS)
      .describe('Default debit attempts per cycle before the schedule halts.'),
    retryIntervalHours: HoursSchema.default(DEFAULT_RETRY_INTERVAL_HOURS).describe(
      'Default hours between a failed attempt and the next one.',
    ),
    chargeLeadHours: HoursSchema.optional().describe('Default charge lead for charge-ahead gateways, in hours.'),
    authorizationTimeoutHours: z
      .number()
      .positive()
      .optional()
      .describe('Default authorisation timeout in hours. Omit for none.'),
    lockTtlMs: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_LOCK_TTL_MS)
      .describe(
        'How long a per-schedule lock survives its owner, in milliseconds. Must exceed the longest time one schedule spends in a tick.',
      ),
    lockWaitMs: z
      .number()
      .int()
      .nonnegative()
      .default(DEFAULT_LOCK_WAIT_MS)
      .describe('How long API calls other than `tick` wait for a busy lock before throwing CONFLICT, in milliseconds.'),
  })
  .describe('Configuration of the billing scheduler: policy defaults and lock timing.');
export type SchedulerConfig = z.output<typeof SchedulerConfigSchema>;
export type SchedulerConfigInput = z.input<typeof SchedulerConfigSchema>;

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** The last error a gateway call produced for a cycle. */
export const CycleErrorSchema = z
  .object({
    code: ErrorCodeSchema.describe('Error code of the failed gateway call.'),
    message: z.string().describe('Human-readable explanation of the failure.'),
    at: IsoDateTimeSchema.describe('When the call failed.'),
  })
  .describe('The last error a gateway call produced for a cycle.');
export type CycleError = z.infer<typeof CycleErrorSchema>;

/** One debit attempt of a cycle, kept as history. */
export const AttemptRecordSchema = z
  .object({
    attempt: z.number().int().min(1).describe('1-based attempt number within the cycle.'),
    chargeId: z.string().describe('The debit id sent to the gateway for this attempt.'),
    status: ChargeStatusSchema.describe('How the attempt ended.'),
    at: IsoDateTimeSchema.describe('When the outcome was recorded.'),
    failureCode: z.string().optional().describe("The gateway's failure code, when the attempt failed."),
    failureReason: z.string().optional().describe("The gateway's failure reason, when the attempt failed."),
  })
  .describe('One debit attempt of a cycle, kept as history.');
export type AttemptRecord = z.infer<typeof AttemptRecordSchema>;

/** The most recent failed debit attempt of a schedule. */
export const LastFailureSchema = z
  .object({
    code: z.string().describe("The gateway's failure code."),
    reason: z.string().optional().describe("The gateway's failure reason."),
    at: IsoDateTimeSchema.describe('When the attempt failed.'),
  })
  .describe('The most recent failed debit attempt of a schedule.');
export type LastFailure = z.infer<typeof LastFailureSchema>;

/** One billing cycle of a schedule, keyed by `(scheduleId, index)`. */
export const CycleRecordSchema = z
  .object({
    scheduleId: z.string().describe('The schedule this cycle belongs to.'),
    index: z.number().int().nonnegative().describe('0-based position of the cycle in the schedule.'),
    status: CycleStatusSchema.describe('Where the cycle is in its state machine.'),
    dueAt: IsoDateTimeSchema.describe("The cycle's contractual due date, derived from the schedule's anchor."),
    attemptDueAt: IsoDateTimeSchema.describe(
      'Earliest instant the current attempt may be debited: `dueAt` for attempt 1, later for retries.',
    ),
    attempt: z
      .number()
      .int()
      .min(1)
      .describe('The current attempt, 1-based. Keeps increasing across rounds so charge ids stay unique.'),
    roundStartAttempt: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('First attempt of the current round of `maxAttempts`; later than 1 after a halted schedule was resumed.'),
    amount: PositivePaiseSchema.optional().describe(
      'Amount in paise, frozen when the cycle is first notified or charged, so an amount update never changes a notified cycle.',
    ),
    notificationRound: z
      .number()
      .int()
      .min(1)
      .describe('Counts re-notifications for the same attempt (a changed debit date needs a fresh notification).'),
    notificationId: z.string().optional().describe('The id of the pre-debit notification sent for this attempt.'),
    invoiceNumber: z.string().optional().describe('Invoice number the gateway returned with the notification.'),
    notifiedAt: IsoDateTimeSchema.optional().describe('When the gateway accepted the pre-debit notification.'),
    debitAt: IsoDateTimeSchema.optional().describe('The debit date the customer was told.'),
    chargeId: z
      .string()
      .optional()
      .describe('Deterministic per (schedule, cycle, attempt); set together with status `charging`.'),
    providerChargeId: z.string().optional().describe("The gateway's own id for the debit, once known."),
    chargeRequestedAt: IsoDateTimeSchema.optional().describe('When the debit was requested from the gateway.'),
    scheduledAt: IsoDateTimeSchema.optional().describe(
      'For gateways that take the charge in advance: the debit date sent to the gateway. Equals `attemptDueAt`, or a ' +
        'later instant when the charge was raised too late to make it. `dueAt` always stays the contractual date.',
    ),
    paidAt: IsoDateTimeSchema.optional().describe('When the debit was collected.'),
    completedAt: IsoDateTimeSchema.optional().describe('When the cycle reached a final status.'),
    lastError: CycleErrorSchema.optional().describe('The last gateway error for this cycle, if any.'),
    attempts: z.array(AttemptRecordSchema).describe('The debit attempts made so far, oldest first.'),
    createdAt: IsoDateTimeSchema.describe('When the cycle record was created.'),
    updatedAt: IsoDateTimeSchema.describe('When the cycle record last changed.'),
  })
  .describe('One billing cycle of a schedule, keyed by `(scheduleId, index)`.');
export type CycleRecord = z.infer<typeof CycleRecordSchema>;

/** A subscription whose recurring debits the scheduler raises. */
export const ScheduleRecordSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .describe('The schedule handle. Defaults to `provider:reference` (see `scheduleIdFor`) and never changes.'),
    provider: ProviderSchema.describe('The gateway holding the mandate.'),
    subscriptionId: z
      .string()
      .min(1)
      .describe('The id the gateway knows the mandate by; debits are raised against it. Activation may replace it.'),
    reference: z.string().min(1).optional().describe("The merchant's own reference for the subscription."),
    status: ScheduleStatusSchema.describe('Where the schedule is in its lifecycle.'),
    statusReason: ScheduleStatusReasonSchema.optional().describe('Why the schedule is in its current status.'),
    amount: PositivePaiseSchema.describe('Amount in paise of the cycles that have not been notified yet.'),
    currency: CurrencySchema.describe('Currency of the amount.'),
    interval: BillingIntervalSchema.describe('How often a cycle falls due.'),
    totalCycles: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Number of cycles after which the schedule completes. Omit for open-ended.'),
    mandateEndsAt: IsoDateTimeSchema.optional().describe(
      'When the mandate lapses. No notification or debit is made for a due date on or after it, and the schedule completes instead.',
    ),
    customer: CustomerSchema.optional().describe('The customer, passed along with each debit.'),
    metadata: MetadataSchema.optional().describe('Merchant metadata, passed along with each debit.'),
    policy: SchedulePolicySchema.describe('The billing policy of this schedule.'),
    fingerprint: z
      .string()
      .describe('Hash of the registration input, so registering the same data again is a no-op.'),
    firstChargeAt: IsoDateTimeSchema.describe(
      'When the first cycle is (or was) due: the end of a free trial or a delayed start. Re-set by activation and re-anchoring before the first debit.',
    ),
    anchorAt: IsoDateTimeSchema.describe('Cycle `anchorIndex` is due at this instant; later cycles follow from it.'),
    anchorIndex: z.number().int().nonnegative().describe('The cycle index that is due at `anchorAt`.'),
    cycleIndex: z.number().int().nonnegative().describe('The cycle being worked on (0-based).'),
    paidCycles: z.number().int().nonnegative().describe('Number of cycles collected so far.'),
    retrying: z
      .boolean()
      .describe('True while the current cycle is being retried after a failed debit attempt.'),
    lastFailure: LastFailureSchema.optional().describe('The most recent failed debit attempt of the current cycle.'),
    resumeAt: IsoDateTimeSchema.optional().describe('While paused: when `tick()` resumes the schedule by itself.'),
    nextChargeAt: IsoDateTimeSchema.optional().describe(
      'When the next cycle is due to be debited. Absent when nothing is scheduled (paused, cancelled, completed, halted, awaiting authorisation).',
    ),
    nextActionAt: IsoDateTimeSchema.optional().describe(
      'When `tick()` next needs to look at this schedule; absent when it needs no attention. The only field the store queries by.',
    ),
    createdAt: IsoDateTimeSchema.describe('When the schedule was registered.'),
    updatedAt: IsoDateTimeSchema.describe('When the schedule last changed.'),
    activatedAt: IsoDateTimeSchema.optional().describe('When the customer authorised and billing started.'),
    endedAt: IsoDateTimeSchema.optional().describe('When the schedule was cancelled, halted or completed.'),
  })
  .describe('A subscription whose recurring debits the scheduler raises.');
export type ScheduleRecord = z.infer<typeof ScheduleRecordSchema>;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export const RegisterScheduleInputSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .optional()
      .describe('The schedule handle. Defaults to `provider:reference`, or `provider:subscriptionId` without a reference.'),
    provider: ProviderSchema.describe('The gateway holding the mandate.'),
    subscriptionId: z.string().min(1).describe('The id the gateway knows the mandate by.'),
    reference: z.string().min(1).optional().describe("The merchant's own reference for the subscription."),
    amount: PositivePaiseSchema.describe('Amount per cycle, in paise.'),
    currency: CurrencySchema.default(Currency.INR).describe('Currency of the amount.'),
    interval: BillingIntervalSchema.describe('How often a cycle falls due.'),
    firstChargeAt: IsoDateTimeSchema.describe(
      'When the first charge is due; for a free trial, the instant the trial ends.',
    ),
    totalCycles: z.number().int().positive().optional().describe('Number of cycles to bill. Omit to bill until cancelled.'),
    mandateEndsAt: IsoDateTimeSchema.optional().describe(
      'When the mandate lapses. Must be after `firstChargeAt`. Nothing is notified or debited on or after it.',
    ),
    customer: CustomerSchema.optional().describe('The customer, passed along with each debit.'),
    metadata: MetadataSchema.optional().describe('Merchant metadata, passed along with each debit.'),
    awaitingAuthorization: z
      .boolean()
      .optional()
      .describe('Store the schedule as `pending_authorization`; `tick()` ignores it until it is activated.'),
  })
  .extend(SchedulePolicyOverridesSchema.shape)
  .describe('Registers a schedule for a merchant-scheduled mandate.');
export type RegisterScheduleInput = z.input<typeof RegisterScheduleInputSchema>;
export type ParsedRegisterScheduleInput = z.output<typeof RegisterScheduleInputSchema>;

export const ActivateScheduleInputSchema = z
  .object({
    subscriptionId: z
      .string()
      .min(1)
      .optional()
      .describe("Replaces the stored gateway subscription id (the schedule's own id stays the same)."),
    firstChargeAt: IsoDateTimeSchema.optional().describe(
      'Replaces the anchor. Without it, a past anchor becomes the activation instant.',
    ),
  })
  .describe('Starts billing once the customer has authorised the mandate.');
export type ActivateScheduleInput = z.input<typeof ActivateScheduleInputSchema>;

export const PauseScheduleInputSchema = z
  .object({
    resumeAt: IsoDateTimeSchema.optional().describe(
      'Resume billing by itself at this instant (the next `tick()` after it). Must be in the future. Omit to stay paused until resumed.',
    ),
  })
  .describe('Options for pausing a schedule.');
export type PauseScheduleInput = z.input<typeof PauseScheduleInputSchema>;

export const ResumeScheduleInputSchema = z
  .object({
    nextChargeAt: IsoDateTimeSchema.optional().describe(
      'When the next cycle is due. Without it the schedule continues unchanged, or from now if the pause swallowed the due date.',
    ),
    skipFailedCycle: z
      .boolean()
      .optional()
      .describe(
        'For a halted schedule whose current cycle failed: skip that cycle and continue from the next one, instead of re-opening it for another round of attempts.',
      ),
  })
  .describe('Options for resuming a paused or halted schedule.');
export type ResumeScheduleInput = z.input<typeof ResumeScheduleInputSchema>;

export const UpdateScheduleInputSchema = z
  .object({
    amount: PositivePaiseSchema.optional().describe(
      'New amount per cycle in paise, for cycles that have not been notified yet.',
    ),
    nextChargeAt: IsoDateTimeSchema.optional().describe(
      'Move the next debit to this instant; later cycles follow from it. A pre-debit notice already sent for the old date is redone.',
    ),
    remainingCycles: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Debits still to be collected, counting the current cycle. Sets the total to paid cycles plus this.'),
    mandateEndsAt: IsoDateTimeSchema.optional().describe(
      'New mandate end date. No notification or debit is made for a due date on or after it.',
    ),
  })
  .refine(
    (input) =>
      input.amount !== undefined ||
      input.nextChargeAt !== undefined ||
      input.remainingCycles !== undefined ||
      input.mandateEndsAt !== undefined,
    { error: 'Nothing to update: pass at least one field to change' },
  )
  .describe('Changes the billing terms of a live schedule.');
export type UpdateScheduleInput = z.input<typeof UpdateScheduleInputSchema>;

export const CancelScheduleInputSchema = z
  .object({
    reason: ScheduleStatusReasonSchema.optional().describe('Why the schedule is cancelled. Defaults to `cancelled_by_merchant`.'),
  })
  .describe('Options for cancelling a schedule.');
export type CancelScheduleInput = z.input<typeof CancelScheduleInputSchema>;

export const TickOptionsSchema = z
  .object({
    limit: z.number().int().min(1).default(DEFAULT_TICK_LIMIT).describe('Maximum schedules examined in this tick.'),
    concurrency: z.number().int().min(1).default(DEFAULT_TICK_CONCURRENCY).describe('Schedules processed in parallel.'),
  })
  .describe('Options for one run of the billing scheduler.');
export type TickOptions = z.input<typeof TickOptionsSchema>;

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export const SchedulerEventSchema = z
  .object({
    type: SchedulerEventTypeSchema.describe('What happened.'),
    at: IsoDateTimeSchema.describe('When it happened.'),
    scheduleId: z.string().describe('The schedule it happened to.'),
    provider: ProviderSchema.describe('The gateway holding the mandate.'),
    subscriptionId: z.string().describe('The gateway subscription id of the schedule.'),
    scheduleStatus: ScheduleStatusSchema.describe('The status of the schedule after the change.'),
    reason: ScheduleStatusReasonSchema.optional().describe('Why the schedule changed status, where relevant.'),
    cycleIndex: z.number().int().nonnegative().optional().describe('The cycle concerned, where relevant.'),
    attempt: z.number().int().min(1).optional().describe('The debit attempt concerned, where relevant.'),
    chargeId: z.string().optional().describe('The debit id concerned, where relevant.'),
    amount: PaiseSchema.optional().describe('The amount in paise concerned, where relevant.'),
    error: z
      .object({
        code: ErrorCodeSchema.describe('Error code of the failure.'),
        message: z.string().describe('Human-readable explanation of the failure.'),
      })
      .optional()
      .describe('The failure, for failure events.'),
  })
  .describe('A state change of a schedule, handed to the `onEvent` listener after it has been persisted.');
export type SchedulerEvent = z.infer<typeof SchedulerEventSchema>;

export const TickErrorSchema = z
  .object({
    scheduleId: z.string().describe('The schedule that failed.'),
    code: ErrorCodeSchema.describe('Error code of the failure.'),
    message: z.string().describe('Human-readable explanation of the failure.'),
  })
  .describe('A failure of one schedule during a tick.');
export type TickError = z.infer<typeof TickErrorSchema>;

/** What one `tick()` did. A failing schedule shows up in `errors`; the others are unaffected. */
export const TickResultSchema = z
  .object({
    at: IsoDateTimeSchema.describe('The instant the tick ran.'),
    due: z.number().int().nonnegative().describe('Schedules the store reported as due.'),
    locked: z.number().int().nonnegative().describe('Due schedules skipped because another worker held their lock.'),
    notified: z.number().int().nonnegative().describe('Pre-debit notifications accepted by the gateway.'),
    charged: z.number().int().nonnegative().describe('`createCharge` calls made.'),
    reconciled: z.number().int().nonnegative().describe('`getCharge` reconciliations made.'),
    succeeded: z.number().int().nonnegative().describe('Cycles that became collected.'),
    failed: z.number().int().nonnegative().describe('Debit attempts that failed.'),
    awaiting: z.number().int().nonnegative().describe("Cycles left waiting for the gateway's final answer."),
    completed: z.number().int().nonnegative().describe('Schedules that completed.'),
    halted: z.number().int().nonnegative().describe('Schedules halted because a cycle exhausted its attempts.'),
    expired: z.number().int().nonnegative().describe('Pending-authorisation schedules cancelled by their timeout.'),
    errors: z.array(TickErrorSchema).describe('Schedules that failed during this tick; the others are unaffected.'),
  })
  .describe('What one run of the billing scheduler did. A failing schedule shows up in `errors`; the others are unaffected.');
export type TickResult = z.infer<typeof TickResultSchema>;
