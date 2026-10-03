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
 *
 * ## The contract of a merchant-scheduled gateway (`capabilities.merchantCharges: true`)
 *
 * The billing scheduler (`BillingScheduler`, reached through `Subscriptions`) raises every debit of such a gateway. It
 * relies on exactly this, and `test/helpers/merchant-adapter-conformance.ts` checks it against any adapter:
 *
 * 1. `createSubscription` returns `amount`, `interval` and `startAt` (the instant of the first charge) on the
 *    subscription, plus `scheduling: 'merchant'`. The facade registers the schedule from them and refuses a subscription
 *    without them (cancelling it again). `id` is what `getSubscription` and the debit calls accept for the mandate; if
 *    the id only exists after the customer authorises (PayU), `verifyCheckout` returns it as `subscriptionId` and
 *    `reference` carries the merchant's own reference.
 * 2. `createCharge({ subscriptionId, chargeId, amount, ... })`: `chargeId` is the merchant's debit id, deterministic per
 *    schedule, cycle and attempt. The scheduler may send the SAME `chargeId` again after an unknown outcome (no answer, a
 *    crash), so the call must be safe to repeat: either it raises one debit per `chargeId` (returning the existing one), or
 *    the gateway rejects the duplicate. If the gateway does neither (PayU's test environment debits again for a repeated
 *    transaction id), the ADAPTER must provide the guarantee itself: look the `chargeId` up before debiting and return the
 *    existing debit when there is one (a lookup that fails for any reason but "not found" aborts before debiting). The scheduler never books a failed attempt, or uses a new id, for a re-sent id,
 *    whatever error it gets back; it asks `getCharge`. `OUTCOME_UNKNOWN` (a write that got no answer) is the right code
 *    for anything that may have taken effect; use `VALIDATION`, `PROVIDER_ERROR`, `AUTH`, `UNSUPPORTED` or `NOT_FOUND`
 *    only when the gateway answered and refused, because the FIRST attempt with such a code counts as a failed debit.
 * 3. `getCharge(subscriptionId, chargeId)` takes the merchant's `chargeId` and answers `NOT_FOUND` only when the
 *    gateway has no trace of the debit (a gateway whose status API lags must not answer `NOT_FOUND` for a debit it
 *    holds). Any other failure must not be `NOT_FOUND`. The returned `Charge.status` is `succeeded`, `failed` or
 *    `cancelled` when final, `pending` or `scheduled` while it is in flight.
 * 4. Ids sent to the gateway (`chargeId`, `notificationId`) are at most `MAX_GATEWAY_ID_LENGTH` characters of
 *    `GATEWAY_ID_PATTERN` (`[A-Za-z0-9_-]`); the adapter must accept them as they are.
 * 5. Webhook events about a debit carry the merchant's debit id in `charge.id` or `charge.reference` (so the scheduler can
 *    match them to the cycle through `SchedulerStore.findScheduleByChargeId`) and `subscriptionId` where the gateway sends
 *    one. A debit that succeeded is `subscription.charged`, one that failed or was cancelled is
 *    `subscription.charge_failed`. Mandate events carry `subscriptionId` (and `subscription.reference` where known):
 *    `subscription.paused` / `subscription.resumed` / `subscription.cancelled` / `subscription.halted` /
 *    `subscription.activated` change the schedule.
 * 6. `merchantPreDebitNotification: true`: the merchant must tell the customer before each debit. The scheduler calls
 *    `notifyCharge` at due minus its `notifyLeadHours`, keeps the returned `invoiceNumber`, passes it to `createCharge`,
 *    and debits only once the gateway's minimum notice has passed. An adapter whose method needs no notice returns an
 *    accepted notification without a request. `merchantChargeLeadHours: n` (and no notification): the gateway notifies
 *    the customer itself once a charge exists, so the scheduler calls `createCharge` at least `n` hours before the due
 *    date with `scheduledAt` set to the debit date (never further ahead than `merchantChargeMaxAheadHours`), and the
 *    adapter must accept every `scheduledAt` the scheduler sends within those limits. Neither set: `createCharge` is
 *    called on the due date.
 * 7. A gateway that ties a debit to its notification (PhonePe: the debit uses the notification's merchant order id and the
 *    amount the notification fixed) returns that id as `ChargeNotification.chargeId`. The scheduler then uses it, as
 *    given, as the `chargeId` of `createCharge` and `getCharge` for that attempt, in place of the id it would generate,
 *    and matches webhook events to the cycle by it. It is saved with the notification before any charge call. A retry
 *    sends a fresh notification and adopts the new one's `chargeId`. The same unknown-outcome rules apply to it: the
 *    id is re-sent, never replaced, until `getCharge` settles the attempt.
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
