import { beforeEach, describe, expect, it } from 'vitest';
import {
  CheckoutOutcomeSchema,
  CheckoutStatus,
  ErrorCode,
  ScriptUrl,
  SubscriptionError,
  loadScript,
  openCashfreeCheckout,
  openCheckout,
  openRazorpayCheckout,
  redirectTo,
  submitForm,
  type CheckoutInstruction,
} from '../../src/checkout/index.js';
import { CheckoutKind, Environment } from '../../src/constants.js';
import { FakeElement, FakeRazorpay, createFakeBrowser } from './helpers.js';

// Literal gateway names are used on purpose below: tests pin the wire contract
// independently of src/checkout/constants.ts.

const RAZORPAY_SCRIPT = 'https://checkout.razorpay.com/v1/checkout.js'; // razorpay.md §6.2
const CASHFREE_SCRIPT = 'https://sdk.cashfree.com/js/v3/cashfree.js';

async function rejection(promise: Promise<unknown>): Promise<SubscriptionError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SubscriptionError);
    return error as SubscriptionError;
  }
  throw new Error('expected the promise to reject');
}

function inputsOf(form: FakeElement): Array<{ type?: string; name?: string; value?: string }> {
  return form.children.map((input) => ({
    type: input.attributes['type'],
    name: input.attributes['name'],
    value: input.attributes['value'],
  }));
}

describe('script URL constants', () => {
  it('match the documented script locations', () => {
    expect(ScriptUrl.RazorpayCheckout).toBe(RAZORPAY_SCRIPT);
    expect(ScriptUrl.Cashfree).toBe(CASHFREE_SCRIPT);
  });
});

describe('redirect', () => {
  it('navigates to the URL and reports redirecting', async () => {
    const browser = createFakeBrowser();
    const outcome = await openCheckout({ kind: CheckoutKind.Redirect, url: 'https://pay.example.com/auth/abc?x=1&y=2' }, undefined, browser.env);
    expect(outcome).toEqual({ status: 'redirecting' });
    expect(browser.assigned).toEqual(['https://pay.example.com/auth/abc?x=1&y=2']);
  });

  it('refuses non-http(s) URLs', () => {
    const browser = createFakeBrowser();
    expect(() => redirectTo({ kind: CheckoutKind.Redirect, url: 'javascript:alert(1)' }, browser.env)).toThrowError(
      expect.objectContaining({ code: ErrorCode.Validation }),
    );
    expect(browser.assigned).toEqual([]);
  });
});

describe('form_post', () => {
  const FIELDS = {
    key: 'merchant_key',
    txnid: 'TXN"1',
    productinfo: '<script>alert("x")</script>',
    firstname: 'Tom & Jerry',
    note: "it's 100% ₹499 — café 🙂 é\n(line2)",
    hash: 'a1b2c3',
    empty: '',
  };

  it('posts every field as a hidden input, values intact', async () => {
    const browser = createFakeBrowser();
    const outcome = await openCheckout({ kind: CheckoutKind.FormPost, url: 'https://secure.payu.in/_payment', fields: FIELDS }, undefined, browser.env);
    expect(outcome).toEqual({ status: 'redirecting' });

    const [form] = browser.forms();
    expect(form).toBeDefined();
    expect(form?.attributes).toEqual({ method: 'POST', action: 'https://secure.payu.in/_payment' });
    expect(form?.submitCalls).toBe(1);
    expect(inputsOf(form as FakeElement)).toEqual(
      Object.entries(FIELDS).map(([name, value]) => ({ type: 'hidden', name, value })),
    );
  });

  it('still submits when a field is named "submit"', () => {
    const browser = createFakeBrowser();
    submitForm({ kind: CheckoutKind.FormPost, url: 'https://secure.payu.in/_payment', fields: { submit: 'go', hash: 'h' } }, browser.env);
    expect(browser.forms()[0]?.submitCalls).toBe(1);
    expect(inputsOf(browser.forms()[0] as FakeElement).map((i) => i.name)).toEqual(['submit', 'hash']);
  });

  it('refuses a non-http(s) action', () => {
    const browser = createFakeBrowser();
    expect(() => submitForm({ kind: CheckoutKind.FormPost, url: 'data:text/html,hi', fields: {} }, browser.env)).toThrowError(
      expect.objectContaining({ code: ErrorCode.Validation }),
    );
    expect(browser.forms()).toEqual([]);
  });
});

