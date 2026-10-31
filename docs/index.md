# india-subscriptions

One headless API over **subscriptions and payments on Indian payment gateways and app stores**. You create a plan and a subscription, the customer authorises a mandate in the gateway's checkout, and from then on charges, retries, pauses, cancellations, refunds and webhooks all look the same whichever gateway sits underneath. One-time payments use the same shapes. A router picks the best gateway for a new purchase, and purchase sessions sell one catalog on iPhone, Android and the web, with the Apple App Store and Google Play as providers. You bring your own keys: money moves directly between the gateway or store and you, and nothing passes through anyone else.

After reading this page you will know what the library is, whether it fits, and where to go next. A developer who has never seen it should be able to ship a ₹499 a month subscription with a 14-day free trial in an afternoon by following [Your first subscription](./getting-started/first-subscription.md).

## Who it is for

- **Node and TypeScript developers.** Import the package. Every input and output is a typed Zod schema, and every status, event and error is an exported constant.
- **Everyone else.** Run `npx india-subscriptions serve` next to your application and call it over HTTP, with a client generated from its OpenAPI document. A Python client with Pydantic models is included. See [Using it from any language](./getting-started/any-language.md).

- **Mobile developers.** An iOS SDK (Swift), an Android SDK (Kotlin), a React Native library and a Flutter plugin drive the device side: Apple in-app purchase on iPhone, Google Play or Google's user choice screen with the hosted checkout on Android. They talk to your backend through the same five calls. See [Mobile apps](./guides/mobile-apps.md).

It does not hold your money, move an existing mandate to another gateway, or draw any user interface for payments: customers pay in the gateway's or the store's own screens.

## What it does

| You want to | Read |
|---|---|
| Charge a customer every month | [Your first subscription](./getting-started/first-subscription.md) |
| Take a single payment | [One-time payments](./guides/one-time-payments.md) |
| Let the library choose the best gateway | [Routing](./guides/routing.md) |
| Sell on iPhone, Android and the web with one catalog | [Selling on iPhone, Android and the web](./guides/purchases.md) |
| Ask what a customer owns, across stores and gateways | [Entitlements](./concepts/entitlements.md) |
| Keep billing state in PostgreSQL, shared by several servers | [PostgreSQL stores](./reference/postgres.md) |

## Gateways and stores

| Provider | Kind | Who raises each recurring debit | One-time payments |
|---|---|---|---|
| [Razorpay](./gateways/razorpay.md) | Gateway | Razorpay | Yes |
| [Cashfree](./gateways/cashfree.md) | Gateway | Cashfree (periodic plans) or this library (on-demand plans) | Yes |
| [PayU](./gateways/payu.md) | Gateway | This library | Yes |
| [PhonePe](./gateways/phonepe.md) | Gateway | This library | Yes |
| [Paytm](./gateways/paytm.md) | Gateway | This library by default, or Paytm for plain fixed plans | Yes |
| [Apple App Store](./gateways/app-store.md) | Store | Apple | Yes (consumables and non-consumables) |
| [Google Play](./gateways/google-play.md) | Store | Google | Yes |

A gateway is chosen by you or by the [router](./guides/routing.md). A store is where the product lives and the purchase starts on the device: [purchase sessions](./guides/purchases.md) use the App Store for iOS and Google Play for Android.

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
| Take a one-time payment | [One-time payments](./guides/one-time-payments.md) |
| Choose the best gateway for each purchase | [Routing](./guides/routing.md) |
| Sell on iPhone, Android and the web | [Selling on iPhone, Android and the web](./guides/purchases.md) |
| Set up the App Store or Google Play | [Setting up the App Store](./guides/setting-up-app-store.md), [Setting up Google Play](./guides/setting-up-google-play.md) |
| Build a mobile app with the iOS SDK, the Android SDK, React Native or Flutter | [Mobile apps](./guides/mobile-apps.md) |
| Run the billing scheduler | [Running the scheduler](./guides/scheduler.md) |
| Look something up | [Reference](./reference/index.md) |
| Add a gateway | [Adding a gateway](./contributing/adding-a-gateway.md) |

## How the documentation is kept honest

The reference pages (every model, every route, every environment variable, every error code, the capability matrix, and the routing and purchase defaults) are generated from the code, and a test fails when they drift. The code samples are extracted from these pages, type-checked against the real entry points, and the main flows are executed against scripted gateway responses.
