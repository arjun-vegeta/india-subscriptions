import type { FetchLike } from '../../src/http.js';
import type { WebhookRequest } from '../../src/schemas.js';
import { WEBHOOK_AUTHORIZATION, tokenBody } from './helpers.js';

/**
 * A stateful stand-in for PhonePe's Standard Checkout Autopay API, used by the scheduler and conformance tests. It answers
 * with the documented shapes (the same ones the fixtures copy) and keeps what a real gateway keeps: setup orders and
 * mandates, notifications with their execution window, debits.
 *
 * Assumptions of the FAKE (the docs are silent): a second redeem of an order that already holds a debit is refused with
 * `DUPLICATE_TXN_REQUEST`; cancelling a cancelled mandate answers 204 again; a notification's window is
 * `[notifiedAt + 24 h, + 72 h]` (rounded down to the second), as the samples of [SC-NOTIFSTATUS] show.
 */

const HOUR = 3_600_000;

export interface FakeOrder {
  id: string;
  kind: 'setup' | 'redemption';
  state: string;
  amount: number;
  subscriptionId: string;
  phonepeOrderId: string;
  authWorkflowType?: string;
  notifiedAt?: number;
  validAfter?: number;
  validUpto?: number;
  transactionId?: string;
  redeemedAt?: number;
  errorCode?: string;
  detailedErrorCode?: string;
  settledAt?: number;
}

export interface FakeSubscription {
  id: string;
  state: string;
  maxAmount: number;
  amountType: string;
  frequency: string;
  expireAt: number;
  authWorkflowType: string;
  phonepeId: string;
}

export interface RecordedRequest {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export class FakePhonePe {
  readonly requests: RecordedRequest[] = [];
  readonly orders = new Map<string, FakeOrder>();
  readonly subscriptions = new Map<string, FakeSubscription>();
  /** The `merchantOrderId` of every redeem request the adapter SENT (a lost one included), repeats included. */
  readonly redeemRequests: string[] = [];
  /** The `merchantOrderId` of every notify request that reached the gateway. */
  readonly notifyRequests: string[] = [];
  /** Orders on which a debit was executed (the customer was debited). */
  readonly debits = new Set<string>();
  readonly validTokens = new Set<string>();
  tokensIssued = 0;
  /** While `now < hideUntilMs`, a redeemed order still shows as `NOTIFIED` (a status API that lags). */
  hideUntilMs = 0;
  dropNextRedeem: 'answer' | 'request' | undefined;
  private counter = 0;
  /** Mandates whose setup the customer has not finished: PhonePe has no subscription entry for them yet. */
  private readonly pendingMandates = new Map<string, FakeSubscription>();

  constructor(private readonly nowMs: () => number) {}

  /** Every token issued so far stops being accepted: the next API call gets a 401. */
  revokeTokens(): void {
    this.validTokens.clear();
  }

  private next(prefix: string): string {
    this.counter += 1;
    return `${prefix}${String(this.counter).padStart(6, '0')}V`;
  }

  /** The customer authorises the mandate that the setup order of `subscriptionId` asks for: it becomes visible and ACTIVE. */
  authorise(subscriptionId: string): void {
    const pending = this.pendingMandates.get(subscriptionId);
    if (!pending) throw new Error(`no pending mandate ${subscriptionId}`);
    this.pendingMandates.delete(subscriptionId);
    this.subscriptions.set(subscriptionId, { ...pending, state: 'ACTIVE' });
    const setup = this.orders.get(`ST_${subscriptionId}`);
    if (setup) setup.state = 'COMPLETED';
  }

  setSubscriptionState(subscriptionId: string, state: string): void {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) throw new Error(`no subscription ${subscriptionId}`);
    subscription.state = state;
  }

  /** PhonePe's final answer for a debit it holds. */
  settle(orderId: string, outcome: 'succeeded' | 'failed'): void {
    const order = this.orders.get(orderId);
    if (!order || order.redeemedAt === undefined) throw new Error(`order ${orderId} holds no debit`);
    order.state = outcome === 'succeeded' ? 'COMPLETED' : 'FAILED';
    order.settledAt = this.nowMs();
    if (outcome === 'failed') {
      order.errorCode = 'INSUFFICIENT_BALANCE';
      order.detailedErrorCode = 'Z9';
    }
  }

  // -------------------------------------------------------------------------
  // The wire
  // -------------------------------------------------------------------------