describe('loadScript', () => {
  it('loads once across concurrent calls and reuses the result afterwards', async () => {
    const browser = createFakeBrowser();
    const [a, b, c] = await Promise.all([
      loadScript('https://cdn.example.com/a.js', browser.env),
      loadScript('https://cdn.example.com/a.js', browser.env),
      loadScript('https://cdn.example.com/a.js', browser.env),
    ]);
    expect([a, b, c]).toEqual([undefined, undefined, undefined]);
    await loadScript('https://cdn.example.com/a.js', browser.env);
    expect(browser.scripts()).toHaveLength(1);
    expect(browser.scripts()[0]?.attributes['src']).toBe('https://cdn.example.com/a.js');

    await loadScript('https://cdn.example.com/b.js', browser.env);
    expect(browser.scripts()).toHaveLength(2);
  });

  it('rejects with PROVIDER_UNAVAILABLE when the script fails, then allows a retry', async () => {
    const browser = createFakeBrowser({ behaviour: 'error' });
    const error = await rejection(loadScript('https://cdn.example.com/x.js', browser.env));
    expect(error.code).toBe(ErrorCode.ProviderUnavailable);
    expect(error.message).toContain('https://cdn.example.com/x.js');

    // A different document is unaffected by the failure.
    const other = createFakeBrowser({ behaviour: 'load' });
    await expect(loadScript('https://cdn.example.com/x.js', other.env)).resolves.toBeUndefined();
  });

  it('forgets a failed load on the same document', async () => {
    const browser = createFakeBrowser({ behaviour: 'manual' });
    const first = loadScript('https://cdn.example.com/y.js', browser.env);
    browser.scripts()[0]?.fire('error');
    await rejection(first);
    const second = loadScript('https://cdn.example.com/y.js', browser.env);
    expect(browser.scripts()).toHaveLength(2);
    browser.scripts()[1]?.fire('load');
    await expect(second).resolves.toBeUndefined();
  });

  it('does not load non-http(s) scripts', async () => {
    const browser = createFakeBrowser();
    await expect(loadScript('javascript:alert(1)', browser.env)).rejects.toMatchObject({ code: ErrorCode.Validation });
    expect(browser.scripts()).toEqual([]);
  });
});

