# Paytm

Paytm Subscriptions can collect each cycle itself, or leave every debit to you. This adapter defaults to **you**, driven by the library's [billing scheduler](../guides/scheduler.md), and offers Paytm's own collection for plain fixed plans.

| | Merchant mode (default) | Paytm mode |
|---|---|---|
| Who raises each debit | The billing scheduler, through Paytm's Renew API | Paytm, on each due date |
| Needs a scheduler | Yes | No |
| You ask for it with | Nothing (or `plan.scheduling: SchedulingMode.Merchant`) | `plan.scheduling: SchedulingMode.Gateway` |
| Amounts | Fixed or variable, up to the mandate ceiling | **Fixed only** |
| Daily billing | Yes | **No** |
| Trials of any length | Yes | Only when the first debit is today or one cycle away on UPI |
| Retries | The scheduler's | Paytm's (grace days and a retry count) |

This page also covers [one-time payments](#one-time-payments), which use Paytm's standard payment gateway rather than its subscription service.

The scheduler is the default because Paytm's own collection cannot do what most products need. Paytm's documentation says manual collection is **mandatory** for variable amounts, on-demand plans and daily frequency, and on UPI Paytm accepts a future start date only when it is **today or exactly one period away**. A trial of arbitrary length therefore cannot use Paytm's collection.

::: info Enterprise merchants
Paytm's documentation describes subscriptions as available to **enterprise merchants**: ask Paytm to enable them on your merchant id before you start.
:::

## Configuration

```ts
import { Environment, MemorySchedulerStore, createSubscriptions, paytm } from 'india-subscriptions';

export const subs = createSubscriptions({
  providers: [
    paytm({
      mid: process.env.PAYTM_MID!,
      merchantKey: process.env.PAYTM_MERCHANT_KEY!,
      website: 'WEBSTAGING',
      environment: Environment.Test,
      callbackUrl: 'https://shop.example.com/paytm/return',
    }),
  ],
  scheduler: { store: new MemorySchedulerStore() },
});
```

| Option | Required | Meaning |
|---|---|---|
| `mid` | yes | Your merchant id. It differs between staging and production. |
| `merchantKey` | yes | The merchant key. It is the AES-128 key of the checksum, so it must be **exactly 16 bytes**. It is never put in an error, a log line, `raw` or a checkout field. |
| `website` | yes | The `websiteName`: `WEBSTAGING` on staging, `DEFAULT` on production, or the name Paytm gave you. |
| `environment` | yes | `Environment.Test` (staging hosts) or `Environment.Live`. |
| `callbackUrl` | no | Default page Paytm posts the customer's result to. A subscription's `returnUrl` overrides it. Without either, Paytm uses the URL configured for `website`. |
| `graceDays`, `retryCount` | no | Grace days and retry count sent for merchant-collected subscriptions. The default grace is the days to the first debit plus 2, capped by what the cycle length and payment modes allow; the default retry count is 3. |
| `mandateYears` | no | How long a subscription without an end date lasts. Default 5 years. Paytm requires an expiry date. |
| `debitReason` | no | The reason shown to the customer in the pre-debit notice (at most 50 characters). Default "Subscription renewal". |
| `channelId`, `clientId` | no | `head.channelId` (`WEB` or `WAP`) and `head.clientId`, for accounts that need them. |
| `subscriptionBaseUrl`, `transactionStatusBaseUrl`, `refundBaseUrl`, `checkoutBaseUrl` | no | Replace the Paytm hosts. Each API goes to the host **its own reference page** prints, because Paytm's pages name two host families (`paytmpayments.com` and `paytmpayments.in`). |

The service reads the same settings from the `PAYTM_*` [environment variables](../reference/generated/environment.md#paytm).

## Capabilities

<!-- generated:begin capabilities paytm -->
<!-- generated:end -->

`scheduling` lists both modes, merchant first. The adapter-level `pause: yes` and `resume: yes` are Paytm's own APIs and apply to a Paytm-collected subscription. For a merchant-scheduled one the facade pauses and resumes through the scheduler instead and leaves the mandate valid.

## How a subscription works on Paytm

`createSubscription` calls Paytm's Initiate Subscription API and returns the subscription (its `id` is Paytm's `subscriptionId`, its `reference` your order id, status `created`) with a **form post** to Paytm's payment page. The form holds only `mid`, `orderId` and a one-time `txnToken`; the merchant key is never in it.

```mermaid
sequenceDiagram
  participant App as Your server
  participant Browser as Customer's browser
  participant Paytm
  participant Sched as Billing scheduler
  App->>Paytm: initiate subscription (signed)
  Paytm-->>App: subscription id, txn token
  App-->>Browser: checkout instruction (form post)
  Browser->>Paytm: customer authorises (UPI, card or eNACH)
  Paytm-->>Browser: result posted to your callback URL
  Browser->>App: Paytm's fields
  App->>App: verifyCheckout checks the checksum, reads the status
  App->>Sched: activate the schedule
  loop every cycle (merchant mode)
    Sched->>Paytm: pre-notify (UPI and cards)
    Sched->>Paytm: renew (the debit)
    Sched->>Paytm: transaction status until final
  end
```

### What you must supply

- The plan **inline**. A plan id string throws `VALIDATION`; `plans.create` and `plans.get` throw `UNSUPPORTED`.
- `reference` becomes Paytm's order id: at most 50 characters of letters, digits and `@ . _ -`, and **not starting with `pay_`**, which is reserved for [one-time payments](#one-time-payments) (the same applies to a debit's `chargeId`). Without one a `sub_...` id is generated. The customer id (`custId`), when you give none, is derived from the order id.
- A 10-digit Indian mobile number (with or without `+91`) for the customer, and an e-mail address.
- No `|` character in any request value.
- `quantity` other than 1 is not supported. `authorizeBy`, `upfrontLabel`, `metadata` and `idempotencyKey` have no Paytm equivalent and are ignored (the order id is the natural idempotency key: Paytm refuses a repeated one).
- `paymentMethods`: `upi`, `card` and `enach`. Paper mandates are not built.

