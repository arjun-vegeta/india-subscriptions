import {
  ChargeKind,
  ChargeStatus,
  Currency,
  ErrorCode,
  EventType,
  PaymentMethod,
  Provider,
  RefundStatus,
  SchedulingMode,
  IntervalUnit,
  SubscriptionStatus,
} from '../../constants.js';
import { SubscriptionError, invalid } from '../../errors.js';
import { paiseToRupeeString, rupeesToPaise } from '../../money.js';
import type {
  BillingInterval,
  Charge,
  ChargeNotification,
  Refund,
  Subscription,
  SubscriptionEvent,
} from '../../schemas.js';
import { addDays, cycleStart, fromIstDateString, parseIso, toIso, toIstDateString } from '../../time.js';
import {
  ASYNC_REGISTRATION_METHODS,
  BILLING_CYCLE_BY_UNIT,
  BLANK_DEBIT_STATUS,
  BODY_ERROR_CODES,
  BODY_ERROR_RULES,
  CARD_MANDATE_STATUS,
  CHARGE_STATUS_BY_STATE,
  DEFAULT_MANDATE_HORIZON_YEARS,
  ENACH_MANDATE_STATUS,
  EVENT_BY_MANDATE_NOTIFICATION,
  EVENT_BY_UPI_ACTION,
  FIRSTNAME_MAX_LENGTH,
  INDIAN_MOBILE_DIGITS,
  INDIA_COUNTRY_CODE,
  IST_OFFSET_SUFFIX,
  IST_TIMESTAMP_PATTERN,
  MANDATE_END_GRACE_DAYS,
  MANDATE_ID_PATTERN,
  PAYMENT_METHOD_BY_MODE,
  PAYMENT_METHOD_BY_PG_TYPE,
  PAYU_BILLING_CURRENCY,
  PAYU_DISALLOWED_TEXT_CHARS,
  PAYU_ENACH_CANCELLATION_NOTIFICATION,
  PAYU_ENACH_CANCELLATION_STATUS,
  PAYU_FAILED_STATUS_VALUES,
  PAYU_FREE_TRIAL_CONSENT_PAISE,
  PAYU_MANDATE_METHODS,
  PAYU_NONE_FETCHED_PATTERN,
  PAYU_NO_ERROR_CODE,
  PAYU_NO_ERROR_MESSAGE,
  PAYU_NOT_FOUND,
  PAYU_STATUS_OK,
  PRODUCTINFO_MAX_LENGTH,
  PayUPaymentSource,
  PayUPaymentStatus,
  PayUPaymentWebhookEvent,
  PayUPgType,
  PayUPreDebitCode,
  PayURefundCode,
  PayUWebhookRefundStatus,
  REFUND_CAPTURED_TODAY_PATTERN,
  REFUND_ERROR_CODES,
  REFUND_REMARKS_DISALLOWED_CHARS,
  REFUND_REMARKS_MAX_LENGTH,
  SUBSCRIPTION_ID_SEPARATOR,
  UNKNOWN_CHARGE_STATUS,
  UNKNOWN_MANDATE_STATUS,
  UPI_MANDATE_STATUS,
  WEBHOOK_UNKNOWN_ID,
  type PayUMandateMethod,
} from './constants.js';
import type {
  PayUCardMandateWebhook,
  PayUDebitDetail,
  PayUEnachCancellationWebhook,
  PayUEnvelope,
  PayUMandateStatusResponse,
  PayUPaymentResponse,
  PayUPreDebitResponse,
  PayURefundResponse,
  PayURefundWebhook,
  PayUSiDetails,
  PayUUpiMandateWebhook,
  PayUVerifiedTransaction,
} from './schemas.js';

const PROVIDER = Provider.PayU;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Case-, whitespace-, `-` and `_`-insensitive key, so `in-progress` finds `in progress`. */
function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[-_\s]+/g, ' ');
}

/** Looks a PayU status up in a table whose keys are PayU's spellings. */
function lookup<V>(table: Record<string, V>, key: string | null | undefined): V | undefined {
  if (key === null || key === undefined) return undefined;
  const wanted = normalizeKey(key);
  if (wanted === '') return undefined;
  for (const [candidate, value] of Object.entries(table)) {
    if (normalizeKey(candidate) === wanted) return value;
  }
  return undefined;
}

function blank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === '';
}

function present(value: string | null | undefined): string | undefined {
  return blank(value) ? undefined : (value as string).trim();
}

