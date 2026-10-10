import { randomBytes } from 'node:crypto';
import type { z } from 'zod';
import {
  CancelMode,
  ChangeTiming,
  ContentType,
  DigestEncoding,
  ErrorCode,
  HeaderName,
  HttpMethod,
  PaymentMethod,
  Provider,
  ProviderKind,
  SchedulingMode,
  SubscriptionStatus,
  type Environment,
} from '../../constants.js';
import { assertSignature, getHeader, sha256Hmac } from '../../crypto.js';
import { SubscriptionError, invalid, isSubscriptionError, parseInput, parseResponse, unsupported } from '../../errors.js';
import type { HttpResponse } from '../../http.js';
import { paiseToRupeeNumber } from '../../money.js';
import { BaseProvider, type GatewayErrorInfo, type ProviderOptions } from '../../provider.js';
import {
  CancelSubscriptionOptionsSchema,
  CreateChargeInputSchema,
  CreatePlanInputSchema,
  CreateSubscriptionInputSchema,
  ListChargesOptionsSchema,
  PauseSubscriptionOptionsSchema,
  RefundInputSchema,
  ResumeSubscriptionOptionsSchema,
  UpdateSubscriptionInputSchema,
  WebhookRequestSchema,
  type Capabilities,
  type CancelSubscriptionOptions,
  type Charge,
  type CheckoutResult,
  type CheckoutVerification,
  type CreateChargeInput,
  type CreatePlanInput,
  type CreateSubscriptionInput,
  type ListChargesOptions,
  type ParsedCreatePlanInput,
  type ParsedCreateSubscriptionInput,
  type PauseSubscriptionOptions,
  type Plan,
  type Refund,
  type RefundInput,
  type ResumeSubscriptionOptions,
  type Subscription,
  type SubscriptionEvent,
  type UpdateSubscriptionInput,
  type WebhookRequest,
} from '../../schemas.js';
import {
  addDays,
  fromIstDateString,
  resolveFirstChargeAt,
  toDate,
  toIstDateString,
  toIstIso,
} from '../../time.js';
import {
  CASHFREE_BASE_URLS,
  CASHFREE_IDEMPOTENCY_ERROR_TYPE,
  CashfreeHeader,
  CashfreeNotificationChannel,
  CashfreePath,
  CashfreePaymentType,
  GENERATED_PLAN_ID_PREFIX,
  GENERATED_SUBSCRIPTION_ID_PREFIX,
  IDEMPOTENCY_KEY_PATTERN,
  INTERVAL_UNIT_TO_CASHFREE,
  ManageAction,
  MERCHANT_CHARGE_LEAD_HOURS,
  MERCHANT_CHARGE_MAX_AHEAD_HOURS,
  MIN_VERIFICATION_PAISE,
  PAYMENT_METHOD_TO_REQUEST_METHOD,
  PLAN_NAME_MAX_LENGTH,
  RETURN_URL_SUBSCRIPTION_ID_PARAM,
  SAME_DAY_CUTOFF_IST_HOUR,
  SCHEDULING_TO_PLAN_TYPE,
  SUPPORTED_PAYMENT_METHODS,
  UPFRONT_CAPABLE_METHODS,
  ZERO_AUTHORIZATION_METHODS,
  ZERO_AUTHORIZATION_PAISE,
  type CashfreeRequestMethod,
} from './constants.js';
import {
  checkoutOf,
  mapCharge,
  mapPlan,
  mapRefund,
  mapSubscription,
  normaliseWebhook,
  parseCashfreeTime,
  schedulingOfPlanType,
} from './mapper.js';
import {
  CashfreeChargeRequestSchema,
  CashfreeConfigSchema,
  CashfreeCreatePlanRequestSchema,
  CashfreeCreateSubscriptionRequestSchema,
  CashfreeErrorBodySchema,
  CashfreeManageSubscriptionRequestSchema,
  CashfreePaymentListSchema,
  CashfreePaymentSchema,
  CashfreePlanSchema,
  CashfreeRefundRequestSchema,
  CashfreeRefundSchema,
  CashfreeReturnParamsSchema,
  CashfreeSubscriptionSchema,
  CashfreeWebhookEnvelopeSchema,
  type CashfreeConfig,
  type CashfreeCreatePlanRequest,
  type CashfreeCreateSubscriptionRequest,
  type CashfreeSubscription,
  type ParsedCashfreeConfig,
} from './schemas.js';

const MAX_ERROR_TEXT = 300;
/** Position of the hour in `2026-11-17T10:30:00+05:30`. */
const ISO_HOUR_START = 11;
const ISO_HOUR_END = 13;

/** A 10-digit Indian mobile, with or without a `+91` / `91` country code. */
const TEN_DIGITS = /^\d{10}$/;
const INDIA_COUNTRY_CODE = /^91(\d{10})$/;

