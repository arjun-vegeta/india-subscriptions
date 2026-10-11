import { describe, expect, it } from 'vitest';
import {
  CheckoutStatus,
  ErrorCode,
  SubscriptionError,
  openCashfreeCheckout,
  openCheckout,
  type CheckoutInstruction,
} from '../../src/checkout/index.js';
import { CheckoutKind, Environment, ProductKind } from '../../src/constants.js';
import { CashfreeCheckoutSchema } from '../../src/schemas.js';
import { createFakeBrowser } from './helpers.js';

// Literal names on purpose: the tests pin the wire contract independently of the library's constants.
// Source: https://www.cashfree.com/docs/payments/online/web/redirect (Step 2): `Cashfree({ mode: "sandbox" })`, then
// `cashfree.checkout({ paymentSessionId, redirectTarget })`; the subscription flow keeps `subscriptionsCheckout`.

const CASHFREE_SCRIPT = 'https://sdk.cashfree.com/js/v3/cashfree.js';
const SESSION = 'session_a1VXIPJo8kh7IBigVXX8LgTMupQW_cu25FS8KwLwQLOmiHqbBxq5UhEilrhbDSKKHA6UAuOj9506aaHNlFAHEqYrHSEl9AVtYQN9LIIc4vkH';

interface Call {
  method: string;
  init: unknown;
  options: unknown;
}

/** A Cashfree.js with both checkouts, recording which one is called. */
function browserWith(calls: Call[], impl: () => Promise<unknown> = () => Promise.resolve(undefined), only?: 'checkout' | 'subscriptionsCheckout') {
  return createFakeBrowser({
    onScriptLoad: (url, win) => {
      if (url !== CASHFREE_SCRIPT) return;
      win['Cashfree'] = (init: unknown) => {
        const sdk: Record<string, unknown> = {};
        for (const method of ['checkout', 'subscriptionsCheckout']) {
          if (only !== undefined && only !== method) continue;
          sdk[method] = (options: unknown) => {
            calls.push({ method, init, options });
            return impl();
          };
        }
        return sdk;
      };
    },
  });
}

const ONE_TIME: CheckoutInstruction = {
  kind: CheckoutKind.CashfreeCheckout,
  sessionId: SESSION,
  environment: Environment.Test,
  productKind: ProductKind.OneTime,
};

describe('cashfree_checkout for a one-time payment', () => {
  it('calls checkout with the payment session id, in sandbox mode for the test environment', async () => {
    const calls: Call[] = [];
    const browser = browserWith(calls);
    const outcome = await openCheckout(ONE_TIME, { redirectTarget: '_blank' }, browser.env);
    expect(outcome).toEqual({ status: CheckoutStatus.Redirecting });
    expect(browser.scripts()[0]?.attributes['src']).toBe(CASHFREE_SCRIPT);
    expect(calls).toEqual([
      { method: 'checkout', init: { mode: 'sandbox' }, options: { paymentSessionId: SESSION, redirectTarget: '_blank' } },
    ]);
  });

  it('uses production mode for the live environment and a full-page redirect by default', async () => {
    const calls: Call[] = [];
    const browser = browserWith(calls);
    await openCashfreeCheckout({ ...ONE_TIME, environment: Environment.Live }, undefined, browser.env);
    expect(calls).toEqual([
      { method: 'checkout', init: { mode: 'production' }, options: { paymentSessionId: SESSION, redirectTarget: '_self' } },
    ]);
  });

  it('never calls subscriptionsCheckout for it, and never sends subsSessionId', async () => {
    const calls: Call[] = [];
    await openCheckout(ONE_TIME, undefined, browserWith(calls).env);
    expect(calls.map((call) => call.method)).toEqual(['checkout']);
    expect(JSON.stringify(calls[0]?.options)).not.toContain('subsSessionId');
  });

  it('maps result.error to a failed outcome and a rejected promise to a failed outcome', async () => {
    const withError = browserWith([], () => Promise.resolve({ error: { message: 'payment session expired' } }));
    expect(await openCheckout(ONE_TIME, undefined, withError.env)).toEqual({
      status: CheckoutStatus.Failed,
      error: { message: 'payment session expired' },
    });
    const rejected = browserWith([], () => Promise.reject(new Error('popup blocked')));
    expect(await openCheckout(ONE_TIME, undefined, rejected.env)).toEqual({
      status: CheckoutStatus.Failed,
      error: { message: 'popup blocked' },
    });
  });

  it('leaves the result to the server when the page redirects or the payment completes: the outcome never says paid', async () => {
    for (const result of [{ redirect: true }, { paymentDetails: { paymentMessage: 'Transaction successful' } }]) {
      const browser = browserWith([], () => Promise.resolve(result));
      expect(await openCheckout(ONE_TIME, undefined, browser.env)).toEqual({ status: CheckoutStatus.Redirecting });
    }
  });

  it('rejects with PROVIDER_UNAVAILABLE when the loaded Cashfree.js has no checkout method', async () => {
    const browser = browserWith([], undefined, 'subscriptionsCheckout');
    const error = await openCheckout(ONE_TIME, undefined, browser.env).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SubscriptionError);
    expect((error as SubscriptionError).code).toBe(ErrorCode.ProviderUnavailable);
    expect((error as SubscriptionError).message).toContain('checkout');
  });
});

describe('cashfree_checkout for a subscription is unchanged', () => {
  const SUBSCRIPTION: CheckoutInstruction = { kind: CheckoutKind.CashfreeCheckout, sessionId: 'session_sub', environment: Environment.Test };

  it('calls subscriptionsCheckout with subsSessionId when productKind is absent', async () => {
    const calls: Call[] = [];
    await openCheckout(SUBSCRIPTION, undefined, browserWith(calls).env);
    expect(calls).toEqual([
      { method: 'subscriptionsCheckout', init: { mode: 'sandbox' }, options: { subsSessionId: 'session_sub', redirectTarget: '_self' } },
    ]);
  });

  it('calls subscriptionsCheckout when productKind is subscription', async () => {
    const calls: Call[] = [];
    await openCheckout({ ...SUBSCRIPTION, productKind: ProductKind.Subscription }, undefined, browserWith(calls).env);
    expect(calls.map((call) => call.method)).toEqual(['subscriptionsCheckout']);
  });

  it('rejects with PROVIDER_UNAVAILABLE when Cashfree.js has no subscriptionsCheckout', async () => {
    const browser = browserWith([], undefined, 'checkout');
    const error = await openCheckout(SUBSCRIPTION, undefined, browser.env).catch((e: unknown) => e);
    expect((error as SubscriptionError).code).toBe(ErrorCode.ProviderUnavailable);
    expect((error as SubscriptionError).message).toContain('subscriptionsCheckout');
  });
});

describe('the instruction', () => {
  it('rejects an unknown product kind with VALIDATION before touching the DOM', async () => {
    const browser = createFakeBrowser();
    const bad = { kind: CheckoutKind.CashfreeCheckout, sessionId: 's', environment: Environment.Test, productKind: 'lifetime' };
    const error = await openCheckout(bad as unknown as CheckoutInstruction, undefined, browser.env).catch((e: unknown) => e);
    expect((error as SubscriptionError).code).toBe(ErrorCode.Validation);
    expect(browser.scripts()).toHaveLength(0);
  });

  it('is what createPayment returns: the shared schema accepts it', () => {
    expect(CashfreeCheckoutSchema.safeParse(ONE_TIME).success).toBe(true);
  });
});