describe('razorpay_checkout', () => {
  const instruction: CheckoutInstruction = {
    kind: CheckoutKind.RazorpayCheckout,
    keyId: 'rzp_test_key',
    subscriptionId: 'sub_00000000000001',
    prefill: { name: 'Gaurav Kumar', email: 'gaurav.kumar@example.com', phone: '+919876543210' },
  };

  beforeEach(() => {
    FakeRazorpay.instances = [];
  });

  function razorpayBrowser() {
    return createFakeBrowser({
      onScriptLoad: (url, win) => {
        if (url === RAZORPAY_SCRIPT) win['Razorpay'] = FakeRazorpay;
      },
    });
  }

  it('builds the documented handler-style options and opens the modal', async () => {
    const browser = razorpayBrowser();
    const pending = openCheckout(
      instruction,
      {
        name: 'Acme Corp.',
        description: 'Monthly Test Plan',
        image: '/your_logo.jpg',
        theme: { color: '#F37254' },
        notes: { note_key_1: 'Tea. Earl Grey. Hot', note_key_2: 'Make it so.' },
      },
      browser.env,
    );
    await vi_waitFor(() => FakeRazorpay.instances.length === 1);
    const rzp = FakeRazorpay.instances[0] as FakeRazorpay;
    expect(browser.scripts()[0]?.attributes['src']).toBe(RAZORPAY_SCRIPT);
    expect(rzp.opened).toBe(1);

    // razorpay.md §6.2 "Checkout with Handler function": key, subscription_id,
    // name, description, image, handler, prefill {name,email,contact}, notes, theme.color.
    // No amount / currency / order_id for subscriptions. Plus modal.ondismiss.
    expect(Object.keys(rzp.options).sort()).toEqual(
      ['description', 'handler', 'image', 'key', 'modal', 'name', 'notes', 'prefill', 'subscription_id', 'theme'],
    );
    expect(rzp.options).toMatchObject({
      key: 'rzp_test_key',
      subscription_id: 'sub_00000000000001',
      name: 'Acme Corp.',
      description: 'Monthly Test Plan',
      image: '/your_logo.jpg',
      prefill: { name: 'Gaurav Kumar', email: 'gaurav.kumar@example.com', contact: '+919876543210' },
      notes: { note_key_1: 'Tea. Earl Grey. Hot', note_key_2: 'Make it so.' },
      theme: { color: '#F37254' },
    });
    expect(rzp.options['callback_url']).toBeUndefined();

    // razorpay.md §6.3: handler gets razorpay_payment_id, razorpay_subscription_id, razorpay_signature.
    const handler = rzp.options['handler'] as (response: unknown) => void;
    const response = {
      razorpay_payment_id: 'pay_29QQoUBi66xm2f',
      razorpay_subscription_id: 'sub_00000000000001',
      razorpay_signature: '9ef4dffbfd84f1318f6739a3ce19f9d85851857ae648f114332d8401e0949a3d',
    };
    handler(response);
    const outcome = await pending;
    expect(outcome).toEqual({ status: 'completed', result: response });
    expect(CheckoutOutcomeSchema.safeParse(outcome).success).toBe(true);
  });

  it('uses callback_url instead of a handler when the instruction has callbackUrl', async () => {
    const browser = razorpayBrowser();
    const pending = openRazorpayCheckout(
      { ...instruction, kind: CheckoutKind.RazorpayCheckout, callbackUrl: 'https://merchant.example.com/razorpay/callback' },
      { name: 'Acme Corp.' },
      browser.env,
    );
    await vi_waitFor(() => FakeRazorpay.instances.length === 1);
    const rzp = FakeRazorpay.instances[0] as FakeRazorpay;
    // razorpay.md §6.2 "Checkout with Callback URL": callback_url OR handler.
    expect(rzp.options['callback_url']).toBe('https://merchant.example.com/razorpay/callback');
    expect('handler' in rzp.options).toBe(false);
    (rzp.options['modal'] as { ondismiss: () => void }).ondismiss();
    await expect(pending).resolves.toEqual({ status: 'dismissed' });
  });

  it('omits prefill and display options that were not given', async () => {
    const browser = razorpayBrowser();
    const pending = openRazorpayCheckout({ kind: CheckoutKind.RazorpayCheckout, keyId: 'k', subscriptionId: 's' }, undefined, browser.env);
    await vi_waitFor(() => FakeRazorpay.instances.length === 1);
    const rzp = FakeRazorpay.instances[0] as FakeRazorpay;
    expect(Object.keys(rzp.options).sort()).toEqual(['handler', 'key', 'modal', 'subscription_id']);
    (rzp.options['modal'] as { ondismiss: () => void }).ondismiss();
    await pending;
  });

  it('resolves dismissed when the customer closes the modal', async () => {
    const browser = razorpayBrowser();
    const pending = openCheckout(instruction, undefined, browser.env);
    await vi_waitFor(() => FakeRazorpay.instances.length === 1);
    (FakeRazorpay.instances[0]?.options['modal'] as { ondismiss: () => void }).ondismiss();
    await expect(pending).resolves.toEqual({ status: 'dismissed' });
  });

  it('resolves failed with the error on payment.failed and closes the modal', async () => {
    const browser = razorpayBrowser();
    const pending = openCheckout(instruction, undefined, browser.env);
    await vi_waitFor(() => FakeRazorpay.instances.length === 1);
    const rzp = FakeRazorpay.instances[0] as FakeRazorpay;
    // razorpay.md §6.2 "Failure response object".
    const failure = {
      error: {
        code: 'BAD_REQUEST_ERROR',
        description: 'Payment failed. Please contact the site admin',
        source: 'business',
        step: 'payment_initiation',
        reason: 'amount_less_than_minimum_amount',
        metadata: {},
        field: 'amount',
      },
    };
    rzp.handlers['payment.failed']?.(failure);
    const outcome = await pending;
    expect(outcome).toEqual({ status: 'failed', error: failure.error });
    expect(rzp.closed).toBe(1);
    // The dismissal caused by closing must not change the outcome.
    (rzp.options['modal'] as { ondismiss: () => void }).ondismiss();
    expect(CheckoutOutcomeSchema.safeParse(outcome).success).toBe(true);
  });

  it('loads the script once for concurrent calls and reuses it afterwards', async () => {
    const browser = razorpayBrowser();
    const first = openCheckout(instruction, undefined, browser.env);
    const second = openCheckout(instruction, undefined, browser.env);
    await vi_waitFor(() => FakeRazorpay.instances.length === 2);
    expect(browser.scripts()).toHaveLength(1);
    for (const rzp of FakeRazorpay.instances) (rzp.options['modal'] as { ondismiss: () => void }).ondismiss();
    await Promise.all([first, second]);

    const third = openCheckout(instruction, undefined, browser.env);
    await vi_waitFor(() => FakeRazorpay.instances.length === 3);
    expect(browser.scripts()).toHaveLength(1);
    (FakeRazorpay.instances[2]?.options['modal'] as { ondismiss: () => void }).ondismiss();
    await third;
  });

  it('does not inject a script when Razorpay is already on the page', async () => {
    const browser = createFakeBrowser();
    browser.win['Razorpay'] = FakeRazorpay;
    const pending = openCheckout(instruction, undefined, browser.env);
    await vi_waitFor(() => FakeRazorpay.instances.length === 1);
    expect(browser.scripts()).toHaveLength(0);
    (FakeRazorpay.instances[0]?.options['modal'] as { ondismiss: () => void }).ondismiss();
    await pending;
  });

  it('rejects with PROVIDER_UNAVAILABLE when checkout.js fails to load', async () => {
    const browser = createFakeBrowser({ behaviour: 'error' });
    const error = await rejection(openCheckout(instruction, undefined, browser.env));
    expect(error.code).toBe(ErrorCode.ProviderUnavailable);
    expect(error.message).toContain(RAZORPAY_SCRIPT);
  });

  it('rejects with PROVIDER_UNAVAILABLE when the script loads but defines no Razorpay', async () => {
    const browser = createFakeBrowser({ behaviour: 'load' });
    const error = await rejection(openCheckout(instruction, undefined, browser.env));
    expect(error.code).toBe(ErrorCode.ProviderUnavailable);
  });
});

