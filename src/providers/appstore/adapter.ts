import { randomUUID, type KeyObject } from 'node:crypto';
import type { z } from 'zod';
import {
  CheckoutKind,
  ErrorCode,
  HeaderName,
  HttpMethod,
  Provider,
  ProviderKind,
  SchedulingMode,
  SubscriptionStatus,
  PaymentStatus,
  ContentType,
} from '../../constants.js';
import { SubscriptionError, invalid, parseInput, parseResponse, unsupported } from '../../errors.js';
import { withQuery, type HttpResponse } from '../../http.js';
import { BaseProvider, type GatewayErrorInfo, type ProviderOptions } from '../../provider.js';
import {
  CreatePaymentInputSchema,
  CreateSubscriptionInputSchema,
  ListChargesOptionsSchema,
  type CancelSubscriptionOptions,
  type Capabilities,
  type Charge,
  type CheckoutResult,
  type CheckoutVerification,
  type CreatePaymentInput,
  type CreatePlanInput,
  type CreateSubscriptionInput,
  type ListChargesOptions,
  type PauseSubscriptionOptions,
  type Payment,
  type PaymentVerification,
  type Plan,
  type Refund,
  type RefundInput,
  type RefundPaymentInput,
  type ResumeSubscriptionOptions,
  type StoreProduct,
  type Subscription,
  type SubscriptionEvent,
  type UpdateSubscriptionInput,
  type WebhookRequest,
} from '../../schemas.js';
import { toIso } from '../../time.js';
import {
  APPSTORE_AUTH_SCHEME,
  APPSTORE_BASE_URLS,
  AppStoreErrorCode,
  AppStoreResultKey,
  AppStorePath,
  DEFAULT_LIST_CHARGES_LIMIT,
  HISTORY_PRODUCT_TYPE_AUTO_RENEWABLE,
  HISTORY_QUERY_PRODUCT_TYPE,
  HISTORY_QUERY_REVISION,
  HISTORY_QUERY_SORT,
  HISTORY_SORT_DESCENDING,
  MAX_ERROR_TEXT,
  MAX_HISTORY_PAGES,
  RETRYABLE_ERROR_CODES,
  STATUS_NOT_PURCHASED,
  UUID_PATTERN,
} from './constants.js';
import {
  isForeignCurrency,
  isSubscriptionTransaction,
  mapCharge,
  mapNotification,
  mapPayment,
  mapSubscription,
  notFound,
} from './mapper.js';
import { readSigningKey, createApiToken, signPromotionalOffer } from './signing.js';
import {
  AppStoreCheckoutResultSchema,
  AppStoreConfigSchema,
  AppStoreErrorBodySchema,
  HistoryResponseSchema,
  NotificationBodySchema,
  StatusResponseSchema,
  TransactionInfoResponseSchema,
  type AppStoreConfig,
  type ParsedAppStoreConfig,
  type StatusResponse,
  type TransactionPayload,
} from './schemas.js';
import { AppStoreVerifier } from './verifier.js';

