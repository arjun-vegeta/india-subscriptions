import { createPrivateKey, randomUUID, type KeyObject } from 'node:crypto';
import type { z } from 'zod';
import {
  CancelMode,
  CheckoutKind,
  ContentType,
  Currency,
  Environment,
  ErrorCode,
  EventType,
  HeaderName,
  HttpMethod,
  PaymentStatus,
  Provider,
  ProviderKind,
  ProductKind,
  RefundStatus,
  SchedulingMode,
  SubscriptionStatus,
} from '../../constants.js';
import { getHeader } from '../../crypto.js';
import { SubscriptionError, invalid, parseInput, parseResponse, unsupported } from '../../errors.js';
import { formEncode, withQuery, type HttpResponse } from '../../http.js';
import { BaseProvider, type ExternalTransactionReporter, type GatewayErrorInfo, type ProviderOptions } from '../../provider.js';
import {
  CancelSubscriptionOptionsSchema,
  CreatePaymentInputSchema,
  CreateSubscriptionInputSchema,
  ExternalTransactionRefundSchema,
  ExternalTransactionReportSchema,
  RefundInputSchema,
  RefundPaymentInputSchema,
  WebhookRequestSchema,
  type CancelSubscriptionOptions,
  type Capabilities,
  type Charge,
  type CheckoutResult,
  type CheckoutVerification,
  type CreatePaymentInput,
  type CreateSubscriptionInput,
  type ExternalTransactionRecord,
  type ExternalTransactionRefund,
  type ExternalTransactionReport,
  type ListChargesOptions,
  type Payment,
  type PaymentVerification,
  type Refund,
  type RefundInput,
  type RefundPaymentInput,
  type Subscription,
  type SubscriptionEvent,
  type WebhookRequest,
} from '../../schemas.js';
import { PushTokenVerifier, GoogleTokenManager, signAssertion, type JwksFetch } from './auth.js';
import {
  BEARER_SCHEME,
  CACHE_CONTROL_HEADER,
  EXTERNAL_RECONCILE_CODES,
  EXTERNAL_TRANSACTION_ID_QUERY,
  ExternalTransactionState,
  GOOGLE_JWKS_URL,
  GOOGLE_JWT_BEARER_GRANT,
  GOOGLE_PLAY_API_URL,
  GOOGLE_PLAY_SCOPE,
  GOOGLE_TOKEN_URL,
  GoogleAcknowledgementState,
  GoogleCancellationType,
  GoogleOrderState,
  GooglePlayPath,
  GooglePlayResultKey,
  HTTP_GONE,
  HTTP_NOT_FOUND,
  HTTP_UNAUTHORIZED,
  LINKED_EVENT_ID_SUFFIX,
  MAX_AGE_PATTERN,
  MICROS_PER_PAISE,
  MAX_ERROR_TEXT,
  NOT_PURCHASED_STATUS,
  ONE_TIME_NOTIFICATION_NAMES,
  ProviderEventName,
  REVOKE_QUERY,
  REVOKE_QUERY_VALUE,
  SUBSCRIPTION_NOTIFICATION_NAMES,
  VOIDED_REFUND_NAMES,
  VoidedProductType,
} from './constants.js';
import {
  buildExternalRefund,
  buildExternalTransaction,
  classifyNotification,
  foreignOrderError,
  grantsAccess,
  isKnownOneTimeNotification,
  isKnownSubscriptionNotification,
  isPurchased,
  isTestProductPurchase,
  isTestPurchase,
  mapCharge,
  mapPayment,
  mapRefundOfOrder,
  mapSubscription,
  millisToIso,
  needsAcknowledgement,
  oneTimeEventType,
  orderTotalPaise,
  productConsumed,
  productStatus,
  subscriptionAccountId,
  subscriptionEventType,
} from './mapper.js';
import {
  DeveloperNotificationSchema,
  GoogleApiErrorSchema,
  GoogleCancelRequestSchema,
  GoogleExternalRefundRequestSchema,
  GoogleExternalTransactionRequestSchema,
  GoogleExternalTransactionSchema,
  GoogleOrderSchema,
  GooglePlayConfigSchema,
  GooglePlayResultSchema,
  GoogleProductPurchaseSchema,
  GoogleSubscriptionPurchaseSchema,
  GoogleTokenErrorSchema,
  GoogleTokenResponseSchema,
  JwksSchema,
  PubSubPushSchema,
  type GoogleExternalTransaction,
  type GoogleOrder,
  type GooglePlayConfig,
  type GoogleProductPurchase,
  type GoogleSubscriptionPurchase,
  type GoogleTokenResponse,
  type ParsedGooglePlayConfig,
} from './schemas.js';