  readonly fetch: FetchLike = async (url, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const target = new URL(url);
    const path = target.pathname.replace(/^\/apis\/pg-sandbox/, '');
    const body = typeof init.body === 'string' ? init.body : undefined;
    const headers = new Headers(init.headers as HeadersInit | undefined);

    if (path === '/v1/oauth/token') {
      this.tokensIssued += 1;
      const token = `fake_token_${this.tokensIssued}`;
      this.validTokens.add(token);
      return json(200, tokenBody(this.nowMs(), token));
    }

    let parsed: Record<string, unknown> | undefined;
    if (body !== undefined) parsed = JSON.parse(body) as Record<string, unknown>;
    this.requests.push({ method, path, ...(parsed ? { body: parsed } : {}) });

    const authorization = headers.get('authorization') ?? '';
    const token = authorization.startsWith('O-Bearer ') ? authorization.slice('O-Bearer '.length) : '';
    if (!this.validTokens.has(token)) return json(401, { code: 'UNAUTHORIZED', message: 'token rejected' });

    let match: RegExpMatchArray | null;
    if (method === 'POST' && path === '/checkout/v2/pay') return this.pay(parsed ?? {});
    if (method === 'GET' && (match = path.match(/^\/checkout\/v2\/order\/([^/]+)\/status$/))) return this.orderStatus(decodeURIComponent(match[1] as string));
    if (method === 'GET' && (match = path.match(/^\/checkout\/v2\/subscriptions\/([^/]+)\/status$/))) return this.subscriptionStatus(decodeURIComponent(match[1] as string));
    if (method === 'POST' && path === '/checkout/v2/subscriptions/notify') return this.notify(parsed ?? {});
    if (method === 'POST' && path === '/checkout/v2/subscriptions/redeem') return this.redeem(parsed ?? {});
    if (method === 'POST' && (match = path.match(/^\/checkout\/v2\/subscriptions\/([^/]+)\/cancel$/))) return this.cancel(decodeURIComponent(match[1] as string));
    if (method === 'POST' && path === '/payments/v2/refund') {
      return json(200, { refundId: this.next('OMR'), currency: 'INR', amount: parsed?.amount, state: 'PENDING' });
    }
    throw new Error(`FakePhonePe: unexpected request ${method} ${path}`);
  };

  private pay(body: Record<string, unknown>): Response {
    const orderId = String(body.merchantOrderId);
    if (this.orders.has(orderId)) return json(400, { code: 'BAD_REQUEST', message: 'Please check the inputs you have provided.' });
    const flow = body.paymentFlow as { subscriptionDetails: Record<string, unknown> };
    const details = flow.subscriptionDetails;
    const subscriptionId = String(details.merchantSubscriptionId);
    const phonepeOrderId = this.next('OMO');
    this.orders.set(orderId, {
      id: orderId,
      kind: 'setup',
      state: 'PENDING',
      amount: Number(body.amount),
      subscriptionId,
      phonepeOrderId,
      authWorkflowType: String(details.authWorkflowType),
    });
    // The mandate itself exists for the status endpoint only once the customer has authorised: until then PhonePe has
    // "no subscription entry" (the fake's reading of an undocumented case).
    this.pendingMandates.set(subscriptionId, {
      id: subscriptionId,
      state: 'PENDING',
      maxAmount: Number(details.maxAmount),
      amountType: String(details.amountType),
      frequency: String(details.frequency),
      expireAt: Number(details.expireAt),
      authWorkflowType: String(details.authWorkflowType),
      phonepeId: this.next('OMS'),
    });
    return json(200, {
      orderId: phonepeOrderId,
      state: 'PENDING',
      redirectUrl: `https://mercury-t2.phonepe.com/transact/pgv3?token=fake&routingKey=V`,
      expireAt: this.nowMs() + 30 * 60 * 1000,
    });
  }

  private subscriptionStatus(id: string): Response {
    const subscription = this.subscriptions.get(id);
    if (!subscription) return json(404, { code: 'SUBSCRIPTION_NOT_FOUND', message: 'Subscription entry not found' });
    return json(200, {
      merchantSubscriptionId: subscription.id,
      subscriptionId: subscription.phonepeId,
      state: subscription.state,
      productType: null,
      authInstrumentType: null,
      authWorkflowType: subscription.authWorkflowType,
      amountType: subscription.amountType,
      currency: 'INR',
      maxAmount: subscription.maxAmount,
      frequency: subscription.frequency,
      expireAt: subscription.expireAt,
      pauseStartDate: null,
      pauseEndDate: null,
    });
  }

