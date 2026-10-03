# The client

`createSubscriptions` returns a `Subscriptions` client: one entry point over every configured gateway. Each method takes the gateway as its first argument and otherwise speaks only the unified [models](./generated/models.md). Every method that returns a promise **rejects**: none throws synchronously, not even for an unknown gateway. Everything thrown is a `SubscriptionError` (see [Errors](./generated/errors.md)).

```ts
import { createSubscriptions, razorpay } from 'india-subscriptions';

export const subs = createSubscriptions({
  providers: [razorpay({ keyId: process.env.RAZORPAY_KEY_ID!, keySecret: process.env.RAZORPAY_KEY_SECRET! })],
});
```

## `createSubscriptions(options)`

| Option | Meaning |
|---|---|
| `providers` | The gateway adapters: `razorpay(...)`, `cashfree(...)`, `payu(...)`. At least one. A gateway listed twice throws `CONFIG`. |
| `scheduler` | Optional. A ready `BillingScheduler`, or just its options (`store`, `onEvent`, `now`, policy defaults): the client then builds the scheduler for exactly the providers above. Required to create merchant-scheduled subscriptions. See [the billing scheduler](./scheduler.md). |

Each adapter factory takes the gateway's config and optionally `{ fetch, now, timeoutMs, maxRetries }`: a custom `fetch`, a clock, a per-request timeout (default 30000 ms) and the number of automatic retries of requests that are safe to repeat (default 2; writes are never retried). The configs are in the gateway pages: [Razorpay](../gateways/razorpay.md#configuration), [Cashfree](../gateways/cashfree.md#configuration), [PayU](../gateways/payu.md#configuration).

## Members

| Member | Meaning |
|---|---|
| `subs.providers` | The configured gateways. |
| `subs.provider(name)` | The adapter, for anything the client does not wrap. Throws `CONFIG` if the gateway is not configured. |
| `subs.capabilities(name)` | What the gateway can do **through this client**: the adapter's capabilities plus what the facade and scheduler add. With a scheduler, merchant-scheduled gateways report `pause` and `resume` as true. See the [capability matrix](./generated/capabilities.md). |
| `subs.scheduler` | The `BillingScheduler`, if configured. |

## Plans

| Method | Returns | Notes |
|---|---|---|
| `subs.plans.create(provider, input)` | `Plan` | Razorpay and Cashfree create a plan at the gateway. PayU throws `UNSUPPORTED`: pass the plan inline to `create`. Razorpay plans cannot be edited or deleted. |
| `subs.plans.get(provider, planId)` | `Plan` | `UNSUPPORTED` on PayU. |

