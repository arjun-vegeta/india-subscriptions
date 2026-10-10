# PayU

PayU keeps the customer's mandate but does not raise recurring debits for you. For each cycle you check the mandate, send a pre-debit notification (for cards and UPI) and then call PayU's recurring-debit command. The library's [billing scheduler](../guides/scheduler.md) does all of that, so with PayU you **must** configure a scheduler. Creating a subscription without one fails before anything is sent to PayU.

## Configuration

```ts
import { Environment, payu } from 'india-subscriptions';

export const gateway = payu({
  key: process.env.PAYU_KEY!,
  salt: process.env.PAYU_SALT!,
  environment: Environment.Test,
  successUrl: 'https://shop.example.com/payu/success',
  failureUrl: 'https://shop.example.com/payu/failure',
});
```

| Option | Required | Meaning |
|---|---|---|
| `key`, `salt` | yes | The merchant key and salt. The salt signs every request and verifies every response. It never leaves your server: it is not in `checkout.fields` and not in any error. |
| `environment` | yes | `Environment.Test` (`test.payu.in`) or `Environment.Live` (`secure.payu.in` for consent, `info.payu.in` for commands). |
| `successUrl`, `failureUrl` | no | Default return URLs (PayU's `surl` and `furl`). A subscription's `returnUrl` overrides both. Without a `returnUrl`, `successUrl` is required, otherwise creating a subscription throws `VALIDATION`. `failureUrl` falls back to `successUrl`. |
| `consentHashLayout` | no | `six_pipes` (default), `five_pipes` or `four_pipes`. PayU's documentation prints the separator count three ways. Change it only if PayU rejects the consent hash. PayU's test environment accepted six pipes. |
| `acceptUnsignedWebhooks` | no | Normalise PayU's unsigned eNACH-cancellation and refund webhooks. Only behind an allow-list of PayU's published source addresses. Default false. |
| `paymentUrl`, `apiUrl` | no | Replace the PayU URLs (a proxy or a mock server). |

The service reads the same settings from the `PAYU_*` [environment variables](../reference/generated/environment.md#payu).

## Capabilities

<!-- generated:begin capabilities payu -->
<!-- generated:end -->

PayU is **merchant-scheduled** only. `pause: no` and `resume: no` describe PayU's own API, which has no pause. With a scheduler configured, the facade pauses and resumes by telling the scheduler to stop and start raising debits, and [`subs.capabilities()`](../reference/generated/capabilities.md#what-the-facade-reports) reports that. `charges.list` is not available: read a debit with `charges.get` and the debit id the scheduler chose, or follow the scheduler's events.

## How a subscription works on PayU

`createSubscription` makes **no network call**. It returns a signed form that the customer's browser posts to PayU. PayU first hears of the subscription when the customer submits it.

```mermaid
sequenceDiagram
  participant App as Your server
  participant Browser as Customer's browser
  participant PayU
  participant Sched as Billing scheduler
  App->>App: create: build and hash the consent form
  App-->>Browser: checkout instruction (form_post)
  Browser->>PayU: consent transaction (card, UPI or eNACH)
  PayU-->>Browser: result posted to surl or furl
  Browser->>App: PayU's fields
  App->>App: verifyCheckout checks the response hash
  App->>Sched: activate the schedule
  loop every cycle
    Sched->>PayU: pre_debit_SI (cards, UPI), 48 hours ahead
    Sched->>PayU: si_transaction on the due date
    Sched->>PayU: verify_payment until the result is final
  end
```

### The subscription id changes once

Before the customer authorises, the subscription's `id` is your consent transaction id: your `reference`, or a generated `sub_...` id. After the customer authorises, `verifyCheckout` returns the id to use from then on, `<method>:<mihpayid>` such as `card:31543714057`, because PayU's status, revoke and modify commands differ per payment method. **Store the `subscriptionId` that `verifyCheckout` returns.** The helpers `encodePayUSubscriptionId` and `decodePayUSubscriptionId` are exported if you need to take one apart.

Your `reference` is PayU's `txnid`. It must be at most 25 characters of letters, digits, `_` and `-`, and unique.

### What you must supply

- The plan **inline**. PayU has no plan API, so a plan id string throws `VALIDATION`, and `plans.create` and `plans.get` throw `UNSUPPORTED`.
- `customer.name`, `customer.email` and `customer.phone`, all required. PayU removes some characters from names and product text, so the adapter removes them first so the hash matches what PayU keeps. Letters, digits and `- _ @ / . +` are kept in an e-mail address; an address with any other character is refused with `VALIDATION` rather than silently changed.
- `quantity` other than 1 is not supported: multiply the plan amount yourself.
- `paymentMethods` cannot be enforced. PayU's hosted checkout lets the customer pick the method.

### Trials, delayed starts and upfront amounts

PayU has no trial feature for merchant-triggered debits. The mandate is registered with a small **consent transaction**, and the scheduler simply does not debit until the trial ends.

| You pass | Consent transaction | Notes |
|---|---|---|
| Nothing or `trial` | ₹2.00 with `free_trial=1` | PayU documents no automatic refund. **You refund it** with `charges.refund`. PayU's pages disagree on whether UPI is ₹0 or ₹2; the adapter uses ₹2, which is valid on every method. |
| `upfrontAmount` | That amount, at least ₹1 | The first instalment, collected with the registration. For eNACH this works on a small set of banks only. |

The mandate's start date is the first debit date. For UPI, PayU's documentation says to send the current date and that any other value is ignored, so a trial on UPI is not at risk from the start date the adapter sends: the scheduler decides when the first debit happens. The end date comes from `mandateEndsAt`, else seven days after the last cycle when you give `totalCycles`, else five years after the first debit. The mandate ceiling (`billingAmount`) is the plan's `maxAmount`, or its `amount`. For cards, PayU states that a fixed plan's debit must equal that amount, so leave `maxAmount` unset on card plans.

### Pre-debit notification and the debit

For cards and UPI the scheduler sends the pre-debit notification 48 hours before the debit and then waits at least 24 hours before debiting. PayU's pages disagree on the lead time (24, 24 to 36, 24 to 48 and 48 hours) and say that a debit without a timely notice fails. **eNACH needs no notification**: the adapter reports an accepted notification without calling PayU. The debit is PayU's `si_transaction`. Its first answer is always "pending", with a final result within about ten minutes for UPI and by T+2 for eNACH; the scheduler polls `verify_payment` until the result is final.

PayU does not reject a repeated transaction id: on its test environment the same `txnid` sent three times produced three debits. So before raising a debit the adapter looks the `txnid` up and returns the existing debit if PayU already holds it. The scheduler only ever re-sends an id after an unknown outcome, and then only after a grace period.

### Failures and retries

PayU can retry failed recurring debits itself (Dashboard, Revenue Recovery), but that is off by default and the library does not depend on it. The scheduler applies its own policy: three attempts, a day apart, then `halted`. See [Running the scheduler](../guides/scheduler.md).

## Payment methods and limits

| | UPI Autopay | Cards | eNACH (net banking) |
|---|---|---|---|
| Debit without the customer | Up to ₹15,000 (₹1,00,000 for insurance and credit-card bill payments) | Up to ₹15,000 (₹1,00,000 for mutual funds, insurance, credit-card bills); above, additional factor authentication | Not required for later debits (limits up to ₹10,00,000 by net banking) |
| Mandate ceiling | The UPI `billingAmount` must not exceed ₹15,000. The adapter does not check this locally; PayU rejects it. | The card's limit | Per bank |
| Pre-debit notice | Yes | Yes | No |
| Registration | Real time | Real time; the customer completes 3-D Secure | Up to T+2 at the bank |
| Pause by the customer | Yes, in their UPI app | No | No |
| Cancel | `upi_mandate_revoke` | `mandate_revoke` (RuPay needs the customer) | `mandate_revoke`, finishes at the bank in T+1 or T+2 |
| Modify | Amount and end date, through `upi_mandate_modify`; the customer must approve | Needs a new consent with the customer | Not available |
| Refund of a debit | Yes | Yes | Not supported by banks |

A card mandate ends at the latest on the card's expiry. UPI collect flows are being retired by NPCI. Every card used for a mandate must be tokenised.

## Authorisation and checkout

`subscription.checkout` is `kind: CheckoutKind.FormPost` with the URL and the signed fields. Post them exactly as given: they are covered by the hash. [`openCheckout`](../guides/checkout.md) builds and submits the form for you.

`verifyCheckout` verifies the response hash PayU posts back (the reverse hash, **without** `si_details`, which PayU's test environment confirmed), then applies PayU's rule: `status` is `success` and `payment_source` is `sist` (and, for cards, a card token was returned). Card and UPI mandates are then `authorized: true`. eNACH is `pending_authorization` until the bank registers it, and `authorized` stays false; the scheduler checks the mandate periodically and starts billing when it is live. The `charge` in the result is the consent payment. PayU marks a failed consent `payu` like any failed payment, and posts a card token even when 3-D Secure failed, so only `status` tells you the outcome.

## Managing a subscription

| Operation | On PayU |
|---|---|
| `pause` and `resume` | Through the scheduler only: it stops and starts raising debits and the mandate stays valid. PayU's own API has none. |
| `cancel` | The scheduler stops billing first, then the mandate is revoked with the method's command. Immediately only: `CancelMode.AtPeriodEnd` throws `UNSUPPORTED`. |
| `update` | UPI mandates only: `amount` and `mandateEndsAt`, which the customer must approve in their UPI app. The facade also applies `amount`, `nextChargeAt` and `remainingCycles` to the schedule. Cards and eNACH mandates cannot be modified through the API. |
| `charges.refund` | `cancel_refund_transaction`. `chargeId` is PayU's payment id or your transaction id. eNACH refunds fail with PayU error 232. A refund of a debit that was captured today may have to wait until tomorrow. |
| `charges.get` | `verify_payment` by your transaction id. A debit PayU does not know answers `NOT_FOUND`. |

## Statuses

<!-- generated:begin payu-subscription-status -->

| Card mandate status (`check_mandate_status`) | Unified status |
|---|---|
| `active` | `active` |
| `cancelled` | `cancelled` |
| `discarded` | `cancelled` |
| `deleted` | `cancelled` |
| `failed` | `failed` |
| `expired` | `expired` |
| `paused` | `paused` |

| eNACH mandate status (`NB_mandate_status`) | Unified status |
|---|---|
| `INITIATED` | `pending_authorization` |
| `SUCCESS` | `active` |
| `FAILED` | `failed` |
| `CANCEL_INITIATED` | `cancelled` |
| `CANCEL_PENDING` | `cancelled` |
| `CANCEL_SUCCESS` | `cancelled` |
| `CANCEL_FAILED` | `active` |
| `CANCEL_INITIATION_FAILED` | `active` |

| UPI mandate status (`upi_mandate_status`) | Unified status |
|---|---|
| `active` | `active` |
| `revoked` | `cancelled` |
| `pause` | `paused` |
| `paused` | `paused` |
| `unpause` | `active` |

<!-- generated:end -->

A mandate status the adapter does not know becomes `pending_authorization`, never `active`. A cancellation that is initiated or pending counts as cancelled; one that failed leaves the mandate live.

<!-- generated:begin payu-charge-status -->

| PayU transaction state | Unified charge status |
|---|---|
| `captured` | `succeeded` |
| `success` | `succeeded` |
| `auth` | `pending` |
| `pending` | `pending` |
| `in progress` | `pending` |
| `initiated` | `pending` |
| `failed` | `failed` |
| `failure` | `failed` |
| `bounced` | `failed` |
| `dropped` | `failed` |
| `autorefund` | `failed` |
| `usercancelled` | `cancelled` |
| `cancelled` | `cancelled` |

<!-- generated:end -->

A debit state the adapter does not know is `pending`, so the scheduler keeps asking instead of debiting again. An `autoRefund` debit is `failed`, never `refunded`, because the scheduler counts a refunded debit as collected.

## Webhooks

PayU's webhooks come in four shapes, and only some are signed.

| Webhook | Format | Signed | Result |
|---|---|---|---|
| Payment (consent result, recurring debit) | Form-encoded | Yes, the response hash | `subscription.authorized` for a card or UPI consent; `subscription.charged` or `subscription.charge_failed` for a debit; otherwise `unknown` |
| Card mandate (issuer modified or cancelled it) | JSON | Yes | `subscription.updated` or `subscription.cancelled` |
| UPI mandate (customer paused, resumed or revoked in their app) | JSON | Yes | `subscription.paused`, `subscription.resumed`, `subscription.cancelled` |
| eNACH cancellation and refund | JSON | **No** | `unknown`, unless `acceptUnsignedWebhooks` is set |

Payment webhooks arrive **form-encoded**, not JSON, so pass the raw body string through as it is. A recurring debit is recognised by `payment_source` of `sirecurring` or a `PG_TYPE` of `SI-PG`. The webhook carries no subscription id, so the scheduler matches it to its debit by the transaction id. PayU's source addresses are listed in its documentation (test: `180.179.174.1`, `3.6.73.183`, `3.6.83.44`; production: `3.7.89.1`, `3.7.89.2`, `3.7.89.3`, `52.140.8.88`, `52.140.8.89`, `52.140.8.64`); check them against PayU's current page before using them as an allow-list.

Because webhooks cannot attribute everything, rely on the scheduler's own events for debits: see [Events](../concepts/events.md).

<!-- generated:begin payu-webhook-events -->

| Card mandate `notificationType` | Unified event |
|---|---|
| `MANDATE_MODIFICATION` | `subscription.updated` |
| `MANDATE_CANCELLATION` | `subscription.cancelled` |
| `MANDATE_DELETION` | `subscription.cancelled` |
| `MANDATE_CANCELLATION_TOKEN_DELETION` | `subscription.cancelled` |

| UPI mandate `action` | Unified event |
|---|---|
| `MANDATE_PAUSE` | `subscription.paused` |
| `MANDATE_UNPAUSE` | `subscription.resumed` |
| `MANDATE_REVOKE` | `subscription.cancelled` |

<!-- generated:end -->

## One-time payments

PayU takes one-time payments through the same hosted checkout it uses for mandates, without the mandate parameters. You call `subs.payments.create`, the customer's browser posts the signed form to PayU, PayU posts the result back to your return URL, and you verify it. The billing scheduler plays no part. Cards, UPI, net banking and wallets are what `capabilities.oneTimePaymentMethods` lists; EMI, BNPL and the other PayU modes are not offered through this call.

### What to call

```ts
import { Environment, PaymentMethod, Provider, createSubscriptions, payu } from 'india-subscriptions';

const subs = createSubscriptions({
  providers: [
    payu({
      key: process.env.PAYU_KEY!,
      salt: process.env.PAYU_SALT!,
      environment: Environment.Test,
    }),
  ],
});

export async function startPayment(orderId: string) {
  const payment = await subs.payments.create(Provider.PayU, {
    reference: orderId,
    amount: 49900, // paise: ₹499
    description: 'Order 1042',
    customer: { name: 'Ashish Kumar', email: 'ashish@example.com', phone: '9876543210' },
    paymentMethods: [PaymentMethod.Upi, PaymentMethod.Card],
    returnUrl: 'https://shop.example.com/payu/return',
    metadata: { orderId },
  });
  // Store payment.id with your order, then send payment.checkout to the browser.
  return payment;
}
```

`customer.name`, `customer.email` and `customer.phone` are all required, because PayU requires `firstname`, `email` and `phone`. The text rules of [the subscription form](#what-you-must-supply) apply: PayU removes some characters from names and product text, so the adapter removes them first and the hash matches what PayU keeps, and an e-mail address with a character PayU strips is refused.

| You pass | What PayU receives |
|---|---|
| `reference` | `txnid`: at most 25 characters of letters, digits, `_` and `-`. Without one the adapter generates `pay_` and 20 hex characters. |
| `amount` | `amount` as rupees with two decimals, such as `499.00`. |
| `description` | `productinfo`, at most 100 characters after PayU's disallowed characters are taken out. A longer one is refused, not cut. Without one the adapter sends `Payment`. |
| `returnUrl` | `surl` and `furl`. Without it the configured `successUrl` and `failureUrl` are used. PayU allows 50 characters for each, and a longer URL is refused. |
| `paymentMethods` | `enforce_paymethod`: `card` is `creditcard\|debitcard`, `upi` is `upi\|upicc`, `netbanking` is `netbanking`, `wallet` is `cashcard`, joined with a pipe. PayU's pages name this parameter both `enforce_paymethod` and `enforced_payment`; the adapter sends `enforce_paymethod`, the name on the page that describes it. A method outside the four (such as `enach`) is refused with `VALIDATION`. |
| `metadata` | `udf1`, as base64url of its JSON, so PayU keeps it unchanged and returns it. It must fit PayU's 255 characters, and a larger one is refused. `getPayment`, `verifyPayment` and the webhook give it back as `payment.metadata`. |
| `expiresAt` | Refused with `UNSUPPORTED`: PayU's hosted checkout has no parameter that ends a payment at a time. |
| `idempotencyKey` | Not used: PayU has no idempotency keys. The `txnid` is the guard, see below. |

The adapter also sets `udf5` to a fixed marker on every payment. It is part of PayU's response hash, so it is covered by the signature you verify, and it is how a payment webhook is told apart from a mandate result.

### The payment id is the transaction id

`payment.id` is PayU's `txnid`: your `reference`, or the generated `pay_...` id. It is the only id that exists before the customer pays, `verify_payment` and the refund command accept it, and the return URL and the webhooks carry it. The id `createPayment` returns is the id `getPayment` and `refundPayment` accept from then on. PayU's own payment id (`mihpayid`) is in `payment.raw` once you have read the payment.

PayU does not stop a transaction id from being tried again before a payment succeeds, and the same id sent after a success is answered with a duplicate-order error. So when you pass a `reference`, `createPayment` first asks PayU for the transaction under that id. If PayU holds one, you get that payment back as it stands (with no `checkout`) instead of a second form to post. If the lookup fails for any reason other than "not found", `createPayment` stops and throws. A payment whose id was generated is not looked up. To start a new attempt after a failed or abandoned one, use a new `reference`.

### The form-post step

`payment.checkout` is `kind: CheckoutKind.FormPost` with PayU's URL and the signed fields: `key`, `txnid`, `amount`, `productinfo`, `firstname`, `email`, `phone`, `surl`, `furl`, `udf5`, the hash, and `udf1` and `enforce_paymethod` when you asked for them. There is no `si`, `si_details` or `api_version`. Post the fields exactly as given: they are covered by the hash, and the salt is not among them. [`openCheckout`](../guides/checkout.md) builds and submits the form.

The hash is `sha512(key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||salt)`, with exactly five user-defined positions and six pipes after the last.

### Verification

PayU posts the result to `surl` on success and `furl` otherwise, as form fields. Pass them on untouched:

```ts
import { Provider, PaymentStatus, createSubscriptions, payu, Environment } from 'india-subscriptions';

const subs = createSubscriptions({
  providers: [payu({ key: process.env.PAYU_KEY!, salt: process.env.PAYU_SALT!, environment: Environment.Test })],
});

export async function confirm(fields: Record<string, string>, storedPaymentId: string) {
  // Throws SIGNATURE_INVALID when the hash does not match, or the result is for another payment.
  const verification = await subs.payments.verify(Provider.PayU, fields, { expectedPaymentId: storedPaymentId });
  if (!verification.paid) return verification.status ?? PaymentStatus.Pending;

  // The return URL is the customer's browser: read the payment from PayU before you fulfil the order.
  const payment = await subs.payments.get(Provider.PayU, verification.paymentId);
  return payment.status;
}
```

`verifyPayment` recomputes PayU's response hash from the posted fields and compares it in constant time. `SIGNATURE_INVALID` follows when it does not match, and nothing in the result is used. The hash covers `status`, the five user-defined fields, `email`, `firstname`, `productinfo`, `amount`, `txnid` and the key, and when PayU adds convenience fees, `additional_charges` in front. A result that belongs to a mandate (`payment_source` of `sist` or `sirecurring`) is refused: it goes to `verifyCheckout`.

Only a `status` of `success` is paid, which is PayU's rule: a state of `captured` next to any other `status` is `pending`. `paid` is true only for `succeeded`. Always pass `expectedPaymentId`, as with [subscriptions](../guides/checkout.md): a genuine result for a different payment then fails with `SIGNATURE_INVALID`. PayU also asks you to compare the amount with the one you sent; `verification.payment.amount` is what PayU echoes, in paise.

`getPayment` is the source of truth. It reads `verify_payment` by `txnid`, and for a succeeded payment it then asks `check_action_status` which refunds PayU holds, so `refundedAmount`, `partially_refunded` and `refunded` are filled in. A payment the customer never opened answers `NOT_FOUND`, because PayU registers the transaction when the customer reaches its page.

### Statuses

PayU gives a transaction state in `unmappedstatus` and a coarse `status`. The adapter reads `unmappedstatus` first, then `status`; the state you get from PayU is verbatim in `providerStatus`.

| PayU state | Unified payment status |
|---|---|
| `captured`, `success` | `succeeded` |
| `auth` (authorised at the bank, not captured at PayU) | `pending` |
| `pending`, `in progress` | `pending` |
| `initiated` (the customer is on PayU's page) | `created` |
| `failed`, `failure`, `bounced`, `dropped` | `failed` |
| `autoRefund` (PayU refunded it after reconciling) | `failed` |
| `userCancelled`, `cancelled` | `cancelled` |

A state the adapter does not know is `pending`, so you keep asking `getPayment` and never read it as paid or failed. The payment method comes from `mode`, with `PG_TYPE` as a fallback: `CC` and `DC` are `card`, `UPI` is `upi`, `NB` is `netbanking`, `CASH` is `wallet`. Any other mode (EMI, BNPL, NEFT/RTGS, QR) leaves `paymentMethod` out.

| Refund state in `check_action_status` | Counted in `refundedAmount` |
|---|---|
| `SUCCESS`, `QUEUED`, `IN PROGRESS`, `REQUESTED`, `od_hit` | yes |
| `FAILURE` | no |

A refund state not in the table is not counted.

### Refunds

```ts
import { Environment, Provider, createSubscriptions, payu } from 'india-subscriptions';

const subs = createSubscriptions({
  providers: [payu({ key: process.env.PAYU_KEY!, salt: process.env.PAYU_SALT!, environment: Environment.Test })],
});

export async function refundOrder(paymentId: string) {
  const refund = await subs.payments.refund(Provider.PayU, {
    paymentId,
    refundId: 'rf_1042', // at most 19 characters
    amount: 10000, // paise; leave out to refund what was debited
    reason: 'Customer returned the item',
  });
  return refund.status;
}
```

`refundPayment` looks the payment up by `txnid`, then calls `cancel_refund_transaction` with PayU's payment id. The refund's `chargeId` and `paymentId` are both the payment's id, and `reference` is your `refundId`. The refund token PayU receives is `pay_` plus your `refundId`, and PayU limits a token to 23 characters, so `refundId` is at most 19 characters. The prefix is how the refund callback is told from the refund of a recurring debit. A refund comes back `pending` (queued) unless PayU answers with its success code. A payment id PayU does not know is `NOT_FOUND`. PayU's error codes are the ones of [charge refunds](#managing-a-subscription).

### Webhooks

Webhook events about a one-time payment need no scheduler and no subscription id.

| PayU webhook | Result |
|---|---|
| Payment, with this adapter's marker in `udf5`, state succeeded | `payment.succeeded` with `paymentId` and `payment` |
| Payment, with the marker, failed or cancelled | `payment.failed` with `paymentId` and `payment` |
| Payment, with the marker, still pending | `unknown`, with `paymentId` and `payment` |
| Payment without the marker (a failed consent, or a payment you did not create through this library) | `unknown`, as before |
| Refund callback whose `token` starts with `pay_` | `refund.succeeded` or `refund.failed` with `paymentId`, and `refund.chargeId` and `refund.paymentId` set to the payment id |
| Refund callback without that prefix | A refund of a charge, as before |

How a payload tells a payment from a recurring debit: a debit has `payment_source` of `sirecurring` (and `mode` `SI`, `PG_TYPE` `SI-PG`); a mandate registration has `sist`. PayU marks a failed consent `payu`, like any failed payment, and its webhook has no mandate field, so nothing in PayU's payload separates a failed payment from a failed consent. The marker in `udf5` does, and because it is inside the response hash, a webhook that carries it has passed the signature check. Payment webhooks are form-encoded and signed with the response hash, so the raw body goes in as it is.

The refund callback is unsigned, and the existing rule stands: it is an `unknown` event unless `acceptUnsignedWebhooks` is set. A refund you start in PayU's dashboard has no `pay_` token, so it is reported as a refund of a charge, without `paymentId`. PayU enables the refund callback on request.

```ts
import { Environment, EventType, Provider, createSubscriptions, payu } from 'india-subscriptions';

const subs = createSubscriptions({
  providers: [payu({ key: process.env.PAYU_KEY!, salt: process.env.PAYU_SALT!, environment: Environment.Test })],
});

export async function onPayuWebhook(rawBody: string): Promise<string[]> {
  const events = await subs.webhooks.parse(Provider.PayU, { rawBody, headers: {} });
  const paid: string[] = [];
  for (const event of events) {
    if (event.type === EventType.PaymentSucceeded && event.paymentId !== undefined) paid.push(event.paymentId);
  }
  return paid;
}
```

### Limits

- `expiresAt` is refused: there is no PayU parameter for it.
- `refundId` is at most 19 characters.
- `surl` and `furl` are at most 50 characters each, `productinfo` 100, `metadata` as encoded 255.
- `reference` (the `txnid`) is at most 25 characters of letters, digits, `_` and `-`.
- `description` and `metadata` must fit those limits: they are refused, not cut.
- Split settlements are not supported: the response hash is read without PayU's `splitInfo` field.
- An existing `txnid` is returned, never posted twice: use a new `reference` for a new attempt.
- A convenience fee PayU adds is not in `amount`: the amount PayU echoes is the one you sent.

## Not built

PayU's ZION subscription product, which is gateway-scheduled and has its own APIs. Its create-subscription page is missing from the public documentation.
