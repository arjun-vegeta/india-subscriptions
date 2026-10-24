# Handling webhooks

After this page you will have a webhook route that verifies, de-duplicates and reacts correctly, and you will avoid the one mistake that breaks almost every first attempt: not passing the raw body.

A **webhook** is the gateway or the store calling your server to tell you something happened after the customer left: a charge succeeded, a payment was captured, a card failed, the retries ran out, a renewal happened in the App Store. `subs.webhooks.handle` verifies the signature, normalises the payload into [events](../concepts/events.md) and applies them to the billing scheduler and to [purchase sessions](./purchases.md) if you have them. `subs.webhooks.parse` does the same verification without applying anything and stores nothing. Both return a promise: some adapters verify with a network call (Google's signing keys) or read the current state of the object the event names, so `await` them.

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

The stores are the same, with one difference in where the proof is:

- **App Store.** Apple posts `{ "signedPayload": "..." }`. The proof is the JWS inside the body, verified against Apple's certificate chain, so no header matters. Pass the raw body and `headers: {}` is enough.
- **Google Play.** Google publishes to Pub/Sub, and a push subscription posts to your route with `Authorization: Bearer <Google-signed token>`. The adapter verifies that token, so **pass the `authorization` header**. Without push authentication configured the webhook is refused.

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
| `payment.succeeded` | A one-time payment was captured. Fulfil the order (after matching `event.paymentId` against the id you stored). |
| `payment.failed` | A payment attempt failed. The customer can often retry on the same order, so read the payment with `subs.payments.get` before giving up. |
| `refund.succeeded`, `refund.failed` | Update the refund record. |
| `unknown` | Ignore, or inspect `event.raw`. |

Do not trust ordering. When the decision matters (granting or revoking access), read the current state with `subs.get` instead of acting on the event alone.

## Payments, and stores

Payment events carry `paymentId` and `payment`; [One-time payments](./one-time-payments.md#webhooks) has the route. Match the id against the payments you created: a gateway account also sends events for payments made outside this library.

Store notifications use the same events. An App Store `DID_RENEW` is `subscription.charged`, a Google Play `SUBSCRIPTION_RENEWED` is `subscription.charged`, and a refund is `refund.succeeded` with the refunded `chargeId` or `paymentId`. Some things only the customer does in the store (cancelling, changing the product) arrive as `subscription.updated`, `subscription.cancelled` or `subscription.expired`; the lists are on [Apple App Store](../gateways/app-store.md#notifications) and [Google Play](../gateways/google-play.md#webhooks).

If you use purchase sessions, route every provider's webhook through `subs.webhooks.handle` and you do not interpret these events yourself: entitlements follow them, and for purchases made through Google's user choice billing renewals and refunds are queued as reports to Google. If one of the consumers fails, `handle` rejects, so the provider delivers the webhook again; every consumer is idempotent.

## Missing a webhook

Gateways stop retrying eventually, and Cashfree does not replay at all. Run a periodic job that reads the subscriptions you consider active with `subs.get` and reconciles them. For merchant-scheduled gateways the scheduler already polls the gateway for charge outcomes, so use its [events](../concepts/events.md) for debits.

## Gateway specifics

- **Razorpay:** `x-razorpay-signature` is `HMAC_SHA256(webhookSecret, rawBody)`. Set `webhookSecret`, or every webhook is rejected. [Details](../gateways/razorpay.md#webhooks).
- **Cashfree:** subscription webhooks are configured on a separate tab of the Dashboard. The timestamp header's format is undocumented, so no replay window is enforced. [Details](../gateways/cashfree.md#webhooks).
- **PayU:** payment, card-mandate and UPI-mandate webhooks are signed; the eNACH cancellation and refund webhooks are not, and are `unknown` unless you set `acceptUnsignedWebhooks` behind an address allow-list. [Details](../gateways/payu.md#webhooks).
- **App Store:** every notification is a signed JWS; reply `200` once handled, and Apple retries a failure in production. [Details](../gateways/app-store.md#notifications).
- **Google Play:** the push subscription must have authentication on; reply a success code once handled, or Pub/Sub sends it again. [Details](../gateways/google-play.md#webhooks).

For the HTTP service and other languages, see [Using it from any language](../getting-started/any-language.md).
