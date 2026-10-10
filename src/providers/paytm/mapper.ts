import { createHash } from 'node:crypto';
import {
  ChargeKind,
  ChargeStatus,
  Currency,
  ErrorCode,
  EventType,
  IntervalUnit,
  PaymentMethod,
  PaymentStatus,
  Provider,
  RefundStatus,
  SchedulingMode,
  SubscriptionStatus,
} from '../../constants.js';
import { SubscriptionError, invalid } from '../../errors.js';
import { paiseToRupeeString, rupeesToPaise } from '../../money.js';
import type {
  BillingInterval,
  Charge,
  Customer,
  Payment,
  Refund,
  Subscription,
  SubscriptionEvent,
} from '../../schemas.js';
import { addDays, cycleStart, fromIstDateString, parseIso, toDate, toIso, toIstDateString, toIstIso } from '../../time.js';
import {
  FALLBACK_CHARGE_STATUS,
  FALLBACK_PAYMENT_STATUS,
  FALLBACK_SUBSCRIPTION_STATUS,
  IST_OFFSET_SUFFIX,
  PAYMENT_EVENT_MAP,
  PAYMENT_EVENT_MAP_ONE_TIME,
  PAYMENT_METHOD_FOR_ONE_TIME_MODE,
  PAYMENT_MODE_MAP,
  PAYTM_BANK_MANDATE_MODES,
  PAYTM_CARD_MAX_GRACE_DAYS,
  PAYTM_CHARGE_STATUS_MAP,
  PAYTM_CUST_ID_PATTERN,
  PAYTM_DATETIME_PATTERN,
  PAYTM_DAY_MONTH_YEAR_SEPARATOR,
  PAYTM_DERIVED_CUST_ID_DIGEST_CHARS,
  PAYTM_DERIVED_CUST_ID_PREFIX,
  PAYTM_ENDED_STATUSES,
  PAYTM_EVENT_ID_SEPARATOR,
  PAYTM_FAILURE_STATUSES,
  PAYTM_FREQUENCY_FOR_INTERVAL,
  PAYTM_INDIA_COUNTRY_CODE,
  PAYTM_INTERVAL_FOR_FREQUENCY,
  PAYTM_MIN_CYCLE_DAYS,
  PAYTM_MOBILE_DIGITS,
  PAYTM_PAYMENT_ORDER_PREFIX,
  PAYTM_PAYMENT_STATUS_MAP,
  PAYTM_PIPE,
  PAYTM_PROVIDER_STATUS_UNKNOWN,
  PAYTM_SLASH_DATETIME_PATTERN,
  PAYTM_SUBSTATUS_RESUMED,
  PaytmAmountType,
  PaytmEventName,
  PaytmFrequencyUnit,
  PaytmMandateType,
  PaytmNotificationStatus,
  PaytmRefundWebhookStatus,
  PaytmSubscriptionStatus,
  SUBSCRIPTION_EVENT_MAP,
  SUBSCRIPTION_STATUS_MAP,
  type ErrorTable,
} from './constants.js';
import type {
  PaytmCallback,
  PaytmPaymentWebhook,
  PaytmPreNotifyWebhook,
  PaytmRefundArnWebhook,
  PaytmRefundWebhookBody,
  PaytmResultInfo,
  PaytmStatusBody,
  PaytmSubscriptionWebhook,
  PaytmTxnStatusBody,
} from './schemas.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+?[0-9]{10,15}$/;

// ---------------------------------------------------------------------------
// Result envelopes (HTTP 200 with a body-level verdict)
// ---------------------------------------------------------------------------

/** `resultInfo` read in either of Paytm's spellings. */
export interface ResultView {
  status?: string;
  code?: string;
  message?: string;
}

