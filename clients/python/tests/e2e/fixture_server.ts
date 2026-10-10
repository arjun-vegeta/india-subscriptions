/**
 * Test fixture for the Python client's end-to-end tests. Not part of the library.
 *
 * Builds a real `Subscriptions` facade around in-memory fake gateways (extending `BaseProvider`),
 * serves it with the real HTTP service (`createNodeServer`) on an ephemeral port, and prints that
 * port as the first line of stdout. It exits when stdin closes, so a crashed test run leaves nothing
 * behind.
 *
 *   cd <repo root> && E2E_API_KEY=... E2E_WEBHOOK_SECRET=... npx tsx clients/python/tests/e2e/fixture_server.ts
 */
import { createSubscriptions } from '../../../../src/client.js';
import {
  CancelMode,
  ChargeKind,
  ChargeStatus,
  CheckoutKind,
  Currency,
  Environment,
  ErrorCode,
  EventType,
  Provider,
  ProviderKind,
  RefundStatus,
  SchedulingMode,
  SubscriptionStatus,
} from '../../../../src/constants.js';
import { getHeader, sha256Hmac, safeEqual } from '../../../../src/crypto.js';
import { SubscriptionError } from '../../../../src/errors.js';
import type { HttpResponse } from '../../../../src/http.js';
import { BaseProvider, type GatewayErrorInfo } from '../../../../src/provider.js';
import {
  CapabilitiesSchema,
  ChargeNotificationSchema,
  ChargeSchema,
  CheckoutVerificationSchema,
  PlanSchema,
  RefundSchema,
  SubscriptionEventSchema,
  SubscriptionSchema,
  type CancelSubscriptionOptions,
  type Capabilities,
  type Charge,
  type ChargeNotification,
  type CheckoutResult,
  type CheckoutVerification,
  type CreateChargeInput,
  type CreatePlanInput,
  type CreateSubscriptionInput,
  type ListChargesOptions,
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
} from '../../../../src/schemas.js';
import { createNodeServer, listen } from '../../../../src/server/index.js';

const API_KEY = requiredEnv('E2E_API_KEY');
const WEBHOOK_SECRET = requiredEnv('E2E_WEBHOOK_SECRET');
const SIGNATURE_HEADER = 'x-fake-signature';
const CHECKOUT_SIGNATURE_FIELD = 'signature';
const CHECKOUT_SUBSCRIPTION_FIELD = 'subscription_id';
/** A charge id that makes the fake gateway "lose" its answer: the outcome is unknown. */
const UNKNOWN_OUTCOME_CHARGE_ID = 'charge_outcome_unknown';
const MS_PER_DAY = 86_400_000;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const CAPABILITIES: Omit<Capabilities, 'provider'> = {
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
  merchantCharges: true,
  merchantPreDebitNotification: true,
  merchantChargeLeadHours: 24,
  listCharges: true,
  refunds: true,
  signedWebhooks: true,
  idempotencyKeys: true,
  paymentMethods: [],
  oneTimePayments: false,
  oneTimePaymentMethods: [],
};

function notFound(provider: Provider, what: string, id: string): SubscriptionError {
  return new SubscriptionError(ErrorCode.NotFound, `${what} ${id} does not exist`, { provider });
}

function conflict(provider: Provider, message: string): SubscriptionError {
  return new SubscriptionError(ErrorCode.Conflict, message, { provider, httpStatus: 409, providerCode: 'BAD_REQUEST_ERROR' });
}

/** Every value the fake returns passes the library's own output schema before it leaves the fixture. */
function checked<T>(schema: { parse: (value: unknown) => T }, value: unknown): T {
  return schema.parse(value);
}

class FakeProvider extends BaseProvider {
  readonly capabilities: Capabilities;
  private readonly plans = new Map<string, Plan>();
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly statusBeforePause = new Map<string, Subscription['status']>();
  private readonly charges = new Map<string, Charge[]>();
  private counter = 0;

  constructor(readonly name: Provider) {
    super();
    this.capabilities = checked(CapabilitiesSchema, { ...CAPABILITIES, provider: name });
  }

