/**
 * Typed constants for purchase sessions, platform policy, entitlements and the report queue. Same pattern as
 * `src/constants.ts`: an `as const` object plus a union type of the same name. Code must reference these, never the
 * bare literals.
 */
import { ErrorCode } from '../constants.js';

/** Where a purchase session is in its life. */
export const SessionStatus = {
  /** Created. The customer has not come back from the checkout yet. */
  Open: 'open',
  /**
   * The customer has paid or approved but the provider has not confirmed yet (a mandate pending at the bank), or the
   * customer chose the alternative payment on Google's screen and the gateway checkout is under way. A confirmation
   * (`complete` or a webhook event) finishes it.
   */
  AwaitingPayment: 'awaiting_payment',
  /** Paid or authorised and recorded as an entitlement. */
  Completed: 'completed',
  /**
   * A verification said the purchase was not paid or not authorised. Not final: a later result or event that shows the
   * money moved (a customer who retries on the same Cashfree order) completes the session.
   */
  Failed: 'failed',
  /** `expiresAt` passed without a payment. Not final either: a payment confirmed afterwards still completes it. */
  Expired: 'expired',
} as const;
export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus];

/** Statuses a session can still move to `completed` from by a verification that says the customer paid. */
export const UNSETTLED_SESSION_STATUSES: readonly SessionStatus[] = [
  SessionStatus.Open,
  SessionStatus.AwaitingPayment,
  SessionStatus.Failed,
  SessionStatus.Expired,
];

/** What a customer owns, per entitlement item. */
export const EntitlementStatus = {
  /** Paid and current. A paid one-time purchase stays `active`. */
  Active: 'active',
  /** In a free trial. */
  Trialing: 'trialing',
  /** A charge failed and is being retried; the subscription is alive. */
  PastDue: 'past_due',
  /** Charging is paused. */
  Paused: 'paused',
  /** Retries are exhausted; no further automatic charges. */
  Halted: 'halted',
  /** Ended. Terminal. */
  Cancelled: 'cancelled',
  /** The term ended (expired, or every cycle was collected). Terminal. */
  Expired: 'expired',
  /** A one-time purchase that was refunded in full. Terminal. */
  Refunded: 'refunded',
} as const;
export type EntitlementStatus = (typeof EntitlementStatus)[keyof typeof EntitlementStatus];

/** Statuses that give the customer access (before the `cancelAtPeriodEnd` rule is applied). */
export const ACCESS_STATUSES: readonly EntitlementStatus[] = [
  EntitlementStatus.Active,
  EntitlementStatus.Trialing,
  EntitlementStatus.PastDue,
];

/**
 * Statuses that stop a customer buying the same product again (the duplicate-purchase guard): everything that gives
 * access, plus a paused subscription (it would resume next to the new one).
 */
export const BLOCKING_STATUSES: readonly EntitlementStatus[] = [...ACCESS_STATUSES, EntitlementStatus.Paused];

/** How one gateway attempt of a `start` or `chooseAlternative` ended. */
export const AttemptOutcome = {
  /** The gateway created the order or mandate. */
  Created: 'created',
  /** The create call failed. */
  Failed: 'failed',
} as const;
export type AttemptOutcome = (typeof AttemptOutcome)[keyof typeof AttemptOutcome];

export const ReportKind = {
  /** A first purchase, a free trial, or a renewal: `createexternaltransaction`. */
  Transaction: 'transaction',
  /** A refund: `refundexternaltransaction`. */
  Refund: 'refund',
} as const;
export type ReportKind = (typeof ReportKind)[keyof typeof ReportKind];

export const ReportStatus = {
  /** Waiting to be sent (or to be sent again). */
  Queued: 'queued',
  /** Google accepted it. Final. */
  Sent: 'sent',
  /** Google refused it as invalid (`VALIDATION`). Never retried: fix the data and enqueue it again by hand. */
  Rejected: 'rejected',
} as const;
export type ReportStatus = (typeof ReportStatus)[keyof typeof ReportStatus];

/** What a flush did with one report. */
export const FlushOutcome = {
  Sent: 'sent',
  /** The attempt failed; the report stays queued and is tried again after a backoff. */
  Retrying: 'retrying',
  /** Waiting for the report it refers to (the first transaction of a renewal, the transaction of a refund). */
  Blocked: 'blocked',
  /** Google refused it as invalid; it will not be retried. */
  Rejected: 'rejected',
  /** No reporter is configured, so nothing can be sent. The report stays queued. */
  NoReporter: 'no_reporter',
} as const;
export type FlushOutcome = (typeof FlushOutcome)[keyof typeof FlushOutcome];

/** Configuration problems found in the catalog or the policy, each with a stable name. */
export const ConfigIssue = {
  DuplicateProductKey: 'duplicate_product_key',
  SubscriptionWithoutInterval: 'subscription_without_interval',
  OneTimeWithInterval: 'one_time_with_interval',
  OneTimeWithTrial: 'one_time_with_trial',
  PhysicalGoodsWithStoreProduct: 'physical_goods_with_store_product',
  MissingAppStoreProvider: 'missing_app_store_provider',
  MissingAppStoreProduct: 'missing_app_store_product',
  MissingGooglePlayProvider: 'missing_google_play_provider',
  MissingGooglePlayProduct: 'missing_google_play_product',
  MissingGateway: 'missing_gateway',
  MissingTaxRate: 'missing_tax_rate',
  MissingReporter: 'missing_reporter',
  MissingCustomerState: 'missing_customer_state',
  PlatformNotOffered: 'platform_not_offered',
  /** The provider that owns a store mapping is of the wrong kind (a gateway registered as the app store). */
  ProviderKindMismatch: 'provider_kind_mismatch',
} as const;
export type ConfigIssue = (typeof ConfigIssue)[keyof typeof ConfigIssue];

