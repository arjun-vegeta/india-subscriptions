# india-subscriptions (Python client)

A typed Python client for the [`india-subscriptions`](../../README.md) HTTP service: one gateway-neutral API over
subscriptions and one-time payments on Indian payment gateways, with routing, purchase sessions across app stores and
gateways, and entitlements. The core library is TypeScript; other languages run its small
self-hosted HTTP service and call it. This package is that call, with everything Pydantic-typed and no magic strings.

* Python 3.9+, runtime dependencies `pydantic>=2.6` and `httpx>=0.27` only.
* Sync (`SubscriptionsClient`) and async (`AsyncSubscriptionsClient`) clients with the same methods.
* Every request and response is a Pydantic model **generated from the service's OpenAPI document**
  (`src/india_subscriptions/models.py`). Enums are `str` enums: `Provider.RAZORPAY`, `SubscriptionStatus.TRIALING`.
* One error type for what the service says (`SubscriptionsApiError`), one for the network (`SubscriptionsTransportError`).
* A webhook helper for FastAPI, Flask and friends that forwards the raw body byte for byte.

```bash
pip install india-subscriptions
```

## Quick start

```python
from datetime import datetime, timezone

from india_subscriptions import (
    ErrorCode,
    Provider,
    SubscriptionStatus,
    SubscriptionsApiError,
    SubscriptionsClient,
)
from india_subscriptions.models import IntervalUnit

with SubscriptionsClient("https://billing.internal", api_key="...") as client:
    plan = client.plans.create(
        Provider.RAZORPAY,
        {"name": "Gold", "amount": 49900, "interval": {"unit": IntervalUnit.MONTH, "count": 1}},  # paise
    )

    subscription = client.subscriptions.create(
        Provider.RAZORPAY,
        {
            "plan": plan.id,
            "customer": {"name": "Asha", "email": "asha@example.com", "phone": "9876543210"},
            "trial": {"days": 14},
        },
    )
    assert subscription.status is SubscriptionStatus.TRIALING
    print(subscription.checkout)  # what the customer must do to authorise the mandate

    try:
        client.subscriptions.get(Provider.RAZORPAY, "sub_does_not_exist")
    except SubscriptionsApiError as error:
        assert error.code is ErrorCode.NOT_FOUND
```

Amounts are integer paise (₹499 is `49900`). Instants are timezone-aware `datetime`s, serialised as ISO-8601.

### Methods

| Call | Operation |
| --- | --- |
| `client.health()` | `getHealth` (no key needed) |
| `client.openapi()` | `getOpenApi` (no key needed) |
| `client.providers()` | `listProviders` |
| `client.capabilities(provider)` | `getCapabilities` |
| `client.plans.create(provider, plan)` / `.get(provider, plan_id)` | `createPlan` / `getPlan` |
| `client.subscriptions.create(provider, subscription)` | `createSubscription` |
| `client.subscriptions.get / update / cancel / pause / resume(provider, subscription_id, ...)` | `getSubscription`, `updateSubscription`, `cancelSubscription`, `pauseSubscription`, `resumeSubscription` |
| `client.charges.list / get(provider, subscription_id, ...)` | `listCharges`, `getCharge` |
| `client.charges.create / notify / refund(provider, ...)` | `createCharge`, `notifyCharge`, `createRefund` |
| `client.checkout.verify(provider, result, expected_subscription_id)` | `verifyCheckout` |
| `client.webhooks.parse(provider, request)` | `parseWebhook` |
| `client.webhooks.receive(provider, raw_body, headers)` | `receiveWebhook` (the gateway-facing route; no key) |
| `client.scheduler.tick(options=None)` | `runSchedulerTick` |
| `client.payments.create(provider, payment)` / `.get(provider, payment_id)` | `createPayment` / `getPayment` |
| `client.payments.verify(provider, result, expected_payment_id)` | `verifyPayment`. **Always pass `expected_payment_id`.** |
| `client.payments.refund(provider, refund)` | `createPaymentRefund` |
| `client.routing.decide(request)` | `decideRoute` |
| `client.routing.record_outcome(outcome)` | `recordRouteOutcome` |
| `client.purchases.start(purchase)` / `.get(session_id)` | `startPurchase` / `getPurchase` |
| `client.purchases.choose_alternative(session_id, external_transaction_token)` | `chooseAlternative` |
| `client.purchases.complete(session_id, provider, result)` | `completePurchase` |
| `client.purchases.flush(options=None)` | `flushPurchaseReports` |
| `client.entitlements.get(customer_ref)` | `getEntitlements` |

