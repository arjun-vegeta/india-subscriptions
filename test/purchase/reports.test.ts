import { describe, expect, it } from 'vitest';
import { ChargeKind } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import {
  EXTERNAL_TRANSACTION_ID_PATTERN,
  Purchases,
  FlushOutcome,
  PurchaseIssue,
  ReportStatus,
  firstTransactionId,
  refundReportId,
  renewalTransactionId,
} from '../../src/purchase/index.js';
import {
  CUSTOMER,
  CUSTOMER_REF,
  DAY,
  ErrorCode,
  EventType,
  FakeReporter,
  HOUR,
  LIFETIME,
  MINUTE,
  MONTHLY,
  Outcome,
  Platform,
  Provider,
  SubscriptionStatus,
  TRIAL_MONTHLY,
  charge,
  event,
  harness,
  refundOf,
  result,
  type Harness,
} from './helpers.js';

interface Alternative {
  sessionId: string;
  /** The subscription or payment id at the gateway. */
  id: string;
  externalId: string;
}

/** An Android user choice purchase made through the alternative, completed. */
async function alternative(h: Harness, productKey = MONTHLY.key, options: { customerRef?: string; firstCharge?: boolean } = {}): Promise<Alternative> {
  const session = await h.purchases.start({
    platform: Platform.Android,
    product: productKey,
    customer: CUSTOMER,
    customerRef: options.customerRef ?? CUSTOMER_REF,
  });
  const chosen = await h.purchases.chooseAlternative(session.id, { externalTransactionToken: `tok_${session.id.slice(3, 9)}` });
  const gateway = chosen.options[1]!;
  if (productKey === MONTHLY.key && options.firstCharge !== false) {
    // The authorisation verified together with the first debit: a paid charge is in the evidence.
    h.host.verifiedCharge.set(gateway.handle, charge(Provider.Razorpay, 'pay_1', gateway.handle, 59_000));
  }
  await h.purchases.complete(session.id, { provider: gateway.provider, result: result(gateway.handle, Outcome.Paid) });
  return { sessionId: session.id, id: gateway.handle, externalId: firstTransactionId(session.id) };
}

