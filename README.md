# india-subscriptions

One headless API for subscriptions on Indian payment gateways: plans, free
trials, upfront amounts, mandate authorisation, recurring charges, pause,
resume, cancel, refunds and webhooks. You bring your own Razorpay, Cashfree or
PayU keys; money always moves directly between the gateway and you.

- **Node / TypeScript**: import the package.
- **Any other language**: run the same code as a small self-hosted HTTP
  service and call it with a client generated from its OpenAPI document. A
  Python client with Pydantic models is included.

## What each gateway supports

| | Razorpay | Cashfree | PayU |
|---|---|---|---|
| Who raises each recurring debit | Razorpay | Cashfree (periodic plans) or this library (on-demand plans) | This library |
| Free trial | Yes | Yes | Yes, with a ₹2 consent debit |
| Upfront amount at sign-up | Yes | UPI and cards only | Yes |
| Quantity | Yes | No | No |
| Pause and resume | Yes | Yes | Yes, through the scheduler |
| Cancel at period end | Yes | No | No |
| Change plan | Yes (not for UPI or bank mandates) | Periodic plans | No |
| Refunds | Yes | Yes | Yes |
| Signed webhooks | Yes | Yes | Payments and card/UPI mandates only |
| Payment methods | UPI Autopay, cards, eMandate | UPI Autopay, cards, eNACH | UPI Autopay, cards, eNACH |

`subs.capabilities(provider)` returns the same information at runtime, so your
code never has to guess.

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
import {
  createSubscriptions,
  razorpay,
  IntervalUnit,
  Provider,
} from 'india-subscriptions';

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
const subscription = await subs.create(Provider.Razorpay, {
  reference: 'order_1042', // your own id
  plan: {
    name: 'Pro monthly',
    amount: 49900, // paise
    interval: { unit: IntervalUnit.Month, count: 1 },
  },
  customer: { name: 'Asha Rao', email: 'asha@example.com', phone: '9876543210' },
  trial: { days: 14 },
});

// 2. Send subscription.checkout to the browser; the customer authorises there.
// 3. The browser posts the gateway's result back to your server:
const verification = await subs.verifyCheckout(Provider.Razorpay, resultFromBrowser, {
  expectedSubscriptionId: subscription.id,
});
if (verification.authorized) {
  // store verification.subscriptionId against your customer
}
```

Amounts are always integers in paise. Instants are ISO-8601 strings. Every
status, event and error code is an exported constant (`SubscriptionStatus`,
`EventType`, `ErrorCode`, …); every input and output is a Zod schema you can
import.

### In the browser

```ts
import { openCheckout } from 'india-subscriptions/checkout';

const outcome = await openCheckout(subscription.checkout, { name: 'Acme' });
if (outcome.status === 'completed') {
  await fetch('/api/subscriptions/verify', { method: 'POST', body: JSON.stringify(outcome.result) });
}
```

`openCheckout` handles all four instruction kinds: a redirect, an auto-submitted
form (PayU), Razorpay Standard Checkout and Cashfree.js. It never sees a secret.

### Webhooks

Pass the **raw** request body. Re-serialised JSON will not verify.

```ts
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

```ts
await subs.get(Provider.Razorpay, id);
await subs.pause(Provider.Razorpay, id);
await subs.resume(Provider.Razorpay, id);
await subs.update(Provider.Razorpay, id, { planId: 'plan_new', timing: ChangeTiming.AtPeriodEnd });
await subs.cancel(Provider.Razorpay, id, { mode: CancelMode.AtPeriodEnd });
await subs.charges.list(Provider.Razorpay, id);
await subs.charges.refund(Provider.Razorpay, { chargeId, refundId: 'refund_1' });
```

An operation a gateway cannot do throws `SubscriptionError` with code
`UNSUPPORTED`.

## Trials and upfront amounts

A free trial means the customer authorises the mandate now and the first
recurring charge happens when the trial ends: `trial: { days: 14 }` or
`trial: { endsAt: '2026-12-01T00:00:00+05:30' }`. Use `startAt` instead to
delay the first charge without calling it a trial. While nothing has been
charged yet the subscription's status is `trialing`.

`upfrontAmount` collects a one-off amount (a setup fee, or a paid trial)
together with the authorisation.

Gateways take a small verification debit when a mandate is set up. Razorpay
and Cashfree refund it automatically; PayU's ₹2 consent debit is not refunded
automatically.

## Gateways that expect you to raise each debit

PayU, and Cashfree on-demand plans, hold the customer's mandate but do not
schedule charges. For these the library includes a billing scheduler that
sends the advance notice RBI rules require, raises each debit, retries
failures, and never debits twice for one cycle.

```ts
import { createSubscriptions, payu, MemorySchedulerStore, Environment } from 'india-subscriptions';

const subs = createSubscriptions({
  providers: [payu({ key, salt, environment: Environment.Test, successUrl, failureUrl })],
  scheduler: { store: new MemorySchedulerStore() },
});

// From a cron job, every few minutes:
await subs.tick();
```

`MemorySchedulerStore` loses everything on restart and is for development
only. For one server process use `FileSchedulerStore` from
`india-subscriptions/server`; for several, implement the `SchedulerStore`
interface on your database. Everything else (`create`, `get`, `pause`,
`cancel`, webhooks) is the same as for any other gateway.

## Other languages

```bash
npx india-subscriptions serve
```

This starts the HTTP service, configured through environment variables (see
[.env.example](.env.example)). It listens on `127.0.0.1` and refuses to start
without `INDIA_SUBSCRIPTIONS_API_KEY`, because it holds live gateway
credentials. Run it next to your application, never on the public internet,
apart from the gateway webhook routes (`POST /v1/{provider}/webhooks`), which
are authenticated by the gateway's own signature.

- The OpenAPI 3.1 document is served at `/v1/openapi.json` and committed at
  [openapi/openapi.json](openapi/openapi.json). Generate a client for your
  language from it.
- A Python client with Pydantic models is in
  [clients/python](clients/python).

```python
from india_subscriptions import SubscriptionsClient
from india_subscriptions.models import Provider

client = SubscriptionsClient(base_url="http://127.0.0.1:8787", api_key=API_KEY)
subscription = client.subscriptions.get(Provider.razorpay, "sub_00000000000001")
```

## Statuses

| Status | Meaning |
|---|---|
| `created` | Created; the customer has not authorised yet |
| `pending_authorization` | Customer approved; the bank has not confirmed the mandate |
| `trialing` | Mandate live; first charge is in the future |
| `active` | Charges are being collected |
| `past_due` | A charge failed and is being retried |
| `halted` | Retries exhausted; no further automatic charges |
| `paused` | Paused by you or the customer |
| `cancelled`, `completed`, `expired`, `failed` | Ended |

The gateway's own status is always available verbatim as `providerStatus`, and
its full response as `raw`.

## Errors

Everything thrown is a `SubscriptionError` with a `code` from `ErrorCode`.
Two matter most:

- `OUTCOME_UNKNOWN`: a request that moves money was sent and no answer came
  back. It may or may not have happened. Fetch the current state before
  retrying.
- `SIGNATURE_INVALID`: a webhook or checkout result did not verify. Nothing
  from it is trusted.

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

See [CONTRIBUTING.md](CONTRIBUTING.md) for the code rules and how to add a
gateway.

## License

MIT
