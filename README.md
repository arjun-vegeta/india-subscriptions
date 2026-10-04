# india-subscriptions

One headless API for subscriptions on Indian payment gateways: plans, free
trials, upfront amounts, mandate authorisation, recurring charges, pause,
resume, cancel, refunds and webhooks. You bring your own gateway keys
(Razorpay, Cashfree, PayU, PhonePe or Paytm); money always moves directly
between the gateway and you.

- **Node / TypeScript**: import the package.
- **Any other language**: run the same code as a small self-hosted HTTP
  service and call it with a client generated from its OpenAPI document. A
  Python client with Pydantic models is included.

## Documentation

Start with [Your first subscription](docs/getting-started/first-subscription.md)
or read [the overview](docs/index.md). The `docs/` folder is also a VitePress
site: see [docs/README.md](docs/README.md).

| You want to | Read |
|---|---|
| Install and build the full flow | [Installation](docs/getting-started/installation.md), [Your first subscription](docs/getting-started/first-subscription.md) |
| Use it from Python or any language | [Using it from any language](docs/getting-started/any-language.md) |
| Understand mandates, trials, statuses, the scheduler | [Concepts](docs/concepts/recurring-payments.md) |
| Pick a gateway | [Razorpay](docs/gateways/razorpay.md), [Cashfree](docs/gateways/cashfree.md), [PayU](docs/gateways/payu.md), [PhonePe](docs/gateways/phonepe.md), [Paytm](docs/gateways/paytm.md) |
| Go live | [Going-live checklist](docs/guides/going-live.md) |
| Look things up | [Reference](docs/reference/index.md) |

## What each gateway supports

| | Razorpay | Cashfree | PayU | PhonePe | Paytm |
|---|---|---|---|---|---|
| Who raises each recurring debit | Razorpay | Cashfree (periodic plans) or this library (on-demand) | This library | This library | This library (default), or Paytm for fixed plans |
| Free trial | Yes | Yes | Yes, with a ₹2 consent debit | Yes, with a ₹2 verification debit | Yes |
| Upfront amount at sign-up | Yes | UPI and cards only | Yes | Yes | Yes (not eNACH-only) |
| Quantity | Yes | No | No | No | No |
| Pause and resume | Yes | Yes (on-demand through the scheduler) | Through the scheduler | Through the scheduler; the customer in their UPI app | Yes |
| Cancel at period end | Yes | No | No | No | No |
| Change plan | Yes (not UPI or bank mandates) | Periodic plans | No | No | No |
| Refunds | Yes | Yes | Yes (not eNACH) | Yes | Yes (not eNACH) |
| Signed webhooks | Yes | Yes | Payments and card/UPI mandates only | Sender hash only; the body is not covered | Yes |
| Payment methods | UPI Autopay, cards, eMandate | UPI Autopay, cards, eNACH | UPI Autopay, cards, eNACH | UPI Autopay | UPI Autopay, cards, eNACH |

The table is a summary. `subs.capabilities(provider)` returns the same
information at runtime, and the generated
[capability matrix](docs/reference/generated/capabilities.md) is read from the
adapters themselves.

**A mandate stays with the gateway that created it.** A UPI Autopay or eNACH
mandate set up through Razorpay can only be debited through Razorpay. You
choose the gateway when a subscription starts, not for each renewal.

## Install

```bash
npm install india-subscriptions
```

Requires Node 18.17 or later. The only runtime dependency is `zod`.

## Quick start

```ts
import { createSubscriptions, razorpay, IntervalUnit, Provider } from 'india-subscriptions';
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

// 1. Create a ₹499/month subscription with a 14-day free trial.
export function startTrial(customer: Customer) {
  return subs.create(Provider.Razorpay, {
    reference: 'order_1042', // your own id
    plan: {
      name: 'Pro monthly',
      amount: 49900, // paise
      interval: { unit: IntervalUnit.Month, count: 1 },
    },
    customer,
    trial: { days: 14 },
  });
}

// 2. Send subscription.checkout to the browser; the customer authorises there.
// 3. The browser posts the gateway's result back to your server:
export async function finish(resultFromBrowser: CheckoutResult, subscriptionId: string) {
  const verification = await subs.verifyCheckout(Provider.Razorpay, resultFromBrowser, {
    expectedSubscriptionId: subscriptionId,
  });
  return verification.authorized; // store verification.subscriptionId against your customer
}
```

Amounts are always integers in paise. Instants are ISO-8601 strings. Every
status, event and error code is an exported constant (`SubscriptionStatus`,
`EventType`, `ErrorCode`, ...); every input and output is a Zod schema you can
import. An operation a gateway cannot do throws `SubscriptionError` with code
`UNSUPPORTED`.

### In the browser

```ts
import { CheckoutStatus, openCheckout } from 'india-subscriptions/checkout';
import type { CheckoutInstruction } from 'india-subscriptions/checkout';

export async function authorise(checkout: CheckoutInstruction) {
  const outcome = await openCheckout(checkout, { name: 'Acme' });
  if (outcome.status === CheckoutStatus.Completed) {
    await fetch('/api/subscriptions/verify', { method: 'POST', body: JSON.stringify(outcome.result) });
  }
}
```

`openCheckout` handles all four instruction kinds: a redirect, an
auto-submitted form (PayU), Razorpay Standard Checkout and Cashfree.js. It never
sees a secret. See [Checkout in the browser](docs/guides/checkout.md).

### Webhooks

Pass the **raw** request body: re-serialised JSON will not verify. See
[Handling webhooks](docs/guides/webhooks.md) for every framework.