/** The mandate id under whichever casing PayU used. */
export function pickAuthPayuId(...candidates: (string | null | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    const value = present(candidate);
    if (value !== undefined) return value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Composite subscription id: `<method>:<mihpayid>`
// ---------------------------------------------------------------------------

export interface MandateRef {
  method: PayUMandateMethod;
  /** PayU's mandate id: the `mihpayid` of the consent transaction (the "authpayuid" of every later command). */
  mandateId: string;
}

/**
 * PayU's status / revoke / modify commands differ per payment method and this
 * adapter is stateless, so the subscription id it hands out after the customer
 * authorises is `<method>:<mihpayid>`, e.g. `upi:25600438037`.
 */
export function encodeSubscriptionId(ref: MandateRef): string {
  if (!PAYU_MANDATE_METHODS.includes(ref.method)) {
    throw invalid(`PayU mandates exist for ${PAYU_MANDATE_METHODS.join(', ')}, not "${String(ref.method)}"`, PROVIDER);
  }
  if (!MANDATE_ID_PATTERN.test(ref.mandateId)) {
    throw invalid('PayU mandate id (mihpayid) is empty or contains characters PayU never uses', PROVIDER);
  }
  return `${ref.method}${SUBSCRIPTION_ID_SEPARATOR}${ref.mandateId}`;
}

/** Inverse of {@link encodeSubscriptionId}. Throws `VALIDATION` for anything else. */
export function decodeSubscriptionId(id: unknown): MandateRef {
  const fail = (): SubscriptionError =>
    invalid(
      `"${typeof id === 'string' ? id.slice(0, 80) : String(id)}" is not a PayU subscription id. ` +
        `Use the subscriptionId returned by verifyCheckout: "<method>${SUBSCRIPTION_ID_SEPARATOR}<mihpayid>" ` +
        `with method one of ${PAYU_MANDATE_METHODS.join(', ')}`,
      PROVIDER,
    );
  if (typeof id !== 'string') throw fail();
  const index = id.indexOf(SUBSCRIPTION_ID_SEPARATOR);
  if (index <= 0) throw fail();
  const method = id.slice(0, index);
  const mandateId = id.slice(index + SUBSCRIPTION_ID_SEPARATOR.length);
  const known = PAYU_MANDATE_METHODS.find((candidate) => candidate === method);
  if (known === undefined || !MANDATE_ID_PATTERN.test(mandateId)) throw fail();
  return { method: known, mandateId };
}

// ---------------------------------------------------------------------------
// Customer text and phone
// ---------------------------------------------------------------------------

/**
 * Removes the characters PayU "automatically removes" (so the text that is
 * hashed is the text PayU keeps), trims, and cuts to PayU's limit. Throws when
 * nothing is left.
 */
export function sanitizePayUText(value: string, maxLength: number, field: string): string {
  const cleaned = value
    .replace(PAYU_DISALLOWED_TEXT_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .trim();
  if (cleaned === '') {
    throw invalid(
      `${field} has no characters PayU accepts (letters A-Z, digits and - _ @ / . space only)`,
      PROVIDER,
    );
  }
  return cleaned;
}

export const sanitizeProductInfo = (value: string): string =>
  sanitizePayUText(value, PRODUCTINFO_MAX_LENGTH, 'plan name (sent as productinfo)');
export const sanitizeFirstName = (value: string): string =>
  sanitizePayUText(value, FIRSTNAME_MAX_LENGTH, 'customer.name (sent as firstname)');

/**
 * An e-mail address cannot be silently cleaned: PayU would drop a `+` and mail
 * a different mailbox. A character PayU strips is a `VALIDATION` error instead.
 */
export function checkEmail(value: string, maxLength: number): string {
  if (value.length > maxLength) throw invalid(`customer.email is longer than the ${maxLength} characters PayU accepts`, PROVIDER);
  if (value.replace(PAYU_DISALLOWED_TEXT_CHARS, '') !== value) {
    throw invalid(
      'customer.email contains a character PayU strips from e-mail addresses (only letters, digits and - _ @ / . are kept); use an address without it',
      PROVIDER,
    );
  }
  return value;
}

/** `+919876543210` and `919876543210` become `9876543210`; other numbers lose only the `+`. */
export function formatPhone(phone: string): string {
  const digits = phone.startsWith('+') ? phone.slice(1) : phone;
  if (digits.length === INDIAN_MOBILE_DIGITS + INDIA_COUNTRY_CODE.length && digits.startsWith(INDIA_COUNTRY_CODE)) {
    return digits.slice(INDIA_COUNTRY_CODE.length);
  }
  return digits;
}

// ---------------------------------------------------------------------------
// Dates (IST)
// ---------------------------------------------------------------------------

/** "2026-11-17 10:30:00" (PayU, IST), "2026-11-17", or an ISO string -> ISO instant. */
export function parsePayUDate(value: string | null | undefined): string | undefined {
  const text = present(value);
  if (text === undefined) return undefined;
  const stamp = IST_TIMESTAMP_PATTERN.exec(text);
  if (stamp) {
    const date = parseIso(`${stamp[1]}T${stamp[2]}${IST_OFFSET_SUFFIX}`);
    return date ? toIso(date) : undefined;
  }
  const day = fromIstDateString(text);
  if (day && /^\d{4}-\d{2}-\d{2}$/.test(text)) return toIso(day);
  const iso = parseIso(text);
  return iso ? toIso(iso) : undefined;
}

export interface MandateDates {
  /** `paymentStartDate`: the first debit date in IST. */
  start: string;
  /** `paymentEndDate` in IST. */
  end: string;
}

/**
 * `paymentStartDate` is the first debit date; `paymentEndDate` is, in order,
 * `mandateEndsAt`, the last of `totalCycles` debits plus a retry grace, or
 * a default horizon after the first debit.
 */
export function deriveMandateDates(input: {
  firstChargeAt: Date;
  interval: BillingInterval;
  totalCycles?: number;
  mandateEndsAt?: string;
}): MandateDates {
  const start = toIstDateString(input.firstChargeAt);
  if (input.mandateEndsAt !== undefined) {
    const ends = parseIso(input.mandateEndsAt);
    if (!ends) throw invalid(`mandateEndsAt is not a valid date: ${input.mandateEndsAt}`, PROVIDER);
    return { start, end: toIstDateString(ends) };
  }
  if (input.totalCycles !== undefined) {
    const lastDebit = cycleStart(input.firstChargeAt, input.interval, input.totalCycles - 1);
    return { start, end: toIstDateString(addDays(lastDebit, MANDATE_END_GRACE_DAYS)) };
  }
  const horizon = cycleStart(input.firstChargeAt, { unit: IntervalUnit.Year, count: DEFAULT_MANDATE_HORIZON_YEARS }, 1);
  return { start, end: toIstDateString(horizon) };
}

export function buildSiDetailsInput(input: {
  ceilingPaise: number;
  interval: BillingInterval;
  dates: MandateDates;
}): PayUSiDetails {
  return {
    billingAmount: paiseToRupeeString(input.ceilingPaise),
    billingCurrency: PAYU_BILLING_CURRENCY,
    billingCycle: BILLING_CYCLE_BY_UNIT[input.interval.unit],
    billingInterval: input.interval.count,
    paymentStartDate: input.dates.start,
    paymentEndDate: input.dates.end,
  };
}

/**
 * What the consent transaction charges.
 *
 * - With an upfront amount: that amount ("pay and subscribe": the first
 *   instalment collected with the registration).
 * - Without: a free-trial consent, `free_trial=1` with INR 2.00. PayU documents
 *   "min 1 INR (for Cards & UPI)" and "0 INR (for Net Banking)", and for
 *   `free_trial` it "adjusts the transaction amount as INR 2.00 for cards and UPI
 *   and INR 0.00 for Net Banking irrespective of what amount is passed". The
 *   docs disagree on UPI (INR 0.00 on the cards pages); INR 0.00 is not valid on
 *   cards or UPI ("the 0.00 INR transaction is not supported today"), so INR 2.00
 *   is the only choice valid on every method. If `free_trial` is not honoured
 *   (it "has no significance in the case of seamless flow") the posted INR 2.00
 *   is itself a valid cards/UPI penny amount. Refunding it is the merchant's job.
 */
export function consentCharge(upfrontPaise: number | undefined): { amount: string; freeTrial: boolean } {
  if (upfrontPaise !== undefined) return { amount: paiseToRupeeString(upfrontPaise), freeTrial: false };
  return { amount: paiseToRupeeString(PAYU_FREE_TRIAL_CONSENT_PAISE), freeTrial: true };
}

// ---------------------------------------------------------------------------
// Status tables
// ---------------------------------------------------------------------------

export interface MappedChargeStatus {
  status: ChargeStatus;
  /** The first non-blank PayU state, verbatim. */
  providerStatus?: string;
}

/**
 * Translates PayU's transaction state: the first candidate (`unmappedstatus`,
 * then `status`) that is in the table wins; blanks are ignored; a state that is
 * not in the table is `pending`, never a guess at success or failure.
 */
export function mapChargeStatus(...candidates: (string | null | undefined)[]): MappedChargeStatus {
  let verbatim: string | undefined;
  for (const candidate of candidates) {
    const state = present(candidate);
    if (state === undefined) continue;
    verbatim ??= state;
    const mapped = lookup(CHARGE_STATUS_BY_STATE, state);
    if (mapped !== undefined) return { status: mapped, providerStatus: verbatim };
  }
  return { status: UNKNOWN_CHARGE_STATUS, ...(verbatim !== undefined ? { providerStatus: verbatim } : {}) };
}

/** Mandate status -> SubscriptionStatus for one payment method. Unknown: `pending_authorization`. */
export function mapMandateStatus(method: PayUMandateMethod, status: string | null | undefined): SubscriptionStatus {
  const table: Record<string, SubscriptionStatus> =
    method === PaymentMethod.Card ? CARD_MANDATE_STATUS : method === PaymentMethod.ENach ? ENACH_MANDATE_STATUS : UPI_MANDATE_STATUS;
  return lookup(table, status) ?? UNKNOWN_MANDATE_STATUS;
}

export function paymentMethodOf(response: {
  mode?: string | null;
  PG_TYPE?: string | null;
}): PayUMandateMethod | undefined {
  return lookup(PAYMENT_METHOD_BY_MODE, response.mode) ?? lookup(PAYMENT_METHOD_BY_PG_TYPE, response.PG_TYPE);
}

// ---------------------------------------------------------------------------
// Consent outcome (`surl` / `furl` / payment webhook)
// ---------------------------------------------------------------------------

export interface ConsentOutcome {
  /** The mandate is registered and live. */
  authorized: boolean;
  status: SubscriptionStatus;
  /** Composite id when a mandate exists, otherwise the consent txnid. */
  subscriptionId: string;
  method?: PayUMandateMethod;
  charge: Charge;
}

function amountPaise(value: string, what: string): number {
  const paise = rupeesToPaise(value);
  if (paise === undefined) {
    throw new SubscriptionError(ErrorCode.UnexpectedResponse, `payu returned ${what} "${value}" that is not an amount`, {
      provider: PROVIDER,
    });
  }
  return paise;
}

/**
 * Decides the outcome of a consent transaction from the documented combination
 * of `status`, `payment_source` and (cards) `cardToken`:
 *
 * | mandate | transaction | unmappedstatus | status  | payment_source |
 * | ------- | ----------- | -------------- | ------- | -------------- |
 * | success | success     | captured       | success | sist           |
 * | failed  | success     | captured       | success | payu           |
 * | failed  | failed      | failed         | failure | payu           |
 *
 * eNACH is registered "at bank end" and usable only after up to T+2 days, so a
 * successful eNACH consent is `pending_authorization` until the mandate status
 * command confirms it.
 */
export function evaluateConsent(response: PayUPaymentResponse): ConsentOutcome {
  const method = paymentMethodOf(response);
  const mihpayid = present(response.mihpayid);
  const status = normalizeKey(response.status);
  const source = normalizeKey(response.payment_source ?? '');
  const cardTokenOk = method !== PaymentMethod.Card || !blank(response.cardToken ?? response.card_token);

  const registered =
    status === PayUPaymentStatus.Success &&
    source === PayUPaymentSource.MandateRegistered &&
    mihpayid !== undefined &&
    cardTokenOk;

  let subscriptionId = response.txnid;
  if (registered) {
    if (method === undefined) {
      throw new SubscriptionError(
        ErrorCode.UnexpectedResponse,
        'payu registered a mandate but the response has no recognisable mode / PG_TYPE, so the subscription id cannot be built',
        { provider: PROVIDER, raw: response },
      );
    }
    subscriptionId = encodeSubscriptionId({ method, mandateId: mihpayid });
  }

  let outcomeStatus: SubscriptionStatus;
  let authorized = false;
  if (registered) {
    const asynchronous = method !== undefined && ASYNC_REGISTRATION_METHODS.includes(method);
    authorized = !asynchronous;
    outcomeStatus = asynchronous ? SubscriptionStatus.PendingAuthorization : SubscriptionStatus.Active;
  } else if (status === PayUPaymentStatus.Pending) {
    outcomeStatus = SubscriptionStatus.PendingAuthorization;
  } else {
    outcomeStatus = SubscriptionStatus.Failed;
  }

  const mapped = mapChargeStatus(response.unmappedstatus, response.status);
  const failed = mapped.status === ChargeStatus.Failed || mapped.status === ChargeStatus.Cancelled;
  const errorCode = present(response.error);
  const charge: Charge = {
    provider: PROVIDER,
    id: mihpayid ?? response.txnid,
    reference: response.txnid,
    ...(registered ? { subscriptionId } : {}),
    kind: ChargeKind.Authorization,
    status: mapped.status,
    ...(mapped.providerStatus !== undefined ? { providerStatus: mapped.providerStatus } : {}),
    amount: amountPaise(response.amount, 'a consent amount'),
    currency: Currency.INR,
    ...(mapped.status === ChargeStatus.Succeeded ? paidAt(response.addedon) : {}),
    ...(failed && errorCode !== undefined && errorCode !== PAYU_NO_ERROR_CODE ? { failureCode: errorCode } : {}),
    ...(failed ? failureReason(response.error_Message, response.field9) : {}),
    ...(method !== undefined ? { paymentMethod: method } : {}),
    raw: response,
  };

  return { authorized, status: outcomeStatus, subscriptionId, ...(method !== undefined ? { method } : {}), charge };
}

function paidAt(addedon: string | null | undefined): { paidAt?: string } {
  const iso = parsePayUDate(addedon);
  return iso === undefined ? {} : { paidAt: iso };
}

function failureReason(...candidates: (string | null | undefined)[]): { failureReason?: string } {
  for (const candidate of candidates) {
    const text = present(candidate);
    if (text !== undefined && text.toLowerCase() !== PAYU_NO_ERROR_MESSAGE.toLowerCase()) return { failureReason: text };
  }
  return {};
}

// ---------------------------------------------------------------------------
// Body-level errors on HTTP 200
// ---------------------------------------------------------------------------

export interface BodyFailure {
  code: ErrorCode;
  message: string;
  providerCode?: string;
}

/** The human-readable text of a postservice answer, whichever key carried it. */
export function envelopeMessage(envelope: PayUEnvelope): string | undefined {
  return present(envelope.errorMessage) ?? present(envelope.message) ?? present(envelope.Message) ?? present(envelope.msg);
}

export interface BodyFailurePolicy {
  /** Code for an internal error, where the outcome is genuinely unclear. */
  unclear: ErrorCode;
  /** Code for a failure shape not recognised by the rules; `null` returns `undefined` so the caller interprets it. */
  otherwise: ErrorCode | null;
}

/**
 * Turns a body-level failure (`status` 0 / 422 or an `errorCode`, on HTTP 200)
 * into an error code. Returns `undefined` when the body is not a failure.
 */
export function classifyBodyFailure(envelope: PayUEnvelope, policy: BodyFailurePolicy): BodyFailure | undefined {
  const errorCode = present(envelope.errorCode);
  const status = envelope.status;
  const failedStatus = status !== null && status !== undefined && PAYU_FAILED_STATUS_VALUES.includes(status);
  if (!failedStatus && errorCode === undefined) return undefined;

  const message = envelopeMessage(envelope) ?? 'PayU reported a failure without a message';
  const providerCode = errorCode ?? (status !== null && status !== undefined ? String(status) : undefined);
  const withCode = (code: ErrorCode): BodyFailure => ({ code, message, ...(providerCode !== undefined ? { providerCode } : {}) });

  if (errorCode !== undefined && Object.hasOwn(BODY_ERROR_CODES, errorCode)) {
    const byCode = BODY_ERROR_CODES[errorCode];
    return withCode(byCode ?? policy.unclear);
  }
  const rule = BODY_ERROR_RULES.find(({ pattern }) => pattern.test(message));
  if (rule) return withCode(rule.code ?? policy.unclear);
  if (policy.otherwise === null) return undefined;
  return withCode(policy.otherwise);
}

// ---------------------------------------------------------------------------
// Mandates
// ---------------------------------------------------------------------------

export function mapMandateSubscription(id: string, ref: MandateRef, body: PayUMandateStatusResponse): Subscription {
  const providerStatus = String(body.status);
  const status = mapMandateStatus(ref.method, providerStatus);
  const ceiling = rupeesToPaise(body.amount);
  const startAt = parsePayUDate(body.mandateStartDate);
  const mandateEndsAt = parsePayUDate(body.mandateEndDate);
  const endedAt = status === SubscriptionStatus.Cancelled ? parsePayUDate(body.deletedon) : undefined;
  return {
    provider: PROVIDER,
    id,
    status,
    providerStatus,
    scheduling: SchedulingMode.Merchant,
    ...(ceiling !== undefined ? { maxAmount: ceiling } : {}),
    currency: Currency.INR,
    ...(startAt !== undefined ? { startAt } : {}),
    ...(mandateEndsAt !== undefined ? { mandateEndsAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    paymentMethod: ref.method,
    raw: body,
  };
}

/** The subscription after a revoke call: card and UPI revoke is synchronous, eNACH is acknowledged and finishes at the bank. */
export function mapRevokedSubscription(id: string, ref: MandateRef, body: PayUEnvelope, now: Date): Subscription {
  return {
    provider: PROVIDER,
    id,
    status: SubscriptionStatus.Cancelled,
    providerStatus: envelopeMessage(body) ?? String(body.status ?? PAYU_STATUS_OK),
    scheduling: SchedulingMode.Merchant,
    endedAt: toIso(now),
    paymentMethod: ref.method,
    raw: body,
  };
}

// ---------------------------------------------------------------------------
// Pre-debit
// ---------------------------------------------------------------------------

export function mapPreDebit(input: {
  notificationId: string;
  subscriptionId: string;
  amountPaise: number;
  debitAt: string;
  invoiceNumber: string;
  body: PayUPreDebitResponse;
}): ChargeNotification {
  const { body } = input;
  const status = body.status === null || body.status === undefined ? '' : String(body.status);
  const message = envelopeMessage(body);
  // A duplicate means PayU already holds this notification (a retry after a lost answer).
  const accepted = status === String(PAYU_STATUS_OK) || status === PayUPreDebitCode.Duplicate;
  const reported = accepted ? status : message !== undefined ? `${status}: ${message}` : status;
  const echoed = rupeesToPaise(body.amount);
  return {
    provider: PROVIDER,
    id: pickAuthPayuId(body.invoiceid, body.invoiceId) ?? input.notificationId,
    subscriptionId: input.subscriptionId,
    accepted,
    ...(reported !== '' ? { providerStatus: reported } : {}),
    amount: echoed ?? input.amountPaise,
    debitAt: input.debitAt,
    invoiceNumber: input.invoiceNumber,
    raw: body,
  };
}

// ---------------------------------------------------------------------------
// Debits
// ---------------------------------------------------------------------------

/** The `si_transaction` answer for one debit, as a Charge. */
export function mapDebitDetail(input: {
  detail: PayUDebitDetail;
  chargeId: string;
  requestedPaise: number;
  subscriptionId: string;
  method: PayUMandateMethod;
}): Charge {
  const { detail } = input;
  const state = present(detail.status);
  const mapped = state === undefined ? { status: BLANK_DEBIT_STATUS } : mapChargeStatus(detail.status);
  const failed = mapped.status === ChargeStatus.Failed || mapped.status === ChargeStatus.Cancelled;
  const echoed = rupeesToPaise(detail.amount);
  return {
    provider: PROVIDER,
    id: present(detail.payuid) ?? input.chargeId,
    reference: input.chargeId,
    subscriptionId: input.subscriptionId,
    kind: ChargeKind.Recurring,
    status: mapped.status,
    ...(state !== undefined ? { providerStatus: state } : {}),
    amount: echoed ?? input.requestedPaise,
    currency: Currency.INR,
    ...(failed ? failureReason(detail.field9) : {}),
    paymentMethod: input.method,
    raw: detail,
  };
}

/** A `verify_payment` transaction as a Charge. */
export function mapVerifiedTransaction(input: {
  transaction: PayUVerifiedTransaction;
  chargeId: string;
  subscriptionId: string;
  method: PayUMandateMethod;
}): Charge {
  const { transaction: tx } = input;
  const mapped = mapChargeStatus(tx.unmappedstatus, tx.status);
  const failed = mapped.status === ChargeStatus.Failed || mapped.status === ChargeStatus.Cancelled;
  const source = normalizeKey(tx.payment_source ?? '');
  const amount = rupeesToPaise(tx.transaction_amount) ?? rupeesToPaise(tx.amt) ?? rupeesToPaise(tx.net_amount_debit) ?? 0;
  const payuId = present(tx.mihpayid);
  const code = present(tx.error_code);
  return {
    provider: PROVIDER,
    id: payuId !== undefined && payuId !== PAYU_NOT_FOUND ? payuId : input.chargeId,
    reference: input.chargeId,
    subscriptionId: input.subscriptionId,
    kind: source === PayUPaymentSource.MandateRegistered ? ChargeKind.Authorization : ChargeKind.Recurring,
    status: mapped.status,
    ...(mapped.providerStatus !== undefined ? { providerStatus: mapped.providerStatus } : {}),
    amount,
    currency: Currency.INR,
    ...(mapped.status === ChargeStatus.Succeeded ? paidAt(tx.addedon) : {}),
    ...(failed && code !== undefined && code !== PAYU_NO_ERROR_CODE ? { failureCode: code } : {}),
    ...(failed ? failureReason(tx.error_Message, tx.field9) : {}),
    paymentMethod: input.method,
    raw: tx,
  };
}

/** True for `transaction_details[txnid]` that PayU answers with "Not Found". */
export function isNotFoundTransaction(tx: PayUVerifiedTransaction | undefined, message: string | undefined): boolean {
  if (tx === undefined) return message !== undefined && PAYU_NONE_FETCHED_PATTERN.test(message);
  return present(tx.status) === PAYU_NOT_FOUND || present(tx.mihpayid) === PAYU_NOT_FOUND;
}

/** The amount a full refund of this transaction returns: what was actually debited, else the transaction amount. */
export function refundableAmountPaise(tx: PayUVerifiedTransaction): number | undefined {
  const debited = rupeesToPaise(tx.net_amount_debit);
  if (debited !== undefined && debited > 0) return debited;
  return rupeesToPaise(tx.transaction_amount) ?? rupeesToPaise(tx.amt);
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

export function sanitizeRefundRemarks(reason: string): string {
  return reason.replace(REFUND_REMARKS_DISALLOWED_CHARS, '').replace(/\s+/g, ' ').trim().slice(0, REFUND_REMARKS_MAX_LENGTH);
}

/**
 * `cancel_refund_transaction`: "The error_code value 102 should be treated as
 * success; the rest are failures." Success (100) is final, queued / pending
 * (102, 101, and the sample without a code) are pending. Returns an error for
 * anything else.
 */
export function mapRefundResponse(input: {
  body: PayURefundResponse;
  chargeId: string;
  refundToken: string;
  amountPaise: number;
  subscriptionId?: string;
}): { refund: Refund } | { failure: BodyFailure } {
  const { body } = input;
  const code = present(body.error_code);
  const message = envelopeMessage(body);
  const ok = body.status !== null && body.status !== undefined && String(body.status) === String(PAYU_STATUS_OK);

  if (ok && message !== undefined && REFUND_CAPTURED_TODAY_PATTERN.test(message)) {
    return { failure: { code: ErrorCode.Conflict, message, ...(code !== undefined ? { providerCode: code } : {}) } };
  }
  const queued = code === undefined || code === PayURefundCode.Queued || code === PayURefundCode.Pending || code === PayURefundCode.Success;
  if (!ok || !queued) {
    const mappedCode = code !== undefined ? REFUND_ERROR_CODES[code] : undefined;
    return {
      failure: {
        code: mappedCode ?? ErrorCode.ProviderError,
        message: message ?? 'PayU did not accept the refund',
        ...(code !== undefined ? { providerCode: code } : {}),
      },
    };
  }
  const refund: Refund = {
    provider: PROVIDER,
    id: present(body.request_id) ?? input.refundToken,
    reference: input.refundToken,
    chargeId: input.chargeId,
    ...(input.subscriptionId !== undefined ? { subscriptionId: input.subscriptionId } : {}),
    status: code === PayURefundCode.Success ? RefundStatus.Succeeded : RefundStatus.Pending,
    ...(message !== undefined ? { providerStatus: message } : {}),
    amount: input.amountPaise,
    currency: Currency.INR,
    raw: body,
  };
  return { refund };
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

function baseEvent(
  id: string,
  type: EventType,
  providerEventType: string,
  raw: unknown,
  extra: Partial<SubscriptionEvent> = {},
): SubscriptionEvent {
  return { id, provider: PROVIDER, type, providerEventType, ...extra, raw };
}

/** A payment webhook (form-encoded): the consent result or a recurring debit. */
export function mapPaymentWebhook(response: PayUPaymentResponse): SubscriptionEvent {
  const source = normalizeKey(response.payment_source ?? '');
  const mapped = mapChargeStatus(response.unmappedstatus, response.status);
  const state = normalizeKey(response.status);
  const eventName =
    state === PayUPaymentStatus.Success
      ? PayUPaymentWebhookEvent.Successful
      : state === PayUPaymentStatus.Pending
        ? PayUPaymentWebhookEvent.Pending
        : PayUPaymentWebhookEvent.Failed;
  const id = `${present(response.mihpayid) ?? response.txnid}:${normalizeKey(response.status)}`;
  const occurredAt = parsePayUDate(response.addedon);
  const when = occurredAt !== undefined ? { occurredAt } : {};

  const recurring =
    source === PayUPaymentSource.RecurringDebit ||
    normalizeKey(response.PG_TYPE ?? '') === normalizeKey(PayUPgType.StandingInstruction);
  if (recurring) {
    const charge = recurringChargeFromWebhook(response, mapped);
    if (mapped.status === ChargeStatus.Succeeded) {
      return baseEvent(id, EventType.SubscriptionCharged, eventName, response, { ...when, charge });
    }
    if (mapped.status === ChargeStatus.Failed || mapped.status === ChargeStatus.Cancelled) {
      return baseEvent(id, EventType.SubscriptionChargeFailed, eventName, response, { ...when, charge });
    }
    return baseEvent(id, EventType.Unknown, eventName, response, { ...when, charge });
  }

  if (source === PayUPaymentSource.MandateRegistered && state === PayUPaymentStatus.Success) {
    const outcome = evaluateConsent(response);
    const subscription: Subscription = {
      provider: PROVIDER,
      id: outcome.subscriptionId,
      reference: response.txnid,
      status: outcome.status,
      providerStatus: response.status,
      scheduling: SchedulingMode.Merchant,
      ...(outcome.method !== undefined ? { paymentMethod: outcome.method } : {}),
      raw: response,
    };
    const common = { ...when, subscriptionId: outcome.subscriptionId, subscription, charge: outcome.charge };
    // eNACH is not live until the bank confirms: not an authorisation yet.
    return baseEvent(id, outcome.authorized ? EventType.SubscriptionAuthorized : EventType.Unknown, eventName, response, common);
  }

  // An ordinary payment, or a failed consent (PayU marks a failed consent `payu`, like any failed payment).
  return baseEvent(id, EventType.Unknown, eventName, response, when);
}

function recurringChargeFromWebhook(
  response: PayUPaymentResponse,
  mapped: MappedChargeStatus,
): Charge {
  const failed = mapped.status === ChargeStatus.Failed || mapped.status === ChargeStatus.Cancelled;
  const code = present(response.error);
  return {
    provider: PROVIDER,
    id: present(response.mihpayid) ?? response.txnid,
    reference: response.txnid,
    kind: ChargeKind.Recurring,
    status: mapped.status,
    ...(mapped.providerStatus !== undefined ? { providerStatus: mapped.providerStatus } : {}),
    amount: amountPaise(response.amount, 'a debit amount'),
    currency: Currency.INR,
    ...(mapped.status === ChargeStatus.Succeeded ? paidAt(response.addedon) : {}),
    ...(failed && code !== undefined && code !== PAYU_NO_ERROR_CODE ? { failureCode: code } : {}),
    ...(failed ? failureReason(response.error_Message, response.field9) : {}),
    raw: response,
  };
}

function mandateSubscription(
  method: PayUMandateMethod,
  mandateId: string,
  fields: { status: string; ceiling?: string | number | null; end?: string | null; start?: string | null },
  raw: unknown,
): Subscription {
  const ceiling = rupeesToPaise(fields.ceiling);
  const startAt = parsePayUDate(fields.start);
  const mandateEndsAt = parsePayUDate(fields.end);
  return {
    provider: PROVIDER,
    id: encodeSubscriptionId({ method, mandateId }),
    status: mapMandateStatus(method, fields.status),
    providerStatus: fields.status,
    scheduling: SchedulingMode.Merchant,
    ...(ceiling !== undefined ? { maxAmount: ceiling } : {}),
    ...(startAt !== undefined ? { startAt } : {}),
    ...(mandateEndsAt !== undefined ? { mandateEndsAt } : {}),
    paymentMethod: method,
    raw,
  };
}

/** A card mandate webhook the signature of which has been verified. */
export function mapCardMandateWebhook(body: PayUCardMandateWebhook): SubscriptionEvent {
  const mandateId = pickAuthPayuId(body.authPayuId, body.authpayuid, body.authpayuId);
  const type = lookup<EventType>(EVENT_BY_MANDATE_NOTIFICATION, body.notificationType) ?? EventType.Unknown;
  const details = body.si_details;
  const subscription =
    mandateId !== undefined
      ? mandateSubscription(
          PaymentMethod.Card,
          mandateId,
          { status: body.status, ceiling: details?.billingAmount, start: details?.paymentStartDate, end: details?.paymentEndDate },
          body,
        )
      : undefined;
  const occurredAt = parsePayUDate(body.eventDate);
  return baseEvent(
    `${mandateId ?? WEBHOOK_UNKNOWN_ID}:${body.notificationType}:${body.eventDate ?? ''}`,
    type,
    body.notificationType,
    body,
    {
      ...(occurredAt !== undefined ? { occurredAt } : {}),
      ...(subscription ? { subscriptionId: subscription.id, subscription } : {}),
    },
  );
}

/** A UPI mandate webhook the signature of which has been verified. */
export function mapUpiMandateWebhook(body: PayUUpiMandateWebhook): SubscriptionEvent {
  const mandateId = pickAuthPayuId(body.authpayuid, body.authPayuId);
  const type = lookup<EventType>(EVENT_BY_UPI_ACTION, body.action) ?? EventType.Unknown;
  const subscription =
    mandateId !== undefined
      ? mandateSubscription(
          PaymentMethod.Upi,
          mandateId,
          { status: body.status, ceiling: body.amount, end: body.endDate },
          body,
        )
      : undefined;
  const occurredAt = parsePayUDate(body.dateTime);
  return baseEvent(`${mandateId ?? WEBHOOK_UNKNOWN_ID}:${body.action}:${body.dateTime ?? ''}`, type, body.action, body, {
    ...(occurredAt !== undefined ? { occurredAt } : {}),
    ...(subscription ? { subscriptionId: subscription.id, subscription } : {}),
  });
}

/**
 * The eNACH cancellation webhook. PayU documents no signature for it, so it is
 * only a `subscription.cancelled` event when the caller opted in; otherwise it
 * is `unknown` and changes no billing state.
 */
export function mapEnachCancellationWebhook(body: PayUEnachCancellationWebhook, trusted: boolean): SubscriptionEvent {
  const mandateId = pickAuthPayuId(body.authPayuId, body.authpayuid, body.authPayuid);
  const cancelled =
    normalizeKey(body.status) === normalizeKey(PAYU_ENACH_CANCELLATION_STATUS) &&
    normalizeKey(body.notificationType) === normalizeKey(PAYU_ENACH_CANCELLATION_NOTIFICATION);
  const subscription =
    mandateId !== undefined ? mandateSubscription(PaymentMethod.ENach, mandateId, { status: body.status }, body) : undefined;
  return baseEvent(
    `${mandateId ?? WEBHOOK_UNKNOWN_ID}:${body.notificationType}:${body.status}`,
    trusted && cancelled ? EventType.SubscriptionCancelled : EventType.Unknown,
    body.notificationType,
    body,
    subscription ? { subscriptionId: subscription.id, subscription } : {},
  );
}

/** The refund callback. Unsigned, so only a `refund.*` event when the caller opted in. */
export function mapRefundWebhook(body: PayURefundWebhook, trusted: boolean): SubscriptionEvent {
  const requestId = present(body.request_id) ?? present(body.token) ?? WEBHOOK_UNKNOWN_ID;
  const chargeId = present(body.mihpayid) ?? present(body.merchantTxnId) ?? WEBHOOK_UNKNOWN_ID;
  const success = normalizeKey(body.status) === PayUWebhookRefundStatus.Success;
  const failure = normalizeKey(body.status) === PayUWebhookRefundStatus.Failure;
  const paise = rupeesToPaise(body.amt);
  const refund: Refund | undefined =
    success || failure
      ? {
          provider: PROVIDER,
          id: requestId,
          ...(present(body.token) !== undefined ? { reference: present(body.token) as string } : {}),
          chargeId,
          status: success ? RefundStatus.Succeeded : RefundStatus.Failed,
          providerStatus: body.status,
          amount: paise ?? 0,
          currency: Currency.INR,
          raw: body,
        }
      : undefined;
  const type = trusted && refund ? (success ? EventType.RefundSucceeded : EventType.RefundFailed) : EventType.Unknown;
  return baseEvent(`${requestId}:${normalizeKey(body.status)}`, type, body.action, body, refund && trusted ? { refund } : {});
}