describe('the first report', () => {
  it('is durable before complete returns, and carries the token, the split and the deadline', async () => {
    const h = harness();
    const session = await h.purchases.start({ platform: Platform.Android, product: MONTHLY.key, customer: CUSTOMER, customerRef: CUSTOMER_REF });
    const chosen = await h.purchases.chooseAlternative(session.id, { externalTransactionToken: 'tok_abc' });
    const gateway = chosen.options[1]!;
    h.host.verifiedCharge.set(gateway.handle, charge(Provider.Razorpay, 'pay_1', gateway.handle, 59_000));
    await h.purchases.complete(session.id, { provider: gateway.provider, result: result(gateway.handle) });

    const stored = await h.store.getReport(firstTransactionId(session.id));
    expect(stored).toBeDefined();
    expect(stored).toMatchObject({
      kind: 'transaction',
      status: ReportStatus.Queued,
      attempts: 0,
      sessionId: session.id,
      dueBy: h.clock.iso(24 * HOUR),
      transaction: {
        externalTransactionId: firstTransactionId(session.id),
        externalTransactionToken: 'tok_abc',
        productKind: 'subscription',
        // Rs 590 with 18% tax included: 500.00 + 90.00.
        amount: 50_000,
        taxAmount: 9_000,
        transactionTime: h.clock.iso(),
        state: 'Karnataka',
      },
    });
    expect(stored?.transaction).not.toHaveProperty('initialExternalTransactionId');
    expect(h.reporter.reports).toHaveLength(0);
  });

  it('is sent by flush, once', async () => {
    const h = harness();
    const a = await alternative(h);
    const first = await h.purchases.flush();
    expect(first).toMatchObject({ sent: 1, retrying: 0, blocked: 0, overdue: [] });
    expect(h.reporter.reports.map((r) => r.externalTransactionId)).toEqual([a.externalId]);
    const second = await h.purchases.flush();
    expect(second.entries).toEqual([]);
    expect(h.reporter.reports).toHaveLength(1);
    expect((await h.store.getReport(a.externalId))?.status).toBe(ReportStatus.Sent);
  });

  it('a free trial is reported with amount 0 and tax 0', async () => {
    const h = harness();
    const session = await h.purchases.start({ platform: Platform.Android, product: TRIAL_MONTHLY.key, customer: CUSTOMER, customerRef: CUSTOMER_REF });
    const chosen = await h.purchases.chooseAlternative(session.id, { externalTransactionToken: 'tok' });
    const gateway = chosen.options[1]!;
    h.host.setSubscription(gateway.handle, gateway.provider, { status: SubscriptionStatus.Trialing });
    await h.purchases.complete(session.id, { provider: gateway.provider, result: result(gateway.handle) });
    const stored = await h.store.getReport(firstTransactionId(session.id));
    expect(stored?.transaction).toMatchObject({ amount: 0, taxAmount: 0, externalTransactionToken: 'tok' });
  });

  it('a one-time purchase is reported with the amount the payment shows', async () => {
    const h = harness();
    const session = await h.purchases.start({ platform: Platform.Android, product: LIFETIME.key, customer: CUSTOMER, customerRef: CUSTOMER_REF });
    const chosen = await h.purchases.chooseAlternative(session.id, { externalTransactionToken: 'tok' });
    const gateway = chosen.options[1]!;
    h.host.setPayment(gateway.handle, gateway.provider, { amount: 100_001, paidAt: '2026-11-22T10:00:00.000Z' });
    await h.purchases.complete(session.id, { provider: gateway.provider, result: result(gateway.handle) });
    const stored = await h.store.getReport(firstTransactionId(session.id));
    expect(stored?.transaction).toMatchObject({ productKind: 'one_time', transactionTime: '2026-11-22T10:00:00.000Z' });
    expect(stored!.transaction!.amount + stored!.transaction!.taxAmount).toBe(100_001);
    expect(stored?.dueBy).toBe('2026-11-23T10:00:00.000Z');
  });

  it('is not queued for a purchase made in Google Play, a store purchase, or a gateway purchase on the web', async () => {
    const h = harness();
    const play = await h.purchases.start({ platform: Platform.Android, product: MONTHLY.key, customer: CUSTOMER, customerRef: 'a' });
    await h.purchases.complete(play.id, { provider: Provider.GooglePlay, result: result(play.options[0]!.handle) });
    const ios = await h.purchases.start({ platform: Platform.Ios, product: MONTHLY.key, customer: CUSTOMER, customerRef: 'b' });
    await h.purchases.complete(ios.id, { provider: Provider.AppStore, result: result(ios.options[0]!.handle) });
    const web = await h.purchases.start({ platform: Platform.Web, product: MONTHLY.key, customer: CUSTOMER, customerRef: 'c' });
    await h.purchases.complete(web.id, { provider: web.options[0]!.provider, result: result(web.options[0]!.handle) });
    expect(await h.store.claimDueReports(h.clock.iso(), 10, MINUTE)).toEqual([]);
  });

  it('a failed attempt at the gateway queues nothing', async () => {
    const h = harness();
    const session = await h.purchases.start({ platform: Platform.Android, product: LIFETIME.key, customer: CUSTOMER, customerRef: CUSTOMER_REF });
    const chosen = await h.purchases.chooseAlternative(session.id, { externalTransactionToken: 'tok' });
    const gateway = chosen.options[1]!;
    await h.purchases.complete(session.id, { provider: gateway.provider, result: result(gateway.handle, Outcome.Failed) });
    expect(await h.store.getReport(firstTransactionId(session.id))).toBeUndefined();
  });
});

