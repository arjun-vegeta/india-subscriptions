import {
  ChannelPolicy,
  ChargeKind,
  ChargeStatus,
  CheckoutKind,
  ErrorCode,
  EventType,
  PaymentStatus,
  ProductKind,
  Provider,
  SalesChannel,
  SubscriptionStatus,
  type Provider as ProviderName,
} from '../constants.js';
import { SubscriptionError, invalid, parseInput } from '../errors.js';
import type { ExternalTransactionReporter } from '../provider.js';
import { RouteOutcomeKind, RouteOutcomeResult } from '../routing/constants.js';
import type { RouteRequest } from '../routing/schemas.js';
import type { Router } from '../routing/router.js';
import type {
  Capabilities,
  CheckoutInstruction,
  CheckoutResult,
  CreatePaymentInput,
  CreateSubscriptionInput,
  ExternalTransactionRefund,
  ExternalTransactionReport,
  Subscription,
  SubscriptionEvent,
} from '../schemas.js';
import {
  AttemptOutcome,
  DEFAULT_FLUSH_LIMIT,
  DEFAULT_LOCK_POLL_MS,
  DEFAULT_LOCK_TTL_MS,
  DEFAULT_LOCK_WAIT_MS,
  DEFAULT_REPORT_LEASE_MS,
  DEFAULT_RETRY_BASE_MS,
  DEFAULT_RETRY_MAX_MS,
  DEFAULT_SESSION_TTL_MS,
  EntitlementStatus,
  FALLBACK_ERROR_CODES,
  FlushOutcome,
  GOOGLE_PLAY_CONSUMABLE_RESULT_KEY,
  LockScope,
  MAX_OVERDUE_LISTED,
  PurchaseIssue,
  REPORT_DEADLINE_MS,
  ReportKind,
  ReportStatus,
  SessionStatus,
  UNAVAILABLE_ERROR_CODES,
  ACCESS_STATUSES,
} from './constants.js';
import { applyEvent, blocksPurchase, statusFromSubscription, toItem } from './entitlement.js';
import type { PurchaseHost } from './host.js';
import { entitlementId, firstTransactionId, newReference, newSessionId, refundReportId, renewalTransactionId } from './ids.js';
import { assertCatalog, resolvePolicy, type ResolvedPolicy } from './policy.js';
import {
  ChooseAlternativeInputSchema,
  CompletePurchaseInputSchema,
  EntitlementRecordSchema,
  FlushOptionsSchema,
  PlatformPolicySchema,
  ProductSchema,
  PurchaseSessionSchema,
  StartPurchaseInputSchema,
  type ChooseAlternativeInput,
  type CompletePurchaseInput,
  type EntitlementRecord,
  type Entitlements,
  type FlushEntry,
  type FlushOptions,
  type FlushResult,
  type PlatformPolicy,
  type PlatformPolicyInput,
  type Product,
  type PurchaseAttempt,
  type PurchaseOption,
  type PurchaseSession,
  type PurchaseSessionRecord,
  type ReportRecord,
  type StartPurchaseInput,
} from './schemas.js';
import type { PurchaseStore } from './store.js';
import { splitRefund, splitTax } from './tax.js';

/** A problem `Purchases` could not turn into an error for the caller (a webhook batch, a report it could not queue). */
export interface IssueReport {
  issue: PurchaseIssue;
  message: string;
  sessionId?: string;
  eventId?: string;
  error?: unknown;
}

export interface PurchasesOptions {
  /** The facade, or anything shaped like it. */
  host: PurchaseHost;
  /** Chooses the gateway. Build it over the host's capabilities so it sees the configured providers. */
  router: Router;
  /** The products you sell. Validated when `Purchases` is built: a bad catalog throws `CONFIG` listing every problem. */
  catalog: Product[];
  /** Where each platform may buy. Defaults: iOS the App Store, Android Google Play, web the gateways. */
  policy?: PlatformPolicyInput;
  /** Sessions, entitlements and the report outbox. Must meet the guarantees in `PurchaseStore`. */
  store: PurchaseStore;
  /** Sends reports to Google (the Google Play adapter). Required when the Android policy is `user_choice`. */
  reporter?: ExternalTransactionReporter;
  /** The clock. Defaults to `new Date()`. */
  now?: () => Date;
  /** How long an unpaid session stays open, in milliseconds. Default 24 hours. */
  sessionTtlMs?: number;
  /** Backoff between attempts to send a report: the first retry waits `baseMs`, each next one twice as long, up to `maxMs`. */
  retry?: { baseMs?: number; maxMs?: number };
  /** How long a flush owns the reports it claimed, in milliseconds. Must exceed one call to Google. Default 5 minutes. */
  reportLeaseMs?: number;
  /** Lock timing: how long a lock lives (`ttlMs`), how long a request waits for one (`waitMs`), how often it looks (`pollMs`). */
  lock?: { ttlMs?: number; waitMs?: number; pollMs?: number };
  /** Called with problems that cannot be raised to the caller. Log them. */
  onIssue?: (issue: IssueReport) => void;
}

/** What a settled purchase is made of, from a verification or from an event. */
interface Evidence {
  /** The provider's subscription id or payment id. */
  providerId: string;
  status: EntitlementStatus;
  /** The price paid, in paise, tax included, where the provider says. */
  amount?: number;
  paidAt?: string;
  /** The charge or payment the amount was paid by, where known. */
  chargeId?: string;
  currentPeriodEnd?: string;
  cancelAtPeriodEnd?: boolean;
  refundedAmount?: number;
}

type Verdict = { kind: 'paid'; evidence: Evidence } | { kind: 'pending' } | { kind: 'failed' };

const LIVE_STATUSES: readonly SessionStatus[] = [SessionStatus.Open, SessionStatus.AwaitingPayment];

