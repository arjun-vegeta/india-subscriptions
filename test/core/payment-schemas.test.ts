import { describe, expect, it } from 'vitest';
import {
  ChannelPolicy,
  CheckoutKind,
  Environment,
  ErrorCode,
  EventType,
  PaymentMethod,
  PaymentStatus,
  Platform,
  ProductKind,
  Provider,
  ProviderKind,
  SalesChannel,
} from '../../src/constants.js';
import { SchemaName, namedSchema } from '../../src/schema-registry.js';
import {
  AppleStoreKitCheckoutSchema,
  CapabilitiesSchema,
  CashfreeCheckoutSchema,
  ChannelPolicySchema,
  CheckoutInstructionSchema,
  CreatePaymentInputSchema,
  CreateSubscriptionInputSchema,
  CustomerSchema,
  ExternalTransactionRecordSchema,
  ExternalTransactionRefundSchema,
  ExternalTransactionReportSchema,
  GooglePlayBillingCheckoutSchema,
  PaymentMethodSchema,
  PaymentSchema,
  PaymentStatusSchema,
  PaymentVerificationSchema,
  PlatformSchema,
  ProductKindSchema,
  ProviderKindSchema,
  ProviderSchema,
  RazorpayCheckoutSchema,
  RefundPaymentInputSchema,
  RefundSchema,
  SalesChannelSchema,
  StoreProductSchema,
  SubscriptionEventSchema,
  VerifyPaymentInputSchema,
} from '../../src/schemas.js';

const TOKEN = '7e3f4a1c-9d2b-4c6e-8f10-3a5b7c9d1e2f';
const NONCE = '0b8f2d6a-4e1c-4a7d-9c35-6f2e8a1b3d47';
const T = '2026-11-22T10:30:00+05:30';

describe('new constants', () => {
  it('have the documented values', () => {
    expect(Provider.AppStore).toBe('app_store');
    expect(Provider.GooglePlay).toBe('google_play');
    expect(Object.values(ProviderKind)).toEqual(['gateway', 'store']);
    expect(Object.values(Platform)).toEqual(['ios', 'android', 'web']);
    expect(Object.values(ChannelPolicy)).toEqual(['store', 'user_choice', 'gateways']);
    expect(Object.values(SalesChannel)).toEqual(['store', 'gateway']);
    expect(Object.values(ProductKind)).toEqual(['subscription', 'one_time']);
    expect(Object.values(PaymentStatus)).toEqual([
      'created',
      'pending',
      'succeeded',
      'failed',
      'cancelled',
      'refunded',
      'partially_refunded',
    ]);
    expect(PaymentMethod.NetBanking).toBe('netbanking');
    expect(PaymentMethod.Wallet).toBe('wallet');
    expect(CheckoutKind.AppleStoreKit).toBe('apple_storekit');
    expect(CheckoutKind.GooglePlayBilling).toBe('google_play_billing');
    expect(EventType.PaymentSucceeded).toBe('payment.succeeded');
    expect(EventType.PaymentFailed).toBe('payment.failed');
    expect(ErrorCode.NoRoute).toBe('NO_ROUTE');
  });
});

describe('enum schemas', () => {
  it.each([
    [ProviderKindSchema, ProviderKind],
    [PlatformSchema, Platform],
    [ChannelPolicySchema, ChannelPolicy],
    [SalesChannelSchema, SalesChannel],
    [ProductKindSchema, ProductKind],
    [PaymentStatusSchema, PaymentStatus],
    [ProviderSchema, Provider],
    [PaymentMethodSchema, PaymentMethod],
  ])('accept exactly the constant values', (schema, constant) => {
    for (const value of Object.values(constant)) expect(schema.safeParse(value).success).toBe(true);
    expect(schema.safeParse('carrier_pigeon').success).toBe(false);
  });
});

