import { describe, expect, it } from 'vitest';
import { Currency, ErrorCode, EventType, HttpMethod, PaymentMethod, PaymentStatus, Provider, RefundStatus } from '../../src/constants.js';
import { REDEMPTION_ORDER_COMPLETED_A_REDORDER, WEBHOOK_CHECKOUT_ORDER_COMPLETED_ONE_OFF, WEBHOOK_CHECKOUT_ORDER_COMPLETED_SC_WEBHOOK } from './fixtures.js';
import {
  ORDER_CASE_1_STATUS,
  ORDER_CASE_6_STATUS,
  WEBHOOK_ORDER_COMPLETED_WEBHOOK,
  WEBHOOK_ORDER_FAILED_WEBHOOK,
  WEBHOOK_REFUND_COMPLETED_CASE_2_WEBHOOK,
  WEBHOOK_REFUND_FAILED_CASE_3_WEBHOOK,
} from './payment-fixtures.js';
import { O_BEARER, SANDBOX_API, TEST_TOKEN, makeProvider, rejection, route, sha256Hex, webhookRequest, WEBHOOK_USERNAME } from './helpers.js';
import type { MockRoute } from '../helpers/mock-fetch.js';

const orderPath = (id: string) => `/checkout/v2/order/${id}/status?details=true`;
const orderRoute = (id: string, json: unknown, status?: number): MockRoute => route(HttpMethod.Get, orderPath(id), { json, ...(status ? { status } : {}) });

async function parse(body: unknown, routes: MockRoute[] = []) {
  const t = makeProvider(routes);
  const events = await t.provider.parseWebhook(webhookRequest(body));
  expect(events).toHaveLength(1);
  return { event: events[0]!, t };
}

describe('checkout.order.* of a one-time payment [WEBHOOK]', () => {
  it('checkout.order.completed is payment.succeeded, with the order id as paymentId and the payment from the payload', async () => {
    const { event, t } = await parse(WEBHOOK_ORDER_COMPLETED_WEBHOOK);
    expect(event).toEqual({
      id: 'checkout.order.completed:merchantOrderId',
      provider: Provider.PhonePe,
      providerEventType: 'checkout.order.completed',
      type: EventType.PaymentSucceeded,
      occurredAt: new Date(1724866793837).toISOString(),
      paymentId: 'merchantOrderId',
      payment: {
        provider: Provider.PhonePe,
        id: 'merchantOrderId',
        reference: 'merchantOrderId',
        status: PaymentStatus.Succeeded,
        providerStatus: 'COMPLETED',
        amount: 10000,
        currency: Currency.INR,
        paymentMethod: PaymentMethod.Upi,
        paidAt: new Date(1724866793837).toISOString(),
        raw: WEBHOOK_ORDER_COMPLETED_WEBHOOK.payload,
      },
      raw: WEBHOOK_ORDER_COMPLETED_WEBHOOK,
    });
    // The payload is enough: no call to PhonePe.
    expect(t.calls).toHaveLength(0);
  });

  it('checkout.order.failed is payment.failed with PhonePe\'s failure codes', async () => {
    const { event } = await parse(WEBHOOK_ORDER_FAILED_WEBHOOK);
    expect(event).toMatchObject({
      id: 'checkout.order.failed:merchantOrderId',
      type: EventType.PaymentFailed,
      providerEventType: 'checkout.order.failed',
      paymentId: 'merchantOrderId',
      payment: {
        id: 'merchantOrderId',
        status: PaymentStatus.Failed,
        providerStatus: 'FAILED',
        amount: 10000,
        paymentMethod: PaymentMethod.Upi,
        failureCode: 'AUTHORIZATION_ERROR',
        failureReason: 'AUTHORIZATION_ERROR (detailed error code ZM)',
      },
    });
    expect(event.payment?.paidAt).toBeUndefined();
  });

  it('a Standard Checkout order may carry paymentFlow type PG_CHECKOUT or PG: still a payment', async () => {
    for (const type of ['PG_CHECKOUT', 'PG']) {
      const body = { ...WEBHOOK_CHECKOUT_ORDER_COMPLETED_ONE_OFF, payload: { ...WEBHOOK_CHECKOUT_ORDER_COMPLETED_ONE_OFF.payload, paymentFlow: { type } } };
      const { event } = await parse(body);
      expect(event).toMatchObject({ type: EventType.PaymentSucceeded, paymentId: 'ONE_OFF_ORDER_1', payment: { amount: 5000 } });
    }
  });

  it('the udf values of the order come back as the payment\'s metadata, without the empty ones', async () => {
    const body = {
      ...WEBHOOK_ORDER_COMPLETED_WEBHOOK,
      payload: { ...WEBHOOK_ORDER_COMPLETED_WEBHOOK.payload, metaInfo: { udf1: 'cart-77', udf2: '' } },
    };
    expect((await parse(body)).event.payment?.metadata).toEqual({ udf1: 'cart-77' });
  });

  it('only the payload\'s own state decides: a completed event with a FAILED state is unknown, and so is a failed event with COMPLETED', async () => {
    const completedButFailed = { ...WEBHOOK_ORDER_COMPLETED_WEBHOOK, payload: { ...WEBHOOK_ORDER_COMPLETED_WEBHOOK.payload, state: 'FAILED' } };
    const failedButCompleted = { ...WEBHOOK_ORDER_FAILED_WEBHOOK, payload: { ...WEBHOOK_ORDER_FAILED_WEBHOOK.payload, state: 'COMPLETED' } };
    const pending = { ...WEBHOOK_ORDER_COMPLETED_WEBHOOK, payload: { ...WEBHOOK_ORDER_COMPLETED_WEBHOOK.payload, state: 'PENDING' } };
    for (const body of [completedButFailed, failedButCompleted, pending]) {
      const { event } = await parse(body);
      expect(event).toMatchObject({ type: EventType.Unknown, providerEventType: body.event });
      expect(event.paymentId).toBeUndefined();
      expect(event.payment).toBeUndefined();
    }
  });

  it('a payload without an order id or without an amount cannot be a payment: unknown, still acknowledged', async () => {
    const { merchantOrderId: _id, ...withoutId } = WEBHOOK_ORDER_COMPLETED_WEBHOOK.payload;
    const { amount: _amount, paymentDetails: _details, ...withoutAmount } = WEBHOOK_ORDER_COMPLETED_WEBHOOK.payload;
    for (const payload of [withoutId, withoutAmount]) {
      expect((await parse({ event: 'checkout.order.completed', payload })).event.type).toBe(EventType.Unknown);
    }
  });

  it('an order of a flow this adapter does not know (a payment link, say) is unknown', async () => {
    const body = { ...WEBHOOK_ORDER_COMPLETED_WEBHOOK, payload: { ...WEBHOOK_ORDER_COMPLETED_WEBHOOK.payload, paymentFlow: { type: 'PAYMENT_LINK' } } };
    expect((await parse(body)).event.type).toBe(EventType.Unknown);
  });

  it('the same delivery has the same event id (de-duplication)', async () => {
    const first = (await parse(WEBHOOK_ORDER_COMPLETED_WEBHOOK)).event.id;
    expect((await parse(WEBHOOK_ORDER_COMPLETED_WEBHOOK)).event.id).toBe(first);
  });
});

