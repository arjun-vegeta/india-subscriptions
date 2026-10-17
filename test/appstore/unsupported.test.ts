import { describe, expect, it } from 'vitest';
import { ErrorCode } from '../../src/constants.js';
import { harness, rejection } from './helpers.js';

/** What the customer or the app does instead; the message must say so. */
const CASES: [string, (h: ReturnType<typeof harness>) => Promise<unknown>, string[]][] = [
  ['createPlan', (h) => h.provider.createPlan({ name: 'Pro', amount: 100, interval: { unit: 'month', count: 1 } }), ['App Store Connect']],
  ['getPlan', (h) => h.provider.getPlan('p'), ['App Store Connect']],
  ['cancelSubscription', (h) => h.provider.cancelSubscription('1'), ['Settings > Apple Account > Subscriptions', 'showManageSubscriptions', 'DID_CHANGE_RENEWAL_STATUS']],
  ['pauseSubscription', (h) => h.provider.pauseSubscription('1'), ['no pause', 'Subscriptions']],
  ['resumeSubscription', (h) => h.provider.resumeSubscription('1'), ['resubscribes', 'showManageSubscriptions']],
  ['updateSubscription', (h) => h.provider.updateSubscription('1', { planId: 'x' }), ['same subscription group', 'DID_CHANGE_RENEWAL_PREF']],
  ['refundCharge', (h) => h.provider.refundCharge({ chargeId: '1', refundId: 'r1' }), ['beginRefundRequest', 'REFUND', 'REFUND_DECLINED']],
  ['refundPayment', (h) => h.provider.refundPayment({ paymentId: '1', refundId: 'r1' }), ['beginRefundRequest', 'reportaproblem.apple.com']],
  ['createCharge', (h) => h.provider.createCharge({ subscriptionId: '1', chargeId: 'c1', amount: 100 }), ['merchant-raised']],
  ['notifyCharge', (h) => h.provider.notifyCharge({ subscriptionId: '1', notificationId: 'n1', amount: 100, debitAt: '2027-01-01T00:00:00Z' }), ['pre-debit']],
];

describe('what a store cannot do from the server', () => {
  it.each(CASES)('%s is UNSUPPORTED, with no call to Apple, and says what to do instead', async (_name, call, mentions) => {
    const h = harness();
    const error = await rejection(call(h));
    expect(error.code).toBe(ErrorCode.Unsupported);
    expect(error.message).toContain('app_store');
    for (const text of mentions) expect(error.message).toContain(text);
    expect(h.calls).toHaveLength(0);
  });

  it('every capability the adapter denies is one of these refusals', () => {
    const capabilities = harness().provider.capabilities;
    expect([capabilities.cancel, capabilities.pause, capabilities.resume, capabilities.changePlan, capabilities.refunds, capabilities.merchantCharges]).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});
