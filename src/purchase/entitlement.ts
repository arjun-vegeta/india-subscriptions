import { EventType, ProductKind, SubscriptionStatus } from '../constants.js';
import type { SubscriptionEvent } from '../schemas.js';
import { ACCESS_STATUSES, BLOCKING_STATUSES, EntitlementStatus } from './constants.js';
import type { EntitlementItem, EntitlementRecord } from './schemas.js';

/**
 * Entitlement rules, pure.
 *
 * What counts as active, per status:
 *
 * | status                                              | access | blocks buying the product again |
 * | --------------------------------------------------- | ------ | ------------------------------- |
 * | `active`, `trialing`                                | yes    | yes                             |
 * | `past_due` (a charge failed, retries running)       | yes    | yes                             |
 * | `paused`                                            | no     | yes (it would resume next to the new one) |
 * | `halted`, `cancelled`, `expired`, `refunded`        | no     | no                              |
 *
 * A subscription cancelled at the end of its period stays `active` with `cancelAtPeriodEnd`; it stops giving access,
 * and stops blocking, once `currentPeriodEnd` has passed, whether or not the closing event arrived.
 */

/** The entitlement status a subscription status stands for, or `undefined` for a mandate that has not started. */
export function statusFromSubscription(status: SubscriptionStatus): EntitlementStatus | undefined {
  switch (status) {
    case SubscriptionStatus.Trialing:
      return EntitlementStatus.Trialing;
    case SubscriptionStatus.Active:
      return EntitlementStatus.Active;
    case SubscriptionStatus.PastDue:
      return EntitlementStatus.PastDue;
    case SubscriptionStatus.Halted:
      return EntitlementStatus.Halted;
    case SubscriptionStatus.Paused:
      return EntitlementStatus.Paused;
    case SubscriptionStatus.Cancelled:
    case SubscriptionStatus.Failed:
      return EntitlementStatus.Cancelled;
    case SubscriptionStatus.Completed:
    case SubscriptionStatus.Expired:
      return EntitlementStatus.Expired;
    case SubscriptionStatus.Created:
    case SubscriptionStatus.PendingAuthorization:
      return undefined;
  }
}

const TERMINAL_ENTITLEMENT_STATUSES: readonly EntitlementStatus[] = [
  EntitlementStatus.Cancelled,
  EntitlementStatus.Expired,
  EntitlementStatus.Refunded,
];

function periodEnded(record: EntitlementRecord, now: Date): boolean {
  return (
    record.cancelAtPeriodEnd === true &&
    record.currentPeriodEnd !== undefined &&
    Date.parse(record.currentPeriodEnd) <= now.getTime()
  );
}

/** True when the item gives the customer access at `now`. */
export function grantsAccess(record: EntitlementRecord, now: Date): boolean {
  return ACCESS_STATUSES.includes(record.status) && !periodEnded(record, now);
}

/** True when the item stops the customer buying the product again at `now` (the duplicate-purchase guard). */
export function blocksPurchase(record: EntitlementRecord, now: Date): boolean {
  return BLOCKING_STATUSES.includes(record.status) && !periodEnded(record, now);
}

/** The public view of a stored item. */
export function toItem(record: EntitlementRecord, now: Date): EntitlementItem {
  return {
    product: record.product,
    kind: record.kind,
    provider: record.provider,
    channel: record.channel,
    platform: record.platform,
    ...(record.subscriptionId !== undefined ? { subscriptionId: record.subscriptionId } : {}),
    ...(record.paymentId !== undefined ? { paymentId: record.paymentId } : {}),
    status: record.status,
    active: grantsAccess(record, now),
    ...(record.cancelAtPeriodEnd !== undefined ? { cancelAtPeriodEnd: record.cancelAtPeriodEnd } : {}),
    ...(record.currentPeriodEnd !== undefined ? { currentPeriodEnd: record.currentPeriodEnd } : {}),
    updatedAt: record.updatedAt,
  };
}

export interface EventEffect {
  record: EntitlementRecord;
  /** False when the event changed nothing (a stale event, an event about something else, a repeat). */
  changed: boolean;
}

