import type { z } from 'zod';
import { ErrorCode, type Provider } from './constants.js';
import { SubscriptionError, parseResponse, unsupported } from './errors.js';
import { HttpClient, codeForStatus, type HttpOptions, type HttpRequest, type HttpResponse } from './http.js';
import type {
  CancelSubscriptionOptions,
  Capabilities,
  Charge,
  ChargeNotification,
  CheckoutResult,
  CheckoutVerification,
  CreateChargeInput,
  CreatePlanInput,
  CreateSubscriptionInput,
  ListChargesOptions,
  NotifyChargeInput,
  PauseSubscriptionOptions,
  Plan,
  Refund,
  RefundInput,
  ResumeSubscriptionOptions,
  Subscription,
  SubscriptionEvent,
  UpdateSubscriptionInput,
  WebhookRequest,
} from './schemas.js';

export interface ProviderOptions extends HttpOptions {
  /** Clock override for tests and deterministic scheduling. */
  now?: () => Date;
}

/**
 * The contract every gateway adapter implements. All inputs and outputs are
 * the gateway-neutral shapes from `schemas.ts`; adapters validate inputs with
 * those schemas, validate gateway responses with their own, and translate.
 *
 * Operations a gateway cannot perform throw `SubscriptionError` with code
 * `UNSUPPORTED` — check `capabilities` first to avoid them.
 */
export interface SubscriptionProvider {
  readonly name: Provider;
  readonly capabilities: Capabilities;

  createPlan(input: CreatePlanInput): Promise<Plan>;
  getPlan(planId: string): Promise<Plan>;

  /** Creates the subscription and returns it with `checkout` instructions for the customer. */
  createSubscription(input: CreateSubscriptionInput): Promise<Subscription>;
  getSubscription(subscriptionId: string): Promise<Subscription>;
  cancelSubscription(subscriptionId: string, options?: CancelSubscriptionOptions): Promise<Subscription>;
  pauseSubscription(subscriptionId: string, options?: PauseSubscriptionOptions): Promise<Subscription>;
  resumeSubscription(subscriptionId: string, options?: ResumeSubscriptionOptions): Promise<Subscription>;
  updateSubscription(subscriptionId: string, input: UpdateSubscriptionInput): Promise<Subscription>;

  listCharges(subscriptionId: string, options?: ListChargesOptions): Promise<Charge[]>;
  getCharge(subscriptionId: string, chargeId: string): Promise<Charge>;
  /** Sends the pre-debit notification for an upcoming merchant-raised charge. */
  notifyCharge(input: NotifyChargeInput): Promise<ChargeNotification>;
  /** Raises a recurring debit against the mandate (merchant-scheduled subscriptions). */
  createCharge(input: CreateChargeInput): Promise<Charge>;
  refundCharge(input: RefundInput): Promise<Refund>;

  /**
   * Verifies what the gateway returned to the browser / return URL after the
   * customer authorised. Throws `SIGNATURE_INVALID` if it was tampered with.
   */
  verifyCheckout(result: CheckoutResult): Promise<CheckoutVerification>;
  /**
   * Verifies a webhook's signature and returns its normalised events.
   * Throws `SIGNATURE_INVALID` when verification fails.
   */
  parseWebhook(request: WebhookRequest): SubscriptionEvent[];
}

export interface GatewayErrorInfo {
  message: string;
  providerCode?: string;
}

/**
 * Shared plumbing for adapters: an HTTP client, a clock, and one `send` that
 * maps gateway failures to `SubscriptionError` and validates the response
 * body. Every optional operation defaults to throwing `UNSUPPORTED`, so an
 * adapter overrides only what its gateway can do.
 */
export abstract class BaseProvider implements SubscriptionProvider {
  abstract readonly name: Provider;
  abstract readonly capabilities: Capabilities;

  protected readonly http: HttpClient;
  private readonly clock: () => Date;