### Billing intervals

Paytm's request takes a frequency **unit with no multiplier**, so only these intervals are accepted. Any other interval throws `VALIDATION`:

<!-- generated:begin paytm-frequencies -->

| Plan interval | Paytm frequency unit |
|---|---|
| 1 day | `DAY` |
| 1 week | `WEEK` |
| 1 month | `MONTH` |
| 2 month | `BI_MONTHLY` |
| 3 month | `QUARTER` |
| 6 month | `SEMI_ANNUALLY` |
| 12 month | `YEAR` |
| 1 year | `YEAR` |

<!-- generated:end -->

UPI Autopay takes week, month, two-month, quarter, half-year, year and on-demand units only; asking for UPI alone with a daily interval is refused.

### Trials, delayed starts and upfront amounts

| You pass | What the customer pays at sign-up |
|---|---|
| Nothing, or a `trial` | **₹0.** Paytm may take ₹1 itself for cards, UPI and wallet to complete authorisation. Whether it is refunded is not stated. |
| `upfrontAmount` | That amount as the first payment |

An upfront amount cannot exceed the mandate ceiling (merchant mode) or the renewal amount (Paytm mode, for UPI and eNACH). **With eNACH as the only method it must be zero**: Paytm refuses a non-zero first amount for bank mandates (code 4001), so the adapter throws `VALIDATION`.

**Merchant mode.** The subscription is created with a variable amount, the plan's ceiling as the maximum, `autoRenewal: false` and a start date of **today**. It is today because a later date would take UPI away from the payment page. The first debit may be days later, so the adapter sends **grace days** that cover the days to the first debit plus room for retries. Paytm's documentation does not say whether Renew is refused outside that window, so a long trial may fail its first debit: override with `graceDays` if it does. Paytm never retries by itself; the scheduler retries, each attempt under a new order id.

**Paytm mode.** The subscription is created with a fixed amount, `autoRenewal: true`, the start date set to the first debit date, and Paytm's documented retry defaults (two grace days, three retries; none for eNACH). The adapter refuses what Paytm cannot collect: a `maxAmount` different from `amount`, a daily interval, and, if UPI could be used, a first debit that is neither today nor exactly one cycle from today. Paytm sends the pre-debit notification itself.