describe('schema registry', () => {
  it('publishes every new schema under its name', () => {
    const published = {
      [SchemaName.ProviderKind]: ProviderKindSchema,
      [SchemaName.Platform]: PlatformSchema,
      [SchemaName.ChannelPolicy]: ChannelPolicySchema,
      [SchemaName.SalesChannel]: SalesChannelSchema,
      [SchemaName.ProductKind]: ProductKindSchema,
      [SchemaName.PaymentStatus]: PaymentStatusSchema,
      [SchemaName.StoreProduct]: StoreProductSchema,
      [SchemaName.AppleStoreKitCheckout]: AppleStoreKitCheckoutSchema,
      [SchemaName.GooglePlayBillingCheckout]: GooglePlayBillingCheckoutSchema,
      [SchemaName.CreatePaymentInput]: CreatePaymentInputSchema,
      [SchemaName.Payment]: PaymentSchema,
      [SchemaName.VerifyPaymentInput]: VerifyPaymentInputSchema,
      [SchemaName.PaymentVerification]: PaymentVerificationSchema,
      [SchemaName.RefundPaymentInput]: RefundPaymentInputSchema,
      [SchemaName.ExternalTransactionReport]: ExternalTransactionReportSchema,
      [SchemaName.ExternalTransactionRefund]: ExternalTransactionRefundSchema,
      [SchemaName.ExternalTransactionRecord]: ExternalTransactionRecordSchema,
    };
    for (const [name, schema] of Object.entries(published)) expect(namedSchema(name as SchemaName), name).toBe(schema);
  });
});

describe('CustomerSchema.state', () => {
  it('is optional, 2 to 60 characters', () => {
    expect(CustomerSchema.safeParse({}).success).toBe(true);
    expect(CustomerSchema.safeParse({ state: 'Karnataka' }).success).toBe(true);
    expect(CustomerSchema.safeParse({ state: 'K' }).success).toBe(false);
    expect(CustomerSchema.safeParse({ state: 'x'.repeat(61) }).success).toBe(false);
  });
});

describe('StoreProductSchema', () => {
  it('needs a productId and nothing else', () => {
    expect(StoreProductSchema.safeParse({ productId: 'pro_monthly' }).success).toBe(true);
    expect(
      StoreProductSchema.safeParse({ productId: 'coins_100', basePlanId: 'b', offerId: 'o', consumable: true }).success,
    ).toBe(true);
    expect(StoreProductSchema.safeParse({}).success).toBe(false);
    expect(StoreProductSchema.safeParse({ productId: '' }).success).toBe(false);
    expect(StoreProductSchema.safeParse({ productId: 'p', basePlanId: '' }).success).toBe(false);
  });

  it('is accepted by both create inputs', () => {
    const customer = { email: 'asha@example.com' };
    const storeProduct = { productId: 'pro_monthly' };
    expect(
      CreateSubscriptionInputSchema.safeParse({ plan: 'plan_1', customer, storeProduct }).success,
    ).toBe(true);
    expect(CreatePaymentInputSchema.safeParse({ amount: 100, customer, storeProduct }).success).toBe(true);
  });
});

describe('store checkout instructions', () => {
  const apple = { kind: CheckoutKind.AppleStoreKit, productId: 'pro_monthly', appAccountToken: TOKEN };
  const google = {
    kind: CheckoutKind.GooglePlayBilling,
    productKind: ProductKind.Subscription,
    productId: 'pro_monthly',
    obfuscatedAccountId: 'acct_1',
    userChoiceBilling: true,
  };

  it('accept the documented shapes through the CheckoutInstruction union', () => {
    expect(CheckoutInstructionSchema.safeParse(apple).success).toBe(true);
    expect(CheckoutInstructionSchema.safeParse(google).success).toBe(true);
    expect(CheckoutInstructionSchema.safeParse({ ...google, basePlanId: 'monthly', offerId: 'intro' }).success).toBe(true);
  });

  it('StoreKit: the account token and the offer nonce are UUIDs', () => {
    expect(AppleStoreKitCheckoutSchema.safeParse({ ...apple, appAccountToken: 'not-a-uuid' }).success).toBe(false);
    const offer = { offerId: 'intro', keyId: 'K1', nonce: NONCE, timestamp: 1_800_000_000_000, signature: 'c2ln' };
    expect(AppleStoreKitCheckoutSchema.safeParse({ ...apple, promotionalOffer: offer }).success).toBe(true);
    expect(AppleStoreKitCheckoutSchema.safeParse({ ...apple, promotionalOffer: { ...offer, nonce: 'n' } }).success).toBe(false);
    expect(AppleStoreKitCheckoutSchema.safeParse({ ...apple, promotionalOffer: { ...offer, timestamp: 1.5 } }).success).toBe(false);
  });

  it('Google Play: obfuscatedAccountId is 1 to 64 characters and userChoiceBilling is required', () => {
    expect(GooglePlayBillingCheckoutSchema.safeParse({ ...google, obfuscatedAccountId: '' }).success).toBe(false);
    expect(GooglePlayBillingCheckoutSchema.safeParse({ ...google, obfuscatedAccountId: 'a'.repeat(65) }).success).toBe(false);
    expect(GooglePlayBillingCheckoutSchema.safeParse({ ...google, obfuscatedAccountId: 'a'.repeat(64) }).success).toBe(true);
    const { userChoiceBilling: _omitted, ...without } = google;
    expect(GooglePlayBillingCheckoutSchema.safeParse(without).success).toBe(false);
    expect(GooglePlayBillingCheckoutSchema.safeParse({ ...google, productKind: 'weekly' }).success).toBe(false);
  });
});

