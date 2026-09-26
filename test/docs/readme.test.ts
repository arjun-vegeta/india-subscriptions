/**
 * Keeps the README honest: these are the README's code samples, run against
 * the real public entry point with a scripted fetch.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CancelMode,
  CheckoutKind,
  Environment,
  EventType,
  IntervalUnit,
  MemorySchedulerStore,
  Provider,
  SchedulingMode,
  SubscriptionStatus,
  createSubscriptions,
  payu,
  razorpay,
} from '../../src/index.js';
import { HttpMethod } from '../../src/constants.js';
import { mockFetch } from '../helpers/mock-fetch.js';

const KEY_SECRET = 'test_key_secret';
const WEBHOOK_SECRET = 'test_webhook_secret';
const NOW = new Date('2026-11-17T06:30:00.000Z');

// Shapes follow Razorpay's "Create a Plan" and "Create a Subscription" samples.
const PLAN = {
  id: 'plan_00000000000001',
  entity: 'plan',
  interval: 1,
  period: 'monthly',
  item: {
    id: 'item_00000000000001',
    active: true,
    name: 'Pro monthly',
    description: null,
    amount: 49900,
    unit_amount: 49900,
    currency: 'INR',
    type: 'plan',
    created_at: 1580219935,
    updated_at: 1580219935,
  },
  notes: {},
  created_at: 1580219935,
};
const SUBSCRIPTION = {
  id: 'sub_00000000000001',
  entity: 'subscription',
  plan_id: PLAN.id,
  status: 'created',
  current_start: null,
  current_end: null,
  ended_at: null,
  quantity: 1,
  notes: { reference: 'order_1042' },
  charge_at: 1580453311,
  start_at: 1580626111,
  end_at: 1583433000,
  auth_attempts: 0,
  total_count: 120,
  paid_count: 0,
  customer_notify: true,
  created_at: 1580280581,
  expire_by: null,
  short_url: 'https://rzp.io/i/z3b1R61A9',
  has_scheduled_changes: false,
  change_scheduled_at: null,
  source: 'api',
  remaining_count: 120,
};

describe('README quick start (Razorpay)', () => {
  it('creates a monthly subscription with a 14-day trial, verifies checkout and handles a webhook', async () => {
    const { fetch, calls } = mockFetch([
      { method: HttpMethod.Post, url: 'https://api.razorpay.com/v1/plans', json: PLAN },
      { method: HttpMethod.Post, url: 'https://api.razorpay.com/v1/subscriptions', json: SUBSCRIPTION },
    ]);
    const subs = createSubscriptions({
      providers: [
        razorpay(
          { keyId: 'rzp_test_key', keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET },
          { fetch, now: () => NOW },
        ),
      ],
    });

    const subscription = await subs.create(Provider.Razorpay, {
      reference: 'order_1042',
      plan: { name: 'Pro monthly', amount: 49900, interval: { unit: IntervalUnit.Month, count: 1 } },
      customer: { name: 'Asha Rao', email: 'asha@example.com', phone: '9876543210' },
      trial: { days: 14 },
    });

    expect(subscription.status).toBe(SubscriptionStatus.Created);
    expect(subscription.scheduling).toBe(SchedulingMode.Gateway);
    expect(subscription.checkout?.kind).toBe(CheckoutKind.RazorpayCheckout);
    const sent = calls[1]?.json as { plan_id: string; start_at: number; total_count: number };
    expect(sent.plan_id).toBe(PLAN.id);
    // The first charge is exactly 14 days after "now".
    expect(sent.start_at).toBe(Math.floor(NOW.getTime() / 1000) + 14 * 24 * 60 * 60);
    expect(sent.total_count).toBeGreaterThan(0);

    const paymentId = 'pay_00000000000001';
    const signature = createHmac('sha256', KEY_SECRET).update(`${paymentId}|${subscription.id}`).digest('hex');
    const verification = await subs.verifyCheckout(
      Provider.Razorpay,
      { razorpay_payment_id: paymentId, razorpay_subscription_id: subscription.id, razorpay_signature: signature },
      { expectedSubscriptionId: subscription.id },
    );
    expect(verification.authorized).toBe(true);
    expect(verification.subscriptionId).toBe(subscription.id);

    // A genuine result presented for a different subscription is refused.
    await expect(
      subs.verifyCheckout(
        Provider.Razorpay,
        { razorpay_payment_id: paymentId, razorpay_subscription_id: subscription.id, razorpay_signature: signature },
        { expectedSubscriptionId: 'sub_someone_elses' },
      ),
    ).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });

    const rawBody = JSON.stringify({
      entity: 'event',
      account_id: 'acc_00000000000001',
      event: 'subscription.charged',
      contains: ['subscription', 'payment'],
      payload: {
        subscription: { entity: { ...SUBSCRIPTION, status: 'active', paid_count: 1, remaining_count: 119 } },
        payment: {
          entity: {
            id: paymentId,
            entity: 'payment',
            amount: 49900,
            currency: 'INR',
            status: 'captured',
            method: 'upi',
            created_at: 1580280581,
          },
        },
      },
      created_at: 1580280600,
    });
    const events = await subs.webhooks.handle(Provider.Razorpay, {
      rawBody,
      headers: {
        'x-razorpay-signature': createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex'),
        'x-razorpay-event-id': 'evt_00000000000001',
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe(EventType.SubscriptionCharged);
    expect(events[0]?.id).toBe('evt_00000000000001');
    expect(events[0]?.charge?.amount).toBe(49900);
  });

  it('exposes the capability matrix the README prints', () => {
    const subs = createSubscriptions({
      providers: [razorpay({ keyId: 'rzp_test_key', keySecret: KEY_SECRET })],
    });
    const capabilities = subs.capabilities(Provider.Razorpay);
    expect(capabilities.cancelAtPeriodEnd).toBe(true);
    expect(capabilities.scheduling).toEqual([SchedulingMode.Gateway]);
    expect(CancelMode.AtPeriodEnd).toBe('at_period_end');
  });
});

describe('README merchant-scheduled example (PayU)', () => {
  it('builds its own scheduler from a store and ticks without doing anything before authorisation', async () => {
    const { fetch, calls } = mockFetch([]);
    const subs = createSubscriptions({
      providers: [
        payu(
          {
            key: 'test_key',
            salt: 'test_salt',
            environment: Environment.Test,
            successUrl: 'https://example.com/payu/success',
            failureUrl: 'https://example.com/payu/failure',
          },
          { fetch, now: () => NOW },
        ),
      ],
      scheduler: { store: new MemorySchedulerStore() },
    });

    const subscription = await subs.create(Provider.PayU, {
      reference: 'order_2001',
      plan: { name: 'Pro monthly', amount: 49900, interval: { unit: IntervalUnit.Month, count: 1 } },
      customer: { name: 'Asha Rao', email: 'asha@example.com', phone: '9876543210' },
      trial: { days: 14 },
    });
    expect(subscription.scheduling).toBe(SchedulingMode.Merchant);
    expect(subscription.checkout?.kind).toBe(CheckoutKind.FormPost);
    // The salt must never be handed to the browser.
    expect(JSON.stringify(subscription.checkout)).not.toContain('test_salt');

    const result = await subs.tick();
    expect(result.errors).toEqual([]);
    // Nothing is notified or charged before the customer authorises.
    expect(calls).toHaveLength(0);
  });
});