/**
 * Purchase sessions, platform policy, entitlements and the queue of reports owed to Google.
 *
 * ## The flow
 *
 * `start` decides where the purchase may go for the platform (see `policy.ts`), creates it there and returns a
 * session with one or more options, each a checkout instruction for the app or browser. `complete` takes what the
 * checkout handed back, verifies it through the host against the id the option was created with, and records the
 * entitlement. `entitlements` answers what a customer owns. `handleEvents` keeps entitlements current from webhook
 * events, and `flush` sends the reports owed to Google.
 *
 * ## Guarantees
 *
 * - `start` with the same `customerRef` and `reference` returns the open session instead of creating a second purchase.
 *   A customer who already owns a product (an entitlement that is active, trialing, past due or paused; consumables
 *   excepted) gets `CONFLICT`, whatever channel they bought it in.
 * - Every state change of a session is taken under a per-session lock in the store, so two `complete` calls racing on
 *   one session write one entitlement and queue one report. Entitlement ids and report ids are deterministic and the
 *   outbox inserts only when absent, so the same holds if a lock expires, and a crash between two writes is repaired by
 *   repeating the call.
 * - `complete` binds the result to the option: the host checks that the verified purchase is the one created for this
 *   session, and `Purchases` checks again. A result for another order is refused with `SIGNATURE_INVALID` and the
 *   session stays as it was.
 * - Money that moved is never lost to a status: a verification that says paid completes a session that is `failed` or
 *   `expired`, and so does a success event. A session becomes `failed` only through `complete` (a verification that says
 *   not paid), never from one failure event: gateways let the customer retry on the same order.
 * - On a gateway create that fails with `PROVIDER_UNAVAILABLE`, `RATE_LIMITED`, `NETWORK`, `TIMEOUT`, `AUTH`,
 *   `PROVIDER_ERROR` or `OUTCOME_UNKNOWN` the next gateway of the router's `ranked` list is tried; any other error
 *   (`VALIDATION`, `CONFLICT`, ...) is raised at once. Each attempt is passed to `router.record` and kept in the
 *   session's `attempts`.
 * - A purchase made through Google's user choice screen is reported to Google: the first transaction (amount 0 for a
 *   free trial) when `complete` runs, each renewal and each refund when `handleEvents` sees them. Reports are written to the
 *   store before `complete` returns and sent by `flush`.
 *
 * ## What it does not do
 *
 * It never cancels or refunds anything at a provider, and it does not move a purchase between gateways after the
 * customer has paid. Events about orders it did not create are ignored.
 */
export class Purchases {
  private readonly host: PurchaseHost;
  private readonly router: Router;
  private readonly store: PurchaseStore;
  private readonly reporter: ExternalTransactionReporter | undefined;
  private readonly clock: () => Date;
  private readonly catalog = new Map<string, Product>();
  private readonly policy: PlatformPolicy;
  private readonly sessionTtlMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly leaseMs: number;
  private readonly lockTtlMs: number;
  private readonly lockWaitMs: number;
  private readonly lockPollMs: number;
  private readonly onIssue: ((issue: IssueReport) => void) | undefined;

  constructor(options: PurchasesOptions) {
    this.host = options.host;
    this.router = options.router;
    this.store = options.store;
    this.reporter = options.reporter;
    this.clock = options.now ?? (() => new Date());
    this.policy = parseInput(PlatformPolicySchema, options.policy ?? {}, 'platform policy');
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.retryBaseMs = options.retry?.baseMs ?? DEFAULT_RETRY_BASE_MS;
    this.retryMaxMs = options.retry?.maxMs ?? DEFAULT_RETRY_MAX_MS;
    this.leaseMs = options.reportLeaseMs ?? DEFAULT_REPORT_LEASE_MS;
    this.lockTtlMs = options.lock?.ttlMs ?? DEFAULT_LOCK_TTL_MS;
    this.lockWaitMs = options.lock?.waitMs ?? DEFAULT_LOCK_WAIT_MS;
    this.lockPollMs = options.lock?.pollMs ?? DEFAULT_LOCK_POLL_MS;
    this.onIssue = options.onIssue;

    const catalog = options.catalog.map((product, index) => parseInput(ProductSchema, product, `catalog product ${index}`));
    assertCatalog({ catalog, policy: this.policy, capabilities: this.capabilities(), hasReporter: this.reporter !== undefined });
    for (const product of catalog) this.catalog.set(product.key, product);
  }

  // -------------------------------------------------------------------------
  // start
  // -------------------------------------------------------------------------