describe('RazorpayCheckoutSchema: exactly one of subscriptionId / orderId', () => {
  const base = { kind: CheckoutKind.RazorpayCheckout, keyId: 'rzp_test_1' };

  it('accepts a subscription checkout', () => {
    expect(RazorpayCheckoutSchema.safeParse({ ...base, subscriptionId: 'sub_1' }).success).toBe(true);
  });

  it('accepts a one-time checkout with an order id and an amount', () => {
    expect(RazorpayCheckoutSchema.safeParse({ ...base, orderId: 'order_1', amount: 49900 }).success).toBe(true);
    expect(RazorpayCheckoutSchema.safeParse({ ...base, orderId: 'order_1' }).success).toBe(true);
  });

  it('rejects both and neither', () => {
    expect(RazorpayCheckoutSchema.safeParse({ ...base, subscriptionId: 'sub_1', orderId: 'order_1' }).success).toBe(false);
    expect(RazorpayCheckoutSchema.safeParse(base).success).toBe(false);
  });

  it('still routes through the CheckoutInstruction union, which enforces the same rule', () => {
    expect(CheckoutInstructionSchema.safeParse({ ...base, orderId: 'order_1', amount: 100 }).success).toBe(true);
    expect(CheckoutInstructionSchema.safeParse(base).success).toBe(false);
  });

  it('rejects a fractional amount', () => {
    expect(RazorpayCheckoutSchema.safeParse({ ...base, orderId: 'order_1', amount: 10.5 }).success).toBe(false);
  });
});

describe('CashfreeCheckoutSchema.productKind', () => {
  const base = { kind: CheckoutKind.CashfreeCheckout, sessionId: 's', environment: Environment.Test };

  it('is optional and takes a ProductKind', () => {
    expect(CashfreeCheckoutSchema.safeParse(base).success).toBe(true);
    expect(CashfreeCheckoutSchema.safeParse({ ...base, productKind: ProductKind.OneTime }).success).toBe(true);
    expect(CashfreeCheckoutSchema.safeParse({ ...base, productKind: ProductKind.Subscription }).success).toBe(true);
    expect(CashfreeCheckoutSchema.safeParse({ ...base, productKind: 'weekly' }).success).toBe(false);
  });
});

