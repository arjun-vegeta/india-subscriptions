import {
  ChargeKind,
  ChargeStatus,
  CheckoutKind,
  Currency,
  DigestEncoding,
  ErrorCode,
  EventType,
  HashAlgorithm,
  IntervalUnit,
  PaymentMethod,
  Provider,
  RefundStatus,
  SchedulingMode,
  SubscriptionStatus,
} from '../../constants.js';
import { hash } from '../../crypto.js';
import { SubscriptionError, invalid } from '../../errors.js';
import {
  type BillingInterval,
  type Charge,
  type ChargeNotification,
  type ParsedCreateSubscriptionInput,
  type ParsedNotifyChargeInput,
  type Refund,
  type Subscription,
  type SubscriptionEvent,
} from '../../schemas.js';
import { addDays, cycleStart, resolveFirstChargeAt, toDate, toIso } from '../../time.js';
import {
  ERROR_CODE_BY_PHONEPE_CODE,
  EVENT_ID_EMPTY,
  EVENT_ID_SEPARATOR,
  EXPIRE_AFTER_MAX_SECONDS,
  EXPIRE_AFTER_MIN_SECONDS,
  DEFAULT_MANDATE_VALIDITY_YEARS,
  FREQUENCY_BY_INTERVAL,
  INTERVAL_BY_FREQUENCY,
  MANDATE_END_GRACE_DAYS,
  MAX_MANDATE_PAISE,
  MAX_MANDATE_VALIDITY_YEARS,
  MAX_MERCHANT_ID_LENGTH,
  MAX_SUBSCRIPTION_ID_LENGTH,
  MERCHANT_ID_PATTERN,
  MIN_NOTIFY_PAISE,
  MIN_TRANSACTION_SETUP_PAISE,
  NOTIFICATION_STATES,
  ORDER_STATE_TO_CHARGE_STATUS,
  PENNY_DROP_AMOUNT_PAISE,
  PhonePeAmountType,
  PhonePeAuthWorkflowType,
  PhonePeErrorCode,
  PhonePeEvent,
  PhonePeFrequency,
  PhonePeOrderState,
  PhonePePaymentFlowType,
  PhonePeProductType,
  PhonePeSubscriptionType,
  REFUND_STATE_TO_STATUS,
  RETURN_SUBSCRIPTION_ID_PARAM,
  SETUP_FLOW_TYPES,
  SETUP_ORDER_ID_PREFIX,
  SETUP_ORDER_STATE_TO_STATUS,
  SUBSCRIPTION_STATE_TO_STATUS,
  UDF_KEY_PATTERN,
  UNKNOWN_CHARGE_STATUS,
  UNKNOWN_REFUND_STATUS,
  UNKNOWN_SUBSCRIPTION_STATUS,
} from './constants.js';
import type {
  PhonePeAttempt,
  PhonePeErrorBody,
  PhonePeNotifyResponse,
  PhonePeOrder,
  PhonePePayResponse,
  PhonePeRedeemResponse,
  PhonePeRefundResponse,
  PhonePeSubscriptionStatus,
  PhonePeWebhook,
  PhonePeWebhookPayload,
} from './schemas.js';

/** Pure functions: the unified model to PhonePe requests, and PhonePe payloads to the unified model. */

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Table lookup that ignores inherited keys (`constructor`, `__proto__`): PhonePe states are free text. */
function lookup<T>(table: Readonly<Record<string, T>>, key: string | null | undefined, fallback: T): T {
  return key !== null && key !== undefined && Object.prototype.hasOwnProperty.call(table, key) ? (table[key] as T) : fallback;
}

/** Epoch milliseconds (PhonePe's unit for every timestamp) to an ISO string; `undefined` for a missing or zero value. */
export function epochMsToIso(value: number | null | undefined): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : undefined;
}

