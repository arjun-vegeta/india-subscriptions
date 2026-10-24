# Errors

After this page you will know what the library throws, how to branch on it, and the one error that must never be retried blindly.

Everything the library throws is a `SubscriptionError`. Branch on its `code`, a stable constant from `ErrorCode`, and never on the message.

```ts
import { ErrorCode, Provider, createSubscriptions, isSubscriptionError, razorpay } from 'india-subscriptions';

const subs = createSubscriptions({
  providers: [razorpay({ keyId: process.env.RAZORPAY_KEY_ID!, keySecret: process.env.RAZORPAY_KEY_SECRET! })],
});

export async function currentStatus(subscriptionId: string) {
  try {
    return (await subs.get(Provider.Razorpay, subscriptionId)).status;
  } catch (error) {
    if (!isSubscriptionError(error)) throw error;
    if (error.code === ErrorCode.NotFound) return undefined;
    if (error.retryable) throw new Error(`try again later: ${error.code}`);
    throw error;
  }
}
```

| Property | Meaning |
|---|---|
| `code` | The `ErrorCode`. |
| `message` | For people. It never contains a secret and may change between releases. |
| `provider` | The gateway involved, where one was. |
| `httpStatus` | The gateway's HTTP status, when it answered. |
| `providerCode` | The gateway's own error code, verbatim. |
| `raw` | The gateway's body, or the validation issues. |
| `retryable` | True when repeating the same call later is safe and may succeed. |

## The two that matter most

- **`OUTCOME_UNKNOWN`.** A request that moves money was sent and no answer came back. It may or may not have happened. **Do not repeat it.** Fetch the current state, then decide. See [Scheduling](./scheduling.md#what-an-unknown-outcome-means).
- **`SIGNATURE_INVALID`.** A webhook or a checkout result did not verify, or it was genuine but belongs to a different subscription than the one you expected. Nothing from it is trusted. Answer 401 to a webhook.

## Errors of routing and purchases

- **`NO_ROUTE`.** No configured gateway can take this purchase: the router excluded every one of them (for example because none offers the payment method, none can do a trial, or the amount is above every limit you set). The message lists why each gateway was excluded; `subs.router.route` and `purchases.start` raise it. Configure another gateway, or relax the request. It is not retryable as it stands. Over HTTP it is a 422. See [Routing](../guides/routing.md#read-a-decision).
- **`CONFLICT` from `purchases.start`.** The customer already owns the product, or another operation on the session is running. Read the entitlements before you decide. See [Selling on iPhone, Android and the web](../guides/purchases.md#one-product-once).
- **`CONFIG` for a purchase configuration.** The catalog or platform policy cannot be served (a product without its store mapping, user choice billing without a gateway, a missing tax rate). It lists every problem at once, when `Purchases` is built or the service starts.
- **`VALIDATION` at `start`.** The product is not sold on that platform, or user choice billing needs `customer.state`.
- **`SIGNATURE_INVALID` at `complete`.** The result belongs to another order than the one the session created. The session stays as it was.

## All codes

The [generated error reference](../reference/generated/errors.md) lists every code: what it means, what to do, whether it is retryable and the HTTP status the service uses.

## Errors over HTTP

The service answers every error with the same body, `{"error": {"code", "message", "provider?", "httpStatus?", "providerCode?", "retryable"}}`, and a status taken from the code: for example 400 for `VALIDATION`, 401 for `SIGNATURE_INVALID`, 404 for `NOT_FOUND`, 409 for `CONFLICT`, 422 for `UNSUPPORTED`, 504 for `OUTCOME_UNKNOWN`. A gateway that rejects your credentials is a **502** (`AUTH`), not a 401: the 401 is for the caller of the service. The Python client raises `SubscriptionsApiError` with the same `code`.