describe('the first report when a webhook completes the session', () => {
  it('a charge event for a customer who never came back queues the first report from the charge, and the next charge is a renewal', async () => {
    const h = harness();
    const session = await h.purchases.start({ platform: Platform.Android, product: MONTHLY.key, customer: CUSTOMER, customerRef: CUSTOMER_REF });
    const chosen = await h.purchases.chooseAlternative(session.id, { externalTransactionToken: 'tok' });
    const id = chosen.options[1]!.handle;
    await h.purchases.handleEvents([
      event(Provider.Razorpay, EventType.SubscriptionCharged, {
        subscriptionId: id,
        charge: charge(Provider.Razorpay, 'pay_1', id, 59_000, { paidAt: '2026-11-22T10:00:00.000Z' }),
      }),
    ]);
    const first = await h.store.getReport(firstTransactionId(session.id));
    expect(first?.transaction).toMatchObject({
      externalTransactionToken: 'tok',
      amount: 50_000,
      taxAmount: 9_000,
      transactionTime: '2026-11-22T10:00:00.000Z',
    });
    expect((await h.purchases.get(session.id)).status).toBe('completed');
    await h.purchases.handleEvents([
      event(Provider.Razorpay, EventType.SubscriptionCharged, { subscriptionId: id, charge: charge(Provider.Razorpay, 'pay_2', id, 59_000) }),
    ]);
    expect(await h.store.getReport(renewalTransactionId(session.id, 'pay_2'))).toBeDefined();
    expect(await h.store.getReport(renewalTransactionId(session.id, 'pay_1'))).toBeUndefined();
  });

  it('a purchase whose session lost the customer state is granted, and the missing report is raised to onIssue', async () => {
    const h = harness();
    const session = await h.purchases.start({ platform: Platform.Android, product: MONTHLY.key, customer: CUSTOMER, customerRef: CUSTOMER_REF });
    const chosen = await h.purchases.chooseAlternative(session.id, { externalTransactionToken: 'tok' });
    const stored = (await h.store.getSession(session.id))!;
    await h.store.saveSession({ ...stored, customer: { name: 'No state' } });
    const gateway = chosen.options[1]!;
    await h.purchases.complete(session.id, { provider: gateway.provider, result: result(gateway.handle) });
    expect((await h.purchases.entitlements(CUSTOMER_REF)).active).toBe(true);
    expect(h.issues.map((i) => i.issue)).toEqual([PurchaseIssue.ReportNotQueued]);
  });
});