describe('cashfree_checkout', () => {
  interface Call {
    init: unknown;
    checkout: unknown;
  }

  function cashfreeBrowser(calls: Call[], checkoutImpl: () => Promise<unknown> = () => Promise.resolve(undefined)) {
    return createFakeBrowser({
      onScriptLoad: (url, win) => {
        if (url !== CASHFREE_SCRIPT) return;
        win['Cashfree'] = (init: unknown) => ({
          subscriptionsCheckout: (opts: unknown) => {
            calls.push({ init, checkout: opts });
            return checkoutImpl();
          },
        });
      },
    });
  }

  it('initialises in sandbox mode for the test environment and calls subscriptionsCheckout', async () => {
    const calls: Call[] = [];
    const browser = cashfreeBrowser(calls);
    const outcome = await openCheckout(
      { kind: CheckoutKind.CashfreeCheckout, sessionId: 'session_abc123', environment: Environment.Test },
      { redirectTarget: '_blank' },
      browser.env,
    );
    expect(outcome).toEqual({ status: 'redirecting' });
    expect(browser.scripts()[0]?.attributes['src']).toBe(CASHFREE_SCRIPT);
    // cashfree.md §7.1: Cashfree({ mode: "sandbox" }) then
    // cashfree.subscriptionsCheckout({ subsSessionId, redirectTarget: "_blank" }).
    expect(calls).toEqual([{ init: { mode: 'sandbox' }, checkout: { subsSessionId: 'session_abc123', redirectTarget: '_blank' } }]);
  });

  it('initialises in production mode for the live environment, redirecting the page by default', async () => {
    const calls: Call[] = [];
    const browser = cashfreeBrowser(calls);
    await openCashfreeCheckout({ kind: CheckoutKind.CashfreeCheckout, sessionId: 'sess_live', environment: Environment.Live }, undefined, browser.env);
    expect(calls).toEqual([{ init: { mode: 'production' }, checkout: { subsSessionId: 'sess_live', redirectTarget: '_self' } }]);
  });

  it('maps result.error to a failed outcome', async () => {
    // cashfree.md §7.1: on failure the promise resolves with result.error.message.
    const browser = cashfreeBrowser([], () => Promise.resolve({ error: { message: 'subscription session expired' } }));
    const outcome = await openCheckout({ kind: CheckoutKind.CashfreeCheckout, sessionId: 's', environment: Environment.Test }, undefined, browser.env);
    expect(outcome).toEqual({ status: 'failed', error: { message: 'subscription session expired' } });
  });

  it('maps a rejected checkout promise to a failed outcome', async () => {
    const browser = cashfreeBrowser([], () => Promise.reject(new Error('popup blocked')));
    const outcome = await openCheckout({ kind: CheckoutKind.CashfreeCheckout, sessionId: 's', environment: Environment.Test }, undefined, browser.env);
    expect(outcome).toEqual({ status: 'failed', error: { message: 'popup blocked' } });
  });

  it('loads cashfree.js once across concurrent calls', async () => {
    const calls: Call[] = [];
    const browser = cashfreeBrowser(calls);
    const instruction = { kind: CheckoutKind.CashfreeCheckout, sessionId: 's', environment: Environment.Test } as const;
    await Promise.all([openCheckout(instruction, undefined, browser.env), openCheckout(instruction, undefined, browser.env)]);
    await openCheckout(instruction, undefined, browser.env);
    expect(browser.scripts()).toHaveLength(1);
    expect(calls).toHaveLength(3);
  });

  it('rejects with PROVIDER_UNAVAILABLE when cashfree.js fails to load', async () => {
    const browser = createFakeBrowser({ behaviour: 'error' });
    const error = await rejection(
      openCheckout({ kind: CheckoutKind.CashfreeCheckout, sessionId: 's', environment: Environment.Test }, undefined, browser.env),
    );
    expect(error.code).toBe(ErrorCode.ProviderUnavailable);
  });
});

