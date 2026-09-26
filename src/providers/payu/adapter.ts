import { randomBytes } from 'node:crypto';
import type { z } from 'zod';
import {
  CancelMode,
  ChangeTiming,
  ContentType,
  ErrorCode,
  HeaderName,
  HttpMethod,
  PaymentMethod,
  Provider,
  SchedulingMode,
  SubscriptionStatus,
  CheckoutKind,
  Currency,
} from '../../constants.js';
import { assertSignature, safeEqual } from '../../crypto.js';
import { SubscriptionError, invalid, parseInput, parseResponse, unsupported } from '../../errors.js';
import { formEncode, type HttpResponse } from '../../http.js';
import { paiseToRupeeNumber, paiseToRupeeString } from '../../money.js';
import { BaseProvider, type GatewayErrorInfo, type ProviderOptions } from '../../provider.js';
import {
  CancelSubscriptionOptionsSchema,
  CreateChargeInputSchema,
  CreateSubscriptionInputSchema,
  NotifyChargeInputSchema,
  RefundInputSchema,
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
  type Plan,
  type Refund,
  type RefundInput,
  type Subscription,
  type SubscriptionEvent,
  type UpdateSubscriptionInput,
  type WebhookRequest,
} from '../../schemas.js';
import { fromIstDateString, resolveFirstChargeAt, toDate, toIso, toIstDateString } from '../../time.js';
import {
  GENERATED_REQUEST_ID_PREFIX,
  GENERATED_REQUEST_ID_RANDOM_BYTES,
  GENERATED_TXNID_PREFIX,
  GENERATED_TXNID_RANDOM_BYTES,
  EMAIL_MAX_LENGTH,
  ID_PART_SEPARATOR,
  INVOICE_NUMBER_PREFIX,
  JSON_BODY_START,
  MANDATE_REVOKE_COMMAND,
  MANDATE_STATUS_COMMAND,
  PAYU_API_URLS,
  PAYU_API_VERSION,
  PAYU_CONSENT_CREATED,
  PAYU_ENACH_CANCELLATION_NOTIFICATION,
  PAYU_PAYMENT_URLS,
  PAYU_PRE_DEBIT_NOT_REQUIRED,
  PAYU_REFUND_ACTION,
  PAYU_MIN_CONSENT_PAISE,
  PAYU_SI_CONSENT,
  PAYU_STATUS_OK,
  PAYU_FREE_TRIAL_FLAG,
  PHONE_MAX_LENGTH,
  PRE_DEBIT_METHODS,
  PayUCommand,
  PayUCommandField,
  PayUConsentField,
  PayUUpiMandateAction,
  PayUWebhookKind,
  REFUND_TOKEN_MAX_LENGTH,
  TXNID_MAX_LENGTH,
  TXNID_PATTERN,
  type ConsentHashLayout,
} from './constants.js';
import {
  cardMandateWebhookHash,
  commandHash,
  consentRequestHash,
  reverseResponseHash,
  upiMandateWebhookHash,
} from './hash.js';
import {
  buildSiDetailsInput,
  checkEmail,
  classifyBodyFailure,
  consentCharge,
  decodeSubscriptionId,
  deriveMandateDates,
  envelopeMessage,
  evaluateConsent,
  formatPhone,
  isNotFoundTransaction,
  mapCardMandateWebhook,
  mapDebitDetail,
  mapEnachCancellationWebhook,
  mapMandateSubscription,
  mapPaymentWebhook,
  mapPreDebit,
  mapRefundResponse,
  mapRefundWebhook,
  mapRevokedSubscription,
  mapUpiMandateWebhook,
  mapVerifiedTransaction,
  pickAuthPayuId,
  refundableAmountPaise,
  sanitizeFirstName,
  sanitizeProductInfo,
  sanitizeRefundRemarks,
  type BodyFailure,
  type BodyFailurePolicy,
  type MandateRef,
} from './mapper.js';
import {
  PayUCardMandateWebhookSchema,
  PayUConfigSchema,
  PayUConsentFormSchema,
  PayUEnachCancellationWebhookSchema,
  PayUEnvelopeSchema,
  PayULooseRecordSchema,
  PayUMandateActionResponseSchema,
  PayUMandateStatusResponseSchema,
  PayUMandateVar1CamelSchema,
  PayUMandateVar1LowerSchema,
  PayUPaymentResponseSchema,
  PayUPreDebitResponseSchema,
  PayUPreDebitVar1Schema,
  PayURefundResponseSchema,
  PayURefundVar9Schema,
  PayURefundWebhookSchema,
  PayUSiDetailsSchema,
  PayUSiTransactionResponseSchema,
  PayUSiTransactionVar1Schema,
  PayUUpiMandateWebhookSchema,
  PayUUpiModifyVar1Schema,
  PayUVerifyPaymentResponseSchema,
  PayUWebhookSniffSchema,
  type ParsedPayUConfig,
  type PayUConfig,
  type PayUPaymentResponse,
  type PayUWebhookSniff,
} from './schemas.js';

const ERROR_TEXT_PREVIEW_CHARS = 200;
const DIGITS_ONLY = /^\d+$/;
/** Mandate and request ids PayU sends as 16+ digit JSON numbers would lose precision in `JSON.parse`; quote them first. */
const BIG_INTEGER_ID = /("(?:authpayuid|authPayuId|authPayuid|authpayuId|mihpayid|request_id)"\s*:\s*)(\d{16,})(?=\s*[,}])/g;