describe('Autopay orders under the same event names are mapped as before', () => {
  it('checkout.order.completed of a subscription setup (paymentFlow SUBSCRIPTION_CHECKOUT_SETUP) is subscription.authorized, not a payment', async () => {
    const { event } = await parse(WEBHOOK_CHECKOUT_ORDER_COMPLETED_SC_WEBHOOK);
    expect(event).toMatchObject({ type: EventType.SubscriptionAuthorized, subscriptionId: 'MSUB_5580745967290798888' });
    expect(event.paymentId).toBeUndefined();
    expect(event.payment).toBeUndefined();
  });

  it('a subscription id in the payload, or the adapter\'s ST_ order id, keeps an order with no paymentFlow out of the payments', async () => {
    const withSubscription = { event: 'checkout.order.completed', payload: { merchantOrderId: 'o1', merchantSubscriptionId: 'MS1', state: 'COMPLETED', amount: 200 } };
    const setupOrder = { event: 'checkout.order.completed', payload: { merchantOrderId: 'ST_sub_1', state: 'COMPLETED', amount: 200 } };
    for (const body of [withSubscription, setupOrder]) {
      const { event } = await parse(body);
      expect(event.type).toBe(EventType.Unknown);
      expect(event.paymentId).toBeUndefined();
    }
  });

  it('the Autopay setup events by their own names are never payments', async () => {
    const body = { event: 'subscription.setup.order.completed', payload: { merchantOrderId: 'order_1', state: 'COMPLETED', amount: 200, paymentFlow: { type: 'PG_CHECKOUT' } } };
    expect((await parse(body)).event.type).toBe(EventType.Unknown);
  });
});