`AsyncSubscriptionsClient` has the same names; `await` each call, and use `async with` / `await client.aclose()`.

Every operation of the service's API has a method. The hosted checkout pages (`/checkout/...`) are for a customer's
browser, not for API calls, so the client has nothing for them.

### Inputs

Every input parameter takes the generated model **or a plain `dict`**, which is validated into the model first.
A dict may use the JSON names (`maxAmount`) or the Python names (`max_amount`). Request models reject unknown keys,
so a typo (`"trail": {...}`) raises `pydantic.ValidationError` before anything is sent. Only the fields you set are
sent; defaults such as `currency` are the service's to apply. The `provider` argument is the `Provider` enum.

```python
from india_subscriptions import CreateSubscriptionInput, Customer

subscription = client.subscriptions.create(
    Provider.CASHFREE, CreateSubscriptionInput(plan="plan_1", customer=Customer(name="Asha"))
)
```

Rules the service enforces but an OpenAPI document cannot express (for example "a trial needs exactly one of
`days` or `endsAt`") come back from the service as `SubscriptionsApiError` with `ErrorCode.VALIDATION`.

### Responses

Responses ignore fields they do not know, so a newer service does not break an older client. A checkout instruction
is a discriminated union on `kind`:

```python
from india_subscriptions.models import RazorpayCheckout

if isinstance(subscription.checkout, RazorpayCheckout):
    open_razorpay_checkout(subscription.checkout.key_id, subscription.checkout.subscription_id)
```

## One-time payments

`client.payments` creates, reads, verifies and refunds a one-time payment at a gateway. `create` returns the
`Payment` with `checkout` instructions for the customer (a union on `kind`, like a subscription's). The browser or device
supplies the result after paying, so verify it on your server and **always pass `expected_payment_id`**, the id (or
your `reference`) you stored when you created the payment: a genuine result for another payment is then refused with
`ErrorCode.SIGNATURE_INVALID`.

```python
from india_subscriptions import PaymentMethod, PaymentStatus, Provider

payment = client.payments.create(
    Provider.RAZORPAY,
    {
        "reference": "order_1001",
        "amount": 29900,  # paise
        "customer": {"name": "Asha", "email": "asha@example.com", "phone": "9876543210"},
        "payment_methods": [PaymentMethod.UPI],
    },
)
# ... the customer pays with payment.checkout; your server receives the gateway's result ...
verification = client.payments.verify(Provider.RAZORPAY, gateway_result, expected_payment_id=payment.id)
if verification.paid:
    assert client.payments.get(Provider.RAZORPAY, payment.id).status is PaymentStatus.SUCCEEDED
    client.payments.refund(Provider.RAZORPAY, {"payment_id": payment.id, "refund_id": "rf_1001", "amount": 10000})
```

`payments.create` and `payments.refund` are writes: they are never retried, and `ErrorCode.OUTCOME_UNKNOWN` means the
payment or refund may exist. Read it back (`payments.get`) before repeating the call; a `reference` makes that easy.
At an app store, `payments.create` makes no purchase: it returns the account token the purchase on the device must carry.

## Routing

`client.routing.decide(request)` chooses the best configured gateway for a subscription or a one-time payment and
explains the choice: every gateway comes back as a candidate with its exclusions or its score, and `ranked` is the
order to try them in. Nothing is created at a gateway. When no gateway can take the request the service answers
`ErrorCode.NO_ROUTE`.

```python
from india_subscriptions import ErrorCode, PaymentMethod, ProductKind, SubscriptionsApiError

try:
    decision = client.routing.decide(
        {"kind": ProductKind.ONE_TIME, "amount": 29900, "payment_methods": [PaymentMethod.NETBANKING]}
    )
    print(decision.provider, decision.ranked)
except SubscriptionsApiError as error:
    if error.code is ErrorCode.NO_ROUTE:
        ...  # no configured gateway can take this payment
```

`client.routing.record_outcome({...})` tells the router how a gateway did (`RouteOutcomeResult.SUCCESS`, `FAILURE` or
`UNAVAILABLE`), so its success rates and circuit breaker follow what you see. Purchase sessions record their own
outcomes; use this for payments you create through `client.payments`.

## Purchases and entitlements

A purchase session decides, for the customer's platform, where a purchase may go: the App Store on iOS; Google Play,
Google Play with user choice billing, or the gateways on Android; the gateways on the web. The service needs purchases
configured (a catalog of products), otherwise these calls answer `ErrorCode.CONFIG`.

```python
from india_subscriptions import Platform, Provider

session = client.purchases.start(
    {
        "platform": Platform.WEB,
        "product": "pro_monthly",  # the key in your catalog
        "customer": {"name": "Asha", "email": "asha@example.com"},
        "customer_ref": "cust_42",
        "reference": "buy_1001",  # starting again with the same reference and customer returns the same session
    }
)
option = session.options[0]  # option.checkout says what the customer must do; option.provider holds the purchase
# ... the customer pays; your server receives what the checkout handed back ...
session = client.purchases.complete(session.id, option.provider, checkout_result)

owned = client.entitlements.get("cust_42")
print(owned.active, [item.product for item in owned.items])
```

* `purchases.complete` verifies the result against the order the session created and records the entitlement. A result
  for another order raises `ErrorCode.SIGNATURE_INVALID` and the session stays as it was.
* `purchases.start` answers `ErrorCode.CONFLICT` when the customer already owns the product.
* `purchases.choose_alternative(session_id, token)` is for Android sessions with the `user_choice` policy: the customer
  picked the alternative payment on Google's screen, and `token` is the external transaction token Google gave the app.
  The session gains a gateway option with a `hosted_url` to open in a browser tab.
* `purchases.flush()` sends the Google reports that are queued (the service also does it on every scheduler tick).
  `result.overdue` lists the reports past their 24 hour deadline: page someone when it is not empty.
* `entitlements.get(customer_ref)` lists everything the customer owns across stores and gateways; `active` is true when
  one item gives access now.

`start`, `choose_alternative`, `complete` and `flush` are writes and are never retried. `get` calls are retried like
every GET.

## Errors

```python
from india_subscriptions import SubscriptionsApiError, SubscriptionsTransportError, ErrorCode

try:
    client.charges.create(Provider.CASHFREE, {"subscriptionId": sid, "chargeId": "cycle_3", "amount": 49900})
except SubscriptionsApiError as error:
    error.code            # ErrorCode, branch on this, never on message
    error.message
    error.provider        # Provider | None
    error.http_status     # the gateway's own HTTP status, when it answered
    error.provider_code   # the gateway's own error code, verbatim
    error.retryable       # True when repeating the same call later is safe
    error.status_code     # the HTTP status of the service's response
except SubscriptionsTransportError as error:
    error.timed_out, error.request_sent, error.outcome_unknown
```

* `ErrorCode` is the generated enum of every code the service can return: the library's codes
  (`VALIDATION`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `PROVIDER_ERROR`, `OUTCOME_UNKNOWN`, ...) plus the service's own
  (`UNAUTHORIZED`, `METHOD_NOT_ALLOWED`, `PAYLOAD_TOO_LARGE`, `INTERNAL_ERROR`). `NO_ROUTE` means no configured gateway
  can take a purchase or payment.
* **`ErrorCode.OUTCOME_UNKNOWN` means a money-moving request was sent and no answer came back. The debit, refund or
  change may or may not have happened. Do not repeat the call: fetch the current state first**
  (`subscriptions.get`, `charges.list`, `payments.get`, `purchases.get`) **and act on what you find.**
* A response that is not the documented shape (an HTML page from a proxy, an empty body, a success body that does not
  match its schema) raises `SubscriptionsApiError` with `ErrorCode.UNEXPECTED_RESPONSE` and `documented_shape=False`,
  with the start of the body in `response_body`. It is never a bare `KeyError` or `ValidationError`.
* Bad arguments (`pydantic.ValidationError`, `ValueError` for an empty id or unknown provider) are raised before any
  request is made.

### Retries

Only a failed **GET** is retried (`max_retries=2` by default, exponential `retry_backoff`), on a network failure or an
error the service marks `retryable`. A request that is not a GET is **never** retried, because a write that got no
answer may already have happened. Pass `max_retries=0` to turn retries off.

## Webhooks in a Python web framework

A gateway posts webhooks to your app. Hand the **raw** body and the headers to `parse_webhook`; the service verifies
the gateway's signature over the exact bytes and returns normalised `SubscriptionEvent`s. Read the raw bytes
before anything parses the JSON: a re-serialised body no longer matches the signature.

### FastAPI

```python
import os

from fastapi import FastAPI, HTTPException, Request

from india_subscriptions import (
    AsyncSubscriptionsClient,
    ErrorCode,
    EventType,
    Provider,
    SubscriptionsApiError,
    parse_webhook_async,
)

app = FastAPI()
client = AsyncSubscriptionsClient(os.environ["BILLING_URL"], os.environ["BILLING_API_KEY"])


@app.post("/webhooks/razorpay")
async def razorpay_webhook(request: Request) -> dict:
    raw = await request.body()  # the exact bytes, before any JSON parsing
    try:
        events = await parse_webhook_async(client, Provider.RAZORPAY, raw, request.headers)
    except SubscriptionsApiError as error:
        if error.code is ErrorCode.SIGNATURE_INVALID:
            raise HTTPException(status_code=401, detail="bad signature") from error
        raise HTTPException(status_code=502) from error  # the gateway retries a 5xx

    for event in events:  # de-duplicate on event.id: gateways deliver more than once
        if event.type is EventType.SUBSCRIPTION_CHARGED:
            ...
    return {"received": len(events)}
```

### Flask

```python
import os

from flask import Flask, abort, request

from india_subscriptions import ErrorCode, EventType, Provider, SubscriptionsApiError, SubscriptionsClient, parse_webhook

app = Flask(__name__)
client = SubscriptionsClient(os.environ["BILLING_URL"], os.environ["BILLING_API_KEY"])


@app.post("/webhooks/razorpay")
def razorpay_webhook():
    raw = request.get_data()  # the exact bytes
    try:
        events = parse_webhook(client, Provider.RAZORPAY, raw, request.headers)
    except SubscriptionsApiError as error:
        abort(401 if error.code is ErrorCode.SIGNATURE_INVALID else 502)

    for event in events:
        if event.type is EventType.SUBSCRIPTION_CHARGED:
            ...
    return {"received": len(events)}
```

`raw_body` may be `bytes` or the `str` they decode to (it must be UTF-8: the service takes the body as a JSON
string). `headers` is any mapping or headers object with `items()`: Starlette and Werkzeug headers work as they are.
Names are lower-cased and a repeated header is forwarded as a list.

Alternatively, register the service's own URL (`POST /v1/{provider}/webhooks`) at the gateway and let the service
receive webhooks itself; `client.webhooks.receive(...)` posts to that route the way a gateway would.

## Testing your code

Inject an `httpx` transport:

```python
import httpx
from india_subscriptions import SubscriptionsClient

def handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json={...})

client = SubscriptionsClient("http://billing.test", "key", transport=httpx.MockTransport(handler))
```

or pass your own `http_client=httpx.Client(...)` (you keep ownership and close it).

## The generated models

`src/india_subscriptions/models.py` is generated and committed, never edited by hand:

```bash
cd clients/python
python -m venv .venv && .venv/bin/pip install -e ".[dev]"
scripts/generate_models.sh        # openapi/openapi.json -> src/india_subscriptions/models.py
```

The generator is `datamodel-code-generator==0.97.0` (pinned); `scripts/generate_models.sh` lists every option and why it
is there. `tests/test_models_generated.py` regenerates into a temporary file and fails on any difference. After the
service's schemas change: `npm run openapi` at the repo root, then regenerate, then run the tests.

For static typing with mypy, enable the Pydantic plugin (`plugins = ["pydantic.mypy"]`) so model constructors accept
the Python field names.

## No magic strings

Routes, header names, operation ids and the API prefix are named constants in `india_subscriptions.constants`;
enum values exist only as the generated enums. `tests/test_no_magic_strings.py` fails on a bare route, header,
operation id or enum value in the client's code, and `tests/test_contract.py` checks the constants against
`openapi/openapi.json`, so the client cannot silently fall behind the service.

## Development

```bash
cd clients/python
.venv/bin/pytest                # unit, contract, drift and end-to-end tests
.venv/bin/pytest tests/e2e      # only the end-to-end tests (needs node and `npm install` at the repo root)
.venv/bin/mypy                  # strict type check of src and tests
```

The end-to-end tests start `tests/e2e/fixture_server.ts` (the real HTTP service around in-memory fake gateways)
with `npx tsx` and drive it with this client. They are skipped when `node`/`npx` are not available.