/** Problems found while handling events that no caller can act on in the request, reported to `onIssue`. */
export const PurchaseIssue = {
  /** A refund of a user choice billing transaction that matches no reported transaction. */
  UnmatchedRefund: 'unmatched_refund',
  /** A user choice billing charge the library could not queue a report for. */
  ReportNotQueued: 'report_not_queued',
  /**
   * A customer paid for the same product in two sessions (for example on the web and on a phone at the same time). Both
   * entitlements are kept because the money has moved; refund or cancel one.
   */
  DuplicatePurchase: 'duplicate_purchase',
  /** An event could not be applied; the others of its batch were. */
  EventFailed: 'event_failed',
  /** The router could not record an outcome (its statistics store failed). The purchase went on. */
  OutcomeNotRecorded: 'outcome_not_recorded',
} as const;
export type PurchaseIssue = (typeof PurchaseIssue)[keyof typeof PurchaseIssue];

/**
 * The error codes of a failed create at a gateway after which the next ranked gateway is tried: the gateway could not
 * take the request (or its answer is unknown), and nothing about the request itself is wrong. `VALIDATION` and
 * `CONFLICT` are deliberately absent: a refusal of the request, or of an optional input, is not a reason to try another
 * gateway. Neither is any other code.
 */
export const FALLBACK_ERROR_CODES: readonly ErrorCode[] = [
  ErrorCode.ProviderUnavailable,
  ErrorCode.RateLimited,
  ErrorCode.Network,
  ErrorCode.Timeout,
  ErrorCode.Auth,
  ErrorCode.ProviderError,
  ErrorCode.OutcomeUnknown,
];

/** The fallback codes that say the gateway could not be reached or is unusable, so they feed the circuit breaker. */
export const UNAVAILABLE_ERROR_CODES: readonly ErrorCode[] = FALLBACK_ERROR_CODES.filter(
  (code) => code !== ErrorCode.ProviderError,
);

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/** Prefix of a purchase session id. */
export const SESSION_ID_PREFIX = 'ps_';
/** Bytes of randomness in a session id (192 bits): the id is the capability to complete the session. */
export const SESSION_ID_RANDOM_BYTES = 24;
/** Prefix of a reference the library generates. A reference must fit every gateway: see `MAX_GATEWAY_ID_LENGTH`. */
export const GENERATED_REFERENCE_PREFIX = 'pr_';
/** Bytes of randomness in a generated reference (11 bytes encode to 15 characters). */
export const GENERATED_REFERENCE_RANDOM_BYTES = 11;
/** Prefix of an external transaction id. Google allows 1 to 63 characters of `[A-Za-z0-9_-]`. */
export const EXTERNAL_ID_PREFIX = 'ext_';
/** Hex characters of the session digest inside an external transaction id. */
export const EXTERNAL_ID_SESSION_CHARS = 24;
/** Hex characters of the digest of a charge or refund id inside an external transaction id. */
export const EXTERNAL_ID_SOURCE_CHARS = 12;
/** Marks a renewal inside an external transaction id. */
export const EXTERNAL_ID_RENEWAL_MARK = 'r';
/** Marks a refund inside a report id. */
export const EXTERNAL_ID_REFUND_MARK = 'f';
/** The longest external transaction id Google accepts. */
export const MAX_EXTERNAL_TRANSACTION_ID_LENGTH = 63;
/** The characters Google accepts in an external transaction id. */
export const EXTERNAL_TRANSACTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,63}$/;
/** Prefix of an entitlement id. */
export const ENTITLEMENT_ID_PREFIX = 'ent_';
/** Hex characters of the digest in an entitlement id. */
export const ENTITLEMENT_ID_CHARS = 32;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** How long a session stays open: 24 hours. */
export const DEFAULT_SESSION_TTL_MS = 24 * HOUR_MS;
/** Google wants a transaction reported within 24 hours of the payment's authorisation. */
export const REPORT_DEADLINE_MS = 24 * HOUR_MS;
/** Most reports one `flush` claims when no limit is given. */
export const DEFAULT_FLUSH_LIMIT = 50;
/** The first retry of a failed report waits this long. */
export const DEFAULT_RETRY_BASE_MS = MINUTE_MS;
/** Each further retry waits twice as long as the last, up to this. */
export const DEFAULT_RETRY_MAX_MS = HOUR_MS;
/** How long a flush owns the reports it claimed: longer than any one call to Google. */
export const DEFAULT_REPORT_LEASE_MS = 5 * MINUTE_MS;
/** How long a per-session or per-entitlement lock is held before the store lets it expire. */
export const DEFAULT_LOCK_TTL_MS = 2 * MINUTE_MS;
/** How long a request waits for a lock another request holds before it gives up with `CONFLICT`. */
export const DEFAULT_LOCK_WAIT_MS = 15_000;
/** How often a waiting request looks at the lock again. */
export const DEFAULT_LOCK_POLL_MS = 10;
/** Most overdue reports a flush lists. */
export const MAX_OVERDUE_LISTED = 100;

/** Basis points in one whole (100%). */
export const BPS_DENOMINATOR = 10_000;

/** Keys of the lock a start takes, a complete takes, and an entitlement update takes. */
export const LockScope = {
  Start: 'start',
  Session: 'session',
  Entitlement: 'entitlement',
} as const;
export type LockScope = (typeof LockScope)[keyof typeof LockScope];

/** Keys of the result passed to a Google Play one-time verification (the adapter reads `consumable`). */
export const GOOGLE_PLAY_CONSUMABLE_RESULT_KEY = 'consumable';
