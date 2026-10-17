import { describe, expect, it } from 'vitest';
import { ErrorCode, HttpMethod, PaymentStatus } from '../../src/constants.js';
import { PaymentSchema } from '../../src/schemas.js';
import { ORDER_PROCESSED, PRODUCT_PURCHASED } from './fixtures.js';
import { P, makeProvider, route } from './helpers.js';

const TOKEN = 'one-time-token';
const BASE = 'https://androidpublisher.googleapis.com/androidpublisher/v3';
const PRODUCT = `${P}/purchases/productsv2/tokens/${TOKEN}`;
const ORDER = `${P}/orders/GPA.3375-1111-2222-33333`;
const ACK = `${P}/purchases/products/coins_100/tokens/${TOKEN}:acknowledge`;
const CONSUME = `${P}/purchases/products/coins_100/tokens/${TOKEN}:consume`;
const REFUND = `${ORDER}:refund`;

const product = (json: unknown = PRODUCT_PURCHASED) => route(HttpMethod.Get, PRODUCT, { json: json as Record<string, unknown> });
const order = (json: unknown = ORDER_PROCESSED) => route(HttpMethod.Get, ORDER, { json: json as Record<string, unknown> });
const result = { purchaseToken: TOKEN, productId: 'coins_100' };
const consumed = (purchase = PRODUCT_PURCHASED) => ({
  ...purchase,
  productLineItem: [{ ...purchase.productLineItem[0], productOfferDetails: { ...purchase.productLineItem[0]?.productOfferDetails, consumptionState: 'CONSUMPTION_STATE_CONSUMED' } }],
});

