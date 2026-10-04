import { randomBytes } from 'node:crypto';
import type { z } from 'zod';
import {
  CancelMode,
  CheckoutKind,
  ContentType,
  Currency,
  ErrorCode,
  GATEWAY_STATUS_UNAVAILABLE,
  HeaderName,
  HttpMethod,
  PaymentMethod,
  Provider,
  RefundStatus,
  SchedulingMode,
  SubscriptionStatus,
} from '../../constants.js';
import { SubscriptionError, invalid, parseInput, parseResponse, unsupported } from '../../errors.js';
import { withQuery, type HttpResponse } from '../../http.js';
import { BaseProvider, type GatewayErrorInfo, type ProviderOptions } from '../../provider.js';
import {
  CancelSubscriptionOptionsSchema,
  CreateChargeInputSchema,
  CreateSubscriptionInputSchema,
  NotifyChargeInputSchema,
  PauseSubscriptionOptionsSchema,
  RefundInputSchema,
  ResumeSubscriptionOptionsSchema,
  UpdateSubscriptionInputSchema,
  WebhookRequestSchema,
  type CancelSubscriptionOptions,
  type Capabilities,
  type Charge,
  type ChargeNotification,
  type CheckoutResult,
  type CheckoutVerification,
  type CreateChargeInput,
  type CreatePlanInput,
  type CreateSubscriptionInput,
  type NotifyChargeInput,
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
import { resolveFirstChargeAt, toDate, toIso, toIstDateString } from '../../time.js';
import { assertChecksum, generateChecksum, generateSalt, jsonMemberText, paramsPayload } from './checksum.js';
import {
  CANCEL_ERRORS,
  INITIATE_ERRORS,
  JSON_BODY_START,
  MODIFY_ERRORS,
  PAYTM_BASE_URLS,
  PAYTM_CHECKSUM_FIELD,
  PAYTM_CURRENCY,
  PAYTM_DECLINED_MESSAGE_PATTERN,
  PAYTM_ENDED_STATUSES,
  PAYTM_GATEWAY_EXPIRY_BUFFER_DAYS,
  PAYTM_GENERATED_ORDER_ID_PREFIX,
  PAYTM_GENERATED_ORDER_ID_RANDOM_BYTES,
  PAYTM_ID_PART_SEPARATOR,
  PAYTM_INVOICE_NUMBER_PATTERN,
  PAYTM_MERCHANT_EXPIRY_BUFFER_DAYS,
  PAYTM_MODES_FOR_METHOD,
  PAYTM_ORDER_ID_MAX_LENGTH,
  PAYTM_ORDER_ID_PATTERN,
  PAYTM_PAYMENT_METHODS,
  PAYTM_PRE_NOTIFY_ALREADY_SENT,
  PAYTM_PRE_NOTIFY_NOT_REQUIRED,
  PAYTM_REQUEST_TYPE_SUBSCRIPTION,
  PAYTM_RETRY_GRACE_DAYS,
  PAYTM_AUTO_RETRY_GRACE_DAYS,
  PAYTM_DEFAULT_RETRY_COUNT,
  PAYTM_STATUS_CREATED,
  PAYTM_TOKEN_TYPE_AES,
  PAYTM_TXN_TYPE_REFUND,
  PAYTM_UPI_FREQUENCIES,
  PRENOTIFY_ERRORS,
  RENEW_ERRORS,
  RENEW_UNLISTED_ERROR,
  REFUND_ERRORS,
  STATUS_ERRORS,
  TXN_STATUS_ERRORS,
  PaytmAmountType,
  PaytmCode,
  PaytmEnableRetry,
  PaytmFrequencyUnit,
  PaytmHeadDialect,
  PaytmHostFamily,
  PaytmMandateType,
  PaytmModifyStatus,
  PaytmPath,
  PaytmQuery,
  PaytmResultStatus,
  PaytmSuccessCode,
  PaytmTxnStatus,
  } from './constants.js';
import {
  buildUserInfo,
  classifyResult,
  deriveExpiryDate,
  findPipe,
  frequencyUnitFor,
  isBankMandateMode,
  isUpiSafeStartDate,
  istDaysBetween,
  mapCallbackCharge,
  mapPaymentWebhook,
  mapPreNotifyWebhook,
  mapRefund,
  mapRefundArnWebhook,
  mapRefundWebhook,
  mapRenewCharge,
  mapStatusSubscription,
  mapSubscriptionWebhook,
  mapTransactionCharge,
  maxGraceDays,
  paise,
  parseIstDateTime,
  resultView,
  rupees,
  supportedIntervalsText,
  toIstDateTimeString,
  toIstDayMonthYear,
  type ApiResultSpec,
  type BodyFailure,
  type ResultView,
} from './mapper.js';
import {
  PaytmActionResponseSchema,
  PaytmCallbackSchema,
  PaytmCancelRequestSchema,
  PaytmConfigSchema,
  PaytmErrorEnvelopeSchema,
  PaytmFormSchema,
  PaytmInitiateRequestSchema,
  PaytmInitiateResponseSchema,
  PaytmJsonEnvelopeSchema,
  PaytmModifyRequestSchema,
  PaytmPaymentWebhookSchema,
  PaytmPreNotifyRequestSchema,
  PaytmPreNotifyResponseSchema,
  PaytmPreNotifyWebhookSchema,
  PaytmRefundArnWebhookSchema,
  PaytmRefundRequestSchema,
  PaytmRefundResponseSchema,
  PaytmRefundWebhookBodySchema,
  PaytmRenewRequestSchema,
  PaytmRenewResponseSchema,
  PaytmStatusRequestSchema,
  PaytmStatusResponseSchema,
  PaytmSubscriptionWebhookSchema,
  PaytmTxnStatusRequestSchema,
  PaytmTxnStatusResponseSchema,
  type ParsedPaytmConfig,
  type PaytmConfig,
  type PaytmForm,
  type PaytmInitiateRequest,
  type PaytmStatusBody,
  type PaytmTxnStatusBody,
} from './schemas.js';

const ERROR_TEXT_PREVIEW_CHARS = 200;

function parseConfig(config: unknown): ParsedPaytmConfig {
  const result = PaytmConfigSchema.safeParse(config);
  if (result.success) return result.data;
  // Paths and messages only: never the offending values, which may be the merchant key.
  const issues = result.error.issues
    .map((issue) => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
  throw new SubscriptionError(ErrorCode.Config, `Invalid ${Provider.Paytm} config: ${issues}`, { provider: Provider.Paytm });
}

export interface PaytmProviderOptions extends ProviderOptions {
  /** Id generator for generated order ids (tests). Receives a prefix and a number of random bytes. */
  generateId?: (prefix: string, randomBytes: number) => string;
  /** Salt source of the checksum (tests make signatures deterministic with it). Must return 4 printable ASCII characters. */
  generateSalt?: () => string;
}

function defaultGenerateId(prefix: string, bytes: number): string {
  return `${prefix}${PAYTM_ID_PART_SEPARATOR}${randomBytes(bytes).toString('hex')}`;
}

function requireText(value: string | undefined, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${what} is required`, Provider.Paytm);
  return value;
}

function checkOrderId(value: string, what: string): string {
  if (value.length > PAYTM_ORDER_ID_MAX_LENGTH || !PAYTM_ORDER_ID_PATTERN.test(value)) {
    throw invalid(
      `${what} "${value.slice(0, 40)}" cannot be a Paytm order id: it must be at most ${PAYTM_ORDER_ID_MAX_LENGTH} characters of letters, digits and "@", ".", "_", "-"`,
      Provider.Paytm,
    );
  }
  return value;
}

/** Per-API reading of `resultInfo`. A write with no verdict is `OUTCOME_UNKNOWN`: it may have taken effect. */
const INITIATE_SPEC: ApiResultSpec = {
  successCode: PaytmSuccessCode.Initiate,
  errors: INITIATE_ERRORS,
  unlisted: ErrorCode.ProviderError,
  noVerdict: ErrorCode.OutcomeUnknown,
  unknownStatus: PaytmResultStatus.Unknown,
};
const RENEW_SPEC: ApiResultSpec = {
  successCode: PaytmSuccessCode.Renew,
  errors: RENEW_ERRORS,
  unlisted: RENEW_UNLISTED_ERROR,
  noVerdict: ErrorCode.OutcomeUnknown,
  unknownStatus: PaytmResultStatus.Unknown,
};
const PRENOTIFY_SPEC: ApiResultSpec = {
  successCode: PaytmSuccessCode.SubscriptionService,
  errors: PRENOTIFY_ERRORS,
  unlisted: ErrorCode.ProviderError,
  noVerdict: ErrorCode.OutcomeUnknown,
};
const STATUS_SPEC: ApiResultSpec = {
  successCode: PaytmSuccessCode.SubscriptionService,
  errors: STATUS_ERRORS,
  unlisted: ErrorCode.ProviderError,
  noVerdict: ErrorCode.UnexpectedResponse,
};
const MODIFY_SPEC: ApiResultSpec = {
  successCode: PaytmSuccessCode.SubscriptionService,
  errors: MODIFY_ERRORS,
  unlisted: ErrorCode.ProviderError,
  noVerdict: ErrorCode.OutcomeUnknown,
};
const CANCEL_SPEC: ApiResultSpec = {
  successCode: PaytmSuccessCode.Cancel,
  errors: CANCEL_ERRORS,
  unlisted: ErrorCode.ProviderError,
  noVerdict: ErrorCode.OutcomeUnknown,
};

/** What `call` needs to know about one Paytm API. */
interface ApiCall<S extends z.ZodType> {
  path: PaytmPath;
  family: PaytmHostFamily;
  dialect: PaytmHeadDialect;
  /** `mid` and `orderId` in the query string, for the APIs that take them there. */
  query?: Record<string, string>;
  /** The request body, already validated: it is serialised ONCE, signed, and sent as that very text. */
  body: object;
  schema: S;
  what: string;
  /** True only for reads. A write that gets no answer is `OUTCOME_UNKNOWN`. */
  idempotent: boolean;
}

/**
 * Paytm Payments (Paytm PG) subscriptions.
 *
 * ## Who collects
 *
 * Paytm can collect each cycle itself (`autoRenewal: true`), but only for fixed amounts, never daily, and for UPI only when
 * the first debit is today or exactly one cycle away. The documented free-trial recipe (a zero first amount with a VARIABLE
 * amount type) and every variable, on-demand or daily subscription are merchant-collected: the merchant calls Renew for each
 * cycle, after Pre-Notify for the payment modes that need one. So `scheduling` is `[merchant, gateway]` and merchant is the
 * default: the library's billing scheduler drives it. A plan asks for Paytm's own collection with `scheduling: 'gateway'`.
 *
 * ## What createSubscription sends
 *
 * Merchant mode: `autoRenewal: false`, VARIABLE with the plan's ceiling as `subscriptionMaxAmount`, `subscriptionStartDate`
 * = today (a later date takes UPI away) with grace days wide enough for the first debit and the scheduler's retries.
 * `autoRetry` is false and Paytm never retries by itself: the scheduler retries, under new debit ids. Gateway mode:
 * `autoRenewal: true`, FIX, the start date is the first debit date, and Paytm's documented retry defaults are on
 * (`autoRetry`, `subscriptionGraceDays` 2, `subscriptionRetryCount` 3).
 *
 * ## Signatures
 *
 * Every request body is serialised once, signed, and sent as that same text. Answers are read from the JSON and their
 * `head.signature` is not verified (the subscription-service APIs return it empty and the response is TLS-authenticated).
 * Callbacks and webhooks ARE verified, each with the rule its kind needs.
 *
 * ## Ignored fields
 *
 * `authorizeBy`, `upfrontLabel`, `metadata`, `idempotencyKey` and `quantity > 1` have no Paytm equivalent (the order id is
 * the natural idempotency key: Paytm refuses a repeated one).
 */
export class PaytmProvider extends BaseProvider {
  readonly name = Provider.Paytm;

  readonly capabilities: Capabilities = {
    provider: Provider.Paytm,
    scheduling: [SchedulingMode.Merchant, SchedulingMode.Gateway],
    gatewayPlans: false,
    trial: true,
    upfrontAmount: true,
    quantity: false,
    pause: true,
    resume: true,
    cancelAtPeriodEnd: false,
    changePlan: false,
    merchantCharges: true,
    merchantPreDebitNotification: true,
    listCharges: false,
    refunds: true,
    signedWebhooks: true,
    idempotencyKeys: false,
    paymentMethods: [...PAYTM_PAYMENT_METHODS],
  };

  // Real private fields: invisible to JSON.stringify, console.log and spreads, so the merchant key cannot leak.
  readonly #mid: string;
  readonly #key: string;
  readonly #config: ParsedPaytmConfig;
  readonly #urls: Record<PaytmHostFamily, string>;
  readonly #checkoutUrl: string;
  readonly #generateId: (prefix: string, bytes: number) => string;
  readonly #generateSalt: () => string;

  constructor(config: PaytmConfig, options: PaytmProviderOptions = {}) {
    const parsed = parseConfig(config);
    super(options);
    this.#mid = parsed.mid;
    this.#key = parsed.merchantKey;
    this.#config = { ...parsed, merchantKey: '' };
    const base = (family: PaytmHostFamily, override: string | undefined): string =>
      (override ?? PAYTM_BASE_URLS[family][parsed.environment]).replace(/\/+$/, '');
    this.#urls = {
      [PaytmHostFamily.Subscription]: base(PaytmHostFamily.Subscription, parsed.subscriptionBaseUrl),
      [PaytmHostFamily.TransactionStatus]: base(PaytmHostFamily.TransactionStatus, parsed.transactionStatusBaseUrl),
      [PaytmHostFamily.Refund]: base(PaytmHostFamily.Refund, parsed.refundBaseUrl),
    };
    this.#checkoutUrl = base(PaytmHostFamily.Subscription, parsed.checkoutBaseUrl);
    this.#generateId = options.generateId ?? defaultGenerateId;
    this.#generateSalt = options.generateSalt ?? generateSalt;
  }

  // -------------------------------------------------------------------------
  // HTTP plumbing
  // -------------------------------------------------------------------------

  /**
   * One Paytm call. The body is serialised once; that text is what is signed and what is sent, as the `body` member of the
   * envelope (concatenated, never re-serialised). Returns the parsed `body` of the answer, not yet judged: Paytm answers
   * HTTP 200 for failures too, so the caller reads `resultInfo`.
   */
  private async call<S extends z.ZodType<{ body: unknown }>>(spec: ApiCall<S>): Promise<z.output<S>['body']> {
    const pipe = findPipe(spec.body);
    if (pipe !== undefined) {
      throw invalid(`${pipe} contains the character "|", which Paytm rejects (code 1008): remove it before sending`, this.name);
    }
    const bodyText = JSON.stringify(spec.body);
    const signature = generateChecksum(bodyText, this.#key, this.#generateSalt());
    const head: Record<string, string> =
      spec.dialect === PaytmHeadDialect.Theia
        ? {
            ...(this.#config.clientId !== undefined ? { clientId: this.#config.clientId } : {}),
            ...(this.#config.channelId !== undefined ? { channelId: this.#config.channelId } : {}),
            signature,
          }
        : {
            tokenType: PAYTM_TOKEN_TYPE_AES,
            ...(this.#config.clientId !== undefined ? { clientId: this.#config.clientId } : {}),
            signature,
          };
    const envelope = `{"body":${bodyText},"head":${JSON.stringify(head)}}`;
    const url = withQuery(`${this.#urls[spec.family]}${spec.path}`, spec.query ?? {});
    const answer = await this.send(
      {
        method: HttpMethod.Post,
        url,
        headers: { [HeaderName.ContentType]: ContentType.Json, [HeaderName.Accept]: ContentType.Json },
        body: envelope,
        idempotent: spec.idempotent,
      },
      spec.schema,
      spec.what,
    );
    return answer.body;
  }

  protected describeError(response: HttpResponse): GatewayErrorInfo {
    const parsed = PaytmErrorEnvelopeSchema.safeParse(response.json);
    if (parsed.success) {
      const view = resultView(parsed.data.body?.resultInfo);
      if (view.message !== undefined) return { message: view.message, ...(view.code !== undefined ? { providerCode: view.code } : {}) };
    }
    const text = response.text.trim();
    return { message: text ? text.slice(0, ERROR_TEXT_PREVIEW_CHARS) : 'empty response body' };
  }

  private bodyError(failure: BodyFailure, what: string, raw: unknown): SubscriptionError {
    const unclear = failure.code === ErrorCode.OutcomeUnknown;
    return new SubscriptionError(
      failure.code,
      `${this.name} ${what}: ${failure.message}${failure.providerCode !== undefined ? ` (code ${failure.providerCode})` : ''}${
        unclear ? '. It may or may not have taken effect: fetch the current state before retrying.' : ''
      }`,
      { provider: this.name, providerCode: failure.providerCode, raw },
    );
  }

  /** Throws when a Paytm answer (HTTP 200) is a body-level failure. */
  private failOnResult(view: ResultView, spec: ApiResultSpec, what: string, raw: unknown): void {
    const failure = classifyResult(view, spec);
    if (failure) throw this.bodyError(failure, what, raw);
  }

  // -------------------------------------------------------------------------
  // Plans: Paytm has no plan API
  // -------------------------------------------------------------------------

  override createPlan(_input: CreatePlanInput): Promise<Plan> {
    return Promise.reject(
      unsupported(this.name, 'creating plans', 'Paytm documents no plan API; pass the plan inline to createSubscription'),
    );
  }

  override getPlan(_planId: string): Promise<Plan> {
    return Promise.reject(
      unsupported(this.name, 'fetching plans', 'Paytm documents no plan API; pass the plan inline to createSubscription'),
    );
  }

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------

  /**
   * Initiate Subscription (`/subscription/create`). Returns the subscription (`id` = Paytm's `subscriptionId`, `reference` =
   * the order id, status `created`) and the form that sends the customer to Paytm's payment page.
   */
  override async createSubscription(rawInput: CreateSubscriptionInput): Promise<Subscription> {
    const input = parseInput(CreateSubscriptionInputSchema, rawInput, 'subscription input', this.name);
    if (typeof input.plan === 'string') {
      throw invalid(
        'Paytm has no plan API, so a plan id cannot be resolved: pass the plan details inline (name, amount, interval) instead of a string',
        this.name,
      );
    }
    const plan = input.plan;
    const scheduling = plan.scheduling ?? SchedulingMode.Merchant;
    const gateway = scheduling === SchedulingMode.Gateway;
    if (input.quantity !== undefined && input.quantity !== 1) {
      throw unsupported(this.name, 'quantity', 'multiply the plan amount yourself');
    }

    const methods = input.paymentMethods;
    const unusable = methods?.filter((method) => !PAYTM_PAYMENT_METHODS.includes(method));
    if (unusable !== undefined && unusable.length > 0) {
      throw invalid(
        `Paytm subscriptions here support ${PAYTM_PAYMENT_METHODS.join(', ')}; ${unusable.join(', ')} cannot be requested (paper mandates need Paytm's separate mandate-form integration)`,
        this.name,
      );
    }
    const upiMayBeUsed = methods === undefined || methods.includes(PaymentMethod.Upi);
    const upiOnly = methods !== undefined && methods.every((method) => method === PaymentMethod.Upi);
    const cardsOnly = methods !== undefined && methods.every((method) => method === PaymentMethod.Card);
    const eNachOnly = methods !== undefined && methods.every((method) => method === PaymentMethod.ENach);
    const eNachMayBeUsed = methods === undefined || methods.includes(PaymentMethod.ENach);

    const unit = frequencyUnitFor(plan.interval);
    if (unit === undefined) {
      throw invalid(
        `Paytm cannot express a billing interval of ${plan.interval.count} ${plan.interval.unit}: its Initiate Subscription takes a frequency unit with no multiplier. Use one of: ${supportedIntervalsText()}`,
        this.name,
      );
    }
    if (upiOnly && !PAYTM_UPI_FREQUENCIES.includes(unit)) {
      throw invalid(`UPI Autopay does not support a ${unit} frequency (it takes ${PAYTM_UPI_FREQUENCIES.join(', ')}); allow other payment methods or change the interval`, this.name);
    }

    const ceiling = plan.maxAmount ?? plan.amount;
    if (input.upfrontAmount !== undefined) {
      if (eNachOnly) {
        throw invalid(
          'upfrontAmount must be 0 when eNACH is the only payment method: Paytm refuses a non-zero first amount for bank mandates (code 4001); drop the upfront amount or allow other payment methods',
          this.name,
        );
      }
      // "Only for UPI & e-Mandates paymodes - The txnAmount cannot be greater than the renewalAmount"; no payment mode can take
      // more than the mandate's ceiling ("Transaction amount cannot be greater than the max amount set against the subscription").
      const limit = upiMayBeUsed || eNachMayBeUsed ? (gateway ? plan.amount : ceiling) : ceiling;
      if (input.upfrontAmount > limit) {
        throw invalid(
          `upfrontAmount (${input.upfrontAmount} paise) is more than Paytm allows for the first payment (${limit} paise${gateway ? ', the renewal amount' : ', the mandate ceiling'})`,
          this.name,
        );
      }
    }

    const now = this.now();
    const { firstChargeAt, isTrial } = resolveFirstChargeAt(input, now);
    const firstDebit = firstChargeAt ?? now;
    const today = toIstDateString(now);

    const orderId = checkOrderId(
      input.reference ?? this.#generateId(PAYTM_GENERATED_ORDER_ID_PREFIX, PAYTM_GENERATED_ORDER_ID_RANDOM_BYTES),
      'reference',
    );
    const { userInfo } = buildUserInfo(input.customer, orderId);
    const totalCycles = input.totalCycles ?? plan.maxCycles;

    let startDate: string;
    let amountFields: { subscriptionAmountType: PaytmAmountType; subscriptionMaxAmount?: string; renewalAmount?: string };
    let retry: { autoRetry: boolean; enableRetry: PaytmEnableRetry; graceDays?: number; retryCount?: number };
    let communicationManager: boolean | undefined;
    let expiryBuffer: number;

    if (gateway) {
      // Paytm collects by itself. What its documentation says it cannot collect is refused here, with the way out.
      const way = 'use merchant scheduling (the default), where this library collects each cycle';
      if (plan.maxAmount !== undefined && plan.maxAmount !== plan.amount) {
        throw invalid(`Paytm's own collection (autoRenewal) takes fixed amounts only, and this plan's maxAmount differs from its amount; ${way}`, this.name);
      }
      if (unit === PaytmFrequencyUnit.Day) {
        throw invalid(`Paytm's own collection (autoRenewal) is not available for daily frequency; ${way}`, this.name);
      }
      startDate = toIstDateString(firstDebit);
      if (upiMayBeUsed && !isUpiSafeStartDate(startDate, now, plan.interval)) {
        throw invalid(
          `UPI Autopay accepts a future start date only when it is today or exactly one cycle from today, and the first debit here is ${startDate}; set paymentMethods without 'upi', start today or one cycle from today, or ${way}`,
          this.name,
        );
      }
      amountFields = { subscriptionAmountType: PaytmAmountType.Fix, renewalAmount: rupees(plan.amount) };
      // Paytm retries by itself, with its documented defaults: autoRetry, 2 grace days, 3 retries. Bank mandates support none.
      retry = eNachOnly
        ? { autoRetry: false, enableRetry: PaytmEnableRetry.Disabled }
        : {
            autoRetry: true,
            enableRetry: PaytmEnableRetry.Enabled,
            graceDays: Math.min(PAYTM_AUTO_RETRY_GRACE_DAYS, maxGraceDays(unit, cardsOnly)),
            retryCount: PAYTM_DEFAULT_RETRY_COUNT,
          };
      // Paytm must send the pre-debit notification itself: nothing else will.
      communicationManager = input.notifyCustomer ?? true;
      expiryBuffer = PAYTM_GATEWAY_EXPIRY_BUFFER_DAYS;
    } else {
      // The merchant collects: no Paytm auto-collect and no Paytm auto-retry. The scheduler retries, each attempt under a new
      // order id (Paytm refuses a repeated one), and a manual retry is only allowed when autoRetry is off.
      startDate = today;
      amountFields = { subscriptionAmountType: PaytmAmountType.Variable, subscriptionMaxAmount: rupees(ceiling) };
      const wanted = this.#config.graceDays ?? Math.max(0, istDaysBetween(now, firstDebit)) + PAYTM_RETRY_GRACE_DAYS;
      retry = eNachOnly
        ? { autoRetry: false, enableRetry: PaytmEnableRetry.Disabled }
        : {
            autoRetry: false,
            enableRetry: PaytmEnableRetry.Enabled,
            graceDays: Math.min(wanted, maxGraceDays(unit, cardsOnly)),
            retryCount: this.#config.retryCount ?? PAYTM_DEFAULT_RETRY_COUNT,
          };
      // The scheduler sends the pre-debit notification through the Pre-Notify API; Paytm's own would be a second one.
      communicationManager = input.notifyCustomer;
      expiryBuffer = PAYTM_MERCHANT_EXPIRY_BUFFER_DAYS;
    }

    const expiryDate = deriveExpiryDate({
      firstDebit,
      interval: plan.interval,
      ...(totalCycles !== undefined ? { totalCycles } : {}),
      ...(input.mandateEndsAt !== undefined ? { mandateEndsAt: input.mandateEndsAt } : {}),
      mandateYears: this.#config.mandateYears,
      bufferDays: expiryBuffer,
    });

    if (expiryDate < startDate) {
      throw invalid(`the mandate would end (${expiryDate}) before its start date (${startDate}): mandateEndsAt must be later`, this.name);
    }

    const callbackUrl = input.returnUrl ?? this.#config.callbackUrl;
    const body: PaytmInitiateRequest = parseInput(
      PaytmInitiateRequestSchema,
      {
        requestType: PAYTM_REQUEST_TYPE_SUBSCRIPTION,
        mid: this.#mid,
        websiteName: this.#config.website,
        orderId,
        ...(callbackUrl !== undefined ? { callbackUrl } : {}),
        // "0" for a trial or a plain authorisation: Paytm may take Re 1 itself for cards, UPI and wallet.
        txnAmount: { value: input.upfrontAmount !== undefined ? rupees(input.upfrontAmount) : '0', currency: PAYTM_CURRENCY },
        userInfo,
        ...amountFields,
        autoRenewal: gateway,
        autoRetry: retry.autoRetry,
        ...(communicationManager !== undefined ? { communicationManager } : {}),
        subscriptionFrequencyUnit: unit,
        subscriptionStartDate: startDate,
        ...(retry.graceDays !== undefined ? { subscriptionGraceDays: String(retry.graceDays) } : {}),
        subscriptionExpiryDate: expiryDate,
        subscriptionEnableRetry: retry.enableRetry,
        ...(retry.retryCount !== undefined ? { subscriptionRetryCount: String(retry.retryCount) } : {}),
        ...(methods?.includes(PaymentMethod.ENach) ? { mandateType: PaytmMandateType.EMandate } : {}),
        ...(methods !== undefined
          ? { enablePaymentMode: methods.flatMap((method) => PAYTM_MODES_FOR_METHOD[method].map((mode) => ({ mode }))) }
          : {}),
      },
      'Paytm subscription request',
      this.name,
    );

    const answer = await this.call({
      path: PaytmPath.CreateSubscription,
      family: PaytmHostFamily.Subscription,
      dialect: PaytmHeadDialect.Theia,
      query: { [PaytmQuery.Mid]: this.#mid, [PaytmQuery.OrderId]: orderId },
      body,
      schema: PaytmInitiateResponseSchema,
      what: 'subscription creation',
      idempotent: false,
    });
    this.failOnResult(resultView(answer.resultInfo), INITIATE_SPEC, 'subscription creation', answer);
    const { subscriptionId, txnToken } = answer;
    if (!subscriptionId || !txnToken) {
      throw new SubscriptionError(
        ErrorCode.UnexpectedResponse,
        `${this.name} reported success for subscription creation without a subscriptionId and txnToken; the subscription may exist: look it up by its order id ${orderId} before creating another`,
        { provider: this.name, raw: answer },
      );
    }

    const customer = {
      id: userInfo.custId,
      ...(input.customer.name !== undefined ? { name: input.customer.name } : {}),
      ...(input.customer.email !== undefined ? { email: input.customer.email } : {}),
      ...(input.customer.phone !== undefined ? { phone: input.customer.phone } : {}),
    };
    return {
      provider: this.name,
      id: subscriptionId,
      reference: orderId,
      status: SubscriptionStatus.Created,
      providerStatus: PAYTM_STATUS_CREATED,
      scheduling,
      customer,
      amount: plan.amount,
      maxAmount: gateway ? plan.amount : ceiling,
      currency: Currency.INR,
      interval: plan.interval,
      ...(totalCycles !== undefined ? { totalCycles } : {}),
      createdAt: toIso(now),
      startAt: toIso(firstDebit),
      ...(isTrial ? { trialEndsAt: toIso(firstDebit) } : {}),
      mandateEndsAt: input.mandateEndsAt ?? toIso(toDate(`${expiryDate}T00:00:00+05:30`)),
      checkout: {
        kind: CheckoutKind.FormPost,
        url: withQuery(`${this.#checkoutUrl}${PaytmPath.ShowPaymentPage}`, {
          [PaytmQuery.Mid]: this.#mid,
          [PaytmQuery.OrderId]: orderId,
        }),
        fields: { mid: this.#mid, orderId, txnToken },
      },
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      raw: answer,
    };
  }

  /** Fetch Subscription Status (`/subscription/checkStatus`) by Paytm's subscription id. */
  private async statusBody(subscriptionId: string): Promise<PaytmStatusBody> {
    const id = requireText(subscriptionId, 'subscriptionId');
    const body = parseInput(PaytmStatusRequestSchema, { mid: this.#mid, subsId: id }, 'Paytm status request', this.name);
    const answer = await this.call({
      path: PaytmPath.FetchStatus,
      family: PaytmHostFamily.Subscription,
      dialect: PaytmHeadDialect.SubscriptionService,
      body,
      schema: PaytmStatusResponseSchema,
      what: 'subscription status',
      idempotent: true,
    });
    this.failOnResult(resultView(answer.resultInfo), STATUS_SPEC, 'subscription status', answer);
    return answer;
  }

  override async getSubscription(subscriptionId: string): Promise<Subscription> {
    return mapStatusSubscription(subscriptionId, await this.statusBody(subscriptionId));
  }

  /** The subscription after a pause, resume or cancel. The action succeeded, so a failing read must not turn it into an error. */
  private async afterAction(subscriptionId: string, expected: SubscriptionStatus): Promise<Subscription> {
    try {
      return await this.getSubscription(subscriptionId);
    } catch {
      return {
        provider: this.name,
        id: subscriptionId,
        status: expected,
        providerStatus: GATEWAY_STATUS_UNAVAILABLE,
        scheduling: SchedulingMode.Merchant,
      };
    }
  }

  private async setStatus(subscriptionId: string, status: PaytmModifyStatus, what: string): Promise<void> {
    const body = parseInput(
      PaytmModifyRequestSchema,
      { mid: this.#mid, subsId: requireText(subscriptionId, 'subscriptionId'), status },
      'Paytm pause/resume request',
      this.name,
    );
    const answer = await this.call({
      path: PaytmPath.ModifyStatus,
      family: PaytmHostFamily.Subscription,
      dialect: PaytmHeadDialect.SubscriptionService,
      body,
      schema: PaytmActionResponseSchema,
      what,
      idempotent: false,
    });
    this.failOnResult(resultView(answer.resultInfo), MODIFY_SPEC, what, answer);
  }

  /** Pause API: `ACTIVE` -> `SUSPENDED`. Paytm takes no end date, so `resumeAt` is refused rather than dropped. */
  override async pauseSubscription(subscriptionId: string, options?: PauseSubscriptionOptions): Promise<Subscription> {
    const parsed = parseInput(PauseSubscriptionOptionsSchema, options ?? {}, 'pause options', this.name);
    if (parsed.resumeAt !== undefined) {
      throw unsupported(this.name, 'pausing until a date', "Paytm's Pause API has no end date; resume the subscription yourself");
    }
    await this.setStatus(subscriptionId, PaytmModifyStatus.Suspended, 'subscription pause');
    return this.afterAction(subscriptionId, SubscriptionStatus.Paused);
  }

  /** Resume API: `SUSPENDED` -> `ACTIVE`. */
  override async resumeSubscription(subscriptionId: string, options?: ResumeSubscriptionOptions): Promise<Subscription> {
    const parsed = parseInput(ResumeSubscriptionOptionsSchema, options ?? {}, 'resume options', this.name);
    if (parsed.nextChargeAt !== undefined) {
      throw unsupported(this.name, 'choosing the next charge date on resume', "Paytm's Resume API takes no date");
    }
    await this.setStatus(subscriptionId, PaytmModifyStatus.Active, 'subscription resume');
    return this.afterAction(subscriptionId, SubscriptionStatus.Active);
  }

  /**
   * Cancel API: permanent, "cannot be reactivated once cancelled". Repeating it is safe: when the call fails (or its answer is
   * lost) the subscription's state is read, and one that is already over is returned as it is.
   */
  override async cancelSubscription(subscriptionId: string, options?: CancelSubscriptionOptions): Promise<Subscription> {
    const parsed = parseInput(CancelSubscriptionOptionsSchema, options ?? {}, 'cancel options', this.name);
    if (parsed.mode === CancelMode.AtPeriodEnd) {
      throw unsupported(
        this.name,
        'cancelling at the end of the period',
        'a Paytm mandate is cancelled at once; stop the billing schedule instead',
      );
    }
    const body = parseInput(
      PaytmCancelRequestSchema,
      { mid: this.#mid, subsId: requireText(subscriptionId, 'subscriptionId') },
      'Paytm cancel request',
      this.name,
    );
    try {
      const answer = await this.call({
        path: PaytmPath.CancelSubscription,
        family: PaytmHostFamily.Subscription,
        dialect: PaytmHeadDialect.SubscriptionService,
        body,
        schema: PaytmActionResponseSchema,
        what: 'subscription cancellation',
        idempotent: false,
      });
      this.failOnResult(resultView(answer.resultInfo), CANCEL_SPEC, 'subscription cancellation', answer);
    } catch (error) {
      const current = await this.getSubscription(subscriptionId).catch(() => undefined);
      if (current !== undefined && PAYTM_ENDED_STATUSES.includes(current.status)) return current;
      throw error;
    }
    return this.afterAction(subscriptionId, SubscriptionStatus.Cancelled);
  }

  override async updateSubscription(_subscriptionId: string, rawInput: UpdateSubscriptionInput): Promise<Subscription> {
    parseInput(UpdateSubscriptionInputSchema, rawInput, 'subscription update', this.name);
    throw unsupported(this.name, 'updating subscriptions', 'Paytm documents no modify API: cancel the subscription and create a new one');
  }

  // -------------------------------------------------------------------------
  // Pre-debit notification and recurring debit
  // -------------------------------------------------------------------------

  /**
   * Pre-Notify (`/subscription/preNotify`) with `notificationId` as Paytm's `referenceId`. Bank mandates need none ("you can
   * ignore this step"): the mode is read with a status fetch, and for them an accepted notification is returned without a
   * request (and without an `invoiceNumber`, so the debit that follows names no pre-notify). For every other mode, and when
   * the mode cannot be read, the notification is sent: UPI, wallet and cards need one, and the docs disagree only about cards.
   *
   * The reference id is returned as `invoiceNumber`: the scheduler passes it to `createCharge`, which sends it as Renew's
   * `prenotifyReferenceId`. Paytm does not tie the debit's own order id to the notification, so `chargeId` is not set.
   *
   * Paytm answering "duplicate reference id" means an earlier try of this very notification got through: accepted. "Notification
   * already sent" (for the debit, under another reference): accepted, but the debit then names no pre-notify of ours.
   */
  override async notifyCharge(rawInput: NotifyChargeInput): Promise<ChargeNotification> {
    const input = parseInput(NotifyChargeInputSchema, rawInput, 'pre-debit notification', this.name);
    if (input.invoiceNumber !== undefined && !PAYTM_INVOICE_NUMBER_PATTERN.test(input.invoiceNumber)) {
      throw invalid('invoiceNumber must be at most 15 letters and digits: Paytm shows it as invoiceDisplayNo', this.name);
    }
    const status = await this.statusBody(input.subscriptionId);
    const mode = status.subsPaymentInstDetails?.paymentMode ?? status.payMode;
    const base = {
      provider: this.name,
      id: input.notificationId,
      subscriptionId: input.subscriptionId,
      accepted: true,
      amount: input.amount,
      debitAt: input.debitAt,
    } as const;
    if (isBankMandateMode(mode)) {
      return { ...base, providerStatus: PAYTM_PRE_NOTIFY_NOT_REQUIRED, raw: { paymentMode: mode } };
    }

    const body = parseInput(
      PaytmPreNotifyRequestSchema,
      {
        mid: this.#mid,
        subsId: input.subscriptionId,
        txnAmount: rupees(input.amount),
        txnDate: toIstDayMonthYear(toDate(input.debitAt, 'debitAt')),
        txnMessage: this.#config.debitReason,
        referenceId: input.notificationId,
        ...(input.invoiceNumber !== undefined ? { invoiceDisplayNo: input.invoiceNumber } : {}),
      },
      'Paytm pre-notify request',
      this.name,
    );
    const answer = await this.call({
      path: PaytmPath.PreNotify,
      family: PaytmHostFamily.Subscription,
      dialect: PaytmHeadDialect.SubscriptionService,
      body,
      schema: PaytmPreNotifyResponseSchema,
      what: 'pre-debit notification',
      idempotent: false,
    });
    const view = resultView(answer.resultInfo);
    if (view.code === PaytmCode.PreNotifyAlreadySent) {
      return { ...base, providerStatus: PAYTM_PRE_NOTIFY_ALREADY_SENT, raw: answer };
    }
    if (view.code === PaytmCode.PreNotifyDuplicateReference) {
      return { ...base, providerStatus: view.message ?? PAYTM_PRE_NOTIFY_ALREADY_SENT, invoiceNumber: input.notificationId, raw: answer };
    }
    this.failOnResult(view, PRENOTIFY_SPEC, 'pre-debit notification', answer);
    return {
      ...base,
      providerStatus: view.status ?? view.message ?? PaytmSuccessCode.SubscriptionService,
      invoiceNumber: input.notificationId,
      raw: answer,
    };
  }

  /**
   * Renew Subscription (`/subscription/renew`): the merchant-collected debit. `chargeId` is the Paytm `orderId`, which Paytm
   * refuses a second time (code 325): a re-sent id never debits twice, and the refusal is `CONFLICT` (reconcile with
   * `getCharge`). Paytm only acknowledges ("Subscription Txn accepted"), so the charge is `pending`; its end comes from
   * `getCharge` or the payment webhook.
   *
   * Not pre-checked here: the mandate's ceiling, FIX versus VARIABLE amounts and "one collection per cycle" are Paytm's to
   * enforce (905, 913, 928, 931), and each rejection has its own error code. A failure whose code is not one of Paytm's listed
   * refusals is `OUTCOME_UNKNOWN`, never a failed debit.
   */
  override async createCharge(rawInput: CreateChargeInput): Promise<Charge> {
    const input = parseInput(CreateChargeInputSchema, rawInput, 'charge input', this.name);
    const orderId = checkOrderId(input.chargeId, 'chargeId');
    const now = this.now();
    const scheduled = input.scheduledAt !== undefined ? toDate(input.scheduledAt, 'scheduledAt') : undefined;
    // `debitDate` is for a debit on a LATER day: "Not required to process current date debit".
    const later = scheduled !== undefined && toIstDateString(scheduled) > toIstDateString(now) ? scheduled : undefined;
    const body = parseInput(
      PaytmRenewRequestSchema,
      {
        mid: this.#mid,
        orderId,
        txnAmount: { value: rupees(input.amount), currency: PAYTM_CURRENCY },
        subscriptionId: input.subscriptionId,
        ...(later !== undefined ? { debitDate: toIstDateTimeString(later) } : {}),
        ...(input.invoiceNumber !== undefined ? { prenotifyReferenceId: input.invoiceNumber } : {}),
        ...(input.description !== undefined ? { extendInfo: { comments: input.description } } : {}),
      },
      'Paytm renew request',
      this.name,
    );
    const answer = await this.call({
      path: PaytmPath.RenewSubscription,
      family: PaytmHostFamily.Subscription,
      dialect: PaytmHeadDialect.Theia,
      query: { [PaytmQuery.Mid]: this.#mid, [PaytmQuery.OrderId]: orderId },
      body,
      schema: PaytmRenewResponseSchema,
      what: 'recurring debit',
      idempotent: false,
    });
    const view = resultView(answer.resultInfo);
    this.failOnResult(view, RENEW_SPEC, 'recurring debit', answer);
    return mapRenewCharge({
      chargeId: orderId,
      subscriptionId: input.subscriptionId,
      amount: input.amount,
      ...(input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt } : {}),
      view,
      raw: answer,
    });
  }

  /**
   * Transaction Status (`/v3/order/status`) for an order id. `NO_RECORD_FOUND` and "Invalid Order Id" are `NOT_FOUND`: Paytm
   * has no trace of the order. Its other `TXN_FAILURE` codes that are not failed debits (wrong MID, "Server Down") are errors,
   * never a failed charge, because the scheduler would debit again under a new id.
   */
  private async transactionBody(orderId: string): Promise<PaytmTxnStatusBody> {
    const body = parseInput(
      PaytmTxnStatusRequestSchema,
      { mid: this.#mid, orderId: checkOrderId(requireText(orderId, 'chargeId'), 'chargeId') },
      'Paytm transaction status request',
      this.name,
    );
    const answer = await this.call({
      path: PaytmPath.TransactionStatus,
      family: PaytmHostFamily.TransactionStatus,
      dialect: PaytmHeadDialect.Theia,
      body,
      schema: PaytmTxnStatusResponseSchema,
      what: 'transaction status',
      idempotent: true,
    });
    const view = resultView(answer.resultInfo);
    if (view.status === undefined && view.code === undefined) {
      throw new SubscriptionError(ErrorCode.UnexpectedResponse, `${this.name} returned a transaction status without a result`, {
        provider: this.name,
        raw: answer,
      });
    }
    const verdict = view.status?.toUpperCase();
    const declined = view.code === PaytmCode.TxnServerDown && PAYTM_DECLINED_MESSAGE_PATTERN.test(view.message ?? '');
    const mapped = view.code !== undefined && !declined ? TXN_STATUS_ERRORS[view.code] : undefined;
    if (verdict === PaytmTxnStatus.NoRecordFound) {
      throw this.bodyError(
        { code: ErrorCode.NotFound, message: view.message ?? 'no record found', ...(view.code !== undefined ? { providerCode: view.code } : {}) },
        'transaction status',
        answer,
      );
    }
    if (verdict === PaytmTxnStatus.Failure && mapped !== undefined) {
      throw this.bodyError(
        { code: mapped, message: view.message ?? 'no message', ...(view.code !== undefined ? { providerCode: view.code } : {}) },
        'transaction status',
        answer,
      );
    }
    return answer;
  }

  override async getCharge(subscriptionId: string, chargeId: string): Promise<Charge> {
    const body = await this.transactionBody(chargeId);
    return mapTransactionCharge(body, { chargeId, subscriptionId });
  }

  // -------------------------------------------------------------------------
  // Refunds
  // -------------------------------------------------------------------------

  /**
   * Refund API (`/refund/apply`), asynchronous: `refId` is `refundId`, `orderId` is `chargeId`, and Paytm's `txnId` is looked
   * up with Transaction Status first (only a successful debit can be refunded). Paytm does not refund bank-mandate (eNACH)
   * debits: refused when the debit's mode, or the subscription's mode when `subscriptionId` is given, is a bank mandate.
   * The answer is `pending` unless Paytm says it is final. `refId` is unique at Paytm, so repeating a refund cannot refund twice.
   */
  override async refundCharge(rawInput: RefundInput): Promise<Refund> {
    const input = parseInput(RefundInputSchema, rawInput, 'refund input', this.name);
    const transaction = await this.transactionBody(input.chargeId);
    const transactionView = resultView(transaction.resultInfo);
    if (transactionView.status?.toUpperCase() !== PaytmTxnStatus.Success) {
      throw invalid(
        `${input.chargeId} cannot be refunded: Paytm reports it as ${transactionView.status ?? 'unknown'}, and only a successful transaction can be refunded`,
        this.name,
      );
    }
    let mode = transaction.paymentMode;
    if (!isBankMandateMode(mode) && input.subscriptionId !== undefined) {
      const subscription = await this.statusBody(input.subscriptionId);
      mode = subscription.subsPaymentInstDetails?.paymentMode ?? subscription.payMode ?? mode;
    }
    if (isBankMandateMode(mode)) {
      throw unsupported(
        this.name,
        'refunds on eNACH / bank mandate debits',
        'Paytm does not support them: refund the customer yourself',
      );
    }
    const txnId = transaction.txnId;
    if (!txnId) {
      throw new SubscriptionError(ErrorCode.UnexpectedResponse, `${this.name} returned the transaction ${input.chargeId} without its txnId`, {
        provider: this.name,
        raw: transaction,
      });
    }
    const charged = paise(transaction.txnAmount);
    const amount = input.amount ?? charged;
    if (amount === undefined) {
      throw invalid('amount is required: Paytm needs the refund amount and it could not be read from the transaction', this.name);
    }
    if (charged !== undefined && amount > charged) {
      throw invalid(`amount (${amount} paise) is more than the transaction's ${charged} paise`, this.name);
    }

    const body = parseInput(
      PaytmRefundRequestSchema,
      {
        mid: this.#mid,
        txnType: PAYTM_TXN_TYPE_REFUND,
        orderId: input.chargeId,
        txnId,
        refId: input.refundId,
        refundAmount: rupees(amount),
        ...(input.reason !== undefined ? { comments: input.reason } : {}),
      },
      'Paytm refund request',
      this.name,
    );
    const answer = await this.call({
      path: PaytmPath.Refund,
      family: PaytmHostFamily.Refund,
      dialect: PaytmHeadDialect.Theia,
      body,
      schema: PaytmRefundResponseSchema,
      what: 'refund',
      idempotent: false,
    });
    const view = resultView(answer.resultInfo);
    const verdict = view.status?.toUpperCase();
    if (verdict === undefined && view.code === undefined) {
      throw this.bodyError({ code: ErrorCode.OutcomeUnknown, message: 'Paytm answered without a result' }, 'refund', answer);
    }
    if (verdict === PaytmTxnStatus.Failure) {
      const code = view.code !== undefined ? (REFUND_ERRORS[view.code] ?? ErrorCode.ProviderError) : ErrorCode.ProviderError;
      throw this.bodyError(
        { code, message: view.message ?? 'no message', ...(view.code !== undefined ? { providerCode: view.code } : {}) },
        'refund',
        answer,
      );
    }
    return mapRefund({
      refundId: answer.refundId ?? input.refundId,
      refId: input.refundId,
      chargeId: input.chargeId,
      ...(input.subscriptionId !== undefined ? { subscriptionId: input.subscriptionId } : {}),
      amount: paise(answer.refundAmount) ?? amount,
      status: verdict === PaytmTxnStatus.Success ? RefundStatus.Succeeded : RefundStatus.Pending,
      providerStatus: view.status ?? PaytmTxnStatus.Pending,
      ...(parseIstDateTime(answer.txnTimestamp) ? { createdAt: toIso(parseIstDateTime(answer.txnTimestamp) as Date) } : {}),
      raw: answer,
    });
  }

  // -------------------------------------------------------------------------
  // Checkout verification
  // -------------------------------------------------------------------------

  /**
   * `result` is the key-value post Paytm sends to `callbackUrl`. Its `CHECKSUMHASH` is verified over all the other fields
   * (`SIGNATURE_INVALID` otherwise; nothing is read from a result that fails). The result is only a browser's word, and a
   * bank mandate becomes active later, so the subscription's state is then fetched, and `authorized` is true only when Paytm
   * says it is `ACTIVE`. The subscription id is the callback's `SUBS_ID`, or the `subsId` Transaction Status holds for its order.
   * `charge` is the payment the callback describes (the token debit of a trial, or the upfront amount).
   */
  override async verifyCheckout(result: CheckoutResult): Promise<CheckoutVerification> {
    const form = this.toForm(result, 'checkout result');
    this.verifyForm(form, 'checkout result');
    const callback = parseInput(PaytmCallbackSchema, form, 'Paytm checkout result', this.name);

    let subscriptionId = callback.SUBS_ID ?? undefined;
    if (subscriptionId === undefined) {
      const transaction = await this.transactionBody(callback.ORDERID);
      subscriptionId = transaction.subsId ?? undefined;
    }
    if (subscriptionId === undefined) {
      throw new SubscriptionError(
        ErrorCode.UnexpectedResponse,
        `${this.name} checkout result for order ${callback.ORDERID} names no subscription, and Transaction Status holds none for it`,
        { provider: this.name, raw: form },
      );
    }
    const state = await this.statusBody(subscriptionId);
    const subscription = mapStatusSubscription(subscriptionId, state);
    const failedCallback = callback.STATUS?.toUpperCase() === PaytmTxnStatus.Failure;
    const status =
      subscription.status === SubscriptionStatus.Created
        ? failedCallback
          ? SubscriptionStatus.Failed
          : SubscriptionStatus.PendingAuthorization
        : subscription.status;
    const upfront = paise(state.upfrontTxnAmount);
    const charge = mapCallbackCharge(callback, { subscriptionId, ...(upfront !== undefined ? { upfrontPaise: upfront } : {}) });
    return {
      provider: this.name,
      subscriptionId,
      reference: callback.ORDERID,
      authorized: subscription.status === SubscriptionStatus.Active,
      status,
      ...(charge ? { charge } : {}),
      raw: { callback: form, subscription: state },
    };
  }

  /** A key-value post as text fields; a value that is not text cannot have been signed by Paytm's algorithm. */
  private toForm(result: Record<string, unknown>, what: string): PaytmForm {
    const fields: Record<string, string | null> = {};
    for (const [name, value] of Object.entries(result)) {
      if (value === undefined) continue;
      if (typeof value !== 'string' && value !== null) {
        throw invalid(`Paytm ${what} fields must be text, but ${name} is a ${typeof value}: pass the fields exactly as Paytm posted them`, this.name);
      }
      fields[name] = value;
    }
    return parseInput(PaytmFormSchema, fields, `Paytm ${what}`, this.name);
  }

  /**
   * Verifies the `CHECKSUMHASH` of a key-value post over all its other fields. A base64 `+` that a form decoder turned into a
   * space is put back (base64 has no spaces).
   */
  private verifyForm(form: PaytmForm, what: string): void {
    const checksum = form[PAYTM_CHECKSUM_FIELD]?.replace(/ /g, '+');
    assertChecksum(paramsPayload(form), this.#key, checksum, what);
  }

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------

  /**
   * Handles every notification Paytm documents, each verified with its own rule before anything is read from it:
   *
   * - key-value posts (form-encoded, or a flat JSON object): subscription status, payment (renewal or upfront), pre-notify
   *   callback and refund ARN: `CHECKSUMHASH` over all other fields;
   * - JSON `{ head, body }`: Accept Refund and Success Refund: `head.signature` over the text of `body`, checked against the
   *   exact characters received and, if the sender pretty-printed the JSON, against the compact form.
   *
   * Event ids are built from the content (never the salted checksum), so a redelivery has the same id.
   */
  override parseWebhook(request: WebhookRequest): SubscriptionEvent[] {
    const { rawBody } = parseInput(WebhookRequestSchema, request, 'webhook request', this.name);
    const text = rawBody.trim();
    if (!text.startsWith(JSON_BODY_START)) {
      return [this.formWebhook(this.toForm(Object.fromEntries(new URLSearchParams(text)), 'webhook'))];
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (cause) {
      throw new SubscriptionError(ErrorCode.UnexpectedResponse, `${this.name} sent a webhook that is not valid JSON`, {
        provider: this.name,
        cause,
      });
    }
    const envelope = PaytmJsonEnvelopeSchema.safeParse(json);
    if (envelope.success && envelope.data.body !== undefined) return [this.refundWebhook(text, envelope.data)];
    // A flat JSON object of text fields is a key-value post sent as JSON: same checksum rule.
    return [this.formWebhook(parseResponse(PaytmFormSchema, json, 'webhook body', this.name))];
  }

  /**
   * Which documented key-value notification this is is decided by which schema the verified fields satisfy: each requires the
   * fields only its own kind carries (`REFERENCEID` + `NOTIFICATIONSTATUS`; `ORDERID` + `REFID`; `SUBS_ID` + `STATUS`;
   * `ORDERID` + `STATUS`), tried from the most specific to the least. Nothing is read from a form before its checksum verified.
   */
  private formWebhook(form: PaytmForm): SubscriptionEvent {
    this.verifyForm(form, 'webhook');
    const preNotify = PaytmPreNotifyWebhookSchema.safeParse(form);
    if (preNotify.success) return mapPreNotifyWebhook(preNotify.data, form);
    const refundArn = PaytmRefundArnWebhookSchema.safeParse(form);
    if (refundArn.success) return mapRefundArnWebhook(refundArn.data, form);
    const subscription = PaytmSubscriptionWebhookSchema.safeParse(form);
    if (subscription.success) return mapSubscriptionWebhook(subscription.data, form);
    const payment = PaytmPaymentWebhookSchema.safeParse(form);
    if (payment.success) return mapPaymentWebhook(payment.data, form);
    throw new SubscriptionError(ErrorCode.UnexpectedResponse, `${this.name} sent a webhook this adapter does not recognise`, {
      provider: this.name,
      raw: form,
    });
  }

  private refundWebhook(text: string, envelope: z.output<typeof PaytmJsonEnvelopeSchema>): SubscriptionEvent {
    const signature = envelope.head?.signature ?? undefined;
    const exact = jsonMemberText(text, 'body');
    const candidates = [...new Set([exact, JSON.stringify(envelope.body)].filter((candidate): candidate is string => candidate !== undefined))];
    let verified = false;
    for (const candidate of candidates) {
      try {
        assertChecksum(candidate, this.#key, signature, 'webhook');
        verified = true;
        break;
      } catch (error) {
        if (!(error instanceof SubscriptionError) || error.code !== ErrorCode.SignatureInvalid) throw error;
      }
    }
    if (!verified) {
      throw new SubscriptionError(ErrorCode.SignatureInvalid, `${this.name} webhook signature does not match`, { provider: this.name });
    }
    return mapRefundWebhook(parseResponse(PaytmRefundWebhookBodySchema, envelope.body, 'refund webhook', this.name), envelope);
  }
}

export function paytm(config: PaytmConfig, options?: PaytmProviderOptions): PaytmProvider {
  return new PaytmProvider(config, options);
}

