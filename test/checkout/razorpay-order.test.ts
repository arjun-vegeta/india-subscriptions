import { beforeEach, describe, expect, it } from 'vitest';
import { CheckoutOutcomeSchema, openCheckout, openRazorpayCheckout, type CheckoutInstruction } from '../../src/checkout/index.js';
import { CheckoutKind } from '../../src/constants.js';
import { RazorpayCheckoutSchema } from '../../src/schemas.js';
import { FakeRazorpay, createFakeBrowser } from './helpers.js';

/*
 * Standard Checkout opened with an order (one-time payments). The option names
 * are those of the Standard Checkout integration page (razorpay.com/docs/payments/
 * payment-gateway/web-integration/standard/integration-steps, "Checkout
 * Options"): key, amount, currency, order_id, name, description, image,
 * prefill, notes, theme, callback_url or handler. Literal names are used on
 * purpose: these tests pin the wire contract independently of the helper's
 * constants.
 */

const RAZORPAY_SCRIPT = 'https://checkout.razorpay.com/v1/checkout.js';

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 0));
  expect(condition()).toBe(true);
}

function razorpayBrowser() {
  return createFakeBrowser({
    onScriptLoad: (url, win) => {
      if (url === RAZORPAY_SCRIPT) win['Razorpay'] = FakeRazorpay;
    },
  });
}

describe('razorpay_checkout with an order', () => {
  const instruction: CheckoutInstruction = {
    kind: CheckoutKind.RazorpayCheckout,
    keyId: 'rzp_test_key',
    orderId: 'order_9A33XWu170gUtm',
    amount: 50000,
    prefill: { name: 'Gaurav Kumar', email: 'gaurav.kumar@example.com', phone: '+919876543210' },
  };

  beforeEach(() => {
    FakeRazorpay.instances = [];
  });

  it('accepts an instruction with an orderId and no subscriptionId, and rejects one with both or neither', () => {
    expect(RazorpayCheckoutSchema.safeParse(instruction).success).toBe(true);
    expect(RazorpayCheckoutSchema.safeParse({ ...instruction, subscriptionId: 'sub_1' }).success).toBe(false);
    expect(RazorpayCheckoutSchema.safeParse({ kind: CheckoutKind.RazorpayCheckout, keyId: 'k' }).success).toBe(false);
  });

  it('opens Checkout with order_id, amount and INR instead of subscription_id', async () => {
    const browser = razorpayBrowser();
    const pending = openCheckout(
      instruction,
      { name: 'Acme Corp.', description: 'Pro plan', image: '/your_logo.jpg', theme: { color: '#3399cc' }, notes: { address: 'Razorpay Corporate Office' } },
      browser.env,
    );
    await waitFor(() => FakeRazorpay.instances.length === 1);
    const rzp = FakeRazorpay.instances[0] as FakeRazorpay;
    expect(browser.scripts()[0]?.attributes['src']).toBe(RAZORPAY_SCRIPT);
    expect(rzp.opened).toBe(1);

    expect(Object.keys(rzp.options).sort()).toEqual(
      ['amount', 'currency', 'description', 'handler', 'image', 'key', 'modal', 'name', 'notes', 'order_id', 'prefill', 'theme'],
    );
    expect(rzp.options).toMatchObject({
      key: 'rzp_test_key',
      order_id: 'order_9A33XWu170gUtm',
      amount: 50000,
      currency: 'INR',
      name: 'Acme Corp.',
      description: 'Pro plan',
      image: '/your_logo.jpg',
      prefill: { name: 'Gaurav Kumar', email: 'gaurav.kumar@example.com', contact: '+919876543210' },
      notes: { address: 'Razorpay Corporate Office' },
      theme: { color: '#3399cc' },
    });
    expect('subscription_id' in rzp.options).toBe(false);
    expect('callback_url' in rzp.options).toBe(false);

    // The handler gets the "Success Callback" fields of the integration page; they go to the server untouched.
    const response = {
      razorpay_payment_id: 'pay_29QQoUBi66xm2f',
      razorpay_order_id: 'order_9A33XWu170gUtm',
      razorpay_signature: '9ef4dffbfd84f1318f6739a3ce19f9d85851857ae648f114332d8401e0949a3d',
    };
    (rzp.options['handler'] as (r: unknown) => void)(response);
    const outcome = await pending;
    expect(outcome).toEqual({ status: 'completed', result: response });
    expect(CheckoutOutcomeSchema.safeParse(outcome).success).toBe(true);
  });

  it('uses callback_url instead of a handler when the instruction has callbackUrl', async () => {
    const browser = razorpayBrowser();
    const pending = openRazorpayCheckout({ ...instruction, callbackUrl: 'https://merchant.example.com/razorpay/callback' }, undefined, browser.env);
    await waitFor(() => FakeRazorpay.instances.length === 1);
    const rzp = FakeRazorpay.instances[0] as FakeRazorpay;
    expect(rzp.options['callback_url']).toBe('https://merchant.example.com/razorpay/callback');
    expect('handler' in rzp.options).toBe(false);
    expect(rzp.options['order_id']).toBe('order_9A33XWu170gUtm');
    (rzp.options['modal'] as { ondismiss: () => void }).ondismiss();
    expect(await pending).toEqual({ status: 'dismissed' });
  });

  it('sends no amount when the instruction has none, and settles on a failed payment like a subscription does', async () => {
    const browser = razorpayBrowser();
    const pending = openRazorpayCheckout({ kind: CheckoutKind.RazorpayCheckout, keyId: 'rzp_test_key', orderId: 'order_9A33XWu170gUtm' }, undefined, browser.env);
    await waitFor(() => FakeRazorpay.instances.length === 1);
    const rzp = FakeRazorpay.instances[0] as FakeRazorpay;
    expect('amount' in rzp.options).toBe(false);
    expect(rzp.options['currency']).toBe('INR');
    const error = { code: 'BAD_REQUEST_ERROR', description: 'Payment failed', source: 'bank', step: 'payment_authorization', reason: 'payment_failed' };
    rzp.handlers['payment.failed']?.({ error });
    expect(await pending).toEqual({ status: 'failed', error });
    expect(rzp.closed).toBe(1);
  });
});

describe('razorpay_checkout with a subscription is unchanged', () => {
  beforeEach(() => {
    FakeRazorpay.instances = [];
  });

  it('opens Checkout with subscription_id and no order_id, amount or currency', async () => {
    const browser = razorpayBrowser();
    const pending = openRazorpayCheckout(
      { kind: CheckoutKind.RazorpayCheckout, keyId: 'rzp_test_key', subscriptionId: 'sub_00000000000001' },
      { name: 'Acme Corp.' },
      browser.env,
    );
    await waitFor(() => FakeRazorpay.instances.length === 1);
    const rzp = FakeRazorpay.instances[0] as FakeRazorpay;
    expect(Object.keys(rzp.options).sort()).toEqual(['handler', 'key', 'modal', 'name', 'subscription_id']);
    expect(rzp.options).toMatchObject({ key: 'rzp_test_key', subscription_id: 'sub_00000000000001', name: 'Acme Corp.' });
    (rzp.options['modal'] as { ondismiss: () => void }).ondismiss();
    expect(await pending).toEqual({ status: 'dismissed' });
  });
});
