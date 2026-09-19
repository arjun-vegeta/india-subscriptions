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

export const ScheduleStatusSchema = z.enum(ScheduleStatus);
export const ScheduleStatusReasonSchema = z.enum(ScheduleStatusReason);
export const CycleStatusSchema = z.enum(CycleStatus);
export const SchedulerEventTypeSchema = z.enum(SchedulerEventType);
export const ErrorCodeSchema = z.enum(ErrorCode);

const HoursSchema = z.number().nonnegative();

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** Billing policy of one schedule, fixed at registration (defaults come from the scheduler's options). */
export const SchedulePolicySchema = z.object({
  /** Send the pre-debit notification this many hours before the due instant. */
  notifyLeadHours: HoursSchema,
  /** Minimum gap between an accepted notification and the debit. */
  minNoticeHours: HoursSchema,
  /** Debit attempts per cycle before the cycle fails and the schedule halts. */
  maxAttempts: z.number().int().min(1),
  /** Wait between a failed attempt and the next one. */
  retryIntervalHours: HoursSchema,
  /**
   * For gateways that want the charge raised days before the debit (Cashfree
   * on-demand): raise it at least this many hours ahead. The effective lead is
   * the larger of this and the gateway's own `merchantChargeLeadHours`.
   */
  chargeLeadHours: HoursSchema.optional(),
  /**
   * A schedule still awaiting authorisation this many hours after it was
   * registered is cancelled by `tick()`. Omit for no timeout.
   */
  authorizationTimeoutHours: z.number().positive().optional(),
});
export type SchedulePolicy = z.infer<typeof SchedulePolicySchema>;

export const SchedulePolicyOverridesSchema = SchedulePolicySchema.partial();
export type SchedulePolicyOverrides = z.infer<typeof SchedulePolicyOverridesSchema>;

/** The scheduler's configuration values (policy defaults and lock timing). */
export const SchedulerConfigSchema = z.object({
  notifyLeadHours: HoursSchema.default(DEFAULT_NOTIFY_LEAD_HOURS),
  minNoticeHours: HoursSchema.default(DEFAULT_MIN_NOTICE_HOURS),
  maxAttempts: z.number().int().min(1).default(DEFAULT_MAX_ATTEMPTS),
  retryIntervalHours: HoursSchema.default(DEFAULT_RETRY_INTERVAL_HOURS),
  chargeLeadHours: HoursSchema.optional(),
  authorizationTimeoutHours: z.number().positive().optional(),
  /** How long a per-schedule lock survives its owner. Must exceed the longest time one schedule spends in a tick. */
  lockTtlMs: z.number().int().positive().default(DEFAULT_LOCK_TTL_MS),
  /** How long API calls other than `tick` wait for a busy lock before throwing CONFLICT. */
  lockWaitMs: z.number().int().nonnegative().default(DEFAULT_LOCK_WAIT_MS),
});
export type SchedulerConfig = z.output<typeof SchedulerConfigSchema>;
export type SchedulerConfigInput = z.input<typeof SchedulerConfigSchema>;

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** The last error a gateway call produced for a cycle. */
export const CycleErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  at: IsoDateTimeSchema,
});
export type CycleError = z.infer<typeof CycleErrorSchema>;

/** One debit attempt of a cycle, kept as history. */
export const AttemptRecordSchema = z.object({
  attempt: z.number().int().min(1),
  chargeId: z.string(),
  status: ChargeStatusSchema,
  at: IsoDateTimeSchema,
  failureCode: z.string().optional(),
  failureReason: z.string().optional(),
});
export type AttemptRecord = z.infer<typeof AttemptRecordSchema>;