Input: [`CreatePlanInput`](./generated/models.md#createplaninput).

## Subscriptions

### `subs.create(provider, input)` : `Subscription`

Creates the subscription and returns it with `checkout`. Input: [`CreateSubscriptionInput`](./generated/models.md#createsubscriptioninput). Errors: `VALIDATION` (also for a combination the gateway cannot do), `UNSUPPORTED`, `CONFIG` (a merchant-scheduled gateway without a scheduler; checked before the gateway is called), `OUTCOME_UNKNOWN` (Razorpay has no idempotency key, so do not retry blindly).

For a merchant-scheduled subscription the client also registers a billing schedule. If that fails after the gateway created the subscription, it cancels it again and throws `INTERNAL_ERROR` (or `CONFIG`), saying whether the cancellation worked.

| | Razorpay | Cashfree | PayU |
|---|---|---|---|
| `plan` | Plan id, or inline (creates a plan each time) | Plan id (periodic only) or inline | Inline only |
| `customer` | Used for prefill | `email` and a 10-digit `phone` required | `name`, `email`, `phone` required |
| `reference` | Kept in `notes` | The subscription id | The transaction id (max 25 characters) |
| `idempotencyKey` | Ignored | Sent as `x-idempotency-key` | Ignored |
| Network call | Yes | Yes | **None**: returns a signed form |

### `subs.get(provider, subscriptionId)` : `Subscription`

The current subscription. For merchant-scheduled subscriptions the schedule's state is merged in and the schedule is brought in step with the gateway (a mandate that is live starts billing; a dead one stops it). Errors: `NOT_FOUND`. PayU accepts your reference or the composite id.

### `subs.verifyCheckout(provider, result, { expectedSubscriptionId })` : `CheckoutVerification`

Verifies what the gateway returned to the browser or return URL, and starts the billing schedule for merchant-scheduled subscriptions. **Always pass `expectedSubscriptionId`** (the id or reference your server stored): without it a genuine result for another subscription would verify. Errors: `SIGNATURE_INVALID` (forged, or for a different subscription), `VALIDATION`. If starting billing fails after the gateway verified the result, it throws `INTERNAL_ERROR` whose `raw` is the verification, so the new subscription id is not lost; calling it again finishes the job.

| | Razorpay | Cashfree | PayU |
|---|---|---|---|
| Verified by | HMAC of payment id and subscription id with the key secret | Fetching the subscription (the return-URL signature is undocumented) | The response hash with the salt |
| Result passed | The checkout handler response | The return URL's query as an object | PayU's posted form fields |

### `subs.pause(provider, id, { resumeAt? })`, `subs.resume(provider, id, { nextChargeAt? })`

Returns the `Subscription`. `UNSUPPORTED` where the gateway cannot. Per-gateway rules are in [Managing subscriptions](../guides/managing-subscriptions.md#pause-and-resume).

### `subs.update(provider, id, input)` : `Subscription`

Input: [`UpdateSubscriptionInput`](./generated/models.md#updatesubscriptioninput); at least one field. Merchant-scheduled subscriptions apply `amount`, `nextChargeAt`, `remainingCycles` and `mandateEndsAt` to the schedule and refuse `planId` and `quantity`. Errors: `UNSUPPORTED`, `CONFLICT` (a cancelled or completed schedule), `VALIDATION`. See [the table in Managing subscriptions](../guides/managing-subscriptions.md#change-plan-quantity-or-amount).

### `subs.cancel(provider, id, { mode? })` : `Subscription`

`mode` is `CancelMode.Immediately` (default) or `CancelMode.AtPeriodEnd` (Razorpay only; `UNSUPPORTED` elsewhere, checked before billing is stopped). For merchant-scheduled subscriptions billing is stopped first, then the mandate cancelled.

### `subs.tick({ limit? })` : `TickResult`

Runs the billing scheduler once. Rejects with `CONFIG` when no scheduler is configured. See [the billing scheduler](./scheduler.md).

## Charges

| Method | Returns | Notes |
|---|---|---|
| `subs.charges.list(provider, subscriptionId, { limit? })` | `Charge[]` | `limit` 1 to 100. `UNSUPPORTED` on PayU. |
| `subs.charges.get(provider, subscriptionId, chargeId)` | `Charge` | On PayU, by your transaction id; an unknown debit is `NOT_FOUND`. |
| `subs.charges.create(provider, input)` | `Charge` | Raises a debit yourself: `CreateChargeInput`. With a scheduler you normally never call this. `UNSUPPORTED` on Razorpay. Reusing a `chargeId` must never debit twice. |
| `subs.charges.notify(provider, input)` | `ChargeNotification` | The pre-debit notification (`NotifyChargeInput`). PayU only; `UNSUPPORTED` elsewhere. eNACH needs none: an accepted notification is returned without a request. |
| `subs.charges.refund(provider, input)` | `Refund` | `RefundInput`. See [Refunds](../guides/managing-subscriptions.md#refunds). |

## Webhooks

| Method | Meaning |
|---|---|
| `subs.webhooks.parse(provider, { rawBody, headers })` | Verifies the signature and returns the normalised `SubscriptionEvent[]`. Pure: stores nothing. Throws `SIGNATURE_INVALID`, or `CONFIG` if the webhook secret is not configured. |
| `subs.webhooks.handle(provider, { rawBody, headers })` | `parse`, then applies each event to the billing scheduler. Use this in your webhook route. |

## Other exports

The main entry also exports every schema and constant, `SubscriptionError`, `isSubscriptionError`, the adapters' config schemas, `BaseProvider` and `SubscriptionProvider` for [writing an adapter](../contributing/adding-a-gateway.md), the money and time helpers, the events-webhook signing and verification functions (`signEventsBody`, `verifyEventsSignature`), the schema registry (`SchemaName`, `exportJsonSchemas`) and each gateway's own constants under `RazorpayApi`, `CashfreeApi` and `PayUApi`.
