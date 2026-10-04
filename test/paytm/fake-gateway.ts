import { ChargeStatus, EventType } from '../../src/constants.js';
import type { FetchLike } from '../../src/http.js';
import type { Subscription, WebhookRequest } from '../../src/schemas.js';
import { KEY, MID, formBody, independentVerify, signForm, webhookRequest } from './helpers.js';

const HOUR_MS = 3_600_000;

export interface FakeSubscription {
  subsId: string;
  orderId: string;
  custId: string;
  status: string;
  subStatus?: string;
  mode: string;
  maxAmount: string;
  amountType: string;
  frequencyUnit: string;
  expiry: string;
}

export interface FakeDebit {
  orderId: string;
  subsId: string;
  amount: string;
  txnId: string;
  status: 'PENDING' | 'TXN_SUCCESS' | 'TXN_FAILURE';
  code: string;
  message: string;
  createdAt: number;
}

export interface FakeNotification {
  referenceId: string;
  subsId: string;
  txnDate: string;
  amount: string;
  at: number;
}

const ok = (body: unknown) => new Response(JSON.stringify({ head: { version: 'v1' }, body }), { status: 200 });
const theia = (status: string, code: string, msg: string, extra: Record<string, unknown> = {}) =>
  ok({ resultInfo: { resultStatus: status, resultCode: code, resultMsg: msg }, ...extra });
const service = (status: string, code: string, message: string, extra: Record<string, unknown> = {}) =>
  ok({ resultInfo: { status, code, message }, ...extra });

/**
 * A stateful fake of Paytm's subscription, renew, pre-notify, status and refund endpoints. It behaves as the docs say a
 * gateway does: it verifies the signature of EVERY request with an independent implementation of the checksum (a request it
 * cannot verify throws, failing the test), refuses a repeated renew order id (325), wants a pre-notify that the renew names
 * (3054 otherwise) at least 24 hours before the debit (a debit sooner ends as TXN_FAILURE 267), keeps a debit PENDING until
 * the test settles it, and answers Transaction Status NO_RECORD_FOUND for an order it never received.
 */
export class FakePaytm {
  readonly subscriptions = new Map<string, FakeSubscription>();
  readonly debits = new Map<string, FakeDebit>();
  readonly notifications: FakeNotification[] = [];
  /** Every request that reached the fake: the path and the parsed body. */
  readonly requests: { path: string; query: URLSearchParams; head: Record<string, unknown>; body: Record<string, unknown> }[] = [];
  /** The order id of every renew request that arrived, repeats and lost ones included. */
  readonly renewRequestIds: string[] = [];
  /** Per-order-id count of Transaction Status lookups. */
  readonly statusLookups: string[] = [];

  paymentMode = 'UPI';
  /** The next renew is executed but its answer never arrives, or never even reaches Paytm. */
  loseNextRenew: 'answer' | 'request' | undefined;
  /** Transaction Status does not see debits until this instant (epoch ms). */
  hideDebitsUntilMs = 0;
  private counter = 0;

  constructor(private readonly nowMs: () => number) {}

  readonly fetch: FetchLike = async (url, init) => {
    const parsed = new URL(url);
    const text = String(init?.body);
    const envelope = JSON.parse(text) as { head: Record<string, unknown>; body: Record<string, unknown> };
    const signedText = JSON.stringify(envelope.body);
    if (!text.includes(`"body":${signedText}`)) throw new Error(`fake Paytm: the body is not sent as the text that was signed (${parsed.pathname})`);
    if (typeof envelope.head.signature !== 'string' || !independentVerify(signedText, KEY, envelope.head.signature)) {
      throw new Error(`fake Paytm: a request to ${parsed.pathname} carries a signature that does not verify`);
    }
    this.requests.push({ path: parsed.pathname, query: parsed.searchParams, head: envelope.head, body: envelope.body });
    switch (parsed.pathname) {
      case '/subscription/create':
        return this.create(parsed, envelope.body);
      case '/subscription/checkStatus':
        return this.status(envelope.body);
      case '/subscription/preNotify':
        return this.preNotify(envelope.body);
      case '/subscription/renew':
        return this.renew(parsed, envelope.body);
      case '/v3/order/status':
        return this.orderStatus(envelope.body);
      case '/subscription/cancel':
        return this.cancel(envelope.body);
      case '/subscription/subscription/status/modify':
        return this.modify(envelope.body);
      default:
        throw new Error(`fake Paytm: unexpected request ${parsed.pathname}`);
    }
  };

  private create(url: URL, body: Record<string, unknown>): Response {
    if (url.searchParams.get('mid') !== body.mid || url.searchParams.get('orderId') !== body.orderId) {
      return theia('F', '2013', 'Mid in the query param doesn\'t match with the Mid send in the request');
    }
    this.counter += 1;
    const subsId = String(130000 + this.counter);
    this.subscriptions.set(subsId, {
      subsId,
      orderId: String(body.orderId),
      custId: String((body.userInfo as { custId: string }).custId),
      status: 'INIT',
      mode: this.paymentMode,
      maxAmount: String(body.subscriptionMaxAmount ?? body.renewalAmount ?? '0'),
      amountType: String(body.subscriptionAmountType),
      frequencyUnit: String(body.subscriptionFrequencyUnit),
      expiry: String(body.subscriptionExpiryDate),
    });
    return theia('S', '0000', 'Success', { txnToken: `tok_${subsId}`, subscriptionId: subsId, authenticated: false });
  }