describe('renewals', () => {
  it('an authorisation with no paid charge is reported as 0, and every successful charge after it is a renewal with its real amount', async () => {
    const h = harness();
    const a = await alternative(h, MONTHLY.key, { firstCharge: false });
    const first = await h.store.getReport(a.externalId);
    expect(first?.transaction).toMatchObject({ amount: 0, taxAmount: 0 });

    await h.purchases.handleEvents([
      event(Provider.Razorpay, EventType.SubscriptionCharged, {
        subscriptionId: a.id,
        charge: charge(Provider.Razorpay, 'pay_1', a.id, 59_000, { paidAt: h.clock.iso() }),
      }),
    ]);
    const renewalId = renewalTransactionId(a.sessionId, 'pay_1');
    const renewal = await h.store.getReport(renewalId);
    expect(renewal).toMatchObject({
      kind: 'transaction',
      dependsOn: a.externalId,
      dueBy: h.clock.iso(24 * HOUR),
      transaction: {
        externalTransactionId: renewalId,
        initialExternalTransactionId: a.externalId,
        productKind: 'subscription',
        amount: 50_000,
        taxAmount: 9_000,
        state: 'Karnataka',
      },
    });
    expect(renewal?.transaction).not.toHaveProperty('externalTransactionToken');

    // The same event again, and the next cycles, one renewal each.
    const again = event(Provider.Razorpay, EventType.SubscriptionCharged, { subscriptionId: a.id, charge: charge(Provider.Razorpay, 'pay_2', a.id, 59_000) });
    h.clock.advance(30 * DAY);
    await h.purchases.handleEvents([again, again]);

    await h.purchases.flush();
    await h.purchases.flush();
    const sent = h.reporter.reports.map((r) => r.externalTransactionId);
    expect(sent).toEqual([a.externalId, renewalId, renewalTransactionId(a.sessionId, 'pay_2')]);
  });

  it('a first charge the evidence already shows is in the first report: arriving again as an event it is not a renewal', async () => {
    const h = harness();
    const a = await alternative(h);
    expect((await h.store.getReport(a.externalId))?.transaction).toMatchObject({ amount: 50_000, taxAmount: 9_000 });
    const arrived = event(Provider.Razorpay, EventType.SubscriptionCharged, { subscriptionId: a.id, charge: charge(Provider.Razorpay, 'pay_1', a.id, 59_000) });
    await h.purchases.handleEvents([arrived, arrived]);
    expect(await h.store.getReport(renewalTransactionId(a.sessionId, 'pay_1'))).toBeUndefined();
    expect(await h.store.claimDueReports(h.clock.iso(), 10, MINUTE)).toHaveLength(1);

    h.clock.advance(30 * DAY);
    await h.purchases.handleEvents([
      event(Provider.Razorpay, EventType.SubscriptionCharged, { subscriptionId: a.id, charge: charge(Provider.Razorpay, 'pay_2', a.id, 59_000) }),
    ]);
    expect(await h.store.getReport(renewalTransactionId(a.sessionId, 'pay_2'))).toBeDefined();
  });

  it('a first debit that fails queues no further report', async () => {
    const h = harness();
    const a = await alternative(h, MONTHLY.key, { firstCharge: false });
    await h.purchases.handleEvents([event(Provider.Razorpay, EventType.SubscriptionChargeFailed, { subscriptionId: a.id })]);
    await h.purchases.handleEvents([
      event(Provider.Razorpay, EventType.SubscriptionCharged, {
        subscriptionId: a.id,
        charge: charge(Provider.Razorpay, 'pay_x', a.id, 59_000, { status: 'failed' }),
      }),
    ]);
    const claimed = await h.store.claimDueReports(h.clock.iso(), 10, MINUTE);
    expect(claimed.map((r) => r.id)).toEqual([a.externalId]);
    expect(claimed[0]?.transaction).toMatchObject({ amount: 0, taxAmount: 0 });
  });

  it('after a free trial the first charge is already a renewal', async () => {
    const h = harness();
    const session = await h.purchases.start({ platform: Platform.Android, product: TRIAL_MONTHLY.key, customer: CUSTOMER, customerRef: CUSTOMER_REF });
    const chosen = await h.purchases.chooseAlternative(session.id, { externalTransactionToken: 'tok' });
    const gateway = chosen.options[1]!;
    h.host.setSubscription(gateway.handle, gateway.provider, { status: SubscriptionStatus.Trialing });
    await h.purchases.complete(session.id, { provider: gateway.provider, result: result(gateway.handle) });
    h.clock.advance(7 * DAY);
    await h.purchases.handleEvents([
      event(Provider.Razorpay, EventType.SubscriptionCharged, { subscriptionId: gateway.handle, charge: charge(Provider.Razorpay, 'pay_1', gateway.handle, 59_000) }),
    ]);
    const renewal = await h.store.getReport(renewalTransactionId(session.id, 'pay_1'));
    expect(renewal?.transaction).toMatchObject({ initialExternalTransactionId: firstTransactionId(session.id), amount: 50_000, taxAmount: 9_000 });
  });

  it('a first charge the verification already showed is not a renewal', async () => {
    const h = harness();
    const session = await h.purchases.start({ platform: Platform.Android, product: MONTHLY.key, customer: CUSTOMER, customerRef: CUSTOMER_REF });
    const chosen = await h.purchases.chooseAlternative(session.id, { externalTransactionToken: 'tok' });
    const gateway = chosen.options[1]!;
    h.host.verifiedCharge.set(gateway.handle, charge(Provider.Razorpay, 'pay_1', gateway.handle, 59_000, { paidAt: '2026-11-22T10:00:00.000Z' }));
    await h.purchases.complete(session.id, { provider: gateway.provider, result: result(gateway.handle) });
    const first = await h.store.getReport(firstTransactionId(session.id));
    expect(first?.transaction?.transactionTime).toBe('2026-11-22T10:00:00.000Z');
    await h.purchases.handleEvents([
      event(Provider.Razorpay, EventType.SubscriptionCharged, { subscriptionId: gateway.handle, charge: charge(Provider.Razorpay, 'pay_1', gateway.handle, 59_000) }),
    ]);
    expect(await h.store.getReport(renewalTransactionId(session.id, 'pay_1'))).toBeUndefined();
    await h.purchases.handleEvents([
      event(Provider.Razorpay, EventType.SubscriptionCharged, { subscriptionId: gateway.handle, charge: charge(Provider.Razorpay, 'pay_2', gateway.handle, 59_000) }),
    ]);
    expect(await h.store.getReport(renewalTransactionId(session.id, 'pay_2'))).toBeDefined();
  });

  it('a small authorisation charge is not reported as a renewal', async () => {
    const h = harness();
    const a = await alternative(h, MONTHLY.key, { firstCharge: false });
    await h.purchases.handleEvents([
      event(Provider.Razorpay, EventType.SubscriptionCharged, {
        subscriptionId: a.id,
        charge: charge(Provider.Razorpay, 'pay_auth', a.id, 500, { kind: ChargeKind.Authorization }),
      }),
    ]);
    expect(await h.store.getReport(renewalTransactionId(a.sessionId, 'pay_auth'))).toBeUndefined();
    await h.purchases.handleEvents([
      event(Provider.Razorpay, EventType.SubscriptionCharged, { subscriptionId: a.id, charge: charge(Provider.Razorpay, 'pay_1', a.id, 59_000) }),
    ]);
    expect(await h.store.getReport(renewalTransactionId(a.sessionId, 'pay_1'))).toBeDefined();
  });

  it('a purchase that was not made through the alternative queues no renewal', async () => {
    const h = harness();
    const session = await h.purchases.start({ platform: Platform.Web, product: MONTHLY.key, customer: CUSTOMER, customerRef: CUSTOMER_REF });
    const id = session.options[0]!.handle;
    await h.purchases.complete(session.id, { provider: Provider.Razorpay, result: result(id) });
    h.clock.advance(30 * DAY);
    await h.purchases.handleEvents([
      event(Provider.Razorpay, EventType.SubscriptionCharged, { subscriptionId: id, charge: charge(Provider.Razorpay, 'pay_2', id, 59_000) }),
    ]);
    expect(await h.store.claimDueReports(h.clock.iso(), 10, MINUTE)).toEqual([]);
  });
});