interface CallSpec<S extends z.ZodType> {
  method: HttpMethod;
  path: string;
  schema: S;
  what: string;
  body?: unknown;
  /** True for reads and for writes carrying `x-idempotency-key`. */
  idempotent: boolean;
  idempotencyKey?: string;
}

/** `payment_schedule_date` and `next_scheduled_time` are dates in effect; send midnight IST of the IST date. */
function istDate(date: Date): { iso: string; at: Date } {
  const midnight = fromIstDateString(toIstDateString(date));
  if (!midnight) throw invalid('Could not derive an IST date from the schedule instant');
  return { iso: toIstIso(midnight), at: midnight };
}

function generateId(prefix: string): string {
  return `${prefix}${randomBytes(16).toString('hex')}`;
}

function formatPhone(phone: string | undefined): string {
  if (phone === undefined) {
    throw invalid('customer.phone is required: Cashfree rejects a subscription without customer_phone', Provider.Cashfree);
  }
  const digits = phone.startsWith('+') ? phone.slice(1) : phone;
  if (TEN_DIGITS.test(digits)) return digits;
  const withCountryCode = INDIA_COUNTRY_CODE.exec(digits);
  if (withCountryCode?.[1]) return withCountryCode[1];
  throw invalid(
    'customer.phone must be a 10-digit Indian mobile number (optionally with +91): Cashfree validates customer_phone as one',
    Provider.Cashfree,
  );
}

