# The checkout helper

`india-subscriptions/checkout` runs the customer's authorisation step in the browser. It is dependency-free apart from `zod`, imports no Node module and never touches a secret. For how to use it, see [Checkout in the browser](../guides/checkout.md).

## `openCheckout(instruction, options?, env?)` : `Promise<CheckoutOutcome>`

Carries out a [`CheckoutInstruction`](./generated/models.md#checkoutinstruction) (what `subscription.checkout` holds).

| Instruction `kind` | Behaviour | Outcome |
|---|---|---|
| `redirect` | Navigates to `url` (http or https only). Used by PhonePe. | `redirecting` |
| `form_post` | Builds a hidden POST form from `fields` through the DOM and submits it. Fields are posted exactly as given. Used by PayU and Paytm. | `redirecting` |
| `razorpay_checkout` | Loads `https://checkout.razorpay.com/v1/checkout.js` once, opens it with `keyId` and `subscriptionId`. With `callbackUrl` it registers no handler and the page navigates. | `completed` (with `result`), `dismissed`, or `failed` (with `error`) |
| `cashfree_checkout` | Loads `https://sdk.cashfree.com/js/v3/cashfree.js` once, initialises it with the mode for `environment` (`sandbox` or `production`), calls `subscriptionsCheckout({ subsSessionId, redirectTarget })` | `failed` on an immediate error, otherwise `redirecting` |

Throws `SubscriptionError`: `VALIDATION` (bad instruction or options), `CONFIG` (no `window` or `document`), `PROVIDER_UNAVAILABLE` (a gateway script failed to load, or did not define its global), `PROVIDER_ERROR` (Razorpay's checkout could not be opened).

### Options

| Option | Used by | Meaning |
|---|---|---|
| `name`, `description`, `image` | Razorpay | Header text and logo |
| `theme.color` | Razorpay | Accent colour |
| `notes` | Razorpay | Free-form notes echoed back |
| `redirectTarget` | Cashfree | `_self` (default), `_blank` or `_top` |

### Outcome

| `status` | Fields | Meaning |
|---|---|---|
| `redirecting` | none | The browser is navigating, or the gateway took over the page |
| `completed` | `result` | The customer finished; POST `result` to your server and verify it |
| `dismissed` | none | The customer closed the checkout |
| `failed` | `error` | The gateway reported a failure: `code`, `message`, `description`, `source`, `step`, `reason`, `metadata` (unknown fields are kept) |

The `CheckoutStatus` constants name the four statuses.

## Other exports

`openRazorpayCheckout`, `openCashfreeCheckout`, `redirectTo`, `submitForm` (one per kind), `buildRazorpayOptions`, `loadScript`, `CASHFREE_MODE`, `ScriptUrl`, the outcome and option schemas, and the `CheckoutEnv` interface. The `env` argument lets you pass a `window` and `document` of your own, for example in tests.