describe('CreatePaymentInputSchema', () => {
  const valid = { amount: 49900, customer: { name: 'Asha' } };

  it('accepts the minimum and the full shape', () => {
    expect(CreatePaymentInputSchema.safeParse(valid).success).toBe(true);
    expect(
      CreatePaymentInputSchema.safeParse({
        ...valid,
        reference: 'order_9',
        description: 'Annual pass',
        paymentMethods: [PaymentMethod.Upi, PaymentMethod.Wallet],
        returnUrl: 'https://shop.example.com/return',
        expiresAt: T,
        metadata: { cart: '1' },
        idempotencyKey: 'k1',
      }).success,
    ).toBe(true);
  });

  it.each([
    { amount: 0 },
    { amount: 10.5 },
    { amount: -1 },
    { reference: '' },
    { reference: 'x'.repeat(61) },
    { description: '' },
    { description: 'x'.repeat(251) },
    { paymentMethods: [] },
    { paymentMethods: ['bitcoin'] },
    { returnUrl: 'not a url' },
    { expiresAt: '2026-11-22' },
    { idempotencyKey: '' },
  ])('rejects %j', (patch) => {
    expect(CreatePaymentInputSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });

  it('needs a customer and an amount', () => {
    expect(CreatePaymentInputSchema.safeParse({ amount: 100 }).success).toBe(false);
    expect(CreatePaymentInputSchema.safeParse({ customer: {} }).success).toBe(false);
  });
});

describe('PaymentSchema, VerifyPaymentInputSchema, PaymentVerificationSchema, RefundPaymentInputSchema', () => {
  const payment = {
    provider: Provider.Razorpay,
    id: 'pay_1',
    status: PaymentStatus.Succeeded,
    providerStatus: 'captured',
    amount: 49900,
  };

  it('Payment: status and amount are required; checkout is a CheckoutInstruction', () => {
    expect(PaymentSchema.safeParse(payment).success).toBe(true);
    expect(
      PaymentSchema.safeParse({
        ...payment,
        reference: 'order_9',
        currency: 'INR',
        refundedAmount: 0,
        paymentMethod: PaymentMethod.NetBanking,
        customer: { state: 'Kerala' },
        createdAt: T,
        paidAt: T,
        metadata: { a: 'b' },
        checkout: { kind: CheckoutKind.Redirect, url: 'https://pay.example.test/1' },
        raw: { any: 'thing' },
      }).success,
    ).toBe(true);
    expect(PaymentSchema.safeParse({ ...payment, status: 'settled' }).success).toBe(false);
    expect(PaymentSchema.safeParse({ ...payment, amount: 1.5 }).success).toBe(false);
    expect(PaymentSchema.safeParse({ ...payment, checkout: { kind: 'carrier_pigeon' } }).success).toBe(false);
    const { providerStatus: _omitted, ...without } = payment;
    expect(PaymentSchema.safeParse(without).success).toBe(false);
  });

  it('VerifyPaymentInput: result is required, expectedPaymentId is optional and non-empty', () => {
    expect(VerifyPaymentInputSchema.safeParse({ result: { a: 1 } }).success).toBe(true);
    expect(VerifyPaymentInputSchema.safeParse({ result: {}, expectedPaymentId: 'pay_1' }).success).toBe(true);
    expect(VerifyPaymentInputSchema.safeParse({ result: {}, expectedPaymentId: '' }).success).toBe(false);
    expect(VerifyPaymentInputSchema.safeParse({}).success).toBe(false);
  });

  it('PaymentVerification: paid is required; it may carry the payment', () => {
    const verification = { provider: Provider.Razorpay, paymentId: 'pay_1', paid: true };
    expect(PaymentVerificationSchema.safeParse(verification).success).toBe(true);
    expect(PaymentVerificationSchema.safeParse({ ...verification, status: PaymentStatus.Succeeded, payment, reference: 'r' }).success).toBe(true);
    expect(PaymentVerificationSchema.safeParse({ provider: Provider.Razorpay, paymentId: 'pay_1' }).success).toBe(false);
  });

  it('RefundPaymentInput: refundId is 1 to 40 characters, amount is positive', () => {
    expect(RefundPaymentInputSchema.safeParse({ paymentId: 'pay_1', refundId: 'r1' }).success).toBe(true);
    expect(RefundPaymentInputSchema.safeParse({ paymentId: 'pay_1', refundId: 'r1', amount: 500, reason: 'duplicate' }).success).toBe(true);
    expect(RefundPaymentInputSchema.safeParse({ paymentId: '', refundId: 'r1' }).success).toBe(false);
    expect(RefundPaymentInputSchema.safeParse({ paymentId: 'pay_1', refundId: 'x'.repeat(41) }).success).toBe(false);
    expect(RefundPaymentInputSchema.safeParse({ paymentId: 'pay_1', refundId: 'r1', amount: 0 }).success).toBe(false);
  });
});

describe('Refund and SubscriptionEvent carry payments', () => {
  it('Refund has an optional paymentId', () => {
    const refund = { provider: Provider.Razorpay, id: 'rf_1', chargeId: 'pay_1', status: 'succeeded', amount: 100 };
    expect(RefundSchema.safeParse(refund).success).toBe(true);
    expect(RefundSchema.parse({ ...refund, paymentId: 'pay_1' }).paymentId).toBe('pay_1');
  });

  it('SubscriptionEvent has optional paymentId and payment', () => {
    const event = {
      id: 'e1',
      provider: Provider.Razorpay,
      type: EventType.PaymentFailed,
      providerEventType: 'payment.failed',
      paymentId: 'pay_1',
      payment: { provider: Provider.Razorpay, id: 'pay_1', status: PaymentStatus.Failed, providerStatus: 'failed', amount: 100 },
    };
    expect(SubscriptionEventSchema.safeParse(event).success).toBe(true);
    expect(SubscriptionEventSchema.safeParse({ ...event, payment: { id: 'pay_1' } }).success).toBe(false);
  });
});

describe('ExternalTransactionReportSchema', () => {
  const first = {
    externalTransactionId: 'ext_1',
    externalTransactionToken: 'token_from_device',
    productKind: ProductKind.Subscription,
    amount: 42300,
    taxAmount: 7614,
    transactionTime: T,
    state: 'Karnataka',
  };
  const { externalTransactionToken: _token, ...withoutToken } = first;
  const renewal = { ...withoutToken, externalTransactionId: 'ext_2', initialExternalTransactionId: 'ext_1' };

  it('accepts a first transaction (token) and a renewal (initial id)', () => {
    expect(ExternalTransactionReportSchema.safeParse(first).success).toBe(true);
    expect(ExternalTransactionReportSchema.safeParse(renewal).success).toBe(true);
  });

  it('accepts a free trial: amount 0 and tax 0', () => {
    expect(ExternalTransactionReportSchema.safeParse({ ...first, amount: 0, taxAmount: 0 }).success).toBe(true);
  });

  it('rejects both the token and the initial id, and neither', () => {
    expect(ExternalTransactionReportSchema.safeParse({ ...first, initialExternalTransactionId: 'ext_0' }).success).toBe(false);
    expect(ExternalTransactionReportSchema.safeParse(withoutToken).success).toBe(false);
  });

  it.each([
    { externalTransactionId: '' },
    { externalTransactionId: 'x'.repeat(129) },
    { amount: -1 },
    { taxAmount: 1.5 },
    { transactionTime: '2026-11-22 10:30' },
    { state: 'K' },
    { productKind: 'weekly' },
  ])('rejects %j', (patch) => {
    expect(ExternalTransactionReportSchema.safeParse({ ...first, ...patch }).success).toBe(false);
  });

  it('allows the longest id', () => {
    expect(ExternalTransactionReportSchema.safeParse({ ...first, externalTransactionId: 'x'.repeat(128) }).success).toBe(true);
  });
});

describe('ExternalTransactionRefundSchema and ExternalTransactionRecordSchema', () => {
  it('a full refund omits the amounts; a partial one carries both', () => {
    expect(ExternalTransactionRefundSchema.safeParse({ externalTransactionId: 'ext_1', refundTime: T }).success).toBe(true);
    expect(
      ExternalTransactionRefundSchema.safeParse({ externalTransactionId: 'ext_1', refundTime: T, amount: 1000, taxAmount: 180 }).success,
    ).toBe(true);
    expect(ExternalTransactionRefundSchema.safeParse({ externalTransactionId: '', refundTime: T }).success).toBe(false);
    expect(ExternalTransactionRefundSchema.safeParse({ externalTransactionId: 'ext_1', refundTime: 'yesterday' }).success).toBe(false);
    expect(ExternalTransactionRefundSchema.safeParse({ externalTransactionId: 'ext_1', refundTime: T, amount: -5 }).success).toBe(false);
  });

  it('a record has an id, a state and the raw answer', () => {
    expect(ExternalTransactionRecordSchema.safeParse({ externalTransactionId: 'ext_1', state: 'ACTIVE', raw: {} }).success).toBe(true);
    expect(ExternalTransactionRecordSchema.safeParse({ externalTransactionId: 'ext_1' }).success).toBe(false);
  });
});

describe('CapabilitiesSchema: the four new fields', () => {
  const capabilities = {
    provider: Provider.Razorpay,
    kind: ProviderKind.Gateway,
    scheduling: ['gateway'],
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
    paymentMethods: [PaymentMethod.Upi],
    oneTimePayments: true,
    oneTimePaymentMethods: [PaymentMethod.Upi, PaymentMethod.NetBanking, PaymentMethod.Wallet],
  };

  it('accepts them', () => {
    expect(CapabilitiesSchema.safeParse(capabilities).success).toBe(true);
    expect(CapabilitiesSchema.safeParse({ ...capabilities, kind: ProviderKind.Store, oneTimePaymentMethods: [] }).success).toBe(true);
  });

  it.each(['kind', 'cancel', 'oneTimePayments', 'oneTimePaymentMethods'])('requires %s', (field) => {
    const { [field]: _omitted, ...without } = capabilities as Record<string, unknown>;
    expect(CapabilitiesSchema.safeParse(without).success).toBe(false);
  });

  it('rejects an unknown kind and an unknown one-time method', () => {
    expect(CapabilitiesSchema.safeParse({ ...capabilities, kind: 'marketplace' }).success).toBe(false);
    expect(CapabilitiesSchema.safeParse({ ...capabilities, oneTimePaymentMethods: ['cheque'] }).success).toBe(false);
  });
});