function present(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/** VALIDATION unless `value` is a legal PhonePe `merchantOrderId` / `merchantRefundId` (<= 63 of `[A-Za-z0-9_-]`). */
export function assertMerchantId(value: string, what: string): string {
  if (value.length === 0 || value.length > MAX_MERCHANT_ID_LENGTH || !MERCHANT_ID_PATTERN.test(value)) {
    throw invalid(
      `${what} must be 1-${MAX_MERCHANT_ID_LENGTH} characters of letters, digits, "_" and "-" (PhonePe's merchant id rule)`,
      Provider.PhonePe,
    );
  }
  return value;
}

/** VALIDATION unless `value` can be both a `merchantSubscriptionId` and the base of the setup order's id. */
export function assertSubscriptionId(value: string, what: string): string {
  if (value.length > MAX_SUBSCRIPTION_ID_LENGTH || !MERCHANT_ID_PATTERN.test(value)) {
    throw invalid(
      `${what} must be 1-${MAX_SUBSCRIPTION_ID_LENGTH} characters of letters, digits, "_" and "-": PhonePe takes a subscription ` +
        `id of that alphabet, and this adapter derives the setup order's id from it (${SETUP_ORDER_ID_PREFIX} + id, at most ${MAX_MERCHANT_ID_LENGTH})`,
      Provider.PhonePe,
    );
  }
  return value;
}

/**
 * The `merchantOrderId` of a subscription's setup order, derived from the subscription id so that later calls (a status
 * lookup before the customer has authorised, a refund of the setup debit) can find it without storage.
 */
export function setupOrderIdFor(merchantSubscriptionId: string): string {
  return `${SETUP_ORDER_ID_PREFIX}${merchantSubscriptionId}`;
}

/** The inverse of {@link setupOrderIdFor}, or `undefined` when the order id is not a setup order id of this adapter. */
export function subscriptionIdFromSetupOrderId(merchantOrderId: string | null | undefined): string | undefined {
  return typeof merchantOrderId === 'string' && merchantOrderId.startsWith(SETUP_ORDER_ID_PREFIX) && merchantOrderId.length > SETUP_ORDER_ID_PREFIX.length
    ? merchantOrderId.slice(SETUP_ORDER_ID_PREFIX.length)
    : undefined;
}

/** The return URL with the subscription id added, so that the customer's return identifies the subscription. */
export function returnUrlFor(base: string, merchantSubscriptionId: string): string {
  const url = new URL(base);
  url.searchParams.set(RETURN_SUBSCRIPTION_ID_PARAM, merchantSubscriptionId);
  return url.toString();
}

// ---------------------------------------------------------------------------
// Frequency
// ---------------------------------------------------------------------------

/**
 * The PhonePe frequency for a plan interval: a named one where PhonePe has an exact match (see
 * `FREQUENCY_BY_INTERVAL`), otherwise `ON_DEMAND` ("as presented": no recurrence rule is enforced at the bank).
 *
 * ASSUMPTION about retries: PhonePe rejects a notification that "breaks frequency constraints"
 * (`SUBSCRIPTION_RECURRENCE_LIMIT_BREACHED`) and does not publish the per-frequency limits. A scheduler retry is a fresh
 * notification a day after a FAILED debit; whether PhonePe counts the failed debit's notification against the period is
 * not stated. If it does, retries of a named-frequency mandate are refused with that code (mapped to `VALIDATION`; the
 * notification then fails on every tick and the cycle never retries successfully). `ON_DEMAND` never has this problem.
 */
export function frequencyFor(interval: BillingInterval): PhonePeFrequency {
  const match = FREQUENCY_BY_INTERVAL.find((entry) => entry.unit === interval.unit && entry.count === interval.count);
  return match ? match.frequency : PhonePeFrequency.OnDemand;
}

function intervalFor(frequency: string | null | undefined): BillingInterval | undefined {
  const match = lookup<{ unit: IntervalUnit; count: number } | undefined>(INTERVAL_BY_FREQUENCY, frequency, undefined);
  return match ? { unit: match.unit, count: match.count } : undefined;
}

// ---------------------------------------------------------------------------
// Subscription setup
// ---------------------------------------------------------------------------

export interface SetupPlan {
  /** The body for `POST /checkout/v2/pay` (to be validated by `PhonePeSetupRequestSchema`). */
  request: unknown;
  merchantSubscriptionId: string;
  setupOrderId: string;
  /** The recurring amount per cycle and the mandate ceiling, in paise. */
  amount: number;
  maxAmount: number;
  interval: BillingInterval;
  firstDebitAt: Date;
  isTrial: boolean;
  totalCycles: number | undefined;
  mandateEndsAt: Date;
}

/**
 * Turns the unified input into the setup request and the facts the returned subscription needs.
 *
 * - `upfrontAmount`: `TRANSACTION`, `amount` = the upfront amount (at least 100 paise). Otherwise `PENNY_DROP`, 200 paise.
 * - `maxAmount` = plan `maxAmount` or `amount`, at most INR 15,000 [SC-SETUP]; `FIXED` unless the plan has a larger,
 *   separate `maxAmount`.
 * - Mandate expiry: `mandateEndsAt`; else, for a limited plan, the last debit date plus a grace period for retries;
 *   else `DEFAULT_MANDATE_VALIDITY_YEARS`. Never beyond 30 years.
 * - `expireAfter` from `authorizeBy`, within PhonePe's 300-3600 seconds (outside it is refused, not clamped: a deadline
 *   PhonePe cannot honour must not be silently changed).
 */
export function planSetup(
  input: ParsedCreateSubscriptionInput,
  context: { now: Date; merchantSubscriptionId: string; redirectUrl: string },
): SetupPlan {
  const plan = input.plan;
  if (typeof plan === 'string') throw invalid('a plan id cannot be resolved: PhonePe has no plan API', Provider.PhonePe);
  const { now, merchantSubscriptionId } = context;

  if (plan.amount < MIN_NOTIFY_PAISE) {
    throw invalid(
      `plan.amount must be at least ${MIN_NOTIFY_PAISE} paise (INR 1): that is the minimum PhonePe accepts for a pre-debit notification`,
      Provider.PhonePe,
    );
  }
  const maxAmount = plan.maxAmount ?? plan.amount;
  if (maxAmount > MAX_MANDATE_PAISE) {
    throw invalid(`the mandate ceiling (maxAmount) may be at most ${MAX_MANDATE_PAISE} paise (INR 15,000); got ${maxAmount}`, Provider.PhonePe);
  }
  const amountType = maxAmount === plan.amount ? PhonePeAmountType.Fixed : PhonePeAmountType.Variable;

  let authWorkflowType: PhonePeAuthWorkflowType;
  let setupAmount: number;
  if (input.upfrontAmount !== undefined) {
    if (input.upfrontAmount < MIN_TRANSACTION_SETUP_PAISE) {
      throw invalid(`upfrontAmount must be at least ${MIN_TRANSACTION_SETUP_PAISE} paise (INR 1) for a PhonePe TRANSACTION setup`, Provider.PhonePe);
    }
    authWorkflowType = PhonePeAuthWorkflowType.Transaction;
    setupAmount = input.upfrontAmount;
  } else {
    authWorkflowType = PhonePeAuthWorkflowType.PennyDrop;
    setupAmount = PENNY_DROP_AMOUNT_PAISE;
  }

  const { firstChargeAt, isTrial } = resolveFirstChargeAt(input, now);
  const firstDebitAt = firstChargeAt ?? now;
  const totalCycles = input.totalCycles ?? plan.maxCycles;

  const horizon = cycleStart(now, { unit: IntervalUnit.Year, count: 1 }, MAX_MANDATE_VALIDITY_YEARS);
  let mandateEndsAt: Date;
  if (input.mandateEndsAt !== undefined) {
    mandateEndsAt = toDate(input.mandateEndsAt, 'mandateEndsAt');
    if (mandateEndsAt.getTime() <= now.getTime()) throw invalid('mandateEndsAt must be in the future', Provider.PhonePe);
  } else if (totalCycles !== undefined) {
    const lastDebit = cycleStart(firstDebitAt, plan.interval, totalCycles - 1);
    mandateEndsAt = addDays(lastDebit, MANDATE_END_GRACE_DAYS);
  } else {
    mandateEndsAt = cycleStart(now, { unit: IntervalUnit.Year, count: 1 }, DEFAULT_MANDATE_VALIDITY_YEARS);
  }
  if (mandateEndsAt.getTime() > horizon.getTime()) {
    throw invalid(
      `the mandate would end after ${mandateEndsAt.toISOString()}, which is more than ${MAX_MANDATE_VALIDITY_YEARS} years away: PhonePe's maximum`,
      Provider.PhonePe,
    );
  }

  let expireAfter: number | undefined;
  if (input.authorizeBy !== undefined) {
    const seconds = Math.ceil((toDate(input.authorizeBy, 'authorizeBy').getTime() - now.getTime()) / 1000);
    if (seconds < EXPIRE_AFTER_MIN_SECONDS || seconds > EXPIRE_AFTER_MAX_SECONDS) {
      throw invalid(
        `authorizeBy must be ${EXPIRE_AFTER_MIN_SECONDS} to ${EXPIRE_AFTER_MAX_SECONDS} seconds from now (PhonePe's setup order expiry); got ${seconds}. ` +
          'Omit it for PhonePe\'s default.',
        Provider.PhonePe,
      );
    }
    expireAfter = seconds;
  }

  const metaInfo = metaInfoFrom(input.metadata);
  const request = {
    merchantOrderId: setupOrderIdFor(merchantSubscriptionId),
    amount: setupAmount,
    paymentFlow: {
      type: PhonePePaymentFlowType.CheckoutSetup,
      merchantUrls: { redirectUrl: context.redirectUrl },
      subscriptionDetails: {
        subscriptionType: PhonePeSubscriptionType.Recurring,
        merchantSubscriptionId,
        authWorkflowType,
        amountType,
        maxAmount,
        frequency: frequencyFor(plan.interval),
        productType: PhonePeProductType.UpiMandate,
        expireAt: mandateEndsAt.getTime(),
      },
    },
    ...(expireAfter !== undefined ? { expireAfter } : {}),
    ...(metaInfo !== undefined ? { metaInfo } : {}),
  };

  return {
    request,
    merchantSubscriptionId,
    setupOrderId: setupOrderIdFor(merchantSubscriptionId),
    amount: plan.amount,
    maxAmount,
    interval: plan.interval,
    firstDebitAt,
    isTrial,
    totalCycles,
    mandateEndsAt,
  };
}

/**
 * Only metadata keys named exactly `udf1` ... `udf15` are sent: PhonePe's `metaInfo` has no other key and renaming them
 * "will result in a production error" [SC-SETUP]. Other keys stay on the returned subscription only.
 */
function metaInfoFrom(metadata: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!metadata) return undefined;
  const udf = Object.entries(metadata).filter(([key]) => UDF_KEY_PATTERN.test(key));
  return udf.length > 0 ? Object.fromEntries(udf) : undefined;
}