function parseConfig(config: unknown): ParsedPayUConfig {
  const result = PayUConfigSchema.safeParse(config);
  if (result.success) return result.data;
  // Paths and messages only: never the offending values, which may be the salt.
  const issues = result.error.issues
    .map((issue) => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
  throw new SubscriptionError(ErrorCode.Config, `Invalid ${Provider.PayU} config: ${issues}`, { provider: Provider.PayU });
}

export interface PayUProviderOptions extends ProviderOptions {
  /** Id generator for generated txnids and request ids (tests). Receives a prefix and a number of random bytes. */
  generateId?: (prefix: string, randomBytes: number) => string;
}

function defaultGenerateId(prefix: string, bytes: number): string {
  return `${prefix}${ID_PART_SEPARATOR}${randomBytes(bytes).toString('hex')}`;
}

function requireText(value: string | undefined, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${what} is required`, Provider.PayU);
  return value;
}

/** The first non-blank string among the candidates. */
function firstOf(...values: (string | null | undefined)[]): string | undefined {
  return values.find((value) => typeof value === 'string' && value.trim() !== '')?.trim();
}

/**
 * PayU India adapter. PayU does not schedule recurring debits: the merchant
 * (this library's billing scheduler) registers a mandate through a consent
 * transaction, then before every debit calls the pre-debit command and raises
 * the debit with the recurring command.
 *
 * - `createSubscription` makes no network call: it returns the signed form the
 *   customer's browser posts to PayU (`checkout.kind === 'form_post'`).
 * - `verifyCheckout` verifies the response hash PayU appends to `surl` / `furl`
 *   and returns a composite subscription id `<method>:<mihpayid>`, because
 *   PayU's status / revoke / modify commands differ per payment method and the
 *   adapter keeps no state.
 * - Fields with no PayU equivalent are accepted and ignored: `authorizeBy`,
 *   `notifyCustomer`, `metadata`, `idempotencyKey` and `paymentMethods`. PayU's
 *   hosted checkout lets the customer pick the method; the docs define `pg` /
 *   `bankcode` only for merchant-hosted flows that need card, VPA or bank
 *   details this adapter never holds, and no "enforce" parameter at all.
 * - `pause` / `resume`: PayU has no API; the scheduler pauses by not charging.
 */
export class PayUProvider extends BaseProvider {
  readonly name = Provider.PayU;

  /**
   * `signedWebhooks` is false because PayU signs only some of its webhooks:
   * payment webhooks (response hash), card and UPI mandate webhooks (hash) are
   * verified; the eNACH cancellation and refund webhooks carry no signature in
   * the docs and are only normalised with `acceptUnsignedWebhooks`.
   */
  readonly capabilities: Capabilities = {
    provider: Provider.PayU,
    scheduling: [SchedulingMode.Merchant],
    gatewayPlans: false,
    trial: true,
    upfrontAmount: true,
    quantity: false,
    pause: false,
    resume: false,
    cancelAtPeriodEnd: false,
    changePlan: false,
    merchantCharges: true,
    merchantPreDebitNotification: true,
    listCharges: false,
    refunds: true,
    signedWebhooks: false,
    idempotencyKeys: false,
    paymentMethods: [PaymentMethod.Card, PaymentMethod.Upi, PaymentMethod.ENach],
  };

  // Real private fields: invisible to JSON.stringify, console.log and spreads, so the salt cannot leak.
  readonly #key: string;
  readonly #salt: string;
  readonly #layout: ConsentHashLayout;
  readonly #paymentUrl: string;
  readonly #apiUrl: string;
  readonly #acceptUnsignedWebhooks: boolean;
  readonly #successUrl: string | undefined;
  readonly #failureUrl: string | undefined;
  readonly #generateId: (prefix: string, bytes: number) => string;

  constructor(config: PayUConfig, options: PayUProviderOptions = {}) {
    const parsed = parseConfig(config);
    super(options);
    this.#key = parsed.key;
    this.#salt = parsed.salt;
    this.#layout = parsed.consentHashLayout;
    this.#paymentUrl = parsed.paymentUrl ?? PAYU_PAYMENT_URLS[parsed.environment];
    this.#apiUrl = parsed.apiUrl ?? PAYU_API_URLS[parsed.environment];
    this.#acceptUnsignedWebhooks = parsed.acceptUnsignedWebhooks;
    this.#successUrl = parsed.successUrl;
    this.#failureUrl = parsed.failureUrl;
    this.#generateId = options.generateId ?? defaultGenerateId;
  }

  // -------------------------------------------------------------------------
  // HTTP plumbing
  // -------------------------------------------------------------------------

  /**
   * One postservice command: a form POST of `key`, `command`, `var1` and
   * `hash = sha512(key|command|var1|salt)`. `var1` is hashed and sent as the
   * very same string. Only reads are `idempotent`: a write that gets no answer
   * is `OUTCOME_UNKNOWN`.
   */
  private command<S extends z.ZodType>(input: {
    command: PayUCommand;
    var1: string;
    schema: S;
    what: string;
    idempotent: boolean;
    extra?: Record<string, string>;
  }): Promise<z.output<S>> {
    const hash = commandHash({ key: this.#key, salt: this.#salt, command: input.command, var1: input.var1 });
    const body = formEncode({
      [PayUCommandField.Key]: this.#key,
      [PayUCommandField.Command]: input.command,
      [PayUCommandField.Var1]: input.var1,
      ...input.extra,
      [PayUCommandField.Hash]: hash,
    });
    return this.send(
      {
        method: HttpMethod.Post,
        url: this.#apiUrl,
        headers: { [HeaderName.ContentType]: ContentType.Form, [HeaderName.Accept]: ContentType.Json },
        body,
        idempotent: input.idempotent,
      },
      input.schema,
      input.what,
    );
  }

  protected describeError(response: HttpResponse): GatewayErrorInfo {
    const parsed = PayUEnvelopeSchema.safeParse(response.json);
    if (parsed.success) {
      const message = envelopeMessage(parsed.data);
      if (message !== undefined) {
        return { message, ...(parsed.data.errorCode ? { providerCode: parsed.data.errorCode } : {}) };
      }
    }
    const text = response.text.trim();
    return { message: text ? text.slice(0, ERROR_TEXT_PREVIEW_CHARS) : 'empty response body' };
  }

  private bodyError(failure: BodyFailure, what: string, raw: unknown): SubscriptionError {
    const unclear = failure.code === ErrorCode.OutcomeUnknown;
    return new SubscriptionError(
      failure.code,
      `${this.name} ${what}: ${failure.message}${
        unclear ? '. It may or may not have taken effect: fetch the current state before retrying.' : ''
      }`,
      { provider: this.name, providerCode: failure.providerCode, raw },
    );
  }

  /** Throws when a postservice answer (HTTP 200) is a body-level failure. */
  private failOnBody(body: z.output<typeof PayUEnvelopeSchema>, what: string, policy: BodyFailurePolicy): void {
    const failure = classifyBodyFailure(body, policy);
    if (failure) throw this.bodyError(failure, what, body);
  }

  private requestId(): string {
    return this.#generateId(GENERATED_REQUEST_ID_PREFIX, GENERATED_REQUEST_ID_RANDOM_BYTES);
  }

  // -------------------------------------------------------------------------
  // Plans: PayU has no plan API
  // -------------------------------------------------------------------------

  override createPlan(_input: CreatePlanInput): Promise<Plan> {
    return Promise.reject(
      unsupported(this.name, 'creating plans', 'PayU has no plan API; pass the plan inline to createSubscription'),
    );
  }

  override getPlan(_planId: string): Promise<Plan> {
    return Promise.reject(
      unsupported(this.name, 'fetching plans', 'PayU has no plan API; pass the plan inline to createSubscription'),
    );
  }

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------

  /**
   * Builds the signed consent form. No network call; PayU first hears of the
   * subscription when the customer's browser posts `checkout.fields` to
   * `checkout.url`. The returned `id` is the consent `txnid`: after the customer
   * authorises, `verifyCheckout` returns the id to use from then on.
   */
  override async createSubscription(rawInput: CreateSubscriptionInput): Promise<Subscription> {
    const input = parseInput(CreateSubscriptionInputSchema, rawInput, 'subscription input', this.name);
    if (typeof input.plan === 'string') {
      throw invalid(
        'PayU has no plan API, so a plan id cannot be resolved: pass the plan details inline (name, amount, interval) instead of a string',
        this.name,
      );
    }
    const plan = input.plan;
    if (plan.scheduling === SchedulingMode.Gateway) {
      throw unsupported(this.name, 'gateway-scheduled subscriptions', 'PayU never raises recurring debits itself');
    }
    if (input.quantity !== undefined && input.quantity !== 1) {
      throw unsupported(this.name, 'quantity', 'multiply the plan amount yourself');
    }
    // `paymentMethods` cannot be enforced (see the class comment), but a list PayU cannot serve at all is refused.
    if (input.paymentMethods !== undefined && !input.paymentMethods.some((method) => this.capabilities.paymentMethods.includes(method))) {
      throw invalid(
        `PayU recurring payments support ${this.capabilities.paymentMethods.join(', ')}; none of the requested paymentMethods is one of them`,
        this.name,
      );
    }
    if (input.upfrontAmount !== undefined && input.upfrontAmount < PAYU_MIN_CONSENT_PAISE) {
      throw invalid('upfrontAmount must be at least INR 1: it is charged by the consent transaction, whose minimum PayU documents as INR 1', this.name);
    }

    const customer = input.customer;
    const name = requireText(customer.name, 'customer.name (PayU requires firstname)');
    const email = requireText(customer.email, 'customer.email (PayU requires email)');
    const phone = requireText(customer.phone, 'customer.phone (PayU requires phone)');

    const now = this.now();
    const { firstChargeAt, isTrial } = resolveFirstChargeAt(input, now);
    const firstDebit = firstChargeAt ?? now;

    const txnid = input.reference ?? this.#generateId(GENERATED_TXNID_PREFIX, GENERATED_TXNID_RANDOM_BYTES);
    if (txnid.length > TXNID_MAX_LENGTH || !TXNID_PATTERN.test(txnid)) {
      throw invalid(
        `reference "${txnid.slice(0, 40)}" cannot be PayU's txnid: it must be at most ${TXNID_MAX_LENGTH} characters of letters, digits, "_" and "-"`,
        this.name,
      );
    }

    const surl = input.returnUrl ?? this.#successUrl;
    const furl = input.returnUrl ?? this.#failureUrl ?? this.#successUrl;
    if (surl === undefined || furl === undefined) {
      throw invalid('returnUrl is required (or set successUrl in the PayU config): PayU needs surl and furl', this.name);
    }

    // The mandate ceiling per debit, the schedule, and the exact JSON string that is both hashed and posted.
    const totalCycles = input.totalCycles ?? plan.maxCycles;
    const dates = deriveMandateDates({
      firstChargeAt: firstDebit,
      interval: plan.interval,
      ...(totalCycles !== undefined ? { totalCycles } : {}),
      ...(input.mandateEndsAt !== undefined ? { mandateEndsAt: input.mandateEndsAt } : {}),
    });
    const siDetails = parseInput(
      PayUSiDetailsSchema,
      buildSiDetailsInput({ ceilingPaise: plan.maxAmount ?? plan.amount, interval: plan.interval, dates }),
      'PayU si_details',
      this.name,
    );
    const siDetailsJson = JSON.stringify(siDetails);

    const consent = consentCharge(input.upfrontAmount);
    const productinfo = sanitizeProductInfo(plan.name);
    const firstname = sanitizeFirstName(name);
    const safeEmail = checkEmail(email, EMAIL_MAX_LENGTH);
    const safePhone = formatPhone(phone).slice(0, PHONE_MAX_LENGTH);

    const hash = consentRequestHash(
      {
        key: this.#key,
        salt: this.#salt,
        txnid,
        amount: consent.amount,
        productinfo,
        firstname,
        email: safeEmail,
        siDetails: siDetailsJson,
      },
      this.#layout,
    );

    const form = parseInput(
      PayUConsentFormSchema,
      {
        key: this.#key,
        txnid,
        amount: consent.amount,
        productinfo,
        firstname,
        email: safeEmail,
        phone: safePhone,
        surl,
        furl,
        api_version: PAYU_API_VERSION,
        si: PAYU_SI_CONSENT,
        si_details: siDetailsJson,
        ...(consent.freeTrial ? { free_trial: PAYU_FREE_TRIAL_FLAG } : {}),
        hash,
      },
      'PayU consent form',
      this.name,
    );
    // Posted in the order of PayU's own sample form. The salt is not a field and never will be.
    const fields: Record<string, string> = {
      [PayUConsentField.Key]: form.key,
      [PayUConsentField.Txnid]: form.txnid,
      [PayUConsentField.Amount]: form.amount,
      [PayUConsentField.Productinfo]: form.productinfo,
      [PayUConsentField.Firstname]: form.firstname,
      [PayUConsentField.Email]: form.email,
      [PayUConsentField.Phone]: form.phone,
      [PayUConsentField.Surl]: form.surl,
      [PayUConsentField.Furl]: form.furl,
      [PayUConsentField.ApiVersion]: form.api_version,
      [PayUConsentField.SiDetails]: form.si_details,
      [PayUConsentField.Si]: form.si,
      ...(form.free_trial !== undefined ? { [PayUConsentField.FreeTrial]: form.free_trial } : {}),
      [PayUConsentField.Hash]: form.hash,
    };

    const mandateEndsAt = fromIstDateString(dates.end);
    return {
      provider: this.name,
      id: txnid,
      reference: txnid,
      status: SubscriptionStatus.Created,
      providerStatus: PAYU_CONSENT_CREATED,
      scheduling: SchedulingMode.Merchant,
      customer: { name, email, phone },
      amount: plan.amount,
      maxAmount: plan.maxAmount ?? plan.amount,
      currency: Currency.INR,
      interval: plan.interval,
      ...(totalCycles !== undefined ? { totalCycles } : {}),
      createdAt: toIso(now),
      startAt: toIso(firstDebit),
      ...(isTrial ? { trialEndsAt: toIso(firstDebit) } : {}),
      ...(input.mandateEndsAt !== undefined
        ? { mandateEndsAt: input.mandateEndsAt }
        : mandateEndsAt
          ? { mandateEndsAt: toIso(mandateEndsAt) }
          : {}),
      checkout: { kind: CheckoutKind.FormPost, url: this.#paymentUrl, fields },
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      raw: fields,
    };
  }

  override async getSubscription(subscriptionId: string): Promise<Subscription> {
    const ref = decodeSubscriptionId(subscriptionId);
    const body = await this.command({
      command: MANDATE_STATUS_COMMAND[ref.method],
      var1: this.mandateVar1(ref),
      schema: PayUMandateStatusResponseSchema,
      what: 'mandate status',
      idempotent: true,
    });
    this.failOnBody(body, 'mandate status', { unclear: ErrorCode.ProviderUnavailable, otherwise: ErrorCode.ProviderError });
    if (body.status === null || body.status === undefined) {
      throw new SubscriptionError(ErrorCode.UnexpectedResponse, `${this.name} returned a mandate status without a status`, {
        provider: this.name,
        raw: body,
      });
    }
    return mapMandateSubscription(subscriptionId, ref, body);
  }

  /** `{authPayuId, requestId}` for the commands whose page prints camel case; `NB_mandate_status` prints `authpayuid`. */
  private mandateVar1(ref: MandateRef, command: PayUCommand = MANDATE_STATUS_COMMAND[ref.method]): string {
    const requestId = this.requestId();
    if (command === PayUCommand.NbMandateStatus) {
      return JSON.stringify(
        parseInput(PayUMandateVar1LowerSchema, { authpayuid: ref.mandateId, requestId }, 'mandate var1', this.name),
      );
    }
    return JSON.stringify(
      parseInput(PayUMandateVar1CamelSchema, { authPayuId: ref.mandateId, requestId }, 'mandate var1', this.name),
    );
  }

  /**
   * Revokes the mandate with the per-method command: `mandate_revoke` (cards,
   * eNACH) or `upi_mandate_revoke`. RuPay cards need a customer-authenticated
   * `_payment` call instead and are refused by PayU with a body-level error.
   * eNACH is acknowledged and finishes at the bank in T+1 / T+2; it is reported
   * as cancelled at once because PayU stops debits on initiation (ASSUMPTION).
   */
  override async cancelSubscription(subscriptionId: string, options?: CancelSubscriptionOptions): Promise<Subscription> {
    const parsed = parseInput(CancelSubscriptionOptionsSchema, options ?? {}, 'cancel options', this.name);
    if (parsed.mode === CancelMode.AtPeriodEnd) {
      throw unsupported(
        this.name,
        'cancelling at the end of the period',
        'a PayU mandate is revoked immediately; stop the billing schedule instead',
      );
    }
    const ref = decodeSubscriptionId(subscriptionId);
    const command = MANDATE_REVOKE_COMMAND[ref.method];
    const body = await this.command({
      command,
      var1: this.mandateVar1(ref, command),
      schema: PayUMandateActionResponseSchema,
      what: 'mandate revoke',
      idempotent: false,
    });
    this.failOnBody(body, 'mandate revoke', { unclear: ErrorCode.OutcomeUnknown, otherwise: ErrorCode.ProviderError });
    this.requireOk(body.status, body, 'mandate revoke');
    return mapRevokedSubscription(subscriptionId, ref, body, this.now());
  }

  /**
   * Only UPI mandates can be modified server to server (`upi_mandate_modify`,
   * `amount` and `endDate`, collect mandates only, and the customer must approve
   * in their PSP app). Cards need a customer-authenticated `_payment` call
   * (`si=3`) and eNACH has no modify API. The returned subscription is the
   * mandate as PayU reports it right after the request, which still shows the
   * old values until the customer approves.
   */
  override async updateSubscription(subscriptionId: string, rawInput: UpdateSubscriptionInput): Promise<Subscription> {
    const input = parseInput(UpdateSubscriptionInputSchema, rawInput, 'subscription update', this.name);
    const ref = decodeSubscriptionId(subscriptionId);
    if (ref.method !== PaymentMethod.Upi) {
      throw unsupported(
        this.name,
        `modifying a ${ref.method} mandate`,
        ref.method === PaymentMethod.Card
          ? 'cards need the customer to re-authenticate through a new _payment transaction (si=3)'
          : 'PayU documents no modify API for eNACH mandates',
      );
    }
    for (const [field, value] of [
      ['planId', input.planId],
      ['quantity', input.quantity],
      ['remainingCycles', input.remainingCycles],
      ['nextChargeAt', input.nextChargeAt],
    ] as const) {
      if (value !== undefined) throw unsupported(this.name, `changing ${field}`, 'a PayU mandate holds only an amount ceiling and an end date');
    }
    if (input.timing === ChangeTiming.AtPeriodEnd) {
      throw unsupported(this.name, 'scheduling a mandate change for the end of the period');
    }

    const var1 = JSON.stringify(
      parseInput(
        PayUUpiModifyVar1Schema,
        {
          requestId: this.requestId(),
          authPayuId: ref.mandateId,
          ...(input.mandateEndsAt !== undefined ? { endDate: toIstDateString(toDate(input.mandateEndsAt, 'mandateEndsAt')) } : {}),
          ...(input.amount !== undefined ? { amount: paiseToRupeeNumber(input.amount) } : {}),
        },
        'mandate modify var1',
        this.name,
      ),
    );
    const body = await this.command({
      command: PayUCommand.UpiMandateModify,
      var1,
      schema: PayUMandateActionResponseSchema,
      what: 'mandate modify',
      idempotent: false,
    });
    this.failOnBody(body, 'mandate modify', { unclear: ErrorCode.OutcomeUnknown, otherwise: ErrorCode.ProviderError });
    this.requireOk(body.status, body, 'mandate modify');
    const current = await this.getSubscription(subscriptionId);
    return { ...current, raw: { update: body, mandate: current.raw } };
  }

  private requireOk(status: string | number | null | undefined, body: unknown, what: string): void {
    if (status === null || status === undefined || String(status) !== String(PAYU_STATUS_OK)) {
      throw new SubscriptionError(
        ErrorCode.UnexpectedResponse,
        `${this.name} ${what} answered without a success status; fetch the mandate's state before retrying`,
        { provider: this.name, raw: body },
      );
    }
  }

  // -------------------------------------------------------------------------
  // Pre-debit notification and recurring debit
  // -------------------------------------------------------------------------

  /**
   * `pre_debit_SI` for cards and UPI. eNACH needs none ("Do not call the
   * pre_debit_SI API for an eNACH recurring debit"): the scheduler still asks,
   * and gets an accepted notification without any request being made. A
   * duplicate-notification code (`E9254`) counts as accepted: it is what PayU
   * answers when a retry follows a notification that did get through.
   */
  override async notifyCharge(rawInput: NotifyChargeInput): Promise<ChargeNotification> {
    const input = parseInput(NotifyChargeInputSchema, rawInput, 'pre-debit notification', this.name);
    const ref = decodeSubscriptionId(input.subscriptionId);
    const invoiceNumber = input.invoiceNumber ?? `${INVOICE_NUMBER_PREFIX}${ID_PART_SEPARATOR}${input.notificationId}`;

    if (!PRE_DEBIT_METHODS.includes(ref.method)) {
      return {
        provider: this.name,
        id: input.notificationId,
        subscriptionId: input.subscriptionId,
        accepted: true,
        providerStatus: PAYU_PRE_DEBIT_NOT_REQUIRED,
        amount: input.amount,
        debitAt: input.debitAt,
        invoiceNumber,
        raw: null,
      };
    }

    const var1 = JSON.stringify(
      parseInput(
        PayUPreDebitVar1Schema,
        {
          authpayuid: ref.mandateId,
          requestId: input.notificationId,
          amount: paiseToRupeeString(input.amount),
          debitDate: toIstDateString(toDate(input.debitAt, 'debitAt')),
          invoiceDisplayNumber: invoiceNumber,
        },
        'pre-debit var1',
        this.name,
      ),
    );
    const body = await this.command({
      command: PayUCommand.PreDebit,
      var1,
      schema: PayUPreDebitResponseSchema,
      what: 'pre-debit notification',
      idempotent: false,
    });
    // Anything PayU says with status 0 that is not a recognised error is "retry later": `accepted: false`.
    this.failOnBody(body, 'pre-debit notification', { unclear: ErrorCode.OutcomeUnknown, otherwise: null });
    if (body.status === null || body.status === undefined) {
      throw new SubscriptionError(ErrorCode.UnexpectedResponse, `${this.name} returned a pre-debit answer without a status`, {
        provider: this.name,
        raw: body,
      });
    }
    return mapPreDebit({
      notificationId: input.notificationId,
      subscriptionId: input.subscriptionId,
      amountPaise: input.amount,
      debitAt: input.debitAt,
      invoiceNumber,
      body,
    });
  }

  /**
   * `si_transaction`. NOT idempotent: a dropped connection is `OUTCOME_UNKNOWN`
   * and so is any body-level failure this adapter cannot classify; reconcile
   * with `getCharge` before retrying. `scheduledAt` is ignored: PayU debits when
   * called. Cards need the `invoiceNumber` of the pre-debit (the scheduler
   * passes it); without one an invoice number is generated from the charge id.
   *
   * PayU does NOT reject a repeated `txnid`: the same `txnid` sent again produces another
   * debit, and `verify_payment` shows only the latest. So the adapter looks the `txnid` up first
   * and, when PayU already holds it, returns that debit instead of raising another one.
   * A lookup that fails for any reason other than "not found" aborts before debiting.
   */
  override async createCharge(rawInput: CreateChargeInput): Promise<Charge> {
    const input = parseInput(CreateChargeInputSchema, rawInput, 'charge input', this.name);
    const ref = decodeSubscriptionId(input.subscriptionId);
    const existing = await this.findDebit(input.chargeId);
    if (existing !== undefined) {
      return mapVerifiedTransaction({
        transaction: existing,
        chargeId: input.chargeId,
        subscriptionId: input.subscriptionId,
        method: ref.method,
      });
    }
    const needsInvoice = PRE_DEBIT_METHODS.includes(ref.method);
    const customer = input.customer;
    const var1 = JSON.stringify(
      parseInput(
        PayUSiTransactionVar1Schema,
        {
          authpayuid: ref.mandateId,
          ...(needsInvoice
            ? { invoiceDisplayNumber: input.invoiceNumber ?? `${INVOICE_NUMBER_PREFIX}${ID_PART_SEPARATOR}${input.chargeId}` }
            : {}),
          amount: paiseToRupeeString(input.amount),
          txnid: input.chargeId,
          ...(customer?.phone !== undefined ? { phone: formatPhone(customer.phone) } : {}),
          ...(customer?.email !== undefined ? { email: customer.email } : {}),
        },
        'recurring debit var1',
        this.name,
      ),
    );
    const body = await this.command({
      command: PayUCommand.SiTransaction,
      var1,
      schema: PayUSiTransactionResponseSchema,
      what: 'recurring debit',
      idempotent: false,
    });
    this.failOnBody(body, 'recurring debit', { unclear: ErrorCode.OutcomeUnknown, otherwise: ErrorCode.OutcomeUnknown });

    const details = body.details;
    const detail =
      details && !Array.isArray(details)
        ? (details[input.chargeId] ??
          Object.values(details).find((candidate) => firstOf(candidate.transactionid) === input.chargeId))
        : undefined;
    if (!detail) {
      throw new SubscriptionError(
        ErrorCode.UnexpectedResponse,
        `${this.name} answered the recurring debit without a result for transaction ${input.chargeId}; ` +
          'it may or may not have been raised: fetch it with getCharge before retrying',
        { provider: this.name, raw: body },
      );
    }
    return mapDebitDetail({
      detail,
      chargeId: input.chargeId,
      requestedPaise: input.amount,
      subscriptionId: input.subscriptionId,
      method: ref.method,
    });
  }

  /**
   * The state of a debit by its merchant `txnid`, through `verify_payment`.
   * PayU answers an unknown txnid with "Not Found"; that is `NOT_FOUND`, which
   * the scheduler reads as "this debit never reached PayU".
   */
  override async getCharge(subscriptionId: string, chargeId: string): Promise<Charge> {
    const ref = decodeSubscriptionId(subscriptionId);
    const { transaction } = await this.fetchTransaction(chargeId);
    return mapVerifiedTransaction({ transaction, chargeId, subscriptionId, method: ref.method });
  }

  /** The transaction PayU holds under this merchant `txnid`, or `undefined` when it has none. Any other failure propagates. */
  private async findDebit(txnid: string) {
    try {
      return (await this.fetchTransaction(txnid)).transaction;
    } catch (error) {
      if (error instanceof SubscriptionError && error.code === ErrorCode.NotFound) return undefined;
      throw error;
    }
  }

  private async fetchTransaction(txnid: string) {
    const id = requireText(txnid, 'chargeId');
    if (id.includes('|')) throw invalid('chargeId must not contain "|": PayU reads it as a list of transactions', this.name);
    const body = await this.command({
      command: PayUCommand.VerifyPayment,
      var1: id,
      schema: PayUVerifyPaymentResponseSchema,
      what: 'transaction lookup',
      idempotent: true,
    });
    const details = body.transaction_details;
    const transaction = details?.[id] ?? Object.values(details ?? {}).find((candidate) => firstOf(candidate.txnid) === id);
    if (isNotFoundTransaction(transaction, envelopeMessage(body))) {
      throw new SubscriptionError(ErrorCode.NotFound, `${this.name} has no transaction ${id}`, {
        provider: this.name,
        raw: body,
      });
    }
    this.failOnBody(body, 'transaction lookup', { unclear: ErrorCode.ProviderUnavailable, otherwise: ErrorCode.ProviderError });
    if (!transaction) {
      throw new SubscriptionError(ErrorCode.UnexpectedResponse, `${this.name} returned no result for transaction ${id}`, {
        provider: this.name,
        raw: body,
      });
    }
    return { transaction, body };
  }

  // -------------------------------------------------------------------------
  // Refunds
  // -------------------------------------------------------------------------

  /**
   * `cancel_refund_transaction`. `chargeId` is a Charge id: PayU's payment id
   * (`mihpayid`) or the merchant `txnid`. It is first looked up as a txnid, so a
   * debit whose payment id was not yet known at creation can still be refunded;
   * an id PayU does not know as a txnid, made of digits, is used as the payment
   * id. Refunds are not supported by banks for eNACH (PayU error 232).
   */
  override async refundCharge(rawInput: RefundInput): Promise<Refund> {
    const input = parseInput(RefundInputSchema, rawInput, 'refund input', this.name);
    if (input.refundId.length > REFUND_TOKEN_MAX_LENGTH) {
      throw invalid(
        `refundId is longer than the ${REFUND_TOKEN_MAX_LENGTH} characters PayU accepts for a refund token`,
        this.name,
      );
    }
    if (input.subscriptionId !== undefined) decodeSubscriptionId(input.subscriptionId);

    let payuId: string;
    let defaultAmount: number | undefined;
    try {
      const { transaction } = await this.fetchTransaction(input.chargeId);
      const found = firstOf(transaction.mihpayid);
      if (found === undefined) throw invalid(`PayU holds transaction ${input.chargeId} without a payment id`, this.name);
      payuId = found;
      defaultAmount = refundableAmountPaise(transaction);
    } catch (error) {
      if (!(error instanceof SubscriptionError) || error.code !== ErrorCode.NotFound || !DIGITS_ONLY.test(input.chargeId)) {
        throw error;
      }
      payuId = input.chargeId;
    }
    const amount = input.amount ?? defaultAmount;
    if (amount === undefined || amount <= 0) {
      throw invalid('amount is required: PayU needs the refund amount and it could not be read from the transaction', this.name);
    }

    const remarks = input.reason !== undefined ? sanitizeRefundRemarks(input.reason) : '';
    const extra: Record<string, string> = {
      [PayUCommandField.Var2]: input.refundId,
      [PayUCommandField.Var3]: paiseToRupeeString(amount),
      ...(remarks !== ''
        ? { [PayUCommandField.Var9]: JSON.stringify(parseInput(PayURefundVar9Schema, { refundDetails: { remarks } }, 'refund var9', this.name)) }
        : {}),
    };
    // The hash covers only var1 (the payment id); var2, var3 and var9 are posted unhashed. [hashing page, SDK]
    const body = await this.command({
      command: PayUCommand.RefundTransaction,
      var1: payuId,
      schema: PayURefundResponseSchema,
      what: 'refund',
      idempotent: false,
      extra,
    });
    const mapped = mapRefundResponse({
      body,
      chargeId: input.chargeId,
      refundToken: input.refundId,
      amountPaise: amount,
      ...(input.subscriptionId !== undefined ? { subscriptionId: input.subscriptionId } : {}),
    });
    if ('failure' in mapped) {
      const refined =
        mapped.failure.providerCode === undefined
          ? classifyBodyFailure(body, { unclear: ErrorCode.OutcomeUnknown, otherwise: ErrorCode.ProviderError })
          : undefined;
      throw this.bodyError(refined ?? mapped.failure, 'refund', body);
    }
    return mapped.refund;
  }

  // -------------------------------------------------------------------------
  // Checkout verification
  // -------------------------------------------------------------------------

  /** Verifies the response hash of a `_payment` result (`surl` / `furl` fields or a payment webhook). */
  private assertPaymentHash(fields: PayUPaymentResponse, what: string): void {
    const expected = reverseResponseHash({
      key: this.#key,
      salt: this.#salt,
      status: fields.status,
      email: fields.email ?? '',
      firstname: fields.firstname ?? '',
      productinfo: fields.productinfo ?? '',
      amount: fields.amount,
      txnid: fields.txnid,
      udf1: fields.udf1 ?? '',
      udf2: fields.udf2 ?? '',
      udf3: fields.udf3 ?? '',
      udf4: fields.udf4 ?? '',
      udf5: fields.udf5 ?? '',
      ...(firstOf(fields.additional_charges, fields.additionalCharges) !== undefined
        ? { additionalCharges: firstOf(fields.additional_charges, fields.additionalCharges) as string }
        : {}),
    });
    assertSignature(expected, fields.hash?.trim().toLowerCase(), this.name, what);
  }

  /**
   * `result` is what PayU posts to `surl` / `furl`. The response hash is
   * verified first (`SIGNATURE_INVALID` on mismatch), then the outcome follows
   * PayU's documented rule: `status` = `success` and `payment_source` = `sist`
   * (and, for cards, a `cardToken`). eNACH is registered with the bank
   * afterwards (up to T+2), so it is `pending_authorization` until
   * `getSubscription` reports the mandate active. The returned `charge` is the
   * consent payment; with the free-trial consent that is INR 2.00 the merchant
   * has to refund.
   */
  override async verifyCheckout(result: CheckoutResult): Promise<CheckoutVerification> {
    const fields = parseInput(PayUPaymentResponseSchema, result, 'PayU checkout result', this.name);
    this.assertPaymentHash(fields, 'checkout result');
    const outcome = evaluateConsent(fields);
    return {
      provider: this.name,
      subscriptionId: outcome.subscriptionId,
      reference: fields.txnid,
      authorized: outcome.authorized,
      status: outcome.status,
      charge: outcome.charge,
      raw: fields,
    };
  }

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------

  /**
   * Handles the webhook bodies PayU documents:
   *
   * - payment webhooks (form-encoded, response `hash`): the consent result and
   *   recurring debits. Verified.
   * - card mandate webhooks (JSON, `hash`): modified / cancelled by the issuer. Verified.
   * - UPI mandate webhooks (JSON, `hash`): paused / unpaused / revoked by the customer. Verified.
   * - eNACH cancellation and refund webhooks (JSON): PayU documents no signature. They
   *   are `unknown` events unless `acceptUnsignedWebhooks` is set, so a forged one
   *   cannot cancel a schedule. Only the merchant `key`, where present, is checked.
   *
   * A signed body whose hash does not verify throws `SIGNATURE_INVALID`.
   */
  override parseWebhook(request: WebhookRequest): SubscriptionEvent[] {
    const { rawBody } = parseInput(WebhookRequestSchema, request, 'webhook request', this.name);
    const text = rawBody.trim();
    if (!text.startsWith(JSON_BODY_START)) return [this.paymentWebhook(Object.fromEntries(new URLSearchParams(text)))];

    let json: unknown;
    try {
      json = JSON.parse(text.replace(BIG_INTEGER_ID, '$1"$2"'));
    } catch (cause) {
      throw new SubscriptionError(ErrorCode.UnexpectedResponse, `${this.name} sent a webhook that is not valid JSON`, {
        provider: this.name,
        cause,
      });
    }
    const record = parseResponse(PayULooseRecordSchema, json, 'webhook body', this.name);
    switch (this.webhookKind(parseResponse(PayUWebhookSniffSchema, record, 'webhook body', this.name))) {
      case PayUWebhookKind.UpiMandate:
        return [this.upiMandateWebhook(record)];
      case PayUWebhookKind.Refund:
        return [this.refundWebhook(record)];
      case PayUWebhookKind.EnachCancellation:
        return [this.enachWebhook(record)];
      case PayUWebhookKind.CardMandate:
        return [this.cardMandateWebhook(record)];
      default:
        throw new SubscriptionError(ErrorCode.UnexpectedResponse, `${this.name} sent a webhook this adapter does not recognise`, {
          provider: this.name,
          raw: record,
        });
    }
  }

  /**
   * Which documented body this is. The eNACH cancellation is the one JSON body
   * with a `notificationType` and no `hash` that is accepted without one; a
   * card-style body that lacks its hash is a card webhook and fails verification.
   */
  private webhookKind(sniff: PayUWebhookSniff): PayUWebhookKind | undefined {
    const upiActions: readonly string[] = Object.values(PayUUpiMandateAction);
    if (sniff.action && upiActions.includes(sniff.action)) return PayUWebhookKind.UpiMandate;
    if (sniff.action && sniff.action.toLowerCase() === PAYU_REFUND_ACTION) return PayUWebhookKind.Refund;
    if (sniff.notificationType) {
      const unsignedCancellation =
        sniff.notificationType === PAYU_ENACH_CANCELLATION_NOTIFICATION &&
        sniff.statusCode !== undefined &&
        sniff.statusCode !== null &&
        sniff.hash === undefined;
      return unsignedCancellation ? PayUWebhookKind.EnachCancellation : PayUWebhookKind.CardMandate;
    }
    return undefined;
  }

  private paymentWebhook(form: Record<string, string>): SubscriptionEvent {
    const fields = parseResponse(PayUPaymentResponseSchema, form, 'payment webhook', this.name);
    this.assertPaymentHash(fields, 'webhook');
    return mapPaymentWebhook(fields);
  }

  private cardMandateWebhook(record: Record<string, unknown>): SubscriptionEvent {
    const body = parseResponse(PayUCardMandateWebhookSchema, record, 'card mandate webhook', this.name);
    const details = body.si_details;
    const mandateId = pickAuthPayuId(body.authPayuId, body.authpayuid, body.authpayuId) ?? '';
    // PayU prints billingAmount as a number (101) in its samples; hash the text it may have signed.
    this.assertAnyHash(
      amountCandidates(details?.billingAmount).map((billingAmount) =>
        cardMandateWebhookHash({
          salt: this.#salt,
          status: body.status,
          authpayuid: mandateId,
          notificationType: body.notificationType,
          billingAmount,
          paymentStartDate: details?.paymentStartDate ?? '',
          paymentEndDate: details?.paymentEndDate ?? '',
          message: body.message ?? '',
          eventDate: body.eventDate ?? '',
          key: body.key ?? '',
          udf1: body.udf1 ?? '',
          udf2: body.udf2 ?? '',
          udf3: body.udf3 ?? '',
          udf4: body.udf4 ?? '',
          udf5: body.udf5 ?? '',
        }),
      ),
      body.hash,
    );
    return mapCardMandateWebhook(body);
  }

  private upiMandateWebhook(record: Record<string, unknown>): SubscriptionEvent {
    const body = parseResponse(PayUUpiMandateWebhookSchema, record, 'UPI mandate webhook', this.name);
    const mandateId = pickAuthPayuId(body.authpayuid, body.authPayuId) ?? '';
    this.assertAnyHash(
      amountCandidates(body.amount).map((amount) =>
        upiMandateWebhookHash({
          salt: this.#salt,
          status: body.status,
          action: body.action,
          authpayuid: mandateId,
          dateTime: body.dateTime ?? '',
          amount,
          endDate: body.endDate ?? '',
        }),
      ),
      body.hash,
    );
    return mapUpiMandateWebhook(body);
  }

  private enachWebhook(record: Record<string, unknown>): SubscriptionEvent {
    const body = parseResponse(PayUEnachCancellationWebhookSchema, record, 'eNACH cancellation webhook', this.name);
    this.assertKey(body.key);
    return mapEnachCancellationWebhook(body, this.#acceptUnsignedWebhooks);
  }

  private refundWebhook(record: Record<string, unknown>): SubscriptionEvent {
    const body = parseResponse(PayURefundWebhookSchema, record, 'refund webhook', this.name);
    this.assertKey(body.key);
    return mapRefundWebhook(body, this.#acceptUnsignedWebhooks);
  }

  /** `SIGNATURE_INVALID` unless the received hash equals one of the (equivalent) expected hashes. */
  private assertAnyHash(expected: readonly string[], received: string | null | undefined): void {
    const got = received?.trim().toLowerCase();
    if (!got || !expected.some((candidate) => safeEqual(candidate, got))) {
      throw new SubscriptionError(ErrorCode.SignatureInvalid, `${this.name} webhook signature does not match`, {
        provider: this.name,
      });
    }
  }

  /** The only check an unsigned webhook allows: it must be addressed to this merchant key. */
  private assertKey(key: string | null | undefined): void {
    if (key !== null && key !== undefined && key.trim() !== '' && key.trim() !== this.#key) {
      throw new SubscriptionError(ErrorCode.SignatureInvalid, `${this.name} webhook is not addressed to this merchant key`, {
        provider: this.name,
      });
    }
  }
}

/** A JSON amount as the text PayU may have hashed: a string as is; a number as `101` and `101.00`. */
function amountCandidates(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value === 'number' && Number.isFinite(value)) return [...new Set([String(value), value.toFixed(2)])];
  return [''];
}

export function payu(config: PayUConfig, options?: PayUProviderOptions): PayUProvider {
  return new PayUProvider(config, options);
}
