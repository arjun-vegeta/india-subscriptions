import type { z } from 'zod';
import {
  CancelMode,
  ChangeTiming,
  Currency,
  ErrorCode,
  HeaderName,
  HttpMethod,
  PaymentMethod,
  Provider,
  ProviderKind,
  SchedulingMode,
  ContentType,
} from '../../constants.js';
import { sha256Hmac, assertSignature, getHeader } from '../../crypto.js';
import { SubscriptionError, invalid, parseInput, parseResponse, unsupported } from '../../errors.js';
import { basicAuth, withQuery, type HttpResponse } from '../../http.js';
import { BaseProvider, type GatewayErrorInfo, type ProviderOptions } from '../../provider.js';
import {
  CancelSubscriptionOptionsSchema,
  CreatePlanInputSchema,
  CreateSubscriptionInputSchema,
  ListChargesOptionsSchema,
  PauseSubscriptionOptionsSchema,
  RefundInputSchema,
  ResumeSubscriptionOptionsSchema,
  UpdateSubscriptionInputSchema,
  WebhookRequestSchema,
  type CancelSubscriptionOptions,
  type Capabilities,
  type Charge,
  type CheckoutResult,
  type CheckoutVerification,
  type CreatePlanInput,
  type CreateSubscriptionInput,
  type ListChargesOptions,
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
import { resolveFirstChargeAt, toDate, toUnixSeconds } from '../../time.js';
import {
  RAZORPAY_BASE_URL,
  RAZORPAY_DEFAULT_UPFRONT_LABEL,
  RAZORPAY_ERROR_DESCRIPTION_RULES,
  RAZORPAY_EXPECTED_SUBSCRIPTION_ID_KEY,
  RAZORPAY_MAX_INVOICE_PAGES,
  RAZORPAY_PAGE_SIZE,
  RazorpayEndpoint,
  RazorpayHeader,
  RazorpayIdPrefix,
  RazorpayNoteKey,
  RazorpayPauseAt,
  RazorpayResumeAt,
  RazorpayScheduleChangeAt,
  RazorpaySubscriptionStatus,
} from './constants.js';
import {
  buildCheckout,
  buildNotes,
  buildPlanRequest,
  cyclesInYears,
  describeErrorBody,
  isTerminal,
  mapInvoiceToCharge,
  mapInvoicesToCharges,
  mapPaymentToCharge,
  mapPlan,
  mapRefund,
  mapSubscription,
  mapWebhookEvent,
  planContext,
  wholeCyclesBetween,
  type PlanContext,
} from './mapper.js';
import {
  RazorpayCancelRequestSchema,
  RazorpayCheckoutResponseSchema,
  RazorpayConfigSchema,
  RazorpayCreatePlanRequestSchema,
  RazorpayCreateSubscriptionRequestSchema,
  RazorpayErrorBodySchema,
  RazorpayInvoiceCollectionSchema,
  RazorpayInvoiceEntitySchema,
  RazorpayInvoiceQuerySchema,
  RazorpayPauseRequestSchema,
  RazorpayPaymentEntitySchema,
  RazorpayPlanEntitySchema,
  RazorpayRefundEntitySchema,
  RazorpayRefundRequestSchema,
  RazorpayResumeRequestSchema,
  RazorpaySubscriptionEntitySchema,
  RazorpayUpdateRequestSchema,
  RazorpayWebhookBodySchema,
  type ParsedRazorpayConfig,
  type RazorpayConfig,
  type RazorpayCreateSubscriptionRequest,
  type RazorpayInvoiceEntity,
  type RazorpayPlanEntity,
  type RazorpaySubscriptionEntity,
  type RazorpayUpdateRequest,
} from './schemas.js';

const ERROR_TEXT_PREVIEW_CHARS = 200;

function parseConfig(config: unknown): ParsedRazorpayConfig {
  const result = RazorpayConfigSchema.safeParse(config);
  if (result.success) return result.data;
  // Paths and messages only: never the offending values, which may be secrets.
  const issues = result.error.issues
    .map((issue) => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
  throw new SubscriptionError(ErrorCode.Config, `Invalid ${Provider.Razorpay} config: ${issues}`, {
    provider: Provider.Razorpay,
  });
}

function requireId(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${what} is required`, Provider.Razorpay);
  return value;
}

/**
 * Razorpay adapter. Razorpay raises every recurring charge itself on the
 * plan's schedule, so `createCharge` / `notifyCharge` stay unsupported.
 *
 * Fields with no Razorpay equivalent on `POST /v1/subscriptions` are accepted
 * and ignored, and `capabilities` says so:
 * - `idempotencyKey`: no idempotency mechanism exists for plans or
 *   subscriptions (fact sheet 1.6), hence `idempotencyKeys: false`. A create
 *   that gets no response is `OUTCOME_UNKNOWN` and must not be blindly retried.
 * - `paymentMethods`: the customer picks the method in checkout; there is no
 *   API parameter to restrict it (fact sheet section 5).
 * - `customer`: Razorpay collects customer details at checkout, so they are
 *   not sent; they come back as `checkout.prefill`.
 */
export class RazorpayProvider extends BaseProvider {
  readonly name = Provider.Razorpay;

  readonly capabilities: Capabilities = {
    provider: Provider.Razorpay,
    kind: ProviderKind.Gateway,
    scheduling: [SchedulingMode.Gateway],
    gatewayPlans: true,
    trial: true,
    upfrontAmount: true,
    quantity: true,
    pause: true,
    resume: true,
    cancel: true,
    cancelAtPeriodEnd: true,
    changePlan: true,
    merchantCharges: false,
    merchantPreDebitNotification: false,
    listCharges: true,
    refunds: true,
    signedWebhooks: true,
    idempotencyKeys: false,
    // "Razorpay Subscriptions supports Cards, UPI Autopay and Emandate."
    paymentMethods: [PaymentMethod.Card, PaymentMethod.Upi, PaymentMethod.ENach],
    oneTimePayments: false,
    oneTimePaymentMethods: [],
  };

  // ES private fields: invisible to JSON.stringify, console.log and spreads, so the secrets cannot leak.
  readonly #config: ParsedRazorpayConfig;
  readonly #authorization: string;
  readonly #baseUrl: string;

  constructor(config: RazorpayConfig, options: ProviderOptions = {}) {
    const parsed = parseConfig(config);
    super(options);
    this.#config = parsed;
    this.#authorization = basicAuth(parsed.keyId, parsed.keySecret);
    this.#baseUrl = (parsed.baseUrl ?? RAZORPAY_BASE_URL).replace(/\/+$/, '');
  }

  // -------------------------------------------------------------------------
  // HTTP plumbing
  // -------------------------------------------------------------------------

  private call<S extends z.ZodType>(
    method: HttpMethod,
    path: string,
    schema: S,
    what: string,
    options: { body?: unknown; query?: Record<string, string | number | undefined> } = {},
  ): Promise<z.output<S>> {
    const url = withQuery(`${this.#baseUrl}${path}`, options.query ?? {});
    const headers: Record<string, string> = {
      [HeaderName.Authorization]: this.#authorization,
      [HeaderName.Accept]: ContentType.Json,
    };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers[HeaderName.ContentType] = ContentType.Json;
      body = JSON.stringify(options.body);
    }
    // Only reads are safe to repeat: Razorpay has no idempotency key for writes.
    return this.send({ method, url, headers, body, idempotent: method === HttpMethod.Get }, schema, what);
  }

  protected describeError(response: HttpResponse): GatewayErrorInfo {
    const parsed = RazorpayErrorBodySchema.safeParse(response.json);
    if (parsed.success) return describeErrorBody(parsed.data);
    const text = response.text.trim();
    return { message: text ? text.slice(0, ERROR_TEXT_PREVIEW_CHARS) : 'empty response body' };
  }

  /**
   * Razorpay reports most failures as HTTP 400. A 400 whose description is one
   * of the documented "not found", "bad credentials" or "operation in
   * progress" texts is refined to NOT_FOUND, AUTH or CONFLICT.
   */
  protected override errorFromResponse(response: HttpResponse, idempotent: boolean): SubscriptionError {
    const error = super.errorFromResponse(response, idempotent);
    if (response.status !== 400) return error;
    const parsed = RazorpayErrorBodySchema.safeParse(response.json);
    const description = parsed.success ? (parsed.data.error.description ?? '') : '';
    const rule = RAZORPAY_ERROR_DESCRIPTION_RULES.find(({ pattern }) => pattern.test(description));
    if (!rule) return error;
    return new SubscriptionError(rule.code, error.message, {
      provider: this.name,
      httpStatus: error.httpStatus,
      providerCode: error.providerCode,
      raw: error.raw,
    });
  }

  // -------------------------------------------------------------------------
  // Plans
  // -------------------------------------------------------------------------

  override async createPlan(rawInput: CreatePlanInput): Promise<Plan> {
    const input = parseInput(CreatePlanInputSchema, rawInput, 'plan input', this.name);
    if (input.scheduling === SchedulingMode.Merchant) {
      throw unsupported(this.name, 'merchant-scheduled plans', 'Razorpay raises every charge itself');
    }
    // `input.maxAmount` is not sent: Razorpay has no per-plan mandate ceiling.
    return mapPlan(await this.postPlan(input));
  }

  override async getPlan(planId: string): Promise<Plan> {
    return mapPlan(await this.fetchPlan(requireId(planId, 'planId')));
  }

  private async postPlan(input: z.output<typeof CreatePlanInputSchema>): Promise<RazorpayPlanEntity> {
    const request = parseInput(RazorpayCreatePlanRequestSchema, buildPlanRequest(input), 'Razorpay plan request', this.name);
    return this.call(HttpMethod.Post, RazorpayEndpoint.plans, RazorpayPlanEntitySchema, 'plan', { body: request });
  }

  private fetchPlan(planId: string): Promise<RazorpayPlanEntity> {
    return this.call(HttpMethod.Get, RazorpayEndpoint.plan(planId), RazorpayPlanEntitySchema, 'plan');
  }

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------

  async createSubscription(rawInput: CreateSubscriptionInput): Promise<Subscription> {
    const input = parseInput(CreateSubscriptionInputSchema, rawInput, 'subscription input', this.name);
    const now = this.now();
    const { firstChargeAt } = resolveFirstChargeAt(input, now);
    const inlinePlan = typeof input.plan === 'string' ? undefined : input.plan;
    if (inlinePlan?.scheduling === SchedulingMode.Merchant) {
      throw unsupported(this.name, 'merchant-scheduled plans', 'Razorpay raises every charge itself');
    }
    const notes = buildNotes(input.metadata, { [RazorpayNoteKey.Reference]: input.reference });
    // Before authorisation the first charge date is unknown, so cycles are counted from now.
    const anchor = firstChargeAt ?? now;

    // Everything that can fail without touching the network happens before the
    // first call, so a bad request never leaves an orphaned plan behind.
    let plan: PlanContext | undefined;
    let planId: string | undefined;
    if (inlinePlan) {
      plan = { amount: inlinePlan.amount, interval: inlinePlan.interval, maxCycles: inlinePlan.maxCycles };
    } else {
      planId = requireId(input.plan, 'plan');
      // The plan's period is needed only to derive `total_count` or to check it against `mandateEndsAt`.
      if (input.totalCycles === undefined || input.mandateEndsAt !== undefined) {
        plan = planContext(await this.fetchPlan(planId));
      }
    }
    const totalCount = this.resolveTotalCount(input, plan, anchor);
    const upfront =
      input.upfrontAmount === undefined
        ? undefined
        : [{ item: { name: input.upfrontLabel ?? RAZORPAY_DEFAULT_UPFRONT_LABEL, amount: input.upfrontAmount, currency: Currency.INR } }];

    let createdPlan: RazorpayPlanEntity | undefined;
    if (inlinePlan) {
      createdPlan = await this.postPlan(inlinePlan);
      planId = createdPlan.id;
      plan = planContext(createdPlan);
    }

    const request: RazorpayCreateSubscriptionRequest = parseInput(
      RazorpayCreateSubscriptionRequestSchema,
      {
        plan_id: planId,
        total_count: totalCount,
        quantity: input.quantity,
        // A trial is a future start_at: "The time between [authentication] and [start date] is treated as the trial period."
        start_at: firstChargeAt ? toUnixSeconds(firstChargeAt) : undefined,
        expire_by: input.authorizeBy ? toUnixSeconds(toDate(input.authorizeBy, 'authorizeBy')) : undefined,
        customer_notify: input.notifyCustomer,
        addons: upfront,
        notes,
      } satisfies Record<keyof RazorpayCreateSubscriptionRequest, unknown>,
      'Razorpay subscription request',
      this.name,
    );

    const entity = await this.call(
      HttpMethod.Post,
      RazorpayEndpoint.subscriptions,
      RazorpaySubscriptionEntitySchema,
      'subscription',
      { body: request },
    );
    const checkout = buildCheckout({
      keyId: this.#config.keyId,
      subscriptionId: entity.id,
      shortUrl: entity.short_url,
      callbackUrl: input.returnUrl,
      customer: input.customer,
    });
    return mapSubscription(entity, { plan, checkout });
  }

  /**
   * Razorpay requires `total_count`. Precedence: the explicit `totalCycles`;
   * else the plan's `maxCycles`; else the whole cycles between the first
   * charge and `mandateEndsAt`; else the cycles in `defaultDurationYears`.
   * An explicit count that disagrees with `mandateEndsAt` is rejected.
   */
  private resolveTotalCount(
    input: z.output<typeof CreateSubscriptionInputSchema>,
    plan: PlanContext | undefined,
    anchor: Date,
  ): number {
    const explicit = input.totalCycles ?? plan?.maxCycles;
    const interval = plan?.interval;

    let fromMandate: number | undefined;
    if (input.mandateEndsAt !== undefined) {
      if (!interval) throw invalid('Cannot derive total_count from mandateEndsAt: the plan period is not recognised', this.name);
      fromMandate = wholeCyclesBetween(anchor, toDate(input.mandateEndsAt, 'mandateEndsAt'), interval);
      if (fromMandate < 1) {
        throw invalid('mandateEndsAt leaves no whole billing cycle after the first charge; move it later', this.name);
      }
    }
    if (explicit !== undefined && fromMandate !== undefined && explicit !== fromMandate) {
      const source = input.totalCycles !== undefined ? 'totalCycles' : "the plan's maxCycles";
      throw invalid(
        `${source} (${explicit}) disagrees with mandateEndsAt, which allows ${fromMandate} whole billing cycle(s). ` +
          'Pass one of them, or make them agree.',
        this.name,
      );
    }
    if (explicit !== undefined) return explicit;
    if (fromMandate !== undefined) return fromMandate;

    if (!interval) throw invalid('Cannot derive total_count: pass totalCycles (the plan period is not recognised)', this.name);
    const years = this.#config.defaultDurationYears;
    const cycles = cyclesInYears(anchor, years, interval);
    if (cycles < 1) {
      throw invalid(`The plan interval is longer than the ${years}-year default duration; pass totalCycles`, this.name);
    }
    return cycles;
  }

  async getSubscription(subscriptionId: string): Promise<Subscription> {
    return mapSubscription(await this.fetchSubscription(requireId(subscriptionId, 'subscriptionId')));
  }

  private fetchSubscription(subscriptionId: string): Promise<RazorpaySubscriptionEntity> {
    return this.call(
      HttpMethod.Get,
      RazorpayEndpoint.subscription(subscriptionId),
      RazorpaySubscriptionEntitySchema,
      'subscription',
    );
  }

  async cancelSubscription(subscriptionId: string, rawOptions: CancelSubscriptionOptions = {}): Promise<Subscription> {
    const id = requireId(subscriptionId, 'subscriptionId');
    const options = parseInput(CancelSubscriptionOptionsSchema, rawOptions, 'cancel options', this.name);
    const atCycleEnd = options.mode === CancelMode.AtPeriodEnd;
    const request = parseInput(
      RazorpayCancelRequestSchema,
      { cancel_at_cycle_end: atCycleEnd },
      'Razorpay cancel request',
      this.name,
    );
    const entity = await this.call(
      HttpMethod.Post,
      RazorpayEndpoint.cancelSubscription(id),
      RazorpaySubscriptionEntitySchema,
      'subscription',
      { body: request },
    );
    const mapped = mapSubscription(entity);
    // The docs do not say how a pending cycle-end cancellation shows on the entity (and
    // `has_scheduled_changes` is shared with plan updates), so it is reported from the request that was accepted.
    return atCycleEnd && !isTerminal(mapped.status) ? { ...mapped, cancelAtPeriodEnd: true } : mapped;
  }

  override async pauseSubscription(subscriptionId: string, rawOptions: PauseSubscriptionOptions = {}): Promise<Subscription> {
    const id = requireId(subscriptionId, 'subscriptionId');
    const options = parseInput(PauseSubscriptionOptionsSchema, rawOptions, 'pause options', this.name);
    if (options.resumeAt !== undefined) {
      throw unsupported(this.name, 'pausing until a date', 'Razorpay only pauses immediately (pause_at "now")');
    }
    // "If you pause a Subscription in the authenticated state, it goes to the cancelled state." Cancelling is
    // irreversible, so refuse instead of letting a trial be destroyed by a pause.
    const current = await this.fetchSubscription(id);
    if (current.status === RazorpaySubscriptionStatus.Authenticated) {
      throw new SubscriptionError(
        ErrorCode.Conflict,
        `${this.name} would cancel subscription ${id} instead of pausing it: it is in the authenticated (trial or not yet charged) state`,
        { provider: this.name },
      );
    }
    const request = parseInput(RazorpayPauseRequestSchema, { pause_at: RazorpayPauseAt.Now }, 'Razorpay pause request', this.name);
    const entity = await this.call(
      HttpMethod.Post,
      RazorpayEndpoint.pauseSubscription(id),
      RazorpaySubscriptionEntitySchema,
      'subscription',
      { body: request },
    );
    return mapSubscription(entity);
  }

  override async resumeSubscription(subscriptionId: string, rawOptions: ResumeSubscriptionOptions = {}): Promise<Subscription> {
    const id = requireId(subscriptionId, 'subscriptionId');
    const options = parseInput(ResumeSubscriptionOptionsSchema, rawOptions, 'resume options', this.name);
    if (options.nextChargeAt !== undefined) {
      throw unsupported(this.name, 'choosing the next charge date on resume', 'Razorpay only resumes immediately (resume_at "now")');
    }
    const request = parseInput(RazorpayResumeRequestSchema, { resume_at: RazorpayResumeAt.Now }, 'Razorpay resume request', this.name);
    const entity = await this.call(
      HttpMethod.Post,
      RazorpayEndpoint.resumeSubscription(id),
      RazorpaySubscriptionEntitySchema,
      'subscription',
      { body: request },
    );
    return mapSubscription(entity);
  }

  override async updateSubscription(subscriptionId: string, rawInput: UpdateSubscriptionInput): Promise<Subscription> {
    const id = requireId(subscriptionId, 'subscriptionId');
    const input = parseInput(UpdateSubscriptionInputSchema, rawInput, 'update input', this.name);
    if (input.amount !== undefined) {
      throw unsupported(this.name, 'changing the amount of a subscription', 'the amount comes from the plan; switch with planId');
    }
    if (input.mandateEndsAt !== undefined) {
      throw unsupported(this.name, 'changing the mandate end date', 'use remainingCycles to change how many cycles remain');
    }
    const request: RazorpayUpdateRequest = parseInput(
      RazorpayUpdateRequestSchema,
      {
        plan_id: input.planId,
        quantity: input.quantity,
        remaining_count: input.remainingCycles,
        // `nextChargeAt` -> `start_at` ("The new start date for the Subscription"): the docs do not say how this
        // interacts with a billing cycle already running, and Razorpay may reject `start_at` on update (fact sheet 12.1 #9).
        start_at: input.nextChargeAt ? toUnixSeconds(toDate(input.nextChargeAt, 'nextChargeAt')) : undefined,
        schedule_change_at: input.timing === ChangeTiming.AtPeriodEnd ? RazorpayScheduleChangeAt.CycleEnd : RazorpayScheduleChangeAt.Now,
        customer_notify: input.notifyCustomer,
      } satisfies Record<keyof RazorpayUpdateRequest, unknown>,
      'Razorpay update request',
      this.name,
    );
    // UPI and eMandate subscriptions cannot be updated: Razorpay's own 400 surfaces as the mapped error.
    const entity = await this.call(HttpMethod.Patch, RazorpayEndpoint.subscription(id), RazorpaySubscriptionEntitySchema, 'subscription', {
      body: request,
    });
    return mapSubscription(entity);
  }

  // -------------------------------------------------------------------------
  // Charges and refunds
  // -------------------------------------------------------------------------

  override async listCharges(subscriptionId: string, rawOptions: ListChargesOptions = {}): Promise<Charge[]> {
    const id = requireId(subscriptionId, 'subscriptionId');
    const options = parseInput(ListChargesOptionsSchema, rawOptions, 'list options', this.name);

    if (options.limit !== undefined) {
      const page = await this.fetchInvoicePage(id, options.limit, 0);
      return mapInvoicesToCharges(page, { subscriptionId: id, complete: page.length < options.limit });
    }
    // Razorpay returns 10 items unless asked for more, so walk the pages instead of silently truncating.
    const invoices: RazorpayInvoiceEntity[] = [];
    for (let pageNumber = 0; pageNumber < RAZORPAY_MAX_INVOICE_PAGES; pageNumber++) {
      const page = await this.fetchInvoicePage(id, RAZORPAY_PAGE_SIZE, pageNumber * RAZORPAY_PAGE_SIZE);
      invoices.push(...page);
      if (page.length < RAZORPAY_PAGE_SIZE) return mapInvoicesToCharges(invoices, { subscriptionId: id, complete: true });
    }
    throw new SubscriptionError(
      ErrorCode.UnexpectedResponse,
      `${this.name} returned more than ${RAZORPAY_MAX_INVOICE_PAGES * RAZORPAY_PAGE_SIZE} invoices for ${id}; pass limit to read part of them`,
      { provider: this.name },
    );
  }

  private async fetchInvoicePage(subscriptionId: string, count: number, skip: number): Promise<RazorpayInvoiceEntity[]> {
    const query = parseInput(
      RazorpayInvoiceQuerySchema,
      { subscription_id: subscriptionId, count, skip },
      'Razorpay invoice query',
      this.name,
    );
    const collection = await this.call(HttpMethod.Get, RazorpayEndpoint.invoices, RazorpayInvoiceCollectionSchema, 'invoice list', {
      query,
    });
    return collection.items;
  }

  /**
   * `chargeId` is the id `listCharges` returns: a payment id, or an invoice id
   * for an invoice with no payment yet. The subscription id is not sent: a
   * payment is fetched by its own id and Razorpay does not return the
   * subscription on a payment, so `Charge.subscriptionId` is left unset for
   * payments rather than asserting a link nobody verified.
   */
  override async getCharge(subscriptionId: string, chargeId: string): Promise<Charge> {
    const id = requireId(chargeId, 'chargeId');
    if (id.startsWith(RazorpayIdPrefix.Invoice)) {
      const invoice = await this.call(HttpMethod.Get, RazorpayEndpoint.invoice(id), RazorpayInvoiceEntitySchema, 'invoice');
      return mapInvoiceToCharge(invoice, { subscriptionId: subscriptionId || undefined });
    }
    const payment = await this.call(HttpMethod.Get, RazorpayEndpoint.payment(id), RazorpayPaymentEntitySchema, 'payment');
    return mapPaymentToCharge(payment);
  }

  /**
   * Refunds a payment (`POST /v1/payments/{id}/refund`, from the SDK; the
   * refund API pages are not part of the subscription docs). `refundId` is
   * sent as the refund `receipt` and in `notes`, but Razorpay does not
   * enforce its uniqueness: never retry this call after OUTCOME_UNKNOWN
   * without checking the payment's refunds first.
   */
  override async refundCharge(rawInput: RefundInput): Promise<Refund> {
    const input = parseInput(RefundInputSchema, rawInput, 'refund input', this.name);
    const request = parseInput(
      RazorpayRefundRequestSchema,
      {
        amount: input.amount,
        receipt: input.refundId,
        notes: buildNotes(undefined, {
          [RazorpayNoteKey.RefundReference]: input.refundId,
          [RazorpayNoteKey.RefundReason]: input.reason,
        }),
      },
      'Razorpay refund request',
      this.name,
    );
    const entity = await this.call(HttpMethod.Post, RazorpayEndpoint.refundPayment(input.chargeId), RazorpayRefundEntitySchema, 'refund', {
      body: request,
    });
    return mapRefund(entity, { chargeId: input.chargeId, amount: input.amount, reference: input.refundId });
  }

  // -------------------------------------------------------------------------
  // Checkout verification and webhooks
  // -------------------------------------------------------------------------

  /**
   * Verifies the checkout handler response:
   * `hex(HMAC_SHA256(key_secret, razorpay_payment_id + "|" + subscription_id))`
   * compared with `razorpay_signature`. The docs say to sign with the
   * subscription id from your own storage, not the one Checkout returns; pass
   * it as `expected_subscription_id` in the result object and it is used
   * instead. Without it, compare the returned `subscriptionId` with your own
   * record yourself.
   */
  async verifyCheckout(result: CheckoutResult): Promise<CheckoutVerification> {
    const fields = parseInput(RazorpayCheckoutResponseSchema, result, 'checkout result', this.name);
    const expectedId = result[RAZORPAY_EXPECTED_SUBSCRIPTION_ID_KEY];
    if (expectedId !== undefined && (typeof expectedId !== 'string' || expectedId === '')) {
      throw invalid(`${RAZORPAY_EXPECTED_SUBSCRIPTION_ID_KEY} must be a non-empty string`, this.name);
    }
    const subscriptionId = expectedId ?? fields.razorpay_subscription_id;
    const expected = sha256Hmac(this.#config.keySecret, `${fields.razorpay_payment_id}|${subscriptionId}`);
    assertSignature(expected, fields.razorpay_signature, this.name, 'checkout');
    return {
      provider: this.name,
      subscriptionId,
      authorized: true,
      raw: result,
    };
  }

  /**
   * Verifies `x-razorpay-signature` (`hex(HMAC_SHA256(webhookSecret, rawBody))`)
   * over the raw body, then normalises the event. Throws CONFIG when no
   * `webhookSecret` was configured.
   */
  parseWebhook(request: WebhookRequest): SubscriptionEvent[] {
    const secret = this.#config.webhookSecret;
    if (!secret) {
      throw new SubscriptionError(
        ErrorCode.Config,
        `${this.name} webhookSecret is not configured; it is required to verify webhooks`,
        { provider: this.name },
      );
    }
    const { rawBody, headers } = parseInput(WebhookRequestSchema, request, 'webhook request', this.name);
    assertSignature(sha256Hmac(secret, rawBody), getHeader(headers, RazorpayHeader.Signature), this.name, 'webhook');

    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch (cause) {
      throw new SubscriptionError(ErrorCode.UnexpectedResponse, `${this.name} webhook body is not JSON`, {
        provider: this.name,
        cause,
      });
    }
    const body = parseResponse(RazorpayWebhookBodySchema, json, 'webhook body', this.name);
    return [mapWebhookEvent(body, getHeader(headers, RazorpayHeader.EventId))];
  }
}

/** Factory: validates the config and returns a ready provider. */
export function razorpay(config: RazorpayConfig, options?: ProviderOptions): RazorpayProvider {
  return new RazorpayProvider(config, options);
}
