# Cashfree

Cashfree offers two kinds of plan, and the difference decides who raises each debit.

- **Periodic plan.** Cashfree debits a fixed amount on a schedule you set. This is the default, and it works like [Razorpay](./razorpay.md): you do not need the scheduler.
- **On-demand plan.** Cashfree holds the mandate and you raise each debit, for any amount up to the mandate ceiling. The library's [billing scheduler](../guides/scheduler.md) does that for you. You ask for it with `plan.scheduling: SchedulingMode.Merchant`.

## Configuration

```ts
import { cashfree, Environment } from 'india-subscriptions';

export const gateway = cashfree({
  clientId: process.env.CASHFREE_CLIENT_ID!,
  clientSecret: process.env.CASHFREE_CLIENT_SECRET!,
  environment: Environment.Test,
});
```

| Option | Required | Meaning |
|---|---|---|
| `clientId`, `clientSecret` | yes | Sent as `x-client-id` and `x-client-secret`. |
| `environment` | yes | `Environment.Test` (`https://sandbox.cashfree.com/pg`) or `Environment.Live` (`https://api.cashfree.com/pg`). |
| `webhookSecret` | no | The secret that signs webhooks. Defaults to the client secret, which is what Cashfree's own SDK does. Set it if your account has a separate one. |
| `apiVersion` | no | The `x-api-version` header, as `YYYY-MM-DD`. Defaults to the version the adapter was built for (`2026-01-01`). |
| `baseUrl` | no | Replaces the host, including the `/pg` prefix. |

