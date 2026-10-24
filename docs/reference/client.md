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
| `providers` | The provider adapters: the gateways `razorpay(...)`, `cashfree(...)`, `payu(...)`, `phonepe(...)`, `paytm(...)` and the stores `appStore(...)`, `googlePlay(...)`. At least one. A provider listed twice throws `CONFIG`. |
| `routing` | Optional. How `subs.router` decides: `strategy` ([`RoutingStrategy`](./generated/models.md#routingstrategy): weights, fees, priorities, limits, circuit breaker), `stats` (a `RoutingStatsStore`; the default is in memory), `now`, `onStatsError`. The router always exists, with documented defaults. See [Routing](../guides/routing.md). |
| `purchases` | Optional. Purchase sessions: `catalog` and `store` are required; `policy`, `now`, `sessionTtlMs`, `retry`, `reportLeaseMs`, `lock`, `gatewayReturnUrl`, `hostedCheckoutUrl` and `onIssue` are optional. The client builds `subs.purchases` over itself, over `subs.router` and with the Google Play provider as the reporter. A bad catalog throws `CONFIG` listing every problem. See [Selling on iPhone, Android and the web](../guides/purchases.md). |
| `scheduler` | Optional. A ready `BillingScheduler`, or just its options (`store`, `onEvent`, `now`, policy defaults): the client then builds the scheduler for exactly the providers above. Required to create merchant-scheduled subscriptions. See [the billing scheduler](./scheduler.md). |

Each adapter factory takes the gateway's config and optionally `{ fetch, now, timeoutMs, maxRetries }`: a custom `fetch`, a clock, a per-request timeout (default 30000 ms) and the number of automatic retries of requests that are safe to repeat (default 2; writes are never retried). The configs are in the gateway pages: [Razorpay](../gateways/razorpay.md#configuration), [Cashfree](../gateways/cashfree.md#configuration), [PayU](../gateways/payu.md#configuration), [PhonePe](../gateways/phonepe.md#configuration), [Paytm](../gateways/paytm.md#configuration).

## Members

| Member | Meaning |
|---|---|
| `subs.providers` | The configured gateways. |
| `subs.provider(name)` | The adapter, for anything the client does not wrap. Throws `CONFIG` if the gateway is not configured. `subs.provider(name).capabilities` is the **raw** adapter view; `subs.capabilities(name)` is the effective one. |
| `subs.capabilities(name)` | What the gateway can do **through this client**: the adapter's capabilities plus what the facade and scheduler add. With a scheduler, merchant-scheduled gateways report `pause` and `resume` as true. See the [capability matrix](./generated/capabilities.md). |
| `subs.scheduler` | The `BillingScheduler`, if configured. |
| `subs.router` | The `Router`: `route(request)` returns a `RoutingDecision` (rejects with `NO_ROUTE` when no gateway is eligible), `record(outcome)` teaches it, `circuitState(provider)` reads a gateway's breaker. Only providers of kind `gateway` are candidates. |
| `subs.purchases` | The `Purchases`, when the `purchases` option was given: `start`, `chooseAlternative`, `complete`, `get`, `entitlements`, `handleEvents`, `flush`. |

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

The current subscription. For merchant-scheduled gateways with a scheduler configured, **your own reference works as well as the gateway's id**, including before the customer has authorised (PayU, for example, only knows the mandate id afterwards). Gateway-scheduled subscriptions (Razorpay, Cashfree periodic plans) must be read by the gateway's id. For merchant-scheduled subscriptions the schedule's state is merged in and the schedule is brought in step with the gateway (a mandate that is live starts billing; a dead one stops it). When the gateway answers not-found for a mandate the schedule tracks (not authorised yet, or PayU's "Consent is Not Mandated" for a working card mandate), the facade returns the **schedule's view**, built from the schedule alone, with `providerStatus` set to the constant `GATEWAY_STATUS_UNAVAILABLE` (`gateway_status_unavailable`) so you can tell it from a gateway's answer; its `status` is derived from the schedule. Errors: `NOT_FOUND`.

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

## One-time payments

`subs.payments` has four methods. Input and output shapes are in [Models](./generated/models.md); the guide is [One-time payments](../guides/one-time-payments.md).

| Method | Returns | Notes |
|---|---|---|
| `subs.payments.create(provider, input)` | `Payment` | `CreatePaymentInput`. Returns `status: created` and a `checkout` instruction. At an app store it makes no purchase: it returns the account token the purchase on the device must carry. `UNSUPPORTED` or `VALIDATION` for an input the gateway cannot honour. |
| `subs.payments.get(provider, paymentId)` | `Payment` | The source of truth. |
| `subs.payments.verify(provider, result, { expectedPaymentId })` | `PaymentVerification` | Verifies what the browser or device returned. **Always pass `expectedPaymentId`**: it is compared with the verified `paymentId` and `reference`, and a mismatch rejects with `SIGNATURE_INVALID`. |
| `subs.payments.refund(provider, input)` | `Refund` | `RefundPaymentInput`. The refund's `chargeId` and `paymentId` are both the payment's id. |

## Charges

| Method | Returns | Notes |
|---|---|---|
| `subs.charges.list(provider, subscriptionId, { limit? })` | `Charge[]` | `limit` 1 to 100. `UNSUPPORTED` on PayU. |
| `subs.charges.get(provider, subscriptionId, chargeId)` | `Charge` | On PayU, by your transaction id; an unknown debit is `NOT_FOUND`. |
| `subs.charges.create(provider, input)` | `Charge` | Raises a debit yourself: `CreateChargeInput`. With a scheduler you normally never call this. `UNSUPPORTED` on Razorpay. Reusing a `chargeId` must never debit twice. |
| `subs.charges.notify(provider, input)` | `ChargeNotification` | The pre-debit notification (`NotifyChargeInput`). PayU, PhonePe and Paytm; `UNSUPPORTED` elsewhere. Where bank mandates need none, an accepted notification is returned without a request. When the result carries a `chargeId` (PhonePe), the notification **dictates the id of the debit that follows**: pass that id to `charges.create` and `charges.get`. |
| `subs.charges.refund(provider, input)` | `Refund` | `RefundInput`. See [Refunds](../guides/managing-subscriptions.md#refunds). |

## Webhooks

| Method | Meaning |
|---|---|
| `subs.webhooks.parse(provider, { rawBody, headers })` | Verifies the signature and returns the normalised `SubscriptionEvent[]`. Pure: stores nothing and does not touch the scheduler or purchases. Returns a promise (some adapters make a network call to verify or to read the object an event names); rejects with `SIGNATURE_INVALID`, or `CONFIG` if the webhook secret is not configured. |
| `subs.webhooks.handle(provider, { rawBody, headers })` | `parse`, then applies each event to the billing scheduler and to purchase sessions. Every consumer sees the events even when another one fails; if any failed, it rejects (so the provider delivers the webhook again) with the first failure's code, and the events in `raw`. Use this in your webhook route. The HTTP service's `POST /v1/{provider}/webhooks/parse` route does the same as `handle`: it verifies, applies to the scheduler and normalises. |

## Routing and purchases

The router and the purchase sessions are also exported as classes, to be built over a host of your own: `Router`, `MemoryRoutingStatsStore`, `RoutingStatsStore`, `Purchases`, `MemoryPurchaseStore`, `PurchaseStore`, `PurchaseHost`, and the pure helpers `resolvePolicy`, `validateCatalog`, `assertCatalog`, `splitTax` and `splitRefund`. `FilePurchaseStore`, the durable one-file store, is exported from `india-subscriptions/server`.

### `Router`

| Method | Meaning |
|---|---|
| `route(request)` | The best gateway and why: `provider`, `ranked`, `candidates`. No side effects. Rejects with `VALIDATION` or `NO_ROUTE`. |
| `record(outcome)` | Counts how an attempt ended: `RouteOutcome` (`provider`, `kind`, `result`, `paymentMethod?`, `at?`). |
| `circuitState(provider)` | `closed`, `open` or `half_open`. |

### `Purchases`

| Method | Meaning |
|---|---|
| `start(input)` | Decides where the purchase may go on the platform, creates it and returns the `PurchaseSession`. `CONFLICT` when the customer already owns the product, `NOT_FOUND` for an unknown product, `NO_ROUTE`, `CONFIG`, `VALIDATION`. |
| `chooseAlternative(sessionId, { externalTransactionToken })` | Android `user_choice` only: creates the gateway purchase and adds it as a second option. |
| `complete(sessionId, { provider, result })` | Verifies the result against the order the session created, writes the entitlement, queues the first Google report when one is owed. `SIGNATURE_INVALID` for another order's result. |
| `get(sessionId)` | The session. `NOT_FOUND` for an unknown id. |
| `entitlements(customerRef)` | `Entitlements`: what the customer owns. |
| `handleEvents(events)` | Applies verified webhook events (`subs.webhooks.handle` calls it). |
| `findByGatewayId(provider, id)` | The session that owns a gateway's own id, as a gateway return that carries only that id needs. |
| `flush({ limit? })` | Sends the queued reports to Google: `FlushResult` with `sent`, `retrying`, `blocked`, `rejected`, `skipped`, `entries` and `overdue`. |

The options, the guarantees and the numbers are in the [Purchases reference](./generated/purchases.md); the routing defaults are in the [Routing reference](./generated/routing.md).

## Other exports

The main entry also exports every schema and constant, `SubscriptionError`, `isSubscriptionError`, the adapters' config schemas, `BaseProvider` and `SubscriptionProvider` for [writing an adapter](../contributing/adding-a-gateway.md), the money and time helpers, the events-webhook signing and verification functions (`signEventsBody`, `verifyEventsSignature`), the schema registry (`SchemaName`, `exportJsonSchemas`) and each provider's own constants under `RazorpayApi`, `CashfreeApi`, `PayUApi`, `PhonePeApi`, `PaytmApi`, `AppStoreApi` and `GooglePlayApi`.