  protected describeError(_response: HttpResponse): GatewayErrorInfo {
    return { message: 'the fake gateway never makes HTTP calls' };
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.name}_${this.counter}`;
  }

  override async createPlan(input: CreatePlanInput): Promise<Plan> {
    const id = input.id ?? this.nextId('plan');
    if (this.plans.has(id)) throw conflict(this.name, `Plan ${id} already exists`);
    const plan = checked(PlanSchema, {
      provider: this.name,
      id,
      name: input.name,
      description: input.description,
      amount: input.amount,
      currency: input.currency ?? Currency.INR,
      interval: input.interval,
      scheduling: input.scheduling ?? SchedulingMode.Gateway,
      maxAmount: input.maxAmount ?? input.amount,
      maxCycles: input.maxCycles,
      createdAt: new Date().toISOString(),
      metadata: input.metadata,
      raw: { fake: true, id },
    });
    this.plans.set(id, plan);
    return plan;
  }

  override async getPlan(planId: string): Promise<Plan> {
    const plan = this.plans.get(planId);
    if (!plan) throw notFound(this.name, 'Plan', planId);
    return plan;
  }

  async createSubscription(input: CreateSubscriptionInput): Promise<Subscription> {
    const plan = typeof input.plan === 'string' ? await this.getPlan(input.plan) : await this.createPlan(input.plan);
    const id = this.nextId('sub');
    const now = new Date();
    const trialEndsAt =
      input.trial?.days !== undefined
        ? new Date(now.getTime() + input.trial.days * MS_PER_DAY).toISOString()
        : input.trial?.endsAt;
    const checkout =
      this.name === Provider.Cashfree
        ? { kind: CheckoutKind.CashfreeCheckout, sessionId: `session_${id}`, environment: Environment.Test }
        : {
            kind: CheckoutKind.RazorpayCheckout,
            keyId: 'rzp_test_fake',
            subscriptionId: id,
            hostedUrl: `https://pay.example.test/${id}`,
            prefill: input.customer,
          };
    const subscription = checked(SubscriptionSchema, {
      provider: this.name,
      id,
      reference: input.reference,
      planId: plan.id,
      status: trialEndsAt ? SubscriptionStatus.Trialing : SubscriptionStatus.Created,
      providerStatus: trialEndsAt ? 'authenticated' : 'created',
      scheduling: plan.scheduling,
      customer: input.customer,
      quantity: input.quantity ?? 1,
      amount: plan.amount,
      maxAmount: plan.maxAmount,
      currency: plan.currency,
      interval: plan.interval,
      totalCycles: input.totalCycles,
      paidCycles: 0,
      createdAt: now.toISOString(),
      startAt: trialEndsAt ?? input.startAt,
      trialEndsAt,
      nextChargeAt: trialEndsAt ?? input.startAt,
      cancelAtPeriodEnd: false,
      checkout,
      metadata: input.metadata,
      raw: { fake: true, id },
    });
    this.subscriptions.set(id, subscription);
    this.charges.set(id, []);
    return subscription;
  }

  async getSubscription(subscriptionId: string): Promise<Subscription> {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) throw notFound(this.name, 'Subscription', subscriptionId);
    return subscription;
  }

  private store(subscription: Subscription): Subscription {
    const stored = checked(SubscriptionSchema, subscription);
    this.subscriptions.set(stored.id, stored);
    return stored;
  }

  async cancelSubscription(subscriptionId: string, options?: CancelSubscriptionOptions): Promise<Subscription> {
    const current = await this.getSubscription(subscriptionId);
    if (current.status === SubscriptionStatus.Cancelled) {
      throw conflict(this.name, `Subscription ${subscriptionId} is already cancelled`);
    }
    if (options?.mode === CancelMode.AtPeriodEnd) return this.store({ ...current, cancelAtPeriodEnd: true });
    return this.store({
      ...current,
      status: SubscriptionStatus.Cancelled,
      providerStatus: 'cancelled',
      endedAt: new Date().toISOString(),
      nextChargeAt: undefined,
      cancelAtPeriodEnd: false,
    });
  }

  override async pauseSubscription(subscriptionId: string, options?: PauseSubscriptionOptions): Promise<Subscription> {
    void options;
    const current = await this.getSubscription(subscriptionId);
    if (current.status !== SubscriptionStatus.Active && current.status !== SubscriptionStatus.Trialing) {
      throw conflict(this.name, `Subscription ${subscriptionId} is ${current.status} and cannot be paused`);
    }
    this.statusBeforePause.set(subscriptionId, current.status);
    return this.store({ ...current, status: SubscriptionStatus.Paused, providerStatus: 'paused' });
  }

  override async resumeSubscription(subscriptionId: string, options?: ResumeSubscriptionOptions): Promise<Subscription> {
    const current = await this.getSubscription(subscriptionId);
    if (current.status !== SubscriptionStatus.Paused) {
      throw conflict(this.name, `Subscription ${subscriptionId} is ${current.status} and cannot be resumed`);
    }
    const status = this.statusBeforePause.get(subscriptionId) ?? SubscriptionStatus.Active;
    return this.store({
      ...current,
      status,
      providerStatus: status,
      nextChargeAt: options?.nextChargeAt ?? current.nextChargeAt,
    });
  }

  override async updateSubscription(subscriptionId: string, input: UpdateSubscriptionInput): Promise<Subscription> {
    const current = await this.getSubscription(subscriptionId);
    if (input.planId !== undefined) await this.getPlan(input.planId);
    return this.store({
      ...current,
      planId: input.planId ?? current.planId,
      quantity: input.quantity ?? current.quantity,
      amount: input.amount ?? current.amount,
      remainingCycles: input.remainingCycles ?? current.remainingCycles,
      nextChargeAt: input.nextChargeAt ?? current.nextChargeAt,
      mandateEndsAt: input.mandateEndsAt ?? current.mandateEndsAt,
    });
  }

  override async listCharges(subscriptionId: string, options?: ListChargesOptions): Promise<Charge[]> {
    await this.getSubscription(subscriptionId);
    const all = [...(this.charges.get(subscriptionId) ?? [])].reverse();
    return options?.limit === undefined ? all : all.slice(0, options.limit);
  }

  override async getCharge(subscriptionId: string, chargeId: string): Promise<Charge> {
    await this.getSubscription(subscriptionId);
    const charge = (this.charges.get(subscriptionId) ?? []).find((candidate) => candidate.id === chargeId);
    if (!charge) throw notFound(this.name, 'Charge', chargeId);
    return charge;
  }

  override async createCharge(input: CreateChargeInput): Promise<Charge> {
    await this.getSubscription(input.subscriptionId);
    if (input.chargeId === UNKNOWN_OUTCOME_CHARGE_ID) {
      throw new SubscriptionError(
        ErrorCode.OutcomeUnknown,
        'POST /payments was sent but no response was received. It may or may not have taken effect: fetch the current state before retrying.',
        { provider: this.name },
      );
    }
    const existing = (this.charges.get(input.subscriptionId) ?? []).find((charge) => charge.reference === input.chargeId);
    if (existing) return existing; // the same debit id never debits twice
    const charge = checked(ChargeSchema, {
      provider: this.name,
      id: this.nextId('pay'),
      reference: input.chargeId,
      subscriptionId: input.subscriptionId,
      kind: ChargeKind.Recurring,
      status: ChargeStatus.Succeeded,
      amount: input.amount,
      currency: Currency.INR,
      scheduledAt: input.scheduledAt,
      paidAt: new Date().toISOString(),
      raw: { fake: true },
    });
    this.charges.get(input.subscriptionId)?.push(charge);
    return charge;
  }

  override async notifyCharge(input: NotifyChargeInput): Promise<ChargeNotification> {
    await this.getSubscription(input.subscriptionId);
    return checked(ChargeNotificationSchema, {
      provider: this.name,
      id: input.notificationId,
      subscriptionId: input.subscriptionId,
      accepted: true,
      providerStatus: 'SENT',
      amount: input.amount,
      debitAt: input.debitAt,
      invoiceNumber: input.invoiceNumber,
      raw: { fake: true },
    });
  }

  override async refundCharge(input: RefundInput): Promise<Refund> {
    const subscriptionId = input.subscriptionId;
    if (subscriptionId === undefined) {
      throw new SubscriptionError(ErrorCode.Validation, 'The fake gateway needs subscriptionId to find a charge', {
        provider: this.name,
      });
    }
    const charge = await this.getCharge(subscriptionId, input.chargeId);
    const amount = input.amount ?? charge.amount;
    if (amount > charge.amount - (charge.refundedAmount ?? 0)) {
      throw new SubscriptionError(ErrorCode.Validation, 'The refund is more than what is left of the charge', {
        provider: this.name,
        httpStatus: 400,
        providerCode: 'BAD_REQUEST_ERROR',
      });
    }
    const refundedAmount = (charge.refundedAmount ?? 0) + amount;
    const list = this.charges.get(subscriptionId) ?? [];
    const index = list.findIndex((candidate) => candidate.id === charge.id);
    list[index] = checked(ChargeSchema, {
      ...charge,
      refundedAmount,
      status: refundedAmount === charge.amount ? ChargeStatus.Refunded : ChargeStatus.PartiallyRefunded,
    });
    return checked(RefundSchema, {
      provider: this.name,
      id: input.refundId,
      reference: input.refundId,
      chargeId: charge.id,
      subscriptionId,
      status: RefundStatus.Succeeded,
      amount,
      currency: Currency.INR,
      createdAt: new Date().toISOString(),
      raw: { fake: true },
    });
  }

  async verifyCheckout(result: CheckoutResult): Promise<CheckoutVerification> {
    const subscriptionId = String(result[CHECKOUT_SUBSCRIPTION_FIELD] ?? '');
    const expected = sha256Hmac(WEBHOOK_SECRET, subscriptionId);
    const received = result[CHECKOUT_SIGNATURE_FIELD];
    if (typeof received !== 'string' || !safeEqual(expected, received)) {
      throw new SubscriptionError(ErrorCode.SignatureInvalid, `${this.name} checkout signature does not match`, {
        provider: this.name,
      });
    }
    const current = await this.getSubscription(subscriptionId);
    this.store({ ...current, status: SubscriptionStatus.Active, providerStatus: 'active' });
    return checked(CheckoutVerificationSchema, {
      provider: this.name,
      subscriptionId,
      authorized: true,
      status: SubscriptionStatus.Active,
      raw: result,
    });
  }

  parseWebhook(request: WebhookRequest): SubscriptionEvent[] {
    const received = getHeader(request.headers, SIGNATURE_HEADER);
    const expected = sha256Hmac(WEBHOOK_SECRET, request.rawBody);
    if (!received || !safeEqual(expected, received)) {
      throw new SubscriptionError(ErrorCode.SignatureInvalid, `${this.name} webhook signature does not match`, {
        provider: this.name,
      });
    }
    let body: { id?: unknown; event?: unknown; subscription_id?: unknown; note?: unknown };
    try {
      body = JSON.parse(request.rawBody) as typeof body;
    } catch {
      throw new SubscriptionError(ErrorCode.Validation, 'The webhook body is not JSON', { provider: this.name });
    }
    const known = Object.values(EventType) as string[];
    const eventName = String(body.event);
    return [
      checked(SubscriptionEventSchema, {
        id: String(body.id),
        provider: this.name,
        type: known.includes(eventName) ? eventName : EventType.Unknown,
        providerEventType: eventName,
        subscriptionId: typeof body.subscription_id === 'string' ? body.subscription_id : undefined,
        raw: body,
      }),
    ];
  }
}

const client = createSubscriptions({
  providers: [new FakeProvider(Provider.Razorpay), new FakeProvider(Provider.Cashfree)],
});

const server = createNodeServer({
  client,
  apiKey: API_KEY,
  onEvents: (provider, events) => {
    process.stderr.write(`webhook ${provider}: ${events.map((event) => event.id).join(',')}\n`);
  },
});
const running = await listen(server, { port: 0 });
process.stdout.write(`${running.port}\n`);

async function shutdown(): Promise<void> {
  await running.close().catch(() => undefined);
  process.exit(0);
}
process.stdin.resume();
process.stdin.on('end', () => void shutdown());
process.stdin.on('close', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
