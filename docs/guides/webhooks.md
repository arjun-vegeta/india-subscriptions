# Handling webhooks

After this page you will have a webhook route that verifies, de-duplicates and reacts correctly, and you will avoid the one mistake that breaks almost every first attempt: not passing the raw body.

A **webhook** is the gateway calling your server to tell you something happened after the customer left: a charge succeeded, a card failed, the retries ran out. `subs.webhooks.handle` verifies the gateway's signature, normalises the payload into [events](../concepts/events.md) and applies them to the billing scheduler if there is one. `subs.webhooks.parse` does the same without touching the scheduler and stores nothing.

## Pass the raw body

The signature is computed over the exact bytes the gateway sent. If your framework parses the JSON and you serialise it again, key order, spacing or escaping change and the signature no longer verifies. Every framework has a way to read the raw body:

| Framework | How to get the raw body |
|---|---|
| Express | `express.raw({ type: '*/*' })` on the webhook route, registered **before** `express.json()`. `req.body` is then a `Buffer`: `req.body.toString('utf8')`. |
| Next.js route handler | `await request.text()` before anything calls `request.json()`. |
| Fastify | Add a content-type parser with `parseAs: 'string'` for the webhook route. |
| NestJS | Create the app with `rawBody: true` and read `request.rawBody`. |
| Hono, Cloudflare Workers, Deno, Bun | `await request.text()` (or `c.req.text()`). |
| AWS Lambda behind API Gateway | `event.body`, base64-decoded when `event.isBase64Encoded` is true. |
| Python (Flask, FastAPI) | `request.get_data()` or `await request.body()`, before any JSON parsing. |
| Any proxy | Make sure it does not re-encode the body or change its charset. |

PayU's payment webhooks are **form-encoded**, not JSON. Pass the body string through as it is. The same applies to headers: pass them with lower-case names. Node and `Headers` already do.

## The route

```ts
import express from 'express';
import { ErrorCode, EventType, Provider, isSubscriptionError, type SubscriptionEvent } from 'india-subscriptions';
import { subs } from './billing';

const seen = new Set<string>(); // use a database table with a unique key in production

async function react(event: SubscriptionEvent): Promise<void> {
  if (seen.has(event.id)) return; // gateways deliver the same event more than once
  switch (event.type) {
    case EventType.SubscriptionCharged:
      console.log(`paid ${event.charge?.amount} paise for ${event.subscriptionId}`);
      break;
    case EventType.SubscriptionHalted:
      console.log(`suspend ${event.subscriptionId}`);
      break;
    default:
      break;
  }
  seen.add(event.id);
}

const app = express();

app.post('/webhooks/razorpay', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const events = await subs.webhooks.handle(Provider.Razorpay, {
      rawBody: req.body.toString('utf8'),
      headers: req.headers,
    });
    for (const event of events) await react(event);
    res.sendStatus(200);
  } catch (error) {
    if (isSubscriptionError(error) && error.code === ErrorCode.SignatureInvalid) {
      res.sendStatus(401); // forged, or the wrong secret: nothing in it is trusted
      return;
    }
    res.sendStatus(500); // ask the gateway to retry
  }
});
```

Rules for the route:

- **Answer fast.** Razorpay requires a 2xx within 5 seconds and treats anything else as a failed delivery. Record the event and do slow work (e-mail, provisioning) afterwards, from a queue.
- **Answer 2xx only after the event is safely stored.** Otherwise a crash loses it and the gateway will not send it again.
- **Return a non-2xx for a failure you want retried.** Razorpay retries for 24 hours with exponential backoff, then disables the webhook; the Dashboard emails you.
- **Answer 401 for a bad signature.** A `CONFIG` error means the webhook secret is not configured.

## De-duplicate on `event.id`

Delivery is at least once. Keep the ids you have processed (a table with a unique key is best, inserted in the same transaction as your change) and skip repeats. Ids come from the gateway where it has one (Razorpay's `x-razorpay-event-id`) and are built deterministically where it does not (Cashfree, PayU).

## What to do on each event

| Event | Do |
|---|---|
| `subscription.authorized`, `subscription.activated` | Record that the mandate is live. Grant access if you have not. |
| `subscription.charged` | Record the payment (`event.charge`) and extend access. |
| `subscription.charge_failed`, `subscription.past_due` | Tell the customer; keep or limit access by your grace policy. |
| `subscription.halted` | Suspend access; ask for a new payment method. |
| `subscription.paused`, `subscription.resumed` | Mirror it. |
| `subscription.cancelled`, `subscription.completed`, `subscription.expired` | End access. |
| `subscription.updated` | Re-read the subscription with `subs.get`. |
| `refund.succeeded`, `refund.failed` | Update the refund record. |
| `unknown` | Ignore, or inspect `event.raw`. |

Do not trust ordering. When the decision matters (granting or revoking access), read the current state with `subs.get` instead of acting on the event alone.

## Missing a webhook

Gateways stop retrying eventually, and Cashfree does not replay at all. Run a periodic job that reads the subscriptions you consider active with `subs.get` and reconciles them. For merchant-scheduled gateways the scheduler already polls the gateway for charge outcomes, so use its [events](../concepts/events.md) for debits.

## Gateway specifics

- **Razorpay:** `x-razorpay-signature` is `HMAC_SHA256(webhookSecret, rawBody)`. Set `webhookSecret`, or every webhook is rejected. [Details](../gateways/razorpay.md#webhooks).
- **Cashfree:** subscription webhooks are configured on a separate tab of the Dashboard. The timestamp header's format is undocumented, so no replay window is enforced. [Details](../gateways/cashfree.md#webhooks).
- **PayU:** payment, card-mandate and UPI-mandate webhooks are signed; the eNACH cancellation and refund webhooks are not, and are `unknown` unless you set `acceptUnsignedWebhooks` behind an address allow-list. [Details](../gateways/payu.md#webhooks).

For the HTTP service and other languages, see [Using it from any language](../getting-started/any-language.md).
