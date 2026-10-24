# Entitlements

After this page you will know what an entitlement is, which statuses give access, what keeps an entitlement current, and why you read it instead of the store or the gateway.

An **entitlement** is the library's record that a customer owns a purchase. A subscription bought in the App Store, a subscription bought through a gateway on the web and a one-time purchase on Google Play are all entitlements, and `purchases.entitlements(customerRef)` returns every one of them for a customer in one answer: `active` says whether any gives access now, and each item says which product, which provider, which channel (`store` or `gateway`), which platform and what status.

You get entitlements from [purchase sessions](../guides/purchases.md): `complete` writes one when a purchase is confirmed, and webhook events keep it current afterwards.

## Statuses

<!-- generated:begin entitlement-statuses -->

| Status | Gives access | Blocks a second purchase | Meaning |
|---|---|---|---|
| `active` | yes | yes | Paid and current. A paid one-time purchase stays `active`. |
| `trialing` | yes | yes | In a free trial. |
| `past_due` | yes | yes | A charge failed and is being retried; the subscription is alive. |
| `paused` | no | yes | Charging is paused. |
| `halted` | no | no | Retries are exhausted; no further automatic charges. |
| `cancelled` | no | no | Ended. Terminal. |
| `expired` | no | no | The term ended (expired, or every cycle was collected). Terminal. |
| `refunded` | no | no | A one-time purchase that was refunded in full. Terminal. |

<!-- generated:end -->

- A subscription cancelled at the end of its period stays `active`, with `cancelAtPeriodEnd` set, until the period ends. Then it is `cancelled` or `expired`.
- `past_due` still gives access: the charge failed and is being retried, or the store's billing grace period runs. Decide for yourself how long to put up with it. The [subscription lifecycle](./lifecycle.md) says what each status means for a subscription.
- A one-time purchase is `active` once paid, stays so, and ends only as `refunded` when it is refunded in full.

## What keeps it current

Events. When a provider's webhook goes through `subs.webhooks.handle`, the client applies the events to the entitlement: activation, renewal, past due, pause, cancellation, expiry and the refund of a one-time purchase. Events about orders the library did not create are ignored, handling an event twice does the same as handling it once, and an older event never overwrites a newer one.

A device or a browser can say that it paid; only the provider's own answer, read by the library when you call `complete` and later as webhooks, changes an entitlement. So read what the customer owns from `entitlements`, not from the app's own state.

## One product, once

`start` refuses with `CONFLICT` when the customer already has an entitlement for the product that is `active`, `trialing`, `past_due` or `paused`, wherever it was bought. Consumables are the exception. If two sessions are paid anyway, both entitlements are kept and an alert is raised: see [One product, once](../guides/purchases.md#one-product-once).

## Over HTTP

`GET /v1/entitlements/{customerRef}`, behind the API key. A mobile app asks your backend, which asks this route: [Mobile apps](../guides/mobile-apps.md).
