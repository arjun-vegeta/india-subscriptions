# The Python client

A typed client for the HTTP service, in `clients/python` of the repository. Python 3.9 or later; dependencies `pydantic` 2.6 or later and `httpx` 0.27 or later. The client's own README has the full detail; this page is the map.

```python
from india_subscriptions import Provider, SubscriptionsClient

with SubscriptionsClient("http://127.0.0.1:8787", api_key="...") as client:
    subscription = client.subscriptions.get(Provider.RAZORPAY, "sub_00000000000001")
    print(subscription.status)
```

## Clients

`SubscriptionsClient` (sync) and `AsyncSubscriptionsClient` (async) have the same methods; `await` each call on the async one and use `async with` or `await client.aclose()`.

| Argument | Meaning |
|---|---|
| `base_url` | Where the service is mounted, such as `https://billing.internal`. |
| `api_key` | Sent as `Authorization: Bearer`. Never in an error message or `repr`. |
| `timeout` | Seconds or an `httpx.Timeout`. Default 30. |
| `max_retries` | Retries of a failed **GET** only. Default 2. Writes are never retried. |
| `retry_backoff` | Seconds before the first retry; doubles. |
| `transport`, `http_client` | Your own `httpx` transport (tests) or client. |

## Methods

| Call | Operation |
|---|---|
| `client.health()`, `client.openapi()` | `getHealth`, `getOpenApi` (no key) |
| `client.providers()`, `client.capabilities(provider)` | `listProviders`, `getCapabilities` |
| `client.plans.create(provider, plan)`, `.get(provider, plan_id)` | `createPlan`, `getPlan` |
| `client.subscriptions.create(provider, subscription)` | `createSubscription` |
| `client.subscriptions.get`, `.update`, `.cancel`, `.pause`, `.resume` | `getSubscription`, `updateSubscription`, `cancelSubscription`, `pauseSubscription`, `resumeSubscription` |
| `client.charges.list(provider, subscription_id, options)`, `.get(...)` | `listCharges`, `getCharge` |
| `client.charges.create`, `.notify`, `.refund` | `createCharge`, `notifyCharge`, `createRefund` |
| `client.checkout.verify(provider, result, expected_subscription_id)` | `verifyCheckout`. **Always pass `expected_subscription_id`.** |
| `client.webhooks.parse(provider, request)` | `parseWebhook` |
| `client.webhooks.receive(provider, raw_body, headers)` | `receiveWebhook` (the gateway-facing route; no key) |
| `client.scheduler.tick(options)` | `runSchedulerTick` |
| `client.payments.create(provider, payment)`, `.get(provider, payment_id)` | `createPayment`, `getPayment` |
| `client.payments.verify(provider, result, expected_payment_id)` | `verifyPayment`. **Always pass `expected_payment_id`.** |
| `client.payments.refund(provider, refund)` | `createPaymentRefund` |
| `client.routing.decide(request)`, `.record_outcome(outcome)` | `decideRoute`, `recordRouteOutcome` |
| `client.purchases.start(purchase)`, `.get(session_id)` | `startPurchase`, `getPurchase` |
| `client.purchases.choose_alternative(session_id, external_transaction_token)` | `chooseAlternative` |
| `client.purchases.complete(session_id, provider, result)` | `completePurchase` |
| `client.purchases.flush(options)` | `flushPurchaseReports` |
| `client.entitlements.get(customer_ref)` | `getEntitlements` |

Every operation of the API has a method. The hosted checkout pages under `/checkout/` are for a customer's browser, so the client has no method for them.

Inputs take the generated model or a plain `dict` (JSON names such as `maxAmount` or Python names such as `max_amount`). Unknown keys raise `pydantic.ValidationError` before anything is sent. Responses ignore unknown fields. Amounts are integer paise and instants are timezone-aware `datetime`s.

Enums are generated: `Provider.RAZORPAY`, `SubscriptionStatus.TRIALING`, `IntervalUnit.MONTH`, `EventType.SUBSCRIPTION_CHARGED`. A checkout instruction is a union on `kind`: `isinstance(subscription.checkout, RazorpayCheckout)`.

## Payments, routing and purchases

```python
from india_subscriptions import Platform, ProductKind, Provider

payment = client.payments.create(Provider.RAZORPAY, {"amount": 29900, "customer": {"name": "Asha"}})
verification = client.payments.verify(Provider.RAZORPAY, gateway_result, expected_payment_id=payment.id)

decision = client.routing.decide({"kind": ProductKind.ONE_TIME, "amount": 29900})

session = client.purchases.start(
    {"platform": Platform.WEB, "product": "pro_monthly", "customer": {"name": "Asha"}, "customer_ref": "cust_42"}
)
session = client.purchases.complete(session.id, session.options[0].provider, checkout_result)
owned = client.entitlements.get("cust_42")
```

`payments.verify` takes the result untouched and checks it against `expected_payment_id`; a genuine result for another payment raises `SIGNATURE_INVALID`. `routing.decide` raises `NO_ROUTE` when no configured gateway can take the request. `purchases.start` with the same `reference` and customer returns the same session, and raises `CONFLICT` when the customer already owns the product. The purchase calls need purchases configured on the service, otherwise they raise `CONFIG`. See the [HTTP service reference](http-service.md) for each route.

The creating and settling calls (`payments.create`, `payments.refund`, `routing.record_outcome`, `purchases.start`, `.choose_alternative`, `.complete`, `.flush`) are never retried. After `OUTCOME_UNKNOWN`, read the state back with `payments.get` or `purchases.get`.

## Errors

| Exception | When |
|---|---|
| `SubscriptionsApiError` | The service answered with an error, or with a body that is not the documented shape. Has `code` (`ErrorCode`), `message`, `provider`, `http_status` (the gateway's), `provider_code`, `retryable`, `status_code` (the service's) and `outcome_unknown`. |
| `SubscriptionsTransportError` | No usable answer: connection refused, timeout, broken stream. Has `timed_out`, `request_sent` and `outcome_unknown`. |
| `pydantic.ValidationError`, `ValueError` | Bad arguments, before any request. |

`ErrorCode.OUTCOME_UNKNOWN` means a money-moving request was sent and no answer came back. Do not repeat it; fetch the current state first. `ErrorCode.NO_ROUTE` means no configured gateway can take the purchase or payment.

## Webhooks in a Python web framework

`parse_webhook(client, provider, raw_body, headers)` and `parse_webhook_async(...)` forward the exact raw bytes and the headers to the service, which verifies the gateway's signature, applies the events to its billing scheduler and returns them normalised. Read the raw bytes (`request.get_data()` in Flask, `await request.body()` in FastAPI) before anything parses the JSON.

The client has no helper for the **events webhook** the service sends to you. Verify its signature with the standard library: see [Using it from any language](../getting-started/any-language.md#verifying-the-signature).

## Regenerating the models

`models.py` is generated from the OpenAPI document and committed. After the service's schemas change: `npm run openapi` at the repository root, then `scripts/generate_models.sh` in `clients/python`, then the tests.