/** The subscription `createSubscription` returns: the mandate does not exist until the customer has authorised. */
export function createdSubscription(
  input: ParsedCreateSubscriptionInput,
  setup: SetupPlan,
  response: PhonePePayResponse,
  now: Date,
): Subscription {
  return {
    provider: Provider.PhonePe,
    id: setup.merchantSubscriptionId,
    reference: setup.merchantSubscriptionId,
    status: SubscriptionStatus.Created,
    providerStatus: response.state,
    scheduling: SchedulingMode.Merchant,
    customer: input.customer,
    amount: setup.amount,
    maxAmount: setup.maxAmount,
    currency: Currency.INR,
    interval: setup.interval,
    ...(setup.totalCycles !== undefined ? { totalCycles: setup.totalCycles } : {}),
    createdAt: toIso(now),
    startAt: toIso(setup.firstDebitAt),
    ...(setup.isTrial ? { trialEndsAt: toIso(setup.firstDebitAt) } : {}),
    mandateEndsAt: toIso(setup.mandateEndsAt),
    paymentMethod: PaymentMethod.Upi,
    // PhonePe's own `redirectUrl`, exactly as received: "you must use this exactly as received, without modifications".
    checkout: { kind: CheckoutKind.Redirect, url: response.redirectUrl },
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    raw: response,
  };
}

