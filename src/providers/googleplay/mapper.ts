import {
  ChargeKind,
  ChargeStatus,
  Currency,
  ErrorCode,
  PaymentStatus,
  Provider,
  ProductKind,
  RefundStatus,
  SchedulingMode,
  SubscriptionStatus,
} from '../../constants.js';
import { invalid, SubscriptionError, unsupported } from '../../errors.js';
import { anyToIso } from '../../time.js';
import type {
  Charge,
  ExternalTransactionRefund,
  ExternalTransactionReport,
  Payment,
  Refund,
  Subscription,
} from '../../schemas.js';
import {
  GoogleAcknowledgementState,
  GoogleCancellationType,
  GoogleConsumptionState,
  GoogleOrderState,
  GooglePartialRefundState,
  GooglePlayMetadataKey,
  GoogleProductPurchaseState,
  GoogleSubscriptionState,
  EXTERNAL_TRANSACTION_ID_PATTERN,
  ExternalSubscriptionType,
  INDIAN_ADMINISTRATIVE_AREAS,
  MICROS_PER_PAISE,
  METADATA_TRUE,
  NANOS_PER_PAISE,
  ONE_TIME_EVENT_BY_NOTIFICATION,
  OneTimeNotificationType,
  PAISE_PER_UNIT,
  PAYMENT_STATUS_BY_PURCHASE_STATE,
  PAYMENT_STATUS_FALLBACK,
  REGION_CODE_INDIA,
  SUBSCRIPTION_EVENT_BY_NOTIFICATION,
  SUBSCRIPTION_STATUS_BY_STATE,
  SUBSCRIPTION_STATUS_FALLBACK,
  SubscriptionNotificationType,
} from './constants.js';
import type {
  DeveloperNotification,
  GoogleExternalRefundRequest,
  GoogleExternalTransactionRequest,
  GoogleMoney,
  GoogleOrder,
  GoogleProductPurchase,
  GoogleSubscriptionLineItem,
  GoogleSubscriptionPurchase,
} from './schemas.js';