function parseConfig(config: unknown): ParsedGooglePlayConfig {
  const result = GooglePlayConfigSchema.safeParse(config);
  if (result.success) return result.data;
  // Paths and messages only: never the offending values, which may be the private key.
  const issues = result.error.issues
    .map((issue) => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
  throw new SubscriptionError(ErrorCode.Config, `Invalid ${Provider.GooglePlay} config: ${issues}`, { provider: Provider.GooglePlay });
}

/** Service account keys are often pasted with literal `\n` instead of line breaks (an environment variable cannot hold them). */
function readPrivateKey(pem: string): KeyObject {
  try {
    return createPrivateKey(pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem);
  } catch {
    throw new SubscriptionError(ErrorCode.Config, `Invalid ${Provider.GooglePlay} config: privateKey is not a PEM private key`, {
      provider: Provider.GooglePlay,
    });
  }
}

export interface GooglePlayProviderOptions extends ProviderOptions {
  /** Generator of the obfuscated account id `createSubscription` / `createPayment` mint (tests). Defaults to a random UUID. */
  generateId?: () => string;
}

interface ApiRequest {
  method: HttpMethod;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  /** True only for reads: a write that gets no answer is `OUTCOME_UNKNOWN`. */
  idempotent: boolean;
}

/**
 * Google Play adapter (an app store): Play Billing on the device, the Google Play Developer API on the server.
 *
 * - The purchase starts on the device. `createSubscription` / `createPayment` make no call: they validate the store
 *   product, mint the obfuscated account id (a UUID) and return it as `id` with a `google_play_billing` checkout.
 *   `verifyCheckout` / `verifyPayment` take the device's purchase (`{ purchaseToken, productId }`), read it from Google,
 *   acknowledge it (or consume a consumable one-time product) and return the purchase token as `subscriptionId` /
 *   `paymentId` and the account id as `reference`.
 * - Ids: the purchase token identifies a subscription (`getSubscription`, `cancelSubscription`) and a one-time purchase
 *   (`getPayment`, `refundPayment`); an order id (`GPA.1234-5678-9012-34567`) identifies a charge (`getCharge`,
 *   `refundCharge`).
 * - Webhooks are Cloud Pub/Sub pushes. Every push carries an OIDC token that is verified when push authentication is
 *   configured; without it webhooks are refused unless `acceptUnauthenticatedWebhooks` is set.
 * - Transactions made outside Google Play billing (user choice billing) are reported through the
 *   `ExternalTransactionReporter` methods.
 *
 * Authentication: an RS256 JWT signed with the service account key, exchanged at Google's token endpoint for an access
 * token that is cached until shortly before it expires; one in-flight token request is shared between concurrent calls.
 */
export class GooglePlayProvider extends BaseProvider implements ExternalTransactionReporter {
  readonly name = Provider.GooglePlay;

  readonly capabilities: Capabilities = {
    provider: Provider.GooglePlay,
    kind: ProviderKind.Store,
    scheduling: [SchedulingMode.Gateway],
    gatewayPlans: false,
    trial: false,
    upfrontAmount: false,
    quantity: false,
    pause: false,
    resume: false,
    cancel: true,
    cancelAtPeriodEnd: true,
    changePlan: false,
    merchantCharges: false,
    merchantPreDebitNotification: false,
    listCharges: false,
    refunds: true,
    signedWebhooks: true,
    idempotencyKeys: false,
    paymentMethods: [],
    oneTimePayments: true,
    oneTimePaymentMethods: [],
  };

  // Real private fields: invisible to JSON.stringify, console.log and spreads, so the key cannot leak.
  readonly #packageName: string;
  readonly #clientEmail: string;
  readonly #privateKey: KeyObject;
  readonly #privateKeyId: string | undefined;
  readonly #environment: ParsedGooglePlayConfig['environment'];
  readonly #acceptUnauthenticatedWebhooks: boolean;
  readonly #revokeOnRefund: boolean;
  readonly #consumableProductIds: ReadonlySet<string>;
  readonly #pushVerifier: PushTokenVerifier | undefined;
  readonly #tokens: GoogleTokenManager;
  readonly #generateId: () => string;

  constructor(config: GooglePlayConfig, options: GooglePlayProviderOptions = {}) {
    const parsed = parseConfig(config);
    super(options);
    this.#packageName = parsed.packageName;
    this.#clientEmail = parsed.clientEmail;
    this.#privateKey = readPrivateKey(parsed.privateKey);
    this.#privateKeyId = parsed.privateKeyId;
    this.#environment = parsed.environment;
    this.#acceptUnauthenticatedWebhooks = parsed.acceptUnauthenticatedWebhooks;
    this.#revokeOnRefund = parsed.revokeOnRefund;
    this.#consumableProductIds = new Set(parsed.consumableProductIds);
    this.#generateId = options.generateId ?? randomUUID;
    this.#tokens = new GoogleTokenManager(() => this.fetchToken(), () => this.now());
    this.#pushVerifier =
      parsed.pushAudience !== undefined && parsed.pushServiceAccountEmail !== undefined
        ? new PushTokenVerifier({
            audience: parsed.pushAudience,
            serviceAccountEmail: parsed.pushServiceAccountEmail,
            fetchJwks: () => this.fetchJwks(),
            now: () => this.now(),
          })
        : undefined;
  }

  // -------------------------------------------------------------------------
  // HTTP plumbing
  // -------------------------------------------------------------------------

  protected describeError(response: HttpResponse): GatewayErrorInfo {
    const parsed = GoogleApiErrorSchema.safeParse(response.json);
    const error = parsed.success ? parsed.data.error : undefined;
    const message = error?.message ?? (response.text.slice(0, MAX_ERROR_TEXT) || 'no message');
    const providerCode = error?.errors?.[0]?.reason ?? error?.status ?? undefined;
    return { message: message.slice(0, MAX_ERROR_TEXT), ...(providerCode ? { providerCode } : {}) };
  }

  /** 410 (`purchaseTokenNoLongerValid`, `subscriptionNoLongerAvailable`) means Google holds no such purchase: `NOT_FOUND`. */
  protected override errorFromResponse(response: HttpResponse, idempotent: boolean): SubscriptionError {
    const error = super.errorFromResponse(response, idempotent);
    if (response.status !== HTTP_GONE) return error;
    return new SubscriptionError(ErrorCode.NotFound, error.message, {
      provider: this.name,
      httpStatus: error.httpStatus,
      providerCode: error.providerCode,
      raw: error.raw,
    });
  }

  /**
   * Exchanges a freshly signed assertion for an access token. Errors are rebuilt from scratch: neither the assertion
   * (signed with the private key) nor the answer (it may hold a token) is put into an error or its `raw`.
   */
  private async fetchToken(): Promise<GoogleTokenResponse> {
    const assertion = signAssertion({
      clientEmail: this.#clientEmail,
      privateKey: this.#privateKey,
      privateKeyId: this.#privateKeyId,
      scope: GOOGLE_PLAY_SCOPE,
      audience: GOOGLE_TOKEN_URL,
      now: this.now(),
    });
    let response: HttpResponse;
    try {
      response = await this.sendRaw({
        method: HttpMethod.Post,
        url: GOOGLE_TOKEN_URL,
        headers: { [HeaderName.ContentType]: ContentType.Form, [HeaderName.Accept]: ContentType.Json },
        body: formEncode({ grant_type: GOOGLE_JWT_BEARER_GRANT, assertion }),
        // Asking for a token again changes nothing at Google: safe to repeat.
        idempotent: true,
      });
    } catch (error) {
      if (!(error instanceof SubscriptionError)) throw error;
      const rejected = error.httpStatus !== undefined && error.httpStatus >= 400 && error.httpStatus < 500 && error.httpStatus !== 429;
      const detail = GoogleTokenErrorSchema.safeParse(error.raw);
      const reason = detail.success && detail.data.error ? `: ${detail.data.error}${detail.data.error_description ? ` (${detail.data.error_description})` : ''}` : '';
      throw new SubscriptionError(
        rejected ? ErrorCode.Auth : error.code,
        `${this.name} token request failed${error.httpStatus !== undefined ? ` with HTTP ${error.httpStatus}` : ` (${error.code})`}${reason}` +
          (rejected ? '; check clientEmail, privateKey and that the service account has access to the app in Play Console' : ''),
        { provider: this.name, httpStatus: error.httpStatus },
      );
    }
    const parsed = GoogleTokenResponseSchema.safeParse(response.json);
    if (!parsed.success) {
      throw new SubscriptionError(ErrorCode.UnexpectedResponse, `${this.name} returned a token response without an access_token`, {
        provider: this.name,
        httpStatus: response.status,
      });
    }
    return parsed.data;
  }

  /** Google's OIDC signing keys, with the `max-age` of the response, for push token verification. */
  private async fetchJwks(): Promise<JwksFetch> {
    const response = await this.sendRaw({
      method: HttpMethod.Get,
      url: GOOGLE_JWKS_URL,
      headers: { [HeaderName.Accept]: ContentType.Json },
      idempotent: true,
    });
    const keys = parseResponse(JwksSchema, response.json, 'signing key set', this.name).keys;
    const maxAge = MAX_AGE_PATTERN.exec(response.headers.get(CACHE_CONTROL_HEADER) ?? '');
    return { keys, maxAgeSeconds: maxAge?.[1] !== undefined ? Number(maxAge[1]) : undefined };
  }

  /** One authenticated call. A 401 drops the rejected token and repeats the call once: a refused token means nothing was processed. */
  private async request(call: ApiRequest): Promise<HttpResponse> {
    const url = withQuery(`${GOOGLE_PLAY_API_URL}${call.path}`, call.query ?? {});
    const attempt = async (): Promise<{ response: HttpResponse; rejected: boolean }> => {
      const token = await this.#tokens.getToken();
      try {
        const response = await this.sendRaw({
          method: call.method,
          url,
          headers: {
            [HeaderName.Authorization]: `${BEARER_SCHEME} ${token}`,
            [HeaderName.Accept]: ContentType.Json,
            ...(call.body !== undefined ? { [HeaderName.ContentType]: ContentType.Json } : {}),
          },
          ...(call.body !== undefined ? { body: JSON.stringify(call.body) } : {}),
          idempotent: call.idempotent,
        });
        return { response, rejected: false };
      } catch (error) {
        if (error instanceof SubscriptionError && error.httpStatus === HTTP_UNAUTHORIZED) {
          this.#tokens.invalidate(token);
          return { response: undefined as never, rejected: true };
        }
        throw error;
      }
    };
    const first = await attempt();
    if (!first.rejected) return first.response;
    const second = await attempt();
    if (!second.rejected) return second.response;
    throw new SubscriptionError(
      ErrorCode.Auth,
      `${this.name} refused the access token twice: check that the service account has access to the app in Play Console`,
      { provider: this.name, httpStatus: HTTP_UNAUTHORIZED },
    );
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

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  private readSubscription(token: string): Promise<GoogleSubscriptionPurchase> {
    return this.api(
      { method: HttpMethod.Get, path: GooglePlayPath.subscription(this.#packageName, token), idempotent: true },
      GoogleSubscriptionPurchaseSchema,
      'subscription purchase',
    );
  }

  private readProduct(token: string): Promise<GoogleProductPurchase> {
    return this.api(
      { method: HttpMethod.Get, path: GooglePlayPath.product(this.#packageName, token), idempotent: true },
      GoogleProductPurchaseSchema,
      'product purchase',
    );
  }

  private readOrder(orderId: string): Promise<GoogleOrder> {
    return this.api(
      { method: HttpMethod.Get, path: GooglePlayPath.order(this.#packageName, orderId), idempotent: true },
      GoogleOrderSchema,
      'order',
    );
  }

  /** The error of a purchase Google no longer holds (404 or 410), which a webhook treats as "no current state". */
  private static gone(error: unknown): boolean {
    return error instanceof SubscriptionError && (error.httpStatus === HTTP_NOT_FOUND || error.httpStatus === HTTP_GONE);
  }

  /**
   * `live` grants nothing for a test purchase: a licence tester's purchase is never charged, and anyone can be added as
   * a tester. `test` accepts it.
   */
  private assertNotTest(isTest: boolean): void {
    if (isTest && this.#environment === Environment.Live) {
      throw new SubscriptionError(
        ErrorCode.Validation,
        `${this.name} purchase is a test purchase (made by a licence tester, never charged) and the environment is live`,
        { provider: this.name },
      );
    }
  }

  // -------------------------------------------------------------------------
  // Creating: nothing is bought yet
  // -------------------------------------------------------------------------

  /**
   * Makes no purchase and no call. Returns `status: created`, `id` = the obfuscated account id, and the checkout the
   * device acts on. Inputs a store cannot honour are refused, each with what Google Play does instead.
   */
  createSubscription(input: CreateSubscriptionInput): Promise<Subscription> {
    return Promise.resolve().then(() => {
      const parsed = parseInput(CreateSubscriptionInputSchema, input, 'subscription input', this.name);
      const product = parsed.storeProduct;
      if (!product) {
        throw invalid('storeProduct is required: Google Play subscriptions are products and base plans created in Play Console', this.name);
      }
      if (!product.basePlanId) {
        throw invalid('storeProduct.basePlanId is required: a Google Play subscription is bought per base plan', this.name);
      }
      this.refuseSubscriptionInputs(parsed);
      const accountId = this.#generateId();
      return {
        provider: this.name,
        id: accountId,
        ...(parsed.reference !== undefined ? { reference: parsed.reference } : {}),
        planId: `${product.productId}:${product.basePlanId}`,
        status: SubscriptionStatus.Created,
        providerStatus: NOT_PURCHASED_STATUS,
        scheduling: SchedulingMode.Gateway,
        customer: parsed.customer,
        checkout: {
          kind: CheckoutKind.GooglePlayBilling,
          productKind: ProductKind.Subscription,
          productId: product.productId,
          basePlanId: product.basePlanId,
          ...(product.offerId !== undefined ? { offerId: product.offerId } : {}),
          obfuscatedAccountId: accountId,
          userChoiceBilling: false,
        },
        ...(parsed.metadata !== undefined ? { metadata: parsed.metadata } : {}),
      };
    });
  }

  private refuseSubscriptionInputs(input: z.output<typeof CreateSubscriptionInputSchema>): void {
    const refuse = (what: string, instead: string): never => {
      throw unsupported(this.name, what, instead);
    };
    if (input.trial !== undefined) {
      refuse('a trial on the subscription', 'a free trial is an offer on the base plan in Play Console; pass its id as storeProduct.offerId');
    }
    if (input.startAt !== undefined) {
      refuse('a start date', 'the subscription starts when the customer buys it; a delayed first charge is an offer in Play Console');
    }
    if (input.upfrontAmount !== undefined) {
      refuse('an upfront amount', 'the price of the base plan and its offer is set in Play Console, and Google Play charges exactly that');
    }
    if (input.quantity !== undefined && input.quantity !== 1) {
      refuse('a quantity', 'a Google Play subscription is one unit of its base plan');
    }
    if (input.totalCycles !== undefined) {
      refuse('a cycle count', 'a base plan renews until it is cancelled; an installment plan with a commitment is configured in Play Console');
    }
    if (input.paymentMethods !== undefined) {
      refuse('payment methods', 'Google Play offers the buyer the payment methods on their account');
    }
    if (input.mandateEndsAt !== undefined) {
      refuse('a mandate end', 'there is no mandate: the subscription renews until it is cancelled');
    }
    if (input.authorizeBy !== undefined) {
      refuse('an authorisation deadline', 'the customer buys on the device; a purchase left pending is cancelled by Google');
    }
  }

  /**
   * Makes no purchase and no call. Returns `status: created`, `id` = the obfuscated account id and the checkout the
   * device acts on. `amount` is echoed, not charged: Google Play charges the price set in Play Console, and the amount
   * that was paid is read from the order by `verifyPayment` and `getPayment`.
   */
  override createPayment(input: CreatePaymentInput): Promise<Payment> {
    return Promise.resolve().then(() => {
      const parsed = parseInput(CreatePaymentInputSchema, input, 'payment input', this.name);
      const product = parsed.storeProduct;
      if (!product) {
        throw invalid('storeProduct is required: Google Play one-time products are created in Play Console', this.name);
      }
      if (parsed.paymentMethods !== undefined) {
        throw unsupported(this.name, 'payment methods', 'Google Play offers the buyer the payment methods on their account');
      }
      if (parsed.expiresAt !== undefined) {
        throw unsupported(this.name, 'an expiry', 'a purchase on the device is completed or cancelled by the customer; Google cancels a pending one');
      }
      const accountId = this.#generateId();
      return {
        provider: this.name,
        id: accountId,
        ...(parsed.reference !== undefined ? { reference: parsed.reference } : {}),
        status: PaymentStatus.Created,
        providerStatus: NOT_PURCHASED_STATUS,
        amount: parsed.amount,
        currency: Currency.INR,
        customer: parsed.customer,
        checkout: {
          kind: CheckoutKind.GooglePlayBilling,
          productKind: ProductKind.OneTime,
          productId: product.productId,
          ...(product.offerId !== undefined ? { offerId: product.offerId } : {}),
          obfuscatedAccountId: accountId,
          userChoiceBilling: false,
        },
        ...(parsed.metadata !== undefined ? { metadata: parsed.metadata } : {}),
        raw: undefined,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Verifying what the device bought
  // -------------------------------------------------------------------------

  /**
   * Reads the purchase from Google and, while it is unacknowledged and grants access, acknowledges it (Google refunds
   * a purchase that is not acknowledged within three days). A purchase that is still pending is returned unauthorised
   * and untouched. The purchase token is the `subscriptionId`, the obfuscated account id the `reference`.
   */
  async verifyCheckout(result: CheckoutResult): Promise<CheckoutVerification> {
    const input = parseInput(GooglePlayResultSchema, result, 'Google Play checkout result', this.name);
    const token = input[GooglePlayResultKey.PurchaseToken];
    const purchase = await this.readSubscription(token);
    this.assertNotTest(isTestPurchase(purchase));
    const productId = input[GooglePlayResultKey.ProductId];
    if (productId !== undefined && !purchase.lineItems.some((item) => item.productId === productId)) {
      throw new SubscriptionError(
        ErrorCode.SignatureInvalid,
        `${this.name} purchase is not a purchase of the product the checkout result names`,
        { provider: this.name },
      );
    }
    const subscription = mapSubscription(purchase, token, this.now());
    const authorized = grantsAccess(subscription.status);
    if (authorized && needsAcknowledgement(purchase.acknowledgementState)) {
      const ackProduct = productId ?? purchase.lineItems[0]?.productId;
      if (ackProduct === undefined) {
        throw new SubscriptionError(ErrorCode.UnexpectedResponse, `${this.name} returned a subscription purchase without a line item`, {
          provider: this.name,
          raw: purchase,
        });
      }
      await this.request({
        method: HttpMethod.Post,
        path: GooglePlayPath.acknowledgeSubscription(this.#packageName, ackProduct, token),
        body: {},
        idempotent: false,
      });
    }
    return {
      provider: this.name,
      subscriptionId: token,
      ...(subscriptionAccountId(purchase) !== undefined ? { reference: subscriptionAccountId(purchase) } : {}),
      authorized,
      status: subscription.status,
      raw: purchase,
    };
  }

  /**
   * Reads the one-time purchase from Google and, once it is `PURCHASED`, fulfils it: a consumable product (the result
   * carries `consumable: true`, or its id is in the config's `consumableProductIds`) is consumed, which also
   * acknowledges it and makes it buyable again; anything else is acknowledged. The purchase token is the `paymentId`,
   * the obfuscated account id the `reference`. A purchase in another currency is fulfilled and returned without
   * `payment`: the unified model is INR only.
   */
  override async verifyPayment(result: CheckoutResult): Promise<PaymentVerification> {
    const input = parseInput(GooglePlayResultSchema, result, 'Google Play checkout result', this.name);
    const token = input[GooglePlayResultKey.PurchaseToken];
    const purchase = await this.readProduct(token);
    this.assertNotTest(isTestProductPurchase(purchase));
    const productId = input[GooglePlayResultKey.ProductId];
    if (productId !== undefined && !purchase.productLineItem.some((item) => item.productId === productId)) {
      throw new SubscriptionError(
        ErrorCode.SignatureInvalid,
        `${this.name} purchase is not a purchase of the product the checkout result names`,
        { provider: this.name },
      );
    }
    const paid = isPurchased(purchase);
    const order = paid && purchase.orderId ? await this.readOrder(purchase.orderId) : undefined;
    if (paid) {
      const flagged = input[GooglePlayResultKey.Consumable] === true;
      for (const item of purchase.productLineItem) {
        if (flagged || this.#consumableProductIds.has(item.productId)) {
          if (!productConsumed(item)) {
            await this.request({
              method: HttpMethod.Post,
              path: GooglePlayPath.consumeProduct(this.#packageName, item.productId, token),
              idempotent: false,
            });
          }
        } else if (purchase.acknowledgementState === GoogleAcknowledgementState.Pending) {
          await this.request({
            method: HttpMethod.Post,
            path: GooglePlayPath.acknowledgeProduct(this.#packageName, item.productId, token),
            body: {},
            idempotent: false,
          });
        }
      }
    }
    const payment = order !== undefined && orderTotalPaise(order) === undefined ? undefined : mapPayment(purchase, order, token);
    return {
      provider: this.name,
      paymentId: token,
      ...(purchase.obfuscatedExternalAccountId?.trim() ? { reference: purchase.obfuscatedExternalAccountId.trim() } : {}),
      paid,
      status: productStatus(purchase),
      ...(payment !== undefined ? { payment } : {}),
      raw: purchase,
    };
  }

  // -------------------------------------------------------------------------
  // Reading and changing what was bought
  // -------------------------------------------------------------------------

  /** `subscriptionId` is the purchase token. */
  async getSubscription(subscriptionId: string): Promise<Subscription> {
    const purchase = await this.readSubscription(subscriptionId);
    return mapSubscription(purchase, subscriptionId, this.now());
  }

  /**
   * `at_period_end` stops the renewals with `DEVELOPER_REQUESTED_STOP_PAYMENTS` (final: the subscription cannot be
   * restored) and the customer keeps access until the paid period ends; repeating it is a no-op. `immediately` is
   * refused: Google's only way to end a subscription at once is `revoke`, which refunds the customer.
   */
  async cancelSubscription(subscriptionId: string, options?: CancelSubscriptionOptions): Promise<Subscription> {
    const { mode } = parseInput(CancelSubscriptionOptionsSchema, options ?? {}, 'cancel options', this.name);
    if (mode === CancelMode.Immediately) {
      throw unsupported(
        this.name,
        'cancelling a subscription immediately',
        `Google Play can only stop the renewals (mode "${CancelMode.AtPeriodEnd}") or revoke the subscription with a refund (refundCharge with the order id)`,
      );
    }
    const before = await this.readSubscription(subscriptionId);
    const current = mapSubscription(before, subscriptionId, this.now());
    if (current.cancelAtPeriodEnd === true || current.status === SubscriptionStatus.Cancelled || current.status === SubscriptionStatus.Expired) {
      return current;
    }
    const body = parseInput(
      GoogleCancelRequestSchema,
      {
        cancellationContext: {
          ...(before.etag ? { etag: before.etag } : {}),
          cancellationType: GoogleCancellationType.DeveloperRequestedStopPayments,
        },
      },
      'cancel request',
      this.name,
    );
    await this.request({
      method: HttpMethod.Post,
      path: GooglePlayPath.cancelSubscription(this.#packageName, subscriptionId),
      body,
      idempotent: false,
    });
    return this.getSubscription(subscriptionId);
  }

  /** `paymentId` is the purchase token. The amount is read from the order, which the purchase resource does not carry. */
  override async getPayment(paymentId: string): Promise<Payment> {
    const purchase = await this.readProduct(paymentId);
    const order = purchase.orderId ? await this.readOrder(purchase.orderId) : undefined;
    return mapPayment(purchase, order, paymentId);
  }

  /** `chargeId` is an order id; `subscriptionId` the purchase token the order must belong to. */
  override async getCharge(subscriptionId: string, chargeId: string): Promise<Charge> {
    const order = await this.readOrder(chargeId);
    if (order.purchaseToken && order.purchaseToken !== subscriptionId) {
      throw new SubscriptionError(ErrorCode.NotFound, `${this.name} order ${chargeId} does not belong to that subscription`, {
        provider: this.name,
      });
    }
    return mapCharge(order);
  }

  override listCharges(_subscriptionId: string, _options?: ListChargesOptions): Promise<Charge[]> {
    return Promise.reject(
      unsupported(
        this.name,
        'listing charges',
        'the Developer API cannot list the orders of a purchase; the order id of a renewal is `metadata.latestOrderId` of the subscription, and getCharge reads one order',
      ),
    );
  }

  /** `chargeId` is the order id. Google refunds a whole order only: an `amount` other than the order total is refused. */
  override refundCharge(input: RefundInput): Promise<Refund> {
    return Promise.resolve().then(() => {
      const parsed = parseInput(RefundInputSchema, input, 'refund input', this.name);
      return this.refundOrder(parsed.chargeId, {
        refundId: parsed.refundId,
        chargeId: parsed.chargeId,
        ...(parsed.subscriptionId !== undefined ? { subscriptionId: parsed.subscriptionId } : {}),
        ...(parsed.amount !== undefined ? { amount: parsed.amount } : {}),
      });
    });
  }

  /** `paymentId` is the purchase token; the purchase's order is refunded in full. */
  override async refundPayment(input: RefundPaymentInput): Promise<Refund> {
    const parsed = parseInput(RefundPaymentInputSchema, input, 'refund input', this.name);
    const purchase = await this.readProduct(parsed.paymentId);
    if (!purchase.orderId) {
      throw unsupported(this.name, 'refunding this purchase', 'Google issued no order for it (a promo code purchase, for example)');
    }
    return this.refundOrder(purchase.orderId, {
      refundId: parsed.refundId,
      chargeId: parsed.paymentId,
      paymentId: parsed.paymentId,
      ...(parsed.amount !== undefined ? { amount: parsed.amount } : {}),
    });
  }

  /**
   * Refunds one order in full (`orders.refund`, with `revoke=true` unless the config turned that off) and reports it as
   * the order shows it afterwards. Refunding an order that is already refunded changes nothing. The call answers with an
   * empty body and no refund id, so the caller's `refundId` is the refund's id.
   */
  private async refundOrder(
    orderId: string,
    ids: { refundId: string; chargeId: string; paymentId?: string; subscriptionId?: string; amount?: number },
  ): Promise<Refund> {
    const order = await this.readOrder(orderId);
    const total = orderTotalPaise(order);
    if (total === undefined) throw foreignOrderError(order, 'a refund');
    if (ids.subscriptionId !== undefined && order.purchaseToken && order.purchaseToken !== ids.subscriptionId) {
      throw invalid(`Order ${orderId} does not belong to subscription ${ids.subscriptionId}`, this.name);
    }
    if (ids.amount !== undefined && ids.amount !== total) {
      throw unsupported(
        this.name,
        'a partial refund',
        `orders.refund refunds the whole order (${total} paise); omit amount, or pass exactly ${total}`,
      );
    }
    const refundIds = {
      refundId: ids.refundId,
      chargeId: ids.chargeId,
      ...(ids.paymentId !== undefined ? { paymentId: ids.paymentId } : {}),
      ...((ids.subscriptionId ?? order.purchaseToken) && ids.paymentId === undefined
        ? { subscriptionId: ids.subscriptionId ?? (order.purchaseToken as string) }
        : {}),
    };
    if (order.state === GoogleOrderState.Refunded) return mapRefundOfOrder(order, refundIds, this.now());
    await this.request({
      method: HttpMethod.Post,
      path: GooglePlayPath.refundOrder(this.#packageName, orderId),
      ...(this.#revokeOnRefund ? { query: { [REVOKE_QUERY]: REVOKE_QUERY_VALUE } } : {}),
      idempotent: false,
    });
    let after: GoogleOrder;
    try {
      after = await this.readOrder(orderId);
    } catch (error) {
      // The refund was accepted; only the follow-up read failed. Report it as asked for, not yet confirmed.
      if (!(error instanceof SubscriptionError)) throw error;
      after = { ...order, state: GoogleOrderState.PendingRefund };
    }
    return mapRefundOfOrder(after, refundIds, this.now());
  }

  // -------------------------------------------------------------------------
  // Notifications
  // -------------------------------------------------------------------------

  /**
   * Accepts a Cloud Pub/Sub push (the wrapped JSON body) and returns the unified events.
   *
   * Authentication first: with `pushAudience` / `pushServiceAccountEmail` configured, the OIDC token in `Authorization`
   * is verified on every request; without them the webhook is refused (`SIGNATURE_INVALID`) unless
   * `acceptUnauthenticatedWebhooks` is set. The event id is the Pub/Sub message id. A notification carries only a token,
   * so the current state is read from Google and attached (`subscription` or `payment`). Notification types this
   * library does not know, test notifications and pending refund reviews are `unknown` events, never an error.
   */
  async parseWebhook(request: WebhookRequest): Promise<SubscriptionEvent[]> {
    const webhook = parseInput(WebhookRequestSchema, request, 'webhook request', this.name);
    await this.authenticatePush(webhook.headers);

    let envelopeJson: unknown;
    try {
      envelopeJson = JSON.parse(webhook.rawBody);
    } catch {
      throw invalid(`${this.name} webhook body is not JSON`, this.name);
    }
    const envelope = parseInput(PubSubPushSchema, envelopeJson, 'Pub/Sub push body', this.name);
    const messageId = envelope.message.messageId ?? envelope.message.message_id;
    if (!messageId) throw invalid(`${this.name} Pub/Sub message has no messageId`, this.name);
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(envelope.message.data, 'base64').toString('utf8'));
    } catch {
      throw invalid(`${this.name} Pub/Sub message data is not base64 encoded JSON`, this.name);
    }
    const notification = parseInput(DeveloperNotificationSchema, decoded, 'developer notification', this.name);
    const common = {
      id: messageId,
      provider: this.name,
      occurredAt: millisToIso(notification.eventTimeMillis),
      raw: { messageId, subscription: envelope.subscription, notification },
    };
    const classified = classifyNotification(notification, this.#packageName);

    switch (classified.kind) {
      case 'subscription':
        return this.subscriptionEvents(common, classified.type, classified.purchaseToken);
      case 'one_time':
        return [await this.oneTimeEvent(common, classified.type, classified.purchaseToken)];
      case 'voided':
        return [await this.voidedEvent(common, classified)];
      case 'pending_refund_review':
        return [{ ...common, type: EventType.Unknown, providerEventType: ProviderEventName.PendingRefundReview }];
      case 'test':
        return [{ ...common, type: EventType.Unknown, providerEventType: ProviderEventName.Test }];
      case 'package_mismatch':
        return [{ ...common, type: EventType.Unknown, providerEventType: ProviderEventName.PackageMismatch }];
      case 'unrecognised':
        return [{ ...common, type: EventType.Unknown, providerEventType: ProviderEventName.Unrecognised }];
    }
  }

  private async authenticatePush(headers: WebhookRequest['headers']): Promise<void> {
    if (this.#pushVerifier) {
      await this.#pushVerifier.verify(getHeader(headers, HeaderName.Authorization));
      return;
    }
    if (!this.#acceptUnauthenticatedWebhooks) {
      throw new SubscriptionError(
        ErrorCode.SignatureInvalid,
        `${this.name} webhook refused: it cannot be authenticated. Set pushAudience and pushServiceAccountEmail to verify the ` +
          'push token Pub/Sub sends, or acceptUnauthenticatedWebhooks to accept pushes without one',
        { provider: this.name },
      );
    }
  }

  private async subscriptionEvents(
    common: Pick<SubscriptionEvent, 'id' | 'provider' | 'occurredAt' | 'raw'>,
    type: number,
    token: string,
  ): Promise<SubscriptionEvent[]> {
    if (!isKnownSubscriptionNotification(type)) {
      return [{ ...common, type: EventType.Unknown, providerEventType: `SUBSCRIPTION_NOTIFICATION_${type}`, subscriptionId: token }];
    }
    let purchase: GoogleSubscriptionPurchase | undefined;
    try {
      purchase = await this.readSubscription(token);
    } catch (error) {
      // Google no longer holds the purchase (more than 60 days after expiry): the event still says what happened.
      if (!GooglePlayProvider.gone(error)) throw error;
    }
    const subscription = purchase ? mapSubscription(purchase, token, this.now()) : undefined;
    let eventType = subscriptionEventType(type) ?? EventType.Unknown;
    // A cancellation that has taken effect ends the subscription; one that waits for the paid period to run out does not.
    if (subscription && eventType === EventType.SubscriptionUpdated && subscription.status === SubscriptionStatus.Cancelled) {
      eventType = EventType.SubscriptionCancelled;
    }
    const events: SubscriptionEvent[] = [
      {
        ...common,
        type: eventType,
        providerEventType: SUBSCRIPTION_NOTIFICATION_NAMES[type],
        subscriptionId: token,
        ...(subscription ? { subscription } : {}),
      },
    ];
    // A purchase that replaces another one (upgrade, downgrade, resubscribe, top-up) ends the old token's subscription.
    if (purchase?.linkedPurchaseToken && eventType === EventType.SubscriptionActivated) {
      events.push({
        ...common,
        id: `${common.id}${LINKED_EVENT_ID_SUFFIX}`,
        type: EventType.SubscriptionCancelled,
        providerEventType: ProviderEventName.LinkedPurchaseReplaced,
        subscriptionId: purchase.linkedPurchaseToken,
      });
    }
    return events;
  }

  private async oneTimeEvent(
    common: Pick<SubscriptionEvent, 'id' | 'provider' | 'occurredAt' | 'raw'>,
    type: number,
    token: string,
  ): Promise<SubscriptionEvent> {
    if (!isKnownOneTimeNotification(type)) {
      return { ...common, type: EventType.Unknown, providerEventType: `ONE_TIME_PRODUCT_NOTIFICATION_${type}`, paymentId: token };
    }
    let payment: Payment | undefined;
    try {
      const purchase = await this.readProduct(token);
      const order = purchase.orderId ? await this.readOrder(purchase.orderId) : undefined;
      if (order === undefined || orderTotalPaise(order) !== undefined) payment = mapPayment(purchase, order, token);
    } catch (error) {
      if (!GooglePlayProvider.gone(error)) throw error;
    }
    return {
      ...common,
      type: oneTimeEventType(type) ?? EventType.Unknown,
      providerEventType: ONE_TIME_NOTIFICATION_NAMES[type],
      paymentId: token,
      ...(payment ? { payment } : {}),
    };
  }

  private async voidedEvent(
    common: Pick<SubscriptionEvent, 'id' | 'provider' | 'occurredAt' | 'raw'>,
    voided: { purchaseToken: string; orderId: string; productType?: number; refundType?: number },
  ): Promise<SubscriptionEvent> {
    const oneTime = voided.productType === VoidedProductType.OneTime;
    const subscription = voided.productType === VoidedProductType.Subscription;
    let refund: Refund | undefined;
    try {
      const order = await this.readOrder(voided.orderId);
      if (orderTotalPaise(order) !== undefined) {
        refund = {
          ...mapRefundOfOrder(
            order,
            {
              refundId: voided.orderId,
              chargeId: oneTime ? voided.purchaseToken : voided.orderId,
              ...(oneTime ? { paymentId: voided.purchaseToken } : {}),
              ...(subscription ? { subscriptionId: voided.purchaseToken } : {}),
            },
            this.now(),
          ),
          status: RefundStatus.Succeeded,
        };
      }
    } catch (error) {
      if (!GooglePlayProvider.gone(error)) throw error;
    }
    const refundName = voided.refundType !== undefined ? (VOIDED_REFUND_NAMES as Record<number, string | undefined>)[voided.refundType] : undefined;
    return {
      ...common,
      type: EventType.RefundSucceeded,
      providerEventType: refundName ? `${ProviderEventName.Voided}:${refundName}` : ProviderEventName.Voided,
      ...(subscription ? { subscriptionId: voided.purchaseToken } : {}),
      ...(oneTime ? { paymentId: voided.purchaseToken } : {}),
      ...(refund ? { refund } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // External transactions (user choice billing)
  // -------------------------------------------------------------------------

  /**
   * Reports a transaction made outside Google Play billing, within 24 hours of the payment's authorisation. A
   * subscription's first transaction (also a free trial, amount 0) carries the device's token; every renewal carries
   * `initialExternalTransactionId` and a new `externalTransactionId`. When the call's outcome is unknown or Google
   * answers that the id is taken, the transaction is read back: one that Google holds with the same amount is returned
   * as reported, so a repeated report is safe.
   *
   * Errors are `SubscriptionError`s: `VALIDATION` before any call (id, state or amounts Google would reject), then the
   * code the HTTP status gives (`AUTH`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `PROVIDER_ERROR`,
   * `PROVIDER_UNAVAILABLE`), or `OUTCOME_UNKNOWN`; `providerCode` is Google's `reason`, `raw` Google's error body.
   */
  async reportExternalTransaction(input: ExternalTransactionReport): Promise<ExternalTransactionRecord> {
    const report = parseInput(ExternalTransactionReportSchema, input, 'external transaction report', this.name);
    const body = parseInput(GoogleExternalTransactionRequestSchema, buildExternalTransaction(report), 'external transaction request', this.name);
    try {
      const created = await this.api(
        {
          method: HttpMethod.Post,
          path: GooglePlayPath.externalTransactions(this.#packageName),
          query: { [EXTERNAL_TRANSACTION_ID_QUERY]: report.externalTransactionId },
          body,
          idempotent: false,
        },
        GoogleExternalTransactionSchema,
        'external transaction',
      );
      return this.externalRecord(report.externalTransactionId, created);
    } catch (error) {
      if (!(error instanceof SubscriptionError) || !EXTERNAL_RECONCILE_CODES.includes(error.code)) throw error;
      const existing = await this.findExternalTransaction(report.externalTransactionId);
      if (existing?.originalPreTaxAmount && String(existing.originalPreTaxAmount.priceMicros) === body.originalPreTaxAmount.priceMicros) {
        return this.externalRecord(report.externalTransactionId, existing);
      }
      throw error;
    }
  }

  /**
   * Reports a refund of an external transaction: a full refund (no amounts) or a partial one of the pre-tax `amount`.
   * Reading back after an unknown outcome or a reused refund id works as for `reportExternalTransaction`. Errors have
   * the shape described there.
   */
  async refundExternalTransaction(input: ExternalTransactionRefund): Promise<ExternalTransactionRecord> {
    const refund = parseInput(ExternalTransactionRefundSchema, input, 'external transaction refund', this.name);
    const body = parseInput(GoogleExternalRefundRequestSchema, buildExternalRefund(refund), 'external refund request', this.name);
    try {
      const refunded = await this.api(
        {
          method: HttpMethod.Post,
          path: GooglePlayPath.refundExternalTransaction(this.#packageName, refund.externalTransactionId),
          body,
          idempotent: false,
        },
        GoogleExternalTransactionSchema,
        'external transaction',
      );
      return this.externalRecord(refund.externalTransactionId, refunded);
    } catch (error) {
      if (!(error instanceof SubscriptionError) || !EXTERNAL_RECONCILE_CODES.includes(error.code)) throw error;
      const existing = await this.findExternalTransaction(refund.externalTransactionId);
      if (existing && this.refundApplied(existing, refund)) return this.externalRecord(refund.externalTransactionId, existing);
      throw error;
    }
  }

  /** True when the transaction Google holds shows a refund at least as large as the one asked for. */
  private refundApplied(transaction: GoogleExternalTransaction, refund: ExternalTransactionRefund): boolean {
    if (refund.amount === undefined) return transaction.transactionState === ExternalTransactionState.Canceled;
    const original = transaction.originalPreTaxAmount?.priceMicros;
    const current = transaction.currentPreTaxAmount?.priceMicros;
    if (original === undefined || current === undefined) return false;
    return BigInt(original) - BigInt(current) >= BigInt(refund.amount) * MICROS_PER_PAISE;
  }

  private async findExternalTransaction(externalTransactionId: string): Promise<GoogleExternalTransaction | undefined> {
    try {
      return await this.api(
        {
          method: HttpMethod.Get,
          path: GooglePlayPath.externalTransaction(this.#packageName, externalTransactionId),
          idempotent: true,
        },
        GoogleExternalTransactionSchema,
        'external transaction',
      );
    } catch {
      // Whatever went wrong, the caller still holds the error of the call it was reconciling.
      return undefined;
    }
  }

  private externalRecord(externalTransactionId: string, transaction: GoogleExternalTransaction): ExternalTransactionRecord {
    return {
      externalTransactionId: transaction.externalTransactionId ?? externalTransactionId,
      state: transaction.transactionState ?? ExternalTransactionState.Unspecified,
      raw: transaction,
    };
  }
}

export function googlePlay(config: GooglePlayConfig, options: GooglePlayProviderOptions = {}): GooglePlayProvider {
  return new GooglePlayProvider(config, options);
}