### Pre-debit notification and the debit (merchant mode)

For UPI, wallet and cards the scheduler calls **Pre-Notify** before each debit; the reference id it sends comes back as `ChargeNotification.invoiceNumber` and is passed on the Renew call. **Bank mandates (eNACH) need no pre-notification**: the adapter reads the payment mode and returns an accepted notification without a request. Paytm's own pages disagree about cards and about timing (24, 48 or 72 hours): the scheduler's defaults of 48 hours ahead and 24 minimum apply.

The debit is **Renew**, with your debit id as Paytm's order id. Paytm only acknowledges it ("Subscription Txn accepted"), so the charge is `pending`; its end comes from Transaction Status or the payment webhook. Paytm refuses a repeated order id (code 325), so a re-sent debit id cannot debit twice, and the refusal is `CONFLICT`. There is **no lookup before debiting**: the adapter relies on that refusal. A failure Paytm does not list is `OUTCOME_UNKNOWN`, never a failed debit.

Paytm allows one collection per subscription per cycle, and none against an expired or cancelled subscription.

## Payment methods and limits

| | UPI Autopay | Cards | eNACH (bank mandate) |
|---|---|---|---|
| Limit per debit | ₹15,000, and ₹1,00,000 for insurance, credit-card bill payments and mutual funds. Above that the customer needs additional factor authentication. | ₹15,000 without it (same exceptions) | ₹10,00,000 in Paytm's main table; up to ₹1,00,00,000 on its marketing page |
| First amount | Up to the mandate ceiling | Same | **Must be zero** |
| Pre-notification | Mandatory | Pages disagree | Not needed |
| Grace days and retries | Yes | Up to 3 grace days (one page says none) | None |
| Refunds | Yes | Yes | **Not supported by Paytm** |
| Authorisation | UPI PIN | OTP or 3-D Secure | Net banking or debit card; activation can take up to 2 days |

A customer may hold at most 5 active subscriptions per merchant (configurable). Other Paytm limits (per-day, per-month and RBI monthly debit limits) surface as Renew rejections.

Payment modes read from Paytm map to unified methods like this. Paytm Wallet, balance and postpaid have no unified method, and net banking is a one-off method, not a mandate:

<!-- generated:begin paytm-payment-modes -->

| Paytm payment mode | Unified payment method |
|---|---|
| `UPI` | `upi` |
| `UPI_INTENT` | `upi` |
| `CC` | `card` |
| `CREDIT_CARD` | `card` |
| `DC` | `card` |
| `DEBIT_CARD` | `card` |
| `BANK_MANDATE` | `enach` |
| `BANKMANDATE` | `enach` |

<!-- generated:end -->

## Pause, resume, cancel

- **Pause and resume** exist as Paytm APIs (`ACTIVE` and `SUSPENDED`). They take no date, so `resumeAt` and `nextChargeAt` throw `UNSUPPORTED`. For a merchant-scheduled subscription the facade uses the scheduler instead.
- **Cancel** is permanent ("cannot be reactivated once cancelled"). Repeating it is safe: if the call fails, the state is read and a mandate that is already over is returned as it is. `CancelMode.AtPeriodEnd` throws `UNSUPPORTED`. After a cancel, Paytm's status is `REJECT`, which maps to `cancelled`.
- **Update** accepts only `amount`, in merchant mode, within the mandate's ceiling (`plan.maxAmount`, else the plan amount): Paytm holds only the ceiling, so the new amount goes to the billing schedule. Above the ceiling is `VALIDATION` (a new mandate is needed). Every other field is `UNSUPPORTED`, and so is any update of a Paytm-collected subscription, whose fixed `autoRenewal` cannot be edited: cancel and create a new one.

## Authorisation and checkout

`subscription.checkout` has `kind: CheckoutKind.FormPost` with Paytm's payment-page URL and the fields above. [`openCheckout`](../guides/checkout.md) builds and submits the form. Paytm then posts the result to your `callbackUrl`.