describe('refunds of a one-time payment [WEBHOOK: the refund payload has no paymentFlow]', () => {
  const ORIGINAL = WEBHOOK_REFUND_COMPLETED_CASE_2_WEBHOOK.payload.originalMerchantOrderId;

  it('pg.refund.completed whose original order is a payment: refund.succeeded with paymentId on the event and on the refund', async () => {
    const { event, t } = await parse(WEBHOOK_REFUND_COMPLETED_CASE_2_WEBHOOK, [orderRoute(ORIGINAL, ORDER_CASE_1_STATUS)]);
    expect(event).toEqual({
      id: 'pg.refund.completed:merchantRefundId',
      provider: Provider.PhonePe,
      providerEventType: 'pg.refund.completed',
      type: EventType.RefundSucceeded,
      occurredAt: new Date(1730869961754).toISOString(),
      paymentId: ORIGINAL,
      refund: {
        provider: Provider.PhonePe,
        id: 'OMR7878098045517540996',
        reference: 'merchantRefundId',
        chargeId: ORIGINAL,
        paymentId: ORIGINAL,
        status: RefundStatus.Succeeded,
        providerStatus: 'COMPLETED',
        amount: 50000,
        currency: Currency.INR,
      },
      raw: WEBHOOK_REFUND_COMPLETED_CASE_2_WEBHOOK,
    });
    // The one read: the original order, with the token.
    expect(t.apiCalls()).toHaveLength(1);
    expect(t.apiCalls()[0]).toMatchObject({ method: 'GET', url: `${SANDBOX_API}${orderPath(ORIGINAL)}` });
    expect(t.apiCalls()[0]?.headers).toMatchObject({ authorization: O_BEARER(TEST_TOKEN) });
  });

  it('pg.refund.failed of a payment is refund.failed with paymentId', async () => {
    const body = {
      event: 'pg.refund.failed',
      payload: { ...WEBHOOK_REFUND_FAILED_CASE_3_WEBHOOK.payload, originalMerchantOrderId: ORIGINAL, merchantRefundId: 'r_9' },
    };
    const { event } = await parse(body, [orderRoute(ORIGINAL, ORDER_CASE_1_STATUS)]);
    expect(event).toMatchObject({
      type: EventType.RefundFailed,
      paymentId: ORIGINAL,
      refund: { chargeId: ORIGINAL, paymentId: ORIGINAL, status: RefundStatus.Failed, amount: 1234 },
    });
  });

  it('a refund of an Autopay debit is mapped exactly as before: no paymentId', async () => {
    const { event } = await parse(WEBHOOK_REFUND_COMPLETED_CASE_2_WEBHOOK, [orderRoute(ORIGINAL, REDEMPTION_ORDER_COMPLETED_A_REDORDER)]);
    expect(event.type).toBe(EventType.RefundSucceeded);
    expect(event.paymentId).toBeUndefined();
    expect(event.refund).toMatchObject({ chargeId: ORIGINAL });
    expect(event.refund).not.toHaveProperty('paymentId');
  });

  it('a refund of a subscription setup order (ST_ id) is Autopay by its id: no call at all', async () => {
    const body = { event: 'pg.refund.completed', payload: { ...WEBHOOK_REFUND_COMPLETED_CASE_2_WEBHOOK.payload, originalMerchantOrderId: 'ST_sub_ref_1' } };
    const { event, t } = await parse(body);
    expect(event).toMatchObject({ subscriptionId: 'sub_ref_1', refund: { subscriptionId: 'sub_ref_1' } });
    expect(event.paymentId).toBeUndefined();
    expect(t.calls).toHaveLength(0);
  });

  it('an original order PhonePe does not know is mapped as an Autopay refund (no paymentId)', async () => {
    const { event } = await parse(WEBHOOK_REFUND_COMPLETED_CASE_2_WEBHOOK, [orderRoute(ORIGINAL, ORDER_CASE_6_STATUS, 404)]);
    expect(event.type).toBe(EventType.RefundSucceeded);
    expect(event.paymentId).toBeUndefined();
  });

  it('the failed-refund sample with an empty originalMerchantOrderId cannot name a payment: unknown, and no call is made', async () => {
    const { event, t } = await parse(WEBHOOK_REFUND_FAILED_CASE_3_WEBHOOK);
    expect(event).toMatchObject({ type: EventType.Unknown, providerEventType: 'pg.refund.failed' });
    expect(t.calls).toHaveLength(0);
  });

  it('when PhonePe cannot be asked, the webhook is refused (PhonePe redelivers) instead of being classified by a guess', async () => {
    const t = makeProvider([route(HttpMethod.Get, orderPath(ORIGINAL), { status: 500, json: { code: 'INTERNAL_SERVER_ERROR', message: 'try later' } })]);
    const error = await rejection(t.provider.parseWebhook(webhookRequest(WEBHOOK_REFUND_COMPLETED_CASE_2_WEBHOOK)));
    expect([ErrorCode.ProviderError, ErrorCode.ProviderUnavailable]).toContain(error.code);
  });

  it('the Authorization header is checked before anything is read from PhonePe', async () => {
    const t = makeProvider();
    const error = await rejection(
      t.provider.parseWebhook(webhookRequest(WEBHOOK_REFUND_COMPLETED_CASE_2_WEBHOOK, sha256Hex(`${WEBHOOK_USERNAME}:wrong`))),
    );
    expect(error.code).toBe(ErrorCode.SignatureInvalid);
    expect(t.calls).toHaveLength(0);
  });
});