The service reads the same settings from the `CASHFREE_*` [environment variables](../reference/generated/environment.md#cashfree).

## Capabilities

<!-- generated:begin capabilities cashfree -->
<!-- generated:end -->

`scheduling` lists both modes. A plan without `scheduling` is periodic. Several capabilities describe periodic plans only; the sections below say which.

## How a subscription works on Cashfree

Cashfree keeps the mandate; the customer authorises it in Cashfree.js using a session id.

```mermaid
sequenceDiagram
  participant App as Your server
  participant CF as Cashfree
  participant Customer as Customer's browser
  App->>CF: create subscription (inline plan, authorisation details)
  CF-->>App: subscription, session id
  App-->>Customer: checkout instruction (session id)
  Customer->>CF: authorises with UPI Autopay, card or eNACH
  CF-->>Customer: redirect to returnUrl
  Customer->>App: return URL parameters
  App->>CF: verifyCheckout fetches the subscription
  CF-->>App: webhooks: payment events, status changes
```

### What you must supply

Cashfree rejects a subscription without a customer e-mail and a customer phone. The phone must be a 10-digit Indian mobile number, with or without `+91`. The adapter checks this before calling Cashfree. Your `reference` becomes Cashfree's `subscription_id` (letters, digits, `_`, `.`, `-` and spaces, up to 250 characters); without one, the adapter generates an id.

A plan name is limited to 40 characters. `quantity` other than 1 is not supported (create a plan for the total), and neither is `upfrontLabel`. `notifyCustomer: false` is refused, because Cashfree documents no way to turn its notifications off. Physical (paper) NACH is not built.

### Trials and the first charge

A trial on a periodic plan is a future `subscription_first_charge_time`. Cashfree does not move your date, but it will not debit earlier than the method allows, and the debit happens on the nearest possible date:

| Method | Customer authorises | Earliest first debit |
|---|---|---|
| UPI Autopay | Before 9 PM | Next day (T+1) |
| UPI Autopay | After 9 PM | T+2 |
| Cards | Before 9 PM | T+1 |
| Cards | After 9 PM | T+2 |
| eNACH | Any time | T+4 |

One FAQ line says the first charge date must fall within a 14-day window. Whether that caps trial length is not clear; check it in the sandbox if your trials are longer than 14 days. For on-demand plans there is no first-charge setting: the scheduler simply does not raise a debit until the trial ends.

### Authorisation amount and upfront amount

| You pass | Cashfree collects | Refunded? |
|---|---|---|
| nothing | ₹1 for UPI and cards, ₹0 for eNACH | Yes, automatically (UPI and cards) |
| `upfrontAmount` | That amount, as the authorisation amount | No |

An upfront amount works on UPI and cards only. eNACH never collects anything at authorisation, so `upfrontAmount` with eNACH throws `UNSUPPORTED`, and with no `paymentMethods` the checkout is limited to UPI and cards. If you need an upfront amount with eNACH, charge it separately once the mandate is `ACTIVE`. The upper bound of the authorisation amount is not documented.

### Raising debits (on-demand plans)

With an on-demand plan the scheduler calls `createCharge` for you. Cashfree sends the pre-debit notification itself once the charge exists, so the scheduler raises each charge **48 hours before the debit date** with `scheduledAt` set, and never more than **13 days** ahead. These limits come from Cashfree's cut-off table:

| Charge raised | For | UPI Autopay and Indian cards |
|---|---|---|
| Before 21:00 on day T | T+1 | Allowed |
| 21:00 or later on day T | T+1 | Not allowed |
| Any time on day T | T+2 to T+14 | Allowed |
| Any time on day T | T (same day) | Not allowed |

NACH and international cards can be debited the same day if the charge is raised before 07:00. Dates are dates, not instants: Cashfree uses only the date part, so the adapter sends midnight IST. With no schedule date, a charge is dated the next day if raised before 21:00 IST, otherwise the day after. The 48-hour lead and the 13-day ceiling appear in `capabilities` as `merchantChargeLeadHours` and `merchantChargeMaxAheadHours`.

`createCharge` is not marked idempotent: Cashfree's idempotency key has to be a UUID and your charge id is not one. A dropped request is `OUTCOME_UNKNOWN`, and the scheduler asks `getCharge` before deciding anything. Cashfree rejects a reused `payment_id`.

### Failures and retries

| Method | After a failed debit |
|---|---|
| UPI Autopay | Cashfree retries up to three times, hourly. What status the subscription takes afterwards is not documented. |
| eNACH | No automatic retry. The subscription becomes `ON_HOLD` (unified `halted`). |
| Cards | No automatic retry. `ON_HOLD`. |

Cashfree allows up to 3 manual retries per cycle through its dashboard or API (not exposed by this library). With on-demand plans the scheduler applies its own retry policy: see [Running the scheduler](../guides/scheduler.md).

## Payment methods and limits

| Method | Largest mandate |
|---|---|
| UPI Autopay | ₹15,000 without additional factor authentication, ₹1,00,000 with it |
| Cards (Indian) | ₹15,000 without it, ₹1,00,00,000 with it |
| Cards (international) | ₹1,00,00,000 |
| eNACH | ₹1,00,00,000 |

Card and UPI are hidden by default for mandates of ₹15,000 and above, in both sandbox and production; additional factor authentication has to be enabled on your account. "At or above" and "above" ₹15,000 are both stated, so whether exactly ₹15,000 works is unclear. If you need a method that never asks the customer to authenticate each debit, use eNACH, which is only for individual accounts. Bank approval of an eNACH mandate takes 24 to 48 hours; until the status is `ACTIVE` the subscription reads `pending_authorization` and nothing is charged. UPI Autopay is not self-serve: Cashfree has to switch it on for your sandbox and production accounts.

Since August 2025 UPI Autopay debits are processed only before 10:00, between 13:00 and 17:00 and after 21:30. Pick a debit time of day in those windows with the scheduler's `debitAtIstTime` policy.

## Authorisation and checkout

`subscription.checkout` has `kind: CheckoutKind.CashfreeCheckout`, the session id and the environment. [`openCheckout`](../guides/checkout.md) loads Cashfree.js and calls `subscriptionsCheckout`. The customer then returns to your `returnUrl`.

Cashfree's return-URL signature algorithm is undocumented, so `verifyCheckout` trusts nothing in the query except the subscription id (`cf_subscriptionId`) and **fetches the subscription from the API** instead. `authorized` is true when the mandate is `ACTIVE` or in a trial. A mandate still waiting for the bank is `authorized: false` with `status: pending_authorization`; the later `ACTIVE` event completes the activation. A session id expires after 2 hours; `getSubscription` returns a fresh one while the subscription is still `created`.

## Managing a subscription

| Operation | On Cashfree |
|---|---|
| `pause` | Periodic plans only. `resumeAt` is not supported. For an on-demand subscription the scheduler pauses by not raising debits and the mandate stays valid. |
| `resume` | Periodic plans: `nextChargeAt` is **required** (Cashfree's `ACTIVATE` needs the date). On-demand: the scheduler resumes. |
| `update` | Only `planId` (periodic plans, through `CHANGE_PLAN`). To change the amount, create a plan with the new amount and move to it. `quantity`, `mandateEndsAt`, `timing: AtPeriodEnd` and `notifyCustomer: true` throw `UNSUPPORTED`. For an on-demand subscription the facade applies `amount`, `nextChargeAt` and `remainingCycles` to the schedule, after checking the amount against the mandate ceiling. |
| `cancel` | Immediately. `CancelMode.AtPeriodEnd` throws `UNSUPPORTED`. |
| `charges.refund` | Needs `subscriptionId`. Without `amount` the adapter reads the charge and refunds all of it. Refund speed is left to Cashfree: UPI allows only standard refunds, eNACH only instant ones. |
| `charges.list` | Newest first by initiation date; Cashfree documents no paging or order, so the adapter imposes the order. |

## Statuses

<!-- generated:begin cashfree-subscription-status -->

| Cashfree subscription status | Unified status |
|---|---|
| `INITIALIZED` | `created` |
| `BANK_APPROVAL_PENDING` | `pending_authorization` |
| `ACTIVE` | `active` |
| `ON_HOLD` | `halted` |
| `PAUSED` | `paused` |
| `CUSTOMER_PAUSED` | `paused` |
| `COMPLETED` | `completed` |
| `CUSTOMER_CANCELLED` | `cancelled` |
| `CANCELLED` | `cancelled` |
| `EXPIRED` | `expired` |
| `LINK_EXPIRED` | `expired` |
| `CARD_EXPIRED` | `expired` |

<!-- generated:end -->

A status Cashfree adds in future maps to `created`, which is safe: it does not charge. When a periodic subscription is `ACTIVE` but its first charge is still ahead, the adapter reports `trialing`.

<!-- generated:begin cashfree-charge-status -->

| Cashfree payment status | Unified charge status |
|---|---|
| `INITIALIZED` | `scheduled` |
| `PENDING` | `pending` |
| `SUCCESS` | `succeeded` |
| `FAILED` | `failed` |
| `CANCELLED` | `cancelled` |

| Cashfree payment type | Unified charge kind |
|---|---|
| `AUTH` | `authorization` |
| `CHARGE` | `recurring` |

<!-- generated:end -->

An unknown payment status becomes `pending`, never `failed`, so the scheduler keeps asking instead of debiting again. A cancelled charge is reported as a failed charge whose status is `cancelled`.

<!-- generated:begin cashfree-refund-status -->

| Cashfree refund status | Unified refund status |
|---|---|
| `INITIALIZED` | `pending` |
| `SUCCESS` | `succeeded` |
| `CANCEL` | `failed` |
| `CANCELLED` | `failed` |
| `PENDING` | `pending` |
| `FAILED` | `failed` |

<!-- generated:end -->

## Webhooks

Subscription webhooks have their own setting in the Cashfree Dashboard: **Payment Gateway, Developers, Webhooks, Subscriptions tab**. An endpoint configured only in the main webhooks section does not receive them. Cashfree signs each delivery with `base64(HMAC_SHA256(secret, timestamp + rawBody))`; the headers are `x-webhook-signature` and `x-webhook-timestamp`. The timestamp's format is not documented, so no replay window is enforced.

Cashfree sends no event id, so the library builds one from the event type, the entity's id, its status and the event time. A repeat has the same id; a later transition does not. Cashfree does not replay webhooks. If you miss one, call `charges.get`.

<!-- generated:begin cashfree-webhook-events -->

| Status in `SUBSCRIPTION_STATUS_CHANGED` | Unified event |
|---|---|
| `INITIALIZED` | `subscription.updated` |
| `BANK_APPROVAL_PENDING` | `subscription.updated` |
| `ACTIVE` | `subscription.activated` |
| `ON_HOLD` | `subscription.halted` |
| `PAUSED` | `subscription.paused` |
| `CUSTOMER_PAUSED` | `subscription.paused` |
| `COMPLETED` | `subscription.completed` |
| `CUSTOMER_CANCELLED` | `subscription.cancelled` |
| `CANCELLED` | `subscription.cancelled` |
| `EXPIRED` | `subscription.expired` |
| `LINK_EXPIRED` | `subscription.expired` |
| `CARD_EXPIRED` | `subscription.expired` |

<!-- generated:end -->

Payment webhooks map to events like this:

| Cashfree event | Unified event |
|---|---|
| `SUBSCRIPTION_AUTH_STATUS` | `subscription.authorized`, `subscription.authorization_failed`, or `subscription.updated` while the bank has not confirmed |
| `SUBSCRIPTION_PAYMENT_NOTIFICATION_INITIATED` | `subscription.charge_scheduled` |
| `SUBSCRIPTION_PAYMENT_SUCCESS` | `subscription.charged` |
| `SUBSCRIPTION_PAYMENT_FAILED` | `subscription.charge_failed` |
| `SUBSCRIPTION_PAYMENT_CANCELLED` | `subscription.charge_failed`, with the charge's status `cancelled` |
| `SUBSCRIPTION_REFUND_STATUS` | `refund.succeeded` or `refund.failed` |
| Card expiry reminders and the controlled-charge events | `unknown` |

Only an `ACTIVE` mandate maps to `subscription.activated`. A mandate that is `BANK_APPROVAL_PENDING` is `subscription.updated`, so the scheduler does not start raising debits that Cashfree would reject.

## One-time payments

A one-time payment on Cashfree is a Cashfree **order**: you create the order on your server, the customer pays it in Cashfree's hosted checkout, and you read the order back to learn the outcome. The adapter uses the same API version as subscriptions (`2026-01-01`), the same credentials and the same webhook secret.

### What to call

| Call | On Cashfree |
|---|---|
| `payments.create` | `POST /orders`. Returns a `Payment` with `status: created` and a `cashfree_checkout` instruction. |
| `payments.get` | `GET /orders/{id}`, `GET /orders/{id}/payments` and, for a paid order, `GET /orders/{id}/refunds`. The source of truth. |
| `payments.verify` | The same reads, for the order named by the return URL. |
| `payments.refund` | `POST /orders/{id}/refunds`. |

`Payment.id` is Cashfree's `order_id`, because every order, payment-list and refund endpoint takes it. It is also `Payment.reference`. Cashfree's `cf_payment_id` belongs to one payment attempt, exists only once the customer has chosen a method, and an order can have several; it stays in `raw`. The id that `payments.create` returns is the one `payments.get`, `payments.refund` and the webhooks use from then on.

```ts
import { randomUUID } from 'node:crypto';
import { cashfree, createSubscriptions, Environment, PaymentMethod, Provider } from 'india-subscriptions';

const subs = createSubscriptions({
  providers: [
    cashfree({
      clientId: process.env.CASHFREE_CLIENT_ID!,
      clientSecret: process.env.CASHFREE_CLIENT_SECRET!,
      environment: Environment.Test,
    }),
  ],
});

const payment = await subs.payments.create(Provider.Cashfree, {
  reference: 'invoice-2026-0412', // becomes the order id
  amount: 49900, // paise: 499 rupees
  description: 'Annual report',
  customer: { name: 'Asha Rao', email: 'asha@example.com', phone: '9876543210' },
  paymentMethods: [PaymentMethod.Upi, PaymentMethod.Card],
  returnUrl: 'https://shop.example.com/pay/return',
  expiresAt: '2026-12-01T10:00:00+05:30',
  metadata: { cart: '7' },
  idempotencyKey: randomUUID(),
});

// Store payment.id with your order, and send payment.checkout to the browser.
console.log(payment.id, payment.checkout);
```

### What the adapter sends

Every input has a place in the order, or it is refused. Nothing is dropped.

| You pass | Sent as | Rule |
|---|---|---|
| `reference` | `order_id` | 3 to 45 letters, digits, `_` and `-`. Without one the adapter generates `order_` and 32 hex digits. A reused id is `CONFLICT`. |
| `amount` | `order_amount`, in rupees | At least 100 paise: Cashfree's minimum is one rupee. |
| `customer.phone` | `customer_phone` | Required. The same rule as for a subscription: a 10-digit Indian mobile number, with or without `+91`. |
| `customer.email`, `customer.name` | `customer_email`, `customer_name` | Optional for an order (a subscription needs an e-mail). 3 to 100 characters. |
| `customer.id` | `customer_id` | 3 to 50 letters, digits, `_` and `-`. Cashfree requires one, so without it the adapter uses `cust_` and the phone number, which keeps one customer under one id. |
| `description` | `order_note` | 3 to 200 characters. |
| `paymentMethods` | `order_meta.payment_methods_filters` | `upi`, `card` (credit, debit and prepaid cards), `netbanking` and `wallet`. `enach` and `physical_nach` throw `UNSUPPORTED`: they are mandate methods. |
| `returnUrl` | `order_meta.return_url` | The adapter adds `order_id=<order id>` to its query (see below). At most 250 characters with it. A `returnUrl` that already has a different `order_id` is refused. |
| `expiresAt` | `order_expiry_time` | Must be in the future; sent as an IST timestamp. |
| `metadata` | `order_tags` | At most 10 entries, each value 1 to 255 characters. |
| `idempotencyKey` | `x-idempotency-key` | Must be a UUID: Cashfree's header has that format. With a key the create is retried safely. |

`customer.state` and `storeProduct` have no Cashfree field and are not sent. Without an `idempotencyKey`, a create that gets no response is `OUTCOME_UNKNOWN`; the order id is unique, so `payments.get` with your `reference` tells you whether the order exists.

### The checkout step

`payment.checkout` has `kind: CheckoutKind.CashfreeCheckout`, the payment session id as `sessionId`, the environment, and `productKind: ProductKind.OneTime`. `openCheckout` from [`india-subscriptions/checkout`](../guides/checkout.md) loads Cashfree.js and calls `checkout` with that session id and a `redirectTarget` (`_self` by default). A subscription instruction, which has no `productKind`, still calls `subscriptionsCheckout`.

```ts
import { CheckoutStatus, openCheckout, type CheckoutInstruction } from 'india-subscriptions/checkout';

export async function pay(checkout: CheckoutInstruction): Promise<void> {
  const outcome = await openCheckout(checkout);
  if (outcome.status === CheckoutStatus.Failed) {
    console.error(outcome.error.message);
  }
  // Otherwise the customer is on Cashfree's page and comes back to your returnUrl.
}
```

Cashfree requires your website domain to be whitelisted in the Dashboard before Cashfree.js will open the checkout. The helper opens redirect targets only (`_self`, `_blank`, `_top`); Cashfree's pop-up and inline checkouts are not wired in.

### Confirming the payment

Cashfree documents no signature and no parameters of its own on the return URL: it sends the customer to your `return_url` with a GET request, and tells you to put the order id in that URL yourself. So `payments.create` adds `order_id=<order id>` to the URL, and `payments.verify` reads only that value from what comes back. It then fetches the order, its payment attempts and its refunds from Cashfree. Nothing else in the query is trusted: a forged `order_status=PAID` changes nothing.

`paid` is `true` only when Cashfree reports the order `PAID`. A partly refunded payment is still paid; a fully refunded one is not. Always pass `expectedPaymentId`, the id your server stored when it created the payment, so that the return URL of one order cannot be used to unlock another.

```ts
import { ErrorCode, isSubscriptionError, Provider } from 'india-subscriptions';
import { subs } from './billing';

// Stands in for your session: the payment id your server stored at creation.
declare function storedPaymentId(request: Request): Promise<string>;

// A route handler for GET /pay/return, in the style of Next.js.
export async function GET(request: Request): Promise<Response> {
  const result = Object.fromEntries(new URL(request.url).searchParams);
  try {
    const verification = await subs.payments.verify(Provider.Cashfree, result, {
      expectedPaymentId: await storedPaymentId(request),
    });
    return Response.redirect(new URL(verification.paid ? '/thanks' : '/pay/pending', request.url));
  } catch (error) {
    if (isSubscriptionError(error) && error.code === ErrorCode.SignatureInvalid) {
      return new Response(null, { status: 400 }); // the result belongs to another payment
    }
    throw error;
  }
}
```

A customer who closes the browser never reaches the return URL. Cashfree says not to rely on the redirect alone, so also act on the webhook, or call `payments.get`, which needs nothing from the browser.

### Statuses

The order decides the payment's status, not any single attempt: Cashfree lets the customer retry a failed attempt until the order ends.

| Cashfree order status | Unified status | Notes |
|---|---|---|
| `ACTIVE` | `created` | No successful payment yet. `pending` while an attempt is in flight. A failed attempt leaves it `created`, because the customer can try again. |
| `PAID` | `succeeded` | `partially_refunded` or `refunded` once successful refunds cover part or all of the amount. |
| `EXPIRED` | `failed` | `pending` while an attempt started before the expiry is still in flight: Cashfree says such an order can still become `PAID`. |
| `TERMINATED` | `cancelled` | The order was terminated; the customer can no longer pay. |
| `TERMINATION_REQUESTED` | `pending` | A pending payment that succeeds meanwhile still wins. |

A status Cashfree adds in future maps to `pending`, never to `succeeded` or `failed`, and stays visible in `providerStatus`. For a failed or cancelled order, `failureCode` and `failureReason` come from the latest failed attempt's `error_details`.

Each payment attempt has its own status, which is what a webhook reports:

| Cashfree attempt status | Unified status |
|---|---|
| `SUCCESS` | `succeeded` |
| `NOT_ATTEMPTED` | `created` |
| `PENDING` | `pending` |
| `FLAGGED` | `pending` |
| `FAILED` | `failed` |
| `USER_DROPPED` | `cancelled` |
| `VOID` | `cancelled` |
| `CANCELLED` | `cancelled` |

`Payment.paymentMethod` is read from the successful attempt's `payment_group`: `upi`, the card groups and `*_emi` become `card`, `net_banking` becomes `netbanking`, and `wallet` stays `wallet`. A group with no unified method (cash, pay later, bank transfer) leaves it unset. `Payment.amount` is the order amount; Cashfree notes that the amount a customer pays can differ when you collect a service fee.

### Refunds

`payments.refund` takes the order id as `paymentId`.

```ts
import { Provider } from 'india-subscriptions';
import { subs } from './billing';

export async function refundPart(paymentId: string) {
  return subs.payments.refund(Provider.Cashfree, {
    paymentId,
    refundId: 'refund-2026-0412-1',
    amount: 10000,
    reason: 'Item returned',
  });
}
```

`refundId` is 3 to 40 letters, digits, `_` and `-`, and `reason` 3 to 100 characters. Cashfree needs an amount, so without `amount` the adapter reads the successful attempt and the refunds already asked for, and refunds what is left; it throws `VALIDATION` if the order has no successful payment or is already refunded in full. The `x-idempotency-key` is derived from the order id and the refund id, so retrying the same refund cannot create two. The returned `Refund` has both `chargeId` and `paymentId` set to the order id, and its status is usually `pending`: Cashfree accepts the request at once and reports the outcome later by webhook. Cashfree allows refunds within six months of the payment, allows several partial refunds up to the captured amount, and says some payment methods do not support partial refunds. Refund speed is left to Cashfree's default (`STANDARD`).

| Cashfree refund status | Unified status |
|---|---|
| `SUCCESS` | `succeeded` |
| `PENDING` | `pending` |
| `PENDING_APPROVAL` | `pending` |
| `ONHOLD` | `pending` |
| `CANCELLED` | `failed` |
| `REJECTED` | `failed` |

### Payment webhooks

Payment-gateway webhooks are set up in the main **Payment Gateway, Developers, Webhooks** section of the Dashboard, separate from the Subscriptions tab. They are signed exactly like subscription webhooks (`base64(HMAC_SHA256(secret, timestamp + rawBody))`), and the adapter tells the two families apart by the `type` field: payment-gateway types are `PAYMENT_*` and `REFUND_STATUS_WEBHOOK` with an `order` and `payment` in `data`; every subscription type starts with `SUBSCRIPTION_`. Subscription mapping is unchanged.

| Cashfree event | Unified event |
|---|---|
| `PAYMENT_SUCCESS_WEBHOOK` | `payment.succeeded`, with `paymentId` (the order id) and `payment` |
| `PAYMENT_FAILED_WEBHOOK` | `payment.failed` |
| `PAYMENT_USER_DROPPED_WEBHOOK` | `payment.failed`, with the payment's status `cancelled` |
| `PAYMENT_CHARGES_WEBHOOK` | `unknown`: it reports fees, but still carries `paymentId` |
| `REFUND_STATUS_WEBHOOK` | `refund.succeeded` for `SUCCESS`, `refund.failed` for `CANCELLED` and `REJECTED`, with `paymentId`; `unknown` while the refund is still moving |
| `AUTO_REFUND_STATUS_WEBHOOK` | `unknown` |

Three things to know:

- **A failed attempt is not a failed order.** Cashfree allows several attempts per order and calls `FAILED` and `PENDING` transitional, so `payment.failed` describes one attempt and its `payment.status` is that attempt's. Treat only `payment.succeeded` as final, and call `payments.get` before you give up on an order.
- **Retries and duplicates.** Cashfree delivers at least once. The event id is built from the event type, the attempt's `cf_payment_id`, its status and the event time, so a redelivery has the same id. Deduplicate on `event.id`.
- **Auto refunds and other orders.** Auto refunds (for example a second payment against the same order) refund an extra payment, not the order's own, so they are never reported as `refund.succeeded` for the order. Orders created outside this library, such as through payment links, also fire these webhooks and arrive as events for an id you did not store.

```ts
import { EventType, type SubscriptionEvent } from 'india-subscriptions';

export function react(event: SubscriptionEvent): string | undefined {
  switch (event.type) {
    case EventType.PaymentSucceeded:
      return `fulfil the order ${event.paymentId}`;
    case EventType.RefundSucceeded:
      return `record the refund of ${event.refund?.paymentId ?? event.refund?.chargeId}`;
    default:
      return undefined;
  }
}
```

### Limits

| Limit | Value |
|---|---|
| Smallest payment | 1 rupee (`order_amount` has a minimum of 1) |
| Methods | `upi`, `card`, `netbanking`, `wallet` |
| Order expiry | Cashfree documents 5 minutes to 30 days for the Dashboard setting; the bounds for a per-order `expiresAt` are not stated |
| Order id, customer id | 3 to 45 and 3 to 50 characters |
| Return URL | 250 characters, including the `order_id` the adapter adds |
| Refund window | 6 months from the payment |

Not built: Cashfree's pop-up and inline checkouts, order splits (Easy Split), payment links, pre-authorised captures, international currencies and Cashfree's other payment modes (pay later, cardless EMI, bank transfer, Apple Pay); the order's `notify_url` (use the Dashboard webhook).

## Testing in the sandbox

Cashfree's sandbox base URL is `https://sandbox.cashfree.com/pg`. To move a charge to a result, call Cashfree's Simulate Payment API (`POST /pg/simulate`) with `entity: SUBS_PAYMENTS` and the payment id; the payment must be `PENDING`. A periodic subscription's payment only leaves `INITIALIZED` on its real billing date, and the sandbox cannot move time forward, so use an **on-demand** plan to test charges quickly: raise a charge, then simulate its result. Specific test UPI ids, test cards and OTPs for subscriptions are not stated anywhere in Cashfree's documentation. In the sandbox the authorisation responses for eNACH, card and UPI differ from production.

## Not built

Physical NACH, the controlled notify-and-execute flow, and the legacy `/api/v2/subscriptions` API.