function requireId(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${field} is required`, Provider.Cashfree);
  return value;
}

export class CashfreeProvider extends BaseProvider {
  readonly name = Provider.Cashfree;

  /**
   * - Scheduling: `gateway` = PERIODIC plan (Cashfree raises each charge),
   *   `merchant` = ON_DEMAND plan (the scheduler raises each through `createCharge`).
   * - `merchantChargeLeadHours` / `merchantChargeMaxAheadHours` come from the
   *   cut-off table: see `constants.ts`.
   * - Pause and resume are PERIODIC-only on Cashfree; for merchant-scheduled
   *   subscriptions the adapter leaves them to the scheduler (see
   *   `pauseSubscription`).
   * - `quantity` has no Cashfree equivalent; `cancelAtPeriodEnd` is not offered.
   * - Physical NACH needs a document-upload flow the hosted checkout does not
   *   cover, so it is not listed.
   */
  readonly capabilities: Capabilities = {
    provider: Provider.Cashfree,
    kind: ProviderKind.Gateway,
    scheduling: [SchedulingMode.Gateway, SchedulingMode.Merchant],
    gatewayPlans: true,
    trial: true,
    upfrontAmount: true,
    quantity: false,
    pause: true,
    resume: true,
    cancel: true,
    cancelAtPeriodEnd: false,
    changePlan: true,
    merchantCharges: true,
    merchantPreDebitNotification: false,
    merchantChargeLeadHours: MERCHANT_CHARGE_LEAD_HOURS,
    merchantChargeMaxAheadHours: MERCHANT_CHARGE_MAX_AHEAD_HOURS,
    listCharges: true,
    refunds: true,
    signedWebhooks: true,
    idempotencyKeys: true,
    paymentMethods: [...SUPPORTED_PAYMENT_METHODS],
    oneTimePayments: false,
    oneTimePaymentMethods: [],
  };

  // Real private fields: they stay out of JSON.stringify, console.log and util.inspect.
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #webhookSecret: string;
  readonly #apiVersion: string;
  readonly #baseUrl: string;
  readonly #environment: Environment;

  constructor(config: CashfreeConfig, options: ProviderOptions = {}) {
    super(options);
    const parsed = parseConfig(config);
    this.#clientId = parsed.clientId;
    this.#clientSecret = parsed.clientSecret;
    this.#webhookSecret = parsed.webhookSecret ?? parsed.clientSecret;
    this.#apiVersion = parsed.apiVersion;
    this.#environment = parsed.environment;
    this.#baseUrl = (parsed.baseUrl ?? CASHFREE_BASE_URLS[parsed.environment]).replace(/\/+$/, '');
  }

  // -------------------------------------------------------------------------
  // Plans
  // -------------------------------------------------------------------------

  override async createPlan(input: CreatePlanInput): Promise<Plan> {
    const plan = parseInput(CreatePlanInputSchema, input, 'plan', this.name);
    const scheduling = plan.scheduling ?? SchedulingMode.Gateway;
    const planId = plan.id ?? generateId(GENERATED_PLAN_ID_PREFIX);
    const fields = this.planFields(plan, plan.maxCycles, scheduling);
    const body: CashfreeCreatePlanRequest = parseInput(
      CashfreeCreatePlanRequestSchema,
      {
        plan_id: planId,
        ...fields.common,
        plan_recurring_amount: fields.recurringAmount,
      },
      'Cashfree plan request',
      this.name,
    );
    const response = await this.call({
      method: HttpMethod.Post,
      path: CashfreePath.Plans,
      body,
      schema: CashfreePlanSchema,
      what: 'plan',
      idempotent: false,
    });
    // Cashfree stores no amount or interval for an ON_DEMAND plan: echo what was asked for.
    return mapPlan(
      response,
      scheduling === SchedulingMode.Merchant ? { amount: plan.amount, interval: plan.interval } : {},
    );
  }

  override async getPlan(planId: string): Promise<Plan> {
    return mapPlan(await this.fetchPlan(requireId(planId, 'planId')));
  }

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------

  async createSubscription(input: CreateSubscriptionInput): Promise<Subscription> {
    const parsed = parseInput(CreateSubscriptionInputSchema, input, 'subscription', this.name);
    this.rejectUnsupportedSubscriptionInput(parsed);
    if (parsed.idempotencyKey !== undefined && !IDEMPOTENCY_KEY_PATTERN.test(parsed.idempotencyKey)) {
      throw invalid(
        'idempotencyKey must be a UUID for Cashfree (its x-idempotency-key header has format UUID), e.g. 47bf8872-46fe-11ee-be56-0242ac120002',
        this.name,
      );
    }

    const now = this.now();
    const { firstChargeAt } = resolveFirstChargeAt(parsed, now);
    if (firstChargeAt && parsed.mandateEndsAt && Date.parse(parsed.mandateEndsAt) <= firstChargeAt.getTime()) {
      throw invalid('mandateEndsAt must be after the first charge date', this.name);
    }
    if (firstChargeAt && parsed.authorizeBy && Date.parse(parsed.authorizeBy) > firstChargeAt.getTime()) {
      throw invalid('authorizeBy must not be after the first charge date', this.name);
    }

    const customer = parsed.customer;
    if (customer.email === undefined) {
      throw invalid('customer.email is required: Cashfree rejects a subscription without customer_email', this.name);
    }
    const customerDetails = {
      customer_name: customer.name,
      customer_email: customer.email,
      customer_phone: formatPhone(customer.phone),
    };

    // Plan: an existing plan id (must be PERIODIC) or the plan inline.
    let scheduling: SchedulingMode;
    let planDetails: CashfreeCreateSubscriptionRequest['plan_details'];
    let overrides: { amount?: number; interval?: ParsedCreatePlanInput['interval']; totalCycles?: number } = {};
    if (typeof parsed.plan === 'string') {
      // One read first: an ON_DEMAND plan carries no interval, and the scheduler cannot bill without one.
      // Finding that out after the subscription exists would leave an orphan mandate.
      const stored = await this.fetchPlan(parsed.plan);
      scheduling = schedulingOfPlanType(stored.plan_type);
      if (scheduling === SchedulingMode.Merchant) {
        throw invalid(
          `Plan "${parsed.plan}" is an ON_DEMAND plan, which has no billing interval, but the scheduler needs one to raise ` +
            'each charge. Pass the plan inline (with its interval) instead of by id.',
          this.name,
        );
      }
      planDetails = { plan_id: parsed.plan };
    } else {
      const plan = parsed.plan;
      scheduling = plan.scheduling ?? SchedulingMode.Gateway;
      if (parsed.totalCycles !== undefined && plan.maxCycles !== undefined && parsed.totalCycles !== plan.maxCycles) {
        throw invalid('totalCycles and plan.maxCycles disagree: pass one of them or make them equal', this.name);
      }
      const totalCycles = parsed.totalCycles ?? plan.maxCycles;
      const fields = this.planFields(plan, totalCycles, scheduling);
      // `plan_id` is deliberately not sent: Cashfree wants it "only if you had already created plan".
      planDetails = { ...fields.common, plan_amount: fields.recurringAmount };
      if (scheduling === SchedulingMode.Merchant) {
        overrides = { amount: plan.amount, interval: plan.interval, totalCycles };
      }
    }

    const sendFirstChargeTime = scheduling === SchedulingMode.Gateway && firstChargeAt !== undefined;
    const authorization = this.authorizationFor(parsed);

    const request: CashfreeCreateSubscriptionRequest = parseInput(
      CashfreeCreateSubscriptionRequestSchema,
      {
        subscription_id: parsed.reference ?? generateId(GENERATED_SUBSCRIPTION_ID_PREFIX),
        customer_details: customerDetails,
        plan_details: planDetails,
        authorization_details: authorization,
        subscription_meta: {
          return_url: parsed.returnUrl,
          notification_channel: parsed.notifyCustomer
            ? [CashfreeNotificationChannel.Email, CashfreeNotificationChannel.Sms]
            : undefined,
          session_id_expiry: parsed.authorizeBy ? toIstIso(toDate(parsed.authorizeBy, 'authorizeBy')) : undefined,
        },
        subscription_expiry_time: parsed.mandateEndsAt ? toIstIso(toDate(parsed.mandateEndsAt, 'mandateEndsAt')) : undefined,
        subscription_first_charge_time: sendFirstChargeTime && firstChargeAt ? toIstIso(firstChargeAt) : undefined,
        subscription_tags: parsed.metadata,
      },
      'Cashfree subscription request',
      this.name,
    );

    const response = await this.call({
      method: HttpMethod.Post,
      path: CashfreePath.Subscriptions,
      body: request,
      schema: CashfreeSubscriptionSchema,
      what: 'subscription',
      idempotent: parsed.idempotencyKey !== undefined,
      idempotencyKey: parsed.idempotencyKey,
    });

    const checkout = checkoutOf(response, this.#environment);
    if (!checkout) {
      throw new SubscriptionError(
        ErrorCode.UnexpectedResponse,
        `${this.name} created subscription ${response.subscription_id} but returned no subscription_session_id`,
        { provider: this.name, raw: response },
      );
    }

    return mapSubscription(response, {
      now,
      checkout,
      overrides: {
        ...overrides,
        // Merchant-scheduled: Cashfree holds no first-charge time, so the scheduler gets it from here.
        // Gateway-scheduled: the response's own value wins; this only covers a response that omits it.
        startAt: firstChargeAt ?? (scheduling === SchedulingMode.Merchant ? now : undefined),
      },
    });
  }

  async getSubscription(subscriptionId: string): Promise<Subscription> {
    const entity = await this.fetchSubscription(requireId(subscriptionId, 'subscriptionId'));
    const mapped = mapSubscription(entity, { now: this.now() });
    // A fetch yields a fresh session id; hand it over so an expired checkout can be reopened.
    return mapped.status === SubscriptionStatus.Created
      ? { ...mapped, checkout: checkoutOf(entity, this.#environment) }
      : mapped;
  }

  async cancelSubscription(subscriptionId: string, options?: CancelSubscriptionOptions): Promise<Subscription> {
    const parsed = parseInput(CancelSubscriptionOptionsSchema, options ?? {}, 'cancel options', this.name);
    if (parsed.mode === CancelMode.AtPeriodEnd) {
      throw unsupported(this.name, 'cancelling at period end', 'a Cashfree CANCEL takes effect immediately');
    }
    return this.manage(requireId(subscriptionId, 'subscriptionId'), ManageAction.Cancel);
  }

  /**
   * Cashfree allows PAUSE only on PERIODIC subscriptions ("aren't supported for
   * On-Demand Subscriptions"). A merchant-scheduled subscription is ON_DEMAND
   * and is paused by the scheduler simply not raising charges, so for it this
   * returns the current subscription without a gateway call.
   */
  override async pauseSubscription(subscriptionId: string, options?: PauseSubscriptionOptions): Promise<Subscription> {
    const parsed = parseInput(PauseSubscriptionOptionsSchema, options ?? {}, 'pause options', this.name);
    if (parsed.resumeAt !== undefined) {
      throw unsupported(this.name, 'pausing until a date', 'Cashfree has no scheduled resume; call resumeSubscription');
    }
    const current = await this.getSubscription(requireId(subscriptionId, 'subscriptionId'));
    if (current.scheduling === SchedulingMode.Merchant) return current;
    return this.manage(subscriptionId, ManageAction.Pause);
  }

  /**
   * `ACTIVATE` requires `next_scheduled_time` ("Required for ACTIVATE action";
   * only the date part is used), so `nextChargeAt` is required for PERIODIC
   * subscriptions. Merchant-scheduled (ON_DEMAND) subscriptions are resumed by
   * the scheduler; see `pauseSubscription`.
   */
  override async resumeSubscription(subscriptionId: string, options?: ResumeSubscriptionOptions): Promise<Subscription> {
    const parsed = parseInput(ResumeSubscriptionOptionsSchema, options ?? {}, 'resume options', this.name);
    const current = await this.getSubscription(requireId(subscriptionId, 'subscriptionId'));
    if (current.scheduling === SchedulingMode.Merchant) return current;
    if (parsed.nextChargeAt === undefined) {
      throw invalid(
        'nextChargeAt is required to resume a Cashfree subscription: ACTIVATE needs the date of the next charge',
        this.name,
      );
    }
    return this.manage(subscriptionId, ManageAction.Activate, {
      next_scheduled_time: istDate(toDate(parsed.nextChargeAt, 'nextChargeAt')).iso,
    });
  }

  /**
   * Only `planId` is expressible (`CHANGE_PLAN`, PERIODIC subscriptions only;
   * to change the amount, create a plan with the new amount and move to it).
   *
   * For a merchant-scheduled subscription the amount, next charge date and
   * remaining cycles live in the scheduler, not at Cashfree: those updates
   * return the current subscription without a gateway call, after checking the
   * new amount against the mandate ceiling (`plan_max_amount`).
   */
  override async updateSubscription(subscriptionId: string, input: UpdateSubscriptionInput): Promise<Subscription> {
    const parsed = parseInput(UpdateSubscriptionInputSchema, input, 'subscription update', this.name);
    if (parsed.quantity !== undefined) throw unsupported(this.name, 'changing quantity');
    if (parsed.mandateEndsAt !== undefined) {
      throw unsupported(this.name, 'changing the mandate end date', 'an expiry cannot be extended; cancel and create a new subscription');
    }
    if (parsed.timing === ChangeTiming.AtPeriodEnd) {
      throw unsupported(this.name, 'changing a subscription at period end', 'Cashfree does not say when a new plan takes effect');
    }
    if (parsed.notifyCustomer === true) {
      throw unsupported(this.name, 'notifying the customer of a change', "Cashfree does not notify customers of plan changes");
    }

    const id = requireId(subscriptionId, 'subscriptionId');
    const current = await this.getSubscription(id);
    const scheduleFieldsPresent =
      parsed.amount !== undefined || parsed.nextChargeAt !== undefined || parsed.remainingCycles !== undefined;

    if (current.scheduling === SchedulingMode.Merchant) {
      if (parsed.planId !== undefined) {
        throw unsupported(
          this.name,
          'changing the plan of a merchant-scheduled subscription',
          'Cashfree supports CHANGE_PLAN only for PERIODIC plans',
        );
      }
      if (parsed.amount !== undefined && current.maxAmount !== undefined && parsed.amount > current.maxAmount) {
        throw invalid(
          `amount ${parsed.amount} paise exceeds the mandate ceiling of ${current.maxAmount} paise (plan_max_amount); ` +
            'a larger amount needs a new subscription and a new authorisation',
          this.name,
        );
      }
      return current;
    }

    if (scheduleFieldsPresent) {
      throw unsupported(
        this.name,
        'changing amount, next charge date or remaining cycles directly',
        'move the subscription to a plan with the new amount (planId); Cashfree has no other update operation',
      );
    }
    if (parsed.planId === undefined) {
      throw invalid('Nothing Cashfree can update: only planId can be changed', this.name);
    }
    return this.manage(id, ManageAction.ChangePlan, { plan_id: parsed.planId });
  }

  // -------------------------------------------------------------------------
  // Charges and refunds
  // -------------------------------------------------------------------------

  override async listCharges(subscriptionId: string, options?: ListChargesOptions): Promise<Charge[]> {
    const parsed = parseInput(ListChargesOptionsSchema, options ?? {}, 'list options', this.name);
    const id = requireId(subscriptionId, 'subscriptionId');
    const payments = await this.call({
      method: HttpMethod.Get,
      path: CashfreePath.payments(id),
      schema: CashfreePaymentListSchema,
      what: 'payment list',
      idempotent: true,
    });
    // Cashfree documents neither paging nor ordering for this endpoint, so the
    // order is imposed here: newest first by `payment_initiated_date`, ties and
    // missing dates in the order received. `limit` then keeps the newest.
    const ranked = payments.map((payment, index) => ({
      charge: mapCharge(payment, { subscriptionId: id }),
      initiated: parseCashfreeTime(payment.payment_initiated_date)?.getTime() ?? Number.NEGATIVE_INFINITY,
      index,
    }));
    ranked.sort((a, b) => (b.initiated === a.initiated ? a.index - b.index : b.initiated - a.initiated));
    const charges = ranked.map((entry) => entry.charge);
    return parsed.limit === undefined ? charges : charges.slice(0, parsed.limit);
  }

  override async getCharge(subscriptionId: string, chargeId: string): Promise<Charge> {
    const id = requireId(subscriptionId, 'subscriptionId');
    const payment = await this.call({
      method: HttpMethod.Get,
      path: CashfreePath.payment(id, requireId(chargeId, 'chargeId')),
      schema: CashfreePaymentSchema,
      what: 'payment',
      idempotent: true,
    });
    return mapCharge(payment, { subscriptionId: id });
  }

  /**
   * `POST /subscriptions/pay` with `payment_type: CHARGE`; `chargeId` is the
   * `payment_id`, which Cashfree rejects when reused. Not marked idempotent:
   * Cashfree's `x-idempotency-key` must be a UUID and the charge id is not, so
   * a dropped request surfaces as `OUTCOME_UNKNOWN` and the caller re-reads
   * the charge by id (`getCharge`) before deciding. `invoiceNumber`,
   * `customer` and `metadata` have no field on this endpoint and are not sent.
   */
  override async createCharge(input: CreateChargeInput): Promise<Charge> {
    const parsed = parseInput(CreateChargeInputSchema, input, 'charge', this.name);
    const schedule = istDate(parsed.scheduledAt ? toDate(parsed.scheduledAt, 'scheduledAt') : this.earliestChargeDate());
    const request = parseInput(
      CashfreeChargeRequestSchema,
      {
        subscription_id: parsed.subscriptionId,
        payment_id: parsed.chargeId,
        payment_type: CashfreePaymentType.Charge,
        payment_amount: paiseToRupeeNumber(parsed.amount),
        payment_schedule_date: schedule.iso,
        payment_remarks: parsed.description,
      },
      'Cashfree charge request',
      this.name,
    );
    const payment = await this.call({
      method: HttpMethod.Post,
      path: CashfreePath.Pay,
      body: request,
      schema: CashfreePaymentSchema,
      what: 'charge',
      idempotent: false,
    });
    return mapCharge(payment, {
      subscriptionId: parsed.subscriptionId,
      reference: parsed.chargeId,
      scheduledAt: schedule.at,
    });
  }

  /**
   * Cashfree needs an amount, so a full refund (no `amount`) first reads the
   * charge and refunds its amount. `refund_speed` is left to Cashfree's
   * default: UPI allows only STANDARD and eNACH only INSTANT, so no single
   * value is right for every method.
   */
  override async refundCharge(input: RefundInput): Promise<Refund> {
    const parsed = parseInput(RefundInputSchema, input, 'refund', this.name);
    if (parsed.subscriptionId === undefined) {
      throw invalid('subscriptionId is required: Cashfree creates refunds under the subscription', this.name);
    }
    const subscriptionId = parsed.subscriptionId;
    const amount = parsed.amount ?? (await this.getCharge(subscriptionId, parsed.chargeId)).amount;
    const request = parseInput(
      CashfreeRefundRequestSchema,
      {
        subscription_id: subscriptionId,
        payment_id: parsed.chargeId,
        refund_id: parsed.refundId,
        refund_amount: paiseToRupeeNumber(amount),
        refund_note: parsed.reason,
      },
      'Cashfree refund request',
      this.name,
    );
    const response = await this.call({
      method: HttpMethod.Post,
      path: CashfreePath.refunds(subscriptionId),
      body: request,
      schema: CashfreeRefundSchema,
      what: 'refund',
      idempotent: false,
    });
    return mapRefund(response, { chargeId: parsed.chargeId, subscriptionId, amountPaise: amount, createdAt: this.now() });
  }

  // -------------------------------------------------------------------------
  // Checkout and webhooks
  // -------------------------------------------------------------------------

  /**
   * The return-URL signature algorithm is not documented, so nothing in the
   * query is trusted: only the subscription id is read from it, and the
   * subscription is fetched from the API. `authorized` is true when the
   * mandate is live (ACTIVE, or trialing). BANK_APPROVAL_PENDING (customer
   * done, bank not yet; up to 48 h for eNACH) is `false` with `status:
   * pending_authorization`, because Cashfree rejects debits until ACTIVE;
   * the later ACTIVE webhook completes the activation.
   */
  async verifyCheckout(result: CheckoutResult): Promise<CheckoutVerification> {
    const params = parseInput(CashfreeReturnParamsSchema, result, 'Cashfree return-URL parameters', this.name);
    const subscriptionId = String(params[RETURN_URL_SUBSCRIPTION_ID_PARAM]);
    const entity = await this.fetchSubscription(subscriptionId);
    const subscription = mapSubscription(entity, { now: this.now() });
    return {
      provider: this.name,
      subscriptionId: subscription.id,
      reference: subscription.reference,
      authorized: subscription.status === SubscriptionStatus.Active || subscription.status === SubscriptionStatus.Trialing,
      status: subscription.status,
      raw: entity,
    };
  }

  /**
   * `signature = base64(HMAC_SHA256(secret, x-webhook-timestamp + rawBody))`,
   * compared in constant time. The timestamp's format is not documented, so no
   * replay window is enforced here (the docs recommend 5 minutes).
   */
  parseWebhook(request: WebhookRequest): SubscriptionEvent[] {
    const webhook = parseInput(WebhookRequestSchema, request, 'webhook request', this.name);
    const signature = getHeader(webhook.headers, CashfreeHeader.WebhookSignature);
    const timestamp = getHeader(webhook.headers, CashfreeHeader.WebhookTimestamp);
    if (!timestamp) {
      throw new SubscriptionError(
        ErrorCode.SignatureInvalid,
        `${this.name} webhook has no ${CashfreeHeader.WebhookTimestamp} header`,
        { provider: this.name },
      );
    }
    const expected = sha256Hmac(this.#webhookSecret, timestamp + webhook.rawBody, DigestEncoding.Base64);
    assertSignature(expected, signature, this.name, 'webhook');

    let body: unknown;
    try {
      body = JSON.parse(webhook.rawBody);
    } catch (cause) {
      throw new SubscriptionError(ErrorCode.UnexpectedResponse, `${this.name} sent a signed webhook that is not JSON`, {
        provider: this.name,
        cause,
      });
    }
    const envelope = parseResponse(CashfreeWebhookEnvelopeSchema, body, 'webhook', this.name);
    return [normaliseWebhook(envelope, { now: this.now(), rawBody: webhook.rawBody })];
  }

  // -------------------------------------------------------------------------
  // Errors
  // -------------------------------------------------------------------------

  /** Reads `{ message, code, type }` (spec) or `{ status, subCode, message, reason }` (legacy). */
  protected describeError(response: HttpResponse): GatewayErrorInfo {
    const parsed = CashfreeErrorBodySchema.safeParse(response.json);
    if (parsed.success) {
      const body = parsed.data;
      const message = body.message?.trim() || body.reason?.trim();
      const detail = body.message?.trim() && body.reason?.trim() && body.reason.trim() !== message ? ` (${body.reason.trim()})` : '';
      const code = body.code ?? body.subCode;
      if (message) {
        return {
          message: `${message}${detail}`.slice(0, MAX_ERROR_TEXT),
          providerCode: code === null || code === undefined ? undefined : String(code),
        };
      }
      if (code !== null && code !== undefined) {
        return { message: `error code ${String(code)}`, providerCode: String(code) };
      }
    }
    const text = response.text.trim();
    return { message: text === '' ? 'no error body' : text.slice(0, MAX_ERROR_TEXT) };
  }

  /** 422 `idempotency_error`: the same `x-idempotency-key` was reused with a different body. */
  protected override errorFromResponse(response: HttpResponse, idempotent: boolean): SubscriptionError {
    const error = super.errorFromResponse(response, idempotent);
    const body = CashfreeErrorBodySchema.safeParse(response.json);
    if (response.status === 422 && body.success && body.data.type === CASHFREE_IDEMPOTENCY_ERROR_TYPE) {
      return new SubscriptionError(ErrorCode.Conflict, error.message, {
        provider: this.name,
        httpStatus: response.status,
        providerCode: error.providerCode,
        raw: error.raw,
      });
    }
    return error;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private call<S extends z.ZodType>(spec: CallSpec<S>): Promise<z.output<S>> {
    const headers: Record<string, string> = {
      [CashfreeHeader.ClientId]: this.#clientId,
      [CashfreeHeader.ClientSecret]: this.#clientSecret,
      [CashfreeHeader.ApiVersion]: this.#apiVersion,
      [HeaderName.Accept]: ContentType.Json,
    };
    if (spec.body !== undefined) headers[HeaderName.ContentType] = ContentType.Json;
    if (spec.idempotencyKey !== undefined) headers[CashfreeHeader.IdempotencyKey] = spec.idempotencyKey;
    return this.send(
      {
        method: spec.method,
        url: `${this.#baseUrl}${spec.path}`,
        headers,
        body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
        idempotent: spec.idempotent,
      },
      spec.schema,
      spec.what,
    );
  }

  private fetchPlan(planId: string) {
    return this.call({
      method: HttpMethod.Get,
      path: CashfreePath.plan(planId),
      schema: CashfreePlanSchema,
      what: 'plan',
      idempotent: true,
    });
  }

  private fetchSubscription(subscriptionId: string): Promise<CashfreeSubscription> {
    return this.call({
      method: HttpMethod.Get,
      path: CashfreePath.subscription(subscriptionId),
      schema: CashfreeSubscriptionSchema,
      what: 'subscription',
      idempotent: true,
    });
  }

  private async manage(
    subscriptionId: string,
    action: ManageAction,
    details?: { next_scheduled_time?: string; plan_id?: string },
  ): Promise<Subscription> {
    const body = parseInput(
      CashfreeManageSubscriptionRequestSchema,
      { subscription_id: subscriptionId, action, action_details: details },
      'Cashfree manage request',
      this.name,
    );
    const entity = await this.call({
      method: HttpMethod.Post,
      path: CashfreePath.manageSubscription(subscriptionId),
      body,
      schema: CashfreeSubscriptionSchema,
      what: 'subscription',
      idempotent: false,
    });
    return mapSubscription(entity, { now: this.now() });
  }

  /** Plan fields shared by `POST /plans` and the inline plan of `POST /subscriptions`. */
  private planFields(plan: ParsedCreatePlanInput, maxCycles: number | undefined, scheduling: SchedulingMode) {
    if (plan.name.length > PLAN_NAME_MAX_LENGTH) {
      throw invalid(`Cashfree limits plan names to ${PLAN_NAME_MAX_LENGTH} characters, got ${plan.name.length}`, this.name);
    }
    const periodic = scheduling === SchedulingMode.Gateway;
    return {
      recurringAmount: periodic ? paiseToRupeeNumber(plan.amount) : undefined,
      common: {
        plan_name: plan.name,
        plan_type: SCHEDULING_TO_PLAN_TYPE[scheduling],
        plan_currency: plan.currency,
        plan_max_amount: paiseToRupeeNumber(plan.maxAmount ?? plan.amount),
        plan_max_cycles: maxCycles,
        plan_intervals: periodic ? plan.interval.count : undefined,
        plan_interval_type: periodic ? INTERVAL_UNIT_TO_CASHFREE[plan.interval.unit] : undefined,
        plan_note: plan.description,
      },
    };
  }

  /**
   * Fact sheet §5.3-5.5:
   * - no `upfrontAmount`: the minimum verification amount (₹1) with
   *   `authorization_amount_refund: true`; eNACH collects nothing at
   *   authorisation ("always 0"), so an eNACH-only mandate sends 0.
   * - `upfrontAmount`: sent as the authorisation amount and NOT refunded (the
   *   setup fee / paid trial). eNACH cannot collect it, so it is rejected for
   *   eNACH, and when `paymentMethods` is omitted the checkout is restricted
   *   to UPI and card; otherwise a customer choosing eNACH would never be charged.
   */
  private authorizationFor(parsed: ParsedCreateSubscriptionInput): CashfreeCreateSubscriptionRequest['authorization_details'] {
    const requested = parsed.paymentMethods;
    if (parsed.upfrontAmount !== undefined) {
      if (requested?.some((method) => !UPFRONT_CAPABLE_METHODS.includes(method))) {
        throw unsupported(
          this.name,
          'an upfront amount on eNACH',
          'Cashfree collects no authorisation amount on eNACH (it is always 0); limit paymentMethods to upi and card, or charge the fee separately after activation',
        );
      }
      return {
        authorization_amount: paiseToRupeeNumber(parsed.upfrontAmount),
        authorization_amount_refund: false,
        payment_methods: (requested ?? UPFRONT_CAPABLE_METHODS).map((method) => this.requestMethodFor(method)),
      };
    }
    const zeroAmountOnly = requested !== undefined && requested.every((method) => ZERO_AUTHORIZATION_METHODS.includes(method));
    return {
      authorization_amount: paiseToRupeeNumber(zeroAmountOnly ? ZERO_AUTHORIZATION_PAISE : MIN_VERIFICATION_PAISE),
      authorization_amount_refund: !zeroAmountOnly,
      payment_methods: requested?.map((method): CashfreeRequestMethod => this.requestMethodFor(method)),
    };
  }

  /** The method as Cashfree's subscription API names it; net banking and wallets exist for one-time payments only. */
  private requestMethodFor(method: PaymentMethod): CashfreeRequestMethod {
    if (method === PaymentMethod.NetBanking || method === PaymentMethod.Wallet) {
      throw unsupported(this.name, `${method} on a subscription`, 'Cashfree subscriptions are authorised with upi, card or enach');
    }
    return PAYMENT_METHOD_TO_REQUEST_METHOD[method];
  }

  private rejectUnsupportedSubscriptionInput(parsed: ParsedCreateSubscriptionInput): void {
    if (parsed.quantity !== undefined && parsed.quantity !== 1) {
      throw unsupported(this.name, 'a quantity other than 1', 'a Cashfree plan has one amount; create a plan for the total');
    }
    if (typeof parsed.plan === 'string' && parsed.totalCycles !== undefined) {
      throw unsupported(
        this.name,
        'totalCycles with an existing plan id',
        'the cycle limit belongs to the plan (plan_max_cycles); pass the plan inline or create the plan with maxCycles',
      );
    }
    if (parsed.upfrontLabel !== undefined) {
      throw unsupported(this.name, 'an upfront label', 'Cashfree has no field for it');
    }
    if (parsed.notifyCustomer === false) {
      throw unsupported(this.name, 'suppressing customer notifications', 'Cashfree documents no way to turn them off');
    }
    if (parsed.paymentMethods?.some((method) => !SUPPORTED_PAYMENT_METHODS.includes(method))) {
      throw unsupported(
        this.name,
        'physical NACH',
        'it needs a mandate-document upload flow that the Cashfree checkout does not cover',
      );
    }
  }

  /**
   * Default debit date for a charge without `scheduledAt`: the earliest date
   * legal for every method. UPI and Indian cards allow T+1 only when raised
   * before 21:00 IST, otherwise T+2 [guide:charge].
   */
  private earliestChargeDate(): Date {
    const now = this.now();
    const hour = Number(toIstIso(now).slice(ISO_HOUR_START, ISO_HOUR_END));
    return addDays(now, hour >= SAME_DAY_CUTOFF_IST_HOUR ? 2 : 1);
  }
}

function parseConfig(config: CashfreeConfig): ParsedCashfreeConfig {
  try {
    return parseInput(CashfreeConfigSchema, config, 'Cashfree config', Provider.Cashfree);
  } catch (error) {
    if (isSubscriptionError(error) && error.code === ErrorCode.Validation) {
      // Issue messages name fields, never values, so no secret can leak through here.
      throw new SubscriptionError(ErrorCode.Config, error.message, { provider: Provider.Cashfree });
    }
    throw error;
  }
}

/** Creates a Cashfree provider. Throws `CONFIG` when the configuration is invalid. */
export function cashfree(config: CashfreeConfig, options?: ProviderOptions): CashfreeProvider {
  return new CashfreeProvider(config, options);
}