  constructor(options: ProviderOptions = {}) {
    this.http = new HttpClient(options);
    this.clock = options.now ?? (() => new Date());
  }

  protected now(): Date {
    return this.clock();
  }

  /** Extracts the gateway's error message and code from a non-2xx response. */
  protected abstract describeError(response: HttpResponse): GatewayErrorInfo;

  /** Sends a request, throws a mapped error on non-2xx, and returns the validated body. */
  protected async send<S extends z.ZodType>(
    request: Omit<HttpRequest, 'provider'>,
    schema: S,
    what: string,
  ): Promise<z.output<S>> {
    const response = await this.sendRaw(request);
    if (response.json === undefined && response.text !== '') {
      throw new SubscriptionError(
        ErrorCode.UnexpectedResponse,
        `${this.name} returned a ${what} that is not JSON`,
        { provider: this.name, httpStatus: response.status, raw: response.text },
      );
    }
    return parseResponse(schema, response.json, what, this.name);
  }

  /** Sends a request and throws a mapped error on non-2xx; returns the raw response. */
  protected async sendRaw(request: Omit<HttpRequest, 'provider'>): Promise<HttpResponse> {
    const response = await this.http.send({ ...request, provider: this.name });
    if (response.status < 200 || response.status >= 300) {
      throw this.errorFromResponse(response, request.idempotent);
    }
    return response;
  }

  protected errorFromResponse(response: HttpResponse, idempotent: boolean): SubscriptionError {
    const info = this.describeError(response);
    return new SubscriptionError(
      codeForStatus(response.status, idempotent),
      `${this.name} responded ${response.status}: ${info.message}`,
      {
        provider: this.name,
        httpStatus: response.status,
        providerCode: info.providerCode,
        raw: response.json ?? response.text,
      },
    );
  }

  createPlan(_input: CreatePlanInput): Promise<Plan> {
    return Promise.reject(unsupported(this.name, 'creating plans'));
  }
  getPlan(_planId: string): Promise<Plan> {
    return Promise.reject(unsupported(this.name, 'fetching plans'));
  }
  abstract createSubscription(input: CreateSubscriptionInput): Promise<Subscription>;
  abstract getSubscription(subscriptionId: string): Promise<Subscription>;
  abstract cancelSubscription(subscriptionId: string, options?: CancelSubscriptionOptions): Promise<Subscription>;
  pauseSubscription(_subscriptionId: string, _options?: PauseSubscriptionOptions): Promise<Subscription> {
    return Promise.reject(unsupported(this.name, 'pausing subscriptions'));
  }
  resumeSubscription(_subscriptionId: string, _options?: ResumeSubscriptionOptions): Promise<Subscription> {
    return Promise.reject(unsupported(this.name, 'resuming subscriptions'));
  }
  updateSubscription(_subscriptionId: string, _input: UpdateSubscriptionInput): Promise<Subscription> {
    return Promise.reject(unsupported(this.name, 'updating subscriptions'));
  }
  listCharges(_subscriptionId: string, _options?: ListChargesOptions): Promise<Charge[]> {
    return Promise.reject(unsupported(this.name, 'listing charges'));
  }
  getCharge(_subscriptionId: string, _chargeId: string): Promise<Charge> {
    return Promise.reject(unsupported(this.name, 'fetching a charge'));
  }
  notifyCharge(_input: NotifyChargeInput): Promise<ChargeNotification> {
    return Promise.reject(unsupported(this.name, 'merchant-sent pre-debit notifications'));
  }
  createCharge(_input: CreateChargeInput): Promise<Charge> {
    return Promise.reject(unsupported(this.name, 'merchant-raised charges'));
  }
  refundCharge(_input: RefundInput): Promise<Refund> {
    return Promise.reject(unsupported(this.name, 'refunds'));
  }
  abstract verifyCheckout(result: CheckoutResult): Promise<CheckoutVerification>;
  abstract parseWebhook(request: WebhookRequest): SubscriptionEvent[];
}
