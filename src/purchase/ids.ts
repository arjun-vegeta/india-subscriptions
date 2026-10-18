import { createHash, randomBytes } from 'node:crypto';
import type { Provider } from '../constants.js';
import {
  ENTITLEMENT_ID_CHARS,
  ENTITLEMENT_ID_PREFIX,
  EXTERNAL_ID_PREFIX,
  EXTERNAL_ID_REFUND_MARK,
  EXTERNAL_ID_RENEWAL_MARK,
  EXTERNAL_ID_SESSION_CHARS,
  EXTERNAL_ID_SOURCE_CHARS,
  GENERATED_REFERENCE_PREFIX,
  GENERATED_REFERENCE_RANDOM_BYTES,
  SESSION_ID_PREFIX,
  SESSION_ID_RANDOM_BYTES,
} from './constants.js';
import type { EntitlementLookup } from './store.js';

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** A new, unguessable session id. */
export function newSessionId(): string {
  return SESSION_ID_PREFIX + randomBytes(SESSION_ID_RANDOM_BYTES).toString('base64url');
}

/** A new reference that fits every gateway (`MAX_GATEWAY_ID_LENGTH` characters of `GATEWAY_ID_PATTERN`). */
export function newReference(): string {
  return GENERATED_REFERENCE_PREFIX + randomBytes(GENERATED_REFERENCE_RANDOM_BYTES).toString('base64url');
}

/**
 * The external transaction id of the first transaction of a session. It is derived from the session id by a hash, so
 * Google never sees the session id (which is a capability) and the same session always yields the same id.
 */
export function firstTransactionId(sessionId: string): string {
  return EXTERNAL_ID_PREFIX + digest(sessionId).slice(0, EXTERNAL_ID_SESSION_CHARS);
}

/** The external transaction id of the renewal that charge `chargeId` pays for. Unique per charge. */
export function renewalTransactionId(sessionId: string, chargeId: string): string {
  return `${firstTransactionId(sessionId)}_${EXTERNAL_ID_RENEWAL_MARK}${digest(chargeId).slice(0, EXTERNAL_ID_SOURCE_CHARS)}`;
}

/** The id of the report of refund `refundId`. Unique per refund. */
export function refundReportId(sessionId: string, refundId: string): string {
  return `${firstTransactionId(sessionId)}_${EXTERNAL_ID_REFUND_MARK}${digest(refundId).slice(0, EXTERNAL_ID_SOURCE_CHARS)}`;
}

/** The entitlement id for what a provider calls a purchase: the same purchase always lands on the same item. */
export function entitlementId(provider: Provider, lookup: EntitlementLookup): string {
  const key = lookup.subscriptionId !== undefined ? `subscription:${lookup.subscriptionId}` : `payment:${lookup.paymentId}`;
  return ENTITLEMENT_ID_PREFIX + digest(`${provider}:${key}`).slice(0, ENTITLEMENT_ID_CHARS);
}