  private orderStatus(id: string): Response {
    const order = this.orders.get(id);
    if (!order) return json(404, { code: 'INVALID_MERCHANT_ORDER_ID', message: 'No entry found for given merchant order id' });
    if (order.kind === 'setup') {
      const mandate = this.subscriptions.get(order.subscriptionId) ?? this.pendingMandates.get(order.subscriptionId);
      return json(200, {
        orderId: order.phonepeOrderId,
        state: order.state,
        currency: 'INR',
        amount: order.amount,
        expireAt: this.nowMs() + 30 * 60 * 1000,
        paymentFlow: {
          type: 'SUBSCRIPTION_CHECKOUT_SETUP',
          merchantSubscriptionId: order.subscriptionId,
          authWorkflowType: order.authWorkflowType,
          amountType: mandate?.amountType,
          maxAmount: mandate?.maxAmount,
          frequency: mandate?.frequency,
          expireAt: mandate?.expireAt,
          ...(order.state === 'COMPLETED' ? { subscriptionId: mandate?.phonepeId } : {}),
        },
        paymentDetails:
          order.state === 'COMPLETED'
            ? [{ transactionId: 'OM_SETUP', paymentMode: 'UPI_QR', timestamp: this.nowMs(), amount: order.amount, state: 'COMPLETED' }]
            : [],
      });
    }
    const hidden = order.redeemedAt !== undefined && this.nowMs() < this.hideUntilMs;
    const state = hidden ? 'NOTIFIED' : order.state;
    const redeemed = order.redeemedAt !== undefined && !hidden;
    return json(200, {
      orderId: order.phonepeOrderId,
      state,
      currency: 'INR',
      amount: order.amount,
      expireAt: (order.notifiedAt ?? 0) + 96 * HOUR,
      ...(state === 'FAILED' ? { errorCode: order.errorCode, detailedErrorCode: order.detailedErrorCode } : {}),
      paymentFlow: {
        type: 'SUBSCRIPTION_CHECKOUT_REDEMPTION',
        merchantSubscriptionId: order.subscriptionId,
        redemptionRetryStrategy: 'STANDARD',
        autoDebit: false,
        validAfter: order.validAfter,
        validUpto: order.validUpto,
        notifiedAt: order.notifiedAt,
      },
      paymentDetails: redeemed
        ? [
            {
              transactionId: order.transactionId,
              paymentMode: 'UPI_AUTO_PAY',
              timestamp: order.settledAt ?? order.redeemedAt,
              amount: order.amount,
              state,
              ...(state === 'FAILED' ? { errorCode: order.errorCode, detailedErrorCode: order.detailedErrorCode } : {}),
            },
          ]
        : [],
    });
  }

  private notify(body: Record<string, unknown>): Response {
    const id = String(body.merchantOrderId);
    const flow = body.paymentFlow as Record<string, unknown>;
    const subscriptionId = String(flow.merchantSubscriptionId);
    this.notifyRequests.push(id);
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return json(404, { code: 'SUBSCRIPTION_NOT_FOUND', message: 'Subscription setup entry not found' });
    if (subscription.state !== 'ACTIVE') {
      return json(400, { code: 'INVALID_SUBSCRIPTION_STATE', message: 'The state subscription is in currently doesn’t approve of the operation tried.' });
    }
    if (this.orders.has(id)) return json(400, { code: 'DUPLICATE_TXN_REQUEST', message: 'Debit transaction id is duplicate. Use another unique one.' });
    const notifiedAt = this.nowMs();
    const validAfter = Math.floor((notifiedAt + 24 * HOUR) / 1000) * 1000;
    const phonepeOrderId = this.next('OMO');
    this.orders.set(id, {
      id,
      kind: 'redemption',
      state: 'NOTIFIED',
      amount: Number(body.amount),
      subscriptionId,
      phonepeOrderId,
      notifiedAt,
      validAfter,
      validUpto: validAfter + 72 * HOUR,
    });
    return json(200, { orderId: phonepeOrderId, state: 'NOTIFICATION_IN_PROGRESS', expireAt: notifiedAt + 96 * HOUR, nativeOtpEnabled: false });
  }

