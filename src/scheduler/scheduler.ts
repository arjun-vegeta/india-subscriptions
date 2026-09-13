import { ChargeStatus, DigestEncoding, ErrorCode, HashAlgorithm, type Provider } from '../constants.js';
import { hash } from '../crypto.js';
import { SubscriptionError, parseInput, unsupported } from '../errors.js';
import type { SubscriptionProvider } from '../provider.js';
import { PositivePaiseSchema, type Charge, type ChargeNotification, type SubscriptionEvent } from '../schemas.js';
import { cycleStart, toDate, toIso } from '../time.js';
import { EventType } from '../constants.js';
import {
  ChargeMetadataKey,
  ChargeTiming,
  CycleStatus,
  HOUR_MS,
  ID_HASH_LENGTH,
  ID_SEPARATOR,
  IN_FLIGHT_CYCLE_STATUSES,
  LOCK_POLL_INTERVAL_MS,
  MAX_STEPS_PER_SCHEDULE_PER_TICK,
  ScheduleStatus,
  ScheduleStatusReason,
  SchedulerEventType,
  SchedulerIdPrefix,
} from './constants.js';
import {
  ActivateScheduleInputSchema,
  RegisterScheduleInputSchema,
  ResumeScheduleInputSchema,
  SchedulerConfigSchema,
  TickOptionsSchema,
  type ActivateScheduleInput,
  type CycleRecord,
  type RegisterScheduleInput,
  type ResumeScheduleInput,
  type ScheduleRecord,
  type SchedulePolicy,
  type SchedulerConfig,
  type SchedulerConfigInput,
  type SchedulerEvent,
  type TickOptions,
  type TickResult,
} from './schemas.js';
import type { SchedulerStore } from './store.js';

export interface SchedulerOptions extends SchedulerConfigInput {
  store: SchedulerStore;
  /** Returns the gateway adapter for a provider. The scheduler only ever talks to the `SubscriptionProvider` interface. */
  resolveProvider: (provider: Provider) => SubscriptionProvider;
  /** Clock override for tests. */
  now?: () => Date;
  /**
   * Called after each state change has been persisted. Errors it throws are
   * swallowed: a broken listener can never affect billing. It may be called more
   * than once for the same change if a worker crashes between persisting and
   * emitting, so make listeners idempotent.
   */
  onEvent?: (event: SchedulerEvent) => void | Promise<void>;
}

/** How a gateway wants debits raised (see `ChargeTiming`). */
interface Timing {
  kind: ChargeTiming;
  /** Hours (as ms) ahead of the debit date a charge must be raised (`ChargeInAdvance` only). */
  leadMs: number;
  /** Furthest ahead (as ms) a charge may be scheduled, when the gateway limits it. */
  maxAheadMs?: number;
}

/** What a gateway said about a failed debit attempt. */
interface Failure {
  status: ChargeStatus;
  code: string;
  reason?: string;
}

/**
 * Billing engine for merchant-scheduled mandates.
 *
 * Some mandates (PayU, Cashfree on-demand plans) leave every recurring debit to
 * the merchant, who must also send the customer a pre-debit notification at
 * least 24 hours ahead. `BillingScheduler` does both, so such subscriptions
 * behave like gateway-scheduled ones: free trials, fixed cycles, retries,
 * pause/resume/cancel. Call {@link BillingScheduler.tick} from a cron job; it
 * does whatever is due, exactly once, even with several workers.
 *
 * ## How a cycle runs
 *
 * ```
 * pending --notify--> notified --debit--> charging --> succeeded
 *    ^                                       |  \--> awaiting_confirmation --> succeeded
 *    |                                       v
 *    +------- retry after retryIntervalHours (failed) ----> failed (after maxAttempts) => schedule halted
 * ```
 *
 * ## Why it never double-debits
 *
 * - The debit id is deterministic per (schedule, cycle, attempt).
 * - The cycle is persisted as `charging` with that id BEFORE the gateway is called.
 * - Whenever the outcome is unknown (crash, timeout, `OUTCOME_UNKNOWN`), the
 *   next tick asks the gateway with `getCharge`. Only a `NOT_FOUND` answer lets
 *   it call `createCharge` again, and then with the same id.
 * - Every state change happens under a per-schedule lock, after re-reading the
 *   schedule, so two workers can never both act on one schedule.
 *
 * Merchants should also cancel the mandate at the gateway when they `cancel`
 * a schedule: the scheduler stops raising debits but does not call the
 * gateway's cancel API.
 */
export class BillingScheduler {
  private readonly store: SchedulerStore;
  private readonly providerFor: (provider: Provider) => SubscriptionProvider;
  private readonly clock: () => Date;
  private readonly onEvent?: (event: SchedulerEvent) => void | Promise<void>;
  private readonly config: SchedulerConfig;