export function resultView(info: PaytmResultInfo | null | undefined): ResultView {
  const status = info?.resultStatus ?? info?.status ?? undefined;
  const code = info?.resultCode ?? info?.code ?? undefined;
  const message = info?.resultMsg ?? info?.message ?? undefined;
  return {
    ...(status !== undefined ? { status } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(message !== undefined ? { message } : {}),
  };
}

/** How one Paytm API's `resultInfo` becomes an error. */
export interface ApiResultSpec {
  /** The code of a successful answer. */
  successCode: string;
  /** Other codes that are a success too (Initiate Transaction's "Success Idempotent"). */
  alsoSuccessCodes?: readonly string[];
  errors: ErrorTable;
  /** A failure whose code is not listed in `errors`. */
  unlisted: ErrorCode;
  /** An answer with no verdict at all (no `resultInfo`). For a write this must be `OUTCOME_UNKNOWN`. */
  noVerdict: ErrorCode;
  /** `resultStatus: U` is Paytm saying it does not know: `OUTCOME_UNKNOWN`. */
  unknownStatus?: string;
}

export interface BodyFailure {
  code: ErrorCode;
  providerCode?: string;
  message: string;
}

/** `undefined` for a successful answer, otherwise the error it stands for. */
export function classifyResult(view: ResultView, spec: ApiResultSpec): BodyFailure | undefined {
  if (view.code === undefined && view.status === undefined) {
    return { code: spec.noVerdict, message: 'Paytm answered without a result' };
  }
  const failedStatus = view.status !== undefined && PAYTM_FAILURE_STATUSES.includes(view.status.toUpperCase());
  const successful = view.code === spec.successCode || (view.code !== undefined && spec.alsoSuccessCodes?.includes(view.code) === true);
  if (successful && !failedStatus) return undefined;
  const message = view.message ?? 'no message';
  if (spec.unknownStatus !== undefined && view.status === spec.unknownStatus) {
    return { code: ErrorCode.OutcomeUnknown, ...(view.code !== undefined ? { providerCode: view.code } : {}), message };
  }
  const code = view.code !== undefined ? (spec.errors[view.code] ?? spec.unlisted) : spec.unlisted;
  return { code, ...(view.code !== undefined ? { providerCode: view.code } : {}), message };
}

// ---------------------------------------------------------------------------
// Money, dates, text
// ---------------------------------------------------------------------------

export function paise(value: string | null | undefined): number | undefined {
  return rupeesToPaise(value);
}

/** `2026-11-17 10:30:00` / `2026-11-17 10:30:00.0` (IST) or a plain `YYYY-MM-DD` (midnight IST) as an instant. */
export function parseIstDateTime(value: string | null | undefined): Date | undefined {
  if (value === null || value === undefined) return undefined;
  const text = value.trim();
  const match = PAYTM_DATETIME_PATTERN.exec(text);
  if (match) return parseIso(`${match[1]}T${match[2]}${IST_OFFSET_SUFFIX}`);
  return fromIstDateString(text) ?? parseIso(text);
}

/** `14/09/2020 11:37` (IST). */
export function parseSlashDateTime(value: string | null | undefined): Date | undefined {
  if (value === null || value === undefined) return undefined;
  const match = PAYTM_SLASH_DATETIME_PATTERN.exec(value.trim());
  if (!match) return undefined;
  const [, day, month, year, hour, minute] = match;
  return parseIso(`${year}-${month}-${day}T${hour}:${minute}:00${IST_OFFSET_SUFFIX}`);
}

export function isoOf(date: Date | undefined): string | undefined {
  return date ? toIso(date) : undefined;
}

/** `YYYY-MM-DD HH:mm:ss` in IST, the form of the Renew `debitDate`. */
export function toIstDateTimeString(date: Date): string {
  return toIstIso(date).slice(0, 19).replace('T', ' ');
}

/** `DD-MM-YYYY` in IST, the form of the Pre-Notify `txnDate`. */
export function toIstDayMonthYear(date: Date): string {
  const [year, month, day] = toIstDateString(date).split('-');
  return [day, month, year].join(PAYTM_DAY_MONTH_YEAR_SEPARATOR);
}

/** Whole IST calendar days from `from` to `to` (negative when `to` is earlier). */
export function istDaysBetween(from: Date, to: Date): number {
  const start = fromIstDateString(toIstDateString(from));
  const end = fromIstDateString(toIstDateString(to));
  if (!start || !end) return 0;
  return Math.round((end.getTime() - start.getTime()) / DAY_MS);
}

// ---------------------------------------------------------------------------
// Frequency
// ---------------------------------------------------------------------------

/** The Paytm unit for an interval, or `undefined` when Paytm's request cannot name that cycle. */
export function frequencyUnitFor(interval: BillingInterval): PaytmFrequencyUnit | undefined {
  return PAYTM_FREQUENCY_FOR_INTERVAL.find((entry) => entry.unit === interval.unit && entry.count === interval.count)?.frequency;
}

/** The intervals a plan may use, for an error message. */
export function supportedIntervalsText(): string {
  return PAYTM_FREQUENCY_FOR_INTERVAL.map((entry) => `${entry.count} ${entry.unit}`).join(', ');
}

/** A billing interval from the unit and the multiplier Fetch Status / the webhook return. */
export function intervalFromFrequency(unit: string | null | undefined, frequency: string | null | undefined): BillingInterval | undefined {
  if (!unit) return undefined;
  const cycle = PAYTM_INTERVAL_FOR_FREQUENCY[unit.toUpperCase() as PaytmFrequencyUnit];
  if (!cycle) return undefined;
  const parsed = frequency === null || frequency === undefined ? 1 : Number(frequency);
  const multiplier = Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
  return { unit: cycle.unit, count: cycle.count * multiplier };
}

/**
 * The most grace days Paytm accepts: not more than the cycle ("Grace days cannot be greater than the frequency set against
 * the subscription") and, when only cards may be used, 3.
 */
export function maxGraceDays(unit: PaytmFrequencyUnit, cardsOnly: boolean): number {
  const cycle = PAYTM_MIN_CYCLE_DAYS[unit] ?? 1;
  return cardsOnly ? Math.min(cycle, PAYTM_CARD_MAX_GRACE_DAYS) : cycle;
}

// ---------------------------------------------------------------------------
// Customer
// ---------------------------------------------------------------------------

/** 10 digits: `+919876543210`, `919876543210` and `9876543210` are the same number. Anything else cannot be a Paytm `mobile`. */
export function formatMobile(phone: string): string {
  const digits = phone.replace(/^\+/, '');
  if (digits.length === PAYTM_MOBILE_DIGITS + PAYTM_INDIA_COUNTRY_CODE.length && digits.startsWith(PAYTM_INDIA_COUNTRY_CODE)) {
    return digits.slice(PAYTM_INDIA_COUNTRY_CODE.length);
  }
  if (digits.length === PAYTM_MOBILE_DIGITS) return digits;
  throw invalid(
    `customer.phone must be a 10-digit Indian mobile number (optionally with +91): Paytm's userInfo.mobile takes exactly 10 digits, got ${digits.length} digits`,
    Provider.Paytm,
  );
}

/** A stable `custId` for a customer without one: a digest of the order id, so it holds only characters Paytm allows. */
export function derivedCustId(orderId: string): string {
  return `${PAYTM_DERIVED_CUST_ID_PREFIX}${createHash('sha256').update(orderId, 'utf8').digest('hex').slice(0, PAYTM_DERIVED_CUST_ID_DIGEST_CHARS)}`;
}

export interface UserInfoResult {
  userInfo: {
    custId: string;
    mobile?: string;
    email?: string;
    firstName?: string;
    lastName?: string;
  };
  /** True when `customer.id` was absent and `custId` is derived from the order id. */
  derived: boolean;
}

export function buildUserInfo(customer: Customer, orderId: string): UserInfoResult {
  const supplied = customer.id;
  if (supplied !== undefined && !PAYTM_CUST_ID_PATTERN.test(supplied)) {
    throw invalid(
      'customer.id cannot be Paytm\'s custId: it may hold only letters, digits and the characters @ ! = _ $ .',
      Provider.Paytm,
    );
  }
  const [firstName, ...rest] = (customer.name ?? '').trim().split(/\s+/).filter((part) => part !== '');
  const lastName = rest.join(' ');
  return {
    userInfo: {
      custId: supplied ?? derivedCustId(orderId),
      ...(customer.phone !== undefined ? { mobile: formatMobile(customer.phone) } : {}),
      ...(customer.email !== undefined ? { email: customer.email } : {}),
      ...(firstName !== undefined ? { firstName } : {}),
      ...(lastName !== '' ? { lastName } : {}),
    },
    derived: supplied === undefined,
  };
}

// ---------------------------------------------------------------------------
// Request text
// ---------------------------------------------------------------------------

/** The path of the first string in `value` that holds the pipe character, or `undefined`. Paytm rejects it (code 1008). */
export function findPipe(value: unknown, path = 'body'): string | undefined {
  if (typeof value === 'string') return value.includes(PAYTM_PIPE) ? path : undefined;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findPipe(item, `${path}[${index}]`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value !== null && typeof value === 'object') {
    for (const [name, item] of Object.entries(value)) {
      const found = findPipe(item, `${path}.${name}`);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Mandate dates
// ---------------------------------------------------------------------------

/** `subscriptionExpiryDate` (IST date) from what the caller gave. */
export function deriveExpiryDate(input: {
  firstDebit: Date;
  interval: BillingInterval;
  totalCycles?: number;
  mandateEndsAt?: string;
  mandateYears: number;
  /** Days kept after the last due date of a plan with a cycle count. */
  bufferDays: number;
}): string {
  if (input.mandateEndsAt !== undefined) return toIstDateString(toDate(input.mandateEndsAt, 'mandateEndsAt'));
  if (input.totalCycles !== undefined) {
    const lastDue = cycleStart(input.firstDebit, input.interval, input.totalCycles - 1);
    return toIstDateString(addDays(lastDue, input.bufferDays));
  }
  return toIstDateString(cycleStart(input.firstDebit, { unit: IntervalUnit.Year, count: input.mandateYears }, 1));
}

/**
 * True when a start date keeps UPI available: "only T or T+Frequency date will work". The unit is the plan's interval, so a
 * bi-monthly plan is two months away, not one. [sub-faq]
 */
export function isUpiSafeStartDate(startDate: string, today: Date, interval: BillingInterval): boolean {
  return startDate === toIstDateString(today) || startDate === toIstDateString(cycleStart(today, interval, 1));
}

// ---------------------------------------------------------------------------
// Payment modes and statuses
// ---------------------------------------------------------------------------

export function mapPaymentMethod(mode: string | null | undefined, mandateType?: string | null): PaymentMethod | undefined {
  if (!mode) return undefined;
  const method = PAYMENT_MODE_MAP[mode.toUpperCase()];
  if (method === PaymentMethod.ENach && mandateType === PaytmMandateType.PaperMandate) return PaymentMethod.PhysicalNach;
  return method;
}

export function isBankMandateMode(mode: string | null | undefined): boolean {
  return mode !== null && mode !== undefined && PAYTM_BANK_MANDATE_MODES.includes(mode.toUpperCase());
}

export function mapSubscriptionStatus(status: string | null | undefined): SubscriptionStatus {
  if (!status) return FALLBACK_SUBSCRIPTION_STATUS;
  return SUBSCRIPTION_STATUS_MAP[status.toUpperCase() as PaytmSubscriptionStatus] ?? FALLBACK_SUBSCRIPTION_STATUS;
}

/** The scheduling a Paytm subscription has, from its amount type: only FIX can be collected by Paytm itself. */
export function schedulingOf(amountType: string | null | undefined): SchedulingMode {
  return amountType?.toUpperCase() === PaytmAmountType.Fix ? SchedulingMode.Gateway : SchedulingMode.Merchant;
}

function validEmail(value: string | null | undefined): string | undefined {
  return value && EMAIL_PATTERN.test(value) ? value : undefined;
}

function validPhone(value: string | null | undefined): string | undefined {
  return value && PHONE_PATTERN.test(value) ? value : undefined;
}

function customerOf(id: string | null | undefined, email: string | null | undefined, phone: string | null | undefined): Customer | undefined {
  const customer: Customer = {
    ...(id ? { id } : {}),
    ...(validEmail(email) !== undefined ? { email: validEmail(email) as string } : {}),
    ...(validPhone(phone) !== undefined ? { phone: validPhone(phone) as string } : {}),
  };
  return Object.keys(customer).length > 0 ? customer : undefined;
}

// ---------------------------------------------------------------------------
// Fetch Subscription Status -> Subscription
// ---------------------------------------------------------------------------

export function mapStatusSubscription(subscriptionId: string, body: PaytmStatusBody): Subscription {
  const status = mapSubscriptionStatus(body.status);
  const providerStatus = body.status ?? PAYTM_PROVIDER_STATUS_UNKNOWN;
  const scheduling = schedulingOf(body.amountType);
  const ceiling = paise(body.maxAmount);
  const interval = intervalFromFrequency(body.frequencyUnit, body.frequency);
  const instrument = body.subsPaymentInstDetails ?? undefined;
  const method = mapPaymentMethod(instrument?.paymentMode ?? body.payMode, instrument?.mandateType);
  const createdAt = isoOf(parseIstDateTime(body.createdDate));
  const mandateEndsAt = isoOf(parseIstDateTime(body.expiryDate));
  const nextRetry = isoOf(parseIstDateTime(body.subsNextRetry?.attemptedTime));
  const customer = customerOf(body.custId, body.custEmailId, body.custMobileNo);
  return {
    provider: Provider.Paytm,
    id: body.subsId ?? subscriptionId,
    ...(body.orderId ? { reference: body.orderId } : {}),
    ...(body.planId ? { planId: body.planId } : {}),
    status,
    providerStatus,
    scheduling,
    ...(customer ? { customer } : {}),
    // A fixed subscription's cap is its amount; a variable one has no fixed amount.
    ...(scheduling === SchedulingMode.Gateway && ceiling !== undefined ? { amount: ceiling } : {}),
    ...(ceiling !== undefined ? { maxAmount: ceiling } : {}),
    currency: Currency.INR,
    ...(interval ? { interval } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(nextRetry ? { nextChargeAt: nextRetry } : {}),
    ...(PAYTM_ENDED_STATUSES.includes(status) && isoOf(parseIstDateTime(body.updatedDate))
      ? { endedAt: isoOf(parseIstDateTime(body.updatedDate)) as string }
      : {}),
    ...(mandateEndsAt ? { mandateEndsAt } : {}),
    ...(method ? { paymentMethod: method } : {}),
    raw: body,
  };
}

// ---------------------------------------------------------------------------
// Transaction Status / callback / webhook -> Charge
// ---------------------------------------------------------------------------

function chargeStatusOf(status: string | null | undefined): ChargeStatus {
  if (!status) return FALLBACK_CHARGE_STATUS;
  return PAYTM_CHARGE_STATUS_MAP[status.toUpperCase()] ?? FALLBACK_CHARGE_STATUS;
}

/**
 * A debit from the Transaction Status API. `TXN_SUCCESS` with a refund amount is `refunded` / `partially_refunded` (the
 * scheduler counts both as collected). `txnAmount` is absent from some answers; the amount is then 0, which only ever
 * accompanies a status that does not depend on it.
 */
export function mapTransactionCharge(
  body: PaytmTxnStatusBody,
  context: { chargeId: string; subscriptionId?: string; kind?: ChargeKind },
): Charge {
  const view = resultView(body.resultInfo);
  const providerStatus = view.status ?? PAYTM_PROVIDER_STATUS_UNKNOWN;
  let status = chargeStatusOf(view.status);
  const amount = paise(body.txnAmount) ?? 0;
  const refunded = paise(body.refundAmt) ?? 0;
  if (status === ChargeStatus.Succeeded && refunded > 0) {
    status = amount > 0 && refunded >= amount ? ChargeStatus.Refunded : ChargeStatus.PartiallyRefunded;
  }
  const paidAt = status === ChargeStatus.Pending || status === ChargeStatus.Failed ? undefined : isoOf(parseIstDateTime(body.txnDate));
  const method = mapPaymentMethod(body.paymentMode);
  return {
    provider: Provider.Paytm,
    id: context.chargeId,
    reference: context.chargeId,
    ...(context.subscriptionId !== undefined ? { subscriptionId: context.subscriptionId } : {}),
    kind: context.kind ?? ChargeKind.Recurring,
    status,
    providerStatus,
    amount,
    currency: Currency.INR,
    ...(paidAt ? { paidAt } : {}),
    ...(status === ChargeStatus.Failed
      ? {
          ...(view.code !== undefined ? { failureCode: view.code } : {}),
          ...(view.message !== undefined ? { failureReason: view.message } : {}),
        }
      : {}),
    ...(method ? { paymentMethod: method } : {}),
    ...(refunded > 0 ? { refundedAmount: refunded } : {}),
    raw: body,
  };
}

/** The debit a Renew answer accepted. Paytm acknowledges the request only: the money has not moved. [renew] */
export function mapRenewCharge(input: {
  chargeId: string;
  subscriptionId: string;
  amount: number;
  scheduledAt?: string;
  view: ResultView;
  raw: unknown;
}): Charge {
  return {
    provider: Provider.Paytm,
    id: input.chargeId,
    reference: input.chargeId,
    subscriptionId: input.subscriptionId,
    kind: ChargeKind.Recurring,
    status: ChargeStatus.Pending,
    providerStatus: input.view.message ?? input.view.status ?? PAYTM_PROVIDER_STATUS_UNKNOWN,
    amount: input.amount,
    currency: Currency.INR,
    ...(input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt } : {}),
    raw: input.raw,
  };
}

/** The consent or upfront payment the checkout callback describes, or `undefined` when it carries no amount. */
export function mapCallbackCharge(callback: PaytmCallback, context: { subscriptionId: string; upfrontPaise?: number }): Charge | undefined {
  const amount = paise(callback.TXNAMOUNT);
  if (amount === undefined || amount <= 0) return undefined;
  const status = chargeStatusOf(callback.STATUS);
  const method = mapPaymentMethod(callback.PAYMENTMODE, callback.MANDATE_TYPE);
  const paidAt = status === ChargeStatus.Succeeded ? isoOf(parseIstDateTime(callback.TXNDATE)) : undefined;
  return {
    provider: Provider.Paytm,
    id: callback.ORDERID,
    reference: callback.ORDERID,
    subscriptionId: context.subscriptionId,
    // A trial's token debit is not recorded as an upfront amount by Paytm; a real upfront amount is.
    kind: context.upfrontPaise !== undefined && context.upfrontPaise > 0 ? ChargeKind.Upfront : ChargeKind.Authorization,
    status,
    providerStatus: callback.STATUS ?? PAYTM_PROVIDER_STATUS_UNKNOWN,
    amount,
    currency: Currency.INR,
    ...(paidAt ? { paidAt } : {}),
    ...(status === ChargeStatus.Failed
      ? {
          ...(callback.RESPCODE ? { failureCode: callback.RESPCODE } : {}),
          ...(callback.RESPMSG ? { failureReason: callback.RESPMSG } : {}),
        }
      : {}),
    ...(method ? { paymentMethod: method } : {}),
    raw: callback,
  };
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

export function mapRefund(input: {
  refundId: string;
  refId: string;
  chargeId: string;
  subscriptionId?: string;
  /** Set for the refund of a one-time payment: `chargeId` and `paymentId` are then the same order id. */
  paymentId?: string;
  amount: number;
  status: RefundStatus;
  providerStatus: string;
  createdAt?: string;
  raw: unknown;
}): Refund {
  return {
    provider: Provider.Paytm,
    id: input.refundId,
    reference: input.refId,
    chargeId: input.chargeId,
    ...(input.paymentId !== undefined ? { paymentId: input.paymentId } : {}),
    ...(input.subscriptionId !== undefined ? { subscriptionId: input.subscriptionId } : {}),
    status: input.status,
    providerStatus: input.providerStatus,
    amount: input.amount,
    currency: Currency.INR,
    ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
    raw: input.raw,
  };
}

// ---------------------------------------------------------------------------
// One-time payments
// ---------------------------------------------------------------------------

/** The order id a one-time payment is created under: `pay_` and then the caller's reference or a generated token. */
export function paymentOrderId(reference: string): string {
  return `${PAYTM_PAYMENT_ORDER_PREFIX}${reference}`;
}

/** True for an order id of a one-time payment (see `PAYTM_PAYMENT_ORDER_PREFIX`). */
export function isPaymentOrderId(orderId: string): boolean {
  return orderId.startsWith(PAYTM_PAYMENT_ORDER_PREFIX) && orderId.length > PAYTM_PAYMENT_ORDER_PREFIX.length;
}

/** The part of a payment's order id after the prefix: the caller's `reference` (or the generated token). */
export function paymentReference(orderId: string): string {
  return orderId.slice(PAYTM_PAYMENT_ORDER_PREFIX.length);
}

/** `{ paymentId }` for an event or refund about a one-time payment, nothing for anything else. */
function paymentIdOf(orderId: string): { paymentId?: string } {
  return isPaymentOrderId(orderId) ? { paymentId: orderId } : {};
}

export function mapOneTimePaymentMethod(mode: string | null | undefined): PaymentMethod | undefined {
  if (!mode) return undefined;
  return PAYMENT_METHOD_FOR_ONE_TIME_MODE[mode.toUpperCase()];
}

export function mapPaymentStatus(status: string | null | undefined): PaymentStatus {
  if (!status) return FALLBACK_PAYMENT_STATUS;
  return PAYTM_PAYMENT_STATUS_MAP[status.toUpperCase()] ?? FALLBACK_PAYMENT_STATUS;
}

/** True when the payment's money was received, whether or not some of it has been refunded since. */
export function isPaidStatus(status: PaymentStatus): boolean {
  return status === PaymentStatus.Succeeded || status === PaymentStatus.Refunded || status === PaymentStatus.PartiallyRefunded;
}

/**
 * The payment Transaction Status describes. `TXN_SUCCESS` with a refund amount is `refunded` / `partially_refunded`. A payment
 * needs an amount: `amountFallback` (the callback's `TXNAMOUNT`) stands in when the answer has none, and without either the
 * answer is unusable.
 */
export function mapTransactionPayment(
  body: PaytmTxnStatusBody,
  context: { orderId: string; amountFallback?: string | null },
): Payment {
  const view = resultView(body.resultInfo);
  const providerStatus = view.status ?? PAYTM_PROVIDER_STATUS_UNKNOWN;
  let status = mapPaymentStatus(view.status);
  const amount = paise(body.txnAmount) ?? paise(context.amountFallback);
  if (amount === undefined) {
    throw new SubscriptionError(
      ErrorCode.UnexpectedResponse,
      `${Provider.Paytm} returned the status of order ${context.orderId} without its txnAmount`,
      { provider: Provider.Paytm, raw: body },
    );
  }
  const refunded = paise(body.refundAmt) ?? 0;
  if (status === PaymentStatus.Succeeded && refunded > 0) {
    status = amount > 0 && refunded >= amount ? PaymentStatus.Refunded : PaymentStatus.PartiallyRefunded;
  }
  const paidAt = isPaidStatus(status) ? isoOf(parseIstDateTime(body.txnDate)) : undefined;
  const method = mapOneTimePaymentMethod(body.paymentMode);
  return {
    provider: Provider.Paytm,
    id: context.orderId,
    reference: paymentReference(context.orderId),
    status,
    providerStatus,
    amount,
    currency: Currency.INR,
    ...(refunded > 0 ? { refundedAmount: refunded } : {}),
    ...(method ? { paymentMethod: method } : {}),
    ...(paidAt ? { paidAt } : {}),
    ...(status === PaymentStatus.Failed
      ? {
          ...(view.code !== undefined ? { failureCode: view.code } : {}),
          ...(view.message !== undefined ? { failureReason: view.message } : {}),
        }
      : {}),
    raw: body,
  };
}

// ---------------------------------------------------------------------------
// Webhooks -> events
// ---------------------------------------------------------------------------

function eventId(...parts: (string | null | undefined)[]): string {
  return [Provider.Paytm, ...parts.map((part) => part ?? '')].join(PAYTM_EVENT_ID_SEPARATOR);
}

/**
 * Subscription Status webhook. The id is built from the subscription, its status and Paytm's update time, so a redelivery
 * of the same notification has the same id and a later status change has another.
 */
export function mapSubscriptionWebhook(form: PaytmSubscriptionWebhook, raw: unknown): SubscriptionEvent {
  const providerStatus = form.STATUS;
  const subStatus = form.subStatus ?? form.SUBSTATUS ?? undefined;
  const resumed =
    providerStatus.toUpperCase() === PaytmSubscriptionStatus.Active && subStatus?.toUpperCase() === PAYTM_SUBSTATUS_RESUMED;
  const type = resumed ? EventType.SubscriptionResumed : (SUBSCRIPTION_EVENT_MAP[providerStatus.toUpperCase()] ?? EventType.Unknown);
  const ceiling = paise(form.MAXAMOUNT);
  const scheduling = schedulingOf(form.AMOUNTTYPE);
  const interval = intervalFromFrequency(form.FREQUENCYUNIT, form.FREQUENCY);
  const method = mapPaymentMethod(form.PAYMENTMODE, form.MANDATETYPE);
  const customer = customerOf(form.CUSTID, form.CUSTEMAILID, form.CUSTMOBILE);
  const createdAt = isoOf(parseIstDateTime(form.CREATEDDATE));
  const mandateEndsAt = isoOf(parseIstDateTime(form.EXPIRYDATE));
  const occurredAt = isoOf(parseIstDateTime(form.UPDATEDDATE));
  const status = mapSubscriptionStatus(providerStatus);
  const subscription: Subscription = {
    provider: Provider.Paytm,
    id: form.SUBS_ID,
    ...(form.ORDERID ? { reference: form.ORDERID } : {}),
    status,
    providerStatus,
    scheduling,
    ...(customer ? { customer } : {}),
    ...(scheduling === SchedulingMode.Gateway && ceiling !== undefined ? { amount: ceiling } : {}),
    ...(ceiling !== undefined ? { maxAmount: ceiling } : {}),
    currency: Currency.INR,
    ...(interval ? { interval } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(mandateEndsAt ? { mandateEndsAt } : {}),
    ...(method ? { paymentMethod: method } : {}),
  };
  return {
    id: eventId(PaytmEventName.SubscriptionStatus, form.SUBS_ID, providerStatus, subStatus, form.UPDATEDDATE),
    provider: Provider.Paytm,
    type,
    providerEventType: `${PaytmEventName.SubscriptionStatus}${PAYTM_EVENT_ID_SEPARATOR}${providerStatus}`,
    ...(occurredAt ? { occurredAt } : {}),
    subscriptionId: form.SUBS_ID,
    subscription,
    raw,
  };
}

/**
 * Payment Status webhook: one debit, keyed by its order id. No subscription id is documented in this payload, so none is
 * set; `charge.id` and `charge.reference` are the order id, which is the id the scheduler raised the debit under. The
 * webhook cannot tell a renewal from the upfront payment, so `kind` is `recurring`; the scheduler only acts on an order id
 * it knows.
 */
export function mapPaymentWebhook(form: PaytmPaymentWebhook, raw: unknown): SubscriptionEvent {
  const providerStatus = form.STATUS;
  const status = chargeStatusOf(providerStatus);
  const amount = paise(form.TXNAMOUNT) ?? 0;
  const method = mapPaymentMethod(form.PAYMENTMODE);
  const occurredAt = isoOf(parseIstDateTime(form.TXNDATE));
  const charge: Charge = {
    provider: Provider.Paytm,
    id: form.ORDERID,
    reference: form.ORDERID,
    kind: ChargeKind.Recurring,
    status,
    providerStatus,
    amount,
    currency: Currency.INR,
    ...(status === ChargeStatus.Succeeded && occurredAt ? { paidAt: occurredAt } : {}),
    ...(status === ChargeStatus.Failed
      ? {
          ...(form.RESPCODE ? { failureCode: form.RESPCODE } : {}),
          ...(form.RESPMSG ? { failureReason: form.RESPMSG } : {}),
        }
      : {}),
    ...(method ? { paymentMethod: method } : {}),
    raw,
  };
  return {
    id: eventId(PaytmEventName.Payment, form.ORDERID, providerStatus, form.TXNID),
    provider: Provider.Paytm,
    type: PAYMENT_EVENT_MAP[providerStatus.toUpperCase()] ?? EventType.Unknown,
    providerEventType: `${PaytmEventName.Payment}${PAYTM_EVENT_ID_SEPARATOR}${providerStatus}`,
    ...(occurredAt ? { occurredAt } : {}),
    charge,
    raw,
  };
}

/**
 * Payment Status webhook of a ONE-TIME payment (its order id starts with the payment prefix): `payment.succeeded` /
 * `payment.failed` with the payment built from the signed fields. A status that is not final is an `unknown` event that still
 * carries the payment.
 */
export function mapOneTimePaymentWebhook(form: PaytmPaymentWebhook, raw: unknown): SubscriptionEvent {
  const providerStatus = form.STATUS;
  const status = mapPaymentStatus(providerStatus);
  const amount = paise(form.TXNAMOUNT);
  if (amount === undefined) {
    throw new SubscriptionError(
      ErrorCode.UnexpectedResponse,
      `${Provider.Paytm} sent a payment webhook for order ${form.ORDERID} without its TXNAMOUNT`,
      { provider: Provider.Paytm, raw },
    );
  }
  const method = mapOneTimePaymentMethod(form.PAYMENTMODE);
  const occurredAt = isoOf(parseIstDateTime(form.TXNDATE));
  const payment: Payment = {
    provider: Provider.Paytm,
    id: form.ORDERID,
    reference: paymentReference(form.ORDERID),
    status,
    providerStatus,
    amount,
    currency: Currency.INR,
    ...(method ? { paymentMethod: method } : {}),
    ...(isPaidStatus(status) && occurredAt ? { paidAt: occurredAt } : {}),
    ...(status === PaymentStatus.Failed
      ? {
          ...(form.RESPCODE ? { failureCode: form.RESPCODE } : {}),
          ...(form.RESPMSG ? { failureReason: form.RESPMSG } : {}),
        }
      : {}),
    raw,
  };
  return {
    id: eventId(PaytmEventName.Payment, form.ORDERID, providerStatus, form.TXNID),
    provider: Provider.Paytm,
    type: PAYMENT_EVENT_MAP_ONE_TIME[providerStatus.toUpperCase()] ?? EventType.Unknown,
    providerEventType: `${PaytmEventName.Payment}${PAYTM_EVENT_ID_SEPARATOR}${providerStatus}`,
    ...(occurredAt ? { occurredAt } : {}),
    paymentId: form.ORDERID,
    payment,
    raw,
  };
}

/** Pre-Notify callback: the customer was (or was not) told. It names no subscription and no amount, so it carries neither. */
export function mapPreNotifyWebhook(form: PaytmPreNotifyWebhook, raw: unknown): SubscriptionEvent {
  const delivered = form.NOTIFICATIONSTATUS.toUpperCase() === PaytmNotificationStatus.Success;
  const occurredAt = isoOf(parseSlashDateTime(form.NOTIFICATIONDATE));
  return {
    id: eventId(PaytmEventName.PreNotify, form.REFERENCEID, form.NOTIFICATIONSTATUS),
    provider: Provider.Paytm,
    type: delivered ? EventType.SubscriptionChargeScheduled : EventType.Unknown,
    providerEventType: `${PaytmEventName.PreNotify}${PAYTM_EVENT_ID_SEPARATOR}${form.NOTIFICATIONSTATUS}`,
    ...(occurredAt ? { occurredAt } : {}),
    raw,
  };
}

/** Refund ARN webhook: information about a refund that already succeeded (the bank reference), not a state change. */
export function mapRefundArnWebhook(form: PaytmRefundArnWebhook, raw: unknown): SubscriptionEvent {
  const occurredAt = isoOf(parseIstDateTime(form.REFUNDDATETIME));
  return {
    id: eventId(PaytmEventName.RefundArn, form.REFID, form.REFUNDID, form.ARN),
    provider: Provider.Paytm,
    type: EventType.Unknown,
    providerEventType: PaytmEventName.RefundArn,
    ...(occurredAt ? { occurredAt } : {}),
    ...paymentIdOf(form.ORDERID),
    refund: mapRefund({
      refundId: form.REFUNDID ?? form.REFID,
      refId: form.REFID,
      chargeId: form.ORDERID,
      ...paymentIdOf(form.ORDERID),
      amount: paise(form.REFUNDAMOUNT) ?? 0,
      status: RefundStatus.Succeeded,
      providerStatus: PaytmEventName.RefundArn,
      raw,
    }),
    raw,
  };
}

/** True for the Success Refund webhook (refund submitted to the bank); the Accept Refund webhook lacks these fields. */
export function isSuccessRefundWebhook(body: PaytmRefundWebhookBody): boolean {
  return (
    body.userCreditInitiateTimestamp !== undefined && body.userCreditInitiateTimestamp !== null
      ? true
      : body.refundDetailInfoList !== undefined || (body.source !== undefined && body.source !== null)
  );
}

/**
 * Accept Refund (refund registered, the amount taken from the merchant's balance; the customer has not been credited) and
 * Success Refund (submitted to the bank). Only Success Refund is `refund.succeeded`: an accepted refund is not yet money
 * with the customer. A `FAILED` status of either is `refund.failed`.
 */
export function mapRefundWebhook(body: PaytmRefundWebhookBody, raw: unknown): SubscriptionEvent {
  const success = isSuccessRefundWebhook(body);
  const failed = body.status?.toUpperCase() === PaytmRefundWebhookStatus.Failed;
  const name = success ? PaytmEventName.SuccessRefund : PaytmEventName.AcceptRefund;
  const refundStatus = failed ? RefundStatus.Failed : success ? RefundStatus.Succeeded : RefundStatus.Pending;
  const type = failed ? EventType.RefundFailed : success ? EventType.RefundSucceeded : EventType.Unknown;
  const occurredAt = isoOf(
    parseIstDateTime(success ? (body.userCreditInitiateTimestamp ?? body.acceptRefundTimestamp) : body.acceptRefundTimestamp),
  );
  return {
    id: eventId(name, body.refId, body.refundId, body.status ?? refundStatus),
    provider: Provider.Paytm,
    type,
    providerEventType: body.status ? `${name}${PAYTM_EVENT_ID_SEPARATOR}${body.status}` : name,
    ...(occurredAt ? { occurredAt } : {}),
    ...paymentIdOf(body.orderId),
    refund: mapRefund({
      refundId: body.refundId ?? body.refId,
      refId: body.refId,
      chargeId: body.orderId,
      ...paymentIdOf(body.orderId),
      amount: paise(body.refundAmount) ?? 0,
      status: refundStatus,
      providerStatus: body.status ?? name,
      ...(isoOf(parseIstDateTime(body.merchantRefundRequestTimestamp))
        ? { createdAt: isoOf(parseIstDateTime(body.merchantRefundRequestTimestamp)) as string }
        : {}),
      raw,
    }),
    raw,
  };
}

// ---------------------------------------------------------------------------
// Small helpers the adapter shares
// ---------------------------------------------------------------------------

/** The amount in the form Paytm takes it: rupees with two decimals. */
export function rupees(paiseAmount: number): string {
  return paiseToRupeeString(paiseAmount);
}