  /**
   * Starts a purchase of a product on a platform.
   *
   * The platform policy decides the channel. A store policy creates the purchase in the store and returns one store
   * option. `user_choice` returns the Google Play option with `userChoiceBilling: true`; the gateway option is created
   * only when the customer picks the alternative (`chooseAlternative`), because creating a mandate is a write. A
   * gateway policy asks the router for the best gateway and creates the purchase there, falling back down the ranking
   * as described on the class.
   *
   * With a `reference`, repeating the call returns the live (or completed) session of that reference. Rejects with
   * `CONFLICT` when the customer already owns the product, `NOT_FOUND` for an unknown product key, `CONFIG` for a policy
   * the configuration cannot serve, `NO_ROUTE` when no gateway can take the purchase.
   */
  async start(raw: StartPurchaseInput): Promise<PurchaseSession> {
    const input = parseInput(StartPurchaseInputSchema, raw, 'purchase start');
    const product = this.product(input.product);
    return this.withLock(`${LockScope.Start}:${input.customerRef}:${product.key}`, async () => {
      if (input.reference !== undefined) {
        const existing = await this.store.findSessionByReference(input.customerRef, input.reference);
        if (existing) {
          if (existing.product !== product.key || existing.platform !== input.platform) {
            throw new SubscriptionError(
              ErrorCode.Conflict,
              `The reference ${input.reference} was used for another purchase of this customer`,
            );
          }
          const current = await this.expireIfDue(existing);
          if (current.status !== SessionStatus.Failed && current.status !== SessionStatus.Expired) return toPublic(current);
        }
      }
      await this.assertNotOwned(input.customerRef, product);

      const resolved = resolvePolicy({
        platform: input.platform,
        product,
        policy: this.policy,
        capabilities: this.capabilities(),
        hasReporter: this.reporter !== undefined,
        customer: input.customer,
      });
      const now = this.now();
      const record: PurchaseSessionRecord = {
        id: newSessionId(),
        platform: input.platform,
        product: product.key,
        policy: resolved.policy,
        status: SessionStatus.Open,
        customerRef: input.customerRef,
        reference: input.reference ?? newReference(),
        options: [],
        attempts: [],
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.sessionTtlMs).toISOString(),
        customer: input.customer,
        ...(input.returnUrl !== undefined ? { returnUrl: input.returnUrl } : {}),
        kind: product.kind,
        amount: product.amount,
        ...(product.taxRateBps !== undefined ? { taxRateBps: product.taxRateBps } : {}),
        trial: product.trialDays !== undefined,
      };

      if (resolved.store) {
        record.options.push(await this.createStoreOption(record, product, resolved));
      } else {
        record.options.push(await this.createGatewayOption(record, product, record.attempts));
      }
      await this.store.saveSession(record);
      return toPublic(record);
    });
  }

  // -------------------------------------------------------------------------
  // chooseAlternative
  // -------------------------------------------------------------------------

  /**
   * The customer picked the alternative payment on Google's choice screen (`user_choice` sessions on Android only).
   * Creates the purchase at the best gateway and adds it to the session as a second option. The token is kept: it is
   * what the first report to Google is sent with.
   *
   * Calling it again with the same token returns the same gateway option, never a second mandate. A different token
   * after the option exists is a `CONFLICT`. If every gateway fails the session records the gateways tried, the token is
   * not kept, and the call can be repeated (with the same or a new token).
   */
  async chooseAlternative(sessionId: string, raw: ChooseAlternativeInput): Promise<PurchaseSession> {
    const input = parseInput(ChooseAlternativeInputSchema, raw, 'alternative choice');
    return this.withLock(`${LockScope.Session}:${sessionId}`, async () => {
      let record = await this.load(sessionId);
      record = await this.expireIfDue(record);
      if (record.policy !== ChannelPolicy.UserChoice) {
        throw invalid(`Session ${sessionId} was not started with the user_choice policy: there is no alternative to choose`);
      }
      const existing = record.options.find((option) => option.channel === SalesChannel.Gateway);
      if (existing && record.externalTransactionToken !== undefined) {
        if (record.externalTransactionToken === input.externalTransactionToken) return toPublic(record);
        throw new SubscriptionError(ErrorCode.Conflict, `Session ${sessionId} already has a gateway purchase made with another token`);
      }
      if (!LIVE_STATUSES.includes(record.status)) {
        throw new SubscriptionError(ErrorCode.Conflict, `Session ${sessionId} is ${record.status}: start a new purchase`);
      }

      const product = this.product(record.product);
      const attempts: PurchaseAttempt[] = [...record.attempts];
      try {
        const option = await this.createGatewayOption(record, product, attempts);
        record.options.push(option);
        record.externalTransactionToken = input.externalTransactionToken;
        record.status = SessionStatus.AwaitingPayment;
      } finally {
        record.attempts = attempts;
        await this.store.saveSession(record);
      }
      return toPublic(record);
    });
  }

  // -------------------------------------------------------------------------
  // complete
  // -------------------------------------------------------------------------

  /**
   * Completes a session with what the checkout handed back.
   *
   * The result is verified through the host against the id the option was created with. Paid or authorised: the
   * entitlement is written, the first report to Google is queued if the purchase went through the alternative, and the
   * session is `completed`. Not paid: the session is `failed` (and can still complete later). Still pending at the
   * provider (a mandate waiting for the bank): `awaiting_payment`. A result for a different order is refused with
   * `SIGNATURE_INVALID` and nothing changes.
   *
   * Completing a completed session returns it unchanged. An expired session whose result says it was paid completes:
   * the customer's money has moved.
   */
  async complete(sessionId: string, raw: CompletePurchaseInput): Promise<PurchaseSession> {
    const input = parseInput(CompletePurchaseInputSchema, raw, 'purchase completion');
    return this.withLock(`${LockScope.Session}:${sessionId}`, async () => {
      let record = await this.load(sessionId);
      const option = record.options.find((candidate) => candidate.provider === input.provider);
      if (!option) {
        throw invalid(`Session ${sessionId} has no option at ${input.provider}`, input.provider);
      }
      if (record.status === SessionStatus.Completed) {
        if (record.provider !== input.provider) {
          throw new SubscriptionError(ErrorCode.Conflict, `Session ${sessionId} was completed at ${String(record.provider)}`);
        }
        return toPublic(record);
      }
      record = await this.expireIfDue(record);

      const verdict = await this.verify(record, option, input);
      if (verdict.kind === 'paid') {
        record = await this.settle(record, option, verdict.evidence);
        return toPublic(record);
      }
      if (verdict.kind === 'pending') {
        if (record.status === SessionStatus.Open) {
          record.status = SessionStatus.AwaitingPayment;
          await this.store.saveSession(record);
        }
        return toPublic(record);
      }
      if (record.status !== SessionStatus.Expired) record.status = SessionStatus.Failed;
      await this.store.saveSession(record);
      await this.recordOutcome(option, record.kind, RouteOutcomeResult.Failure);
      return toPublic(record);
    });
  }

  // -------------------------------------------------------------------------
  // get, entitlements
  // -------------------------------------------------------------------------

  /** The session. An unpaid session past its `expiresAt` is returned (and stored) as `expired`. Rejects with `NOT_FOUND`. */
  async get(sessionId: string): Promise<PurchaseSession> {
    const record = await this.load(sessionId);
    if (!this.isDue(record)) return toPublic(record);
    return this.withLock(`${LockScope.Session}:${sessionId}`, async () => toPublic(await this.expireIfDue(await this.load(sessionId))));
  }

  /** What a customer owns, across stores and gateways. `active` is true when any item gives access now. */
  async entitlements(customerRef: string): Promise<Entitlements> {
    const now = this.now();
    const records = await this.store.listEntitlements(customerRef);
    const items = records.map((record) => toItem(record, now));
    return { customerRef, active: items.some((item) => item.active), items };
  }

  // -------------------------------------------------------------------------
  // handleEvents
  // -------------------------------------------------------------------------

  /**
   * Applies verified webhook events: entitlements follow them (activation, renewal, past due, pause, cancellation,
   * expiry, the refund of a one-time purchase), a success event completes a session whose customer never came back,
   * charge and payment outcomes go to `router.record`, and for purchases made through the alternative a charge queues
   * the renewal report and a refund the refund report.
   *
   * Events that match no session and no entitlement are ignored. Handling an event twice does the same as handling it
   * once. Every event of the batch is tried; if some fail, the first error is thrown afterwards (so a webhook route
   * answers with a failure and the gateway delivers the batch again).
   */
  async handleEvents(events: SubscriptionEvent[]): Promise<void> {
    const errors: unknown[] = [];
    for (const event of events) {
      try {
        await this.handleEvent(event);
      } catch (error) {
        errors.push(error);
        this.report({ issue: PurchaseIssue.EventFailed, message: `Event ${event.id} could not be applied`, eventId: event.id, error });
      }
    }
    if (errors.length > 0) throw errors[0];
  }

  private async handleEvent(event: SubscriptionEvent): Promise<void> {
    const ids = eventIds(event);
    if (ids.length === 0) return;
    let sessionId: string | undefined;
    for (const id of ids) {
      sessionId = (await this.findEntitlement(event.provider, id))?.sessionId;
      if (sessionId) break;
    }
    if (!sessionId) {
      for (const id of ids) {
        sessionId = (await this.store.findSessionByHandle(event.provider, id))?.id;
        if (sessionId) break;
      }
    }
    if (!sessionId) return;
    const owner = sessionId;

    await this.withLock(`${LockScope.Session}:${owner}`, async () => {
      const session = await this.store.getSession(owner);
      if (!session) return;
      let entitlement: EntitlementRecord | undefined;
      for (const id of ids) {
        entitlement = await this.findEntitlement(event.provider, id);
        if (entitlement) break;
      }
      if (entitlement) await this.applyToEntitlement(session, entitlement, event);
      else await this.settleFromEvent(session, event);
    });
  }

  private async findEntitlement(provider: ProviderName, id: string): Promise<EntitlementRecord | undefined> {
    return (
      (await this.store.findEntitlement(provider, { subscriptionId: id })) ??
      (await this.store.findEntitlement(provider, { paymentId: id }))
    );
  }

  private async applyToEntitlement(session: PurchaseSessionRecord, found: EntitlementRecord, event: SubscriptionEvent): Promise<void> {
    const now = this.now();
    const chargeId = event.type === EventType.SubscriptionCharged ? event.charge?.id : undefined;
    const isGateway = found.channel === SalesChannel.Gateway;

    // Reports first: they are the obligation. Deterministic ids make a repeat harmless.
    if (session.externalTransactionToken !== undefined && session.initialReportId !== undefined) {
      await this.queueEventReport(session, event, now);
    }

    const outcome = await this.withLock(`${LockScope.Entitlement}:${found.id}`, async () => {
      const current = (await this.store.getEntitlement(found.id)) ?? found;
      const effect = applyEvent(current, event, now);
      let record = effect.record;
      let touched = effect.changed;
      const firstCharge = chargeId !== undefined && current.lastChargeId !== chargeId;
      if (firstCharge) {
        record = { ...record, lastChargeId: chargeId, updatedAt: now.toISOString() };
        touched = true;
      }
      if (touched) await this.store.saveEntitlement(record);
      return { firstCharge };
    });

    if (!isGateway) return;
    const provider = event.provider;
    switch (event.type) {
      case EventType.SubscriptionCharged:
        if (outcome.firstCharge && event.charge?.kind !== ChargeKind.Authorization) {
          await this.record(provider, RouteOutcomeKind.Charge, RouteOutcomeResult.Success);
        }
        break;
      case EventType.SubscriptionChargeFailed:
        await this.record(provider, RouteOutcomeKind.Charge, RouteOutcomeResult.Failure);
        break;
      case EventType.PaymentFailed:
        await this.record(provider, RouteOutcomeKind.Payment, RouteOutcomeResult.Failure);
        break;
      case EventType.SubscriptionAuthorizationFailed:
        await this.record(provider, RouteOutcomeKind.Authorization, RouteOutcomeResult.Failure);
        break;
      default:
        break;
    }
  }

  /** An event about a session nobody has completed yet: success evidence completes it, a failure is only counted. */
  private async settleFromEvent(session: PurchaseSessionRecord, event: SubscriptionEvent): Promise<void> {
    const option = session.options.find((candidate) => candidate.provider === event.provider);
    if (!option) return;
    const evidence = evidenceFromEvent(session, option, event);
    if (evidence) {
      await this.settle(session, option, evidence);
      return;
    }
    if (option.channel !== SalesChannel.Gateway) return;
    switch (event.type) {
      case EventType.PaymentFailed:
        await this.record(event.provider, RouteOutcomeKind.Payment, RouteOutcomeResult.Failure);
        break;
      case EventType.SubscriptionAuthorizationFailed:
        await this.record(event.provider, RouteOutcomeKind.Authorization, RouteOutcomeResult.Failure);
        break;
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // flush
  // -------------------------------------------------------------------------

  /**
   * Sends the reports that are due to Google, most urgent first, at most `limit` (default 50).
   *
   * Each report is claimed with a lease, so two flushes never send the same one. A success is stored at once and the
   * report is never sent again. A failure keeps it queued and schedules the next attempt with a growing backoff
   * (`retry.baseMs`, doubled each time, capped at `retry.maxMs`); a `VALIDATION` failure marks it `rejected` instead,
   * because Google will not accept it as it is. A renewal or refund waits (`blocked`) until the report it refers to has
   * been sent. Without a reporter nothing is sent and every due report stays queued.
   *
   * `overdue` lists every queued report whose `dueBy` (transaction time plus 24 hours) has passed, whether or not this
   * flush tried it: an alert should fire when it is not empty.
   */
  async flush(raw: FlushOptions = {}): Promise<FlushResult> {
    const options = parseInput(FlushOptionsSchema, raw, 'flush options');
    const now = this.now();
    const at = now.toISOString();
    const claimed = await this.store.claimDueReports(at, options.limit ?? DEFAULT_FLUSH_LIMIT, this.leaseMs);
    const entries: FlushEntry[] = [];
    for (const report of claimed) entries.push(await this.sendReport(report, now));

    const tried = new Map(entries.map((entry) => [entry.id, entry] as const));
    const overdue = (await this.store.listOverdueReports(at, MAX_OVERDUE_LISTED)).map(
      (report): FlushEntry =>
        tried.get(report.id) ?? {
          id: report.id,
          kind: report.kind,
          attempts: report.attempts,
          dueBy: report.dueBy,
          overdue: true,
          ...(report.lastError ? { errorCode: report.lastError.code, errorMessage: report.lastError.message } : {}),
        },
    );
    const count = (outcome: FlushOutcome): number => entries.filter((entry) => entry.outcome === outcome).length;
    return {
      sent: count(FlushOutcome.Sent),
      retrying: count(FlushOutcome.Retrying),
      blocked: count(FlushOutcome.Blocked),
      rejected: count(FlushOutcome.Rejected),
      skipped: count(FlushOutcome.NoReporter),
      entries,
      overdue,
    };
  }

  private async sendReport(claimed: ReportRecord, now: Date): Promise<FlushEntry> {
    const token = claimed.leaseToken as string;
    const release = (): ReportRecord => withoutLease(claimed);
    const entry = (outcome: FlushOutcome, record: ReportRecord, error?: { code: string; message: string }): FlushEntry => ({
      id: record.id,
      kind: record.kind,
      outcome,
      attempts: record.attempts,
      dueBy: record.dueBy,
      overdue: now.getTime() > Date.parse(record.dueBy),
      ...(error ? { errorCode: error.code, errorMessage: error.message } : {}),
    });

    if (!this.reporter) {
      await this.store.saveReport(release(), token);
      return entry(FlushOutcome.NoReporter, claimed);
    }
    if (claimed.dependsOn !== undefined) {
      const dependency = await this.store.getReport(claimed.dependsOn);
      if (dependency?.status !== ReportStatus.Sent) {
        await this.store.saveReport(release(), token);
        return entry(FlushOutcome.Blocked, claimed);
      }
    }

    const attempts = claimed.attempts + 1;
    try {
      if (claimed.kind === ReportKind.Transaction && claimed.transaction) {
        await this.reporter.reportExternalTransaction(claimed.transaction);
      } else if (claimed.kind === ReportKind.Refund && claimed.refund) {
        await this.reporter.refundExternalTransaction(claimed.refund);
      } else {
        throw new SubscriptionError(ErrorCode.Internal, `Report ${claimed.id} carries nothing to send`);
      }
      const sent: ReportRecord = {
        ...release(),
        status: ReportStatus.Sent,
        attempts,
        lastAttemptAt: now.toISOString(),
        sentAt: now.toISOString(),
      };
      delete sent.lastError;
      await this.store.saveReport(sent, token);
      return entry(FlushOutcome.Sent, sent);
    } catch (error) {
      const code = error instanceof SubscriptionError ? error.code : ErrorCode.Internal;
      const message = error instanceof Error ? error.message : String(error);
      const rejected = code === ErrorCode.Validation;
      const failed: ReportRecord = {
        ...release(),
        status: rejected ? ReportStatus.Rejected : ReportStatus.Queued,
        attempts,
        lastAttemptAt: now.toISOString(),
        lastError: { code, message },
        nextAttemptAt: new Date(now.getTime() + this.backoffMs(attempts)).toISOString(),
      };
      await this.store.saveReport(failed, token);
      return entry(rejected ? FlushOutcome.Rejected : FlushOutcome.Retrying, failed, { code, message });
    }
  }

  private backoffMs(attempts: number): number {
    return Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.max(0, attempts - 1));
  }

  // -------------------------------------------------------------------------
  // Creating options
  // -------------------------------------------------------------------------

  private async createStoreOption(
    record: PurchaseSessionRecord,
    product: Product,
    resolved: ResolvedPolicy,
  ): Promise<PurchaseOption> {
    const store = resolved.store;
    if (!store) throw new SubscriptionError(ErrorCode.Internal, 'A store option needs a resolved store');
    const created =
      product.kind === ProductKind.Subscription
        ? await this.host.create(store.provider, {
            ...this.subscriptionInput(record, product),
            storeProduct: store.product,
          })
        : await this.host.payments.create(store.provider, {
            ...this.paymentInput(record, product),
            storeProduct: store.product,
          });
    const userChoice = resolved.policy === ChannelPolicy.UserChoice;
    const checkout = requireCheckout(store.provider, created.checkout);
    return {
      channel: SalesChannel.Store,
      provider: store.provider,
      checkout:
        checkout.kind === CheckoutKind.GooglePlayBilling ? { ...checkout, userChoiceBilling: userChoice } : checkout,
      handle: created.id,
    };
  }

  /**
   * Routes and creates the purchase at the best gateway, trying the next ranked gateway when a create fails with a code
   * in `FALLBACK_ERROR_CODES`. Every attempt is pushed to `attempts` and passed to `router.record`.
   */
  private async createGatewayOption(
    record: PurchaseSessionRecord,
    product: Product,
    attempts: PurchaseAttempt[],
  ): Promise<PurchaseOption> {
    const request: RouteRequest = {
      kind: product.kind,
      amount: product.amount,
      ...(product.interval !== undefined ? { interval: product.interval } : {}),
      ...(product.paymentMethods !== undefined ? { paymentMethods: product.paymentMethods } : {}),
      ...(product.trialDays !== undefined ? { needs: { trial: true } } : {}),
    };
    const decision = await this.router.route(request);

    const failures: { provider: ProviderName; code: string; message: string }[] = [];
    let last: unknown;
    for (const provider of decision.ranked) {
      try {
        const created =
          product.kind === ProductKind.Subscription
            ? await this.host.create(provider, this.subscriptionInput(record, product))
            : await this.host.payments.create(provider, this.paymentInput(record, product));
        const checkout = requireCheckout(provider, created.checkout);
        attempts.push({ provider, outcome: AttemptOutcome.Created, at: this.now().toISOString() });
        await this.record(provider, RouteOutcomeKind.Request, RouteOutcomeResult.Success);
        return { channel: SalesChannel.Gateway, provider, checkout, handle: created.id, routing: decision };
      } catch (error) {
        const code = error instanceof SubscriptionError ? error.code : ErrorCode.Internal;
        const message = error instanceof Error ? error.message : String(error);
        attempts.push({ provider, outcome: AttemptOutcome.Failed, at: this.now().toISOString(), errorCode: code, message });
        await this.record(
          provider,
          RouteOutcomeKind.Request,
          UNAVAILABLE_ERROR_CODES.includes(code) ? RouteOutcomeResult.Unavailable : RouteOutcomeResult.Failure,
        );
        if (!(error instanceof SubscriptionError) || !FALLBACK_ERROR_CODES.includes(code)) throw error;
        failures.push({ provider, code, message });
        last = error;
      }
    }
    throw new SubscriptionError(
      ErrorCode.ProviderUnavailable,
      `Every gateway tried failed to create the purchase: ${failures.map((f) => `${f.provider} (${f.code}: ${f.message})`).join('; ')}`,
      { raw: failures, cause: last },
    );
  }

  private subscriptionInput(record: PurchaseSessionRecord, product: Product): CreateSubscriptionInput {
    return {
      reference: record.reference,
      plan: {
        name: product.name,
        amount: product.amount,
        interval: product.interval as NonNullable<Product['interval']>,
        ...product.plan,
      },
      customer: record.customer,
      ...(product.trialDays !== undefined ? { trial: { days: product.trialDays } } : {}),
      ...(product.paymentMethods !== undefined ? { paymentMethods: product.paymentMethods } : {}),
      ...(record.returnUrl !== undefined ? { returnUrl: record.returnUrl } : {}),
    };
  }

  /** Only what every gateway takes, plus the payment methods when the product asks for them. */
  private paymentInput(record: PurchaseSessionRecord, product: Product): CreatePaymentInput {
    return {
      reference: record.reference,
      amount: product.amount,
      description: product.name,
      customer: record.customer,
      ...(product.paymentMethods !== undefined ? { paymentMethods: product.paymentMethods } : {}),
      ...(record.returnUrl !== undefined ? { returnUrl: record.returnUrl } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Verifying and settling
  // -------------------------------------------------------------------------

  private async verify(record: PurchaseSessionRecord, option: PurchaseOption, input: { provider: ProviderName; result: CheckoutResult }): Promise<Verdict> {
    const { provider } = input;
    if (record.kind === ProductKind.Subscription) {
      const verification = await this.host.verifyCheckout(provider, input.result, { expectedSubscriptionId: option.handle });
      await this.assertBound(record, option, verification.subscriptionId, verification.reference, true);
      if (!verification.authorized) {
        return verification.status === SubscriptionStatus.PendingAuthorization ? { kind: 'pending' } : { kind: 'failed' };
      }
      const live = await this.host.get(provider, verification.subscriptionId).catch(() => undefined);
      const fromLive = live ? statusFromSubscription(live.status) : undefined;
      const fromResult = verification.status ? statusFromSubscription(verification.status) : undefined;
      const charge = verification.charge;
      const paidCharge =
        charge && charge.status === ChargeStatus.Succeeded && charge.kind !== ChargeKind.Authorization ? charge : undefined;
      return {
        kind: 'paid',
        evidence: {
          providerId: verification.subscriptionId,
          status: fromLive ?? fromResult ?? EntitlementStatus.Active,
          ...(paidCharge ? { amount: paidCharge.amount, chargeId: paidCharge.id, ...(paidCharge.paidAt ? { paidAt: paidCharge.paidAt } : {}) } : {}),
          ...periodOf(live),
        },
      };
    }

    const product = this.product(record.product);
    const googleConsumable = provider === Provider.GooglePlay && product.googlePlay?.consumable === true;
    const result = googleConsumable ? { ...input.result, [GOOGLE_PLAY_CONSUMABLE_RESULT_KEY]: true } : input.result;
    const verification = await this.host.payments.verify(provider, result, { expectedPaymentId: option.handle });
    await this.assertBound(record, option, verification.paymentId, verification.reference, false);
    if (!verification.paid) {
      return verification.status === PaymentStatus.Pending ? { kind: 'pending' } : { kind: 'failed' };
    }
    const payment = verification.payment ?? (await this.host.payments.get(provider, verification.paymentId).catch(() => undefined));
    return {
      kind: 'paid',
      evidence: {
        providerId: verification.paymentId,
        status: payment?.status === PaymentStatus.Refunded ? EntitlementStatus.Refunded : EntitlementStatus.Active,
        ...(payment ? { amount: payment.amount } : {}),
        ...(payment?.paidAt ? { paidAt: payment.paidAt } : {}),
        ...(payment?.refundedAmount !== undefined ? { refundedAmount: payment.refundedAmount } : {}),
        chargeId: verification.paymentId,
      },
    };
  }

  /**
   * The host refuses a result for another order. Check again, so a host that does not still cannot unlock one order
   * with another's payment: the verified id or reference must be the option's handle or the session's reference, or the
   * purchase it names must carry one of them as its own reference (the facade accepts that case too).
   */
  private async assertBound(
    record: PurchaseSessionRecord,
    option: PurchaseOption,
    id: string,
    reference: string | undefined,
    subscription: boolean,
  ): Promise<void> {
    const expected = [option.handle, record.reference];
    if (expected.includes(id) || (reference !== undefined && expected.includes(reference))) return;
    const fetched = await (subscription
      ? this.host.get(option.provider, id)
      : this.host.payments.get(option.provider, id)
    ).catch(() => undefined);
    if (fetched?.reference !== undefined && expected.includes(fetched.reference)) return;
    throw new SubscriptionError(
      ErrorCode.SignatureInvalid,
      `${option.provider} result is for a different purchase than session ${record.id}`,
      { provider: option.provider },
    );
  }

  /**
   * Records a confirmed purchase. The caller holds the session lock. Order: the report (the obligation to Google),
   * then the entitlement, then the session, so a crash leaves a session that can simply be settled again; every
   * write is idempotent.
   */
  private async settle(record: PurchaseSessionRecord, option: PurchaseOption, evidence: Evidence): Promise<PurchaseSessionRecord> {
    const now = this.now();
    const session: PurchaseSessionRecord = { ...record, options: record.options, attempts: record.attempts };
    const trial = evidence.status === EntitlementStatus.Trialing;
    const subscription = session.kind === ProductKind.Subscription;

    if (session.externalTransactionToken !== undefined && option.channel === SalesChannel.Gateway) {
      const state = session.customer.state;
      if (state === undefined) {
        // Never lose a paid purchase over a missing field: `start` requires the state, so this is a damaged record.
        this.report({
          issue: PurchaseIssue.ReportNotQueued,
          message: `Session ${session.id} was paid through the alternative but has no customer state: its report to Google could not be queued`,
          sessionId: session.id,
        });
      } else {
        const gross = trial ? 0 : (evidence.amount ?? session.amount);
        const time = evidence.paidAt ?? now.toISOString();
        const id = firstTransactionId(session.id);
        const split = splitTax(gross, session.taxRateBps ?? 0);
        await this.enqueue({
          id,
          kind: ReportKind.Transaction,
          sessionId: session.id,
          customerRef: session.customerRef,
          product: session.product,
          transaction: {
            externalTransactionId: id,
            externalTransactionToken: session.externalTransactionToken,
            productKind: session.kind,
            amount: split.amount,
            taxAmount: split.taxAmount,
            transactionTime: time,
            state,
          },
          sourceId: evidence.chargeId,
          occurredAt: time,
          now,
        });
        session.initialReportId = id;
        if (evidence.chargeId !== undefined) session.initialChargeId = evidence.chargeId;
        session.initialClaimable = subscription && !trial && evidence.chargeId === undefined;
      }
    }

    const id = entitlementId(option.provider, subscription ? { subscriptionId: evidence.providerId } : { paymentId: evidence.providerId });
    await this.withLock(`${LockScope.Entitlement}:${id}`, async () => {
      const record: EntitlementRecord = {
        id,
        customerRef: session.customerRef,
        sessionId: session.id,
        product: session.product,
        kind: session.kind,
        provider: option.provider,
        channel: option.channel,
        platform: session.platform,
        ...(subscription ? { subscriptionId: evidence.providerId } : { paymentId: evidence.providerId }),
        status: evidence.status,
        ...(evidence.cancelAtPeriodEnd !== undefined ? { cancelAtPeriodEnd: evidence.cancelAtPeriodEnd } : {}),
        ...(evidence.currentPeriodEnd !== undefined ? { currentPeriodEnd: evidence.currentPeriodEnd } : {}),
        updatedAt: now.toISOString(),
        amount: evidence.amount ?? session.amount,
        ...(evidence.refundedAmount !== undefined ? { refundedAmount: evidence.refundedAmount } : {}),
        ...(evidence.chargeId !== undefined && subscription ? { lastChargeId: evidence.chargeId } : {}),
      };
      await this.store.saveEntitlement(EntitlementRecordSchema.parse(record));
    });

    session.status = SessionStatus.Completed;
    session.completedAt = now.toISOString();
    session.provider = option.provider;
    if (subscription) session.subscriptionId = evidence.providerId;
    else session.paymentId = evidence.providerId;
    await this.store.saveSession(session);
    await this.recordOutcome(option, session.kind, RouteOutcomeResult.Success);
    return session;
  }

  // -------------------------------------------------------------------------
  // Report queue
  // -------------------------------------------------------------------------

  private async enqueue(input: {
    id: string;
    kind: ReportKind;
    sessionId: string;
    customerRef: string;
    product: string;
    transaction?: ExternalTransactionReport;
    refund?: ExternalTransactionRefund;
    dependsOn?: string;
    sourceId?: string;
    occurredAt: string;
    now: Date;
  }): Promise<void> {
    const report: ReportRecord = {
      id: input.id,
      kind: input.kind,
      status: ReportStatus.Queued,
      sessionId: input.sessionId,
      customerRef: input.customerRef,
      product: input.product,
      ...(input.transaction ? { transaction: input.transaction } : {}),
      ...(input.refund ? { refund: input.refund } : {}),
      ...(input.dependsOn !== undefined ? { dependsOn: input.dependsOn } : {}),
      ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
      createdAt: input.now.toISOString(),
      dueBy: new Date(Date.parse(input.occurredAt) + REPORT_DEADLINE_MS).toISOString(),
      attempts: 0,
      nextAttemptAt: input.now.toISOString(),
    };
    await this.store.enqueueReport(report);
  }

  /** Queues the renewal or refund report an event calls for, for a session that was reported to Google. */
  private async queueEventReport(session: PurchaseSessionRecord, event: SubscriptionEvent, now: Date): Promise<void> {
    const state = session.customer.state;
    const initial = session.initialReportId as string;
    if (event.type === EventType.SubscriptionCharged) {
      const charge = event.charge;
      if (charge?.kind === ChargeKind.Authorization) return;
      if (!charge) {
        this.report({
          issue: PurchaseIssue.ReportNotQueued,
          message: `Event ${event.id} reports a charge of session ${session.id} without the charge: it cannot be reported to Google`,
          sessionId: session.id,
          eventId: event.id,
        });
        return;
      }
      if (session.initialChargeId === charge.id) return;
      if (session.initialClaimable === true) {
        // The first charge of a subscription whose first report was queued at completion: that report is this charge.
        await this.store.saveSession({ ...session, initialChargeId: charge.id, initialClaimable: false });
        session.initialChargeId = charge.id;
        session.initialClaimable = false;
        return;
      }
      if (state === undefined) return;
      const time = charge.paidAt ?? event.occurredAt ?? now.toISOString();
      const split = splitTax(charge.amount, session.taxRateBps ?? 0);
      const id = renewalTransactionId(session.id, charge.id);
      await this.enqueue({
        id,
        kind: ReportKind.Transaction,
        sessionId: session.id,
        customerRef: session.customerRef,
        product: session.product,
        transaction: {
          externalTransactionId: id,
          initialExternalTransactionId: initial,
          productKind: session.kind,
          amount: split.amount,
          taxAmount: split.taxAmount,
          transactionTime: time,
          state,
        },
        dependsOn: initial,
        sourceId: charge.id,
        occurredAt: time,
        now,
      });
      return;
    }

    if (event.type === EventType.RefundSucceeded && event.refund) {
      const refund = event.refund;
      const chargeId = refund.chargeId;
      let target: string | undefined;
      if (chargeId === session.initialChargeId) target = initial;
      else {
        const renewal = renewalTransactionId(session.id, chargeId);
        if (await this.store.getReport(renewal)) target = renewal;
      }
      const original = target ? await this.store.getReport(target) : undefined;
      if (!target || !original?.transaction) {
        this.report({
          issue: PurchaseIssue.UnmatchedRefund,
          message: `Refund ${refund.id} of charge ${chargeId} matches no transaction reported to Google for session ${session.id}`,
          sessionId: session.id,
          eventId: event.id,
        });
        return;
      }
      const time = refund.createdAt ?? event.occurredAt ?? now.toISOString();
      const paid = { amount: original.transaction.amount, taxAmount: original.transaction.taxAmount };
      const gross = paid.amount + paid.taxAmount;
      const full = refund.amount >= gross;
      const split = full ? undefined : splitRefund(refund.amount, paid);
      const id = refundReportId(session.id, refund.id);
      await this.enqueue({
        id,
        kind: ReportKind.Refund,
        sessionId: session.id,
        customerRef: session.customerRef,
        product: session.product,
        refund: {
          externalTransactionId: original.transaction.externalTransactionId,
          refundTime: time,
          ...(split ? { amount: split.amount, taxAmount: split.taxAmount } : {}),
        },
        dependsOn: target,
        sourceId: refund.id,
        occurredAt: time,
        now,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Sessions, expiry, guard
  // -------------------------------------------------------------------------

  private async load(sessionId: string): Promise<PurchaseSessionRecord> {
    const record = await this.store.getSession(sessionId);
    if (!record) throw new SubscriptionError(ErrorCode.NotFound, `Purchase session ${sessionId} does not exist`);
    return record;
  }

  private isDue(record: PurchaseSessionRecord): boolean {
    return LIVE_STATUSES.includes(record.status) && Date.parse(record.expiresAt) <= this.now().getTime();
  }

  /** Marks an unpaid session past `expiresAt` as expired and stores it. The caller holds the session lock. */
  private async expireIfDue(record: PurchaseSessionRecord): Promise<PurchaseSessionRecord> {
    if (!this.isDue(record)) return record;
    const expired = { ...record, status: SessionStatus.Expired };
    await this.store.saveSession(expired);
    return expired;
  }

  private async assertNotOwned(customerRef: string, product: Product): Promise<void> {
    if (product.appStore?.consumable === true || product.googlePlay?.consumable === true) return;
    const now = this.now();
    const owned = (await this.store.listEntitlements(customerRef)).find(
      (record) => record.product === product.key && blocksPurchase(record, now),
    );
    if (owned) {
      throw new SubscriptionError(
        ErrorCode.Conflict,
        `Customer ${customerRef} already has ${product.key} (${owned.status}, bought through ${owned.provider})`,
        { raw: toItem(owned, now) },
      );
    }
  }

  private product(key: string): Product {
    const product = this.catalog.get(key);
    if (!product) throw new SubscriptionError(ErrorCode.NotFound, `Product ${key} is not in the catalog`);
    return product;
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private now(): Date {
    return this.clock();
  }

  private capabilities(): Capabilities[] {
    return this.host.providers.map((provider) => this.host.capabilities(provider));
  }

  private report(issue: IssueReport): void {
    try {
      this.onIssue?.(issue);
    } catch {
      // A failing log hook must not fail a purchase.
    }
  }

  /** Reports an outcome to the router. The router's statistics must never stop a purchase. */
  private async record(provider: ProviderName, kind: RouteOutcomeKind, result: RouteOutcomeResult): Promise<void> {
    try {
      await this.router.record({ provider, kind, result });
    } catch (error) {
      this.report({ issue: PurchaseIssue.OutcomeNotRecorded, message: `The router could not record an outcome of ${provider}`, error });
    }
  }

  /** `record` for what a customer's checkout showed: only gateways are routed. */
  private async recordOutcome(option: PurchaseOption, kind: ProductKind, result: RouteOutcomeResult): Promise<void> {
    if (option.channel !== SalesChannel.Gateway) return;
    await this.record(
      option.provider,
      kind === ProductKind.Subscription ? RouteOutcomeKind.Authorization : RouteOutcomeKind.Payment,
      result,
    );
  }

  private async withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const started = Date.now();
    let token = await this.store.acquireLock(key, this.lockTtlMs);
    while (token === undefined) {
      if (Date.now() - started >= this.lockWaitMs) {
        throw new SubscriptionError(ErrorCode.Conflict, `Another request is changing ${key}: try again`);
      }
      await new Promise((resolve) => setTimeout(resolve, this.lockPollMs));
      token = await this.store.acquireLock(key, this.lockTtlMs);
    }
    try {
      return await work();
    } finally {
      await this.store.releaseLock(key, token).catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function toPublic(record: PurchaseSessionRecord): PurchaseSession {
  return PurchaseSessionSchema.parse(record);
}

function withoutLease(report: ReportRecord): ReportRecord {
  const { leaseToken: _token, leaseUntil: _until, ...rest } = report;
  return rest;
}

function requireCheckout(provider: ProviderName, checkout: CheckoutInstruction | undefined): CheckoutInstruction {
  if (!checkout) {
    throw new SubscriptionError(ErrorCode.UnexpectedResponse, `${provider} created the purchase without checkout instructions`, { provider });
  }
  return checkout;
}

function periodOf(subscription: Subscription | undefined): Pick<Evidence, 'currentPeriodEnd' | 'cancelAtPeriodEnd'> {
  return {
    ...(subscription?.currentPeriodEnd !== undefined ? { currentPeriodEnd: subscription.currentPeriodEnd } : {}),
    ...(subscription?.cancelAtPeriodEnd !== undefined ? { cancelAtPeriodEnd: subscription.cancelAtPeriodEnd } : {}),
  };
}

/** Every id an event may name its purchase by. */
function eventIds(event: SubscriptionEvent): string[] {
  const candidates = [
    event.subscriptionId,
    event.subscription?.id,
    event.subscription?.reference,
    event.charge?.subscriptionId,
    event.refund?.subscriptionId,
    event.paymentId,
    event.payment?.id,
    event.payment?.reference,
    event.refund?.paymentId,
    event.refund?.chargeId,
  ];
  return [...new Set(candidates.filter((value): value is string => typeof value === 'string' && value !== ''))];
}

/** What an event proves about a session nobody completed, or `undefined` when it proves no payment. */
function evidenceFromEvent(session: PurchaseSessionRecord, option: PurchaseOption, event: SubscriptionEvent): Evidence | undefined {
  if (session.kind === ProductKind.Subscription) {
    const evidenceTypes: string[] = [EventType.SubscriptionAuthorized, EventType.SubscriptionActivated, EventType.SubscriptionCharged];
    if (!evidenceTypes.includes(event.type)) return undefined;
    const embedded = event.subscription ? statusFromSubscription(event.subscription.status) : undefined;
    if (event.subscription && embedded === undefined) return undefined;
    const status = embedded ?? EntitlementStatus.Active;
    if (!ACCESS_STATUSES.includes(status)) return undefined;
    const charge = event.charge;
    const paidCharge =
      event.type === EventType.SubscriptionCharged && charge && charge.kind !== ChargeKind.Authorization ? charge : undefined;
    return {
      providerId: event.subscriptionId ?? event.subscription?.id ?? option.handle,
      status,
      ...(paidCharge ? { amount: paidCharge.amount, chargeId: paidCharge.id, paidAt: paidCharge.paidAt ?? event.occurredAt } : {}),
      ...periodOf(event.subscription),
    };
  }
  if (event.type !== EventType.PaymentSucceeded) return undefined;
  const payment = event.payment;
  return {
    providerId: event.paymentId ?? payment?.id ?? option.handle,
    status: EntitlementStatus.Active,
    ...(payment ? { amount: payment.amount } : {}),
    ...(payment?.paidAt !== undefined || event.occurredAt !== undefined ? { paidAt: payment?.paidAt ?? event.occurredAt } : {}),
    chargeId: event.paymentId ?? payment?.id ?? option.handle,
  };
}