  constructor(options: SchedulerOptions) {
    this.config = parseInput(SchedulerConfigSchema, options, 'scheduler options');
    this.store = options.store;
    this.providerFor = options.resolveProvider;
    this.clock = options.now ?? (() => new Date());
    this.onEvent = options.onEvent;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /** The schedule with this id, or `undefined` when there is none. */
  get(id: string): Promise<ScheduleRecord | undefined> {
    return this.store.getSchedule(id);
  }

  /** The schedule currently using this gateway subscription id, or `undefined`. */
  findBySubscriptionId(provider: Provider, subscriptionId: string): Promise<ScheduleRecord | undefined> {
    return this.store.findBySubscriptionId(provider, subscriptionId);
  }

  /** Every cycle of a schedule, oldest first. */
  listCycles(id: string): Promise<CycleRecord[]> {
    return this.store.listCycles(id);
  }

  // -------------------------------------------------------------------------
  // Registration and lifecycle
  // -------------------------------------------------------------------------

  /**
   * Registers a schedule. The id defaults to `subscriptionId`. Registering the
   * same id again with the same data returns the existing record; with different
   * data it throws `CONFLICT`. With `awaitingAuthorization` the schedule waits as
   * `pending_authorization` (ignored by `tick`) until {@link activate} or a
   * `subscription.authorized` event arrives.
   */
  async register(input: RegisterScheduleInput): Promise<ScheduleRecord> {
    const parsed = parseInput(RegisterScheduleInputSchema, input, 'schedule registration', input?.provider);
    const provider = this.providerFor(parsed.provider);
    if (!provider.capabilities.merchantCharges) {
      throw unsupported(
        parsed.provider,
        'merchant-raised charges',
        'the gateway raises the debits itself, so there is nothing for the scheduler to do',
      );
    }
    const id = parsed.id ?? parsed.subscriptionId;
    const firstChargeAt = toIso(toDate(parsed.firstChargeAt, 'firstChargeAt'));
    const fingerprint = hash(
      HashAlgorithm.Sha256,
      stableStringify({ ...parsed, id, firstChargeAt }),
      DigestEncoding.Hex,
    );

    return this.withLock(id, async () => {
      const existing = await this.store.getSchedule(id);
      if (existing) {
        if (existing.fingerprint === fingerprint) return existing;
        throw new SubscriptionError(
          ErrorCode.Conflict,
          `A schedule with id "${id}" is already registered with different data`,
          { provider: parsed.provider },
        );
      }

      const now = this.now();
      const nowIso = toIso(now);
      const policy: SchedulePolicy = {
        notifyLeadHours: parsed.notifyLeadHours ?? this.config.notifyLeadHours,
        minNoticeHours: parsed.minNoticeHours ?? this.config.minNoticeHours,
        maxAttempts: parsed.maxAttempts ?? this.config.maxAttempts,
        retryIntervalHours: parsed.retryIntervalHours ?? this.config.retryIntervalHours,
      };
      const chargeLeadHours = parsed.chargeLeadHours ?? this.config.chargeLeadHours;
      if (chargeLeadHours !== undefined) policy.chargeLeadHours = chargeLeadHours;
      const authorizationTimeoutHours = parsed.authorizationTimeoutHours ?? this.config.authorizationTimeoutHours;
      if (authorizationTimeoutHours !== undefined) policy.authorizationTimeoutHours = authorizationTimeoutHours;

      const schedule: ScheduleRecord = {
        id,
        provider: parsed.provider,
        subscriptionId: parsed.subscriptionId,
        status: parsed.awaitingAuthorization ? ScheduleStatus.PendingAuthorization : ScheduleStatus.Active,
        amount: parsed.amount,
        currency: parsed.currency,
        interval: parsed.interval,
        policy,
        fingerprint,
        anchorAt: firstChargeAt,
        anchorIndex: 0,
        cycleIndex: 0,
        paidCycles: 0,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      if (parsed.reference !== undefined) schedule.reference = parsed.reference;
      if (parsed.totalCycles !== undefined) schedule.totalCycles = parsed.totalCycles;
      if (parsed.customer !== undefined) schedule.customer = parsed.customer;
      if (parsed.metadata !== undefined) schedule.metadata = parsed.metadata;

      let cycle: CycleRecord | undefined;
      if (schedule.status === ScheduleStatus.Active) {
        schedule.activatedAt = nowIso;
        cycle = this.newCycle(schedule, 0, now);
        await this.store.saveCycle(cycle);
      }
      this.plan(schedule, cycle, now);
      await this.store.saveSchedule(schedule);
      await this.emit(SchedulerEventType.ScheduleRegistered, schedule);
      return schedule;
    });
  }

  /**
   * Moves a `pending_authorization` schedule to `active`. `subscriptionId`
   * replaces the stored gateway id (the schedule's own `id` is unchanged);
   * `firstChargeAt` replaces the anchor, and without it a past anchor becomes
   * the activation instant. Activating an active schedule with the same data is
   * a no-op; on any other status it throws `CONFLICT`.
   */
  activate(id: string, input: ActivateScheduleInput = {}): Promise<ScheduleRecord> {
    const parsed = parseInput(ActivateScheduleInputSchema, input, 'activation');
    return this.mutate(id, (schedule) => this.activateLocked(schedule, parsed));
  }

  /** Stops billing without ending the schedule. A debit already in flight is still reconciled. */
  pause(id: string): Promise<ScheduleRecord> {
    return this.mutate(id, (schedule) => this.pauseLocked(schedule, ScheduleStatusReason.PausedByMerchant));
  }

  /**
   * Resumes a paused schedule. The remaining cycles are re-anchored at
   * `nextChargeAt`, or at the current instant if the pause swallowed the due
   * date; cycles that fell due while paused are never billed retroactively.
   * A pre-debit notification already sent for a date that changed is redone.
   */
  resume(id: string, input: ResumeScheduleInput = {}): Promise<ScheduleRecord> {
    const parsed = parseInput(ResumeScheduleInputSchema, input, 'resume options');
    return this.mutate(id, (schedule) => this.resumeLocked(schedule, parsed.nextChargeAt));
  }

  /**
   * Cancels the schedule (also while it awaits authorisation). No further
   * notifications or debits; a debit already in flight is still reconciled.
   * Idempotent. Throws `CONFLICT` for a completed schedule.
   */
  cancel(id: string): Promise<ScheduleRecord> {
    return this.mutate(id, (schedule) => this.cancelLocked(schedule, ScheduleStatusReason.CancelledByMerchant));
  }

  /** Sets the amount (paise) for cycles that have not been notified yet. */
  updateAmount(id: string, amount: number): Promise<ScheduleRecord> {
    const parsed = parseInput(PositivePaiseSchema, amount, 'amount');
    return this.mutate(id, async (schedule) => {
      if (this.isTerminal(schedule)) {
        throw new SubscriptionError(ErrorCode.Conflict, `Schedule "${id}" is ${schedule.status}; its amount cannot change`);
      }
      schedule.amount = parsed;
      schedule.updatedAt = toIso(this.now());
      await this.store.saveSchedule(schedule);
      return schedule;
    });
  }

  // -------------------------------------------------------------------------
  // tick
  // -------------------------------------------------------------------------

  /**
   * Does whatever is due: sends notifications, raises debits, reconciles debits
   * whose outcome is unknown, retries failed attempts, expires unauthorised
   * schedules. Safe to call from several workers and as often as you like: with
   * nothing due it makes no gateway calls. One failing schedule is reported in
   * `errors` and never stops the others.
   */
  async tick(options: TickOptions = {}): Promise<TickResult> {
    const { limit, concurrency } = parseInput(TickOptionsSchema, options, 'tick options');
    const result = this.emptyResult();
    const due = await this.store.listDueSchedules(result.at, limit);
    result.due = due.length;

    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < due.length) {
        const schedule = due[next++];
        if (schedule) await this.tickOne(schedule.id, result);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, due.length) }, worker));
    return result;
  }

  private async tickOne(id: string, result: TickResult): Promise<void> {
    let token: string | undefined;
    try {
      token = await this.store.acquireLock(id, this.config.lockTtlMs);
    } catch (error) {
      this.pushError(result, id, error);
      return;
    }
    if (token === undefined) {
      result.locked += 1;
      return;
    }
    try {
      // Re-read under the lock: the listed copy may be stale, and another
      // worker may have handled this schedule since it was listed.
      const schedule = await this.store.getSchedule(id);
      if (!schedule || schedule.nextActionAt === undefined) return;
      if (Date.parse(schedule.nextActionAt) > this.now().getTime()) return;
      await this.process(schedule, result);
    } catch (error) {
      this.pushError(result, id, error);
    } finally {
      await this.releaseQuietly(id, token);
    }
  }

  private async process(schedule: ScheduleRecord, result: TickResult): Promise<void> {
    if (schedule.status === ScheduleStatus.PendingAuthorization) {
      await this.expireIfUnauthorized(schedule, result);
      return;
    }

    for (let steps = 0; steps < MAX_STEPS_PER_SCHEDULE_PER_TICK; steps++) {
      const cycle = await this.currentCycle(schedule, schedule.status === ScheduleStatus.Active);
      if (!cycle) break;
      if (!(await this.step(schedule, cycle, result))) break;
    }

    const cycle = await this.store.getCycle(schedule.id, schedule.cycleIndex);
    const now = this.now();
    if (this.plan(schedule, cycle, now)) {
      schedule.updatedAt = toIso(now);
      await this.store.saveSchedule(schedule);
    }
  }

  private async expireIfUnauthorized(schedule: ScheduleRecord, result: TickResult): Promise<void> {
    const timeout = schedule.policy.authorizationTimeoutHours;
    if (timeout === undefined) return;
    const deadline = Date.parse(schedule.createdAt) + timeout * HOUR_MS;
    if (this.now().getTime() < deadline) return;
    await this.cancelLocked(schedule, ScheduleStatusReason.AuthorizationTimeout);
    result.expired += 1;
  }

  // -------------------------------------------------------------------------
  // The cycle state machine
  // -------------------------------------------------------------------------

  /** Advances one cycle by one transition. Returns true when the loop should look at the schedule again. */
  private async step(schedule: ScheduleRecord, cycle: CycleRecord, result: TickResult): Promise<boolean> {
    switch (cycle.status) {
      case CycleStatus.Succeeded:
        // Recovery: a crash after the cycle was saved but before the schedule's pointer moved.
        return this.advancePointer(schedule, cycle, result);
      case CycleStatus.Skipped:
        return false;
      case CycleStatus.Failed:
        if (schedule.status === ScheduleStatus.Active) {
          await this.halt(schedule, ScheduleStatusReason.RetriesExhausted, result);
        }
        return false;
      case CycleStatus.Charging:
        return this.reconcile(schedule, cycle, result);
      case CycleStatus.AwaitingConfirmation:
        // A charge scheduled for a future date cannot have an outcome yet: do not poll before then.
        if (cycle.scheduledAt !== undefined && this.now().getTime() < Date.parse(cycle.scheduledAt)) return false;
        return this.reconcile(schedule, cycle, result);
      default:
        break;
    }
    if (schedule.status !== ScheduleStatus.Active) return false;

    const now = this.now();
    const provider = this.providerFor(schedule.provider);

    if (cycle.status === CycleStatus.Pending) {
      const timing = this.timing(schedule, provider);
      if (now.getTime() < this.actionTime(cycle, schedule.policy, timing)) return false;
      if (timing.kind === ChargeTiming.NotifyThenCharge) return this.notify(schedule, cycle, provider, result);
      return this.startCharge(schedule, cycle, timing, result);
    }

    // Notified: the debit may go out once both the due time and the minimum notice have passed.
    if (now.getTime() < this.earliestDebit(cycle, schedule.policy)) return false;
    return this.startCharge(schedule, cycle, this.timing(schedule, provider), result);
  }

  /** Which of the three gateway styles applies, and its lead time in milliseconds. */
  private timing(schedule: ScheduleRecord, provider: SubscriptionProvider): Timing {
    const capabilities = provider.capabilities;
    if (capabilities.merchantPreDebitNotification) return { kind: ChargeTiming.NotifyThenCharge, leadMs: 0 };
    const gatewayLead = capabilities.merchantChargeLeadHours ?? 0;
    if (gatewayLead > 0) {
      const leadHours = Math.max(gatewayLead, schedule.policy.chargeLeadHours ?? 0);
      const maxAhead = capabilities.merchantChargeMaxAheadHours;
      return {
        kind: ChargeTiming.ChargeInAdvance,
        leadMs: leadHours * HOUR_MS,
        ...(maxAhead !== undefined ? { maxAheadMs: maxAhead * HOUR_MS } : {}),
      };
    }
    return { kind: ChargeTiming.ChargeOnDue, leadMs: 0 };
  }

  /** When a pending cycle's next action (notify, or raise the charge) becomes due, in epoch ms. */
  private actionTime(cycle: CycleRecord, policy: SchedulePolicy, timing: Timing): number {
    const due = Date.parse(cycle.attemptDueAt);
    switch (timing.kind) {
      case ChargeTiming.NotifyThenCharge:
        return due - policy.notifyLeadHours * HOUR_MS;
      case ChargeTiming.ChargeInAdvance:
        // Never earlier than the gateway allows a charge to be scheduled ahead.
        return Math.max(due - timing.leadMs, timing.maxAheadMs !== undefined ? due - timing.maxAheadMs : -Infinity);
      case ChargeTiming.ChargeOnDue:
        return due;
    }
  }

  private async notify(
    schedule: ScheduleRecord,
    cycle: CycleRecord,
    provider: SubscriptionProvider,
    result: TickResult,
  ): Promise<boolean> {
    const amount = cycle.amount ?? schedule.amount;
    const notificationId = this.notificationId(schedule, cycle);
    const debitAt = new Date(
      Math.max(Date.parse(cycle.attemptDueAt), this.now().getTime() + schedule.policy.minNoticeHours * HOUR_MS),
    );

    let notification: ChargeNotification;
    try {
      notification = await provider.notifyCharge({
        subscriptionId: schedule.subscriptionId,
        notificationId,
        amount,
        debitAt: toIso(debitAt),
      });
    } catch (error) {
      await this.recordError(
        schedule,
        cycle,
        asSubscriptionError(error, ErrorCode.ProviderError),
        SchedulerEventType.NotificationFailed,
        result,
      );
      return false;
    }
    if (!notification.accepted) {
      const rejected = new SubscriptionError(
        ErrorCode.ProviderError,
        `${schedule.provider} did not accept the pre-debit notification (status: ${notification.providerStatus ?? 'unknown'})`,
        { provider: schedule.provider },
      );
      await this.recordError(schedule, cycle, rejected, SchedulerEventType.NotificationFailed, result);
      return false;
    }

    const notifiedAt = this.now();
    cycle.status = CycleStatus.Notified;
    cycle.amount = amount;
    cycle.notificationId = notificationId;
    if (notification.invoiceNumber !== undefined) cycle.invoiceNumber = notification.invoiceNumber;
    cycle.notifiedAt = toIso(notifiedAt);
    cycle.debitAt = toIso(debitAt);
    delete cycle.lastError;
    cycle.updatedAt = cycle.notifiedAt;
    await this.store.saveCycle(cycle);
    result.notified += 1;
    await this.emit(SchedulerEventType.NotificationSent, schedule, this.cycleFields(cycle));
    return true;
  }

  /** Persists `charging` + the deterministic charge id, and only then calls the gateway. */
  private async startCharge(
    schedule: ScheduleRecord,
    cycle: CycleRecord,
    timing: Timing,
    result: TickResult,
  ): Promise<boolean> {
    const now = this.now();
    const nowIso = toIso(now);
    cycle.amount ??= schedule.amount;
    cycle.chargeId = this.chargeId(schedule, cycle);
    cycle.status = CycleStatus.Charging;
    cycle.chargeRequestedAt = nowIso;
    if (timing.kind === ChargeTiming.ChargeInAdvance) {
      // The debit date: the due date, or the earliest legal one when we are already too close to it.
      cycle.scheduledAt = toIso(new Date(Math.max(Date.parse(cycle.attemptDueAt), now.getTime() + timing.leadMs)));
    }
    cycle.updatedAt = nowIso;
    await this.store.saveCycle(cycle);
    schedule.nextActionAt = nowIso;
    schedule.updatedAt = nowIso;
    await this.store.saveSchedule(schedule);
    return this.submitCharge(schedule, cycle, result);
  }

  /** Calls `createCharge` for a cycle that is already persisted as `charging`. */
  private async submitCharge(schedule: ScheduleRecord, cycle: CycleRecord, result: TickResult): Promise<boolean> {
    const provider = this.providerFor(schedule.provider);
    const timing = this.timing(schedule, provider);
    if (timing.kind === ChargeTiming.ChargeInAdvance) {
      // A resubmission after a lost answer may be later than the original: never send a date that is now too close.
      const earliest = this.now().getTime() + timing.leadMs;
      const planned = cycle.scheduledAt !== undefined ? Date.parse(cycle.scheduledAt) : earliest;
      const scheduledAt = toIso(new Date(Math.max(planned, earliest)));
      if (cycle.scheduledAt !== scheduledAt) {
        cycle.scheduledAt = scheduledAt;
        await this.store.saveCycle(cycle);
      }
    }
    let charge: Charge;
    result.charged += 1;
    try {
      charge = await provider.createCharge({
        subscriptionId: schedule.subscriptionId,
        chargeId: cycle.chargeId as string,
        amount: cycle.amount as number,
        ...(timing.kind === ChargeTiming.ChargeInAdvance && cycle.scheduledAt !== undefined
          ? { scheduledAt: cycle.scheduledAt }
          : {}),
        ...(cycle.invoiceNumber !== undefined ? { invoiceNumber: cycle.invoiceNumber } : {}),
        ...(schedule.customer !== undefined ? { customer: schedule.customer } : {}),
        metadata: {
          ...schedule.metadata,
          [ChargeMetadataKey.ScheduleId]: schedule.id,
          [ChargeMetadataKey.Cycle]: String(cycle.index + 1),
          [ChargeMetadataKey.Attempt]: String(cycle.attempt),
        },
      });
    } catch (error) {
      const failure = asSubscriptionError(error, ErrorCode.OutcomeUnknown);
      if (isDefiniteRejection(failure)) {
        // The gateway answered and refused: no debit exists, so this attempt failed.
        return this.settleFailure(
          schedule,
          cycle,
          { status: ChargeStatus.Failed, code: failure.providerCode ?? failure.code, reason: failure.message },
          result,
        );
      }
      // Anything else may or may not have reached the bank. Stay `charging`; the next tick asks the gateway.
      await this.recordError(schedule, cycle, failure, SchedulerEventType.ChargeOutcomeUnknown, result);
      return false;
    }
    return this.applyCharge(schedule, cycle, charge, result);
  }

  /** Asks the gateway what happened to a debit whose outcome is not known. */
  private async reconcile(schedule: ScheduleRecord, cycle: CycleRecord, result: TickResult): Promise<boolean> {
    const provider = this.providerFor(schedule.provider);
    const chargeId = cycle.chargeId ?? this.chargeId(schedule, cycle);
    result.reconciled += 1;

    let charge: Charge;
    try {
      charge = await provider.getCharge(schedule.subscriptionId, chargeId);
    } catch (error) {
      const failure = asSubscriptionError(error, ErrorCode.ProviderError);
      if (failure.code === ErrorCode.NotFound && cycle.status === CycleStatus.Charging) {
        // The gateway has never seen this debit, so asking again with the same id cannot double-debit.
        if (schedule.status === ScheduleStatus.Active) return this.submitCharge(schedule, cycle, result);
        return this.dropUnsentCharge(schedule, cycle);
      }
      await this.recordError(schedule, cycle, failure, SchedulerEventType.ChargeOutcomeUnknown, result);
      return false;
    }
    return this.applyCharge(schedule, cycle, charge, result);
  }

  /** A `charging` cycle that never reached the gateway, on a schedule that must not debit any more. */
  private async dropUnsentCharge(schedule: ScheduleRecord, cycle: CycleRecord): Promise<boolean> {
    const now = this.now();
    if (schedule.status === ScheduleStatus.Paused) {
      // Keep the cycle for after the resume: it needs a fresh notification, and the same attempt number.
      this.clearAttemptState(cycle, true);
      cycle.status = CycleStatus.Pending;
      cycle.updatedAt = toIso(now);
      await this.store.saveCycle(cycle);
      return false;
    }
    cycle.status = CycleStatus.Skipped;
    cycle.completedAt = toIso(now);
    cycle.updatedAt = cycle.completedAt;
    await this.store.saveCycle(cycle);
    this.plan(schedule, cycle, now);
    schedule.updatedAt = toIso(now);
    await this.store.saveSchedule(schedule);
    await this.emit(SchedulerEventType.CycleSkipped, schedule, this.cycleFields(cycle));
    return false;
  }

  private applyCharge(
    schedule: ScheduleRecord,
    cycle: CycleRecord,
    charge: Charge,
    result: TickResult,
  ): Promise<boolean> {
    switch (charge.status) {
      case ChargeStatus.Succeeded:
      case ChargeStatus.Refunded:
      case ChargeStatus.PartiallyRefunded:
        return this.settleSuccess(schedule, cycle, charge, result);
      case ChargeStatus.Failed:
      case ChargeStatus.Cancelled:
        return this.settleFailure(
          schedule,
          cycle,
          {
            status: charge.status,
            code: charge.failureCode ?? charge.providerStatus ?? charge.status,
            ...(charge.failureReason !== undefined ? { reason: charge.failureReason } : {}),
          },
          result,
        );
      case ChargeStatus.Pending:
      case ChargeStatus.Scheduled:
        return this.markAwaiting(cycle, charge, result);
    }
  }

  private async markAwaiting(cycle: CycleRecord, charge: Charge, result: TickResult): Promise<boolean> {
    if (cycle.status !== CycleStatus.AwaitingConfirmation || cycle.providerChargeId !== charge.id) {
      if (cycle.status !== CycleStatus.AwaitingConfirmation) result.awaiting += 1;
      cycle.status = CycleStatus.AwaitingConfirmation;
      cycle.providerChargeId = charge.id;
      delete cycle.lastError;
      cycle.updatedAt = toIso(this.now());
      await this.store.saveCycle(cycle);
    }
    return false;
  }

  private async settleSuccess(
    schedule: ScheduleRecord,
    cycle: CycleRecord,
    charge: Charge,
    result: TickResult,
  ): Promise<boolean> {
    const nowIso = toIso(this.now());
    cycle.attempts.push({
      attempt: cycle.attempt,
      chargeId: cycle.chargeId ?? charge.reference ?? charge.id,
      status: ChargeStatus.Succeeded,
      at: nowIso,
    });
    cycle.status = CycleStatus.Succeeded;
    cycle.providerChargeId = charge.id;
    cycle.paidAt = charge.paidAt ?? nowIso;
    cycle.completedAt = nowIso;
    cycle.updatedAt = nowIso;
    delete cycle.lastError;
    await this.store.saveCycle(cycle);
    result.succeeded += 1;
    await this.emit(SchedulerEventType.ChargeSucceeded, schedule, this.cycleFields(cycle));
    return this.advancePointer(schedule, cycle, result);
  }

  /**
   * Moves the schedule past a succeeded cycle: counts it, then either completes
   * the schedule or creates the next cycle. Idempotent (a no-op once the pointer
   * has moved), so a crash between saving the cycle and the schedule heals itself.
   */
  private async advancePointer(schedule: ScheduleRecord, cycle: CycleRecord, result: TickResult): Promise<boolean> {
    if (schedule.cycleIndex !== cycle.index) return false;
    const now = this.now();
    const nowIso = toIso(now);
    schedule.paidCycles += 1;
    schedule.cycleIndex = cycle.index + 1;
    schedule.updatedAt = nowIso;

    const open = schedule.status === ScheduleStatus.Active || schedule.status === ScheduleStatus.Paused;
    const lastCycle = schedule.totalCycles !== undefined && cycle.index + 1 >= schedule.totalCycles;
    if (open && lastCycle) {
      schedule.status = ScheduleStatus.Completed;
      schedule.statusReason = ScheduleStatusReason.AllCyclesCollected;
      schedule.endedAt = nowIso;
      this.plan(schedule, undefined, now);
      await this.store.saveSchedule(schedule);
      result.completed += 1;
      await this.emit(SchedulerEventType.ScheduleCompleted, schedule);
      return false;
    }
    if (schedule.status !== ScheduleStatus.Active) {
      this.plan(schedule, undefined, now);
      await this.store.saveSchedule(schedule);
      return false;
    }
    const next = this.newCycle(schedule, schedule.cycleIndex, now);
    await this.store.saveCycle(next);
    this.plan(schedule, next, now);
    await this.store.saveSchedule(schedule);
    return true;
  }

  private async settleFailure(
    schedule: ScheduleRecord,
    cycle: CycleRecord,
    failure: Failure,
    result: TickResult,
  ): Promise<boolean> {
    const now = this.now();
    const nowIso = toIso(now);
    cycle.attempts.push({
      attempt: cycle.attempt,
      chargeId: cycle.chargeId ?? '',
      status: failure.status,
      at: nowIso,
      failureCode: failure.code,
      ...(failure.reason !== undefined ? { failureReason: failure.reason } : {}),
    });
    result.failed += 1;
    const failedAttempt = cycle.attempt;
    const failedChargeId = cycle.chargeId;

    const live = schedule.status === ScheduleStatus.Active || schedule.status === ScheduleStatus.Paused;
    const exhausted = failedAttempt >= schedule.policy.maxAttempts;
    if (!live || exhausted) {
      cycle.status = CycleStatus.Failed;
      cycle.completedAt = nowIso;
      cycle.updatedAt = nowIso;
      await this.store.saveCycle(cycle);
      await this.emit(SchedulerEventType.ChargeFailed, schedule, {
        ...this.cycleFields(cycle),
        error: { code: ErrorCode.ProviderError, message: failure.reason ?? failure.code },
      });
      if (live) {
        await this.emit(SchedulerEventType.CycleFailed, schedule, this.cycleFields(cycle));
        await this.halt(schedule, ScheduleStatusReason.RetriesExhausted, result);
      } else {
        this.plan(schedule, cycle, now);
        schedule.updatedAt = nowIso;
        await this.store.saveSchedule(schedule);
      }
      return false;
    }

    // Retry: a new attempt number (so a new charge id) after the retry interval, with a fresh notification.
    this.clearAttemptState(cycle, false);
    cycle.status = CycleStatus.Pending;
    cycle.attempt = failedAttempt + 1;
    cycle.attemptDueAt = toIso(new Date(now.getTime() + schedule.policy.retryIntervalHours * HOUR_MS));
    cycle.updatedAt = nowIso;
    await this.store.saveCycle(cycle);
    this.plan(schedule, cycle, now);
    schedule.updatedAt = nowIso;
    await this.store.saveSchedule(schedule);
    await this.emit(SchedulerEventType.ChargeFailed, schedule, {
      cycleIndex: cycle.index,
      attempt: failedAttempt,
      ...(failedChargeId !== undefined ? { chargeId: failedChargeId } : {}),
      error: { code: ErrorCode.ProviderError, message: failure.reason ?? failure.code },
    });
    return schedule.status === ScheduleStatus.Active;
  }

  private async halt(schedule: ScheduleRecord, reason: ScheduleStatusReason, result: TickResult): Promise<void> {
    const now = this.now();
    schedule.status = ScheduleStatus.Halted;
    schedule.statusReason = reason;
    schedule.endedAt = toIso(now);
    schedule.updatedAt = schedule.endedAt;
    this.plan(schedule, undefined, now);
    await this.store.saveSchedule(schedule);
    result.halted += 1;
    await this.emit(SchedulerEventType.ScheduleHalted, schedule, { reason });
  }

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------

  /**
   * Applies a normalised webhook event to its schedule. Idempotent (gateways
   * deliver events more than once) and safe to race with `tick`: it takes the
   * same per-schedule lock, waiting up to `lockWaitMs` before throwing
   * `CONFLICT` so the gateway redelivers. Events that match no schedule are ignored.
   *
   * The schedule is found by `event.subscription.reference` or `event.subscriptionId`
   * as a schedule id, or by `event.subscriptionId` as a gateway subscription id.
   * Handled: authorised/activated (activates a pending schedule, adopting the
   * event's subscription id), authorisation failed, expired, cancelled, paused,
   * halted, charged and charge failed (matched to the in-flight debit by
   * `charge.reference` or `charge.id`).
   */
  async handleEvent(event: SubscriptionEvent): Promise<void> {
    const found = await this.locate(event);
    if (!found) return;
    await this.withLock(found.id, async () => {
      const schedule = await this.store.getSchedule(found.id);
      if (!schedule) return;
      const result = this.emptyResult();

      switch (event.type) {
        case EventType.SubscriptionAuthorized:
        case EventType.SubscriptionActivated:
          if (schedule.status === ScheduleStatus.PendingAuthorization) {
            const subscriptionId = event.subscriptionId ?? event.subscription?.id;
            await this.activateLocked(schedule, subscriptionId !== undefined ? { subscriptionId } : {});
          }
          return;
        case EventType.SubscriptionAuthorizationFailed:
          if (schedule.status === ScheduleStatus.PendingAuthorization) {
            await this.cancelLocked(schedule, ScheduleStatusReason.AuthorizationFailed);
          }
          return;
        case EventType.SubscriptionExpired:
          if (schedule.status === ScheduleStatus.PendingAuthorization) {
            await this.cancelLocked(schedule, ScheduleStatusReason.AuthorizationTimeout);
          } else if (schedule.status === ScheduleStatus.Active || schedule.status === ScheduleStatus.Paused) {
            await this.cancelLocked(schedule, ScheduleStatusReason.MandateExpired);
          }
          return;
        case EventType.SubscriptionCancelled:
          if (schedule.status !== ScheduleStatus.Completed) {
            await this.cancelLocked(schedule, ScheduleStatusReason.CancelledByGateway);
          }
          return;
        case EventType.SubscriptionPaused:
          if (schedule.status === ScheduleStatus.Active) {
            await this.pauseLocked(schedule, ScheduleStatusReason.PausedByGateway);
          }
          return;
        case EventType.SubscriptionHalted:
          if (schedule.status === ScheduleStatus.Active || schedule.status === ScheduleStatus.Paused) {
            await this.halt(schedule, ScheduleStatusReason.HaltedByGateway, result);
          }
          return;
        case EventType.SubscriptionCharged:
        case EventType.SubscriptionChargeFailed:
          await this.applyChargeEvent(schedule, event, result);
          return;
        default:
          return;
      }
    });
  }

  private async locate(event: SubscriptionEvent): Promise<ScheduleRecord | undefined> {
    const subscriptionId = event.subscriptionId ?? event.subscription?.id ?? event.charge?.subscriptionId;
    const byId = [event.subscription?.reference, subscriptionId];
    for (const id of byId.slice(0, 1)) {
      const schedule = id ? await this.store.getSchedule(id) : undefined;
      if (schedule && schedule.provider === event.provider) return schedule;
    }
    if (subscriptionId) {
      const bySubscription = await this.store.findBySubscriptionId(event.provider, subscriptionId);
      if (bySubscription) return bySubscription;
      const bySchedule = await this.store.getSchedule(subscriptionId);
      if (bySchedule && bySchedule.provider === event.provider) return bySchedule;
    }
    return undefined;
  }

  private async applyChargeEvent(
    schedule: ScheduleRecord,
    event: SubscriptionEvent,
    result: TickResult,
  ): Promise<void> {
    const charge = event.charge;
    if (!charge) return;
    for (const index of [schedule.cycleIndex, schedule.cycleIndex - 1]) {
      if (index < 0) continue;
      const cycle = await this.store.getCycle(schedule.id, index);
      if (!cycle || !IN_FLIGHT_CYCLE_STATUSES.includes(cycle.status)) continue;
      const matches =
        (cycle.chargeId !== undefined && (charge.reference === cycle.chargeId || charge.id === cycle.chargeId)) ||
        (cycle.providerChargeId !== undefined && charge.id === cycle.providerChargeId);
      if (!matches) continue;

      // "Charged" means collected even when the gateway's status field lags.
      const settled: Charge =
        event.type === EventType.SubscriptionCharged &&
        (charge.status === ChargeStatus.Pending || charge.status === ChargeStatus.Scheduled)
          ? { ...charge, status: ChargeStatus.Succeeded }
          : charge;
      await this.applyCharge(schedule, cycle, settled, result);
      return;
    }
    // Already settled (a redelivery) or not a debit of ours: nothing to do.
  }

  // -------------------------------------------------------------------------
  // Locked mutations shared by the public API, webhooks and tick
  // -------------------------------------------------------------------------

  private async activateLocked(schedule: ScheduleRecord, input: ActivateScheduleInput): Promise<ScheduleRecord> {
    const firstChargeAt = input.firstChargeAt !== undefined ? toIso(toDate(input.firstChargeAt, 'firstChargeAt')) : undefined;
    if (schedule.status === ScheduleStatus.Active) {
      const sameSubscription = input.subscriptionId === undefined || input.subscriptionId === schedule.subscriptionId;
      const sameAnchor = firstChargeAt === undefined || firstChargeAt === schedule.anchorAt;
      if (sameSubscription && sameAnchor) return schedule;
      throw new SubscriptionError(
        ErrorCode.Conflict,
        `Schedule "${schedule.id}" is already active with different data`,
        { provider: schedule.provider },
      );
    }
    if (schedule.status !== ScheduleStatus.PendingAuthorization) {
      throw new SubscriptionError(
        ErrorCode.Conflict,
        `Schedule "${schedule.id}" is ${schedule.status} and cannot be activated`,
        { provider: schedule.provider },
      );
    }

    const now = this.now();
    const nowIso = toIso(now);
    if (input.subscriptionId !== undefined) schedule.subscriptionId = input.subscriptionId;
    if (firstChargeAt !== undefined) schedule.anchorAt = firstChargeAt;
    else if (Date.parse(schedule.anchorAt) <= now.getTime()) schedule.anchorAt = nowIso;
    schedule.anchorIndex = 0;
    schedule.cycleIndex = 0;
    schedule.status = ScheduleStatus.Active;
    delete schedule.statusReason;
    schedule.activatedAt = nowIso;
    schedule.updatedAt = nowIso;

    const cycle = this.newCycle(schedule, 0, now);
    await this.store.saveCycle(cycle);
    this.plan(schedule, cycle, now);
    await this.store.saveSchedule(schedule);
    await this.emit(SchedulerEventType.ScheduleActivated, schedule);
    return schedule;
  }

  private async pauseLocked(schedule: ScheduleRecord, reason: ScheduleStatusReason): Promise<ScheduleRecord> {
    if (schedule.status === ScheduleStatus.Paused) return schedule;
    if (schedule.status !== ScheduleStatus.Active) {
      throw new SubscriptionError(
        ErrorCode.Conflict,
        `Schedule "${schedule.id}" is ${schedule.status} and cannot be paused`,
        { provider: schedule.provider },
      );
    }
    const now = this.now();
    schedule.status = ScheduleStatus.Paused;
    schedule.statusReason = reason;
    schedule.updatedAt = toIso(now);
    // A debit already in flight keeps being reconciled while paused.
    const cycle = await this.store.getCycle(schedule.id, schedule.cycleIndex);
    this.plan(schedule, cycle, now);
    await this.store.saveSchedule(schedule);
    await this.emit(SchedulerEventType.SchedulePaused, schedule, { reason });
    await this.emitInFlight(schedule, cycle);
    return schedule;
  }

  private async resumeLocked(schedule: ScheduleRecord, nextChargeAt: string | undefined): Promise<ScheduleRecord> {
    if (schedule.status === ScheduleStatus.Active) return schedule;
    if (schedule.status !== ScheduleStatus.Paused) {
      throw new SubscriptionError(
        ErrorCode.Conflict,
        `Schedule "${schedule.id}" is ${schedule.status} and cannot be resumed`,
        { provider: schedule.provider },
      );
    }
    const now = this.now();
    const nowIso = toIso(now);
    let cycle = await this.store.getCycle(schedule.id, schedule.cycleIndex);
    const inFlight = cycle !== undefined && IN_FLIGHT_CYCLE_STATUSES.includes(cycle.status);
    // A debit in flight belongs to the current cycle; the re-anchoring applies to the one after it.
    const targetIndex = inFlight ? schedule.cycleIndex + 1 : schedule.cycleIndex;
    const exhausted = schedule.totalCycles !== undefined && targetIndex >= schedule.totalCycles;

    let newDue: Date | undefined;
    if (!exhausted) {
      if (nextChargeAt !== undefined) {
        newDue = toDate(nextChargeAt, 'nextChargeAt');
      } else {
        const currentDue =
          cycle && !inFlight ? new Date(cycle.attemptDueAt) : this.dueAt(schedule, targetIndex);
        if (currentDue.getTime() <= now.getTime()) newDue = now;
      }
    }

    if (newDue) {
      schedule.anchorAt = toIso(newDue);
      schedule.anchorIndex = targetIndex;
      if (cycle && !inFlight && (cycle.status === CycleStatus.Pending || cycle.status === CycleStatus.Notified)) {
        cycle.dueAt = schedule.anchorAt;
        cycle.attemptDueAt = schedule.anchorAt;
        if (cycle.status === CycleStatus.Notified) {
          // The customer was told another debit date: that notice no longer holds.
          this.clearNotification(cycle, true);
          cycle.status = CycleStatus.Pending;
        }
        cycle.updatedAt = nowIso;
        await this.store.saveCycle(cycle);
      }
    }
    schedule.status = ScheduleStatus.Active;
    delete schedule.statusReason;
    schedule.updatedAt = nowIso;
    if (!cycle) {
      cycle = this.newCycle(schedule, schedule.cycleIndex, now);
      await this.store.saveCycle(cycle);
    }
    this.plan(schedule, cycle, now);
    await this.store.saveSchedule(schedule);
    await this.emit(SchedulerEventType.ScheduleResumed, schedule);
    return schedule;
  }

  private async cancelLocked(schedule: ScheduleRecord, reason: ScheduleStatusReason): Promise<ScheduleRecord> {
    if (schedule.status === ScheduleStatus.Cancelled) return schedule;
    if (schedule.status === ScheduleStatus.Completed) {
      throw new SubscriptionError(
        ErrorCode.Conflict,
        `Schedule "${schedule.id}" is already completed and cannot be cancelled`,
        { provider: schedule.provider },
      );
    }
    const now = this.now();
    const nowIso = toIso(now);
    const cycle = await this.store.getCycle(schedule.id, schedule.cycleIndex);
    if (cycle && (cycle.status === CycleStatus.Pending || cycle.status === CycleStatus.Notified)) {
      cycle.status = CycleStatus.Skipped;
      cycle.completedAt = nowIso;
      cycle.updatedAt = nowIso;
      await this.store.saveCycle(cycle);
    }
    schedule.status = ScheduleStatus.Cancelled;
    schedule.statusReason = reason;
    schedule.endedAt = nowIso;
    schedule.updatedAt = nowIso;
    // A debit in flight keeps being reconciled so its outcome is recorded.
    this.plan(schedule, cycle, now);
    await this.store.saveSchedule(schedule);
    await this.emit(SchedulerEventType.ScheduleCancelled, schedule, { reason });
    await this.emitInFlight(schedule, cycle);
    return schedule;
  }

  /** Tells the caller a debit is already raised at the gateway, so it can cancel it there if unwanted. */
  private async emitInFlight(schedule: ScheduleRecord, cycle: CycleRecord | undefined): Promise<void> {
    if (cycle && IN_FLIGHT_CYCLE_STATUSES.includes(cycle.status)) {
      await this.emit(SchedulerEventType.ChargeInFlight, schedule, this.cycleFields(cycle));
    }
  }

  // -------------------------------------------------------------------------
  // Planning, ids and cycles
  // -------------------------------------------------------------------------

  /**
   * Recomputes `nextActionAt` (when `tick` must next look) and `nextChargeAt`
   * (when the next debit is due) from the schedule and its current cycle.
   * Returns true when either changed. Does not save.
   */
  private plan(schedule: ScheduleRecord, cycle: CycleRecord | undefined, now: Date): boolean {
    const nowIso = toIso(now);
    let nextAction: string | undefined;
    let nextCharge: string | undefined;

    if (cycle && IN_FLIGHT_CYCLE_STATUSES.includes(cycle.status)) {
      nextAction = nowIso;
      // A debit scheduled for a future date has no outcome to ask about before then.
      if (
        cycle.status === CycleStatus.AwaitingConfirmation &&
        cycle.scheduledAt !== undefined &&
        Date.parse(cycle.scheduledAt) > now.getTime()
      ) {
        nextAction = cycle.scheduledAt;
      }
      if (schedule.status === ScheduleStatus.Active) nextCharge = cycle.attemptDueAt;
    } else if (schedule.status === ScheduleStatus.PendingAuthorization) {
      const timeout = schedule.policy.authorizationTimeoutHours;
      if (timeout !== undefined) nextAction = toIso(new Date(Date.parse(schedule.createdAt) + timeout * HOUR_MS));
    } else if (schedule.status === ScheduleStatus.Active) {
      if (!cycle) {
        nextAction = nowIso;
        nextCharge = toIso(this.dueAt(schedule, schedule.cycleIndex));
      } else {
        switch (cycle.status) {
          case CycleStatus.Pending: {
            const provider = this.providerFor(schedule.provider);
            let at = this.actionTime(cycle, schedule.policy, this.timing(schedule, provider));
            // After a gateway error, try again on a later tick rather than at the head of the queue.
            if (cycle.lastError) at = Math.max(at, Date.parse(cycle.lastError.at));
            nextAction = toIso(new Date(at));
            nextCharge = cycle.attemptDueAt;
            break;
          }
          case CycleStatus.Notified:
            nextAction = toIso(new Date(this.earliestDebit(cycle, schedule.policy)));
            nextCharge = cycle.attemptDueAt;
            break;
          case CycleStatus.Succeeded:
          case CycleStatus.Failed:
          case CycleStatus.Skipped:
            // Transient crash-recovery states: let the next tick finish the transition.
            nextAction = nowIso;
            break;
          default:
            break;
        }
      }
    }

    const changed = schedule.nextActionAt !== nextAction || schedule.nextChargeAt !== nextCharge;
    if (nextAction === undefined) delete schedule.nextActionAt;
    else schedule.nextActionAt = nextAction;
    if (nextCharge === undefined) delete schedule.nextChargeAt;
    else schedule.nextChargeAt = nextCharge;
    return changed;
  }

  /** The earliest instant a notified cycle may be debited: due time, told date, and notice period all passed. */
  private earliestDebit(cycle: CycleRecord, policy: SchedulePolicy): number {
    let earliest = Date.parse(cycle.attemptDueAt);
    if (cycle.debitAt !== undefined) earliest = Math.max(earliest, Date.parse(cycle.debitAt));
    if (cycle.notifiedAt !== undefined) {
      earliest = Math.max(earliest, Date.parse(cycle.notifiedAt) + policy.minNoticeHours * HOUR_MS);
    }
    return earliest;
  }

  private dueAt(schedule: ScheduleRecord, index: number): Date {
    return cycleStart(new Date(schedule.anchorAt), schedule.interval, index - schedule.anchorIndex);
  }

  private newCycle(schedule: ScheduleRecord, index: number, now: Date): CycleRecord {
    const due = toIso(this.dueAt(schedule, index));
    const nowIso = toIso(now);
    return {
      scheduleId: schedule.id,
      index,
      status: CycleStatus.Pending,
      dueAt: due,
      attemptDueAt: due,
      attempt: 1,
      notificationRound: 1,
      attempts: [],
      createdAt: nowIso,
      updatedAt: nowIso,
    };
  }

  /** Loads the schedule's current cycle, creating it when the pointer is ahead of the stored cycles. */
  private async currentCycle(schedule: ScheduleRecord, create: boolean): Promise<CycleRecord | undefined> {
    const existing = await this.store.getCycle(schedule.id, schedule.cycleIndex);
    if (existing || !create) return existing;
    if (schedule.totalCycles !== undefined && schedule.cycleIndex >= schedule.totalCycles) return undefined;
    const cycle = this.newCycle(schedule, schedule.cycleIndex, this.now());
    await this.store.saveCycle(cycle);
    return cycle;
  }

  /** Forgets the notification and the debit of the current attempt. */
  private clearAttemptState(cycle: CycleRecord, keepAttempt: boolean): void {
    this.clearNotification(cycle, keepAttempt);
    delete cycle.chargeId;
    delete cycle.providerChargeId;
    delete cycle.chargeRequestedAt;
    delete cycle.scheduledAt;
    delete cycle.lastError;
  }

  private clearNotification(cycle: CycleRecord, bumpRound: boolean): void {
    delete cycle.notificationId;
    delete cycle.invoiceNumber;
    delete cycle.notifiedAt;
    delete cycle.debitAt;
    cycle.notificationRound = bumpRound ? cycle.notificationRound + 1 : 1;
  }

  /** Deterministic per (schedule, cycle, attempt): the same debit always carries the same id. */
  private chargeId(schedule: ScheduleRecord, cycle: CycleRecord): string {
    return [SchedulerIdPrefix.Charge, idHash(schedule.id), cycle.index, cycle.attempt].join(ID_SEPARATOR);
  }

  /** Deterministic per (schedule, cycle, attempt, round). */
  private notificationId(schedule: ScheduleRecord, cycle: CycleRecord): string {
    return [
      SchedulerIdPrefix.Notification,
      idHash(schedule.id),
      cycle.index,
      cycle.attempt,
      cycle.notificationRound,
    ].join(ID_SEPARATOR);
  }

  private cycleFields(cycle: CycleRecord): Partial<SchedulerEvent> {
    return {
      cycleIndex: cycle.index,
      attempt: cycle.attempt,
      ...(cycle.chargeId !== undefined ? { chargeId: cycle.chargeId } : {}),
      ...(cycle.amount !== undefined ? { amount: cycle.amount } : {}),
    };
  }

  private isTerminal(schedule: ScheduleRecord): boolean {
    return (
      schedule.status === ScheduleStatus.Cancelled ||
      schedule.status === ScheduleStatus.Completed ||
      schedule.status === ScheduleStatus.Halted
    );
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private now(): Date {
    return this.clock();
  }

  private emptyResult(): TickResult {
    return {
      at: toIso(this.now()),
      due: 0,
      locked: 0,
      notified: 0,
      charged: 0,
      reconciled: 0,
      succeeded: 0,
      failed: 0,
      awaiting: 0,
      completed: 0,
      halted: 0,
      expired: 0,
      errors: [],
    };
  }

  /** Records a gateway error on the cycle, in the tick result and as an event. The cycle keeps its status. */
  private async recordError(
    schedule: ScheduleRecord,
    cycle: CycleRecord,
    error: SubscriptionError,
    type: SchedulerEventType,
    result: TickResult,
  ): Promise<void> {
    const nowIso = toIso(this.now());
    cycle.lastError = { code: error.code, message: error.message, at: nowIso };
    cycle.updatedAt = nowIso;
    await this.store.saveCycle(cycle);
    result.errors.push({ scheduleId: schedule.id, code: error.code, message: error.message });
    await this.emit(type, schedule, {
      ...this.cycleFields(cycle),
      error: { code: error.code, message: error.message },
    });
  }

  private pushError(result: TickResult, scheduleId: string, error: unknown): void {
    const failure = asSubscriptionError(error, ErrorCode.ProviderError);
    result.errors.push({ scheduleId, code: failure.code, message: failure.message });
  }

  private async emit(
    type: SchedulerEventType,
    schedule: ScheduleRecord,
    extra: Partial<SchedulerEvent> = {},
  ): Promise<void> {
    if (!this.onEvent) return;
    const event: SchedulerEvent = {
      type,
      at: toIso(this.now()),
      scheduleId: schedule.id,
      provider: schedule.provider,
      subscriptionId: schedule.subscriptionId,
      scheduleStatus: schedule.status,
      ...extra,
    };
    try {
      await this.onEvent(event);
    } catch {
      // A throwing listener must never affect billing.
    }
  }

  private async releaseQuietly(id: string, token: string): Promise<void> {
    try {
      await this.store.releaseLock(id, token);
    } catch {
      // The lock expires on its own; a failed release must not mask the real outcome.
    }
  }

  /** Runs `fn` while holding the schedule's lock, waiting up to `lockWaitMs` for it. */
  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + this.config.lockWaitMs;
    let token = await this.store.acquireLock(id, this.config.lockTtlMs);
    while (token === undefined) {
      if (Date.now() >= deadline) {
        throw new SubscriptionError(
          ErrorCode.Conflict,
          `Schedule "${id}" is being processed by another worker; try again shortly`,
        );
      }
      await sleep(LOCK_POLL_INTERVAL_MS);
      token = await this.store.acquireLock(id, this.config.lockTtlMs);
    }
    try {
      return await fn();
    } finally {
      await this.releaseQuietly(id, token);
    }
  }

  /** Locks, re-reads the schedule (throwing NOT_FOUND when it does not exist) and runs `fn` on it. */
  private mutate(id: string, fn: (schedule: ScheduleRecord) => Promise<ScheduleRecord>): Promise<ScheduleRecord> {
    return this.withLock(id, async () => {
      const schedule = await this.store.getSchedule(id);
      if (!schedule) throw new SubscriptionError(ErrorCode.NotFound, `No schedule with id "${id}"`);
      return fn(schedule);
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Short stable hash of a schedule id, so gateway ids stay within their length limits. */
function idHash(scheduleId: string): string {
  return hash(HashAlgorithm.Sha256, scheduleId, DigestEncoding.Hex).slice(0, ID_HASH_LENGTH);
}

/** Wraps anything that is not already a `SubscriptionError`, keeping the original as `cause`. */
function asSubscriptionError(error: unknown, fallback: ErrorCode): SubscriptionError {
  if (error instanceof SubscriptionError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new SubscriptionError(fallback, `Unexpected error: ${message}`, { cause: error });
}

/**
 * True when a `createCharge` failure proves the gateway refused the debit (so
 * no debit exists and the attempt counts as failed). Everything else (timeouts,
 * `OUTCOME_UNKNOWN`, 5xx, unparseable answers, rate limits, auth problems) is
 * treated as "may have happened" and reconciled with `getCharge`.
 */
function isDefiniteRejection(error: SubscriptionError): boolean {
  return error.code === ErrorCode.ProviderError || error.code === ErrorCode.Validation;
}

/** JSON with sorted keys and no `undefined`, so equal data always hashes equally. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
