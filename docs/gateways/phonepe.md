# PhonePe

PhonePe Autopay sets up **UPI mandates only**. PhonePe never raises a recurring debit itself: you tell it about each debit in advance and then ask it to take the money. The library's [billing scheduler](../guides/scheduler.md) does both, so with PhonePe you **must** configure a scheduler. Creating a subscription without one fails before anything is sent to PhonePe.

The same adapter also takes [one-time payments](#one-time-payments) (UPI, cards and net banking) on PhonePe's Standard Checkout. They need no mandate and no scheduler.

## Configuration

```ts
import { Environment, MemorySchedulerStore, createSubscriptions, phonepe } from 'india-subscriptions';

export const subs = createSubscriptions({
  providers: [
    phonepe({
      clientId: process.env.PHONEPE_CLIENT_ID!,
      clientSecret: process.env.PHONEPE_CLIENT_SECRET!,
      clientVersion: process.env.PHONEPE_CLIENT_VERSION!,
      environment: Environment.Test,
      webhookUsername: process.env.PHONEPE_WEBHOOK_USERNAME,
      webhookPassword: process.env.PHONEPE_WEBHOOK_PASSWORD,
      redirectUrl: 'https://shop.example.com/phonepe/return',
    }),
  ],
  scheduler: { store: new MemorySchedulerStore() },
});
```

| Option | Required | Meaning |
|---|---|---|
| `clientId`, `clientSecret`, `clientVersion` | yes | The credentials from the PhonePe Business Dashboard (Developer Settings). The adapter exchanges them for an OAuth token and caches it until five minutes before it expires. |
| `environment` | yes | `Environment.Test` (PhonePe's sandbox, `api-preprod.phonepe.com`) or `Environment.Live` (`api.phonepe.com`). The live token endpoint is on a different host; the adapter knows it. |
| `webhookUsername`, `webhookPassword` | for webhooks | Give both or neither. The credentials you set for the webhook in the Dashboard. Without them `parseWebhook` throws `CONFIG`. |
| `redirectUrl` | no | Default page PhonePe sends the customer back to. A subscription's or payment's `returnUrl` overrides it. One of the two is required. |
| `apiUrl`, `tokenUrl` | no | Replace the PhonePe hosts (a proxy or a mock server). |

The service reads the same settings from the `PHONEPE_*` [environment variables](../reference/generated/environment.md#phonepe).

## Capabilities

<!-- generated:begin capabilities phonepe -->
<!-- generated:end -->

PhonePe is **merchant-scheduled** only. `pause: no` and `resume: no` describe PhonePe's own API, which has none. With a scheduler configured, the facade pauses and resumes by telling the scheduler to stop and start raising debits, and [`subs.capabilities()`](../reference/generated/capabilities.md#what-the-facade-reports) reports that. `charges.list` is not available: read a debit with `charges.get` and its id, or follow the scheduler's events.

## How a subscription works on PhonePe

`createSubscription` calls PhonePe's setup API and returns a **redirect** to PhonePe's hosted checkout page. The customer approves the mandate in their UPI app; PhonePe sends them back to your return page.

```mermaid
sequenceDiagram
  participant App as Your server
  participant Browser as Customer's browser
  participant PhonePe
  participant Sched as Billing scheduler
  App->>PhonePe: setup (hosted checkout)
  PhonePe-->>App: redirect URL
  App-->>Browser: checkout instruction (redirect)
  Browser->>PhonePe: customer approves the mandate in their UPI app
  PhonePe-->>Browser: back to your return URL
  Browser->>App: return URL with merchantSubscriptionId
  App->>PhonePe: verifyCheckout reads the mandate
  App->>Sched: activate the schedule
  loop every cycle
    Sched->>PhonePe: notify (pre-debit notification, order id N)
    Sched->>PhonePe: redeem (same order id N, at least 24 hours later)
    Sched->>PhonePe: order status until the result is final
  end
```

### What you must supply

- The plan **inline**. PhonePe has no plan API, so a plan id string throws `VALIDATION`, and `plans.create` and `plans.get` throw `UNSUPPORTED`.
- A return page: `returnUrl` on the subscription or `redirectUrl` in the config.
- `paymentMethods`, if you pass it, must include `upi`. Nothing else exists.
- A plan amount of at least ₹1, and a ceiling (`maxAmount`, or the amount) of at most **₹15,000**. If `maxAmount` differs from `amount` the mandate is variable, otherwise fixed.
- `quantity` other than 1 is not supported. `notifyCustomer`, `idempotencyKey` and `customer` (which is kept on the returned subscription) have no PhonePe field and are ignored. `metadata` is sent only for the keys `udf1` to `udf15` (the first ten up to 256 characters, the rest up to 50 characters of letters, digits and `_ - + @ .`); other keys stay on the returned subscription only.

The subscription's `id` is your `reference` (letters, digits, `_` and `-`, at most 60 characters) or a generated `sub_...` id. PhonePe's own mandate id is never needed. The setup order id is derived from it (`ST_` plus the subscription id), so the adapter keeps no state.

### Billing intervals

PhonePe names a fixed set of frequencies. Any other interval is sent as `ON_DEMAND`, which means no recurrence rule is enforced at the bank:

<!-- generated:begin phonepe-frequencies -->

| Plan interval | PhonePe frequency |
|---|---|
| 1 day | `DAILY` |
| 1 week | `WEEKLY` |
| 7 day | `WEEKLY` |
| 2 week | `FORTNIGHTLY` |
| 14 day | `FORTNIGHTLY` |
| 1 month | `MONTHLY` |
| 3 month | `QUARTERLY` |
| 6 month | `HALFYEARLY` |
| 12 month | `YEARLY` |
| 1 year | `YEARLY` |

<!-- generated:end -->

A two-month interval is sent as `ON_DEMAND`, because PhonePe's "BIMONTHLY" could mean every two months or twice a month and its pages do not say which. Whether a failed debit counts against a frequency limit is not documented.

### Trials, delayed starts and upfront amounts

PhonePe has no trial or plan object. The mandate is set up with one of two verifications, and the scheduler simply does not debit until the trial ends.

| You pass | Setup | Notes |
|---|---|---|
| No `upfrontAmount` | **₹2 verification debit** (`PENNY_DROP`, fixed) | PhonePe's dashboard documentation says it is credited back during setup; the API pages do not say so. If it is not returned, refund it. |
| `upfrontAmount` (at least ₹1) | That amount is debited at setup (`TRANSACTION`) | The first payment, collected with the authorisation. |

**A recurring charge cannot happen at sign-up.** Every debit needs a pre-debit notification, and PhonePe allows the debit only 24 hours or more after it. The notification and the debit use the **same order id**, and the debit window runs from 24 hours after the notification until its expiry (PhonePe's retry window is 48 hours). So without an upfront amount, the customer's first real charge is at least a day after sign-up, trial or not. An upfront amount is the only way to take money at sign-up. It does not move the date of the first recurring debit, which is the subscription's `startAt` (now, when you pass no trial); pass `trial` or `startAt` if the upfront amount is meant to pay for the first period.

The mandate's end date is `mandateEndsAt`, else seven days after the last debit when you give `totalCycles`, else **29 years** (PhonePe's documented maximum is 30). `authorizeBy` sets how long the setup page lives and must be 300 to 3600 seconds away; outside that it is refused, not clamped.

### Pre-debit notification and the debit

For each cycle the scheduler calls `notifyCharge`, which returns the notification's order id as `ChargeNotification.chargeId`. The scheduler then uses that id as the debit's id: `createCharge` asks PhonePe to redeem that order. The amount is fixed by the notification, so a different amount in `createCharge` is a `VALIDATION` error.

Redeem has no documented idempotency, so the adapter **reads the order first**:

| What PhonePe holds | `createCharge` does |
|---|---|
| Nothing | `NOT_FOUND`: notify first |
| An order already redeemed | Returns that debit; sends nothing |
| A notification, window not open yet | `CONFLICT`: nothing was debited and it can still happen, so it does not use up an attempt |
| A notification, window expired | `PROVIDER_ERROR`: the scheduler retries with a fresh notification |
| A notification, window open | Redeems |

`getCharge` on an order PhonePe holds only as a notification answers `NOT_FOUND`: no debit exists yet. The scheduler reads that as "never reached PhonePe" and, after its grace period, sends the same redeem again. PhonePe retries failed debits itself inside its window (the `STANDARD` strategy), and only during non-peak hours (9:31 PM to 9:59 AM and 1:01 PM to 4:59 PM, as its documentation states). Use the scheduler's `debitAtIstTime` policy to stay inside them.

## Payment methods and limits

| | UPI Autopay |
|---|---|
| Customer authorises with | UPI PIN in a UPI app (PhonePe, BHIM, Google Pay, Paytm, CRED, Amazon Pay, SuperMoney) |
| Mandate ceiling | ₹15,000, PhonePe's stated maximum on this API. A larger ceiling is refused with `VALIDATION`. |
| Smallest amounts | ₹1 for the plan amount and any upfront amount; ₹2 for the verification |
| Frequency | The table above |
| Mandate validity | Up to 30 years |
| Customer actions | Pause, un-pause and revoke in their UPI app |

## Pause, resume, cancel

- **Customers** pause, un-pause and revoke in their UPI app. PhonePe tells you through webhooks. A pause that came from the customer is undone only by the customer's un-pause: the scheduler marks who paused and never lets a gateway event undo **your** pause. After a pause and un-pause, PhonePe's documentation requires a new notification and 24 hours before the next debit; the scheduler notifies before every debit anyway.
- **You** can only **cancel**. `subs.cancel` stops billing first and then cancels the mandate (PhonePe answers 204 and the status is read afterwards). Cancelling twice is fine. A mandate the customer never authorised cannot be cancelled at PhonePe (`NOT_FOUND`); the facade then stops the schedule and returns its own view of the subscription.
- `pause` and `resume` throw `UNSUPPORTED` on the adapter; through the facade they are the scheduler's. `CancelMode.AtPeriodEnd` is `UNSUPPORTED`.
- `update` accepts only `amount`, and only for a **variable** mandate (the plan's `maxAmount` above its `amount`): within the ceiling the new amount goes to the billing schedule (PhonePe holds only the ceiling), above it is `VALIDATION`. A **fixed** mandate debits exactly its setup amount, so it is `UNSUPPORTED`; so is every other field.

## Authorisation and checkout

`subscription.checkout` has `kind: CheckoutKind.Redirect` and PhonePe's page URL. [`openCheckout`](../guides/checkout.md) navigates to it. PhonePe then sends the customer to your return URL; the adapter adds `merchantSubscriptionId` to it. That return carries **no documented signature**, so `verifyCheckout` trusts nothing in it except that id and **reads the mandate from PhonePe**: `authorized` is true only when it is `ACTIVE`. A mandate still `ACTIVATION_IN_PROGRESS` is `pending_authorization`. Always pass `expectedSubscriptionId`, because the id comes from the browser.

Before the customer authorises, PhonePe's subscription-status endpoint may not know the mandate. A not-found answer falls back to the **setup order**: still pending is `created`, failed or expired is `failed`, completed is `pending_authorization`.

## Statuses

<!-- generated:begin phonepe-subscription-status -->

| PhonePe mandate state | Unified status |
|---|---|
| `ACTIVATION_IN_PROGRESS` | `pending_authorization` |
| `ACTIVE` | `active` |
| `PAUSE_IN_PROGRESS` | `paused` |
| `PAUSED` | `paused` |
| `UNPAUSE_IN_PROGRESS` | `paused` |
| `CANCEL_IN_PROGRESS` | `cancelled` |
| `CANCELLED` | `cancelled` |
| `REVOKE_IN_PROGRESS` | `cancelled` |
| `REVOKED` | `cancelled` |
| `EXPIRED` | `expired` |
| `FAILED` | `failed` |

| Setup order state (before the mandate exists) | Unified status |
|---|---|
| `PENDING` | `created` |
| `COMPLETED` | `pending_authorization` |
| `FAILED` | `failed` |

<!-- generated:end -->

A mandate state PhonePe adds later becomes `pending_authorization`, the one status the scheduler and the facade do not act on. The gateway's own state is always in `providerStatus`. A mandate being paused, un-paused, cancelled or revoked is already as good as gone, so the in-progress states map like their final ones.

<!-- generated:begin phonepe-charge-status -->

| PhonePe order state | Unified charge status |
|---|---|
| `PENDING` | `pending` |
| `COMPLETED` | `succeeded` |
| `FAILED` | `failed` |
| `NOTIFICATION_IN_PROGRESS` | `scheduled` |
| `NOTIFIED` | `scheduled` |

<!-- generated:end -->

An unknown order state is `pending`: never final, never a failure. A notification that was never redeemed and whose window has passed is reported as a failed debit.

<!-- generated:begin phonepe-refund-status -->

| PhonePe refund state | Unified refund status |
|---|---|
| `PENDING` | `pending` |
| `CONFIRMED` | `pending` |
| `ACCEPTED` | `pending` |
| `COMPLETED` | `succeeded` |
| `FAILED` | `failed` |

<!-- generated:end -->

A refund state PhonePe adds later is `pending`.

## Refunds

`charges.refund` calls `POST /payments/v2/refund`: `chargeId` is the debit's order id (the notification id) and `refundId` your unique id (at most 63 characters). Without `amount` the adapter reads the order and refunds all of it; only a completed debit can be refunded. PhonePe refuses refunds of payments older than 90 days. The documented minimum refund amount contradicts itself (1 paisa in one place, 100 in another) and is not enforced locally. PhonePe does not say whether a repeated `refundId` is refused, so a refund that failed must be re-sent under a **new** id, and the call is not retried automatically.

## Webhooks

In the PhonePe Business Dashboard, add your webhook URL and set a username and password. PhonePe sends `Authorization: sha256(username:password)` (lower-case hex), which the adapter compares in constant time.

::: danger This header does not cover the body
It identifies the sender and nothing more. It does not sign the payload, so **a captured webhook can be replayed** and a body altered in transit would not be detected. Serve the endpoint over **HTTPS only**, and de-duplicate on `event.id`. PhonePe's HMAC webhook mode is not implemented, because its algorithm is not documented. The capability `signedWebhooks: yes` means the **sender** is authenticated, not the body.
:::

| PhonePe event | Unified event |
|---|---|
| `subscription.setup.order.completed`, `checkout.order.completed` (a subscription setup) | `subscription.authorized` |
| `subscription.setup.order.failed`, `checkout.order.failed` (a subscription setup) | `subscription.authorization_failed` |
| `subscription.paused` | `subscription.paused` |
| `subscription.unpaused` | `subscription.resumed` |
| `subscription.revoked`, `subscription.cancelled` | `subscription.cancelled` |
| `subscription.notification.completed` | `subscription.charge_scheduled` |
| `subscription.redemption.order.completed` and `subscription.redemption.transaction.completed` (confirmed) | `subscription.charged` |
| `subscription.redemption.order.failed` (final) | `subscription.charge_failed` |
| `pg.refund.completed`, `pg.refund.failed` | `refund.succeeded`, `refund.failed` (with `paymentId` for a one-time payment) |
| `checkout.order.completed`, `checkout.order.failed` (a one-time payment) | `payment.succeeded`, `payment.failed` ([details](#webhooks-for-one-time-payments)) |
| `subscription.notification.failed`, `subscription.redemption.transaction.failed`, `pg.refund.accepted`, orders of an unknown flow, anything else | `unknown` |

A failed notification is `unknown` because reporting it as a failed charge would burn an attempt for a debit that was never tried. A single failed attempt is `unknown` as well, since PhonePe retries inside its window and only the order's own `FAILED` is final.

Event ids are built from the event name and the ids in the payload. The two redemption-success events of one debit share one id, so you do not fulfil twice. PhonePe's un-pause, revoke and cancel payloads carry no timestamp, so a second un-pause of the same subscription has the same id as the first: it looks like a redelivery.

## One-time payments

`subs.payments.create` calls PhonePe's Standard Checkout create-payment API (`POST /checkout/v2/pay`, flow `PG_CHECKOUT`) and returns a `Payment` whose `checkout` is a **redirect** to PhonePe's hosted page. It uses the credentials, token and webhook settings of the subscription setup above; no scheduler or mandate is involved.

```mermaid
sequenceDiagram
  participant App as Your server
  participant Browser as Customer's browser
  participant PhonePe
  App->>PhonePe: create payment (merchant order id)
  PhonePe-->>App: redirect URL
  App-->>Browser: checkout instruction (redirect)
  Browser->>PhonePe: customer pays (UPI, card or net banking)
  PhonePe-->>Browser: back to your return URL with merchantOrderId
  Browser->>App: return URL
  App->>PhonePe: order status (verifyPayment)
  PhonePe-->>App: COMPLETED, FAILED or PENDING
  PhonePe->>App: checkout.order.completed or failed webhook
```

```ts title="phonepe-payments.ts"
import { EventType, PaymentMethod, Provider, type SubscriptionEvent, type Subscriptions } from 'india-subscriptions';

/** Create the payment and hand the browser the redirect. Store `orderId` with your order. */
export async function startPayment(subs: Subscriptions, orderId: string) {
  const payment = await subs.payments.create(Provider.PhonePe, {
    reference: orderId,
    amount: 49900,
    description: 'Order 1042',
    customer: { name: 'Asha Rao', email: 'asha@example.com', phone: '9876543210' },
    paymentMethods: [PaymentMethod.Upi, PaymentMethod.Card],
    returnUrl: 'https://shop.example.com/phonepe/return',
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    metadata: { udf1: orderId },
  });
  return payment.checkout; // { kind: 'redirect', url }: pass it to openCheckout in the browser
}

/** The return page's route: PhonePe sends the browser back with `?merchantOrderId=...`. */
export async function confirmReturn(subs: Subscriptions, query: Record<string, string>, orderId: string) {
  const verification = await subs.payments.verify(Provider.PhonePe, query, { expectedPaymentId: orderId });
  return verification.paid; // true only when PhonePe's own order status says COMPLETED
}

/** Refund part of a paid order. The refund starts pending; its result arrives as a webhook. */
export async function refundPart(subs: Subscriptions, orderId: string, refundId: string) {
  return subs.payments.refund(Provider.PhonePe, { paymentId: orderId, refundId, amount: 10000 });
}

/** What to do with the events of one-time payments. */
export function onEvent(event: SubscriptionEvent): void {
  switch (event.type) {
    case EventType.PaymentSucceeded:
      console.log(`${event.paymentId} paid ${event.payment?.amount} paise`);
      break;
    case EventType.PaymentFailed:
      console.log(`${event.paymentId} failed: ${event.payment?.failureReason}`);
      break;
    case EventType.RefundSucceeded:
      console.log(`${event.refund?.paymentId ?? event.refund?.chargeId} refunded ${event.refund?.amount} paise`);
      break;
    default:
      break;
  }
}
```

### The payment id

`payment.id` is PhonePe's **merchant order id**: your `reference`, or a generated `pay_` plus 24 hex characters. It is the one id every later call takes: `payments.get`, `payments.refund`, `expectedPaymentId`, and the `paymentId` of webhook events. PhonePe's own `OMO...` order id stays in `payment.raw`.

- 1 to 63 characters of letters, digits, `_` and `-`. The library's own limit on `reference` is 60.
- It must not start with `ST_`, the prefix the adapter gives to subscription setup orders. It is refused, not rewritten.
- Order ids are unique at PhonePe: creating a second order with an id PhonePe already holds answers `VALIDATION` (`BAD_REQUEST`). PhonePe documents no idempotency key, so `idempotencyKey` is not used; give each payment its own `reference`, and read the order with `payments.get` before creating it again after an `OUTCOME_UNKNOWN`.

### What reaches PhonePe

| You pass | PhonePe receives |
|---|---|
| `reference` | `merchantOrderId` |
| `amount` | `amount` in paise, at least 100 (₹1) |
| `description` | `paymentFlow.message`, which PhonePe describes as the message "used for collect requests". PhonePe does not show it on every instrument. |
| `paymentMethods` | `paymentModeConfig.enabledPaymentModes`: only those instruments are offered. `upi` is UPI intent and QR, `card` is credit and debit cards, `netbanking` is net banking. `wallet`, `enach` and `physical_nach` are refused with `VALIDATION`. |
| `expiresAt` | `expireAfter` in seconds, rounded down so the order never outlives your deadline. PhonePe accepts 300 to 3600 seconds from now; anything else is refused, not clamped. Without it PhonePe's default applies (its length is not stated). |
| `metadata` | `metaInfo`, whose only keys are `udf1` to `udf15` (the first ten up to 256 characters, the rest up to 50 characters of letters, digits and `_ - + @ .`). Any other key is refused with `VALIDATION`. The values come back on `payment.metadata`. |
| `returnUrl` | `paymentFlow.merchantUrls.redirectUrl` (or `redirectUrl` from the config; one of the two is required), with `merchantOrderId` added as a query parameter |
| `customer` | Nothing: PhonePe's create call has no customer fields. It is kept on the returned payment. |
| `storeProduct` | Not used (app stores only) |

`payment.checkout.url` is PhonePe's `redirectUrl`, which PhonePe says to use exactly as received. [`openCheckout`](../guides/checkout.md) navigates to it. PhonePe's own checkout script can also open it in an iframe (`PhonePeCheckout.transact` with `tokenUrl` set to that URL); the library does not do that for you.

### Confirming a payment

The customer's return to your `returnUrl` carries **nothing signed**, and PhonePe documents no parameter on it. The adapter therefore adds `merchantOrderId` to the URL and treats it only as a pointer. `payments.verify` **reads the order from PhonePe** (the order-status API, which PhonePe names as the way to confirm a payment) and reports `paid: true` only when the order's state is `COMPLETED`. Nothing else the browser sends counts.

- Always pass `expectedPaymentId`: the id comes from the browser, so without it a customer could present the return of someone else's paid order.
- An order that is not a one-time payment (a subscription setup, a debit, a notification, another flow) is refused with `VALIDATION`, so a ₹1 mandate setup can never be passed off as a payment.
- A payment that is still `PENDING` is not paid. PhonePe asks for the order to be reconciled on your server until it is `COMPLETED` or `FAILED`: first after 20 to 25 seconds, then every 3 seconds for 30 seconds, every 6 seconds for 60, every 10 seconds for 60, every 30 seconds for 60, then every minute until the order's expiry. Webhooks do the same job without polling.

### Statuses

`payments.get` reads `GET /checkout/v2/order/{id}/status?details=true&errorContext=true`.

| PhonePe order state | Unified status |
|---|---|
| `PENDING`, no payment attempt yet | `created` |
| `PENDING`, an attempt exists | `pending` |
| `COMPLETED` | `succeeded` |
| `FAILED` | `failed` |
| Any state PhonePe adds later | `pending`, with the state verbatim in `providerStatus` |

PhonePe's order status has no refund information and no cancelled or expired state, so `getPayment` never answers `refunded`, `partially_refunded` or `cancelled`. Follow refunds through `payments.refund` and the `refund.*` webhooks.

`paymentMethod` comes from the completed attempt (else the latest one):

| PhonePe `paymentMode` | `paymentMethod` |
|---|---|
| `UPI_INTENT`, `UPI_QR`, `UPI_COLLECT` | `upi` |
| `CARD` | `card` |
| `NET_BANKING` | `netbanking` |
| Anything else (`CREDIT_LINE`, a new mode) | not set |

A failed payment carries PhonePe's `errorCode` as `failureCode` and, as `failureReason`, the `errorContext` description (for example "Wrong MPIN was entered"), else the code and detailed code.

### Refunds of a payment

`payments.refund` reads the order first, then calls `POST /payments/v2/refund` with `merchantRefundId` = `refundId` and `originalMerchantOrderId` = `paymentId`. The result's `chargeId` and `paymentId` are both the payment's id, and its status starts `pending`.

- Only a `COMPLETED` payment can be refunded. Without `amount` the whole payment is refunded; an amount above the payment's is refused before PhonePe is called.
- `refundId` is 1 to 63 characters of letters, digits, `_` and `-` (the library's own limit is 40). A failed refund is sent again under a **new** `refundId`, and PhonePe asks you not to start another refund of the same payment while one is `PENDING`.
- `reason` has no PhonePe field and is refused with `VALIDATION`.
- PhonePe refuses refunds more than three months after the payment, and needs enough forward balance on the day. Its refund table gives a minimum of 100 paise while one of its samples refunds 50, so the minimum is left to PhonePe.
- The refund call is not repeated by the adapter: a lost answer is `OUTCOME_UNKNOWN`.

### Webhooks for one-time payments

`checkout.order.completed` and `checkout.order.failed` announce Autopay setups and one-time payments alike. The adapter tells them apart by the payload: an order is a **subscription** order when `paymentFlow.type` is one of the `SUBSCRIPTION_*` types, a `merchantSubscriptionId` is present, or its id starts with `ST_`; it is a **one-time payment** when `paymentFlow` is absent (PhonePe's Standard Checkout samples print none) or its type is `PG_CHECKOUT` or `PG`. An order of any other flow type stays `unknown`.

| PhonePe event | Unified event |
|---|---|
| `checkout.order.completed` (state `COMPLETED`) | `payment.succeeded`, with `paymentId` and `payment` |
| `checkout.order.failed` (state `FAILED`) | `payment.failed`, with `paymentId` and `payment` |
| `pg.refund.completed`, `pg.refund.failed` of a payment | `refund.succeeded`, `refund.failed`, with `paymentId` (also on `refund`) |

Only the payload's own `state` decides, as PhonePe asks, and it must agree with the event's name; otherwise the event is `unknown`. Event ids are the event name plus the order id, so a redelivery has the same id.

A refund payload has no `paymentFlow`, so the adapter reads the original order from PhonePe to learn whether it refunds a payment. It makes no call for an `ST_` order, and an order PhonePe does not know is treated as an Autopay refund. If PhonePe cannot answer, the webhook fails (answer 5xx) so that PhonePe delivers it again, instead of guessing. PhonePe's failed-refund samples print an empty `originalMerchantOrderId`; such an event cannot name a payment and is `unknown`.

### Limits

| | One-time payments |
|---|---|
| Methods | UPI (intent and QR), cards (credit and debit), net banking |
| Amount | At least ₹1; no maximum is stated |
| Order id | 1 to 63 letters, digits, `_`, `-`; not starting with `ST_` |
| Order expiry | 300 to 3600 seconds (`expiresAt`) |
| Refund | Within three months; partial refunds allowed |
| Idempotency | None documented; the order id is the key |

## Testing in the sandbox

For one-time payments the sandbox host is the same (`api-preprod.phonepe.com/apis/pg-sandbox`). On the payment page, UPI QR can be scanned with any UPI app, which opens a link offering Success, Failure and Pending; card and net banking pages offer the same three outcomes. PhonePe's documentation lists the test cards 4208 5851 9011 6667 (credit) and 4242 4242 4242 4242 (debit) and the simulation OTP 123456.

PhonePe's UAT sandbox simulates Autopay flows with templates: install PhonePe's test app, enter your merchant id and pick a template (for example "Setup, notify & redemption success with PhonePe retries"). The template must be set **before** you call the APIs, otherwise PhonePe answers "scenario name not found". Test VPAs for collect checks are `success@ybl`, `failure@ybl` and `pending@ybl`. The test app's Subscriptions list lets you pause, un-pause and revoke a mandate to see the webhooks. PhonePe's documentation asks you to share your UAT webhook URL with the integration team.

## Not built

PhonePe's API-integration variant (merchant-rendered UPI intent and collect), its paylinks variant, the mobile SDK token flow, HMAC webhooks, the partner `X-MERCHANT-ID` header, and refund-status polling (use the `refund.*` webhooks). eNACH is a separate PhonePe product and is not covered.
