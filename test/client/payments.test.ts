import { describe, expect, it } from 'vitest';
import { Subscriptions } from '../../src/client.js';
import {
  ErrorCode,
  EventType,
  PaymentMethod,
  PaymentStatus,
  Provider,
  ProviderKind,
  SchedulingMode,
} from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import type { HttpResponse } from '../../src/http.js';
import { BaseProvider, type GatewayErrorInfo } from '../../src/provider.js';
import type {
  Capabilities,
  CheckoutResult,
  CreatePaymentInput,
  Payment,
  PaymentVerification,
  RefundPaymentInput,
  SubscriptionEvent,
  WebhookRequest,
} from '../../src/schemas.js';

const CAPABILITIES: Capabilities = {
  provider: Provider.Razorpay,
  kind: ProviderKind.Gateway,
  scheduling: [SchedulingMode.Gateway],
  gatewayPlans: true,
  trial: true,
  upfrontAmount: true,
  quantity: true,
  pause: false,
  resume: false,
  cancel: true,
  cancelAtPeriodEnd: false,
  changePlan: false,
  merchantCharges: false,
  merchantPreDebitNotification: false,
  listCharges: false,
  refunds: true,
  signedWebhooks: true,
  idempotencyKeys: false,
  paymentMethods: [PaymentMethod.Upi],
  oneTimePayments: true,
  oneTimePaymentMethods: [PaymentMethod.Upi, PaymentMethod.NetBanking],
};

const PAYMENT_ID = 'pay_real_1';
const ORDER_TOKEN = 'order_token_1';

const PAYMENT: Payment = {
  provider: Provider.Razorpay,
  id: PAYMENT_ID,
  status: PaymentStatus.Succeeded,
  providerStatus: 'captured',
  amount: 49900,
  raw: {},
};

const EVENT: SubscriptionEvent = {
  id: 'evt_pay_1',
  provider: Provider.Razorpay,
  type: EventType.PaymentSucceeded,
  providerEventType: 'payment.captured',
  paymentId: PAYMENT_ID,
  payment: PAYMENT,
  raw: {},
};

/** An adapter with one-time payments and a webhook parser that answers asynchronously (it "fetches a key"). */
class PaymentsProvider extends BaseProvider {
  readonly name = Provider.Razorpay;
  readonly capabilities = CAPABILITIES;
  readonly calls: string[] = [];
  verification: PaymentVerification = {
    provider: Provider.Razorpay,
    paymentId: PAYMENT_ID,
    reference: ORDER_TOKEN,
    paid: true,
    status: PaymentStatus.Succeeded,
    raw: {},
  };
  fetched: Payment | undefined = PAYMENT;

  protected describeError(_response: HttpResponse): GatewayErrorInfo {
    return { message: 'unused' };
  }
  override createPayment(input: CreatePaymentInput): Promise<Payment> {
    this.calls.push(`createPayment:${input.amount}`);
    return Promise.resolve({ ...PAYMENT, status: PaymentStatus.Created });
  }
  override getPayment(paymentId: string): Promise<Payment> {
    this.calls.push(`getPayment:${paymentId}`);
    return this.fetched ? Promise.resolve(this.fetched) : Promise.reject(new SubscriptionError(ErrorCode.NotFound, 'gone'));
  }
  override verifyPayment(_result: CheckoutResult): Promise<PaymentVerification> {
    this.calls.push('verifyPayment');
    return Promise.resolve(this.verification);
  }
  override refundPayment(input: RefundPaymentInput) {
    this.calls.push(`refundPayment:${input.paymentId}`);
    return Promise.resolve({
      provider: Provider.Razorpay,
      id: 'rf_1',
      chargeId: input.paymentId,
      paymentId: input.paymentId,
      status: 'succeeded' as const,
      amount: input.amount ?? 49900,
    });
  }
  createSubscription(): Promise<never> {
    return Promise.reject(new Error('unused'));
  }
  getSubscription(): Promise<never> {
    return Promise.reject(new Error('unused'));
  }
  cancelSubscription(): Promise<never> {
    return Promise.reject(new Error('unused'));
  }
  verifyCheckout(): Promise<never> {
    return Promise.reject(new Error('unused'));
  }
  parseWebhook(request: WebhookRequest): SubscriptionEvent[] | Promise<SubscriptionEvent[]> {
    if (request.headers['x-signature'] !== 'ok') {
      return Promise.reject(new SubscriptionError(ErrorCode.SignatureInvalid, 'bad signature', { provider: this.name }));
    }
    return Promise.resolve([EVENT]);
  }
}

function build() {
  const provider = new PaymentsProvider();
  return { provider, subs: new Subscriptions({ providers: [provider] }) };
}