/** Looks a key up in a table without reaching the prototype (`constructor`, `toString`). */
function lookup<V>(table: Record<string, V>, key: string | number | null | undefined): V | undefined {
  if (key === undefined || key === null) return undefined;
  return Object.hasOwn(table, String(key)) ? table[String(key)] : undefined;
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Paise of a Google `Money` (`units` whole currency units, `nanos` billionths), without float maths. Only INR has a
 * unified representation: another currency answers `undefined` and the caller decides. A fraction below one paise is
 * rounded half up. Negative amounts and amounts beyond the safe integer range are `UNEXPECTED_RESPONSE`.
 */
export function moneyToPaise(money: GoogleMoney | null | undefined): number | undefined {
  if (!money || money.currencyCode !== Currency.INR) return undefined;
  const malformed = () =>
    new SubscriptionError(ErrorCode.UnexpectedResponse, `${Provider.GooglePlay} returned an amount that is not a valid INR amount`, {
      provider: Provider.GooglePlay,
      raw: money,
    });
  const unitsText = money.units === null || money.units === undefined ? '0' : String(money.units);
  if (!/^\d+$/.test(unitsText)) throw malformed();
  const nanos = BigInt(money.nanos ?? 0);
  if (nanos < 0n || nanos > 999_999_999n) throw malformed();
  const wholePaise = BigInt(unitsText) * PAISE_PER_UNIT + nanos / NANOS_PER_PAISE;
  const remainder = nanos % NANOS_PER_PAISE;
  const paise = remainder * 2n >= NANOS_PER_PAISE ? wholePaise + 1n : wholePaise;
  if (paise > BigInt(Number.MAX_SAFE_INTEGER)) throw malformed();
  return Number(paise);
}

/** `priceMicros` (an int64 as a string) of an INR amount in paise: 1 paise = 10,000 micros. */
export function paiseToMicros(paise: number): string {
  return (BigInt(paise) * MICROS_PER_PAISE).toString();
}

/** The currency of a `Money`, for the metadata of an amount that has no unified form. */
function foreignCurrency(money: GoogleMoney | null | undefined): string | undefined {
  return money && money.currencyCode !== Currency.INR ? money.currencyCode : undefined;
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

function latestExpiry(lineItems: readonly GoogleSubscriptionLineItem[]): string | undefined {
  let latest: { iso: string; ms: number } | undefined;
  for (const item of lineItems) {
    const iso = anyToIso(item.expiryTime);
    if (iso === undefined) continue;
    const ms = Date.parse(iso);
    if (latest === undefined || ms > latest.ms) latest = { iso, ms };
  }
  return latest?.iso;
}

/** True when the first line item's current offer phase is a free trial. */
export function inFreeTrial(purchase: GoogleSubscriptionPurchase): boolean {
  return purchase.lineItems.some((item) => item.offerPhase?.freeTrial !== undefined && item.offerPhase.freeTrial !== null);
}

function isCancelPending(purchase: GoogleSubscriptionPurchase): boolean {
  return purchase.lineItems.some(
    (item) =>
      item.autoRenewingPlan?.installmentDetails?.pendingCancellation !== undefined &&
      item.autoRenewingPlan.installmentDetails.pendingCancellation !== null,
  );
}

export interface MappedStatus {
  status: SubscriptionStatus;
  /** True while a cancellation is scheduled and the paid period still runs. */
  cancelAtPeriodEnd: boolean;
}

/**
 * The unified status of a subscription purchase, from `subscriptionState` through `SUBSCRIPTION_STATUS_BY_STATE`:
 * - `CANCELED` is still paid until `expiryTime`: `active` with `cancelAtPeriodEnd` (or `cancelled` once that time has passed);
 * - `EXPIRED` is `cancelled` when `canceledStateContext` says the user, Google or the developer ended it (a revoke too),
 *   else `expired`;
 * - `ACTIVE` in a free trial phase is `trialing`.
 */
export function mapSubscriptionStatus(purchase: GoogleSubscriptionPurchase, now: Date): MappedStatus {
  const base = lookup(SUBSCRIPTION_STATUS_BY_STATE, purchase.subscriptionState) ?? SUBSCRIPTION_STATUS_FALLBACK;
  let status: SubscriptionStatus = base;
  let cancelAtPeriodEnd = false;
  if (purchase.subscriptionState === GoogleSubscriptionState.Canceled) {
    const expiry = latestExpiry(purchase.lineItems);
    if (expiry !== undefined && Date.parse(expiry) > now.getTime()) {
      status = SubscriptionStatus.Active;
      cancelAtPeriodEnd = true;
    }
  } else if (purchase.subscriptionState === GoogleSubscriptionState.Expired) {
    if (purchase.canceledStateContext) status = SubscriptionStatus.Cancelled;
  } else if (status === SubscriptionStatus.Active && isCancelPending(purchase)) {
    cancelAtPeriodEnd = true;
  }
  if (status === SubscriptionStatus.Active && inFreeTrial(purchase)) status = SubscriptionStatus.Trialing;
  return { status, cancelAtPeriodEnd };
}

const TERMINAL: readonly SubscriptionStatus[] = [
  SubscriptionStatus.Cancelled,
  SubscriptionStatus.Expired,
  SubscriptionStatus.Failed,
];

/**
 * The first line item that is not an add-on is the plan the customer is on; add-ons add to `amount`. The purchase token
 * is the id: Google has no other identifier for a subscription that stays the same across the calls of its lifecycle.
 */
export function mapSubscription(purchase: GoogleSubscriptionPurchase, token: string, now: Date): Subscription {
  const { status, cancelAtPeriodEnd } = mapSubscriptionStatus(purchase, now);
  const item = purchase.lineItems[0];
  const expiry = latestExpiry(purchase.lineItems);
  const renewing = purchase.lineItems.some((line) => line.autoRenewingPlan?.autoRenewEnabled === true);

  let amount: number | undefined;
  let currencyCode: string | undefined;
  for (const line of purchase.lineItems) {
    const price = line.autoRenewingPlan?.recurringPrice;
    if (!price) continue;
    const paise = moneyToPaise(price);
    if (paise === undefined) {
      currencyCode = price.currencyCode;
      amount = undefined;
      break;
    }
    amount = (amount ?? 0) + paise;
  }

  const installment = item?.autoRenewingPlan?.installmentDetails;
  const offer = item?.offerDetails;
  const planId = item === undefined ? undefined : [item.productId, offer?.basePlanId].filter((part): part is string => !!part).join(':');
  const latestOrderId = item?.latestSuccessfulOrderId ?? purchase.latestOrderId;
  const metadata: Record<string, string> = {};
  const put = (key: string, value: string | null | undefined) => {
    if (value !== undefined && value !== null && value !== '') metadata[key] = value;
  };
  put(GooglePlayMetadataKey.ProductId, item?.productId);
  put(GooglePlayMetadataKey.BasePlanId, offer?.basePlanId);
  put(GooglePlayMetadataKey.OfferId, offer?.offerId);
  put(GooglePlayMetadataKey.RegionCode, purchase.regionCode);
  put(GooglePlayMetadataKey.LatestOrderId, latestOrderId);
  put(GooglePlayMetadataKey.LinkedPurchaseToken, purchase.linkedPurchaseToken);
  put(GooglePlayMetadataKey.Etag, purchase.etag);
  put(GooglePlayMetadataKey.AcknowledgementState, purchase.acknowledgementState);
  put(GooglePlayMetadataKey.CurrencyCode, currencyCode);
  if (isTestPurchase(purchase)) metadata[GooglePlayMetadataKey.TestPurchase] = METADATA_TRUE;

  const ended = TERMINAL.includes(status) ? expiry : undefined;
  return {
    provider: Provider.GooglePlay,
    id: token,
    reference: purchase.externalAccountIdentifiers?.obfuscatedExternalAccountId?.trim() || undefined,
    planId,
    status,
    providerStatus: purchase.subscriptionState,
    scheduling: SchedulingMode.Gateway,
    ...(amount !== undefined ? { amount, currency: Currency.INR } : {}),
    ...(installment?.initialCommittedPaymentsCount != null ? { totalCycles: installment.initialCommittedPaymentsCount } : {}),
    ...(installment?.remainingCommittedPaymentsCount != null
      ? { remainingCycles: installment.remainingCommittedPaymentsCount }
      : {}),
    createdAt: anyToIso(purchase.startTime),
    ...(status === SubscriptionStatus.Trialing && expiry !== undefined ? { trialEndsAt: expiry } : {}),
    ...(expiry !== undefined ? { currentPeriodEnd: expiry } : {}),
    ...(renewing && expiry !== undefined && (status === SubscriptionStatus.Active || status === SubscriptionStatus.Trialing)
      ? { nextChargeAt: expiry }
      : {}),
    ...(ended !== undefined ? { endedAt: ended } : {}),
    cancelAtPeriodEnd,
    metadata,
    raw: purchase,
  };
}

export function isTestPurchase(purchase: GoogleSubscriptionPurchase): boolean {
  return purchase.testPurchase !== undefined && purchase.testPurchase !== null;
}

/** The account id the purchase was made with (`BillingFlowParams.setObfuscatedAccountId`), which is the order's token. */
export function subscriptionAccountId(purchase: GoogleSubscriptionPurchase): string | undefined {
  const id = purchase.externalAccountIdentifiers?.obfuscatedExternalAccountId?.trim();
  return id ? id : undefined;
}

/** True while the customer has access: the unified statuses in which the product is usable. */
export function grantsAccess(status: SubscriptionStatus): boolean {
  return status === SubscriptionStatus.Active || status === SubscriptionStatus.Trialing || status === SubscriptionStatus.PastDue;
}

export function needsAcknowledgement(state: string | null | undefined): boolean {
  return state === GoogleAcknowledgementState.Pending;
}

/** The cancellation type behind the unified cancel: final, the subscription cannot be restored. */
export const UNIFIED_CANCELLATION_TYPE = GoogleCancellationType.DeveloperRequestedStopPayments;

// ---------------------------------------------------------------------------
// One-time purchases and orders
// ---------------------------------------------------------------------------

export function productStatus(purchase: GoogleProductPurchase): PaymentStatus {
  return lookup(PAYMENT_STATUS_BY_PURCHASE_STATE, purchase.purchaseStateContext?.purchaseState) ?? PAYMENT_STATUS_FALLBACK;
}

export function isPurchased(purchase: GoogleProductPurchase): boolean {
  return purchase.purchaseStateContext?.purchaseState === GoogleProductPurchaseState.Purchased;
}

export function isTestProductPurchase(purchase: GoogleProductPurchase): boolean {
  return purchase.testPurchaseContext !== undefined && purchase.testPurchaseContext !== null;
}

export function productConsumed(item: GoogleProductPurchase['productLineItem'][number]): boolean {
  return item.productOfferDetails?.consumptionState === GoogleConsumptionState.Consumed;
}

/** Sum of the money in the refund events of an order: the full refund if there is one, else the processed partial refunds. */
export function refundedPaise(order: GoogleOrder): number | undefined {
  const history = order.orderHistory;
  if (!history) return undefined;
  const full = history.refundEvent?.refundDetails?.total;
  if (full) return moneyToPaise(full);
  let sum = 0;
  let seen = false;
  for (const event of history.partialRefundEvents ?? []) {
    if (event.state !== GooglePartialRefundState.Processed) continue;
    const paise = moneyToPaise(event.refundDetails?.total);
    if (paise === undefined) return undefined;
    sum += paise;
    seen = true;
  }
  return seen ? sum : undefined;
}

export function orderTotalPaise(order: GoogleOrder): number | undefined {
  return moneyToPaise(order.total);
}

/** Why an order has no unified amount: it is in a currency the unified model does not have. */
export function foreignOrderError(order: GoogleOrder, what: string): SubscriptionError {
  return unsupported(
    Provider.GooglePlay,
    what,
    `the order is in ${foreignCurrency(order.total) ?? 'a currency other than INR'}, and the unified model is INR only`,
  );
}

/**
 * A one-time payment from its purchase and (when the purchase has one) its order. `amount` is what the customer paid,
 * from `Order.total` (the purchase resource has no price; a purchase without an order, such as a promo code, is 0).
 * A refund recorded on the order wins over `purchaseState`.
 */
export function mapPayment(purchase: GoogleProductPurchase, order: GoogleOrder | undefined, token: string): Payment {
  const state = purchase.purchaseStateContext?.purchaseState ?? GoogleProductPurchaseState.Unspecified;
  let status = productStatus(purchase);
  let providerStatus: string = state;
  if (status === PaymentStatus.Succeeded && order) {
    if (order.state === GoogleOrderState.Refunded) {
      status = PaymentStatus.Refunded;
      providerStatus = order.state;
    } else if (order.state === GoogleOrderState.PartiallyRefunded) {
      status = PaymentStatus.PartiallyRefunded;
      providerStatus = order.state;
    }
  }
  const amount = order ? orderTotalPaise(order) : 0;
  if (amount === undefined) throw foreignOrderError(order as GoogleOrder, 'a payment');
  const refunded = order ? refundedPaise(order) : undefined;
  const item = purchase.productLineItem[0];
  const metadata: Record<string, string> = {};
  const put = (key: string, value: string | null | undefined) => {
    if (value !== undefined && value !== null && value !== '') metadata[key] = value;
  };
  put(GooglePlayMetadataKey.ProductId, item?.productId);
  put(GooglePlayMetadataKey.OfferId, item?.productOfferDetails?.offerId);
  put(GooglePlayMetadataKey.RegionCode, purchase.regionCode);
  put(GooglePlayMetadataKey.OrderId, purchase.orderId);
  put(GooglePlayMetadataKey.OrderState, order?.state);
  put(GooglePlayMetadataKey.AcknowledgementState, purchase.acknowledgementState);
  if (isTestProductPurchase(purchase)) metadata[GooglePlayMetadataKey.TestPurchase] = METADATA_TRUE;
  return {
    provider: Provider.GooglePlay,
    id: token,
    reference: purchase.obfuscatedExternalAccountId?.trim() || undefined,
    status,
    providerStatus,
    amount,
    currency: Currency.INR,
    ...(refunded !== undefined ? { refundedAmount: refunded } : {}),
    createdAt: anyToIso(order?.createTime),
    paidAt: anyToIso(purchase.purchaseCompletionTime),
    metadata,
    raw: { purchase, order },
  };
}

const CHARGE_STATUS_BY_ORDER_STATE: Record<GoogleOrderState, ChargeStatus> = {
  [GoogleOrderState.Unspecified]: ChargeStatus.Pending,
  [GoogleOrderState.Pending]: ChargeStatus.Pending,
  [GoogleOrderState.Processed]: ChargeStatus.Succeeded,
  [GoogleOrderState.Canceled]: ChargeStatus.Cancelled,
  /** A refund was asked for and is waiting: the money was collected, so the charge stays succeeded. */
  [GoogleOrderState.PendingRefund]: ChargeStatus.Succeeded,
  [GoogleOrderState.PartiallyRefunded]: ChargeStatus.PartiallyRefunded,
  [GoogleOrderState.Refunded]: ChargeStatus.Refunded,
};
const CHARGE_STATUS_FALLBACK: ChargeStatus = ChargeStatus.Pending;

/**
 * A subscription order (one payment of a subscription: the signup, a renewal, a proration) as a charge. `id` is the
 * order id; `subscriptionId` the purchase token the order belongs to. The order of a free trial is the setup of the
 * subscription, so its kind is `authorization`. `amount` is `Order.total`: what was paid, with discounts and tax.
 */
export function mapCharge(order: GoogleOrder): Charge {
  const amount = orderTotalPaise(order);
  if (amount === undefined) throw foreignOrderError(order, 'a charge');
  const status = lookup(CHARGE_STATUS_BY_ORDER_STATE, order.state) ?? CHARGE_STATUS_FALLBACK;
  const freeTrial = order.lineItems?.some((line) => line.subscriptionDetails?.offerPhaseDetails?.freeTrialDetails != null) ?? false;
  const refunded = refundedPaise(order);
  return {
    provider: Provider.GooglePlay,
    id: order.orderId,
    ...(order.purchaseToken ? { subscriptionId: order.purchaseToken } : {}),
    kind: freeTrial ? ChargeKind.Authorization : ChargeKind.Recurring,
    status,
    ...(order.state ? { providerStatus: order.state } : {}),
    amount,
    currency: Currency.INR,
    scheduledAt: anyToIso(order.createTime),
    ...(status === ChargeStatus.Succeeded || status === ChargeStatus.Refunded || status === ChargeStatus.PartiallyRefunded
      ? { paidAt: anyToIso(order.orderHistory?.processedEvent?.eventTime) ?? anyToIso(order.createTime) }
      : {}),
    ...(refunded !== undefined ? { refundedAmount: refunded } : {}),
    raw: order,
  };
}

const REFUND_STATUS_BY_ORDER_STATE: Record<GoogleOrderState, RefundStatus> = {
  [GoogleOrderState.Unspecified]: RefundStatus.Pending,
  [GoogleOrderState.Pending]: RefundStatus.Pending,
  [GoogleOrderState.Processed]: RefundStatus.Pending,
  [GoogleOrderState.Canceled]: RefundStatus.Pending,
  [GoogleOrderState.PendingRefund]: RefundStatus.Pending,
  [GoogleOrderState.PartiallyRefunded]: RefundStatus.Succeeded,
  [GoogleOrderState.Refunded]: RefundStatus.Succeeded,
};

/**
 * The refund of an order as the order shows it after `orders.refund` (which answers with an empty body): `REFUNDED` is
 * succeeded, `PENDING_REFUND` and anything not refunded yet is pending. Google issues no refund id, so the caller's
 * `refundId` is the id.
 */
export function mapRefundOfOrder(
  order: GoogleOrder,
  ids: { refundId: string; chargeId: string; paymentId?: string; subscriptionId?: string },
  now: Date,
): Refund {
  const total = orderTotalPaise(order);
  if (total === undefined) throw foreignOrderError(order, 'a refund');
  return {
    provider: Provider.GooglePlay,
    id: ids.refundId,
    reference: ids.refundId,
    chargeId: ids.chargeId,
    ...(ids.paymentId !== undefined ? { paymentId: ids.paymentId } : {}),
    ...(ids.subscriptionId !== undefined ? { subscriptionId: ids.subscriptionId } : {}),
    status: lookup(REFUND_STATUS_BY_ORDER_STATE, order.state) ?? RefundStatus.Pending,
    ...(order.state ? { providerStatus: order.state } : {}),
    amount: refundedPaise(order) ?? total,
    currency: Currency.INR,
    createdAt: now.toISOString(),
    raw: order,
  };
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/** A notification, sorted by which of the mutually exclusive payloads it carries. */
export type ClassifiedNotification =
  | { kind: 'package_mismatch' }
  | { kind: 'subscription'; type: number; purchaseToken: string }
  | { kind: 'one_time'; type: number; purchaseToken: string; sku?: string }
  | { kind: 'voided'; purchaseToken: string; orderId: string; productType?: number; refundType?: number }
  | { kind: 'pending_refund_review' }
  | { kind: 'test' }
  | { kind: 'unrecognised' };

export function classifyNotification(note: DeveloperNotification, packageName: string): ClassifiedNotification {
  if (note.packageName !== packageName) return { kind: 'package_mismatch' };
  if (note.subscriptionNotification) {
    return {
      kind: 'subscription',
      type: note.subscriptionNotification.notificationType,
      purchaseToken: note.subscriptionNotification.purchaseToken,
    };
  }
  if (note.oneTimeProductNotification) {
    return {
      kind: 'one_time',
      type: note.oneTimeProductNotification.notificationType,
      purchaseToken: note.oneTimeProductNotification.purchaseToken,
      ...(note.oneTimeProductNotification.sku ? { sku: note.oneTimeProductNotification.sku } : {}),
    };
  }
  if (note.voidedPurchaseNotification) {
    return {
      kind: 'voided',
      purchaseToken: note.voidedPurchaseNotification.purchaseToken,
      orderId: note.voidedPurchaseNotification.orderId,
      ...(note.voidedPurchaseNotification.productType != null ? { productType: note.voidedPurchaseNotification.productType } : {}),
      ...(note.voidedPurchaseNotification.refundType != null ? { refundType: note.voidedPurchaseNotification.refundType } : {}),
    };
  }
  if (note.pendingRefundReviewNotification) return { kind: 'pending_refund_review' };
  if (note.testNotification) return { kind: 'test' };
  return { kind: 'unrecognised' };
}

export function subscriptionEventType(type: number) {
  return lookup(SUBSCRIPTION_EVENT_BY_NOTIFICATION, type);
}

export function oneTimeEventType(type: number) {
  return lookup(ONE_TIME_EVENT_BY_NOTIFICATION, type);
}

export function isKnownSubscriptionNotification(type: number): type is SubscriptionNotificationType {
  return Object.values(SubscriptionNotificationType).includes(type as SubscriptionNotificationType);
}

export function isKnownOneTimeNotification(type: number): type is OneTimeNotificationType {
  return Object.values(OneTimeNotificationType).includes(type as OneTimeNotificationType);
}

/** `eventTimeMillis` (milliseconds since the Epoch, a long, usually printed as a string) as an ISO string. */
export function millisToIso(value: string | number | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

// ---------------------------------------------------------------------------
// External transactions
// ---------------------------------------------------------------------------

/**
 * The `administrativeArea` Google wants: its documented list is upper case with `AND` (the unified `state` is free
 * text such as "Jammu & Kashmir"). A state outside the list is `VALIDATION`, so a report never reaches Google with a
 * value it will reject.
 */
export function administrativeArea(state: string): string {
  const normalised = state.replace(/&/g, ' AND ').replace(/\s+/g, ' ').trim().toUpperCase();
  if (!INDIAN_ADMINISTRATIVE_AREAS.includes(normalised)) {
    throw invalid(
      `"${state}" is not a state or union territory Google accepts as userTaxAddress.administrativeArea; ` +
        'use one of the names in the Play Developer API reference (for example "Karnataka")',
      Provider.GooglePlay,
    );
  }
  return normalised;
}

export function assertExternalTransactionId(id: string, field: string): void {
  if (!EXTERNAL_TRANSACTION_ID_PATTERN.test(id)) {
    throw invalid(
      `${field} must be 1 to 63 characters of A-Z, a-z, 0-9, "_" and "-" (Google's rule for external transaction ids), got ${id.length} characters`,
      Provider.GooglePlay,
    );
  }
}

function isoUtc(value: string, field: string): string {
  const iso = anyToIso(value);
  if (iso === undefined) throw invalid(`${field} is not a valid date: ${value}`, Provider.GooglePlay);
  return iso;
}

/**
 * The `createexternaltransaction` body for a unified report: INR amounts as micros, the customer's state as
 * `userTaxAddress`, and the product kind and position in the series as Google's shapes it:
 * a one-time purchase is `oneTimeTransaction` with the device token; the first transaction of a subscription is
 * `recurringTransaction` with the token and `externalSubscription`; a renewal is `recurringTransaction` with
 * `initialExternalTransactionId` and no token. [https://developer.android.com/google/play/billing/outside-gpb-backend]
 */
export function buildExternalTransaction(report: ExternalTransactionReport): GoogleExternalTransactionRequest {
  assertExternalTransactionId(report.externalTransactionId, 'externalTransactionId');
  const price = (paise: number) => ({ currency: Currency.INR, priceMicros: paiseToMicros(paise) });
  const base = {
    originalPreTaxAmount: price(report.amount),
    originalTaxAmount: price(report.taxAmount),
    transactionTime: isoUtc(report.transactionTime, 'transactionTime'),
    userTaxAddress: { regionCode: REGION_CODE_INDIA, administrativeArea: administrativeArea(report.state) },
  };
  if (report.productKind === ProductKind.OneTime) {
    if (report.externalTransactionToken === undefined) {
      throw invalid(
        'A one-time purchase is reported with the externalTransactionToken from the device; it has no earlier transaction to refer to',
        Provider.GooglePlay,
      );
    }
    return { ...base, oneTimeTransaction: { externalTransactionToken: report.externalTransactionToken } };
  }
  if (report.initialExternalTransactionId !== undefined) {
    assertExternalTransactionId(report.initialExternalTransactionId, 'initialExternalTransactionId');
  }
  return {
    ...base,
    recurringTransaction: {
      ...(report.externalTransactionToken !== undefined
        ? { externalTransactionToken: report.externalTransactionToken }
        : { initialExternalTransactionId: report.initialExternalTransactionId }),
      externalSubscription: { subscriptionType: ExternalSubscriptionType.Recurring },
    },
  };
}

/**
 * The `refundexternaltransaction` body: no amount is a `fullRefund` (what is left of the transaction); an amount is a
 * `partialRefund` of that pre-tax amount. Google's `refundId` must be unique per transaction and a repeated id fails
 * once the first succeeded, so it is derived from the refund time and amount: re-sending the same refund is recognised.
 * The partial refund has no tax field in Google's API, so `taxAmount` is not sent.
 */
export function buildExternalRefund(refund: ExternalTransactionRefund): GoogleExternalRefundRequest {
  assertExternalTransactionId(refund.externalTransactionId, 'externalTransactionId');
  const refundTime = isoUtc(refund.refundTime, 'refundTime');
  if (refund.amount === undefined) {
    if (refund.taxAmount !== undefined) {
      throw invalid('taxAmount without amount: give both for a partial refund, or neither for a full refund', Provider.GooglePlay);
    }
    return { refundTime, fullRefund: {} };
  }
  return {
    refundTime,
    partialRefund: {
      refundId: `r${Date.parse(refundTime)}-${refund.amount}`,
      refundPreTaxAmount: { currency: Currency.INR, priceMicros: paiseToMicros(refund.amount) },
    },
  };
}