function parseConfig(config: unknown): ParsedAppStoreConfig {
  const result = AppStoreConfigSchema.safeParse(config);
  if (result.success) return result.data;
  // Paths and messages only: never the offending values, which may be the private key.
  const issues = result.error.issues
    .map((issue) => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
  throw new SubscriptionError(ErrorCode.Config, `Invalid ${Provider.AppStore} config: ${issues}`, { provider: Provider.AppStore });
}

export interface AppStoreProviderOptions extends ProviderOptions {
  /** Generator of the app account token (tests). It must return a UUID. */
  generateToken?: () => string;
  /** Generator of the nonce of a promotional offer signature (tests). */
  generateNonce?: () => string;
}

/** What the customer or the app does instead of an operation the App Store Server API does not offer. */
const CUSTOMER_MANAGES =
  'the customer manages the subscription in Settings > Apple Account > Subscriptions (the app can show that sheet with AppStore.showManageSubscriptions(in:))';

/**
 * Apple App Store adapter: StoreKit 2 on the device, the App Store Server API and App Store Server Notifications V2 on the
 * server. The product lives in App Store Connect and the purchase starts on the device, so this adapter sells nothing itself:
 *
 * - `createSubscription` / `createPayment` make no purchase and call no Apple API. They check `storeProduct`, mint an app
 *   account token (a UUID) and return `status: created` with that token as `id` and an `apple_storekit` checkout
 *   instruction. The app passes the token to StoreKit's `appAccountToken` purchase option (and the promotional offer
 *   signature, when `storeProduct.offerId` asked for one: the only thing signed here).
 * - The device sends the signed transaction (`VerificationResult.jwsRepresentation`) to `verifyCheckout` / `verifyPayment`
 *   as `{ signedTransaction }`. The adapter verifies it (chain to Apple Root CA - G3, ES256 signature, bundle id, environment),
 *   then reads the current state from the Server API. The result carries the store's id (`originalTransactionId` for a
 *   subscription, `transactionId` for a one-time purchase) and the token as `reference`.
 * - `getSubscription` takes the `originalTransactionId` (the `transactionId` of its latest transaction works too);
 *   `getPayment` and `getCharge`'s `chargeId` take a `transactionId`; `listCharges` takes the `originalTransactionId`.
 * - `parseWebhook` takes App Store Server Notifications V2: the `signedPayload` and the signed transaction and renewal
 *   information inside it are all verified before anything is read.
 * - Everything a store cannot do from the server (cancel, pause, resume, change the product, refund) is `UNSUPPORTED`, and the
 *   message says what the customer or the app does instead.
 *
 * Amounts: Apple records a price in milliunits (the price times 1000) and a currency. This library's model is INR only: a
 * transaction priced in another currency is refused with `UNSUPPORTED` where a `Charge`, `Payment` or `Refund` would have to
 * state its amount, and is read without an amount where the model allows (a subscription, a webhook event, a
 * verification). Apple says not to use `price` for revenue reconciliation: App Store Connect reporting is the record.
 *
 * Authentication: an ES256 JWT (`iss`, `iat`, `exp`, `aud`, `bid`) signed with the In-App Purchase key, made for each request.
 */
export class AppStoreProvider extends BaseProvider {
  readonly name = Provider.AppStore;

  readonly capabilities: Capabilities = {
    provider: Provider.AppStore,
    kind: ProviderKind.Store,
    // Apple raises every renewal itself.
    scheduling: [SchedulingMode.Gateway],
    // Products and prices live in App Store Connect.
    gatewayPlans: false,
    // A free trial is an introductory offer configured in App Store Connect, not something `createSubscription` can add.
    trial: false,
    upfrontAmount: false,
    quantity: false,
    pause: false,
    resume: false,
    cancel: false,
    cancelAtPeriodEnd: false,
    changePlan: false,
    merchantCharges: false,
    merchantPreDebitNotification: false,
    listCharges: true,
    refunds: false,
    signedWebhooks: true,
    idempotencyKeys: false,
    // The customer pays with whatever their Apple Account holds.
    paymentMethods: [],
    oneTimePayments: true,
    oneTimePaymentMethods: [],
  };

  // Real private fields: invisible to JSON.stringify, console.log and spreads, so the keys cannot leak.
  readonly #bundleId: string;
  readonly #issuerId: string;
  readonly #keyId: string;
  readonly #apiKey: KeyObject;
  readonly #offerKey: { keyId: string; key: KeyObject } | undefined;
  readonly #baseUrl: string;
  readonly #verifier: AppStoreVerifier;
  readonly #generateToken: () => string;
  readonly #generateNonce: (() => string) | undefined;

  constructor(config: AppStoreConfig, options: AppStoreProviderOptions = {}) {
    const parsed = parseConfig(config);
    super(options);
    this.#bundleId = parsed.bundleId;
    this.#issuerId = parsed.issuerId;
    this.#keyId = parsed.keyId;
    this.#apiKey = readSigningKey(parsed.privateKey, 'privateKey');
    this.#offerKey = parsed.promotionalOfferKey
      ? { keyId: parsed.promotionalOfferKey.keyId, key: readSigningKey(parsed.promotionalOfferKey.privateKey, 'promotionalOfferKey.privateKey') }
      : undefined;
    this.#baseUrl = APPSTORE_BASE_URLS[parsed.environment];
    this.#verifier = new AppStoreVerifier({
      bundleId: parsed.bundleId,
      environment: parsed.environment,
      appAppleId: parsed.appAppleId,
      rootCertificates: parsed.rootCertificates,
      now: () => this.now(),
    });
    this.#generateToken = options.generateToken ?? randomUUID;
    this.#generateNonce = options.generateNonce;
  }

  // -------------------------------------------------------------------------
  // HTTP plumbing
  // -------------------------------------------------------------------------

  protected describeError(response: HttpResponse): GatewayErrorInfo {
    const parsed = AppStoreErrorBodySchema.safeParse(response.json);
    const body = parsed.success ? parsed.data : undefined;
    const message = body?.errorMessage ?? response.text;
    const providerCode = body?.errorCode;
    return {
      message: (message || `HTTP ${response.status}`).slice(0, MAX_ERROR_TEXT),
      ...(providerCode !== null && providerCode !== undefined ? { providerCode: String(providerCode) } : {}),
    };
  }

  /**
   * Apple's "errors to retry" arrive as HTTP 404 or 500, but asking again later may succeed, so they are `PROVIDER_UNAVAILABLE`,
   * never `NOT_FOUND`. A refused token is `AUTH`, with the settings to check; an unknown app (`bid`) is `CONFIG`.
   */
  protected override errorFromResponse(response: HttpResponse, idempotent: boolean): SubscriptionError {
    const error = super.errorFromResponse(response, idempotent);
    const code = error.providerCode === undefined ? undefined : Number(error.providerCode);
    let mapped: ErrorCode = error.code;
    let message = error.message;
    if (code !== undefined && RETRYABLE_ERROR_CODES.includes(code)) {
      mapped = ErrorCode.ProviderUnavailable;
    } else if (code === AppStoreErrorCode.AppNotFound) {
      mapped = ErrorCode.Config;
      message += ' (check bundleId)';
    } else if (error.code === ErrorCode.Auth) {
      message += ' (check issuerId, keyId, privateKey and bundleId)';
    }
    if (mapped === error.code && message === error.message) return error;
    return new SubscriptionError(mapped, message, {
      provider: this.name,
      httpStatus: error.httpStatus,
      providerCode: error.providerCode,
      raw: error.raw,
    });
  }

  /** A `GET` with a fresh API token. Every call this adapter makes is a read, so it is safe to repeat. */
  private async get<S extends z.ZodType>(
    path: string,
    schema: S,
    what: string,
    query: Record<string, string> = {},
  ): Promise<z.output<S>> {
    const token = createApiToken({
      key: this.#apiKey,
      keyId: this.#keyId,
      issuerId: this.#issuerId,
      bundleId: this.#bundleId,
      now: this.now(),
    });
    return this.send(
      {
        method: HttpMethod.Get,
        url: withQuery(`${this.#baseUrl}${path}`, query),
        headers: {
          [HeaderName.Authorization]: `${APPSTORE_AUTH_SCHEME} ${token}`,
          [HeaderName.Accept]: ContentType.Json,
        },
        idempotent: true,
      },
      schema,
      what,
    );
  }

  // -------------------------------------------------------------------------
  // Creating a purchase: nothing is bought on the server
  // -------------------------------------------------------------------------

  private storeProductOf(input: { storeProduct?: StoreProduct | undefined }, what: string): StoreProduct {
    if (!input.storeProduct) {
      throw invalid(
        `storeProduct is required for ${what}: the product lives in App Store Connect, so give its product id as storeProduct.productId`,
        this.name,
      );
    }
    if (input.storeProduct.basePlanId !== undefined) {
      throw invalid('storeProduct.basePlanId is a Google Play field; the App Store has no base plans', this.name);
    }
    return input.storeProduct;
  }

  private checkoutFor(product: StoreProduct, appAccountToken: string, allowOffer: boolean) {
    if (product.offerId === undefined) {
      return { kind: CheckoutKind.AppleStoreKit, productId: product.productId, appAccountToken } as const;
    }
    if (!allowOffer) {
      throw unsupported(
        this.name,
        'offers on a one-time purchase',
        'promotional offers apply to auto-renewable subscriptions; for a one-time product the customer redeems an offer code in the App Store',
      );
    }
    if (!this.#offerKey) {
      throw new SubscriptionError(
        ErrorCode.Config,
        `storeProduct.offerId asks for a promotional offer, which needs promotionalOfferKey (keyId and privateKey) in the ${Provider.AppStore} config`,
        { provider: this.name },
      );
    }
    const promotionalOffer = signPromotionalOffer({
      key: this.#offerKey.key,
      keyId: this.#offerKey.keyId,
      bundleId: this.#bundleId,
      productId: product.productId,
      offerId: product.offerId,
      appAccountToken,
      now: this.now(),
      ...(this.#generateNonce ? { nonce: this.#generateNonce } : {}),
    });
    return { kind: CheckoutKind.AppleStoreKit, productId: product.productId, appAccountToken, promotionalOffer } as const;
  }

  /**
   * Makes no purchase and calls no Apple API. `id` is the app account token the app passes to StoreKit; the real id
   * (`originalTransactionId`) comes from `verifyCheckout` after the customer buys. The price, the billing period and any
   * free trial are those configured in App Store Connect: `plan` is not read, and everything the store cannot honour is
   * refused (`UNSUPPORTED`), with what the store does instead.
   */
  async createSubscription(rawInput: CreateSubscriptionInput): Promise<Subscription> {
    const input = parseInput(CreateSubscriptionInputSchema, rawInput, 'subscription', this.name);
    const product = this.storeProductOf(input, 'an App Store subscription');
    this.refuse('trial', input.trial !== undefined, 'a free trial is an introductory offer you configure on the subscription in App Store Connect');
    this.refuse('startAt', input.startAt !== undefined, 'the subscription starts when the customer buys it; to delay billing, configure an introductory offer in App Store Connect');
    this.refuse('upfrontAmount', input.upfrontAmount !== undefined, 'the customer pays the price set in App Store Connect; configure a pay-up-front offer there');
    this.refuse('quantity', input.quantity !== undefined && input.quantity !== 1, 'an App Store subscription is bought one at a time');
    this.refuse('totalCycles', input.totalCycles !== undefined, 'an App Store subscription renews until the customer cancels it');
    this.refuse('paymentMethods', input.paymentMethods !== undefined, 'the customer pays with the payment method of their Apple Account');
    this.refuse('mandateEndsAt', input.mandateEndsAt !== undefined, 'an App Store subscription has no mandate: it renews until the customer cancels it');
    this.refuse('authorizeBy', input.authorizeBy !== undefined, 'the purchase starts on the device and has no deadline');
    if (typeof input.plan !== 'string') {
      this.refuse('plan.maxCycles', input.plan.maxCycles !== undefined, 'an App Store subscription renews until the customer cancels it');
      this.refuse('plan.scheduling', input.plan.scheduling === SchedulingMode.Merchant, 'Apple raises every renewal itself');
    }
    const appAccountToken = this.#generateToken();
    const checkout = this.checkoutFor(product, appAccountToken, true);
    return {
      provider: this.name,
      id: appAccountToken,
      ...(input.reference ? { reference: input.reference } : {}),
      planId: product.productId,
      status: SubscriptionStatus.Created,
      providerStatus: STATUS_NOT_PURCHASED,
      scheduling: SchedulingMode.Gateway,
      customer: input.customer,
      createdAt: toIso(this.now()),
      checkout,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
  }

  /**
   * Makes no purchase and calls no Apple API. `id` is the app account token the app passes to StoreKit. The price is the one set
   * in App Store Connect: `amount` is carried back as the amount the caller expects, and the amount actually charged is the
   * one `verifyPayment` / `getPayment` return.
   */
  override async createPayment(rawInput: CreatePaymentInput): Promise<Payment> {
    const input = parseInput(CreatePaymentInputSchema, rawInput, 'payment', this.name);
    const product = this.storeProductOf(input, 'an App Store purchase');
    this.refuse('paymentMethods', input.paymentMethods !== undefined, 'the customer pays with the payment method of their Apple Account');
    this.refuse('expiresAt', input.expiresAt !== undefined, 'the purchase starts on the device and has no deadline');
    const appAccountToken = this.#generateToken();
    const checkout = this.checkoutFor(product, appAccountToken, false);
    return {
      provider: this.name,
      id: appAccountToken,
      ...(input.reference ? { reference: input.reference } : {}),
      status: PaymentStatus.Created,
      providerStatus: STATUS_NOT_PURCHASED,
      amount: input.amount,
      customer: input.customer,
      createdAt: toIso(this.now()),
      checkout,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
  }

  private refuse(field: string, present: boolean, instead: string): void {
    if (present) throw unsupported(this.name, field, instead);
  }

  // -------------------------------------------------------------------------
  // Verifying what the device returns
  // -------------------------------------------------------------------------

  private signedTransactionOf(result: CheckoutResult): TransactionPayload {
    const parsed = parseInput(AppStoreCheckoutResultSchema, result, `checkout result (expected { ${AppStoreResultKey.SignedTransaction} })`, this.name);
    return this.#verifier.transaction(parsed[AppStoreResultKey.SignedTransaction]);
  }

  /**
   * Verifies the signed transaction the device returned, then reads the subscription's current state from the Server API.
   * `subscriptionId` is the `originalTransactionId` and `reference` the app account token; `authorized` is true while the
   * subscription is `active` or `trialing`.
   */
  async verifyCheckout(result: CheckoutResult): Promise<CheckoutVerification> {
    const transaction = this.signedTransactionOf(result);
    if (!isSubscriptionTransaction(transaction)) {
      throw invalid(
        `transaction ${transaction.transactionId} is not an auto-renewable subscription (${transaction.type ?? 'no type'}); use verifyPayment for a one-time purchase`,
        this.name,
      );
    }
    const statuses = await this.get(AppStorePath.subscriptionStatuses(transaction.transactionId), StatusResponseSchema, 'subscription statuses');
    const subscription = this.subscriptionFrom(statuses, transaction.originalTransactionId);
    const authorized = subscription.status === SubscriptionStatus.Active || subscription.status === SubscriptionStatus.Trialing;
    const reference = transaction.appAccountToken ?? subscription.reference;
    const charge = isForeignCurrency(transaction.currency) ? undefined : mapCharge(transaction);
    return {
      provider: this.name,
      subscriptionId: subscription.id,
      ...(reference ? { reference } : {}),
      authorized,
      status: subscription.status,
      ...(charge ? { charge } : {}),
      raw: subscription.raw,
    };
  }

  /**
   * Verifies the signed transaction the device returned, then reads the transaction from the Server API. `paymentId` is the
   * `transactionId` and `reference` the app account token; `paid` is true unless the transaction was refunded or revoked.
   */
  override async verifyPayment(result: CheckoutResult): Promise<PaymentVerification> {
    const signed = this.signedTransactionOf(result);
    if (isSubscriptionTransaction(signed)) {
      throw invalid(`transaction ${signed.transactionId} is an auto-renewable subscription; use verifyCheckout`, this.name);
    }
    const current = await this.readTransaction(signed.transactionId);
    const payment = mapPayment(current);
    const reference = signed.appAccountToken ?? current.appAccountToken;
    return {
      provider: this.name,
      paymentId: current.transactionId,
      ...(reference ? { reference } : {}),
      paid: payment.status === PaymentStatus.Succeeded,
      status: payment.status,
      payment,
      raw: current,
    };
  }

  /** Reads one transaction and verifies it; the answer must be the transaction asked for. */
  private async readTransaction(transactionId: string): Promise<TransactionPayload> {
    const response = await this.get(AppStorePath.transaction(transactionId), TransactionInfoResponseSchema, 'transaction');
    const transaction = this.#verifier.transaction(response.signedTransactionInfo);
    if (transaction.transactionId !== transactionId) {
      throw new SubscriptionError(
        ErrorCode.UnexpectedResponse,
        `${this.name} answered with transaction ${transaction.transactionId} for ${transactionId}`,
        { provider: this.name },
      );
    }
    return transaction;
  }

  // -------------------------------------------------------------------------
  // Reading state
  // -------------------------------------------------------------------------

  /** A store id is a number-like text; a UUID is the app account token this adapter minted, which names no purchase. */
  private assertStoreId(id: string, what: string): void {
    if (id.trim() === '') throw invalid(`${what} is required`, this.name);
    if (UUID_PATTERN.test(id)) {
      throw invalid(
        `${id} is an app account token, not an App Store id: pass the originalTransactionId that verifyCheckout returned as subscriptionId (or the transactionId that verifyPayment returned as paymentId)`,
        this.name,
      );
    }
  }

  /**
   * The subscription whose `originalTransactionId` (or whose latest transaction's `transactionId`) is `wanted`, from a Get All
   * Subscription Statuses answer. Only the chosen entry's signed data is read, after it verified.
   */
  private subscriptionFrom(statuses: StatusResponse, wanted: string): Subscription {
    const entries = (statuses.data ?? []).flatMap((group) => group.lastTransactions ?? []);
    let entry = entries.find((candidate) => candidate.originalTransactionId === wanted);
    let transaction = entry ? this.#verifier.transaction(entry.signedTransactionInfo) : undefined;
    if (entry && transaction?.originalTransactionId !== wanted) {
      // The entry's own id is not signed; the signed transaction must agree with it.
      throw new SubscriptionError(ErrorCode.UnexpectedResponse, `${this.name} listed subscription ${wanted} with the transaction of another subscription`, {
        provider: this.name,
      });
    }
    if (!entry) {
      for (const candidate of entries) {
        const verified = this.#verifier.transaction(candidate.signedTransactionInfo);
        if (verified.transactionId === wanted) {
          entry = candidate;
          transaction = verified;
          break;
        }
      }
    }
    if (!entry || !transaction) throw notFound(`${this.name} has no subscription ${wanted} for this app; pass the originalTransactionId`);
    const renewal = entry.signedRenewalInfo ? this.#verifier.renewalInfo(entry.signedRenewalInfo) : undefined;
    return mapSubscription({ status: entry.status, transaction, renewal });
  }

  /** `subscriptionId` is the `originalTransactionId`, or the `transactionId` of the subscription's latest transaction. */
  async getSubscription(subscriptionId: string): Promise<Subscription> {
    this.assertStoreId(subscriptionId, 'subscriptionId');
    const statuses = await this.get(AppStorePath.subscriptionStatuses(subscriptionId), StatusResponseSchema, 'subscription statuses');
    return this.subscriptionFrom(statuses, subscriptionId);
  }

  /**
   * The transactions of a subscription, newest first, read from Get Transaction History (up to
   * `MAX_HISTORY_PAGES` pages of 20, filtered to auto-renewable subscriptions and then to this subscription).
   * `subscriptionId` is the `originalTransactionId` (or any `transactionId` of the subscription). A transaction priced in
   * another currency than INR makes the call fail with `UNSUPPORTED`.
   */
  override async listCharges(subscriptionId: string, rawOptions?: ListChargesOptions): Promise<Charge[]> {
    this.assertStoreId(subscriptionId, 'subscriptionId');
    const options = parseInput(ListChargesOptionsSchema, rawOptions ?? {}, 'list options', this.name);
    const transactions: TransactionPayload[] = [];
    let revision: string | undefined;
    for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
      const response = await this.get(AppStorePath.history(subscriptionId), HistoryResponseSchema, 'transaction history', {
        [HISTORY_QUERY_PRODUCT_TYPE]: HISTORY_PRODUCT_TYPE_AUTO_RENEWABLE,
        [HISTORY_QUERY_SORT]: HISTORY_SORT_DESCENDING,
        ...(revision ? { [HISTORY_QUERY_REVISION]: revision } : {}),
      });
      for (const signed of response.signedTransactions ?? []) transactions.push(this.#verifier.transaction(signed));
      if (!response.hasMore || !response.revision) break;
      revision = response.revision;
    }
    // The id may be a transactionId: its transaction names the subscription.
    const original = transactions.find((transaction) => transaction.transactionId === subscriptionId)?.originalTransactionId ?? subscriptionId;
    return transactions
      .filter((transaction) => transaction.originalTransactionId === original)
      .sort((a, b) => (b.purchaseDate ?? 0) - (a.purchaseDate ?? 0))
      .slice(0, options.limit ?? DEFAULT_LIST_CHARGES_LIMIT)
      .map(mapCharge);
  }

  /** `chargeId` is the `transactionId`; it must belong to the subscription (`NOT_FOUND` otherwise). */
  override async getCharge(subscriptionId: string, chargeId: string): Promise<Charge> {
    this.assertStoreId(subscriptionId, 'subscriptionId');
    this.assertStoreId(chargeId, 'chargeId');
    const transaction = await this.readTransaction(chargeId);
    if (!isSubscriptionTransaction(transaction) || (transaction.originalTransactionId !== subscriptionId && transaction.transactionId !== subscriptionId)) {
      throw notFound(`${this.name} transaction ${chargeId} is not a charge of subscription ${subscriptionId}`);
    }
    return mapCharge(transaction);
  }

  /** `paymentId` is the `transactionId` of a one-time purchase. */
  override async getPayment(paymentId: string): Promise<Payment> {
    this.assertStoreId(paymentId, 'paymentId');
    const transaction = await this.readTransaction(paymentId);
    if (isSubscriptionTransaction(transaction)) {
      throw invalid(`transaction ${paymentId} belongs to an auto-renewable subscription; read it with getCharge or getSubscription`, this.name);
    }
    return mapPayment(transaction);
  }

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------

  /**
   * App Store Server Notifications V2. The body is `{ signedPayload }`; the payload and the signed transaction and renewal
   * information inside it are verified (chain, signature, bundle id, environment, app Apple id in production) before anything
   * is read, and anything that fails is `SIGNATURE_INVALID`. The result is one event whose `id` is the notification's UUID.
   */
  parseWebhook(request: WebhookRequest): SubscriptionEvent[] {
    let body: unknown;
    try {
      body = JSON.parse(request.rawBody);
    } catch {
      throw this.unverifiable('the body is not JSON');
    }
    const parsed = NotificationBodySchema.safeParse(body);
    if (!parsed.success) throw this.unverifiable('the body has no signedPayload');
    const payload = this.#verifier.notification(parsed.data.signedPayload);
    const data = payload.data;
    const transaction = data?.signedTransactionInfo ? this.#verifier.transaction(data.signedTransactionInfo) : undefined;
    const renewal = data?.signedRenewalInfo ? this.#verifier.renewalInfo(data.signedRenewalInfo) : undefined;
    return [mapNotification({ payload, transaction, renewal })];
  }

  private unverifiable(why: string): SubscriptionError {
    return new SubscriptionError(ErrorCode.SignatureInvalid, `${this.name} notification did not verify: ${why}`, { provider: this.name });
  }

  // -------------------------------------------------------------------------
  // What a store cannot do from the server
  // -------------------------------------------------------------------------

  override createPlan(_input: CreatePlanInput): Promise<Plan> {
    return Promise.reject(unsupported(this.name, 'creating plans', 'create the subscription and its price in App Store Connect, then pass its product id as storeProduct.productId'));
  }

  override getPlan(_planId: string): Promise<Plan> {
    return Promise.reject(unsupported(this.name, 'fetching plans', 'products and prices live in App Store Connect'));
  }

  override cancelSubscription(_subscriptionId: string, _options?: CancelSubscriptionOptions): Promise<Subscription> {
    return Promise.reject(
      unsupported(
        this.name,
        'cancelling subscriptions',
        `${CUSTOMER_MANAGES}; the cancellation reaches you as a DID_CHANGE_RENEWAL_STATUS notification (subscription.updated with cancelAtPeriodEnd) and, at the period end, as EXPIRED`,
      ),
    );
  }

  override pauseSubscription(_subscriptionId: string, _options?: PauseSubscriptionOptions): Promise<Subscription> {
    return Promise.reject(unsupported(this.name, 'pausing subscriptions', 'the App Store has no pause; the customer cancels in Settings > Apple Account > Subscriptions and resubscribes later'));
  }

  override resumeSubscription(_subscriptionId: string, _options?: ResumeSubscriptionOptions): Promise<Subscription> {
    return Promise.reject(unsupported(this.name, 'resuming subscriptions', 'the customer turns renewal back on, or resubscribes, in the App Store (the app can show the sheet with AppStore.showManageSubscriptions(in:))'));
  }

  override updateSubscription(_subscriptionId: string, _input: UpdateSubscriptionInput): Promise<Subscription> {
    return Promise.reject(
      unsupported(
        this.name,
        'updating subscriptions',
        'the customer upgrades or downgrades by buying another product of the same subscription group in the app; the change reaches you as a DID_CHANGE_RENEWAL_PREF notification',
      ),
    );
  }

  override refundCharge(_input: RefundInput): Promise<Refund> {
    return Promise.reject(this.noRefunds());
  }

  override refundPayment(_input: RefundPaymentInput): Promise<Refund> {
    return Promise.reject(this.noRefunds());
  }

  private noRefunds(): SubscriptionError {
    return unsupported(
      this.name,
      'refunds',
      'Apple decides refunds: the customer asks in the app (Transaction.beginRefundRequest(for:in:)) or on reportaproblem.apple.com, and the outcome reaches you as a REFUND or REFUND_DECLINED notification',
    );
  }
}

/** Creates the Apple App Store provider. */
export function appStore(config: AppStoreConfig, options?: AppStoreProviderOptions): AppStoreProvider {
  return new AppStoreProvider(config, options);
}
