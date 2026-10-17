import {
  ChargeKind,
  ChargeStatus,
  Currency,
  ErrorCode,
  EventType,
  PaymentStatus,
  Provider,
  RefundStatus,
  SchedulingMode,
  SubscriptionStatus,
} from '../../constants.js';
import { SubscriptionError, unsupported } from '../../errors.js';
import type {
  Charge,
  Payment,
  Refund,
  Subscription,
  SubscriptionEvent,
} from '../../schemas.js';
import { toIso } from '../../time.js';
import {
  AppStoreProductType,
  AppStoreSubscriptionStatus,
  AutoRenewStatus,
  EXPIRATION_INTENT_STATUS,
  MILLIUNITS_PER_PAISE,
  NOTIFICATION_EVENT_MAP,
  OfferDiscountType,
  REFUND_REVOCATION_TYPES,
  REVOCATION_CHARGE_STATUS,
  REVOCATION_PAYMENT_STATUS,
  REVOCATION_PERCENTAGE_FULL,
  RevocationType,
  SUBSCRIPTION_EVENT_TYPES,
  SUBSCRIPTION_STATUS_MAP,
  TRANSACTION_STATUS_PURCHASED,
  TRANSACTION_STATUS_REVOKED,
  UNKNOWN_SUBSCRIPTION_STATUS,
  notificationKey,
} from './constants.js';
import type {
  NotificationPayload,
  RenewalInfoPayload,
  TransactionPayload,
} from './schemas.js';