`verifyCheckout` takes that posted form. Its `CHECKSUMHASH` is verified over all other fields (`SIGNATURE_INVALID` otherwise; nothing is read from a result that fails). The result is only the browser's word, and a bank mandate becomes active later, so the subscription's status is then **fetched**, and `authorized` is true only when Paytm says `ACTIVE`. Always pass `expectedSubscriptionId` (your order id or Paytm's subscription id).

## Statuses

<!-- generated:begin paytm-subscription-status -->

| Paytm subscription status | Unified status |
|---|---|
| `INIT` | `created` |
| `IN_AUTHORIZATION` | `pending_authorization` |
| `AUTHORISED` | `pending_authorization` |
| `AUTHORIZED` | `pending_authorization` |
| `CONFIRMED` | `pending_authorization` |
| `ACTIVE` | `active` |
| `SUSPENDED` | `paused` |
| `EXPIRED` | `expired` |
| `REJECT` | `cancelled` |
| `CLOSED` | `expired` |
| `AUTHORIZATION_FAILED` | `failed` |

<!-- generated:end -->

A status Paytm adds later is `pending_authorization`, which neither starts nor stops billing. `CONFIRMED` has no definition in Paytm's documentation and is treated as not yet live. Paytm spells `AUTHORISED` two ways; both are read. Subscription timestamps are read as IST.

<!-- generated:begin paytm-charge-status -->

| Paytm transaction status | Unified charge status |
|---|---|
| `TXN_SUCCESS` | `succeeded` |
| `TXN_FAILURE` | `failed` |
| `PENDING` | `pending` |

<!-- generated:end -->

A debit whose status is not listed is `pending`, never failed: treating an unknown answer as failed would let the scheduler start a second debit while the first may be live. Transaction Status answers "no record" (331) and "invalid order id" (334) as `NOT_FOUND`, which the scheduler reads as "never reached Paytm". Other `TXN_FAILURE` codes that are not failed debits (a wrong merchant id, "Server Down") are errors, not failed charges.

## Refunds

`charges.refund` uses Paytm's asynchronous Refund API. `chargeId` is the debit's order id; the adapter reads the transaction first (only a successful one can be refunded) and refunds all of it unless you pass `amount`. **Debits on eNACH or bank mandates are refused with `UNSUPPORTED`**: Paytm does not refund them. `refundId` is unique at Paytm, so repeating a refund cannot refund twice. The result is `pending` unless Paytm says it is final.

## Webhooks

Configure the webhook URLs with Paytm: the subscription-status webhook URL is set by Paytm support. Key-value notifications (subscription status, payment, pre-notify callback and the refund reference) are signed with `CHECKSUMHASH` over all the other fields; JSON refund notifications carry a `head.signature` over `body`. The adapter verifies each with the rule its kind needs before reading anything, and an **unsigned refund webhook is rejected**. Event ids are built from the content, never from the salted checksum, so a redelivery has the same id.

<!-- generated:begin paytm-webhook-events -->

| Status in the subscription status webhook | Unified event |
|---|---|
| `ACTIVE` | `subscription.activated` |
| `SUSPENDED` | `subscription.paused` |
| `REJECT` | `subscription.cancelled` |
| `EXPIRED` | `subscription.expired` |
| `CLOSED` | `subscription.expired` |
| `AUTHORIZATION_FAILED` | `subscription.authorization_failed` |
| `AUTHORIZED` | `subscription.authorized` |
| `AUTHORISED` | `subscription.authorized` |

| Status in the payment webhook | Unified event |
|---|---|
| `TXN_SUCCESS` | `subscription.charged` |
| `TXN_FAILURE` | `subscription.charge_failed` |

<!-- generated:end -->

An `ACTIVE` status whose sub-status is `RESUMED` is a resume (`subscription.resumed`). The payment webhook **cannot tell an upfront payment from a renewal**, so a `subscription.charged` event may describe either: for a merchant-scheduled subscription the scheduler matches it to its own debit by id, and an upfront payment matches none. A pre-notify callback is `subscription.charge_scheduled` when Paytm reports it delivered, otherwise `unknown`. The refund reference (ARN) notification is `unknown`; the JSON Success Refund notification is `refund.succeeded` or `refund.failed`.

## One-time payments

`capabilities.oneTimePayments` is `true` and `oneTimePaymentMethods` lists `upi`, `card`, `netbanking` and `wallet`. A payment goes through Paytm's Initiate Transaction API and the same form-post payment page as a subscription, so the customer sees one Paytm page whether they subscribe or pay once.

| You call | Paytm API | What comes back |
|---|---|---|
| `payments.create` | Initiate Transaction (request type `Payment`) | A `Payment` with status `created` and a `checkout` form post |
| `payments.verify` | Transaction Status, after the checksum of the callback | `paid`, and the `Payment` as Paytm reports it |
| `payments.get` | Transaction Status | The `Payment` |
| `payments.refund` | Refund | A `Refund` that is `pending` until Paytm says otherwise |

```ts title="paytm-one-time-payment.ts"
import { PaymentMethod, Provider, type Subscriptions } from 'india-subscriptions';

export async function startPayment(subs: Subscriptions, orderNumber: string) {
  const payment = await subs.payments.create(Provider.Paytm, {
    reference: orderNumber,
    amount: 49900,
    description: 'Pro plan, one month',
    customer: { id: 'CUST_001', name: 'Ashish Kumar', email: 'ashish@example.com', phone: '+919876543210' },
    paymentMethods: [PaymentMethod.Upi, PaymentMethod.Card],
    returnUrl: 'https://shop.example.com/paytm/return',
  });
  // Store payment.id: it is the id for every later call. Send payment.checkout to the browser.
  return payment;
}

export async function onReturn(subs: Subscriptions, fields: Record<string, string>, paymentId: string) {
  // `fields` is the form Paytm posts to your callback URL, exactly as received.
  const verification = await subs.payments.verify(Provider.Paytm, fields, { expectedPaymentId: paymentId });
  return verification.paid;
}

export async function refundPart(subs: Subscriptions, paymentId: string) {
  return subs.payments.refund(Provider.Paytm, { paymentId, refundId: 'refund_2001', amount: 10000, reason: 'Customer returned one item' });
}
```

### The payment id

`Payment.id` is Paytm's **order id**, and it is `pay_` followed by your `reference` (or by a generated token when you give none). Paytm keys Transaction Status and Refund by order id, so the id `payments.create` returns is the one `payments.get`, `payments.refund` and the webhooks use, with no mapping to store. `Payment.reference` is the part after `pay_`, so `payments.verify` accepts either the id or your reference as `expectedPaymentId`.

The prefix exists because of how Paytm's webhooks are built. Paytm's documentation says a subscription debit ends with the same "Payment S2S callback" as a one-time payment, and neither payload names the flow: the Payment Status fields (`ORDERID`, `TXNID`, `TXNAMOUNT`, `STATUS` and so on) carry no subscription id. The order id is therefore what tells the two apart. This leaves three rules to know:

- A reference is at most 46 characters (the order id is at most 50). `createSubscription` and `createCharge` refuse a reference that starts with `pay_`, so the two cannot collide.
- `getPayment` and `refundPayment` accept only ids that start with `pay_`; any other order id is `VALIDATION`.
- A payment made at Paytm outside this library, under another order id, is reported by the webhook as a subscription debit.

### What the payment page needs

```mermaid
sequenceDiagram
  participant App as Your server
  participant Browser as Customer's browser
  participant Paytm
  App->>Paytm: initiate transaction (signed)
  Paytm-->>App: txn token
  App-->>Browser: checkout instruction (form post)
  Browser->>Paytm: customer pays on Paytm's page
  Paytm-->>Browser: fields posted to your callback URL
  Browser->>App: Paytm's fields
  App->>Paytm: verify checks the checksum, then Transaction Status
  Paytm-->>App: final status
  Paytm-->>App: Payment Status webhook (server to server)
```

`payment.checkout` has `kind: CheckoutKind.FormPost`. Its fields are only `mid`, `orderId` and the transaction token; the merchant key is never in it. [`openCheckout`](../guides/checkout.md) builds and submits the form. Paytm's documentation says the transaction token is valid for 15 minutes, so send the customer to the page soon after creating the payment.

| Input | What happens |
|---|---|
| `amount` | Sent as rupees with two decimals in `txnAmount` |
| `customer` | Sent as `userInfo`. A 10-digit Indian mobile number (with or without `+91`) is required if you pass a phone. `customer.id` becomes `custId`; without one it is derived from the order id. `customer.state` is not sent. |
| `reference` | Becomes the order id after `pay_` |
| `paymentMethods` | Limits the page with `enablePaymentMode`: `upi` is `UPI`, `card` is `CREDIT_CARD` and `DEBIT_CARD`, `netbanking` is `NET_BANKING`, `wallet` is `BALANCE`. `enach` and `physical_nach` are `VALIDATION`. |
| `returnUrl` | Sent as `callbackUrl`; without one the `callbackUrl` of the configuration, then the URL Paytm holds for your `website` |
| `description` | Sent in `extendInfo.comments` |
| `expiresAt` | **Refused with `UNSUPPORTED`.** Initiate Transaction takes no expiry. |
| `metadata` | **Refused with `UNSUPPORTED`.** Initiate Transaction has no key-value field, and no callback, webhook or status answer returns one. Keep it next to the payment id on your side. |
| `idempotencyKey` | Not sent. The order id is the natural key: Paytm answers a repeat of the same request for the same order id with "Success Idempotent", and a different request with "Repeat Request Inconsistent" (`CONFLICT`). Pass a `reference` to make a retry safe. |

A create call that gets no answer, or an answer without a verdict, is `OUTCOME_UNKNOWN`: the order may exist. Read it with `getPayment`, or repeat the call with the same `reference`.

### Verification

`verifyPayment` takes the form Paytm posts to your callback URL. It does three things, in this order:

1. Verifies `CHECKSUMHASH` over all the other fields, in constant time. A missing, wrong or tampered checksum is `SIGNATURE_INVALID`, and nothing is read from the result or sent to Paytm.
2. Refuses a result whose `ORDERID` does not start with `pay_` (`VALIDATION`): that callback belongs to [`verifyCheckout`](#authorisation-and-checkout).
3. Reads Transaction Status for the order. Paytm's documentation says the callback "can be intermediate or final" and strongly recommends fetching the final status before confirming an order, so `paid` and `payment` come from Transaction Status, never from the callback's own `STATUS`. If Transaction Status cannot be read, the call fails rather than guessing.

`paid` is true for a payment that succeeded, including one that has been refunded in part or whole since. Compare `payment.amount` with the amount of your own order before you fulfil it: Paytm's documentation names no amount check, so it is yours to make.

### Statuses and payment methods

| Paytm status | Unified status |
|---|---|
| `TXN_SUCCESS` | `succeeded` |
| `TXN_SUCCESS` with a refund amount | `partially_refunded`, or `refunded` when it equals the payment |
| `TXN_FAILURE` | `failed`, with Paytm's `RESPCODE` as `failureCode` and `RESPMSG` as `failureReason` |
| `PENDING` | `pending` |
| Any other status | `pending`, and the status stays visible in `providerStatus` |

An unknown status is never read as a failure or as a success: failing it could release an order or start a second attempt while the payment is live, and succeeding it would give goods away. A payment created and not yet attempted is `created`, which only `createPayment` returns.

Transaction Status answers `NO_RECORD_FOUND` (code 331) and "Invalid Order ID" (334) as `NOT_FOUND`. Paytm's page does not say whether an order that nobody has tried to pay has a record, so `getPayment` straight after `createPayment` may be `NOT_FOUND`. A wrong merchant id and "Server Down" are errors, never a failed payment.

| Paytm payment mode (`paymentMode`, `PAYMENTMODE`) | Unified payment method |
|---|---|
| `UPI`, `UPI_INTENT` | `upi` |
| `CC`, `CREDIT_CARD`, `DC`, `DEBIT_CARD` | `card` |
| `NB`, `NET_BANKING` | `netbanking` |
| `PPI`, `BALANCE` | `wallet` |
| `PPBL`, postpaid (`PAYTMCC`), `PAYTM_DIGITAL_CREDIT`, `EMI`, `BANK_TRANSFER` | none: `paymentMethod` is left out |

### Refunds

`payments.refund` calls the Refund API with the payment's order id as `orderId` and your `refundId` as `refId`. The transaction is read first: only a successful one can be refunded (anything else is `VALIDATION`), and an `amount` above the amount paid is refused. Omit `amount` to refund all of it. The refund is asynchronous: Paytm's answer only says the request was registered, so the `Refund` is `pending` unless Paytm says it is final, and `chargeId` and `paymentId` of the refund are both the payment id. Paytm rejects a repeated `refId`, so repeating a refund whose answer was lost cannot refund twice. Paytm's own limits come back as errors: no partial refund under Re 1, none on an order older than a year, and a refund while another is in progress.

### Webhooks

Configure the Payment Status webhook URL in the Paytm dashboard. Paytm posts key-value fields signed with `CHECKSUMHASH`, which the adapter verifies before reading anything. For an order id that starts with `pay_`:

| Paytm notification | Unified event |
|---|---|
| Payment Status, `TXN_SUCCESS` | `payment.succeeded` |
| Payment Status, `TXN_FAILURE` | `payment.failed` |
| Payment Status, any other status | `unknown`, still carrying the `payment` |
| Success Refund | `refund.succeeded` |
| Accept Refund | `unknown` (the refund is registered, the customer has not been credited) |
| Refund notification with status `FAILED` | `refund.failed` |
| Refund ARN | `unknown` |

Payment events carry `paymentId` and `payment`, built from the signed fields. Refund events carry `paymentId` and a `refund` whose `chargeId` and `paymentId` are the payment id. Event ids are built from the content, so a redelivery has the same id. The Payment ARN notification (cards only, no `STATUS`) is not read.

```ts title="paytm-one-time-webhook.ts"
import { EventType, Provider, type Subscriptions } from 'india-subscriptions';

export async function onPaytmWebhook(subs: Subscriptions, rawBody: string) {
  const events = await subs.webhooks.parse(Provider.Paytm, { rawBody, headers: {} });
  for (const event of events) {
    if (event.type === EventType.PaymentSucceeded) console.log('paid', event.paymentId, event.payment?.amount);
    if (event.type === EventType.PaymentFailed) console.log('declined', event.paymentId, event.payment?.failureReason);
  }
}
```

The same Payment Status fields under any other order id keep their subscription meaning (`subscription.charged` and `subscription.charge_failed`, see [Webhooks](#webhooks) above). A webhook is Paytm's word that a payment finished; confirm a large or unexpected one with `payments.get` before acting on it.

### Limits

- No order expiry and no metadata (refused, above). The transaction token is valid for 15 minutes.
- No payment-method choice beyond UPI, cards, net banking and the Paytm wallet. Paytm Payments Bank, postpaid, EMI and bank-transfer payments are not selectable from this library, though a customer may be offered them when you do not pass `paymentMethods`.
- Paytm lists a Refund Status API; the library has no refund lookup, so a refund's end comes from the Success Refund webhook.
- Paytm's pages disagree about the host of Transaction Status: its reference page prints `securegw(-stage).paytmpayments.in` and the JS Checkout page `secure(stage).paytmpayments.com`. The adapter follows the reference page; `transactionStatusBaseUrl` replaces it.

## Testing on staging

Paytm staging data appears in the Dashboard under Test Data. Test cards are any Visa or Mastercard with a future expiry and CVV 123; card and net-banking payments redirect to a Paytm page with success and failure buttons. Paytm Wallet test credentials are published (mobile `77777 77777`, OTP `489871`). No test UPI id and no eNACH test credentials are published. The smallest billing cycle Paytm says you can test is one day with zero grace days and a retry count of 1. Subscriptions must be enabled on your staging merchant id, which Paytm's documentation does not say is the default.

## Not built

Paytm Wallet subscriptions, the Consult and List APIs, paper (physical) mandates, and JS Checkout. The form-post payment page is used instead.