describe('verifyPayment: a non-consumable product is acknowledged [purchases.products.acknowledge]', () => {
  it('reads the purchase and its order, acknowledges once, and returns the token as paymentId', async () => {
    const t = makeProvider([product(), order(), route(HttpMethod.Post, ACK, { json: {} })]);
    const verification = await t.provider.verifyPayment(result);
    const [readProduct, readOrder, ack] = t.apiCalls();
    expect(readProduct).toMatchObject({ method: 'GET', url: `${BASE}${PRODUCT}` });
    expect(readOrder).toMatchObject({ method: 'GET', url: `${BASE}${ORDER}` });
    expect(ack).toMatchObject({ method: 'POST', url: `${BASE}${ACK}` });
    expect(ack?.json).toEqual({});
    expect(verification).toMatchObject({
      provider: 'google_play',
      paymentId: TOKEN,
      reference: '0b9d9a4e-6f27-4c52-8a0b-4a3c2f6f4c10',
      paid: true,
      status: 'succeeded',
    });
    expect(PaymentSchema.parse(verification.payment)).toBeTruthy();
    expect(verification.payment).toMatchObject({
      id: TOKEN,
      amount: 9900,
      currency: 'INR',
      status: 'succeeded',
      providerStatus: 'PURCHASED',
      createdAt: '2026-11-22T05:59:30.000Z',
      paidAt: '2026-11-22T06:00:00.000Z',
      metadata: { productId: 'coins_100', orderId: 'GPA.3375-1111-2222-33333', orderState: 'PROCESSED' },
    });
  });

  it('does not acknowledge twice', async () => {
    const t = makeProvider([product({ ...PRODUCT_PURCHASED, acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' }), order()]);
    await t.provider.verifyPayment(result);
    expect(t.apiCalls()).toHaveLength(2);
  });

  it('a pending purchase is unpaid and untouched', async () => {
    const t = makeProvider([product({ ...PRODUCT_PURCHASED, purchaseStateContext: { purchaseState: 'PENDING' }, orderId: null })]);
    const verification = await t.provider.verifyPayment(result);
    expect(verification).toMatchObject({ paid: false, status: PaymentStatus.Pending });
    expect(t.apiCalls()).toHaveLength(1);
  });

  it('a cancelled purchase is unpaid and untouched', async () => {
    const t = makeProvider([product({ ...PRODUCT_PURCHASED, purchaseStateContext: { purchaseState: 'CANCELLED' }, orderId: null })]);
    expect(await t.provider.verifyPayment(result)).toMatchObject({ paid: false, status: PaymentStatus.Cancelled });
    expect(t.apiCalls()).toHaveLength(1);
  });

  it('a purchase with no order (a promo code) is paid, amount 0', async () => {
    const t = makeProvider([product({ ...PRODUCT_PURCHASED, orderId: null }), route(HttpMethod.Post, ACK, { json: {} })]);
    const verification = await t.provider.verifyPayment(result);
    expect(verification.payment?.amount).toBe(0);
  });

  it('a result naming another product is SIGNATURE_INVALID', async () => {
    const t = makeProvider([product()]);
    await expect(t.provider.verifyPayment({ purchaseToken: TOKEN, productId: 'gems_500' })).rejects.toMatchObject({ code: ErrorCode.SignatureInvalid });
    expect(t.apiCalls()).toHaveLength(1);
  });

  it('refuses a test purchase in live', async () => {
    const t = makeProvider([product({ ...PRODUCT_PURCHASED, testPurchaseContext: { fopType: 'TEST' } })], { config: { environment: 'live' } });
    await expect(t.provider.verifyPayment(result)).rejects.toMatchObject({ code: ErrorCode.Validation });
  });

  it('in another currency the purchase is acknowledged and returned without payment', async () => {
    const usd = { ...ORDER_PROCESSED, total: { currencyCode: 'USD', units: '1', nanos: 0 } };
    const t = makeProvider([product(), order(usd), route(HttpMethod.Post, ACK, { json: {} })]);
    const verification = await t.provider.verifyPayment(result);
    expect(verification).toMatchObject({ paid: true, paymentId: TOKEN });
    expect(verification.payment).toBeUndefined();
    expect(t.apiCalls()).toHaveLength(3);
  });
});

describe('verifyPayment: a consumable product is consumed [purchases.products.consume]', () => {
  it('consumes, and does not acknowledge, when the checkout result says consumable', async () => {
    const t = makeProvider([product(), order(), route(HttpMethod.Post, CONSUME, { json: {} })]);
    await t.provider.verifyPayment({ ...result, consumable: true });
    const post = t.apiCalls()[2];
    expect(post).toMatchObject({ method: 'POST', url: `${BASE}${CONSUME}` });
    expect(post?.body).toBeUndefined();
    expect(t.apiCalls().some((call) => call.url.endsWith(':acknowledge'))).toBe(false);
  });

  it('consumes when the product id is in consumableProductIds', async () => {
    const t = makeProvider([product(), order(), route(HttpMethod.Post, CONSUME, { json: {} })], { config: { consumableProductIds: ['coins_100'] } });
    await t.provider.verifyPayment(result);
    expect(t.apiCalls()[2]?.url).toBe(`${BASE}${CONSUME}`);
  });

  it('does not consume a purchase that is consumed already', async () => {
    const t = makeProvider([product(consumed()), order()], { config: { consumableProductIds: ['coins_100'] } });
    await t.provider.verifyPayment(result);
    expect(t.apiCalls()).toHaveLength(2);
  });

  it('a consumable flag of false means acknowledge', async () => {
    const t = makeProvider([product(), order(), route(HttpMethod.Post, ACK, { json: {} })]);
    await t.provider.verifyPayment({ ...result, consumable: false });
    expect(t.apiCalls()[2]?.url).toBe(`${BASE}${ACK}`);
  });
});

describe('getPayment [purchases.productsv2.getproductpurchasev2 + orders.get]', () => {
  it('maps the purchase state and takes the amount from the order', async () => {
    const t = makeProvider([product(), order()]);
    const payment = await t.provider.getPayment(TOKEN);
    expect(payment).toMatchObject({ id: TOKEN, status: 'succeeded', amount: 9900 });
  });

  it('a refund on the order wins over PURCHASED', async () => {
    const full = { ...ORDER_PROCESSED, state: 'REFUNDED', orderHistory: { refundEvent: { eventTime: '2026-11-22T08:00:00Z', refundDetails: { total: { currencyCode: 'INR', units: '99', nanos: 0 } } } } };
    const t = makeProvider([product(), order(full)]);
    expect(await t.provider.getPayment(TOKEN)).toMatchObject({ status: 'refunded', providerStatus: 'REFUNDED', refundedAmount: 9900 });
  });

  it('a partial refund is partially_refunded with the processed amounts added', async () => {
    const partial = {
      ...ORDER_PROCESSED,
      state: 'PARTIALLY_REFUNDED',
      orderHistory: {
        partialRefundEvents: [
          { state: 'PROCESSED_SUCCESSFULLY', refundDetails: { total: { currencyCode: 'INR', units: '10', nanos: 0 } } },
          { state: 'PROCESSED_SUCCESSFULLY', refundDetails: { total: { currencyCode: 'INR', units: '5', nanos: 500000000 } } },
          { state: 'PENDING', refundDetails: { total: { currencyCode: 'INR', units: '50', nanos: 0 } } },
        ],
      },
    };
    const t = makeProvider([product(), order(partial)]);
    expect(await t.provider.getPayment(TOKEN)).toMatchObject({ status: 'partially_refunded', refundedAmount: 1550 });
  });

  it('an order in another currency is UNSUPPORTED', async () => {
    const t = makeProvider([product(), order({ ...ORDER_PROCESSED, total: { currencyCode: 'EUR', units: '1', nanos: 0 } })]);
    await expect(t.provider.getPayment(TOKEN)).rejects.toMatchObject({ code: ErrorCode.Unsupported });
  });

  it('an unknown purchase state is pending', async () => {
    const t = makeProvider([product({ ...PRODUCT_PURCHASED, purchaseStateContext: { purchaseState: 'SOMETHING_NEW' }, orderId: null })]);
    expect(await t.provider.getPayment(TOKEN)).toMatchObject({ status: 'pending', providerStatus: 'SOMETHING_NEW' });
  });
});

describe('refundPayment [orders.refund]', () => {
  it('refunds the purchase\'s order with revoke=true and returns chargeId and paymentId as the token', async () => {
    const t = makeProvider([
      product(),
      order(),
      route(HttpMethod.Post, REFUND, { json: {} }, '?revoke=true'),
      order({ ...ORDER_PROCESSED, state: 'REFUNDED' }),
    ]);
    const refund = await t.provider.refundPayment({ paymentId: TOKEN, refundId: 'refund-9', reason: 'customer asked' });
    expect(t.apiCalls()[2]).toMatchObject({ method: 'POST', url: `${BASE}${REFUND}?revoke=true` });
    expect(refund).toMatchObject({ id: 'refund-9', chargeId: TOKEN, paymentId: TOKEN, status: 'succeeded', amount: 9900, currency: 'INR' });
    expect(refund.subscriptionId).toBeUndefined();
  });

  it('refuses a partial amount', async () => {
    const t = makeProvider([product(), order()]);
    await expect(t.provider.refundPayment({ paymentId: TOKEN, refundId: 'r', amount: 500 })).rejects.toMatchObject({ code: ErrorCode.Unsupported });
  });

  it('a purchase without an order cannot be refunded here', async () => {
    const t = makeProvider([product({ ...PRODUCT_PURCHASED, orderId: null })]);
    await expect(t.provider.refundPayment({ paymentId: TOKEN, refundId: 'r' })).rejects.toThrowError(/no order|issued no order/);
  });
});