// ---------------------------------------------------------------------------
// Subscription status
// ---------------------------------------------------------------------------

/** The mandate as `GET /checkout/v2/subscriptions/{id}/status` reports it. */
export function mapSubscriptionStatus(body: PhonePeSubscriptionStatus, requestedId: string): Subscription {
  const id = present(body.merchantSubscriptionId) ?? requestedId;
  const status = lookup<SubscriptionStatus>(SUBSCRIPTION_STATE_TO_STATUS, body.state, UNKNOWN_SUBSCRIPTION_STATUS);
  const interval = intervalFor(body.frequency);
  const mandateEndsAt = epochMsToIso(body.expireAt);
  return {
    provider: Provider.PhonePe,
    id,
    reference: id,
    status,
    providerStatus: body.state,
    scheduling: SchedulingMode.Merchant,
    ...(typeof body.maxAmount === 'number' ? { maxAmount: body.maxAmount } : {}),
    currency: Currency.INR,
    ...(interval ? { interval } : {}),
    ...(mandateEndsAt ? { mandateEndsAt } : {}),
    paymentMethod: PaymentMethod.Upi,
    raw: body,
  };
}

/**
 * A mandate the status endpoint does not know, described by its setup order: still waiting for the customer is
 * `created`, failed (or expired: PhonePe fails an unfinished setup order) is `failed`, completed but not yet visible as a
 * mandate is `pending_authorization`.
 */
export function mapSetupOrderAsSubscription(order: PhonePeOrder, merchantSubscriptionId: string): Subscription {
  const status = lookup<SubscriptionStatus>(SETUP_ORDER_STATE_TO_STATUS, order.state, UNKNOWN_SUBSCRIPTION_STATUS);
  const flow = order.paymentFlow;
  const interval = intervalFor(flow?.frequency);
  const mandateEndsAt = epochMsToIso(flow?.expireAt);
  return {
    provider: Provider.PhonePe,
    id: merchantSubscriptionId,
    reference: merchantSubscriptionId,
    status,
    providerStatus: order.state,
    scheduling: SchedulingMode.Merchant,
    ...(typeof flow?.maxAmount === 'number' ? { maxAmount: flow.maxAmount } : {}),
    currency: Currency.INR,
    ...(interval ? { interval } : {}),
    ...(mandateEndsAt ? { mandateEndsAt } : {}),
    paymentMethod: PaymentMethod.Upi,
    raw: order,
  };
}

/** What `cancelSubscription` returns when the cancel call answered 204 but the status could not be read afterwards. */
export function cancelledSubscription(merchantSubscriptionId: string, providerStatus: string): Subscription {
  return {
    provider: Provider.PhonePe,
    id: merchantSubscriptionId,
    reference: merchantSubscriptionId,
    status: SubscriptionStatus.Cancelled,
    providerStatus,
    scheduling: SchedulingMode.Merchant,
    paymentMethod: PaymentMethod.Upi,
  };
}

// ---------------------------------------------------------------------------
// Orders -> charges
// ---------------------------------------------------------------------------

function sortedByTime(attempts: readonly PhonePeAttempt[]): PhonePeAttempt[] {
  return [...attempts].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
}

/** What an order (or a webhook payload shaped like one) says about the debit, as the unified `Charge`. */
export type OrderLike = PhonePeWebhookPayload;

function chargeKindOf(order: OrderLike): ChargeKind {
  const type = order.paymentFlow?.type;
  if (type !== null && type !== undefined && SETUP_FLOW_TYPES.includes(type)) {
    return order.paymentFlow?.authWorkflowType === PhonePeAuthWorkflowType.PennyDrop ? ChargeKind.Authorization : ChargeKind.Upfront;
  }
  return ChargeKind.Recurring;
}

/** `INVALID_MPIN (detailed error code ZM)`. */
function failureReasonOf(errorCode: string | undefined, detailedErrorCode: string | undefined): string | undefined {
  if (errorCode && detailedErrorCode) return `${errorCode} (detailed error code ${detailedErrorCode})`;
  if (errorCode) return errorCode;
  if (detailedErrorCode) return `detailed error code ${detailedErrorCode}`;
  return undefined;
}