describe('validation and environment', () => {
  it('rejects an invalid instruction with VALIDATION before touching the DOM', async () => {
    const browser = createFakeBrowser();
    const bad = [
      { kind: 'nope' },
      { kind: CheckoutKind.Redirect, url: 'not a url' },
      { kind: CheckoutKind.FormPost, url: 'https://x.example.com', fields: { a: 1 } },
      { kind: CheckoutKind.RazorpayCheckout, keyId: 'k' },
      { kind: CheckoutKind.CashfreeCheckout, sessionId: 's', environment: 'staging' },
    ];
    for (const instruction of bad) {
      const error = await rejection(openCheckout(instruction as unknown as CheckoutInstruction, undefined, browser.env));
      expect(error.code).toBe(ErrorCode.Validation);
    }
    expect(browser.assigned).toEqual([]);
    expect(browser.head.appended).toEqual([]);
    expect(browser.body.appended).toEqual([]);
  });

  it('rejects invalid display options with VALIDATION', async () => {
    const browser = createFakeBrowser();
    const error = await rejection(
      openCheckout(
        { kind: CheckoutKind.Redirect, url: 'https://pay.example.com' },
        { notes: { a: 1 } } as never,
        browser.env,
      ),
    );
    expect(error.code).toBe(ErrorCode.Validation);
  });

  it('throws CONFIG when there is no DOM', async () => {
    // Vitest runs in Node: no window/document globals.
    for (const instruction of [
      { kind: CheckoutKind.Redirect, url: 'https://pay.example.com' },
      { kind: CheckoutKind.FormPost, url: 'https://pay.example.com', fields: {} },
      { kind: CheckoutKind.RazorpayCheckout, keyId: 'k', subscriptionId: 's' },
      { kind: CheckoutKind.CashfreeCheckout, sessionId: 's', environment: Environment.Test },
    ] as const) {
      const error = await rejection(openCheckout(instruction, undefined));
      expect(error.code).toBe(ErrorCode.Config);
    }
    await expect(loadScript('https://cdn.example.com/a.js')).rejects.toMatchObject({ code: ErrorCode.Config });
  });

  it('throws CONFIG for a half-formed env', async () => {
    const browser = createFakeBrowser();
    const error = await rejection(
      openCheckout({ kind: CheckoutKind.Redirect, url: 'https://pay.example.com' }, undefined, { document: browser.doc }),
    );
    expect(error.code).toBe(ErrorCode.Config);
  });

  it('exports the outcome statuses', () => {
    expect(Object.values(CheckoutStatus).sort()).toEqual(['completed', 'dismissed', 'failed', 'redirecting']);
  });
});

/** Polls until `condition` holds (script loads resolve on microtasks). */
async function vi_waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition never became true');
}