describe('refund reports', () => {
  async function withFirstCharge(h: Harness) {
    const a = await alternative(h);
    await h.purchases.handleEvents([
      event(Provider.Razorpay, EventType.SubscriptionCharged, { subscriptionId: a.id, charge: charge(Provider.Razorpay, 'pay_1', a.id, 59_000) }),
    ]);
    return a;
  }

  it('a full refund names the first transaction and omits the amounts', async () => {
    const h = harness();
    const a = await withFirstCharge(h);
    h.clock.advance(2 * DAY);
    await h.purchases.handleEvents([
      event(Provider.Razorpay, EventType.RefundSucceeded, {
        subscriptionId: a.id,
        refund: refundOf(Provider.Razorpay, 'rf_1', 'pay_1', 59_000, { subscriptionId: a.id }),
      }),
    ]);
    const stored = await h.store.getReport(refundReportId(a.sessionId, 'rf_1'));
    expect(stored).toMatchObject({
      kind: 'refund',
      dependsOn: a.externalId,
      refund: { externalTransactionId: a.externalId, refundTime: h.clock.iso() },
    });
    expect(stored?.refund).not.toHaveProperty('amount');
    expect(stored?.refund).not.toHaveProperty('taxAmount');
  });

  it('a partial refund is split in the proportions of the transaction and sums to the refund', async () => {
    const h = harness();
    const a = await withFirstCharge(h);
    await h.purchases.handleEvents([
      event(Provider.Razorpay, EventType.RefundSucceeded, {
        subscriptionId: a.id,
        refund: refundOf(Provider.Razorpay, 'rf_1', 'pay_1', 11_800, { subscriptionId: a.id }),
      }),
    ]);
    const stored = await h.store.getReport(refundReportId(a.sessionId, 'rf_1'));
    expect(stored?.refund).toMatchObject({ amount: 10_000, taxAmount: 1_800 });
    await h.purchases.handleEvents([
      event(Provider.Razorpay, EventType.RefundSucceeded, {
        subscriptionId: a.id,
        refund: refundOf(Provider.Razorpay, 'rf_2', 'pay_1', 12_345, { subscriptionId: a.id }),
      }),
    ]);
    const odd = (await h.store.getReport(refundReportId(a.sessionId, 'rf_2')))!.refund!;
    expect(odd.amount! + odd.taxAmount!).toBe(12_345);
  });

  it('a refund of a renewal names that renewal\'s id', async () => {
    const h = harness();
    const a = await withFirstCharge(h);
    h.clock.advance(30 * DAY);
    await h.purchases.handleEvents([
      event(Provider.Razorpay, EventType.SubscriptionCharged, { subscriptionId: a.id, charge: charge(Provider.Razorpay, 'pay_2', a.id, 59_000) }),
      event(Provider.Razorpay, EventType.RefundSucceeded, {
        subscriptionId: a.id,
        refund: refundOf(Provider.Razorpay, 'rf_9', 'pay_2', 59_000, { subscriptionId: a.id }),
      }),
    ]);
    const stored = await h.store.getReport(refundReportId(a.sessionId, 'rf_9'));
    expect(stored?.refund?.externalTransactionId).toBe(renewalTransactionId(a.sessionId, 'pay_2'));
    expect(stored?.dependsOn).toBe(renewalTransactionId(a.sessionId, 'pay_2'));
  });

  it('a refund of a one-time purchase refers to its first transaction', async () => {
    const h = harness();
    const a = await alternative(h, LIFETIME.key);
    await h.purchases.handleEvents([
      event(Provider.Razorpay, EventType.RefundSucceeded, {
        paymentId: a.id,
        refund: refundOf(Provider.Razorpay, 'rf_1', a.id, LIFETIME.amount, { paymentId: a.id }),
      }),
    ]);
    const stored = await h.store.getReport(refundReportId(a.sessionId, 'rf_1'));
    expect(stored?.refund).toMatchObject({ externalTransactionId: a.externalId });
  });

  it('a repeated refund event queues one report', async () => {
    const h = harness();
    const a = await withFirstCharge(h);
    const refund = event(Provider.Razorpay, EventType.RefundSucceeded, {
      subscriptionId: a.id,
      refund: refundOf(Provider.Razorpay, 'rf_1', 'pay_1', 59_000, { subscriptionId: a.id }),
    });
    await h.purchases.handleEvents([refund, refund]);
    await h.purchases.flush();
    await h.purchases.flush();
    expect(h.reporter.refunds).toHaveLength(1);
  });

  it('a refund that matches no transaction we reported is raised to onIssue, not reported', async () => {
    const h = harness();
    const a = await withFirstCharge(h);
    await h.purchases.handleEvents([
      event(Provider.Razorpay, EventType.RefundSucceeded, {
        subscriptionId: a.id,
        refund: refundOf(Provider.Razorpay, 'rf_1', 'pay_unknown', 100, { subscriptionId: a.id }),
      }),
    ]);
    expect(h.issues.map((i) => i.issue)).toEqual([PurchaseIssue.UnmatchedRefund]);
    expect(await h.store.getReport(refundReportId(a.sessionId, 'rf_1'))).toBeUndefined();
  });

  it('a refund waits until the transaction it refers to has been sent', async () => {
    const h = harness();
    const a = await withFirstCharge(h);
    await h.purchases.handleEvents([
      event(Provider.Razorpay, EventType.RefundSucceeded, {
        subscriptionId: a.id,
        refund: refundOf(Provider.Razorpay, 'rf_1', 'pay_1', 59_000, { subscriptionId: a.id }),
      }),
    ]);
    h.reporter.down = new SubscriptionError(ErrorCode.ProviderUnavailable, 'down');
    const down = await h.purchases.flush();
    expect(down.retrying).toBe(1);
    expect(down.blocked).toBe(1);
    expect(h.reporter.refunds).toHaveLength(0);

    h.reporter.down = undefined;
    h.clock.advance(MINUTE);
    const up = await h.purchases.flush();
    expect(up.sent).toBe(2);
    expect(h.reporter.reports).toHaveLength(1);
    expect(h.reporter.refunds).toHaveLength(1);
  });
});

