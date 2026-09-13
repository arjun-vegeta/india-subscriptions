/**
 * Typed constants for the billing scheduler. Same pattern as `src/constants.ts`:
 * an `as const` object plus a union type of the same name. Code must reference
 * these, never the bare literals.
 */

/** Lifecycle of one scheduled subscription. */
export const ScheduleStatus = {
  /**
   * Registered, but the customer has not authorised the mandate yet. `tick()`
   * never notifies or charges a schedule in this state; it only enforces the
   * optional authorisation timeout.
   */
  PendingAuthorization: 'pending_authorization',
  /** Billing: `tick()` advances the current cycle. */
  Active: 'active',
  /** Billing suspended by the merchant or the gateway; can be resumed. */
  Paused: 'paused',
  /** Stopped. Terminal. */
  Cancelled: 'cancelled',
  /** Every cycle (`totalCycles`) was collected. Terminal. */
  Completed: 'completed',
  /** A cycle exhausted its attempts, or the gateway halted the mandate. No further charges. */
  Halted: 'halted',
} as const;
export type ScheduleStatus = (typeof ScheduleStatus)[keyof typeof ScheduleStatus];

/** Why a schedule is in its current status, for dashboards and audit logs. */
export const ScheduleStatusReason = {
  AuthorizationTimeout: 'authorization_timeout',
  AuthorizationFailed: 'authorization_failed',
  MandateExpired: 'mandate_expired',
  CancelledByMerchant: 'cancelled_by_merchant',
  CancelledByGateway: 'cancelled_by_gateway',
  PausedByMerchant: 'paused_by_merchant',
  PausedByGateway: 'paused_by_gateway',
  HaltedByGateway: 'halted_by_gateway',
  RetriesExhausted: 'retries_exhausted',
  AllCyclesCollected: 'all_cycles_collected',
} as const;
export type ScheduleStatusReason = (typeof ScheduleStatusReason)[keyof typeof ScheduleStatusReason];

/** Where one billing cycle is in the notify -> charge state machine. */
export const CycleStatus = {
  /** Waiting for the pre-debit notification time (or the due time, if no notification is needed). */
  Pending: 'pending',
  /** The gateway accepted the pre-debit notification; waiting for the debit time. */
  Notified: 'notified',
  /**
   * Persisted BEFORE `createCharge` is called. A cycle found in this state at the
   * start of a tick means the outcome of the debit is unknown and must be
   * reconciled with `getCharge`.
   */
  Charging: 'charging',
  /** The gateway accepted the debit but has not reported the final result. */
  AwaitingConfirmation: 'awaiting_confirmation',
  Succeeded: 'succeeded',
  /** Every attempt failed. The schedule is halted. */
  Failed: 'failed',
  /** Never debited (the schedule was cancelled first). */
  Skipped: 'skipped',
} as const;
export type CycleStatus = (typeof CycleStatus)[keyof typeof CycleStatus];

/** Cycle states in which money may be moving: the gateway must be asked, never re-charged blindly. */
export const IN_FLIGHT_CYCLE_STATUSES: readonly CycleStatus[] = [
  CycleStatus.Charging,
  CycleStatus.AwaitingConfirmation,
];

export const TERMINAL_SCHEDULE_STATUSES: readonly ScheduleStatus[] = [
  ScheduleStatus.Cancelled,
  ScheduleStatus.Completed,
  ScheduleStatus.Halted,
];

/** Events handed to `onEvent`. */
export const SchedulerEventType = {
  ScheduleRegistered: 'schedule.registered',
  ScheduleActivated: 'schedule.activated',
  SchedulePaused: 'schedule.paused',
  ScheduleResumed: 'schedule.resumed',
  ScheduleCancelled: 'schedule.cancelled',
  ScheduleCompleted: 'schedule.completed',
  ScheduleHalted: 'schedule.halted',
  NotificationSent: 'notification.sent',
  NotificationFailed: 'notification.failed',
  /** A debit succeeded. */
  ChargeSucceeded: 'charge.succeeded',
  /** One attempt failed (a retry may follow; `cycle.failed` means none will). */
  ChargeFailed: 'charge.failed',
  /** A `createCharge`/`getCharge` call ended without a definite answer; it will be reconciled. */
  ChargeOutcomeUnknown: 'charge.outcome_unknown',
  CycleFailed: 'cycle.failed',
  CycleSkipped: 'cycle.skipped',
} as const;
export type SchedulerEventType = (typeof SchedulerEventType)[keyof typeof SchedulerEventType];

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** How long before the debit the pre-debit notification is sent. */
export const DEFAULT_NOTIFY_LEAD_HOURS = 48;
/** RBI: at least 24 hours between an accepted notification and the debit. */
export const DEFAULT_MIN_NOTICE_HOURS = 24;
/** Debit attempts per cycle before the cycle fails and the schedule halts. */
export const DEFAULT_MAX_ATTEMPTS = 3;
/** Wait between a failed attempt and the next one. */
export const DEFAULT_RETRY_INTERVAL_HOURS = 24;
/**
 * How long a per-schedule lock is held if its owner dies. It must exceed the
 * longest time one schedule can spend in a tick (a few gateway round-trips).
 */
export const DEFAULT_LOCK_TTL_MS = 60_000;
/** How long `pause`/`resume`/`cancel`/`activate`/`handleEvent` wait for a busy lock before throwing CONFLICT. */
export const DEFAULT_LOCK_WAIT_MS = 5_000;
/** Poll interval while waiting for a lock. */
export const LOCK_POLL_INTERVAL_MS = 25;
/** Schedules examined per `tick()` unless the caller passes a limit. */
export const DEFAULT_TICK_LIMIT = 100;
/** Schedules processed in parallel inside one `tick()`. */
export const DEFAULT_TICK_CONCURRENCY = 5;
/** Safety cap on state transitions for one schedule in one tick. */
export const MAX_STEPS_PER_SCHEDULE_PER_TICK = 16;

export const HOUR_MS = 60 * 60 * 1000;

/** Deterministic id prefixes sent to gateways (alphanumerics and underscores only). */
export const SchedulerIdPrefix = {
  Charge: 'chg',
  Notification: 'ntf',
} as const;
export type SchedulerIdPrefix = (typeof SchedulerIdPrefix)[keyof typeof SchedulerIdPrefix];
export const ID_SEPARATOR = '_';
/** Hex characters of the schedule-id hash used inside gateway ids (gateway ids are length-limited). */
export const ID_HASH_LENGTH = 16;

/** Keys the scheduler adds to the metadata of the charges it raises. */
export const ChargeMetadataKey = {
  ScheduleId: 'schedule_id',
  Cycle: 'cycle',
  Attempt: 'attempt',
} as const;
export type ChargeMetadataKey = (typeof ChargeMetadataKey)[keyof typeof ChargeMetadataKey];
