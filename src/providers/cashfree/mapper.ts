import {
  ChargeKind,
  ChargeStatus,
  CheckoutKind,
  Currency,
  DigestEncoding,
  ErrorCode,
  EventType,
  HashAlgorithm,
  PaymentMethod,
  PaymentStatus,
  ProductKind,
  Provider,
  RefundStatus,
  SchedulingMode,
  SubscriptionStatus,
  type Environment,
} from '../../constants.js';
import { hash } from '../../crypto.js';
import { SubscriptionError, parseResponse } from '../../errors.js';
import { rupeesToPaise } from '../../money.js';
import type {
  BillingInterval,
  Charge,
  CheckoutInstruction,
  Customer,
  Metadata,
  Payment,
  Plan,
  Refund,
  Subscription,
  SubscriptionEvent,
} from '../../schemas.js';
import { fromIstDateString, isoOrUndefined, parseIso, toIso } from '../../time.js';
import {
  ATTEMPT_STATUS_MAP,
  CASHFREE_TO_INTERVAL_UNIT,
  CashfreeAuthorizationStatus,
  CashfreeOrderWebhookEvent,
  CashfreePaymentStatus,
  CashfreePlanType,
  CashfreeWebhookEvent,
  EVENT_ID_HASH_LENGTH,
  METHOD_TO_PAYMENT_METHOD,
  ORDER_PAYMENT_EVENT_MAP,
  ORDER_REFUND_EVENT_MAP,
  ORDER_REFUND_STATUS_MAP,
  ORDER_STATUS_MAP,
  PAYMENT_GROUP_TO_METHOD,
  PAYMENT_METHOD_KEY_TO_METHOD,
  PAYMENT_STATUS_MAP,
  PAYMENT_TYPE_MAP,
  REFUND_STATUS_MAP,
  CashfreeRefundStatus,
  STATUS_EVENT_MAP,
  SUBSCRIPTION_STATUS_MAP,
  UNKNOWN_ATTEMPT_STATUS_FALLBACK,
  UNKNOWN_ORDER_REFUND_STATUS_FALLBACK,
  UNKNOWN_ORDER_STATUS_FALLBACK,
  UNKNOWN_PAYMENT_STATUS_FALLBACK,
  UNKNOWN_PAYMENT_TYPE_FALLBACK,
  UNKNOWN_REFUND_STATUS_FALLBACK,
  UNKNOWN_SUBSCRIPTION_STATUS_FALLBACK,
} from './constants.js';
import {
  CashfreeLooseEventDataSchema,
  CashfreeOrderPaymentWebhookDataSchema,
  CashfreeOrderRefundWebhookDataSchema,
  CashfreePaymentWebhookDataSchema,
  CashfreeRefundWebhookDataSchema,
  CashfreeStatusWebhookDataSchema,
  type CashfreeAuthorizationDetails,
  type CashfreeEmbeddedPlan,
  type CashfreeOrder,
  type CashfreeOrderPayment,
  type CashfreeOrderPaymentWebhookData,
  type CashfreeOrderRefund,
  type CashfreePayment,
  type CashfreePlan,
  type CashfreeRefund,
  type CashfreeSubscription,
  type CashfreeWebhookEnvelope,
} from './schemas.js';

/**
 * Pure translation from Cashfree payloads to the unified model. Amounts are
 * rupees on Cashfree's side and paise on ours (`rupeesToPaise`); timestamps
 * are IST unless they carry an offset.
 */

const PROVIDER = Provider.Cashfree;
const EVENT_ID_SEPARATOR = ':';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Own-property lookup that is safe for keys such as "constructor". */
function lookup<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** Cashfree status and method strings are matched case-insensitively; the original stays in `providerStatus`. */
function normaliseKey(value: string): string {
  return value.trim().toUpperCase();
}

function nonEmpty(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

const UTC_OR_OFFSET = /(?:Z|[+-]\d{2}:\d{2})$/i;
const OFFSET_WITHOUT_COLON = /([+-])(\d{2})(\d{2})$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const IST_OFFSET = '+05:30';

/**
 * Parses a Cashfree timestamp. Cashfree "stores timestamps in IST", and its
 * responses are not uniform: `2025-06-01T23:47:52+05:30`, `2025-06-01T16:45:00`
 * (no offset, IST), `2025-06-01T22:14:58+0530` (no colon) and `2024-07-20`
 * (date only) all appear in its own samples. A bare `new Date()` would read
 * the offset-less forms in the server's timezone, so they are normalised first.
 */
export function parseCashfreeTime(value: unknown): Date | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') return undefined;
  if (DATE_ONLY.test(text)) return fromIstDateString(text);
  let normalised = text;
  if (!UTC_OR_OFFSET.test(normalised)) {
    normalised = OFFSET_WITHOUT_COLON.test(normalised)
      ? normalised.replace(OFFSET_WITHOUT_COLON, '$1$2:$3')
      : `${normalised}${IST_OFFSET}`;
  }
  return parseIso(normalised);
}