/**
 * The debit an order holds. `id` and `reference` are the `merchantOrderId` (the one id the scheduler knows the debit by);
 * PhonePe's transaction id, error code and detailed error code stay in `raw` and in the failure fields.
 *
 * The status comes from the order's `state` through `ORDER_STATE_TO_CHARGE_STATUS`; a state not in the table is `pending`.
 * For a failed order the failure is the order's own `errorCode` / `detailedErrorCode`, else the latest attempt's.
 */
export function mapOrderCharge(
  order: OrderLike,
  context: { merchantOrderId: string; subscriptionId?: string | undefined; raw?: unknown },
): Charge {
  const attempts = sortedByTime(order.paymentDetails ?? []);
  const completed = attempts.find((attempt) => attempt.state === PhonePeOrderState.Completed);
  const latest = attempts[0];
  const amount = order.amount ?? completed?.amount ?? latest?.amount;
  if (typeof amount !== 'number') {
    throw new SubscriptionError(
      ErrorCode.UnexpectedResponse,
      `${Provider.PhonePe} returned order ${context.merchantOrderId} without an amount`,
      { provider: Provider.PhonePe, raw: context.raw ?? order },
    );
  }
  const status = lookup<ChargeStatus>(ORDER_STATE_TO_CHARGE_STATUS, order.state, UNKNOWN_CHARGE_STATUS);
  const failed = status === ChargeStatus.Failed;
  const errorCode = present(order.errorCode) ?? (failed ? present(latest?.errorCode) : undefined);
  const detailedErrorCode = present(order.detailedErrorCode) ?? (failed ? present(latest?.detailedErrorCode) : undefined);
  const paidAt = status === ChargeStatus.Succeeded ? epochMsToIso(completed?.timestamp ?? latest?.timestamp) : undefined;
  const failureCode = errorCode ?? detailedErrorCode;
  const failureReason = failureReasonOf(errorCode, detailedErrorCode);
  const subscriptionId = context.subscriptionId ?? present(order.paymentFlow?.merchantSubscriptionId);
  return {
    provider: Provider.PhonePe,
    id: context.merchantOrderId,
    reference: context.merchantOrderId,
    ...(subscriptionId !== undefined ? { subscriptionId } : {}),
    kind: chargeKindOf(order),
    status,
    ...(order.state !== null && order.state !== undefined ? { providerStatus: order.state } : {}),
    amount,
    currency: Currency.INR,
    ...(paidAt ? { paidAt } : {}),
    ...(failed && failureCode ? { failureCode } : {}),
    ...(failed && failureReason ? { failureReason } : {}),
    paymentMethod: PaymentMethod.Upi,
    raw: context.raw ?? order,
  };
}

/** The debit `POST /redeem` answered: `{ transactionId, state }`. The amount is the notification's. */
export function mapRedeemCharge(
  response: PhonePeRedeemResponse,
  context: { merchantOrderId: string; subscriptionId: string; amount: number; now: Date },
): Charge {
  const status = lookup<ChargeStatus>(ORDER_STATE_TO_CHARGE_STATUS, response.state, UNKNOWN_CHARGE_STATUS);
  return {
    provider: Provider.PhonePe,
    id: context.merchantOrderId,
    reference: context.merchantOrderId,
    subscriptionId: context.subscriptionId,
    kind: ChargeKind.Recurring,
    status,
    providerStatus: response.state,
    amount: context.amount,
    currency: Currency.INR,
    ...(status === ChargeStatus.Succeeded ? { paidAt: toIso(context.now) } : {}),
    paymentMethod: PaymentMethod.Upi,
    raw: response,
  };
}

/**
 * A notification whose execution window has closed without a redemption: the debit can never be raised with it, so it is
 * a failed debit (the scheduler then retries with a fresh notification). PhonePe reports `SUBSCRIPTION_DEBIT_EXECUTE_INTERVAL_EXPIRED`
 * for a redeem after the window [A-ERR]; the order itself keeps its `NOTIFIED` state. (ASSUMPTION: fact sheet 5.3 / 5.4.)
 */
export function expiredNotificationCharge(order: OrderLike, context: { merchantOrderId: string; subscriptionId?: string | undefined }): Charge {
  const charge = mapOrderCharge(order, { ...context, raw: order });
  return {
    ...charge,
    status: ChargeStatus.Failed,
    failureCode: PhonePeErrorCode.ExecuteIntervalExpired,
    failureReason: 'the notification was not redeemed inside its execution window',
  };
}

/** True when a notification's execution window has closed: the debit can never be raised with it. */
export function windowExpired(order: OrderLike, nowMs: number): boolean {
  const validUpto = order.paymentFlow?.validUpto;
  return typeof validUpto === 'number' && validUpto > 0 && nowMs > validUpto;
}

/** True when a notification's execution window has not opened yet. */
export function windowNotOpen(order: OrderLike, nowMs: number): boolean {
  const validAfter = order.paymentFlow?.validAfter;
  return typeof validAfter === 'number' && validAfter > 0 && nowMs < validAfter;
}