  private status(body: Record<string, unknown>): Response {
    const sub = this.subscriptions.get(String(body.subsId));
    if (!sub) return service('FAILURE', '3004', 'Subscription Not Found');
    return service('SUCCESS', '3006', 'SUCCESS', {
      subsId: sub.subsId,
      status: sub.status,
      ...(sub.subStatus ? { subStatus: sub.subStatus } : {}),
      orderId: sub.orderId,
      subsPaymentInstDetails: { paymentMode: sub.mode },
      amountType: sub.amountType,
      maxAmount: sub.maxAmount,
      mid: MID,
      frequencyUnit: sub.frequencyUnit,
      frequency: '1',
      expiryDate: `${sub.expiry} 00:00:00`,
      createdDate: '2026-01-01 10:30:00',
      updatedDate: '2026-01-01 10:35:00',
      custId: sub.custId,
      upfrontTxnAmount: '0.00',
    });
  }

  private preNotify(body: Record<string, unknown>): Response {
    const sub = this.subscriptions.get(String(body.subsId));
    if (!sub) return service('FAILURE', '3004', 'Subscription Not Found');
    if (sub.status !== 'ACTIVE') return service('FAILURE', '400', 'Subscription is in paused/suspended state');
    const referenceId = String(body.referenceId);
    if (this.notifications.some((entry) => entry.referenceId === referenceId)) return service('FAILURE', '3049', 'Duplicate Reference Id');
    this.notifications.push({
      referenceId,
      subsId: sub.subsId,
      txnDate: String(body.txnDate),
      amount: String(body.txnAmount),
      at: this.nowMs(),
    });
    return service('SUCCESS', '3006', 'SUCCESS', { paytmReferenceId: `PTM${this.notifications.length}` });
  }

  private renew(url: URL, body: Record<string, unknown>): Response {
    const orderId = String(body.orderId);
    this.renewRequestIds.push(orderId);
    if (this.loseNextRenew === 'request') {
      this.loseNextRenew = undefined;
      throw new TypeError('fetch failed');
    }
    const lose = this.loseNextRenew === 'answer';
    this.loseNextRenew = undefined;
    const respond = (response: Response): Response => {
      if (lose) throw new TypeError('fetch failed');
      return response;
    };
    if (url.searchParams.get('orderId') !== orderId) return theia('F', '2014', 'OrderId in the query param doesn\'t match');
    const sub = this.subscriptions.get(String(body.subscriptionId));
    if (!sub || sub.status !== 'ACTIVE') return theia('F', '901', 'Subscription not available');
    if (this.debits.has(orderId)) return theia('F', '325', 'Duplicate Order Id');
    const amount = (body.txnAmount as { value: string }).value;
    if (Number(amount) > Number(sub.maxAmount)) return theia('F', '905', 'Invalid Transaction Amount');
    const notification = this.notifications.find((entry) => entry.referenceId === body.prenotifyReferenceId && entry.subsId === sub.subsId);
    if (sub.mode === 'UPI' && !notification) return theia('F', '3054', 'Prenotify not found for the given params');
    const tooSoon = notification !== undefined && this.nowMs() - notification.at < 24 * HOUR_MS;
    this.debits.set(orderId, {
      orderId,
      subsId: sub.subsId,
      amount,
      txnId: `TXN${this.debits.size + 1}`,
      status: tooSoon ? 'TXN_FAILURE' : 'PENDING',
      code: tooSoon ? '267' : '',
      message: tooSoon ? 'at least a 24 hours gap is not maintained between successful pre-notify and mandate execution' : '',
      createdAt: this.nowMs(),
    });
    return respond(theia('S', '900', 'Subscription Txn accepted.', { txnId: `TXN${this.debits.size}` }));
  }

  private orderStatus(body: Record<string, unknown>): Response {
    const orderId = String(body.orderId);
    this.statusLookups.push(orderId);
    const debit = this.debits.get(orderId);
    if (!debit || this.nowMs() < this.hideDebitsUntilMs) return theia('NO_RECORD_FOUND', '331', 'No Record Found');
    const common = {
      txnId: debit.txnId,
      bankTxnId: `BANK_${debit.txnId}`,
      orderId,
      txnAmount: debit.amount,
      mid: MID,
      paymentMode: this.paymentMode,
      subsId: debit.subsId,
      txnDate: '2026-01-15 10:00:00.0',
    };
    switch (debit.status) {
      case 'TXN_SUCCESS':
        return theia('TXN_SUCCESS', '01', 'Txn Success', common);
      case 'TXN_FAILURE':
        return theia('TXN_FAILURE', debit.code || '227', debit.message || 'Your payment has been declined by your bank.', common);
      default:
        return theia('PENDING', '400', 'Transaction status not confirmed yet.', common);
    }
  }