function isoOf(value: unknown): string | undefined {
  return isoOrUndefined(parseCashfreeTime(value));
}

/** A rupee amount that the response schema already validated, as paise. */
function requirePaise(value: unknown, field: string): number {
  const paise = rupeesToPaise(value);
  if (paise === undefined || paise < 0) {
    throw new SubscriptionError(ErrorCode.UnexpectedResponse, `${PROVIDER} returned ${field} that is not a rupee amount`, {
      provider: PROVIDER,
    });
  }
  return paise;
}

function optionalPaise(value: unknown): number | undefined {
  const paise = rupeesToPaise(value);
  return paise !== undefined && paise >= 0 ? paise : undefined;
}

// ---------------------------------------------------------------------------
// Status and enum translation
// ---------------------------------------------------------------------------

/** Unknown statuses fall back to `Created` (non-charging); see `UNKNOWN_SUBSCRIPTION_STATUS_FALLBACK`. */
export function mapSubscriptionStatus(status: string): SubscriptionStatus {
  return lookup(SUBSCRIPTION_STATUS_MAP, normaliseKey(status)) ?? UNKNOWN_SUBSCRIPTION_STATUS_FALLBACK;
}

/** Unknown statuses fall back to `Pending`; see `UNKNOWN_PAYMENT_STATUS_FALLBACK`. */
export function mapPaymentStatus(status: string): ChargeStatus {
  return lookup(PAYMENT_STATUS_MAP, normaliseKey(status)) ?? UNKNOWN_PAYMENT_STATUS_FALLBACK;
}

export function mapRefundStatus(status: string) {
  return lookup(REFUND_STATUS_MAP, normaliseKey(status)) ?? UNKNOWN_REFUND_STATUS_FALLBACK;
}

export function mapPaymentMethod(method: string | null | undefined) {
  const key = nonEmpty(method);
  return key === undefined ? undefined : lookup(METHOD_TO_PAYMENT_METHOD, key.toLowerCase());
}

/** The authorisation block, under whichever spelling Cashfree used. */
export function authorizationOf(entity: {
  authorization_details?: CashfreeAuthorizationDetails | null;
  authorisation_details?: CashfreeAuthorizationDetails | null;
}): CashfreeAuthorizationDetails | undefined {
  return entity.authorization_details ?? entity.authorisation_details ?? undefined;
}

/** `payment_method` is an object keyed by method (spec) or a plain string (older samples); `payment_group` is the fallback. */
function methodOfAuthorization(auth: CashfreeAuthorizationDetails | undefined) {
  if (!auth) return undefined;
  const method = auth.payment_method ?? auth.paymentMethod;
  if (typeof method === 'string') return mapPaymentMethod(method);
  if (method && typeof method === 'object') {
    for (const key of Object.keys(method)) {
      const mapped = mapPaymentMethod(key);
      if (mapped) return mapped;
    }
  }
  return mapPaymentMethod(auth.payment_group);
}

export function schedulingOfPlanType(planType: string | null | undefined): SchedulingMode {
  return planType !== null && planType !== undefined && normaliseKey(planType) === CashfreePlanType.OnDemand
    ? SchedulingMode.Merchant
    : SchedulingMode.Gateway;
}

function intervalOfPlan(plan: CashfreeEmbeddedPlan | undefined): BillingInterval | undefined {
  const type = nonEmpty(plan?.plan_interval_type);
  if (type === undefined) return undefined;
  const unit = lookup(CASHFREE_TO_INTERVAL_UNIT, normaliseKey(type));
  if (unit === undefined) return undefined;
  const count = plan?.plan_intervals;
  // "The default value is 1" for plan_intervals [openapi].
  return { unit, count: typeof count === 'number' && Number.isInteger(count) && count > 0 ? count : 1 };
}

