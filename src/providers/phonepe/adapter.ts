import { randomBytes } from 'node:crypto';
import type { z } from 'zod';
import {
  CancelMode,
  ContentType,
  DigestEncoding,
  ErrorCode,
  HashAlgorithm,
  HeaderName,
  HttpMethod,
  PaymentMethod,
  Provider,
  SchedulingMode,
  SubscriptionStatus,
  TERMINAL_SUBSCRIPTION_STATUSES,
} from '../../constants.js';
import { assertSignature, getHeader, hash } from '../../crypto.js';
import { SubscriptionError, invalid, parseInput, parseResponse, unsupported } from '../../errors.js';
import { formEncode, withQuery, type HttpResponse } from '../../http.js';
import { BaseProvider, type GatewayErrorInfo, type ProviderOptions } from '../../provider.js';
import {
  CancelSubscriptionOptionsSchema,
  CreateChargeInputSchema,
  CreateSubscriptionInputSchema,
  NotifyChargeInputSchema,
  RefundInputSchema,
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
import { PhonePeTokenManager, redactSecrets } from './auth.js';
import {
  GENERATED_SUBSCRIPTION_ID_PREFIX,
  GENERATED_SUBSCRIPTION_ID_RANDOM_BYTES,
  ID_PART_SEPARATOR,
  MAX_ERROR_TEXT,
  MIN_NOTIFY_PAISE,
  NOTIFICATION_STATES,
  ORDER_NOT_FOUND_CODES,
  PHONEPE_AUTH_SCHEME,
  PHONEPE_BASE_URLS,
  PHONEPE_DETAILS_ALL,
  PHONEPE_DETAILS_QUERY,
  PHONEPE_GRANT_TYPE,
  PHONEPE_TOKEN_URLS,
  PhonePeErrorCode,
  PhonePeOrderState,
  PhonePePath,
  PhonePeRetryStrategy,
  PhonePePaymentFlowType,
  REDEEMED_STATES,
  CANCEL_ACCEPTED_STATUS,
  RETURN_SUBSCRIPTION_ID_PARAM,
  SETUP_FLOW_TYPES,
} from './constants.js';
import {
  assertMerchantId,
  assertSubscriptionId,
  cancelledSubscription,
  createdSubscription,
  describeErrorBody,
  errorCodeFor,
  expiredNotificationCharge,
  mapNotification,
  mapOrderCharge,
  mapRedeemCharge,
  mapRefund,
  mapSetupOrderAsSubscription,
  mapSubscriptionStatus,
  mapWebhook,
  planSetup,
  returnUrlFor,
  setupOrderIdFor,
  windowExpired,
  windowNotOpen,
  type OrderLike,
} from './mapper.js';
import {
  PhonePeConfigSchema,
  PhonePeErrorBodySchema,
  PhonePeNotifyRequestSchema,
  PhonePeNotifyResponseSchema,
  PhonePeOrderSchema,
  PhonePePayResponseSchema,
  PhonePeRedeemRequestSchema,
  PhonePeRedeemResponseSchema,
  PhonePeRefundRequestSchema,
  PhonePeRefundResponseSchema,
  PhonePeReturnParamsSchema,
  PhonePeSetupRequestSchema,
  PhonePeSubscriptionStatusSchema,
  PhonePeTokenRequestSchema,
  PhonePeTokenResponseSchema,
  PhonePeWebhookSchema,
  type ParsedPhonePeConfig,
  type PhonePeConfig,
  type PhonePeOrder,
  type PhonePeTokenResponse,
} from './schemas.js';

function parseConfig(config: unknown): ParsedPhonePeConfig {
  const result = PhonePeConfigSchema.safeParse(config);
  if (result.success) return result.data;
  // Paths and messages only: never the offending values, which may be the client secret.
  const issues = result.error.issues
    .map((issue) => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
  throw new SubscriptionError(ErrorCode.Config, `Invalid ${Provider.PhonePe} config: ${issues}`, { provider: Provider.PhonePe });
}

export interface PhonePeProviderOptions extends ProviderOptions {
  /** Generator of the subscription id used when `reference` is not given (tests). */
  generateId?: () => string;
}

function defaultGenerateId(): string {
  return [GENERATED_SUBSCRIPTION_ID_PREFIX, randomBytes(GENERATED_SUBSCRIPTION_ID_RANDOM_BYTES).toString('hex')].join(ID_PART_SEPARATOR);
}

/**
 * The errors of API calls whose access token PhonePe refused (HTTP 401). A WeakSet and not a look at the error's fields: a
 * failure of the TOKEN request itself (wrong client secret, also a 401 from PhonePe) must never be mistaken for it, or
 * the adapter would keep asking for tokens.
 */
/** HTTP status of a refused token. */
const HTTP_UNAUTHORIZED = 401;

const REJECTED_TOKEN_ERRORS = new WeakSet<object>();

function isRejectedToken(error: unknown): boolean {
  return typeof error === 'object' && error !== null && REJECTED_TOKEN_ERRORS.has(error);
}

interface ApiRequest {
  method: HttpMethod;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  /** True only for reads: a write that gets no answer is `OUTCOME_UNKNOWN`. */
  idempotent: boolean;
  /**
   * Repeat the call once, with a new token, when PhonePe answers 401. Only for calls that are safe to repeat: reads, and
   * the setup (a repeated `merchantOrderId` is refused by PhonePe, never doubled [G-CREATE]). Writes that move money are
   * repeated by re-running the whole read-then-write flow (see `afterTokenRejection`).
   */
  repeatOn401: boolean;
}

/**
 * PhonePe Autopay adapter (UPI mandates), on the Standard Checkout family of endpoints. PhonePe does not schedule
 * recurring debits: the merchant (this library's billing scheduler) sets up a mandate through PhonePe's hosted checkout,
 * then drives every debit itself with the same pair of calls: NOTIFY (the mandatory pre-debit notification), a wait of at
 * least 24 hours, then REDEEM with the SAME `merchantOrderId`. The amount is fixed by the notification.
 *
 * - `createSubscription` calls `POST /checkout/v2/pay` and returns PhonePe's `redirectUrl` as a redirect checkout. The id
 *   of the subscription is the `merchantSubscriptionId` (the caller's `reference`, or generated); the setup order's id is
 *   derived from it (`setupOrderIdFor`) so no storage is needed.
 * - `notifyCharge` returns the notification's id as `chargeId`: the scheduler then uses it as the id of the debit
 *   (`createCharge` / `getCharge` take it as `merchantOrderId`).
 * - Customers pause, un-pause and revoke in their UPI app (webhooks tell you); only cancel is a merchant API.
 *   `pause` / `resume` are therefore `unsupported` here: the scheduler pauses by not charging.
 * - Fields with no PhonePe equivalent are accepted and ignored: `notifyCustomer`, `idempotencyKey`, `quantity` of 1,
 *   `customer` (kept on the returned subscription), `metadata` keys other than `udf1`-`udf15` (kept on the returned
 *   subscription), and the invoice number and `debitAt` of a notification.
 *
 * Authentication: an OAuth client-credentials token, cached until shortly before its expiry, one in-flight token request
 * shared between concurrent calls, one refresh-and-repeat on a 401 where repeating is safe.
 */
export class PhonePeProvider extends BaseProvider {
  readonly name = Provider.PhonePe;

  readonly capabilities: Capabilities = {
    provider: Provider.PhonePe,
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
    signedWebhooks: true,
    idempotencyKeys: false,
    paymentMethods: [PaymentMethod.Upi],
  };

  // Real private fields: invisible to JSON.stringify, console.log and spreads, so the secrets cannot leak.
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #clientVersion: string;
  readonly #apiUrl: string;
  readonly #tokenUrl: string;
  readonly #redirectUrl: string | undefined;
  /** `sha256(username:password)`, the value PhonePe sends in the webhook's `Authorization` header. */
  readonly #webhookAuthorization: string | undefined;
  readonly #tokens: PhonePeTokenManager;
  readonly #generateId: () => string;

  constructor(config: PhonePeConfig, options: PhonePeProviderOptions = {}) {
    const parsed = parseConfig(config);
    super(options);
    this.#clientId = parsed.clientId;
    this.#clientSecret = parsed.clientSecret;
    this.#clientVersion = parsed.clientVersion;
    this.#apiUrl = (parsed.apiUrl ?? PHONEPE_BASE_URLS[parsed.environment]).replace(/\/+$/, '');
    this.#tokenUrl = parsed.tokenUrl ?? PHONEPE_TOKEN_URLS[parsed.environment];
    this.#redirectUrl = parsed.redirectUrl;
    this.#webhookAuthorization =
      parsed.webhookUsername !== undefined && parsed.webhookPassword !== undefined
        ? hash(HashAlgorithm.Sha256, `${parsed.webhookUsername}:${parsed.webhookPassword}`, DigestEncoding.Hex)
        : undefined;
    this.#generateId = options.generateId ?? defaultGenerateId;
    this.#tokens = new PhonePeTokenManager(() => this.fetchToken(), () => this.now());
  }

  // -------------------------------------------------------------------------
  // HTTP plumbing
  // -------------------------------------------------------------------------

  protected describeError(response: HttpResponse): GatewayErrorInfo {
    const parsed = PhonePeErrorBodySchema.safeParse(response.json);
    const info = describeErrorBody(parsed.success ? parsed.data : undefined, response.text);
    return { message: info.message.slice(0, MAX_ERROR_TEXT), ...(info.providerCode ? { providerCode: info.providerCode } : {}) };
  }

  /** A documented PhonePe error code decides the code (status below 500 only); otherwise the status does. */
  protected override errorFromResponse(response: HttpResponse, idempotent: boolean): SubscriptionError {
    const error = super.errorFromResponse(response, idempotent);
    const code = errorCodeFor(response.status, error.providerCode, error.code);
    if (code === error.code) return error;
    return new SubscriptionError(code, error.message, {
      provider: this.name,
      httpStatus: error.httpStatus,
      providerCode: error.providerCode,
      raw: error.raw,
    });
  }

  /**
   * `POST` the form-encoded token request. Errors are rebuilt from scratch: neither the request (it holds the client
   * secret) nor PhonePe's answer (it may hold a token) is ever put into an error or its `raw`.
   */
  private async fetchToken(): Promise<PhonePeTokenResponse> {
    const form = parseInput(
      PhonePeTokenRequestSchema,
      {
        client_id: this.#clientId,
        client_version: this.#clientVersion,
        client_secret: this.#clientSecret,
        grant_type: PHONEPE_GRANT_TYPE,
      },
      'token request',
      this.name,
    );
    let response: HttpResponse;
    try {
      response = await this.sendRaw({
        method: HttpMethod.Post,
        url: this.#tokenUrl,
        headers: { [HeaderName.ContentType]: ContentType.Form, [HeaderName.Accept]: ContentType.Json },
        body: formEncode(form),
        // Asking for a token again changes nothing at PhonePe: safe to repeat.
        idempotent: true,
      });
    } catch (error) {
      if (!(error instanceof SubscriptionError)) throw error;
      const rejected = error.httpStatus !== undefined && error.httpStatus >= 400 && error.httpStatus < 500 && error.httpStatus !== 429;
      throw new SubscriptionError(
        rejected ? ErrorCode.Auth : error.code,
        `${this.name} token request failed${error.httpStatus !== undefined ? ` with HTTP ${error.httpStatus}` : ` (${error.code})`}` +
          (rejected ? ': check clientId, clientSecret, clientVersion and environment' : ''),
        { provider: this.name, httpStatus: error.httpStatus, providerCode: error.providerCode },
      );
    }
    const parsed = PhonePeTokenResponseSchema.safeParse(response.json);
    if (!parsed.success) {
      throw new SubscriptionError(ErrorCode.UnexpectedResponse, `${this.name} returned a token response without an access_token`, {
        provider: this.name,
        httpStatus: response.status,
      });
    }
    return parsed.data;
  }

  /** One authenticated call. A 401 drops the rejected token; it is repeated once only when `repeatOn401`. */
  private async request(call: ApiRequest): Promise<HttpResponse> {
    const url = withQuery(`${this.#apiUrl}${call.path}`, call.query ?? {});
    const attempt = async (): Promise<HttpResponse> => {
      const token = await this.#tokens.getToken();
      try {
        return await this.sendRaw({
          method: call.method,
          url,
          headers: {
            [HeaderName.Authorization]: `${PHONEPE_AUTH_SCHEME} ${token}`,
            // Every PhonePe page lists `Content-Type: application/json` among the request headers, bodiless calls included.
            [HeaderName.ContentType]: ContentType.Json,
            [HeaderName.Accept]: ContentType.Json,
          },
          ...(call.body !== undefined ? { body: JSON.stringify(call.body) } : {}),
          idempotent: call.idempotent,
        });
      } catch (caught) {
        const error = this.scrubbed(caught, token);
        if (error instanceof SubscriptionError && error.code === ErrorCode.Auth && error.httpStatus === HTTP_UNAUTHORIZED) {
          REJECTED_TOKEN_ERRORS.add(error);
          this.#tokens.invalidate(token);
        }
        throw error;
      }
    };
    try {
      return await attempt();
    } catch (error) {
      if (call.repeatOn401 && isRejectedToken(error)) return attempt();
      throw error;
    }
  }

  /** The error with the access token and the client secret removed from its message and `raw` (should PhonePe ever echo them). */
  private scrubbed(error: unknown, token: string): unknown {
    if (!(error instanceof SubscriptionError)) return error;
    const secrets = [token, this.#clientSecret];
    const message = redactSecrets(error.message, secrets);
    const raw = redactSecrets(error.raw, secrets);
    if (!message.changed && !raw.changed) return error;
    return new SubscriptionError(error.code, message.value as string, {
      provider: this.name,
      httpStatus: error.httpStatus,
      providerCode: error.providerCode,
      raw: raw.value,
    });
  }

  private async api<S extends z.ZodType>(call: ApiRequest, schema: S, what: string): Promise<z.output<S>> {
    const response = await this.request(call);
    if (response.json === undefined && response.text !== '') {
      throw new SubscriptionError(ErrorCode.UnexpectedResponse, `${this.name} returned a ${what} that is not JSON`, {
        provider: this.name,
        httpStatus: response.status,
        raw: response.text,
      });
    }
    return parseResponse(schema, response.json, what, this.name);
  }

  /**
   * Runs a read-then-write flow, and once more when its write was refused with a 401. The repeat starts with the read
   * again, so it only sends the write when PhonePe still holds the state the first run saw: repeating is safe by construction.
   */
  private async afterTokenRejection<T>(flow: () => Promise<T>): Promise<T> {
    try {
      return await flow();
    } catch (error) {
      if (isRejectedToken(error)) return flow();
      throw error;
    }
  }

  /**
   * The order PhonePe holds under this `merchantOrderId`, or `undefined` when PhonePe says it has none
   * (`INVALID_MERCHANT_ORDER_ID`). A bare 404 proves nothing about the order (it may be a wrong URL), so it is a
   * `PROVIDER_ERROR`, never `NOT_FOUND`: the scheduler reads `NOT_FOUND` from `getCharge` as "the debit never reached PhonePe".
   */
  private async readOrder(merchantOrderId: string): Promise<PhonePeOrder | undefined> {
    try {
      return await this.api(
        {
          method: HttpMethod.Get,
          path: PhonePePath.orderStatus(merchantOrderId),
          query: { [PHONEPE_DETAILS_QUERY]: PHONEPE_DETAILS_ALL },
          idempotent: true,
          repeatOn401: true,
        },
        PhonePeOrderSchema,
        'order status',
      );
    } catch (error) {
      if (!(error instanceof SubscriptionError) || error.code !== ErrorCode.NotFound) throw error;
      if (error.providerCode !== undefined && ORDER_NOT_FOUND_CODES.includes(error.providerCode)) return undefined;
      throw new SubscriptionError(
        ErrorCode.ProviderError,
        `${this.name} answered 404 for order ${merchantOrderId} without ${PhonePeErrorCode.InvalidMerchantOrderId}; ` +
          'that does not prove the order does not exist (check the endpoint and credentials)',
        { provider: this.name, httpStatus: error.httpStatus, providerCode: error.providerCode, raw: error.raw },
      );
    }
  }

  // -------------------------------------------------------------------------
  // Plans: PhonePe has no plan API
  // -------------------------------------------------------------------------

  override createPlan(_input: CreatePlanInput): Promise<Plan> {
    return Promise.reject(
      unsupported(this.name, 'creating plans', 'PhonePe has no plan API; pass the plan inline to createSubscription'),
    );
  }

  override getPlan(_planId: string): Promise<Plan> {
    return Promise.reject(
      unsupported(this.name, 'fetching plans', 'PhonePe has no plan API; pass the plan inline to createSubscription'),
    );
  }

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------

  /**
   * Sets the mandate up: `POST /checkout/v2/pay`. The returned `id` is the `merchantSubscriptionId`; PhonePe's own mandate
   * id only exists once the customer has authorised and is not needed for any call.
   *
   * With `upfrontAmount` the setup is a `TRANSACTION` of that amount; without it a `PENNY_DROP` (INR 2, whether PhonePe
   * returns it automatically is not stated for the API; refund it if needed). Without a trial or `startAt` the first real
   * debit still needs a notification and 24 hours of notice, so it cannot happen at setup.
   */
  override async createSubscription(rawInput: CreateSubscriptionInput): Promise<Subscription> {
    const input = parseInput(CreateSubscriptionInputSchema, rawInput, 'subscription input', this.name);
    if (typeof input.plan === 'string') {
      throw invalid(
        'PhonePe has no plan API, so a plan id cannot be resolved: pass the plan details inline (name, amount, interval) instead of a string',
        this.name,
      );
    }
    if (input.plan.scheduling === SchedulingMode.Gateway) {
      throw unsupported(this.name, 'gateway-scheduled subscriptions', 'PhonePe never raises recurring debits itself');
    }
    if (input.quantity !== undefined && input.quantity !== 1) {
      throw unsupported(this.name, 'quantity', 'multiply the plan amount yourself');
    }
    if (input.paymentMethods !== undefined && !input.paymentMethods.includes(PaymentMethod.Upi)) {
      throw invalid('PhonePe Autopay supports only UPI mandates; none of the requested paymentMethods is upi', this.name);
    }

    const merchantSubscriptionId = assertSubscriptionId(input.reference ?? this.#generateId(), 'reference');
    const returnBase = input.returnUrl ?? this.#redirectUrl;
    if (returnBase === undefined) {
      throw invalid('returnUrl is required (or set redirectUrl in the PhonePe config): PhonePe needs the page to send the customer back to', this.name);
    }

    const now = this.now();
    const setup = planSetup(input, {
      now,
      merchantSubscriptionId,
      redirectUrl: returnUrlFor(returnBase, merchantSubscriptionId),
    });
    const request = parseInput(PhonePeSetupRequestSchema, setup.request, 'PhonePe setup request', this.name);
    const response = await this.api(
      {
        method: HttpMethod.Post,
        path: PhonePePath.Pay,
        body: request,
        idempotent: false,
        repeatOn401: true,
      },
      PhonePePayResponseSchema,
      'subscription setup',
    );
    return createdSubscription(input, setup, response, now);
  }

  /**
   * `GET /checkout/v2/subscriptions/{id}/status`. The docs describe it as the status "after [the subscription] has been set
   * up" and do not say what it answers before. So a `NOT_FOUND` falls back to the SETUP ORDER (whose id is derived from the
   * subscription id): still `PENDING` is `created`, failed or expired is `failed`, completed is `pending_authorization`.
   * Neither found: `NOT_FOUND`.
   */
  override async getSubscription(subscriptionId: string): Promise<Subscription> {
    const id = assertSubscriptionId(subscriptionId, 'subscriptionId');
    try {
      const body = await this.api(
        { method: HttpMethod.Get, path: PhonePePath.subscriptionStatus(id), idempotent: true, repeatOn401: true },
        PhonePeSubscriptionStatusSchema,
        'subscription status',
      );
      return mapSubscriptionStatus(body, id);
    } catch (error) {
      if (!(error instanceof SubscriptionError) || error.code !== ErrorCode.NotFound) throw error;
      const order = await this.readOrder(setupOrderIdFor(id)).catch(() => undefined);
      if (order === undefined) throw error;
      return mapSetupOrderAsSubscription(order, id);
    }
  }

  /**
   * `POST /checkout/v2/subscriptions/{id}/cancel` (204, no body), then the status. A mandate that is already over (cancelled,
   * revoked, expired, failed) is returned as it is without a call, so cancelling twice is safe. A cancel whose status cannot be read
   * afterwards still returns a cancelled subscription: the 204 is PhonePe's answer that the mandate is now inactive.
   * A mandate the customer never authorised cannot be cancelled (nothing to cancel); PhonePe answers `NOT_FOUND`.
   */
  override async cancelSubscription(subscriptionId: string, options?: CancelSubscriptionOptions): Promise<Subscription> {
    const parsed = parseInput(CancelSubscriptionOptionsSchema, options ?? {}, 'cancel options', this.name);
    if (parsed.mode === CancelMode.AtPeriodEnd) {
      throw unsupported(
        this.name,
        'cancelling at the end of the period',
        'a PhonePe mandate is cancelled immediately; stop the billing schedule instead',
      );
    }
    const id = assertSubscriptionId(subscriptionId, 'subscriptionId');
    // Cancelling a mandate that has already ended must not fail (the docs do not say what PhonePe answers): read first.
    const before = await this.getSubscription(id).catch(() => undefined);
    if (before !== undefined && TERMINAL_SUBSCRIPTION_STATUSES.includes(before.status)) return before;
    await this.request({
      method: HttpMethod.Post,
      path: PhonePePath.cancelSubscription(id),
      idempotent: false,
      repeatOn401: false,
    });
    try {
      return await this.getSubscription(id);
    } catch {
      return cancelledSubscription(id, CANCEL_ACCEPTED_STATUS);
    }
  }

  override pauseSubscription(_subscriptionId: string, _options?: PauseSubscriptionOptions): Promise<Subscription> {
    return Promise.reject(
      unsupported(this.name, 'pausing subscriptions', 'only the customer can pause a PhonePe mandate, in their UPI app; stop billing instead'),
    );
  }

  override resumeSubscription(_subscriptionId: string, _options?: ResumeSubscriptionOptions): Promise<Subscription> {
    return Promise.reject(
      unsupported(this.name, 'resuming subscriptions', 'only the customer can un-pause a PhonePe mandate, in their UPI app'),
    );
  }

  override updateSubscription(_subscriptionId: string, _input: UpdateSubscriptionInput): Promise<Subscription> {
    return Promise.reject(
      unsupported(this.name, 'updating subscriptions', 'a PhonePe mandate cannot be changed after setup; cancel it and set a new one up'),
    );
  }

  // -------------------------------------------------------------------------
  // Pre-debit notification and recurring debit
  // -------------------------------------------------------------------------

  /**
   * `POST /checkout/v2/subscriptions/notify`: `merchantOrderId` is the `notificationId`, `autoDebit` is false (the merchant
   * redeems), and the retry strategy is `STANDARD` (PhonePe retries a failed debit itself inside its 48 hour window).
   *
   * `debitAt` and the invoice number have no PhonePe field. PhonePe's execution window (not earlier than 24 hours after
   * the notification) is what constrains the debit; the scheduler waits its own `minNoticeHours` before redeeming.
   *
   * Safe to send again with the same `notificationId`: PhonePe is asked about the order first, and a notification it
   * already holds (same amount, same subscription) is returned instead of sent twice.
   */
  override async notifyCharge(rawInput: NotifyChargeInput): Promise<ChargeNotification> {
    const input = parseInput(NotifyChargeInputSchema, rawInput, 'pre-debit notification', this.name);
    const subscriptionId = assertSubscriptionId(input.subscriptionId, 'subscriptionId');
    const merchantOrderId = assertMerchantId(input.notificationId, 'notificationId');
    if (input.amount < MIN_NOTIFY_PAISE) {
      throw invalid(`amount must be at least ${MIN_NOTIFY_PAISE} paise (INR 1): PhonePe's minimum for a pre-debit notification`, this.name);
    }
    const request = parseInput(
      PhonePeNotifyRequestSchema,
      {
        merchantOrderId,
        amount: input.amount,
        paymentFlow: {
          type: PhonePePaymentFlowType.CheckoutRedemption,
          merchantSubscriptionId: subscriptionId,
          redemptionRetryStrategy: PhonePeRetryStrategy.Standard,
          autoDebit: false,
        },
      },
      'PhonePe notify request',
      this.name,
    );

    return this.afterTokenRejection(async () => {
      const existing = await this.readOrder(merchantOrderId);
      if (existing !== undefined) {
        this.assertSameNotification(existing, merchantOrderId, subscriptionId, input.amount);
        return mapNotification(input, existing.state, existing);
      }
      const body = await this.api(
        { method: HttpMethod.Post, path: PhonePePath.Notify, body: request, idempotent: false, repeatOn401: false },
        PhonePeNotifyResponseSchema,
        'pre-debit notification',
      );
      return mapNotification(input, body.state, body);
    });
  }

  /** An order PhonePe already holds under a notification's id must be that very notification, still unredeemed. */
  private assertSameNotification(order: PhonePeOrder, merchantOrderId: string, subscriptionId: string, amount: number): void {
    const flow = order.paymentFlow;
    const sameSubscription = flow?.merchantSubscriptionId === undefined || flow.merchantSubscriptionId === null || flow.merchantSubscriptionId === subscriptionId;
    const sameAmount = order.amount === undefined || order.amount === null || order.amount === amount;
    const isNotification = NOTIFICATION_STATES.includes(order.state);
    if (!sameSubscription || !sameAmount || !isNotification) {
      throw new SubscriptionError(
        ErrorCode.Conflict,
        `${this.name} already holds order ${merchantOrderId} as something other than this notification ` +
          `(state ${order.state}, amount ${String(order.amount)}); a notification id must never be reused`,
        { provider: this.name, providerCode: PhonePeErrorCode.DuplicateTxnRequest, raw: order },
      );
    }
  }

  /**
   * `POST /checkout/v2/subscriptions/redeem` with `merchantOrderId` = `chargeId`, which must be the id of the notification
   * (`ChargeNotification.chargeId`). Not idempotent at PhonePe, so a dropped connection is `OUTCOME_UNKNOWN`; the call is
   * made safe to repeat by READING the order first:
   *
   * - PhonePe has no such order: `NOT_FOUND` (nothing was notified);
   * - already redeemed (`PENDING` / `COMPLETED` / `FAILED`): that debit is returned and nothing is sent;
   * - `NOTIFICATION_IN_PROGRESS`, or `NOTIFIED` but before `validAfter`: `CONFLICT` with
   *   `SUBSCRIPTION_DEBIT_EXECUTE_INTERVAL_NOT_STARTED`. Nothing was debited and the debit can still happen, so this is
   *   deliberately not one of the codes the scheduler counts as a failed attempt;
   * - `NOTIFIED` after `validUpto`: `PROVIDER_ERROR` with `SUBSCRIPTION_DEBIT_EXECUTE_INTERVAL_EXPIRED` (a definite refusal:
   *   the debit can never happen with this notification);
   * - `input.amount` differs from the notification's: `VALIDATION`. The amount of the debit is fixed by the notification;
   *   PhonePe's redeem call takes none, and this check is the only place it could be verified.
   *
   * The subscription's state is not read first (the docs advise checking it is `ACTIVE`): PhonePe refuses a redeem on an
   * inactive mandate with `INVALID_SUBSCRIPTION_STATE`, mapped to `PROVIDER_ERROR`.
   */
  override async createCharge(rawInput: CreateChargeInput): Promise<Charge> {
    const input = parseInput(CreateChargeInputSchema, rawInput, 'charge input', this.name);
    const subscriptionId = assertSubscriptionId(input.subscriptionId, 'subscriptionId');
    const merchantOrderId = assertMerchantId(input.chargeId, 'chargeId');
    const request = parseInput(PhonePeRedeemRequestSchema, { merchantOrderId }, 'PhonePe redeem request', this.name);

    return this.afterTokenRejection(async () => {
      const order = await this.readOrder(merchantOrderId);
      if (order === undefined) {
        throw new SubscriptionError(
          ErrorCode.NotFound,
          `${this.name} holds no notification ${merchantOrderId}: send the pre-debit notification first and debit with its id (ChargeNotification.chargeId)`,
          { provider: this.name, providerCode: PhonePeErrorCode.InvalidMerchantOrderId },
        );
      }
      this.assertOrderOwner(order, merchantOrderId, subscriptionId);
      const flowType = order.paymentFlow?.type;
      if (flowType !== undefined && flowType !== null && SETUP_FLOW_TYPES.includes(flowType)) {
        throw invalid(`order ${merchantOrderId} is a mandate setup, not a pre-debit notification`, this.name);
      }
      if (REDEEMED_STATES.includes(order.state)) {
        return mapOrderCharge(order, { merchantOrderId, subscriptionId, raw: order });
      }
      if (order.state !== PhonePeOrderState.Notified) {
        throw new SubscriptionError(
          order.state === PhonePeOrderState.NotificationInProgress ? ErrorCode.Conflict : ErrorCode.UnexpectedResponse,
          `${this.name} holds order ${merchantOrderId} in state ${order.state}, not ${PhonePeOrderState.Notified}: it cannot be redeemed yet`,
          { provider: this.name, providerCode: PhonePeErrorCode.ExecuteIntervalNotStarted, raw: order },
        );
      }
      if (typeof order.amount === 'number' && order.amount !== input.amount) {
        throw invalid(
          `the debit amount is fixed by the notification (${order.amount} paise) and differs from the requested ${input.amount}`,
          this.name,
          order,
        );
      }
      const nowMs = this.now().getTime();
      if (windowNotOpen(order, nowMs)) {
        throw new SubscriptionError(
          ErrorCode.Conflict,
          `${this.name} allows the debit of ${merchantOrderId} only from ${new Date(order.paymentFlow?.validAfter ?? 0).toISOString()} (24 hours after the notification)`,
          { provider: this.name, providerCode: PhonePeErrorCode.ExecuteIntervalNotStarted, raw: order },
        );
      }
      if (windowExpired(order, nowMs)) {
        throw new SubscriptionError(
          ErrorCode.ProviderError,
          `${this.name} allowed the debit of ${merchantOrderId} only until ${new Date(order.paymentFlow?.validUpto ?? 0).toISOString()}: send a new notification`,
          { provider: this.name, providerCode: PhonePeErrorCode.ExecuteIntervalExpired, raw: order },
        );
      }
      const body = await this.api(
        { method: HttpMethod.Post, path: PhonePePath.Redeem, body: request, idempotent: false, repeatOn401: false },
        PhonePeRedeemResponseSchema,
        'redemption',
      );
      return mapRedeemCharge(body, { merchantOrderId, subscriptionId, amount: order.amount ?? input.amount, now: this.now() });
    });
  }

  /** The order must belong to the subscription it is asked about. */
  private assertOrderOwner(order: OrderLike, merchantOrderId: string, subscriptionId: string): void {
    const owner = order.paymentFlow?.merchantSubscriptionId;
    if (owner !== undefined && owner !== null && owner !== subscriptionId) {
      throw invalid(`order ${merchantOrderId} belongs to subscription ${owner}, not ${subscriptionId}`, this.name);
    }
  }

  /**
   * The state of a debit by the notification's `merchantOrderId`, from the order status.
   *
   * - PhonePe has never seen the order: `NOT_FOUND`.
   * - PhonePe holds only the NOTIFICATION (`NOTIFICATION_IN_PROGRESS` / `NOTIFIED`, inside its window): no debit exists
   *   yet, so `NOT_FOUND` as well. The scheduler reads that as "never reached PhonePe" and, after its grace period, sends
   *   the same redeem again, which is exactly right. (Answering `scheduled` would leave the cycle awaiting confirmation
   *   forever.) ASSUMPTION about how this contract reads "no trace of the debit".
   * - `NOTIFIED` past `validUpto`: a failed debit (`SUBSCRIPTION_DEBIT_EXECUTE_INTERVAL_EXPIRED`).
   * - otherwise `PENDING` / `COMPLETED` / `FAILED` through `ORDER_STATE_TO_CHARGE_STATUS`; any other state is `pending`.
   */
  override async getCharge(subscriptionId: string, chargeId: string): Promise<Charge> {
    const id = assertSubscriptionId(subscriptionId, 'subscriptionId');
    const merchantOrderId = assertMerchantId(chargeId, 'chargeId');
    const order = await this.readOrder(merchantOrderId);
    if (order === undefined) {
      throw new SubscriptionError(ErrorCode.NotFound, `${this.name} has no order ${merchantOrderId}`, {
        provider: this.name,
        providerCode: PhonePeErrorCode.InvalidMerchantOrderId,
      });
    }
    this.assertOrderOwner(order, merchantOrderId, id);
    if (NOTIFICATION_STATES.includes(order.state)) {
      if (windowExpired(order, this.now().getTime())) {
        return expiredNotificationCharge(order, { merchantOrderId, subscriptionId: id });
      }
      throw new SubscriptionError(
        ErrorCode.NotFound,
        `${this.name} holds only the pre-debit notification ${merchantOrderId} (state ${order.state}); no debit has been raised for it`,
        { provider: this.name, providerCode: order.state, raw: order },
      );
    }
    return mapOrderCharge(order, { merchantOrderId, subscriptionId: id, raw: order });
  }

  // -------------------------------------------------------------------------
  // Refunds
  // -------------------------------------------------------------------------

  /**
   * `POST /payments/v2/refund`: `merchantRefundId` = `refundId`, `originalMerchantOrderId` = `chargeId`. Without an
   * `amount` the whole debit is refunded: its amount is read from the order status (a debit that is not `COMPLETED`
   * cannot be refunded). PhonePe does not say whether a repeated `merchantRefundId` is refused, so the call is not
   * idempotent; a refund that failed must be re-sent under a new id [G-UATCHECK].
   */
  override async refundCharge(rawInput: RefundInput): Promise<Refund> {
    const input = parseInput(RefundInputSchema, rawInput, 'refund input', this.name);
    const merchantRefundId = assertMerchantId(input.refundId, 'refundId');
    const originalMerchantOrderId = assertMerchantId(input.chargeId, 'chargeId');

    let amount = input.amount;
    if (amount === undefined) {
      const order = await this.readOrder(originalMerchantOrderId);
      if (order === undefined) {
        throw new SubscriptionError(ErrorCode.NotFound, `${this.name} has no order ${originalMerchantOrderId} to refund`, {
          provider: this.name,
          providerCode: PhonePeErrorCode.InvalidMerchantOrderId,
        });
      }
      if (order.state !== PhonePeOrderState.Completed || typeof order.amount !== 'number') {
        throw invalid(
          `order ${originalMerchantOrderId} is ${order.state}: only a completed debit can be refunded, and its amount must be known`,
          this.name,
        );
      }
      amount = order.amount;
    }
    const request = parseInput(
      PhonePeRefundRequestSchema,
      { merchantRefundId, originalMerchantOrderId, amount },
      'PhonePe refund request',
      this.name,
    );
    const body = await this.api(
      { method: HttpMethod.Post, path: PhonePePath.Refund, body: request, idempotent: false, repeatOn401: false },
      PhonePeRefundResponseSchema,
      'refund',
    );
    return mapRefund(body, {
      merchantRefundId,
      chargeId: originalMerchantOrderId,
      ...(input.subscriptionId !== undefined ? { subscriptionId: input.subscriptionId } : {}),
      amount,
    });
  }

  // -------------------------------------------------------------------------
  // Checkout verification
  // -------------------------------------------------------------------------

  /**
   * The customer's return to `redirectUrl` carries no documented signature, so NOTHING in it is trusted except the
   * subscription id this adapter added to the URL. The mandate is read from PhonePe, and `authorized` is true only when
   * it is `ACTIVE`. A mandate still `ACTIVATION_IN_PROGRESS` is `pending_authorization`, not authorised.
   *
   * The id comes from the browser: always pass `expectedSubscriptionId` to the facade, or a customer could present the
   * return of someone else's active subscription.
   */
  override async verifyCheckout(result: CheckoutResult): Promise<CheckoutVerification> {
    const params = parseInput(PhonePeReturnParamsSchema, result, `PhonePe checkout result (the "${RETURN_SUBSCRIPTION_ID_PARAM}" parameter)`, this.name);
    const subscriptionId = assertSubscriptionId(params[RETURN_SUBSCRIPTION_ID_PARAM], RETURN_SUBSCRIPTION_ID_PARAM);
    const subscription = await this.getSubscription(subscriptionId);
    return {
      provider: this.name,
      subscriptionId: subscription.id,
      reference: subscription.reference ?? subscription.id,
      authorized: subscription.status === SubscriptionStatus.Active,
      status: subscription.status,
      raw: subscription.raw,
    };
  }

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------

  /**
   * Verifies the `Authorization` header (`sha256(username:password)` as lower-case hex [G-UATCHECK, SDKs], compared in
   * constant time) and normalises the event; see `mapWebhook` for the table.
   *
   * That header authenticates the sender and nothing else: it does not cover the body, so a captured webhook can be
   * replayed and a body altered in transit is not detected. Serve the endpoint over HTTPS only. PhonePe's HMAC
   * webhook mode is not implemented: its algorithm is not documented.
   */
  override parseWebhook(request: WebhookRequest): SubscriptionEvent[] {
    const { rawBody, headers } = parseInput(WebhookRequestSchema, request, 'webhook request', this.name);
    if (this.#webhookAuthorization === undefined) {
      throw new SubscriptionError(
        ErrorCode.Config,
        `${this.name} webhooks cannot be verified: set webhookUsername and webhookPassword in the config`,
        { provider: this.name },
      );
    }
    assertSignature(this.#webhookAuthorization, getHeader(headers, HeaderName.Authorization), this.name, 'webhook');
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch (cause) {
      throw new SubscriptionError(ErrorCode.UnexpectedResponse, `${this.name} sent a webhook that is not valid JSON`, {
        provider: this.name,
        cause,
      });
    }
    const webhook = parseResponse(PhonePeWebhookSchema, json, 'webhook body', this.name);
    return [mapWebhook(webhook, rawBody)];
  }
}

export function phonepe(config: PhonePeConfig, options?: PhonePeProviderOptions): PhonePeProvider {
  return new PhonePeProvider(config, options);
}
