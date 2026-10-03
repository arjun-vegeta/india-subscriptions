# Checkout in the browser

After this page you will be able to run the customer's authorisation step for any gateway with one call, handle every outcome, and know how the result gets back to your server on each gateway.

Creating a subscription returns `subscription.checkout`, an **instruction** describing what the customer's browser must do. `openCheckout` from `india-subscriptions/checkout` carries it out. It imports no Node module, depends only on `zod`, and never sees a secret: it only knows what your server chose to return. PayU's salt, for example, signs the form on your server and is never in it.

## The four kinds of instruction

Branch on `checkout.kind` (a `CheckoutKind` constant) if you build your own UI; `openCheckout` does it for you.

| Kind | What the browser does | Used by | Outcome |
|---|---|---|---|
| `razorpay_checkout` | Loads Razorpay Standard Checkout, opens it for the subscription id | Razorpay | `completed` with the gateway's handler response, or `dismissed`, or `failed` |
| `cashfree_checkout` | Loads Cashfree.js, calls `subscriptionsCheckout` with the session id | Cashfree | `redirecting` (the customer returns to your `returnUrl`), or `failed` |
| `form_post` | Builds a hidden form with the given fields and submits it to the gateway | PayU | `redirecting` |
| `redirect` | Navigates to a URL | No current adapter returns it; it exists for gateways with a hosted page. Razorpay's `hostedUrl` can be used with `redirectTo`. | `redirecting` |

`openCheckout` returns an outcome you switch on with the `CheckoutStatus` constants:

| Status | Meaning | What to do |
|---|---|---|
| `completed` | The customer finished in the page. `result` is what the gateway returned. | POST `result` to your server, untouched, and verify it there. |
| `dismissed` | The customer closed the checkout. | Leave the subscription as it is; show the button again. |
| `failed` | The gateway reported a failure. `error` has its details. | Show a message and let them retry. |
| `redirecting` | The browser is navigating away. | Nothing. The result arrives at your server through the return URL or a webhook. |

It throws `SubscriptionError` for a bad instruction (`VALIDATION`), no browser (`CONFIG`) or a gateway script that could not load (`PROVIDER_UNAVAILABLE`, usually an ad blocker or a Content-Security-Policy).

```ts
import { CheckoutStatus, openCheckout, type CheckoutInstruction } from 'india-subscriptions/checkout';

export async function authorise(checkout: CheckoutInstruction): Promise<string> {
  const outcome = await openCheckout(checkout, {
    name: 'Acme', // shown in the Razorpay header
    description: 'Pro monthly',
    theme: { color: '#0b5fff' },
  });
  switch (outcome.status) {
    case CheckoutStatus.Completed:
      await fetch('/api/subscriptions/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(outcome.result),
      });
      return 'verifying';
    case CheckoutStatus.Dismissed:
      return 'try again when you are ready';
    case CheckoutStatus.Failed:
      return outcome.error.description ?? outcome.error.message ?? 'the payment failed';
    default:
      return CheckoutStatus.Redirecting;
  }
}
```

## Options

All optional. `name`, `description`, `image`, `theme.color` and `notes` are for Razorpay's checkout. `redirectTarget` is Cashfree only: where the hosted checkout opens (default `_self`, a full-page redirect, so the customer comes back to your `returnUrl` in the same tab). Cashfree's other `redirectTarget` values are not documented and need a real-browser check.

## How the result reaches your server

| Gateway | Result | Verify with |
|---|---|---|
| Razorpay | The handler response, in the browser (`completed`). With a `callbackUrl` on the instruction, Razorpay redirects the page instead and no handler is registered. | `subs.verifyCheckout(Provider.Razorpay, result, { expectedSubscriptionId })` |
| Cashfree | The customer returns to your `returnUrl` with `cf_subscriptionId` in the query. The library trusts nothing else in the query and fetches the subscription. | `verifyCheckout(Provider.Cashfree, queryAsObject, { expectedSubscriptionId })` |
| PayU | PayU **posts a form** to your `surl` (success) or `furl` (failure). Verify the response hash with `verifyCheckout`. | `verifyCheckout(Provider.PayU, formFields, { expectedSubscriptionId })` |

Always pass `expectedSubscriptionId`: the id (or your `reference`) your server stored when it created the subscription. A genuine, correctly signed result for a **different** subscription then fails with `SIGNATURE_INVALID`, so a customer cannot replay one authorisation to unlock another.

For PayU, the return route receives a form post, and the subscription id changes once: `verification.subscriptionId` is the id to store from then on.

```ts
import express from 'express';
import { Provider } from 'india-subscriptions';
import { subs } from './billing-payu';

const app = express();

// The URL you gave PayU as successUrl / failureUrl: it receives a form post.
app.post('/payu/return', express.urlencoded({ extended: false }), async (req, res) => {
  const verification = await subs.verifyCheckout(Provider.PayU, req.body, {
    expectedSubscriptionId: 'order_2001', // the reference you stored when you created it
  });
  // Store verification.subscriptionId (for example "card:31543714057"): it is the id from now on.
  res.redirect(verification.authorized ? '/welcome' : '/payment-pending');
});
```

An eNACH mandate that the bank has not yet confirmed comes back as `authorized: false` with `status: pending_authorization`. Show "being confirmed" and wait for the activation event.

## Mobile apps and other clients

`openCheckout` is for the web. A mobile app or another client branches on `checkout.kind` itself: open Razorpay's or Cashfree's native SDK with the ids in the instruction, or a web view for `form_post` and `redirect`. The result handling on the server is the same.

## Content-Security-Policy

Allow the gateway scripts and endpoints you use: `https://checkout.razorpay.com` for Razorpay, `https://sdk.cashfree.com` for Cashfree.js, and the PayU host in `form-action` (`https://test.payu.in` or `https://secure.payu.in`).