describe('flush', () => {
  it('retries a failure with a growing backoff and never sends twice after a success', async () => {
    const h = harness({ purchases: { retry: { baseMs: MINUTE, maxMs: 5 * MINUTE } } });
    const a = await alternative(h);
    h.reporter.failNext(ErrorCode.ProviderUnavailable, 3);

    const one = await h.purchases.flush();
    expect(one).toMatchObject({ sent: 0, retrying: 1 });
    expect(one.entries[0]).toMatchObject({ outcome: FlushOutcome.Retrying, attempts: 1, errorCode: ErrorCode.ProviderUnavailable });
    expect((await h.store.getReport(a.externalId))?.nextAttemptAt).toBe(h.clock.iso(MINUTE));

    // Not due yet: nothing is claimed.
    expect((await h.purchases.flush()).entries).toEqual([]);

    h.clock.advance(MINUTE);
    await h.purchases.flush();
    expect((await h.store.getReport(a.externalId))?.nextAttemptAt).toBe(h.clock.iso(2 * MINUTE));

    h.clock.advance(2 * MINUTE);
    await h.purchases.flush();
    expect((await h.store.getReport(a.externalId))?.nextAttemptAt).toBe(h.clock.iso(4 * MINUTE));

    h.clock.advance(4 * MINUTE);
    const done = await h.purchases.flush();
    expect(done).toMatchObject({ sent: 1 });
    expect(h.reporter.reports).toHaveLength(1);
    expect((await h.store.getReport(a.externalId))).toMatchObject({ status: ReportStatus.Sent, attempts: 4, sentAt: h.clock.iso() });
    expect((await h.store.getReport(a.externalId))?.lastError).toBeUndefined();

    h.clock.advance(HOUR);
    await h.purchases.flush();
    expect(h.reporter.reports).toHaveLength(1);
  });

  it('the backoff is capped', async () => {
    const h = harness({ purchases: { retry: { baseMs: MINUTE, maxMs: 3 * MINUTE } } });
    const a = await alternative(h);
    h.reporter.down = new SubscriptionError(ErrorCode.Network, 'down');
    for (let i = 0; i < 6; i += 1) {
      await h.purchases.flush();
      h.clock.advance(3 * MINUTE);
    }
    const stored = await h.store.getReport(a.externalId);
    expect(Date.parse(stored!.nextAttemptAt) - Date.parse(stored!.lastAttemptAt!)).toBe(3 * MINUTE);
  });

  it.each([ErrorCode.ProviderUnavailable, ErrorCode.RateLimited, ErrorCode.Network, ErrorCode.Timeout, ErrorCode.OutcomeUnknown, ErrorCode.Auth])(
    '%s from the reporter leaves the report queued',
    async (code) => {
      const h = harness();
      const a = await alternative(h);
      h.reporter.failNext(code);
      const flushed = await h.purchases.flush();
      expect(flushed.retrying).toBe(1);
      expect((await h.store.getReport(a.externalId))).toMatchObject({ status: ReportStatus.Queued, lastError: { code } });
    },
  );

  it('a report Google refuses as invalid is rejected and never retried', async () => {
    const h = harness();
    const a = await alternative(h);
    h.reporter.failNext(ErrorCode.Validation);
    const flushed = await h.purchases.flush();
    expect(flushed).toMatchObject({ rejected: 1, retrying: 0 });
    h.clock.advance(DAY);
    expect((await h.purchases.flush()).entries).toEqual([]);
    expect((await h.store.getReport(a.externalId))?.status).toBe(ReportStatus.Rejected);
    expect(h.reporter.reports).toHaveLength(0);
  });

  it('without a reporter nothing is sent and every report stays queued', async () => {
    const h = harness();
    const a = await alternative(h);
    const bare = new Purchases({ host: h.host, router: h.router, catalog: [MONTHLY], policy: {}, store: h.store, now: h.clock.now });
    const flushed = await bare.flush();
    expect(flushed).toMatchObject({ sent: 0, skipped: 1 });
    expect((await h.store.getReport(a.externalId))?.status).toBe(ReportStatus.Queued);
    // ... and a flush with the reporter finds it at once.
    expect((await h.purchases.flush()).sent).toBe(1);
  });

  it('flags a report past its 24-hour deadline, whether or not this flush tried it', async () => {
    const h = harness();
    const a = await alternative(h);
    const dueBy = h.clock.iso(24 * HOUR);
    h.reporter.down = new SubscriptionError(ErrorCode.ProviderUnavailable, 'down');
    expect((await h.purchases.flush()).overdue).toEqual([]);

    // Exactly at the deadline it is not late yet.
    h.clock.advance(24 * HOUR);
    expect((await h.purchases.flush()).overdue).toEqual([]);

    h.clock.advance(2 * MINUTE);
    const tried = await h.purchases.flush();
    expect(tried.overdue).toHaveLength(1);
    expect(tried.overdue[0]).toMatchObject({ id: a.externalId, overdue: true, dueBy, outcome: FlushOutcome.Retrying });

    // The next flush finds the report in its backoff and does not try it, but still lists it.
    const idle = await h.purchases.flush();
    expect(idle.entries).toEqual([]);
    expect(idle.overdue).toHaveLength(1);
    expect(idle.overdue[0]).toMatchObject({ id: a.externalId, overdue: true, errorCode: ErrorCode.ProviderUnavailable });
    expect(idle.overdue[0]?.outcome).toBeUndefined();
  });

  it('marks a report sent after its deadline as overdue in the entry', async () => {
    const h = harness();
    const a = await alternative(h);
    h.clock.advance(25 * HOUR);
    const flushed = await h.purchases.flush();
    expect(flushed.entries[0]).toMatchObject({ id: a.externalId, outcome: FlushOutcome.Sent, overdue: true });
    expect(flushed.overdue).toEqual([]);
  });

  it('two flushes at once send a report once (the claim is a lease)', async () => {
    const h = harness();
    await alternative(h);
    const [a, b] = await Promise.all([h.purchases.flush(), h.purchases.flush()]);
    expect(a.sent + b.sent).toBe(1);
    expect(h.reporter.reports).toHaveLength(1);
  });

  it('a lease that ran out lets another flush take the report', async () => {
    const h = harness({ purchases: { reportLeaseMs: 5 * MINUTE } });
    const a = await alternative(h);
    const claimed = await h.store.claimDueReports(h.clock.iso(), 10, 5 * MINUTE);
    expect(claimed).toHaveLength(1);
    expect((await h.purchases.flush()).entries).toEqual([]);
    h.clock.advance(5 * MINUTE);
    expect((await h.purchases.flush()).sent).toBe(1);
    // The first claimer's late save is refused: it no longer owns the report.
    expect(await h.store.saveReport({ ...claimed[0]!, status: ReportStatus.Sent }, claimed[0]!.leaseToken as string)).toBe(false);
    expect((await h.store.getReport(a.externalId))?.attempts).toBe(1);
  });

  it('sends at most `limit` reports, the most urgent first', async () => {
    const h = harness();
    const first = await alternative(h, MONTHLY.key, { customerRef: 'one' });
    h.clock.advance(HOUR);
    const second = await alternative(h, LIFETIME.key, { customerRef: 'two' });
    const flushed = await h.purchases.flush({ limit: 1 });
    expect(flushed.sent).toBe(1);
    expect(h.reporter.reports[0]?.externalTransactionId).toBe(first.externalId);
    await h.purchases.flush();
    expect(h.reporter.reports.map((r) => r.externalTransactionId)).toEqual([first.externalId, second.externalId]);
  });

  it('every external transaction id fits Google\'s rule and is unique per report', async () => {
    const h = harness();
    const a = await alternative(h);
    const ids = [
      a.externalId,
      renewalTransactionId(a.sessionId, 'pay_2'),
      renewalTransactionId(a.sessionId, 'pay_3'),
      refundReportId(a.sessionId, 'rf_1'),
      renewalTransactionId(a.sessionId, 'x'.repeat(200)),
    ];
    for (const id of ids) expect(id).toMatch(EXTERNAL_TRANSACTION_ID_PATTERN);
    expect(new Set(ids).size).toBe(ids.length);
    // The session id is a capability: it is not part of anything sent to Google.
    for (const id of ids) expect(id).not.toContain(a.sessionId.slice(3, 15));
  });

  it('rejects an invalid limit', async () => {
    const h = harness();
    await expect(h.purchases.flush({ limit: 0 })).rejects.toMatchObject({ code: ErrorCode.Validation });
  });
});

describe('a reporter fake that nobody configured', () => {
  it('user choice without a reporter is a configuration error at construction', async () => {
    expect(() => harness({ reporter: null })).toThrowError(/reporter/);
  });
  it('is a FakeReporter by default', () => {
    expect(new FakeReporter().reports).toEqual([]);
  });
});