describe('subs.payments', () => {
  const rzp = Provider.Razorpay;

  it('create, get and refund delegate to the adapter', async () => {
    const { provider, subs } = build();
    const created = await subs.payments.create(rzp, { amount: 49900, customer: { email: 'asha@example.com' } });
    expect(created.status).toBe(PaymentStatus.Created);
    expect(await subs.payments.get(rzp, PAYMENT_ID)).toBe(PAYMENT);
    const refund = await subs.payments.refund(rzp, { paymentId: PAYMENT_ID, refundId: 'r1' });
    expect(refund).toMatchObject({ chargeId: PAYMENT_ID, paymentId: PAYMENT_ID });
    expect(provider.calls).toEqual(['createPayment:49900', `getPayment:${PAYMENT_ID}`, `refundPayment:${PAYMENT_ID}`]);
  });

  it('rejects for an unknown provider instead of throwing synchronously', async () => {
    const { subs } = build();
    await expect(subs.payments.get(Provider.Cashfree, PAYMENT_ID)).rejects.toMatchObject({ code: ErrorCode.Config });
  });

  describe('verify', () => {
    it('returns the verification when no expected id is given', async () => {
      const { subs } = build();
      expect((await subs.payments.verify(rzp, {})).paymentId).toBe(PAYMENT_ID);
    });

    it('accepts an expected id equal to the verified paymentId', async () => {
      const { subs } = build();
      expect((await subs.payments.verify(rzp, {}, { expectedPaymentId: PAYMENT_ID })).paid).toBe(true);
    });

    it('accepts an expected id equal to the verified reference', async () => {
      const { subs } = build();
      expect((await subs.payments.verify(rzp, {}, { expectedPaymentId: ORDER_TOKEN })).paid).toBe(true);
    });

    it('rejects with SIGNATURE_INVALID when the expected id matches neither paymentId nor reference', async () => {
      const { subs } = build();
      const error = await subs.payments.verify(rzp, {}, { expectedPaymentId: 'someone_elses_order' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SubscriptionError);
      expect((error as SubscriptionError).code).toBe(ErrorCode.SignatureInvalid);
      expect((error as SubscriptionError).provider).toBe(rzp);
    });

    it('with no reference on the result, compares the reference of the fetched payment', async () => {
      const { provider, subs } = build();
      provider.verification = { ...provider.verification, reference: undefined };
      provider.fetched = { ...PAYMENT, reference: 'my_order_9' };
      expect((await subs.payments.verify(rzp, {}, { expectedPaymentId: 'my_order_9' })).paymentId).toBe(PAYMENT_ID);
      await expect(subs.payments.verify(rzp, {}, { expectedPaymentId: 'other' })).rejects.toMatchObject({
        code: ErrorCode.SignatureInvalid,
      });
    });

    it('with no reference and a failed lookup, refuses rather than guessing', async () => {
      const { provider, subs } = build();
      provider.verification = { ...provider.verification, reference: undefined };
      provider.fetched = undefined;
      await expect(subs.payments.verify(rzp, {}, { expectedPaymentId: 'my_order_9' })).rejects.toMatchObject({
        code: ErrorCode.SignatureInvalid,
      });
    });
  });
});

describe('subs.webhooks with an asynchronous adapter', () => {
  const rzp = Provider.Razorpay;
  const good: WebhookRequest = { rawBody: '{}', headers: { 'x-signature': 'ok' } };

  it('parse returns a promise of the events', async () => {
    const { subs } = build();
    const pending = subs.webhooks.parse(rzp, good);
    expect(pending).toBeInstanceOf(Promise);
    expect(await pending).toEqual([EVENT]);
  });

  it('parse rejects (never throws synchronously) when verification fails', async () => {
    const { subs } = build();
    let pending: Promise<unknown> | undefined;
    expect(() => {
      pending = subs.webhooks.parse(rzp, { ...good, headers: {} });
    }).not.toThrow();
    await expect(pending).rejects.toMatchObject({ code: ErrorCode.SignatureInvalid });
  });

  it('parse rejects with CONFIG for a provider that is not configured', async () => {
    const { subs } = build();
    await expect(subs.webhooks.parse(Provider.Paytm, good)).rejects.toMatchObject({ code: ErrorCode.Config });
  });

  it('handle awaits the adapter and returns its events', async () => {
    const { subs } = build();
    expect(await subs.webhooks.handle(rzp, good)).toEqual([EVENT]);
  });

  it('parse also works with an adapter that answers synchronously', async () => {
    const provider = new PaymentsProvider();
    provider.parseWebhook = () => [EVENT];
    const subs = new Subscriptions({ providers: [provider] });
    expect(await subs.webhooks.parse(rzp, good)).toEqual([EVENT]);
  });
});