/** A table lookup that answers `undefined` for a key the table does not hold, whatever the key's type. */
function lookup<T>(table: Readonly<Record<string | number, T>>, key: string | number | null | undefined): T | undefined {
  if (key === null || key === undefined) return undefined;
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

function isoOf(milliseconds: number | null | undefined): string | undefined {
  return milliseconds === null || milliseconds === undefined ? undefined : toIso(new Date(milliseconds));
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Milliunits (the price multiplied by 1000) to paise, in integers: 1 rupee is 1000 milliunits and 100 paise, so one paise is
 * ten milliunits. A price Apple records with a fraction of a paisa (never the case for a price set in App Store Connect) is
 * rounded half up.
 */
export function milliunitsToPaise(milliunits: number): number {
  const remainder = milliunits % MILLIUNITS_PER_PAISE;
  const whole = (milliunits - remainder) / MILLIUNITS_PER_PAISE;
  return remainder * 2 >= MILLIUNITS_PER_PAISE ? whole + 1 : whole;
}

/** True when the payload prices the purchase in a currency other than INR. Without a `currency` there is nothing to object to. */
export function isForeignCurrency(currency: string | null | undefined): boolean {
  return currency !== null && currency !== undefined && currency !== Currency.INR;
}

/**
 * The unified model is INR only, so a transaction priced in another currency cannot be turned into a `Charge`, a `Payment`
 * or a `Refund`: their amounts would be wrong. Reading one is refused with `UNSUPPORTED`, naming the currency and the
 * storefront; the raw transaction stays in the signed data the caller holds. A subscription, an event and a verification
 * result never fail for it: they carry no amount and no currency instead (see `mapSubscription`, `mapNotification`).
 */
function assertInr(transaction: TransactionPayload, what: string): void {
  if (!isForeignCurrency(transaction.currency)) return;
  const storefront = transaction.storefront ? ` (storefront ${transaction.storefront})` : '';
  throw unsupported(
    Provider.AppStore,
    `a ${what} priced in ${transaction.currency}`,
    `transaction ${transaction.transactionId} is priced in ${transaction.currency}${storefront}, and this library's model is INR only; sell the product on the India storefront only`,
  );
}

/** The amount of a transaction in paise. A transaction without a price (a free offer code, for one) is 0. */
function amountOf(transaction: TransactionPayload): number {
  return transaction.price === null || transaction.price === undefined ? 0 : milliunitsToPaise(transaction.price);
}

/**
 * How much of the transaction was refunded, in paise, or `undefined` when none was: a full refund is the whole amount, a prorated
 * refund the share `revocationPercentage` names (milliunits of a percent; without one, which the documentation does not allow,
 * the whole amount). A revocation that returned no money (Family Sharing, a group assignment) refunded nothing.
 */
export function refundedAmountOf(transaction: TransactionPayload): number | undefined {
  if (transaction.revocationDate === null || transaction.revocationDate === undefined) return undefined;
  if (transaction.revocationType !== null && transaction.revocationType !== undefined && !REFUND_REVOCATION_TYPES.includes(transaction.revocationType)) {
    return undefined;
  }
  const amount = amountOf(transaction);
  const percentage = transaction.revocationPercentage;
  if (transaction.revocationType !== RevocationType.RefundProrated || percentage === null || percentage === undefined) return amount;
  // Integer arithmetic: amount (paise) times percentage (milliunits of a percent), rounded half up.
  const product = amount * percentage;
  const remainder = product % REVOCATION_PERCENTAGE_FULL;
  const whole = (product - remainder) / REVOCATION_PERCENTAGE_FULL;
  return remainder * 2 >= REVOCATION_PERCENTAGE_FULL ? whole + 1 : whole;
}

function isRevoked(transaction: TransactionPayload): boolean {
  return transaction.revocationDate !== null && transaction.revocationDate !== undefined;
}

/** The revocation type table key of a revoked transaction; a payload with a date and no type is a plain refund. */
function revocationKey(transaction: TransactionPayload): string {
  return transaction.revocationType ?? RevocationType.RefundFull;
}

function providerStatusOf(transaction: TransactionPayload): string {
  if (!isRevoked(transaction)) return TRANSACTION_STATUS_PURCHASED;
  return transaction.revocationType ?? TRANSACTION_STATUS_REVOKED;
}

export function isSubscriptionTransaction(transaction: TransactionPayload): boolean {
  return transaction.type === AppStoreProductType.AutoRenewableSubscription;
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/**
 * One transaction of an auto-renewable subscription (the first purchase, a renewal, an upgrade) as a charge. Every transaction
 * is a charge that went through: a renewal that failed creates none. The id is the `transactionId`; `subscriptionId` is the
 * `originalTransactionId`. A revoked transaction is `refunded`, `partially_refunded` or, when no money went back,
 * `cancelled`. A free trial is a charge of 0.
 */
export function mapCharge(transaction: TransactionPayload): Charge {
  assertInr(transaction, 'charge');
  const revoked = isRevoked(transaction);
  const refunded = refundedAmountOf(transaction);
  const status = revoked ? (lookup(REVOCATION_CHARGE_STATUS, revocationKey(transaction)) ?? ChargeStatus.Refunded) : ChargeStatus.Succeeded;
  return {
    provider: Provider.AppStore,
    id: transaction.transactionId,
    ...(transaction.appAccountToken ? { reference: transaction.appAccountToken } : {}),
    subscriptionId: transaction.originalTransactionId,
    kind: ChargeKind.Recurring,
    status,
    providerStatus: providerStatusOf(transaction),
    amount: amountOf(transaction),
    currency: Currency.INR,
    ...(isoOf(transaction.purchaseDate) ? { paidAt: isoOf(transaction.purchaseDate) as string } : {}),
    ...(refunded !== undefined ? { refundedAmount: refunded } : {}),
    raw: transaction,
  };
}

/**
 * A one-time purchase (consumable, non-consumable, non-renewing subscription) as a payment. The id is the `transactionId`.
 * `refundedAmount` is set on a refunded transaction.
 */
export function mapPayment(transaction: TransactionPayload): Payment {
  assertInr(transaction, 'payment');
  const revoked = isRevoked(transaction);
  const refunded = refundedAmountOf(transaction);
  const status = revoked ? (lookup(REVOCATION_PAYMENT_STATUS, revocationKey(transaction)) ?? PaymentStatus.Refunded) : PaymentStatus.Succeeded;
  const purchasedAt = isoOf(transaction.purchaseDate);
  return {
    provider: Provider.AppStore,
    id: transaction.transactionId,
    ...(transaction.appAccountToken ? { reference: transaction.appAccountToken } : {}),
    status,
    providerStatus: providerStatusOf(transaction),
    amount: amountOf(transaction),
    currency: Currency.INR,
    ...(refunded !== undefined ? { refundedAmount: refunded } : {}),
    ...(purchasedAt ? { createdAt: purchasedAt, paidAt: purchasedAt } : {}),
    raw: transaction,
  };
}

/**
 * A refund of a transaction, as the `REFUND` notification and the transaction's revocation describe it. Apple gives a refund no
 * id of its own, so `id` and `chargeId` are the transaction's id; `paymentId` is set for a one-time product, `subscriptionId`
 * for a subscription.
 */
export function mapRefund(transaction: TransactionPayload): Refund {
  assertInr(transaction, 'refund');
  const subscription = isSubscriptionTransaction(transaction);
  const createdAt = isoOf(transaction.revocationDate);
  return {
    provider: Provider.AppStore,
    id: transaction.transactionId,
    chargeId: transaction.transactionId,
    ...(subscription ? { subscriptionId: transaction.originalTransactionId } : { paymentId: transaction.transactionId }),
    status: RefundStatus.Succeeded,
    providerStatus: providerStatusOf(transaction),
    amount: refundedAmountOf(transaction) ?? 0,
    currency: Currency.INR,
    ...(createdAt ? { createdAt } : {}),
    raw: transaction,
  };
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

/**
 * Apple's status and the renewal information as a unified status, through `SUBSCRIPTION_STATUS_MAP`:
 *
 * - `1` active: `active`, or `trialing` while the current period is a free trial (`offerDiscountType` `FREE_TRIAL`);
 * - `2` expired: by the expiration intent, `cancelled` (the customer cancelled), `halted` (billing retry ended) or `expired`;
 * - `3` billing retry and `4` grace period: `past_due`; `providerStatus` and `raw` say which;
 * - `5` revoked: `cancelled`;
 * - a status Apple adds later: `expired` (`UNKNOWN_SUBSCRIPTION_STATUS`), so an unknown state never grants access.
 */
export function mapSubscriptionStatus(
  status: number,
  transaction: TransactionPayload,
  renewal: RenewalInfoPayload | undefined,
): SubscriptionStatus {
  if (status === AppStoreSubscriptionStatus.Expired) {
    return lookup(EXPIRATION_INTENT_STATUS, renewal?.expirationIntent) ?? SubscriptionStatus.Expired;
  }
  if (status === AppStoreSubscriptionStatus.Active && transaction.offerDiscountType === OfferDiscountType.FreeTrial) {
    return SubscriptionStatus.Trialing;
  }
  return lookup(SUBSCRIPTION_STATUS_MAP, status) ?? UNKNOWN_SUBSCRIPTION_STATUS;
}

const LIVE_STATUSES: readonly SubscriptionStatus[] = [SubscriptionStatus.Active, SubscriptionStatus.Trialing, SubscriptionStatus.PastDue];

/**
 * An auto-renewable subscription from its status, its latest transaction and its renewal information.
 *
 * - `id` is the `originalTransactionId`; `reference` the app account token; `planId` the product id.
 * - `currentPeriodStart` / `currentPeriodEnd` are the latest transaction's `purchaseDate` / `expiresDate`; `nextChargeAt` is
 *   the period end while the subscription renews; `trialEndsAt` the period end of a trial.
 * - `cancelAtPeriodEnd` is true while a live subscription's auto-renew is off (the customer cancelled; access runs to the
 *   period end), false while it is on.
 * - `amount` is the price of the next period (`renewalPrice`), or the transaction's price when the renewal information has none
 *   and the transaction carries no offer. A subscription priced in another currency than INR has no `amount` and no
 *   `currency`: the status is what matters for access.
 * - `interval` is not set: Apple's signed data does not carry the subscription's duration.
 */
export function mapSubscription(input: {
  status: number;
  transaction: TransactionPayload;
  renewal?: RenewalInfoPayload | undefined;
}): Subscription {
  const { transaction, renewal } = input;
  const status = mapSubscriptionStatus(input.status, transaction, renewal);
  const live = LIVE_STATUSES.includes(status);
  const autoRenew = renewal?.autoRenewStatus;
  const cancelAtPeriodEnd = live && autoRenew !== null && autoRenew !== undefined ? autoRenew === AutoRenewStatus.Off : undefined;
  const currency = renewal?.renewalPrice !== null && renewal?.renewalPrice !== undefined ? (renewal.currency ?? transaction.currency) : transaction.currency;
  const price =
    renewal?.renewalPrice !== null && renewal?.renewalPrice !== undefined
      ? renewal.renewalPrice
      : transaction.offerType === null || transaction.offerType === undefined
        ? transaction.price
        : undefined;
  const periodEnd = isoOf(transaction.expiresDate);
  const reference = transaction.appAccountToken ?? renewal?.appAccountToken;
  const ended = status === SubscriptionStatus.Cancelled || status === SubscriptionStatus.Expired || status === SubscriptionStatus.Halted;
  const endedAt = input.status === AppStoreSubscriptionStatus.Revoked ? (isoOf(transaction.revocationDate) ?? periodEnd) : ended ? periodEnd : undefined;
  const renews = live && cancelAtPeriodEnd !== true && status !== SubscriptionStatus.PastDue;
  const subscription: Subscription = {
    provider: Provider.AppStore,
    id: transaction.originalTransactionId,
    ...(reference ? { reference } : {}),
    planId: transaction.productId,
    status,
    providerStatus: String(input.status),
    scheduling: SchedulingMode.Gateway,
    ...(transaction.quantity !== null && transaction.quantity !== undefined ? { quantity: transaction.quantity } : {}),
    ...(price !== null && price !== undefined && !isForeignCurrency(currency)
      ? { amount: milliunitsToPaise(price), currency: Currency.INR }
      : {}),
    ...(isoOf(transaction.originalPurchaseDate) ? { createdAt: isoOf(transaction.originalPurchaseDate) as string, startAt: isoOf(transaction.originalPurchaseDate) as string } : {}),
    ...(status === SubscriptionStatus.Trialing && periodEnd ? { trialEndsAt: periodEnd } : {}),
    ...(isoOf(transaction.purchaseDate) ? { currentPeriodStart: isoOf(transaction.purchaseDate) as string } : {}),
    ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}),
    ...(renews && periodEnd ? { nextChargeAt: periodEnd } : {}),
    ...(endedAt ? { endedAt } : {}),
    ...(cancelAtPeriodEnd !== undefined ? { cancelAtPeriodEnd } : {}),
    raw: { status: input.status, transactionInfo: transaction, ...(renewal ? { renewalInfo: renewal } : {}) },
  };
  return subscription;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export interface NotificationContext {
  payload: NotificationPayload;
  /** The verified `data.signedTransactionInfo`. */
  transaction?: TransactionPayload | undefined;
  /** The verified `data.signedRenewalInfo`. */
  renewal?: RenewalInfoPayload | undefined;
}

/** The event type of a notification: the table entry for `TYPE:SUBTYPE`, else for `TYPE`, else `unknown`. */
export function eventTypeFor(type: string, subtype: string | null | undefined): EventType {
  const specific = lookup(NOTIFICATION_EVENT_MAP, notificationKey(type, subtype ?? undefined));
  return specific ?? lookup(NOTIFICATION_EVENT_MAP, type) ?? EventType.Unknown;
}

/**
 * A verified notification as one unified event, whose `id` is the notification's UUID (Apple: "Use this value to identify a
 * duplicate notification"). A type or subtype outside `NOTIFICATION_EVENT_MAP` is an `unknown` event, never an error. A subscription
 * event about a product that is not an auto-renewable subscription is `unknown` as well, and so is one without a transaction.
 * A transaction priced in another currency than INR still yields the event, without the `charge`, `payment` or `refund` that
 * would carry its amount.
 */
export function mapNotification(context: NotificationContext): SubscriptionEvent {
  const { payload, transaction, renewal } = context;
  const status = payload.data?.status;
  let type = eventTypeFor(payload.notificationType, payload.subtype);
  const subscriptionProduct = transaction !== undefined && isSubscriptionTransaction(transaction);
  if (SUBSCRIPTION_EVENT_TYPES.includes(type) && !subscriptionProduct) type = EventType.Unknown;
  const priced = transaction !== undefined && !isForeignCurrency(transaction.currency);

  const event: SubscriptionEvent = {
    id: payload.notificationUUID,
    provider: Provider.AppStore,
    type,
    providerEventType: notificationKey(payload.notificationType, payload.subtype ?? undefined),
    ...(isoOf(payload.signedDate) ? { occurredAt: isoOf(payload.signedDate) as string } : {}),
    raw: {
      notification: payload,
      ...(transaction ? { transactionInfo: transaction } : {}),
      ...(renewal ? { renewalInfo: renewal } : {}),
    },
  };
  if (transaction === undefined) return event;

  if (subscriptionProduct) {
    event.subscriptionId = transaction.originalTransactionId;
    if (status !== null && status !== undefined) event.subscription = mapSubscription({ status, transaction, renewal });
    if (type === EventType.SubscriptionCharged && priced) event.charge = mapCharge(transaction);
  } else {
    event.paymentId = transaction.transactionId;
    if (priced && (type === EventType.PaymentSucceeded || type === EventType.Unknown)) event.payment = mapPayment(transaction);
  }
  if (type === EventType.RefundSucceeded && priced) {
    event.refund = mapRefund(transaction);
    if (subscriptionProduct) event.charge = mapCharge(transaction);
    else if (event.payment === undefined) event.payment = mapPayment(transaction);
  }
  return event;
}

/** A `SubscriptionError` for an Apple answer that names no transaction the adapter can use. */
export function notFound(message: string): SubscriptionError {
  return new SubscriptionError(ErrorCode.NotFound, message, { provider: Provider.AppStore });
}
