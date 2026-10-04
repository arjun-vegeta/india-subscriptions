# india-subscriptions

One headless API over **recurring payments on Indian payment gateways**. You create a plan and a subscription, the customer authorises a mandate in the gateway's checkout, and from then on charges, retries, pauses, cancellations, refunds and webhooks all look the same whichever gateway sits underneath. You bring your own gateway keys: money moves directly between the gateway and you, and nothing passes through anyone else.

After reading this page you will know what the library is, whether it fits, how far to trust it today, and where to go next. A developer who has never seen it should be able to ship a ₹499 a month subscription with a 14-day free trial in an afternoon by following [Your first subscription](./getting-started/first-subscription.md).

## Who it is for

- **Node and TypeScript developers.** Import the package. Every input and output is a typed Zod schema, and every status, event and error is an exported constant.
- **Everyone else.** Run `npx india-subscriptions serve` next to your application and call it over HTTP, with a client generated from its OpenAPI document. A Python client with Pydantic models is included. See [Using it from any language](./getting-started/any-language.md).

It does not route a new payment to the best gateway, take one-time payments, or provide native mobile SDKs. It handles the recurring part only.

## Gateways

| Gateway | Who raises each debit |
|---|---|
| [Razorpay](./gateways/razorpay.md) | Razorpay |
| [Cashfree](./gateways/cashfree.md) | Cashfree (periodic plans) or this library (on-demand plans) |
| [PayU](./gateways/payu.md) | This library |
| [PhonePe](./gateways/phonepe.md) | This library |
| [Paytm](./gateways/paytm.md) | This library by default, or Paytm for plain fixed plans |

## Sixty seconds

```ts
import { createSubscriptions, IntervalUnit, Provider, razorpay } from 'india-subscriptions';
import type { CheckoutResult, Customer } from 'india-subscriptions';

const subs = createSubscriptions({
  providers: [
    razorpay({
      keyId: process.env.RAZORPAY_KEY_ID!,
      keySecret: process.env.RAZORPAY_KEY_SECRET!,
      webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
    }),
  ],
});

// 1. Create a ₹499 a month subscription with a 14-day free trial. Amounts are paise.
export async function startTrial(customer: Customer) {
  return subs.create(Provider.Razorpay, {
    reference: 'order_1042', // your own id
    plan: { name: 'Pro monthly', amount: 49900, interval: { unit: IntervalUnit.Month, count: 1 } },
    customer,
    trial: { days: 14 },
  });
  // 2. Send subscription.checkout to the browser; the customer authorises there.
}

// 3. The browser posts the gateway's result back to your server:
export async function finish(resultFromBrowser: CheckoutResult, subscriptionId: string) {
  const verification = await subs.verifyCheckout(Provider.Razorpay, resultFromBrowser, {
    expectedSubscriptionId: subscriptionId,
  });
  return verification.authorized;
}
```

That is the whole shape. The rest of the documentation is about doing it safely: the browser half, webhooks, scheduling for gateways that need it, and going live.

## Where to go next

| You want to | Read |
|---|---|
| Install it | [Installation](./getting-started/installation.md) |
| Build the full flow in Express or Next.js | [Your first subscription](./getting-started/first-subscription.md) |
| Use it from Python, Go or anything else | [Using it from any language](./getting-started/any-language.md) |
| Understand mandates, UPI Autopay, eNACH and the Rs 15,000 rule | [How recurring payments work in India](./concepts/recurring-payments.md) |
| See every status and what your app should do | [The subscription lifecycle](./concepts/lifecycle.md) |
| Pick a gateway | [Razorpay](./gateways/razorpay.md), [Cashfree](./gateways/cashfree.md), [PayU](./gateways/payu.md), [PhonePe](./gateways/phonepe.md), [Paytm](./gateways/paytm.md) |
| Run the billing scheduler | [Running the scheduler](./guides/scheduler.md) |
| Look something up | [Reference](./reference/index.md) |
| Add a gateway | [Adding a gateway](./contributing/adding-a-gateway.md) |

## How the documentation is kept honest

The reference pages (every model, every route, every environment variable, every error code and the capability matrix) are generated from the code, and a test fails when they drift. The code samples are extracted from these pages, type-checked against the real entry points, and the main flows are executed against scripted gateway responses.