/** One billing cycle of a schedule, keyed by `(scheduleId, index)`. */
export const CycleRecordSchema = z.object({
  scheduleId: z.string(),
  /** 0-based position of the cycle in the schedule. */
  index: z.number().int().nonnegative(),
  status: CycleStatusSchema,
  /** The cycle's date from the schedule's anchor. */
  dueAt: IsoDateTimeSchema,
  /** Earliest instant the current attempt may be debited: `dueAt` for attempt 1, later for retries. */
  attemptDueAt: IsoDateTimeSchema,
  /** The current attempt, 1-based. Keeps increasing across rounds so charge ids stay unique. */
  attempt: z.number().int().min(1),
  /** First attempt of the current round of `maxAttempts`; later than 1 after a halted schedule was resumed. */
  roundStartAttempt: z.number().int().min(1).optional(),
  /** Frozen when the cycle is first notified or charged, so `updateAmount` never changes a notified cycle. */
  amount: PositivePaiseSchema.optional(),
  /** Counts re-notifications for the same attempt (a changed debit date needs a fresh notification). */
  notificationRound: z.number().int().min(1),
  notificationId: z.string().optional(),
  invoiceNumber: z.string().optional(),
  notifiedAt: IsoDateTimeSchema.optional(),
  /** The debit date the customer was told. */
  debitAt: IsoDateTimeSchema.optional(),
  /** Deterministic per (schedule, cycle, attempt); set together with status `charging`. */
  chargeId: z.string().optional(),
  /** The gateway's own id for the debit, once known. */
  providerChargeId: z.string().optional(),
  chargeRequestedAt: IsoDateTimeSchema.optional(),
  /**
   * For gateways that take the charge in advance: the debit date sent to the
   * gateway. Equals `attemptDueAt`, or a later instant when the charge was
   * raised too late to make it (late activation, retry, resume). `dueAt` always
   * stays the contractual date.
   */
  scheduledAt: IsoDateTimeSchema.optional(),
  paidAt: IsoDateTimeSchema.optional(),
  completedAt: IsoDateTimeSchema.optional(),
  lastError: CycleErrorSchema.optional(),
  attempts: z.array(AttemptRecordSchema),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type CycleRecord = z.infer<typeof CycleRecordSchema>;

/** A subscription whose recurring debits the scheduler raises. */
export const ScheduleRecordSchema = z.object({
  /** Your handle for the schedule; defaults to the subscription id and never changes. */
  id: z.string().min(1),
  provider: ProviderSchema,
  /** The id the gateway knows the mandate by; charges are raised against it. `activate` may replace it. */
  subscriptionId: z.string().min(1),
  reference: z.string().min(1).optional(),
  status: ScheduleStatusSchema,
  statusReason: ScheduleStatusReasonSchema.optional(),
  /** Amount of cycles that have not been notified yet, in paise. */
  amount: PositivePaiseSchema,
  currency: CurrencySchema,
  interval: BillingIntervalSchema,
  totalCycles: z.number().int().positive().optional(),
  customer: CustomerSchema.optional(),
  metadata: MetadataSchema.optional(),
  policy: SchedulePolicySchema,
  /** Hash of the registration input, so registering the same data again is a no-op. */
  fingerprint: z.string(),
  /** Cycle `anchorIndex` is due at `anchorAt`; later cycles follow from it via `cycleStart`. */
  anchorAt: IsoDateTimeSchema,
  anchorIndex: z.number().int().nonnegative(),
  /** The cycle being worked on (0-based). */
  cycleIndex: z.number().int().nonnegative(),
  /** Number of cycles collected so far. */
  paidCycles: z.number().int().nonnegative(),
  /** When the next cycle is due to be debited. Absent when nothing is scheduled (paused, cancelled, completed, halted, awaiting authorisation). */
  nextChargeAt: IsoDateTimeSchema.optional(),
  /**
   * When `tick()` next needs to look at this schedule; absent when it needs no
   * attention. This is the only field the store queries by.
   */
  nextActionAt: IsoDateTimeSchema.optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  activatedAt: IsoDateTimeSchema.optional(),
  endedAt: IsoDateTimeSchema.optional(),
});
export type ScheduleRecord = z.infer<typeof ScheduleRecordSchema>;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export const RegisterScheduleInputSchema = z
  .object({
    /** Defaults to `subscriptionId`. */
    id: z.string().min(1).optional(),
    provider: ProviderSchema,
    subscriptionId: z.string().min(1),
    reference: z.string().min(1).optional(),
    /** Amount per cycle, in paise. */
    amount: PositivePaiseSchema,
    currency: CurrencySchema.default(Currency.INR),
    interval: BillingIntervalSchema,
    /** When the first charge is due; for a free trial, the instant the trial ends. */
    firstChargeAt: IsoDateTimeSchema,
    /** Omit to bill until cancelled. */
    totalCycles: z.number().int().positive().optional(),
    customer: CustomerSchema.optional(),
    metadata: MetadataSchema.optional(),
    /** Store the schedule as `pending_authorization`; `tick()` ignores it until `activate`. */
    awaitingAuthorization: z.boolean().optional(),
  })
  .extend(SchedulePolicyOverridesSchema.shape);
export type RegisterScheduleInput = z.input<typeof RegisterScheduleInputSchema>;
export type ParsedRegisterScheduleInput = z.output<typeof RegisterScheduleInputSchema>;

export const ActivateScheduleInputSchema = z.object({
  /** Replaces the stored gateway subscription id (the schedule's own `id` stays the same). */
  subscriptionId: z.string().min(1).optional(),
  /** Replaces the anchor. Without it, a past anchor becomes the activation instant. */
  firstChargeAt: IsoDateTimeSchema.optional(),
});
export type ActivateScheduleInput = z.input<typeof ActivateScheduleInputSchema>;

export const ResumeScheduleInputSchema = z.object({
  /** When the next cycle is due. Without it the schedule continues unchanged, or from now if the pause swallowed the due date. */
  nextChargeAt: IsoDateTimeSchema.optional(),
  /**
   * For a halted schedule whose current cycle failed: skip that cycle and continue
   * from the next one, instead of re-opening it for another round of attempts.
   */
  skipFailedCycle: z.boolean().optional(),
});
export type ResumeScheduleInput = z.input<typeof ResumeScheduleInputSchema>;

export const TickOptionsSchema = z.object({
  /** Maximum schedules examined in this tick. */
  limit: z.number().int().min(1).default(DEFAULT_TICK_LIMIT),
  /** Schedules processed in parallel. */
  concurrency: z.number().int().min(1).default(DEFAULT_TICK_CONCURRENCY),
});
export type TickOptions = z.input<typeof TickOptionsSchema>;

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export const SchedulerEventSchema = z.object({
  type: SchedulerEventTypeSchema,
  at: IsoDateTimeSchema,
  scheduleId: z.string(),
  provider: ProviderSchema,
  subscriptionId: z.string(),
  scheduleStatus: ScheduleStatusSchema,
  reason: ScheduleStatusReasonSchema.optional(),
  cycleIndex: z.number().int().nonnegative().optional(),
  attempt: z.number().int().min(1).optional(),
  chargeId: z.string().optional(),
  amount: PaiseSchema.optional(),
  error: z.object({ code: ErrorCodeSchema, message: z.string() }).optional(),
});
export type SchedulerEvent = z.infer<typeof SchedulerEventSchema>;

export const TickErrorSchema = z.object({
  scheduleId: z.string(),
  code: ErrorCodeSchema,
  message: z.string(),
});
export type TickError = z.infer<typeof TickErrorSchema>;

/** What one `tick()` did. A failing schedule shows up in `errors`; the others are unaffected. */
export const TickResultSchema = z.object({
  at: IsoDateTimeSchema,
  /** Schedules the store reported as due. */
  due: z.number().int().nonnegative(),
  /** Due schedules skipped because another worker held their lock. */
  locked: z.number().int().nonnegative(),
  /** Pre-debit notifications accepted by the gateway. */
  notified: z.number().int().nonnegative(),
  /** `createCharge` calls made. */
  charged: z.number().int().nonnegative(),
  /** `getCharge` reconciliations made. */
  reconciled: z.number().int().nonnegative(),
  /** Cycles that became collected. */
  succeeded: z.number().int().nonnegative(),
  /** Debit attempts that failed. */
  failed: z.number().int().nonnegative(),
  /** Cycles left waiting for the gateway's final answer. */
  awaiting: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  halted: z.number().int().nonnegative(),
  /** Pending-authorisation schedules cancelled by their timeout. */
  expired: z.number().int().nonnegative(),
  errors: z.array(TickErrorSchema),
});
export type TickResult = z.infer<typeof TickResultSchema>;