/**
 * Applies one event to an entitlement and returns the result; `record` is never mutated.
 *
 * - An event older than the newest one applied (`occurredAt` before `lastEventAt`) changes nothing, so a redelivered or
 *   late webhook cannot undo what a newer one did. An event with no timestamp cannot revive an ended item.
 * - Subscription events set the status (`activated`/`resumed`/`charged` active or trialing, `charge_failed`/`past_due`
 *   past due, `paused`, `halted`, `cancelled`, `completed`/`expired` expired) and take `currentPeriodEnd` and
 *   `cancelAtPeriodEnd` from the subscription they carry.
 * - A refund of a one-time purchase adds to `refundedAmount` (each refund once) and, when the whole price is back, ends
 *   the item as `refunded`. A refund of a subscription charge changes nothing here: ending the subscription is its own event.
 */
export function applyEvent(record: EntitlementRecord, event: SubscriptionEvent, now: Date): EventEffect {
  const unchanged: EventEffect = { record, changed: false };
  const at = event.occurredAt;
  if (at !== undefined && record.lastEventAt !== undefined && Date.parse(at) < Date.parse(record.lastEventAt)) return unchanged;
  const ended = TERMINAL_ENTITLEMENT_STATUSES.includes(record.status);
  if (ended && at === undefined) return unchanged;

  const next: EntitlementRecord = { ...record };
  const subscription = event.subscription;

  if (record.kind === ProductKind.OneTime) {
    switch (event.type) {
      case EventType.PaymentSucceeded:
        if (record.status !== EntitlementStatus.Refunded) next.status = EntitlementStatus.Active;
        break;
      case EventType.RefundSucceeded: {
        const refund = event.refund;
        if (!refund) break;
        const counted = new Set(record.refundIds ?? []);
        const cumulative = event.payment?.refundedAmount;
        if (cumulative !== undefined) {
          next.refundedAmount = Math.max(record.refundedAmount ?? 0, cumulative);
        } else if (!counted.has(refund.id)) {
          next.refundedAmount = (record.refundedAmount ?? 0) + refund.amount;
        }
        counted.add(refund.id);
        next.refundIds = [...counted];
        if ((next.refundedAmount ?? 0) >= record.amount) next.status = EntitlementStatus.Refunded;
        break;
      }
      default:
        break;
    }
  } else {
    const embedded = subscription ? statusFromSubscription(subscription.status) : undefined;
    const current = record.status;
    const alive = current === EntitlementStatus.Active || current === EntitlementStatus.Trialing;
    switch (event.type) {
      case EventType.SubscriptionActivated:
      case EventType.SubscriptionResumed:
      case EventType.SubscriptionCharged:
        next.status = embedded === EntitlementStatus.Trialing ? EntitlementStatus.Trialing : EntitlementStatus.Active;
        break;
      case EventType.SubscriptionAuthorized:
      case EventType.SubscriptionUpdated:
        if (embedded !== undefined) next.status = embedded;
        break;
      case EventType.SubscriptionChargeFailed:
      case EventType.SubscriptionPastDue:
        if (alive || (event.type === EventType.SubscriptionPastDue && current === EntitlementStatus.PastDue)) {
          next.status = EntitlementStatus.PastDue;
        }
        break;
      case EventType.SubscriptionHalted:
        next.status = EntitlementStatus.Halted;
        break;
      case EventType.SubscriptionPaused:
        next.status = EntitlementStatus.Paused;
        break;
      case EventType.SubscriptionCancelled:
        next.status = EntitlementStatus.Cancelled;
        break;
      case EventType.SubscriptionCompleted:
      case EventType.SubscriptionExpired:
        next.status = EntitlementStatus.Expired;
        break;
      default:
        break;
    }
    if (subscription && !TERMINAL_ENTITLEMENT_STATUSES.includes(next.status)) {
      if (subscription.currentPeriodEnd !== undefined) next.currentPeriodEnd = subscription.currentPeriodEnd;
      if (subscription.cancelAtPeriodEnd !== undefined) next.cancelAtPeriodEnd = subscription.cancelAtPeriodEnd;
      else if (event.type === EventType.SubscriptionCharged) next.cancelAtPeriodEnd = false;
    }
  }

  if (at !== undefined && (record.lastEventAt === undefined || Date.parse(at) > Date.parse(record.lastEventAt))) {
    next.lastEventAt = at;
  }
  const changed = JSON.stringify(stable(next)) !== JSON.stringify(stable(record));
  if (!changed) return unchanged;
  next.updatedAt = now.toISOString();
  return { record: next, changed: true };
}

function stable(record: EntitlementRecord): unknown {
  const { updatedAt: _updatedAt, ...rest } = record;
  return Object.fromEntries(Object.entries(rest).sort(([a], [b]) => (a < b ? -1 : 1)));
}
