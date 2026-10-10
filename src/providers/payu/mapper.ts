import {
  ChargeKind,
  ChargeStatus,
  Currency,
  ErrorCode,
  EventType,
  PaymentMethod,
  PaymentStatus,
  Provider,
  RefundStatus,
  SchedulingMode,
  IntervalUnit,
  SubscriptionStatus,
} from '../../constants.js';
import { SubscriptionError, invalid, unsupported } from '../../errors.js';
import { paiseToRupeeString, rupeesToPaise } from '../../money.js';
import { CustomerSchema, MetadataSchema } from '../../schemas.js';
import type {
  BillingInterval,
  Charge,
  ChargeNotification,
  Metadata,
  Payment,
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
  ENFORCE_PAYMETHOD_BY_METHOD,
  ENFORCE_PAYMETHOD_SEPARATOR,
  EVENT_BY_MANDATE_NOTIFICATION,
  EVENT_BY_UPI_ACTION,
  FIRSTNAME_MAX_LENGTH,
  INDIAN_MOBILE_DIGITS,
  INDIA_COUNTRY_CODE,
  IST_OFFSET_SUFFIX,
  IST_TIMESTAMP_PATTERN,
  MANDATE_END_GRACE_DAYS,
  MANDATE_ID_PATTERN,
  ONE_TIME_METHOD_BY_MODE,
  ONE_TIME_METHOD_BY_PG_TYPE,
  PAYMENT_METHOD_BY_MODE,
  PAYMENT_METHOD_BY_PG_TYPE,
  PAYMENT_REFUND_TOKEN_PREFIX,
  PAYMENT_STATUS_BY_STATE,
  PAYU_BILLING_CURRENCY,
  PAYU_DISALLOWED_EMAIL_CHARS,
  PAYU_DISALLOWED_TEXT_CHARS,
  PAYU_ENACH_CANCELLATION_NOTIFICATION,
  PAYU_ENACH_CANCELLATION_STATUS,
  PAYU_FAILED_STATUS_VALUES,
  PAYU_FREE_TRIAL_CONSENT_PAISE,
  PAYU_MANDATE_METHODS,
  PAYU_NONE_FETCHED_PATTERN,
  PAYU_NO_ACTION_STATUS,
  PAYU_NO_ERROR_CODE,
  PAYU_NO_ERROR_MESSAGE,
  PAYU_NOT_FOUND,
  PAYU_ONE_TIME_METHODS,
  PAYU_REFUND_ENTRY_ACTION,
  PAYU_STATUS_OK,
  PRODUCTINFO_MAX_LENGTH,
  PayUPaymentSource,
  PayUPaymentStatus,
  PayUPaymentWebhookEvent,
  PayUPgType,
  PayUPreDebitCode,
  PayURefundCode,
  PayUWebhookRefundStatus,
  PAYU_ONE_TIME_MARKER,
  REFUND_CAPTURED_TODAY_PATTERN,
  REFUND_ERROR_CODES,
  REFUND_REMARKS_DISALLOWED_CHARS,
  REFUND_ACTION_COUNTS,
  REFUND_REMARKS_MAX_LENGTH,
  SUBSCRIPTION_ID_SEPARATOR,
  UDF_MAX_LENGTH,
  UNKNOWN_CHARGE_STATUS,
  UNKNOWN_MANDATE_STATUS,
  UNKNOWN_PAYMENT_STATUS,
  UPI_MANDATE_STATUS,
  WEBHOOK_UNKNOWN_ID,
  type PayUMandateMethod,
} from './constants.js';
import type {
  PayUCardMandateWebhook,
  PayUDebitDetail,
  PayUEnachCancellationWebhook,
  PayUActionStatusResponse,
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
 * An e-mail address cannot be silently cleaned: PayU could drop a character and mail a different mailbox. A character
 * the docs say PayU strips is a `VALIDATION` error instead. `+` is allowed: PayU's test environment keeps it verbatim.
 */
export function checkEmail(value: string, maxLength: number): string {
  if (value.length > maxLength) throw invalid(`customer.email is longer than the ${maxLength} characters PayU accepts`, PROVIDER);
  if (value.replace(PAYU_DISALLOWED_EMAIL_CHARS, '') !== value) {
    throw invalid(
      'customer.email contains a character PayU strips from e-mail addresses (only letters, digits and - _ @ / . + are kept); use an address without it',
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
  const { value, providerStatus } = mapState(CHARGE_STATUS_BY_STATE, UNKNOWN_CHARGE_STATUS, candidates);
  return { status: value, ...(providerStatus !== undefined ? { providerStatus } : {}) };
}

/** The first candidate that is in the table wins; blanks are ignored; none in the table gives the fallback. `providerStatus` is the first non-blank state. */
function mapState<V>(
  table: Record<string, V>,
  fallback: V,
  candidates: readonly (string | null | undefined)[],
): { value: V; providerStatus?: string } {
  let verbatim: string | undefined;
  for (const candidate of candidates) {
    const state = present(candidate);
    if (state === undefined) continue;
    verbatim ??= state;
    const mapped = lookup(table, state);
    if (mapped !== undefined) return { value: mapped, providerStatus: verbatim };
  }
  return { value: fallback, ...(verbatim !== undefined ? { providerStatus: verbatim } : {}) };
}

export interface MappedPaymentStatus {
  status: PaymentStatus;
  /** The first non-blank PayU state, verbatim. */
  providerStatus?: string;
}

/**
 * Translates PayU's transaction state for a one-time payment: the first candidate (`unmappedstatus`, then `status`) that is in
 * `PAYMENT_STATUS_BY_STATE` wins; a state that is not in the table is `pending`.
 */
export function mapPaymentStatus(...candidates: (string | null | undefined)[]): MappedPaymentStatus {
  const { value, providerStatus } = mapState(PAYMENT_STATUS_BY_STATE, UNKNOWN_PAYMENT_STATUS, candidates);
  return { status: value, ...(providerStatus !== undefined ? { providerStatus } : {}) };
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
// One-time payments
// ---------------------------------------------------------------------------

/**
 * `productinfo` for a payment: the description with the characters PayU removes taken out, or the default text. A description that
 * does not fit PayU's 100 characters is refused rather than cut.
 */
export function paymentProductInfo(description: string | undefined, fallback: string): string {
  if (description === undefined) return fallback;
  const cleaned = sanitizePayUText(description, Number.POSITIVE_INFINITY, 'description (sent as productinfo)');
  if (cleaned.length > PRODUCTINFO_MAX_LENGTH) {
    throw invalid(
      `description is longer than the ${PRODUCTINFO_MAX_LENGTH} characters PayU accepts for productinfo (${cleaned.length} after the characters PayU removes are taken out)`,
      PROVIDER,
    );
  }
  return cleaned;
}

/**
 * `enforce_paymethod` for the requested methods, or `undefined` when the caller restricts nothing. A method PayU's hosted checkout
 * cannot take (mandate methods) is refused: the restriction would not hold.
 */
export function enforcePaymethod(methods: readonly PaymentMethod[] | undefined): string | undefined {
  if (methods === undefined) return undefined;
  const refused = methods.filter((method) => !PAYU_ONE_TIME_METHODS.includes(method));
  if (refused.length > 0) {
    throw invalid(
      `PayU takes ${PAYU_ONE_TIME_METHODS.join(', ')} for a one-time payment; paymentMethods contains ${refused.join(', ')}`,
      PROVIDER,
    );
  }
  const values = methods.flatMap((method) => ENFORCE_PAYMETHOD_BY_METHOD[method] ?? []);
  return [...new Set(values)].join(ENFORCE_PAYMETHOD_SEPARATOR);
}

/**
 * Metadata travels in `udf1` as base64url of its JSON: that alphabet is inside the characters PayU keeps, and `udf1` comes back in
 * the response, the verify API and the webhook. Refused when it does not fit PayU's 255 characters.
 */
export function encodeMetadata(metadata: Metadata): string {
  const encoded = Buffer.from(JSON.stringify(metadata), 'utf8').toString('base64url');
  if (encoded.length > UDF_MAX_LENGTH) {
    throw invalid(
      `metadata is too large: PayU stores at most ${UDF_MAX_LENGTH} characters in a user-defined field and the metadata takes ${encoded.length} once encoded`,
      PROVIDER,
    );
  }
  return encoded;
}

/** The metadata `encodeMetadata` wrote, or `undefined` when `udf1` holds something else. */
export function decodeMetadata(udf1: string | null | undefined): Metadata | undefined {
  const text = present(udf1);
  if (text === undefined) return undefined;
  try {
    const parsed = MetadataSchema.safeParse(JSON.parse(Buffer.from(text, 'base64url').toString('utf8')));
    return parsed.success && Object.keys(parsed.data).length > 0 ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The unified payment method of a one-time payment: `mode`, else `PG_TYPE`. Modes with no unified method give `undefined`. */
export function oneTimeMethodOf(response: { mode?: string | null; PG_TYPE?: string | null }): PaymentMethod | undefined {
  return lookup(ONE_TIME_METHOD_BY_MODE, response.mode) ?? lookup(ONE_TIME_METHOD_BY_PG_TYPE, response.PG_TYPE);
}

/** True for a result that belongs to a mandate: the registration (`sist`) or a recurring debit (`sirecurring`, `SI-PG`). */
export function isMandateResult(response: { payment_source?: string | null; PG_TYPE?: string | null }): boolean {
  const source = normalizeKey(response.payment_source ?? '');
  return (
    source === PayUPaymentSource.MandateRegistered ||
    source === PayUPaymentSource.RecurringDebit ||
    normalizeKey(response.PG_TYPE ?? '') === normalizeKey(PayUPgType.StandingInstruction)
  );
}

/** True when the payment carries the marker this adapter puts in `udf5`. */
export function isOneTimePayment(udf5: string | null | undefined): boolean {
  return present(udf5) === PAYU_ONE_TIME_MARKER;
}

/** What a payment is built from: the fields PayU posts to `surl` / `furl` and the webhook, or a `verify_payment` transaction. */
export interface PaymentSource {
  txnid: string;
  mihpayid?: string | null;
  status?: string | null;
  unmappedstatus?: string | null;
  amountPaise: number;
  mode?: string | null;
  PG_TYPE?: string | null;
  addedon?: string | null;
  success_at?: string | null;
  error?: string | null;
  error_Message?: string | null;
  field9?: string | null;
  udf1?: string | null;
  firstname?: string | null;
  email?: string | null;
  phone?: string | null;
  refundedPaise?: number;
}

/**
 * The customer PayU echoes, field by field and only what is a valid unified value (PayU masks the phone in webhooks).
 * `firstname` is the text this adapter sent.
 */
function customerOf(source: PaymentSource): Payment['customer'] {
  const candidate = { name: present(source.firstname), email: present(source.email), phone: present(source.phone) };
  const customer: NonNullable<Payment['customer']> = {};
  for (const field of ['name', 'email', 'phone'] as const) {
    const value = candidate[field];
    if (value !== undefined && CustomerSchema.shape[field].safeParse(value).success) customer[field] = value;
  }
  return Object.keys(customer).length > 0 ? customer : undefined;
}

/**
 * A PayU transaction as a Payment. `id` and `reference` are the txnid. The outcome follows PayU's rule ("treat only `success` as
 * successful"): a state that says captured next to a `status` that is not `success` is `pending`, never `succeeded`. A succeeded
 * payment with accepted refunds is `partially_refunded` or `refunded`.
 */
export function mapPayment(source: PaymentSource, raw: unknown): Payment {
  const mapped = mapPaymentStatus(source.unmappedstatus, source.status);
  const statusIsSuccess = normalizeKey(source.status ?? '') === PayUPaymentStatus.Success;
  let status = mapped.status === PaymentStatus.Succeeded && !statusIsSuccess ? PaymentStatus.Pending : mapped.status;
  const refunded = source.refundedPaise ?? 0;
  if (status === PaymentStatus.Succeeded && refunded > 0) {
    status = refunded >= source.amountPaise ? PaymentStatus.Refunded : PaymentStatus.PartiallyRefunded;
  }
  const failed = status === PaymentStatus.Failed || status === PaymentStatus.Cancelled;
  const code = present(source.error);
  const method = oneTimeMethodOf(source);
  const createdAt = parsePayUDate(source.addedon);
  const paidAt = status === PaymentStatus.Succeeded ? parsePayUDate(source.success_at) ?? createdAt : undefined;
  const metadata = decodeMetadata(source.udf1);
  const customer = customerOf(source);
  return {
    provider: PROVIDER,
    id: source.txnid,
    reference: source.txnid,
    status,
    providerStatus: mapped.providerStatus ?? present(source.status) ?? '',
    amount: source.amountPaise,
    currency: Currency.INR,
    ...(refunded > 0 ? { refundedAmount: refunded } : {}),
    ...(method !== undefined ? { paymentMethod: method } : {}),
    ...(customer !== undefined ? { customer } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(paidAt !== undefined ? { paidAt } : {}),
    ...(failed && code !== undefined && code !== PAYU_NO_ERROR_CODE ? { failureCode: code } : {}),
    ...(failed ? failureReason(source.error_Message, source.field9) : {}),
    ...(metadata !== undefined ? { metadata } : {}),
    raw,
  };
}

/** The payment source of the fields PayU posts to `surl` / `furl` and to the payment webhook. */
export function paymentSourceFromResponse(response: PayUPaymentResponse): PaymentSource {
  return {
    txnid: response.txnid,
    mihpayid: response.mihpayid,
    status: response.status,
    unmappedstatus: response.unmappedstatus,
    amountPaise: amountPaise(response.amount, 'a payment amount'),
    mode: response.mode,
    PG_TYPE: response.PG_TYPE,
    addedon: response.addedon,
    success_at: response.success_at,
    error: response.error,
    error_Message: response.error_Message,
    field9: response.field9,
    udf1: response.udf1,
    firstname: response.firstname,
    email: response.email,
    phone: response.phone,
  };
}

/** The payment source of a `verify_payment` transaction. `transaction_amount` is read first, as for debits. */
export function paymentSourceFromTransaction(tx: PayUVerifiedTransaction, txnid: string, refundedPaise?: number): PaymentSource {
  const amount = rupeesToPaise(tx.transaction_amount) ?? rupeesToPaise(tx.amt) ?? rupeesToPaise(tx.net_amount_debit);
  if (amount === undefined) {
    throw new SubscriptionError(ErrorCode.UnexpectedResponse, `payu returned transaction ${txnid} without an amount`, {
      provider: PROVIDER,
      raw: tx,
    });
  }
  return {
    txnid,
    mihpayid: tx.mihpayid,
    status: tx.status,
    unmappedstatus: tx.unmappedstatus,
    amountPaise: amount,
    mode: tx.mode,
    PG_TYPE: tx.PG_TYPE,
    addedon: tx.addedon,
    success_at: tx.success_at,
    error: tx.error_code,
    error_Message: tx.error_Message,
    field9: tx.field9,
    udf1: tx.udf1,
    firstname: tx.firstname,
    email: tx.email,
    phone: tx.phone,
    ...(refundedPaise !== undefined ? { refundedPaise } : {}),
  };
}

/**
 * What `check_action_status` says has been refunded: the sum of the refund entries in a state that counts (see
 * `REFUND_ACTION_COUNTS`). An id PayU holds no action for answers with a text instead of entries: nothing refunded.
 */
export function refundedPaiseOf(body: PayUActionStatusResponse): number {
  let total = 0;
  for (const entries of Object.values(body.transaction_details ?? {})) {
    if (typeof entries === 'string') {
      if (entries !== PAYU_NO_ACTION_STATUS) {
        throw new SubscriptionError(ErrorCode.UnexpectedResponse, `payu answered the refund lookup with "${entries.slice(0, 80)}"`, {
          provider: PROVIDER,
          raw: body,
        });
      }
      continue;
    }
    for (const entry of Object.values(entries)) {
      if (normalizeKey(entry.action ?? '') !== PAYU_REFUND_ENTRY_ACTION) continue;
      if (lookup(REFUND_ACTION_COUNTS, entry.status) !== true) continue;
      total += rupeesToPaise(entry.amt) ?? 0;
    }
  }
  return total;
}

/** `expiresAt` is refused: PayU's hosted checkout takes no expiry. */
export function unsupportedExpiry(): SubscriptionError {
  return unsupported(PROVIDER, 'expiresAt', 'PayU hosted checkout has no parameter that ends a payment at a time');
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
const NUMERIC_STATUS = /^\d+$/;

/** A numeric envelope `status` other than 0 / 1 (PayU's own refund error code), as text. */
function statusAsRefundCode(status: string | number | null | undefined): string | undefined {
  if (status === null || status === undefined) return undefined;
  const text = String(status).trim();
  const isEnvelopeStatus = text === String(PAYU_STATUS_OK) || PAYU_FAILED_STATUS_VALUES.some((value) => String(value) === text);
  return NUMERIC_STATUS.test(text) && !isEnvelopeStatus ? text : undefined;
}

export function mapRefundResponse(input: {
  body: PayURefundResponse;
  chargeId: string;
  refundToken: string;
  amountPaise: number;
  subscriptionId?: string;
  /** Your own refund id when it differs from the token sent (a payment refund token carries a prefix). */
  reference?: string;
  /** Set for a refund of a one-time payment. */
  paymentId?: string;
}): { refund: Refund } | { failure: BodyFailure } {
  const { body } = input;
  const message = envelopeMessage(body);
  const ok = body.status !== null && body.status !== undefined && String(body.status) === String(PAYU_STATUS_OK);
  // PayU's test environment puts the refund error code in `status` itself (`{"status":236,"msg":"..."}`), with no
  // `error_code`, where the docs promise `status` 0 / 1 and `error_code`.
  const code = present(body.error_code) ?? statusAsRefundCode(body.status);

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
    reference: input.reference ?? input.refundToken,
    chargeId: input.chargeId,
    ...(input.paymentId !== undefined ? { paymentId: input.paymentId } : {}),
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

/** A payment webhook (form-encoded): the consent result, a recurring debit or a one-time payment. */
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

  // A payment this adapter created carries the marker in `udf5`, which the verified hash covers.
  if (isOneTimePayment(response.udf5)) {
    const payment = mapPayment(paymentSourceFromResponse(response), response);
    const common = { ...when, paymentId: payment.id, payment };
    if (payment.status === PaymentStatus.Succeeded) return baseEvent(id, EventType.PaymentSucceeded, eventName, response, common);
    if (payment.status === PaymentStatus.Failed || payment.status === PaymentStatus.Cancelled) {
      return baseEvent(id, EventType.PaymentFailed, eventName, response, common);
    }
    return baseEvent(id, EventType.Unknown, eventName, response, common);
  }

  // Any other payment, or a failed consent (PayU marks a failed consent `payu`, like any failed payment).
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

/**
 * The refund callback. Unsigned, so only a `refund.*` event when the caller opted in. A refund whose `token` has the prefix
 * `refundPayment` puts on it is a refund of a one-time payment: its `merchantTxnId` is the payment id, the refund carries it as
 * `chargeId` and `paymentId`, and the reference is the token without the prefix.
 */
export function mapRefundWebhook(body: PayURefundWebhook, trusted: boolean): SubscriptionEvent {
  const requestId = present(body.request_id) ?? present(body.token) ?? WEBHOOK_UNKNOWN_ID;
  const token = present(body.token);
  const paymentId = token?.startsWith(PAYMENT_REFUND_TOKEN_PREFIX) ? present(body.merchantTxnId) : undefined;
  const chargeId = paymentId ?? present(body.mihpayid) ?? present(body.merchantTxnId) ?? WEBHOOK_UNKNOWN_ID;
  const reference = paymentId !== undefined ? token?.slice(PAYMENT_REFUND_TOKEN_PREFIX.length) : token;
  const success = normalizeKey(body.status) === PayUWebhookRefundStatus.Success;
  const failure = normalizeKey(body.status) === PayUWebhookRefundStatus.Failure;
  const paise = rupeesToPaise(body.amt);
  const refund: Refund | undefined =
    success || failure
      ? {
          provider: PROVIDER,
          id: requestId,
          ...(reference !== undefined && reference !== '' ? { reference } : {}),
          chargeId,
          ...(paymentId !== undefined ? { paymentId } : {}),
          status: success ? RefundStatus.Succeeded : RefundStatus.Failed,
          providerStatus: body.status,
          amount: paise ?? 0,
          currency: Currency.INR,
          raw: body,
        }
      : undefined;
  const type = trusted && refund ? (success ? EventType.RefundSucceeded : EventType.RefundFailed) : EventType.Unknown;
  const attached = refund && trusted ? { refund, ...(paymentId !== undefined ? { paymentId } : {}) } : {};
  return baseEvent(`${requestId}:${normalizeKey(body.status)}`, type, body.action, body, attached);
}