// ---------------------------------------------------------------------------
// Notification
// ---------------------------------------------------------------------------

/**
 * The notification as the unified model: `accepted` when PhonePe holds it as `NOTIFICATION_IN_PROGRESS` or `NOTIFIED`.
 * `chargeId` is the notification's `merchantOrderId`: PhonePe ties the debit to it, so the scheduler uses it as the id of
 * the debit that follows. `debitAt` is echoed: PhonePe has no field for it, its window (not earlier than 24 hours after
 * the notification) is what constrains the debit.
 */
export function mapNotification(
  input: ParsedNotifyChargeInput,
  state: string,
  raw: PhonePeNotifyResponse | PhonePeOrder,
): ChargeNotification {
  return {
    provider: Provider.PhonePe,
    id: input.notificationId,
    subscriptionId: input.subscriptionId,
    accepted: NOTIFICATION_STATES.includes(state),
    providerStatus: state,
    amount: input.amount,
    debitAt: input.debitAt,
    ...(input.invoiceNumber !== undefined ? { invoiceNumber: input.invoiceNumber } : {}),
    chargeId: input.notificationId,
    raw,
  };
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

export function mapRefund(
  response: PhonePeRefundResponse,
  context: { merchantRefundId: string; chargeId: string; subscriptionId?: string | undefined; amount: number },
): Refund {
  const status = lookup<RefundStatus>(REFUND_STATE_TO_STATUS, response.state, UNKNOWN_REFUND_STATUS);
  return {
    provider: Provider.PhonePe,
    id: response.refundId,
    reference: context.merchantRefundId,
    chargeId: context.chargeId,
    ...(context.subscriptionId !== undefined ? { subscriptionId: context.subscriptionId } : {}),
    status,
    providerStatus: response.state,
    amount: typeof response.amount === 'number' ? response.amount : context.amount,
    currency: Currency.INR,
    raw: response,
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The message and PhonePe code of an error body. */
export function describeErrorBody(body: PhonePeErrorBody | undefined, text: string): { message: string; providerCode?: string } {
  const code = present(body?.code) ?? present(body?.errorCode);
  const message = present(body?.message)?.trim();
  if (message) return { message, ...(code ? { providerCode: code } : {}) };
  if (code) return { message: `error code ${code}`, providerCode: code };
  const trimmed = text.trim();
  return { message: trimmed === '' ? 'empty response body' : trimmed };
}

/**
 * The `ErrorCode` for a failed HTTP answer: a documented PhonePe code first (HTTP status below 500 only), else the
 * status-derived code the shared client chose.
 */
export function errorCodeFor(httpStatus: number, providerCode: string | undefined, fromStatus: ErrorCode): ErrorCode {
  if (providerCode !== undefined && httpStatus < 500 && Object.prototype.hasOwnProperty.call(ERROR_CODE_BY_PHONEPE_CODE, providerCode)) {
    return ERROR_CODE_BY_PHONEPE_CODE[providerCode as keyof typeof ERROR_CODE_BY_PHONEPE_CODE];
  }
  return fromStatus;
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

function eventId(...parts: (string | number | null | undefined)[]): string {
  return parts.map((part) => (part === null || part === undefined || part === '' ? EVENT_ID_EMPTY : String(part))).join(EVENT_ID_SEPARATOR);
}

/** The subscription a webhook payload is about: the mandate fields sit in `paymentFlow` for orders, in the payload for state changes. */
function webhookSubscriptionId(payload: PhonePeWebhookPayload): string | undefined {
  return (
    present(payload.merchantSubscriptionId) ??
    present(payload.paymentFlow?.merchantSubscriptionId) ??
    subscriptionIdFromSetupOrderId(payload.merchantOrderId)
  );
}

function webhookSubscription(
  payload: PhonePeWebhookPayload,
  subscriptionId: string,
  status: SubscriptionStatus,
  providerStatus: string,
): Subscription {
  const flow = payload.paymentFlow;
  const maxAmount = payload.maxAmount ?? flow?.maxAmount;
  const interval = intervalFor(payload.frequency ?? flow?.frequency);
  const mandateEndsAt = epochMsToIso(payload.expireAt ?? undefined) ?? epochMsToIso(flow?.expireAt);
  return {
    provider: Provider.PhonePe,
    id: subscriptionId,
    reference: subscriptionId,
    status,
    providerStatus,
    scheduling: SchedulingMode.Merchant,
    ...(typeof maxAmount === 'number' ? { maxAmount } : {}),
    currency: Currency.INR,
    ...(interval ? { interval } : {}),
    ...(mandateEndsAt ? { mandateEndsAt } : {}),
    paymentMethod: PaymentMethod.Upi,
  };
}

/** The most recent attempt's timestamp, or the payload's own. */
function orderOccurredAt(payload: PhonePeWebhookPayload): string | undefined {
  return epochMsToIso(sortedByTime(payload.paymentDetails ?? [])[0]?.timestamp) ?? epochMsToIso(payload.paymentFlow?.notifiedAt);
}

/**
 * Normalises one verified webhook body into one event.
 *
 * Mapping (every other event, and any event whose payload contradicts its name, is `unknown` with its name in
 * `providerEventType`):
 *
 * | PhonePe event                                                     | event                                 |
 * |-------------------------------------------------------------------|---------------------------------------|
 * | subscription.setup.order.completed, checkout.order.completed (setup) | subscription.authorized            |
 * | subscription.setup.order.failed, checkout.order.failed (setup)       | subscription.authorization_failed  |
 * | subscription.notification.completed                               | subscription.charge_scheduled         |
 * | subscription.notification.failed                                  | unknown (payload undocumented)        |
 * | subscription.redemption.order.completed (state COMPLETED)         | subscription.charged                  |
 * | subscription.redemption.transaction.completed (attempt COMPLETED) | subscription.charged                  |
 * | subscription.redemption.order.failed (state FAILED)               | subscription.charge_failed            |
 * | subscription.redemption.transaction.failed                        | unknown (one attempt; PhonePe retries)|
 * | subscription.paused / unpaused                                    | subscription.paused / resumed         |
 * | subscription.revoked / cancelled                                  | subscription.cancelled                |
 * | pg.refund.completed / failed                                      | refund.succeeded / refund.failed      |
 *
 * Event ids (for de-duplication) are built from the event name and the ids in the payload. Both redemption success
 * events of one debit share one id (a consumer that fulfils on `subscription.charged` must not see it twice).
 * PhonePe's `unpaused`, `revoked` and `cancelled` payloads carry no timestamp, so two such events of one subscription
 * with identical bodies have the same id: a second un-pause of the same subscription is indistinguishable from a
 * redelivery of the first.
 */
export function mapWebhook(webhook: PhonePeWebhook, rawBody: string): SubscriptionEvent {
  const { event, payload } = webhook;
  const subscriptionId = webhookSubscriptionId(payload);
  const orderId = present(payload.merchantOrderId);
  const base = {
    provider: Provider.PhonePe,
    providerEventType: event,
    raw: webhook,
  } as const;
  const unknown = (idParts: (string | null | undefined)[], extra: Partial<SubscriptionEvent> = {}): SubscriptionEvent => ({
    id: eventId(event, ...idParts),
    ...base,
    type: EventType.Unknown,
    ...(subscriptionId !== undefined ? { subscriptionId } : {}),
    ...extra,
  });
  const fallbackId = hash(HashAlgorithm.Sha256, rawBody, DigestEncoding.Hex);

  switch (event) {
    case PhonePeEvent.SetupCompleted:
    case PhonePeEvent.SetupFailed:
    case PhonePeEvent.CheckoutOrderCompleted:
    case PhonePeEvent.CheckoutOrderFailed: {
      const completed = event === PhonePeEvent.SetupCompleted || event === PhonePeEvent.CheckoutOrderCompleted;
      const flowType = payload.paymentFlow?.type;
      const isSetup = flowType !== null && flowType !== undefined && SETUP_FLOW_TYPES.includes(flowType);
      // `checkout.order.*` also announce ordinary one-off payments of the merchant: only a subscription setup is ours.
      const expectedState = completed ? PhonePeOrderState.Completed : PhonePeOrderState.Failed;
      if (!isSetup || subscriptionId === undefined || orderId === undefined || payload.state !== expectedState) {
        return unknown([orderId ?? fallbackId]);
      }
      const charge = mapOrderCharge(payload, { merchantOrderId: orderId, subscriptionId });
      const occurredAt = orderOccurredAt(payload);
      return {
        id: eventId(event, orderId),
        ...base,
        type: completed ? EventType.SubscriptionAuthorized : EventType.SubscriptionAuthorizationFailed,
        ...(occurredAt ? { occurredAt } : {}),
        subscriptionId,
        subscription: webhookSubscription(
          payload,
          subscriptionId,
          completed ? SubscriptionStatus.PendingAuthorization : SubscriptionStatus.Failed,
          payload.state,
        ),
        charge,
      };
    }

    case PhonePeEvent.Paused:
    case PhonePeEvent.Unpaused:
    case PhonePeEvent.Revoked:
    case PhonePeEvent.Cancelled: {
      const state = present(payload.state);
      if (subscriptionId === undefined) return unknown([fallbackId]);
      const type =
        event === PhonePeEvent.Paused
          ? EventType.SubscriptionPaused
          : event === PhonePeEvent.Unpaused
            ? EventType.SubscriptionResumed
            : EventType.SubscriptionCancelled;
      const status =
        event === PhonePeEvent.Paused
          ? SubscriptionStatus.Paused
          : event === PhonePeEvent.Unpaused
            ? SubscriptionStatus.Active
            : SubscriptionStatus.Cancelled;
      const occurredAt = epochMsToIso(payload.pauseStartDate);
      return {
        id: eventId(event, subscriptionId, payload.pauseStartDate, payload.pauseEndDate),
        ...base,
        type,
        ...(occurredAt && event === PhonePeEvent.Paused ? { occurredAt } : {}),
        subscriptionId,
        subscription: webhookSubscription(payload, subscriptionId, status, state ?? event),
      };
    }

    case PhonePeEvent.NotificationCompleted: {
      if (orderId === undefined || subscriptionId === undefined) return unknown([orderId ?? fallbackId]);
      const occurredAt = epochMsToIso(payload.paymentFlow?.notifiedAt);
      return {
        id: eventId(event, orderId),
        ...base,
        type: EventType.SubscriptionChargeScheduled,
        ...(occurredAt ? { occurredAt } : {}),
        subscriptionId,
        charge: mapOrderCharge(payload, { merchantOrderId: orderId, subscriptionId }),
      };
    }

    case PhonePeEvent.NotificationFailed:
      // No page shows this payload and no unified event means "the pre-debit notice failed". Reporting it as a failed
      // charge would burn an attempt for a debit that was never tried, so it is surfaced as `unknown`. The scheduler's
      // next step is the debit, which PhonePe refuses without a valid notification: that failure is then an ordinary one.
      return unknown([orderId ?? fallbackId]);

    case PhonePeEvent.RedemptionOrderCompleted:
    case PhonePeEvent.RedemptionTransactionCompleted:
    case PhonePeEvent.RedemptionOrderFailed:
    case PhonePeEvent.RedemptionTransactionFailed: {
      if (orderId === undefined) return unknown([fallbackId]);
      const attempts = sortedByTime(payload.paymentDetails ?? []);
      const succeeded = event === PhonePeEvent.RedemptionOrderCompleted || event === PhonePeEvent.RedemptionTransactionCompleted;
      if (succeeded) {
        // The order event says so in its `state`; the attempt event (whose `state` is the order's, often still PENDING) in
        // the attempt. Anything else is not normalised.
        const confirmed =
          event === PhonePeEvent.RedemptionOrderCompleted
            ? payload.state === PhonePeOrderState.Completed
            : attempts.some((attempt) => attempt.state === PhonePeOrderState.Completed);
        if (!confirmed) return unknown([orderId]);
        const occurredAt = orderOccurredAt(payload);
        return {
          id: eventId(PhonePeEvent.RedemptionOrderCompleted, orderId),
          ...base,
          type: EventType.SubscriptionCharged,
          ...(occurredAt ? { occurredAt } : {}),
          ...(subscriptionId !== undefined ? { subscriptionId } : {}),
          charge: mapOrderCharge(
            { ...payload, state: PhonePeOrderState.Completed },
            { merchantOrderId: orderId, subscriptionId, raw: payload },
          ),
        };
      }
      // One attempt failed: with the STANDARD retry strategy PhonePe retries inside its window, so only the order's own
      // `FAILED` is final.
      if (event === PhonePeEvent.RedemptionTransactionFailed || payload.state !== PhonePeOrderState.Failed) {
        return unknown([orderId, attempts[0]?.transactionId]);
      }
      const occurredAt = orderOccurredAt(payload);
      return {
        id: eventId(event, orderId),
        ...base,
        type: EventType.SubscriptionChargeFailed,
        ...(occurredAt ? { occurredAt } : {}),
        ...(subscriptionId !== undefined ? { subscriptionId } : {}),
        charge: mapOrderCharge(payload, { merchantOrderId: orderId, subscriptionId, raw: payload }),
      };
    }

    case PhonePeEvent.RefundCompleted:
    case PhonePeEvent.RefundFailed: {
      const merchantRefundId = present(payload.merchantRefundId);
      const chargeId = present(payload.originalMerchantOrderId);
      const refundId = present(payload.refundId);
      const amount = payload.amount;
      if ((merchantRefundId === undefined && refundId === undefined) || chargeId === undefined || typeof amount !== 'number') {
        return unknown([merchantRefundId ?? refundId ?? fallbackId]);
      }
      const succeeded = event === PhonePeEvent.RefundCompleted;
      const occurredAt = epochMsToIso(payload.timestamp);
      const refundSubscriptionId = subscriptionIdFromSetupOrderId(chargeId);
      return {
        id: eventId(event, merchantRefundId ?? refundId),
        ...base,
        type: succeeded ? EventType.RefundSucceeded : EventType.RefundFailed,
        ...(occurredAt ? { occurredAt } : {}),
        ...(refundSubscriptionId !== undefined ? { subscriptionId: refundSubscriptionId } : {}),
        refund: {
          provider: Provider.PhonePe,
          id: refundId ?? merchantRefundId ?? fallbackId,
          ...(merchantRefundId !== undefined ? { reference: merchantRefundId } : {}),
          chargeId,
          ...(refundSubscriptionId !== undefined ? { subscriptionId: refundSubscriptionId } : {}),
          status: succeeded ? RefundStatus.Succeeded : RefundStatus.Failed,
          ...(payload.state !== null && payload.state !== undefined ? { providerStatus: payload.state } : {}),
          amount,
          currency: Currency.INR,
        },
      };
    }

    default:
      // `pg.refund.accepted`, `checkout.transaction.attempt.failed`, `paylink.*`, one-off checkout payments, and anything
      // PhonePe adds later: verified, but not a subscription event this library normalises.
      return unknown([orderId ?? present(payload.merchantRefundId) ?? subscriptionId ?? fallbackId]);
  }
}