  private redeem(body: Record<string, unknown>): Response {
    const id = String(body.merchantOrderId);
    // Recorded when SENT: a request the network loses is still a request the adapter made (and may repeat).
    this.redeemRequests.push(id);
    if (this.dropNextRedeem === 'request') {
      this.dropNextRedeem = undefined;
      throw new TypeError('fetch failed');
    }
    const order = this.orders.get(id);
    if (!order || order.kind !== 'redemption') return json(404, { code: 'INVALID_MERCHANT_ORDER_ID', message: 'No entry found for given merchant order id' });
    if (order.redeemedAt !== undefined) return json(400, { code: 'DUPLICATE_TXN_REQUEST', message: 'Debit transaction id is duplicate. Use another unique one.' });
    const subscription = this.subscriptions.get(order.subscriptionId);
    if (!subscription || subscription.state !== 'ACTIVE') {
      return json(400, { code: 'INVALID_SUBSCRIPTION_STATE', message: 'The state subscription is in currently doesn’t approve of the operation tried.' });
    }
    const now = this.nowMs();
    if (now < (order.validAfter ?? 0)) {
      return json(400, { code: 'SUBSCRIPTION_DEBIT_EXECUTE_INTERVAL_NOT_STARTED', message: 'Execution interval hasn’t yet started (24 hours after notification)' });
    }
    if (now > (order.validUpto ?? Infinity)) {
      return json(400, { code: 'SUBSCRIPTION_DEBIT_EXECUTE_INTERVAL_EXPIRED', message: 'Subscription debit execute interval has expired' });
    }
    order.state = 'PENDING';
    order.redeemedAt = now;
    order.transactionId = this.next('OM');
    this.debits.add(id);
    if (this.dropNextRedeem === 'answer') {
      this.dropNextRedeem = undefined;
      throw new TypeError('fetch failed');
    }
    return json(200, { transactionId: order.transactionId, state: 'PENDING' });
  }

  private cancel(id: string): Response {
    const subscription = this.subscriptions.get(id);
    if (!subscription) return json(404, { code: 'SUBSCRIPTION_NOT_FOUND', message: 'Subscription entry not found' });
    subscription.state = 'CANCELLED';
    return new Response(null, { status: 204 });
  }

  // -------------------------------------------------------------------------
  // Webhooks PhonePe would send, signed with the Authorization header
  // -------------------------------------------------------------------------

  private signed(body: unknown): WebhookRequest {
    return { rawBody: JSON.stringify(body), headers: { authorization: WEBHOOK_AUTHORIZATION } };
  }

  /** `subscription.redemption.order.completed|failed` for a debit the gateway holds. */
  debitWebhook(orderId: string, outcome: 'succeeded' | 'failed'): WebhookRequest {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`no order ${orderId}`);
    const failed = outcome === 'failed';
    return this.signed({
      event: failed ? 'subscription.redemption.order.failed' : 'subscription.redemption.order.completed',
      payload: {
        merchantId: 'MER_FAKE',
        merchantOrderId: order.id,
        orderId: order.phonepeOrderId,
        state: failed ? 'FAILED' : 'COMPLETED',
        amount: order.amount,
        expireAt: (order.notifiedAt ?? 0) + 96 * HOUR,
        ...(failed ? { errorCode: 'INSUFFICIENT_BALANCE', detailedErrorCode: 'Z9' } : {}),
        paymentFlow: {
          type: 'SUBSCRIPTION_CHECKOUT_REDEMPTION',
          merchantSubscriptionId: order.subscriptionId,
          redemptionRetryStrategy: 'STANDARD',
          autoDebit: false,
          validAfter: order.validAfter,
          validUpto: order.validUpto,
          notifiedAt: order.notifiedAt,
        },
        paymentDetails: [
          {
            transactionId: order.transactionId ?? 'OM_FAKE',
            paymentMode: 'UPI_AUTO_PAY',
            timestamp: this.nowMs(),
            amount: order.amount,
            state: failed ? 'FAILED' : 'COMPLETED',
            ...(failed ? { errorCode: 'INSUFFICIENT_BALANCE', detailedErrorCode: 'Z9' } : {}),
          },
        ],
      },
    });
  }

  /** The customer paused / un-paused / revoked in their UPI app, or the merchant's cancel. */
  mandateWebhook(subscriptionId: string, kind: 'paused' | 'unpaused' | 'revoked' | 'cancelled'): WebhookRequest {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) throw new Error(`no subscription ${subscriptionId}`);
    const now = this.nowMs();
    const state = { paused: 'PAUSED', unpaused: 'ACTIVE', revoked: 'REVOKED', cancelled: 'CANCELLED' }[kind];
    return this.signed({
      event: `subscription.${kind}`,
      payload: {
        merchantSubscriptionId: subscription.id,
        subscriptionId: subscription.phonepeId,
        state,
        authWorkflowType: subscription.authWorkflowType,
        amountType: subscription.amountType,
        maxAmount: subscription.maxAmount,
        frequency: subscription.frequency,
        expireAt: subscription.expireAt,
        pauseStartDate: kind === 'paused' ? now : null,
        pauseEndDate: kind === 'paused' ? now + 24 * HOUR : null,
      },
    });
  }
}