```ts
import express from 'express';
import { EventType, Provider } from 'india-subscriptions';
import { subs } from './billing';

const app = express();

app.post('/webhooks/razorpay', express.raw({ type: '*/*' }), async (req, res) => {
  const events = await subs.webhooks.handle(Provider.Razorpay, {
    rawBody: req.body.toString('utf8'),
    headers: req.headers,
  });
  for (const event of events) {
    // event.id is stable: use it to ignore duplicate deliveries
    if (event.type === EventType.SubscriptionCharged) { /* extend access */ }
    if (event.type === EventType.SubscriptionHalted) { /* suspend access */ }
  }
  res.sendStatus(200);
});
```

### Managing a subscription

See [Managing subscriptions](docs/guides/managing-subscriptions.md) for what
each gateway allows.

```ts
import { CancelMode, ChangeTiming, Provider } from 'india-subscriptions';
import { subs } from './billing';

export async function manage(id: string, chargeId: string) {
  await subs.get(Provider.Razorpay, id);
  await subs.pause(Provider.Razorpay, id);
  await subs.resume(Provider.Razorpay, id);
  await subs.update(Provider.Razorpay, id, { planId: 'plan_new', timing: ChangeTiming.AtPeriodEnd });
  await subs.cancel(Provider.Razorpay, id, { mode: CancelMode.AtPeriodEnd });
  await subs.charges.list(Provider.Razorpay, id);
  await subs.charges.refund(Provider.Razorpay, { chargeId, refundId: 'refund_1' });
}
```

## Trials and upfront amounts

A free trial means the customer authorises the mandate now and the first
recurring charge happens when the trial ends: `trial: { days: 14 }` or
`trial: { endsAt: '2026-12-01T00:00:00+05:30' }`. Use `startAt` instead to
delay the first charge without calling it a trial. While nothing has been
charged yet the subscription's status is `trialing`. `upfrontAmount` collects a
one-off amount (a setup fee, or a paid trial) together with the authorisation.

Gateways take a small verification debit when a mandate is set up. Razorpay
and Cashfree refund it automatically; PayU's ₹2 consent debit is not refunded
automatically. See [Trials, delayed starts and upfront amounts](docs/concepts/trials.md).

## Gateways that expect you to raise each debit

PayU, PhonePe, Paytm (by default) and Cashfree on-demand plans hold the customer's mandate but do not
schedule charges. For these the library includes a billing scheduler that
sends the advance notice RBI rules require, raises each debit, retries
failures, and never debits twice for one cycle. See
[Running the scheduler](docs/guides/scheduler.md).

```ts
import { createSubscriptions, payu, MemorySchedulerStore, Environment } from 'india-subscriptions';

export const subs = createSubscriptions({
  providers: [
    payu({
      key: process.env.PAYU_KEY!,
      salt: process.env.PAYU_SALT!,
      environment: Environment.Test,
      successUrl: 'https://shop.example.com/payu/success',
      failureUrl: 'https://shop.example.com/payu/failure',
    }),
  ],
  scheduler: { store: new MemorySchedulerStore() },
});

// From a cron job, every few minutes:
export function tick() {
  return subs.tick();
}
```

`MemorySchedulerStore` loses everything on restart and is for development
only. For one server process use `FileSchedulerStore` from
`india-subscriptions/server`; for several, implement the `SchedulerStore`
interface on your database (a PostgreSQL example is in the guide).

## Other languages

```bash
npx india-subscriptions serve
```

This starts the HTTP service, configured through environment variables (see
[.env.example](.env.example) and the generated
[reference](docs/reference/generated/environment.md)). It listens on
`127.0.0.1` and refuses to start without `INDIA_SUBSCRIPTIONS_API_KEY`, because
it holds live gateway credentials. Run it next to your application, never on
the public internet, apart from the gateway webhook routes
(`POST /v1/{provider}/webhooks`), which are authenticated by the gateway's own
signature.

- Set `EVENTS_WEBHOOK_URL` and `EVENTS_WEBHOOK_SECRET` and the service posts
  normalised events to your application, signed with HMAC-SHA256 over
  `<timestamp>.<raw body>`. See
  [Using it from any language](docs/getting-started/any-language.md).
- The OpenAPI 3.1 document is served at `/v1/openapi.json` and committed at
  [openapi/openapi.json](openapi/openapi.json).
- A Python client with Pydantic models is in [clients/python](clients/python).

```python
from india_subscriptions import SubscriptionsClient
from india_subscriptions.models import Provider

client = SubscriptionsClient(base_url="http://127.0.0.1:8787", api_key="...")
subscription = client.subscriptions.get(Provider.RAZORPAY, "sub_00000000000001")
```

## Statuses and errors

`created`, `pending_authorization`, `trialing`, `active`, `past_due`,
`halted`, `paused`, and the terminal `cancelled`, `completed`, `expired`,
`failed`: see [The subscription lifecycle](docs/concepts/lifecycle.md) for what
each means and what your app should do. The gateway's own status is always
available verbatim as `providerStatus`, and its full response as `raw`.

Everything thrown is a `SubscriptionError` with a `code` from `ErrorCode`. Two
matter most: `OUTCOME_UNKNOWN` (a request that moves money was sent and no
answer came back: fetch the current state before retrying) and
`SIGNATURE_INVALID` (a webhook or checkout result did not verify; nothing from
it is trusted). See [Errors](docs/concepts/errors.md).

## Not included

- Routing a new payment to the best gateway, and one-time payments.
- Native mobile SDKs.
- PayU's own scheduler product (ZION), Cashfree paper mandates.

## Development

```bash
npm install
```

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run build
```

After changing a schema, route, environment variable, error code or an
adapter's capabilities, run `npm run docs:reference`. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the code rules and
[Adding a gateway](docs/contributing/adding-a-gateway.md).

## License

MIT
