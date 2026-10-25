import type {
  BillingFailure,
  Entitlements,
  PurchaseEvent,
  PurchaseFailure,
  PurchaseOutcome,
  PurchaseSession,
  RefundRequestOutcome,
  ReturnLinkResult,
  Unknown,
} from './types';

/**
 * Turns the native payloads into the typed unions. This is translation only: a payload this version does not know (a
 * `type` a newer native SDK added, or one that is malformed) becomes `{ type: 'unknown', name, raw }`, never a throw.
 */

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unknown(raw: unknown): Unknown {
  const name = isRecord(raw) && typeof raw.type === 'string' ? raw.type : '';
  return { type: 'unknown', name, raw };
}

function session(value: unknown): PurchaseSession | undefined {
  return isRecord(value) && typeof value.id === 'string'
    ? (value as unknown as PurchaseSession)
    : undefined;
}

function failure(value: unknown): PurchaseFailure | undefined {
  return isRecord(value) && typeof value.reason === 'string'
    ? (value as unknown as PurchaseFailure)
    : undefined;
}

function billingFailure(value: unknown): BillingFailure | undefined {
  return isRecord(value) && typeof value.reason === 'string'
    ? (value as unknown as BillingFailure)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function texts(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export function decodeOutcome(raw: unknown): PurchaseOutcome {
  if (!isRecord(raw)) {
    return unknown(raw);
  }
  const s = session(raw.session);
  const f = failure(raw.failure);
  switch (raw.type) {
    case 'completed':
    case 'pending':
    case 'awaitingReturn':
      return s ? { type: raw.type, session: s } : unknown(raw);
    case 'cancelled':
      return { type: 'cancelled', ...(s ? { session: s } : {}) };
    case 'unverified':
      return s
        ? { type: 'unverified', session: s, reason: text(raw.reason) ?? '' }
        : unknown(raw);
    case 'awaitingBackend':
    case 'rejected':
      return s && f ? { type: raw.type, session: s, failure: f } : unknown(raw);
    case 'failed': {
      const b = billingFailure(raw.failure);
      return s && b ? { type: 'failed', session: s, failure: b } : unknown(raw);
    }
    default:
      return unknown(raw);
  }
}

export function decodeEvent(raw: unknown): PurchaseEvent {
  if (!isRecord(raw)) {
    return unknown(raw);
  }
  const s = session(raw.session);
  const f = failure(raw.failure);
  const sessionId = text(raw.sessionId);
  const transactionId = text(raw.transactionId);
  switch (raw.type) {
    case 'completed': {
      if (!s) {
        return unknown(raw);
      }
      const purchaseToken = text(raw.purchaseToken);
      return {
        type: 'completed',
        session: s,
        ...(transactionId !== undefined ? { transactionId } : {}),
        ...(purchaseToken !== undefined ? { purchaseToken } : {}),
      };
    }
    case 'pending':
      return sessionId !== undefined
        ? { type: 'pending', sessionId, productIds: texts(raw.productIds) }
        : unknown(raw);
    case 'awaitingBackend':
    case 'rejected':
      return sessionId !== undefined && f
        ? {
            type: raw.type,
            sessionId,
            failure: f,
            ...(transactionId !== undefined ? { transactionId } : {}),
          }
        : unknown(raw);
    case 'hostedCheckoutOpened':
      return s ? { type: 'hostedCheckoutOpened', session: s } : unknown(raw);
    case 'unmatchedPurchase': {
      const purchaseToken = text(raw.purchaseToken);
      return {
        type: 'unmatchedPurchase',
        productIds: texts(raw.productIds),
        ...(transactionId !== undefined ? { transactionId } : {}),
        ...(purchaseToken !== undefined ? { purchaseToken } : {}),
      };
    }
    case 'unverifiedTransaction':
      return transactionId !== undefined
        ? {
            type: 'unverifiedTransaction',
            transactionId,
            reason: text(raw.reason) ?? '',
          }
        : unknown(raw);
    default:
      return unknown(raw);
  }
}

export function decodeReturnLinkResult(raw: unknown): ReturnLinkResult {
  if (!isRecord(raw)) {
    return unknown(raw);
  }
  const s = session(raw.session);
  const f = failure(raw.failure);
  switch (raw.type) {
    case 'ignored':
      return { type: 'ignored' };
    case 'completed':
    case 'notPaid':
    case 'stillPending':
      return s ? { type: raw.type, session: s } : unknown(raw);
    case 'backendFailed':
      return f ? { type: 'backendFailed', failure: f } : unknown(raw);
    default:
      return unknown(raw);
  }
}

export function decodeEvents(raw: unknown): PurchaseEvent[] {
  return isRecord(raw) && Array.isArray(raw.events)
    ? raw.events.map(decodeEvent)
    : [];
}

export function decodeEntitlements(raw: unknown): Entitlements {
  if (
    isRecord(raw) &&
    typeof raw.customerRef === 'string' &&
    typeof raw.active === 'boolean' &&
    Array.isArray(raw.items)
  ) {
    return raw as unknown as Entitlements;
  }
  throw new TypeError('The native module returned unreadable entitlements');
}

export function decodeRefundOutcome(raw: unknown): RefundRequestOutcome {
  if (isRecord(raw) && typeof raw.outcome === 'string') {
    return raw.outcome;
  }
  throw new TypeError('The native module returned an unreadable refund result');
}