  private cancel(body: Record<string, unknown>): Response {
    const sub = this.subscriptions.get(String(body.subsId));
    if (!sub) return service('FAILURE', '3004', 'Subscription Not Found');
    const already = sub.status === 'REJECT';
    sub.status = 'REJECT';
    return service(already ? 'NO CONTENT FOUND' : 'SUCCESS', '200', already ? 'NO CONTENT FOUND' : 'SUCCESS');
  }

  private modify(body: Record<string, unknown>): Response {
    const sub = this.subscriptions.get(String(body.subsId));
    if (!sub) return service('FAILURE', '3004', 'Subscription Not Found');
    sub.status = String(body.status);
    return service('SUCCESS', '3006', 'SUCCESS');
  }

  // -------------------------------------------------------------------------
  // What the customer, the bank and Paytm do
  // -------------------------------------------------------------------------

  /** The customer authorises: the subscription becomes ACTIVE. Returns the callback Paytm posts to the merchant. */
  authorise(subscription: Pick<Subscription, 'id' | 'reference'>): Record<string, string> {
    const sub = this.subscriptions.get(subscription.id);
    if (!sub) throw new Error(`fake Paytm holds no subscription ${subscription.id}`);
    sub.status = 'ACTIVE';
    return signForm({
      MID,
      TXNID: `AUTH_${sub.subsId}`,
      ORDERID: sub.orderId,
      BANKTXNID: '6877266',
      TXNAMOUNT: '1.00',
      CURRENCY: 'INR',
      STATUS: 'TXN_SUCCESS',
      RESPCODE: '01',
      RESPMSG: 'Txn Success',
      TXNDATE: '2026-01-01 10:32:00.0',
      GATEWAYNAME: 'PPBLC',
      BANKNAME: 'HDFC Bank',
      PAYMENTMODE: this.paymentMode,
      SUBS_ID: sub.subsId,
    });
  }

  /** The bank ends a debit. */
  settle(orderId: string, outcome: typeof ChargeStatus.Succeeded | typeof ChargeStatus.Failed): void {
    const debit = this.debits.get(orderId);
    if (!debit) throw new Error(`fake Paytm holds no debit ${orderId}`);
    debit.status = outcome === ChargeStatus.Succeeded ? 'TXN_SUCCESS' : 'TXN_FAILURE';
    debit.code = outcome === ChargeStatus.Succeeded ? '01' : '227';
  }

  /** Paytm's Payment Status webhook for a debit, as a request. */
  paymentWebhook(orderId: string, outcome: typeof ChargeStatus.Succeeded | typeof ChargeStatus.Failed): WebhookRequest {
    const debit = this.debits.get(orderId);
    if (!debit) throw new Error(`fake Paytm holds no debit ${orderId}`);
    const success = outcome === ChargeStatus.Succeeded;
    return webhookRequest(
      formBody(
        signForm({
          ORDERID: orderId,
          MID,
          TXNID: debit.txnId,
          TXNAMOUNT: debit.amount,
          PAYMENTMODE: this.paymentMode,
          CURRENCY: 'INR',
          TXNDATE: '2026-01-15 10:00:00.0',
          STATUS: success ? 'TXN_SUCCESS' : 'TXN_FAILURE',
          RESPCODE: success ? '01' : '227',
          RESPMSG: success ? 'Txn Success' : 'Your payment has been declined by your bank.',
          GATEWAYNAME: 'PPBLC',
          BANKTXNID: `BANK_${debit.txnId}`,
        }),
      ),
    );
  }

  /** Paytm's Subscription Status webhook for a pause, resume or cancellation of the only subscription. */
  mandateWebhook(
    event: typeof EventType.SubscriptionPaused | typeof EventType.SubscriptionResumed | typeof EventType.SubscriptionCancelled,
  ): WebhookRequest {
    const sub = [...this.subscriptions.values()][0];
    if (!sub) throw new Error('fake Paytm holds no subscription');
    const status = event === EventType.SubscriptionPaused ? 'SUSPENDED' : event === EventType.SubscriptionResumed ? 'ACTIVE' : 'REJECT';
    return webhookRequest(
      formBody(
        signForm({
          ORDERID: sub.orderId,
          MID,
          SUBS_ID: sub.subsId,
          STATUS: status,
          ...(event === EventType.SubscriptionResumed ? { subStatus: 'RESUMED' } : {}),
          PAYMENTMODE: this.paymentMode,
          CUSTID: sub.custId,
          AMOUNTTYPE: sub.amountType,
          MAXAMOUNT: sub.maxAmount,
          FREQUENCYUNIT: sub.frequencyUnit,
          FREQUENCY: '1',
          UPDATEDDATE: `2026-01-${String(10 + this.requests.length).padStart(2, '0')} 09:00:00`,
        }),
      ),
    );
  }
}