function positiveInt(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function currencyOf(value: string | null | undefined) {
  const text = nonEmpty(value);
  return text !== undefined && text.toUpperCase() === Currency.INR ? Currency.INR : undefined;
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export interface PlanOverrides {
  /** Cashfree stores no recurring amount for ON_DEMAND plans; a create call can echo what the caller asked for. */
  amount?: number;
  interval?: BillingInterval;
}

/**
 * `amount` is the recurring amount Cashfree stores: 0 for an ON_DEMAND plan
 * (nothing is billed automatically), with the ceiling in `maxAmount`.
 */
export function mapPlan(plan: CashfreePlan, overrides: PlanOverrides = {}): Plan {
  const scheduling = schedulingOfPlanType(plan.plan_type);
  const recurring = scheduling === SchedulingMode.Gateway ? optionalPaise(plan.plan_recurring_amount) : undefined;
  const maxAmount = optionalPaise(plan.plan_max_amount);
  return {
    provider: PROVIDER,
    id: plan.plan_id,
    name: nonEmpty(plan.plan_name) ?? plan.plan_id,
    description: nonEmpty(plan.plan_note),
    amount: overrides.amount ?? recurring ?? 0,
    currency: currencyOf(plan.plan_currency) ?? Currency.INR,
    interval: overrides.interval ?? (scheduling === SchedulingMode.Gateway ? intervalOfPlan(plan) : undefined),
    scheduling,
    maxAmount,
    maxCycles: positiveInt(plan.plan_max_cycles),
    providerStatus: nonEmpty(plan.plan_status),
    raw: plan,
  };
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export function checkoutOf(
  entity: { subscription_session_id?: string | null },
  environment: Environment,
): CheckoutInstruction | undefined {
  const sessionId = nonEmpty(entity.subscription_session_id);
  return sessionId === undefined ? undefined : { kind: CheckoutKind.CashfreeCheckout, sessionId, environment };
}

export interface SubscriptionOverrides {
  /** Merchant-scheduled subscriptions: an ON_DEMAND plan has no amount or interval, so the create call supplies them. */
  amount?: number;
  interval?: BillingInterval;
  totalCycles?: number;
  /** First charge instant when Cashfree does not hold it (merchant scheduling). */
  startAt?: Date;
  customer?: Customer;
  metadata?: Metadata;
  reference?: string;
}

export interface MapSubscriptionOptions {
  now: Date;
  checkout?: CheckoutInstruction;
  overrides?: SubscriptionOverrides;
}

function customerOf(entity: CashfreeSubscription): Customer | undefined {
  const details = entity.customer_details;
  if (!details) return undefined;
  const customer: Customer = {};
  const name = nonEmpty(details.customer_name);
  const email = nonEmpty(details.customer_email);
  const phone = nonEmpty(details.customer_phone);
  if (name) customer.name = name;
  if (email) customer.email = email;
  if (phone) customer.phone = phone;
  return Object.keys(customer).length > 0 ? customer : undefined;
}

function metadataOf(tags: Record<string, unknown> | null | undefined): Metadata | undefined {
  if (!tags) return undefined;
  const metadata: Metadata = {};
  for (const [key, value] of Object.entries(tags)) {
    if (typeof value === 'string') metadata[key] = value;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/**
 * `ACTIVE` becomes `Trialing` while `subscription_first_charge_time` is still
 * in the future (a free trial or delayed start on a PERIODIC plan; ON_DEMAND
 * subscriptions have no first-charge time on Cashfree's side).
 */
export function mapSubscription(entity: CashfreeSubscription, options: MapSubscriptionOptions): Subscription {
  const { now, checkout, overrides = {} } = options;
  const plan = entity.plan_details ?? undefined;
  const scheduling = schedulingOfPlanType(plan?.plan_type);
  const auth = authorizationOf(entity);

  let status = mapSubscriptionStatus(entity.subscription_status);
  const firstChargeAt = parseCashfreeTime(entity.subscription_first_charge_time);
  let trialEndsAt: string | undefined;
  if (
    status === SubscriptionStatus.Active &&
    scheduling === SchedulingMode.Gateway &&
    firstChargeAt !== undefined &&
    firstChargeAt.getTime() > now.getTime()
  ) {
    status = SubscriptionStatus.Trialing;
    trialEndsAt = toIso(firstChargeAt);
  }

  const isPeriodic = scheduling === SchedulingMode.Gateway;
  const startAt = firstChargeAt ?? overrides.startAt;
  const expiresAt = parseCashfreeTime(entity.subscription_expiry_time);

  return {
    provider: PROVIDER,
    id: entity.subscription_id,
    reference: overrides.reference ?? entity.subscription_id,
    planId: nonEmpty(plan?.plan_id),
    status,
    providerStatus: entity.subscription_status,
    scheduling,
    customer: overrides.customer ?? customerOf(entity),
    amount: overrides.amount ?? (isPeriodic ? optionalPaise(plan?.plan_recurring_amount) : undefined),
    maxAmount: optionalPaise(plan?.plan_max_amount),
    currency: currencyOf(plan?.plan_currency),
    interval: overrides.interval ?? (isPeriodic ? intervalOfPlan(plan) : undefined),
    totalCycles: overrides.totalCycles ?? positiveInt(plan?.plan_max_cycles),
    startAt: isoOrUndefined(startAt),
    trialEndsAt,
    nextChargeAt: isoOf(entity.next_schedule_date),
    mandateEndsAt: isoOrUndefined(expiresAt),
    paymentMethod: methodOfAuthorization(auth),
    checkout,
    metadata: overrides.metadata ?? metadataOf(entity.subscription_tags),
    raw: entity,
  };
}

// ---------------------------------------------------------------------------
// Charges and refunds
// ---------------------------------------------------------------------------

function failureReasonOf(payment: CashfreePayment): string | undefined {
  for (const details of [payment.failure_details, payment.failureDetails]) {
    if (typeof details === 'string') {
      const text = nonEmpty(details);
      if (text) return text;
    } else if (details) {
      const candidate: unknown = details.failure_reason ?? details.failureReason;
      const text = typeof candidate === 'string' ? nonEmpty(candidate) : undefined;
      if (text) return text;
    }
  }
  return undefined;
}

/**
 * `AUTH` is the mandate-setup payment. When its authorisation amount is *not*
 * refunded (`authorization_amount_refund: false`) and is above zero, Cashfree
 * keeps it: that is the setup fee / paid trial, so it is `Upfront`. A refunded
 * or zero (eNACH) authorisation is the verification debit.
 */
function chargeKindOf(payment: CashfreePayment, amountPaise: number): ChargeKind {
  const base =
    (payment.payment_type ? lookup(PAYMENT_TYPE_MAP, normaliseKey(payment.payment_type)) : undefined) ??
    UNKNOWN_PAYMENT_TYPE_FALLBACK;
  if (base !== ChargeKind.Authorization) return base;
  const auth = authorizationOf(payment);
  const refunded = auth?.authorization_amount_refund ?? auth?.authorizationAmountRefund;
  return refunded === false && amountPaise > 0 ? ChargeKind.Upfront : ChargeKind.Authorization;
}

export interface MapChargeOptions {
  subscriptionId?: string;
  /** The caller's own charge id, when this adapter created the charge. */
  reference?: string;
  /** Instant to report as `paidAt` when the payment succeeded (the webhook's `event_time`). */
  paidAt?: Date;
  /** Schedule instant to report when the payload has none (create-charge responses do not echo it). */
  scheduledAt?: Date;
}

export function mapCharge(payment: CashfreePayment, options: MapChargeOptions = {}): Charge {
  const amount = requirePaise(payment.payment_amount, 'payment_amount');
  const status = mapPaymentStatus(payment.payment_status);
  const auth = authorizationOf(payment);
  const rawMethod = payment.payment_method;
  const paymentMethod =
    methodOfAuthorization(auth) ??
    (typeof rawMethod === 'string'
      ? mapPaymentMethod(rawMethod)
      : methodOfAuthorization({ payment_method: rawMethod ?? undefined }));
  return {
    provider: PROVIDER,
    id: payment.payment_id,
    reference: options.reference,
    subscriptionId: payment.subscription_id ?? options.subscriptionId,
    kind: chargeKindOf(payment, amount),
    status,
    providerStatus: payment.payment_status,
    amount,
    currency: currencyOf(payment.payment_currency),
    scheduledAt: isoOf(payment.payment_schedule_date) ?? isoOrUndefined(options.scheduledAt),
    paidAt: status === ChargeStatus.Succeeded ? isoOrUndefined(options.paidAt) : undefined,
    failureReason: failureReasonOf(payment),
    paymentMethod,
    raw: payment,
  };
}

export interface MapRefundOptions {
  /** Fallbacks for create responses, which echo the ids but may omit them. */
  chargeId?: string;
  subscriptionId?: string;
  amountPaise?: number;
  createdAt?: Date;
}

export function mapRefund(refund: CashfreeRefund, options: MapRefundOptions = {}): Refund {
  const chargeId = nonEmpty(refund.payment_id) ?? options.chargeId;
  if (chargeId === undefined) {
    throw new SubscriptionError(ErrorCode.UnexpectedResponse, `${PROVIDER} returned a refund without a payment_id`, {
      provider: PROVIDER,
    });
  }
  const amount =
    refund.refund_amount !== null && refund.refund_amount !== undefined
      ? requirePaise(refund.refund_amount, 'refund_amount')
      : options.amountPaise;
  if (amount === undefined) {
    throw new SubscriptionError(ErrorCode.UnexpectedResponse, `${PROVIDER} returned a refund without a refund_amount`, {
      provider: PROVIDER,
    });
  }
  return {
    provider: PROVIDER,
    id: refund.refund_id,
    reference: refund.refund_id,
    chargeId,
    subscriptionId: options.subscriptionId,
    status: mapRefundStatus(refund.refund_status),
    providerStatus: refund.refund_status,
    amount,
    currency: Currency.INR,
    createdAt: isoOrUndefined(options.createdAt),
    raw: refund,
  };
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export interface WebhookContext {
  now: Date;
  /** The exact signed body; only used to derive an id for event types that carry no entity id. */
  rawBody: string;
}

function eventId(type: string, parts: Array<string | number | null | undefined>, eventTime: string | null | undefined): string {
  const present = parts.filter((part): part is string | number => part !== null && part !== undefined && part !== '');
  return [type, ...present.map(String), eventTime ?? ''].join(EVENT_ID_SEPARATOR);
}

type AuthOutcome = 'success' | 'failed' | 'other';

function authOutcome(payment: CashfreePayment): AuthOutcome {
  const auth = authorizationOf(payment);
  const authStatus = nonEmpty(auth?.authorization_status ?? auth?.authorizationStatus);
  const key = authStatus === undefined ? undefined : normaliseKey(authStatus);
  if (key === CashfreeAuthorizationStatus.Success || key === CashfreeAuthorizationStatus.Active) return 'success';
  if (key === CashfreeAuthorizationStatus.Failed) return 'failed';
  const paymentStatus = normaliseKey(payment.payment_status);
  if (paymentStatus === CashfreePaymentStatus.Success) return 'success';
  if (paymentStatus === CashfreePaymentStatus.Failed) return 'failed';
  return 'other';
}

/**
 * Turns a verified webhook body into one normalised event.
 *
 * Event id: Cashfree sends no event id, so the id is the event name, the
 * entity's own ids (`cf_subscription_id` / `cf_payment_id` / `cf_refund_id`,
 * else the merchant ids), the entity's status and `event_time`. A redelivery of
 * the same event repeats all of them; a later transition (another status, a
 * retried payment, a second pause) differs. Event types with no entity id use a
 * hash of the raw body instead.
 */
export function normaliseWebhook(envelope: CashfreeWebhookEnvelope, context: WebhookContext): SubscriptionEvent {
  const { now, rawBody } = context;
  const providerEventType = envelope.type;
  const occurredAt = isoOf(envelope.event_time);
  const base = { provider: PROVIDER, providerEventType, occurredAt, raw: envelope };

  switch (providerEventType) {
    case CashfreeWebhookEvent.SubscriptionStatusChanged: {
      const data = parseResponse(CashfreeStatusWebhookDataSchema, envelope.data, 'status webhook data', PROVIDER);
      const details = data.subscription_details;
      const subscription = mapSubscription(
        {
          ...details,
          customer_details: data.customer_details,
          plan_details: data.plan_details,
          authorization_details: data.authorization_details,
        },
        { now },
      );
      return {
        ...base,
        id: eventId(
          providerEventType,
          [details.cf_subscription_id ?? details.subscription_id, details.subscription_status],
          envelope.event_time,
        ),
        type: lookup(STATUS_EVENT_MAP, normaliseKey(details.subscription_status)) ?? EventType.Unknown,
        subscriptionId: details.subscription_id,
        subscription,
      };
    }

    case CashfreeWebhookEvent.SubscriptionAuthStatus:
    case CashfreeWebhookEvent.PaymentNotificationInitiated:
    case CashfreeWebhookEvent.PaymentSuccess:
    case CashfreeWebhookEvent.PaymentFailed:
    case CashfreeWebhookEvent.PaymentCancelled: {
      const data = parseResponse(CashfreePaymentWebhookDataSchema, envelope.data, 'payment webhook data', PROVIDER);
      const charge = mapCharge(data, { paidAt: parseCashfreeTime(envelope.event_time) });
      return {
        ...base,
        id: eventId(
          providerEventType,
          [data.cf_payment_id ?? data.payment_id, data.payment_status, data.retry_attempts],
          envelope.event_time,
        ),
        type: paymentEventType(providerEventType, data),
        subscriptionId: data.subscription_id,
        charge,
      };
    }

    case CashfreeWebhookEvent.RefundStatus: {
      const data = parseResponse(CashfreeRefundWebhookDataSchema, envelope.data, 'refund webhook data', PROVIDER);
      const refund = mapRefund(data, { createdAt: parseCashfreeTime(envelope.event_time) });
      return {
        ...base,
        id: eventId(providerEventType, [data.cf_refund_id ?? data.refund_id, data.refund_status], envelope.event_time),
        type: refundEventType(data.refund_status),
        refund,
      };
    }

    case CashfreeOrderWebhookEvent.PaymentSuccess:
    case CashfreeOrderWebhookEvent.PaymentFailed:
    case CashfreeOrderWebhookEvent.PaymentUserDropped:
    case CashfreeOrderWebhookEvent.PaymentCharges: {
      const data = parseResponse(CashfreeOrderPaymentWebhookDataSchema, envelope.data, 'payment webhook data', PROVIDER);
      const payment = mapWebhookPayment(data, { eventTime: parseCashfreeTime(envelope.event_time) });
      return {
        ...base,
        id: eventId(
          providerEventType,
          [data.payment.cf_payment_id ?? data.order.order_id, data.payment.payment_status],
          envelope.event_time,
        ),
        type: lookup(ORDER_PAYMENT_EVENT_MAP, providerEventType) ?? EventType.Unknown,
        paymentId: data.order.order_id,
        payment,
      };
    }

    case CashfreeOrderWebhookEvent.RefundStatus: {
      const data = parseResponse(CashfreeOrderRefundWebhookDataSchema, envelope.data, 'refund webhook data', PROVIDER);
      const refund = mapOrderRefund(data.refund, { createdAt: parseCashfreeTime(envelope.event_time) });
      return {
        ...base,
        id: eventId(
          providerEventType,
          [data.refund.cf_refund_id ?? data.refund.refund_id, data.refund.refund_status],
          envelope.event_time,
        ),
        type: lookup(ORDER_REFUND_EVENT_MAP, normaliseKey(data.refund.refund_status)) ?? EventType.Unknown,
        paymentId: data.refund.order_id,
        refund,
      };
    }

    case CashfreeWebhookEvent.CardExpiryReminder:
    case CashfreeWebhookEvent.ControlledNotificationStatus:
    case CashfreeWebhookEvent.ControlledExecutionStatus: {
      // Not normalised: this adapter never uses the controlled flow, and a card
      // expiry reminder changes nothing about the subscription. The event is
      // still verified and carries the subscription id when the payload has one.
      const loose = CashfreeLooseEventDataSchema.safeParse(envelope.data);
      const data = loose.success ? loose.data : undefined;
      const subscriptionId =
        nonEmpty(data?.subscription_id) ??
        nonEmpty(data?.subscription_status_webhook?.subscription_details?.subscription_id);
      return {
        ...base,
        id: eventId(
          providerEventType,
          [
            data?.cf_notification_id ?? data?.notification_id ?? data?.cf_execution_id ?? data?.execution_id ?? subscriptionId,
            data?.notification_status ?? data?.execution_status,
          ],
          envelope.event_time,
        ),
        type: EventType.Unknown,
        subscriptionId,
      };
    }

    default:
      return {
        ...base,
        id: `${providerEventType}${EVENT_ID_SEPARATOR}${hash(HashAlgorithm.Sha256, rawBody, DigestEncoding.Hex).slice(0, EVENT_ID_HASH_LENGTH)}`,
        type: EventType.Unknown,
      };
  }
}

/**
 * - `SUBSCRIPTION_AUTH_STATUS`: authorisation succeeded -> `Authorized`; failed -> `AuthorizationFailed`.
 *   A success on a mandate that Cashfree reports as not yet ACTIVE (bank approval
 *   pending) is only `Updated`: `Authorized` makes a billing scheduler start
 *   raising debits, which Cashfree rejects until the mandate is ACTIVE.
 * - `..._NOTIFICATION_INITIATED` -> `ChargeScheduled`; `..._SUCCESS` -> `Charged`;
 *   `..._FAILED` -> `ChargeFailed`; `..._CANCELLED` -> `ChargeFailed` with charge
 *   status `cancelled` (there is no cancelled-charge event). `charge.kind`
 *   tells an AUTH payment from a recurring charge.
 */
function paymentEventType(providerEventType: string, data: CashfreePayment & { subscription_details?: { subscription_status?: string | null } | null }): EventType {
  switch (providerEventType) {
    case CashfreeWebhookEvent.SubscriptionAuthStatus: {
      const outcome = authOutcome(data);
      if (outcome === 'failed') return EventType.SubscriptionAuthorizationFailed;
      if (outcome === 'other') return EventType.SubscriptionUpdated;
      const subscriptionStatus = nonEmpty(data.subscription_details?.subscription_status);
      const live = subscriptionStatus === undefined || mapSubscriptionStatus(subscriptionStatus) === SubscriptionStatus.Active;
      return live ? EventType.SubscriptionAuthorized : EventType.SubscriptionUpdated;
    }
    case CashfreeWebhookEvent.PaymentNotificationInitiated:
      return EventType.SubscriptionChargeScheduled;
    case CashfreeWebhookEvent.PaymentSuccess:
      return EventType.SubscriptionCharged;
    case CashfreeWebhookEvent.PaymentFailed:
    case CashfreeWebhookEvent.PaymentCancelled:
      return EventType.SubscriptionChargeFailed;
    default:
      return EventType.Unknown;
  }
}

function refundEventType(status: string): EventType {
  switch (normaliseKey(status)) {
    case CashfreeRefundStatus.Success:
      return EventType.RefundSucceeded;
    case CashfreeRefundStatus.Failed:
    case CashfreeRefundStatus.Cancel:
    case CashfreeRefundStatus.Cancelled:
      return EventType.RefundFailed;
    default:
      return EventType.Unknown;
  }
}

// ---------------------------------------------------------------------------
// One-time payments (Cashfree orders)
// ---------------------------------------------------------------------------

/** The order's status as a payment status. Unknown statuses fall back to `Pending`; see `UNKNOWN_ORDER_STATUS_FALLBACK`. */
export function mapOrderStatus(status: string): PaymentStatus {
  return lookup(ORDER_STATUS_MAP, normaliseKey(status)) ?? UNKNOWN_ORDER_STATUS_FALLBACK;
}

/** One attempt's status as a payment status. Unknown or missing statuses fall back to `Pending`; see `UNKNOWN_ATTEMPT_STATUS_FALLBACK`. */
export function mapAttemptStatus(status: string | null | undefined): PaymentStatus {
  const key = nonEmpty(status);
  return key === undefined ? UNKNOWN_ATTEMPT_STATUS_FALLBACK : (lookup(ATTEMPT_STATUS_MAP, normaliseKey(key)) ?? UNKNOWN_ATTEMPT_STATUS_FALLBACK);
}

/** Unknown refund statuses fall back to `Pending`; see `UNKNOWN_ORDER_REFUND_STATUS_FALLBACK`. */
export function mapOrderRefundStatus(status: string) {
  return lookup(ORDER_REFUND_STATUS_MAP, normaliseKey(status)) ?? UNKNOWN_ORDER_REFUND_STATUS_FALLBACK;
}

/** `payment_group` first (it names the method outright), then the key of the `payment_method` object. */
export function methodOfAttempt(attempt: CashfreeOrderPayment): PaymentMethod | undefined {
  const group = nonEmpty(attempt.payment_group);
  const fromGroup = group === undefined ? undefined : lookup(PAYMENT_GROUP_TO_METHOD, group.toLowerCase());
  if (fromGroup !== undefined) return fromGroup;
  for (const key of Object.keys(attempt.payment_method ?? {})) {
    const mapped = lookup(PAYMENT_METHOD_KEY_TO_METHOD, key.toLowerCase());
    if (mapped !== undefined) return mapped;
  }
  return undefined;
}

function orderCustomerOf(
  details: { customer_id?: string | null; customer_name?: string | null; customer_email?: string | null; customer_phone?: string | null } | null | undefined,
): Customer | undefined {
  if (!details) return undefined;
  const customer: Customer = {};
  const id = nonEmpty(details.customer_id);
  const name = nonEmpty(details.customer_name);
  const email = nonEmpty(details.customer_email);
  const phone = nonEmpty(details.customer_phone);
  if (id) customer.id = id;
  if (name) customer.name = name;
  if (email) customer.email = email;
  if (phone) customer.phone = phone;
  return Object.keys(customer).length > 0 ? customer : undefined;
}

/** The checkout to open for a freshly created order: the payment session id, flagged as a one-time payment. */
export function orderCheckoutOf(order: CashfreeOrder, environment: Environment): CheckoutInstruction | undefined {
  const sessionId = nonEmpty(order.payment_session_id);
  return sessionId === undefined
    ? undefined
    : { kind: CheckoutKind.CashfreeCheckout, sessionId, environment, productKind: ProductKind.OneTime };
}

function attemptTime(attempt: CashfreeOrderPayment): number {
  return (parseCashfreeTime(attempt.payment_completion_time) ?? parseCashfreeTime(attempt.payment_time))?.getTime() ?? Number.NEGATIVE_INFINITY;
}

/** What went wrong on an attempt: the error code and the most specific text Cashfree gives. */
function attemptFailure(
  attempt: CashfreeOrderPayment,
  errorDetails: CashfreeOrderPayment['error_details'] = attempt.error_details,
): { failureCode?: string; failureReason?: string } {
  const code = nonEmpty(errorDetails?.error_code);
  const reason = nonEmpty(errorDetails?.error_description) ?? nonEmpty(errorDetails?.error_reason) ?? nonEmpty(attempt.payment_message);
  return { ...(code === undefined ? {} : { failureCode: code }), ...(reason === undefined ? {} : { failureReason: reason }) };
}

/** Refunds whose money has left, summed in paise. In-flight and failed refunds do not count. */
export function refundedPaise(refunds: CashfreeOrderRefund[]): number {
  let total = 0;
  for (const refund of refunds) {
    if (mapOrderRefundStatus(refund.refund_status) !== RefundStatus.Succeeded) continue;
    total += optionalPaise(refund.refund_amount) ?? 0;
  }
  return total;
}

/** Refunds that have been asked for and not failed: the amount of the payment they already claim, in paise. */
export function committedRefundPaise(refunds: CashfreeOrderRefund[]): number {
  let total = 0;
  for (const refund of refunds) {
    if (mapOrderRefundStatus(refund.refund_status) === RefundStatus.Failed) continue;
    total += optionalPaise(refund.refund_amount) ?? 0;
  }
  return total;
}

export interface MapOrderPaymentOptions {
  /** The order's payment attempts, when they were fetched. */
  attempts?: CashfreeOrderPayment[];
  /** The order's refunds, when they were fetched. */
  refunds?: CashfreeOrderRefund[];
  checkout?: CheckoutInstruction;
  /** What `Payment.raw` carries; defaults to the order. */
  raw?: unknown;
}

/**
 * The order is the payment. Its status decides the result, because a failed attempt does not end an order: the customer
 * may retry until it ends [idem]. An order that is ACTIVE or EXPIRED while an attempt is still in flight is `pending`:
 * an expired order "can still move to PAID" if an attempt started before expiry succeeds [lifecycle]. A PAID order with
 * successful refunds is `partially_refunded`, or `refunded` once they cover the amount.
 */
export function mapOrderPayment(order: CashfreeOrder, options: MapOrderPaymentOptions = {}): Payment {
  const attempts = options.attempts ?? [];
  const amount = requirePaise(order.order_amount, 'order_amount');
  const refunded = options.refunds === undefined ? undefined : refundedPaise(options.refunds);

  let status = mapOrderStatus(order.order_status);
  const inFlight = attempts.some((attempt) => mapAttemptStatus(attempt.payment_status) === PaymentStatus.Pending);
  if (inFlight && (status === PaymentStatus.Created || status === PaymentStatus.Failed)) status = PaymentStatus.Pending;
  if (status === PaymentStatus.Succeeded && refunded !== undefined && refunded > 0) {
    status = refunded >= amount ? PaymentStatus.Refunded : PaymentStatus.PartiallyRefunded;
  }

  const success = attempts.find((attempt) => mapAttemptStatus(attempt.payment_status) === PaymentStatus.Succeeded);
  const paid = status === PaymentStatus.Succeeded || status === PaymentStatus.PartiallyRefunded || status === PaymentStatus.Refunded;
  let failure: { failureCode?: string; failureReason?: string } = {};
  if (status === PaymentStatus.Failed || status === PaymentStatus.Cancelled) {
    // The latest attempt that ended badly; attempts are listed in no documented order, so rank by time.
    const ended = attempts
      .map((attempt, index) => ({ attempt, index, at: attemptTime(attempt) }))
      .filter(({ attempt }) => {
        const attemptStatus = mapAttemptStatus(attempt.payment_status);
        return attemptStatus === PaymentStatus.Failed || attemptStatus === PaymentStatus.Cancelled;
      })
      .sort((a, b) => (a.at === b.at ? a.index - b.index : a.at - b.at))
      .at(-1);
    if (ended) failure = attemptFailure(ended.attempt);
  }

  return {
    provider: PROVIDER,
    id: order.order_id,
    reference: order.order_id,
    status,
    providerStatus: order.order_status,
    amount,
    currency: currencyOf(order.order_currency),
    refundedAmount: refunded,
    paymentMethod: success ? methodOfAttempt(success) : undefined,
    customer: orderCustomerOf(order.customer_details),
    createdAt: isoOf(order.created_at),
    paidAt: paid && success ? isoOf(success.payment_completion_time ?? success.payment_time) : undefined,
    ...failure,
    checkout: options.checkout,
    metadata: metadataOf(order.order_tags),
    raw: options.raw ?? order,
  };
}

/**
 * A payment webhook describes one attempt, so the status is the attempt's, and `payment.failed` reports a failed attempt
 * on an order that may still be paid. `paidAt` is the attempt's completion time, else the event time.
 */
export function mapWebhookPayment(data: CashfreeOrderPaymentWebhookData, context: { eventTime?: Date }): Payment {
  const { order, payment } = data;
  const status = mapAttemptStatus(payment.payment_status);
  const failed = status === PaymentStatus.Failed || status === PaymentStatus.Cancelled;
  return {
    provider: PROVIDER,
    id: order.order_id,
    reference: order.order_id,
    status,
    providerStatus: payment.payment_status,
    amount: requirePaise(order.order_amount, 'order_amount'),
    currency: currencyOf(order.order_currency),
    paymentMethod: methodOfAttempt(payment),
    customer: orderCustomerOf(data.customer_details),
    paidAt:
      status === PaymentStatus.Succeeded
        ? isoOrUndefined(parseCashfreeTime(payment.payment_completion_time) ?? context.eventTime)
        : undefined,
    ...(failed ? attemptFailure(payment, data.error_details ?? payment.error_details) : {}),
    metadata: metadataOf(order.order_tags),
    raw: data,
  };
}

export interface MapOrderRefundOptions {
  /** Fallbacks for create responses, which echo the ids but may omit them. */
  orderId?: string;
  amountPaise?: number;
  createdAt?: Date;
}

/** A refund of a one-time payment: `chargeId` and `paymentId` are both the order id. */
export function mapOrderRefund(refund: CashfreeOrderRefund, options: MapOrderRefundOptions = {}): Refund {
  const orderId = nonEmpty(refund.order_id) ?? options.orderId;
  if (orderId === undefined) {
    throw new SubscriptionError(ErrorCode.UnexpectedResponse, `${PROVIDER} returned a refund without an order_id`, { provider: PROVIDER });
  }
  const amount =
    refund.refund_amount !== null && refund.refund_amount !== undefined
      ? requirePaise(refund.refund_amount, 'refund_amount')
      : options.amountPaise;
  if (amount === undefined) {
    throw new SubscriptionError(ErrorCode.UnexpectedResponse, `${PROVIDER} returned a refund without a refund_amount`, {
      provider: PROVIDER,
    });
  }
  return {
    provider: PROVIDER,
    id: refund.refund_id,
    reference: refund.refund_id,
    chargeId: orderId,
    paymentId: orderId,
    status: mapOrderRefundStatus(refund.refund_status),
    providerStatus: refund.refund_status,
    amount,
    currency: Currency.INR,
    createdAt: isoOf(refund.created_at) ?? isoOrUndefined(options.createdAt),
    raw: refund,
  };
}
