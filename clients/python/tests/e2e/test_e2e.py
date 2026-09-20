"""The cross-language contract, for real: this client against the real TypeScript service.

The service is ``createNodeServer`` around a ``Subscriptions`` facade with in-memory fake gateways
(``fixture_server.ts``). Nothing is mocked on the Python side or inside the service's HTTP layer, so a
disagreement between ``openapi.json``, the Zod schemas, the server and these generated models fails here.
Skipped when node/npx (or tsx) is missing.
"""

from __future__ import annotations

import hashlib
import hmac
import inspect
import json
import socket
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, Union

import pytest

from india_subscriptions import (
    AsyncSubscriptionsClient,
    ErrorCode,
    EventType,
    Provider,
    SubscriptionStatus,
    SubscriptionsApiError,
    SubscriptionsClient,
    SubscriptionsTransportError,
    parse_webhook,
    parse_webhook_async,
)
from india_subscriptions.constants import ContentType, HttpStatus
from india_subscriptions.models import (
    IntervalUnit,
    CancelMode,
    ChargeStatus,
    CashfreeCheckout,
    RazorpayCheckout,
    Environment,
    HealthStatus,
    RefundStatus,
    SchedulingMode,
)

from ..conftest import BOTH_KINDS, ClientKind
from .conftest import Service

pytestmark = pytest.mark.e2e

REPO_ROOT = Path(__file__).resolve().parents[4]
SIGNATURE_HEADER = "x-fake-signature"
UNKNOWN_OUTCOME_CHARGE_ID = "charge_outcome_unknown"  # fixture_server.ts: this debit "loses" its answer
TRIAL_DAYS = 14


async def settle(value: Union[Any, Awaitable[Any]]) -> Any:
    return await value if inspect.isawaitable(value) else value


def sign(secret: str, payload: str) -> str:
    return hmac.new(secret.encode(), payload.encode("utf-8"), hashlib.sha256).hexdigest()


class Api:
    """The same calls through the sync or the async client, so one scenario covers both."""

    def __init__(self, kind: ClientKind, service: Service, api_key: Union[str, None] = None) -> None:
        key = service.api_key if api_key is None else api_key
        self.kind = kind
        self.client: Union[SubscriptionsClient, AsyncSubscriptionsClient] = (
            SubscriptionsClient(service.base_url, key)
            if kind is ClientKind.SYNC
            else AsyncSubscriptionsClient(service.base_url, key)
        )

    async def __call__(self, value: Any) -> Any:
        return await settle(value)

    async def close(self) -> None:
        if isinstance(self.client, AsyncSubscriptionsClient):
            await self.client.aclose()
        else:
            self.client.close()

    async def parse_webhook(self, provider: Provider, body: Union[bytes, str], headers: Dict[str, str]) -> Any:
        if isinstance(self.client, AsyncSubscriptionsClient):
            return await parse_webhook_async(self.client, provider, body, headers)
        return parse_webhook(self.client, provider, body, headers)


@pytest.fixture(params=BOTH_KINDS, ids=lambda kind: kind.value)
async def api(request: pytest.FixtureRequest, service: Service) -> Any:
    handle = Api(request.param, service)
    yield handle
    await handle.close()


async def test_health_and_capabilities(api: Api) -> None:
    health = await api(api.client.health())
    assert health.status is HealthStatus.OK
    assert set(health.providers) == {Provider.RAZORPAY, Provider.CASHFREE}

    providers = await api(api.client.providers())
    assert {capabilities.provider for capabilities in providers} == {Provider.RAZORPAY, Provider.CASHFREE}
    capabilities = await api(api.client.capabilities(Provider.CASHFREE))
    assert capabilities.provider is Provider.CASHFREE
    assert capabilities.scheduling == [SchedulingMode.GATEWAY]
    assert capabilities.merchant_charge_lead_hours == 24
    assert capabilities.trial is True


async def test_the_openapi_document_served_is_the_one_the_client_was_built_from(api: Api) -> None:
    committed = json.loads((REPO_ROOT / "openapi" / "openapi.json").read_text(encoding="utf-8"))

    served = await api(api.client.openapi())

    assert served.openapi == committed["openapi"]
    assert served.model_extra is not None
    assert served.model_extra["paths"] == committed["paths"]
    assert served.model_extra["components"] == committed["components"]


async def test_the_subscription_lifecycle_with_a_trial(api: Api) -> None:
    provider = Provider.RAZORPAY
    client = api.client

    # A plan, then a subscription on it with a 14-day trial.
    plan = await api(
        client.plans.create(
            provider,
            {"name": "Gold", "amount": 49900, "interval": {"unit": IntervalUnit.MONTH, "count": 1}, "maxAmount": 60000},
        )
    )
    assert plan.provider is provider
    assert (plan.name, plan.amount, plan.max_amount) == ("Gold", 49900, 60000)
    assert plan.interval is not None and plan.interval.count == 1
    assert plan.scheduling is SchedulingMode.GATEWAY
    assert (await api(client.plans.get(provider, plan.id))).id == plan.id

    before = datetime.now(timezone.utc)
    created = await api(
        client.subscriptions.create(
            provider,
            {
                "plan": plan.id,
                "customer": {"name": "Asha", "email": "asha@example.com", "phone": "9876543210"},
                "trial": {"days": TRIAL_DAYS},
                "totalCycles": 12,
                "reference": "order-1001",
            },
        )
    )
    assert created.status is SubscriptionStatus.TRIALING
    assert created.reference == "order-1001"
    assert created.plan_id == plan.id
    assert created.total_cycles == 12
    assert created.customer is not None and created.customer.email == "asha@example.com"
    assert created.trial_ends_at is not None
    assert timedelta(days=TRIAL_DAYS) - timedelta(minutes=5) < created.trial_ends_at - before < timedelta(days=TRIAL_DAYS, minutes=5)
    assert isinstance(created.checkout, RazorpayCheckout)
    assert created.checkout.subscription_id == created.id
    assert created.checkout.prefill is not None and created.checkout.prefill.name == "Asha"
    assert created.raw == {"fake": True, "id": created.id}

    fetched = await api(client.subscriptions.get(provider, created.id))
    assert fetched.id == created.id and fetched.status is SubscriptionStatus.TRIALING

    paused = await api(client.subscriptions.pause(provider, created.id))
    assert paused.status is SubscriptionStatus.PAUSED
    resumed = await api(client.subscriptions.resume(provider, created.id))
    assert resumed.status is SubscriptionStatus.TRIALING

    updated = await api(client.subscriptions.update(provider, created.id, {"quantity": 3}))
    assert updated.quantity == 3

    scheduled = await api(
        client.subscriptions.cancel(provider, created.id, {"mode": CancelMode.AT_PERIOD_END})
    )
    assert scheduled.cancel_at_period_end is True and scheduled.status is SubscriptionStatus.TRIALING

    cancelled = await api(client.subscriptions.cancel(provider, created.id))
    assert cancelled.status is SubscriptionStatus.CANCELLED
    assert cancelled.ended_at is not None
    assert cancelled.cancel_at_period_end is False

    with pytest.raises(SubscriptionsApiError) as conflict:
        await api(client.subscriptions.pause(provider, created.id))
    assert conflict.value.code is ErrorCode.CONFLICT
    assert conflict.value.status_code == HttpStatus.CONFLICT
    assert conflict.value.http_status == HttpStatus.CONFLICT  # the gateway's own status, carried in the body
    assert conflict.value.provider_code == "BAD_REQUEST_ERROR"
    assert conflict.value.provider is provider
    assert conflict.value.retryable is False


async def test_a_cashfree_subscription_has_the_other_checkout_kind(api: Api) -> None:
    subscription = await api(
        api.client.subscriptions.create(
            Provider.CASHFREE,
            {
                "plan": {"name": "Silver", "amount": 19900, "interval": {"unit": IntervalUnit.WEEK, "count": 2}},
                "customer": {"phone": "+919876543210"},
            },
        )
    )
    assert subscription.status is SubscriptionStatus.CREATED
    assert isinstance(subscription.checkout, CashfreeCheckout)
    assert subscription.checkout.environment is Environment.TEST
    assert subscription.checkout.session_id.endswith(subscription.id)


async def test_charges_notifications_and_refunds(api: Api) -> None:
    provider = Provider.RAZORPAY
    client = api.client
    subscription = await api(
        client.subscriptions.create(
            provider,
            {"plan": {"name": "Charges", "amount": 10000, "interval": {"unit": IntervalUnit.MONTH, "count": 1}}, "customer": {"name": "B"}},
        )
    )
    assert await api(client.charges.list(provider, subscription.id)) == []

    debit_at = datetime(2030, 1, 1, 10, 0, tzinfo=timezone(timedelta(hours=5, minutes=30)))
    notification = await api(
        client.charges.notify(
            provider,
            {"subscriptionId": subscription.id, "notificationId": "note_1", "amount": 10000, "debitAt": debit_at},
        )
    )
    assert notification.accepted is True and notification.debit_at == debit_at

    charge = await api(client.charges.create(provider, {"subscriptionId": subscription.id, "chargeId": "cycle_1", "amount": 10000}))
    assert charge.status is ChargeStatus.SUCCEEDED and charge.reference == "cycle_1" and charge.amount == 10000
    again = await api(client.charges.create(provider, {"subscriptionId": subscription.id, "chargeId": "cycle_1", "amount": 10000}))
    assert again.id == charge.id  # the same debit id never debits twice
    await api(client.charges.create(provider, {"subscriptionId": subscription.id, "chargeId": "cycle_2", "amount": 10000}))

    listed = await api(client.charges.list(provider, subscription.id))
    assert [item.reference for item in listed] == ["cycle_2", "cycle_1"]  # newest first
    assert [item.id for item in await api(client.charges.list(provider, subscription.id, {"limit": 1}))] == [listed[0].id]
    assert (await api(client.charges.get(provider, subscription.id, charge.id))).id == charge.id

    refund = await api(
        client.charges.refund(
            provider,
            {"subscriptionId": subscription.id, "chargeId": charge.id, "refundId": "rf_1", "amount": 2500, "reason": "goodwill"},
        )
    )
    assert refund.status is RefundStatus.SUCCEEDED and refund.amount == 2500 and refund.charge_id == charge.id
    after = await api(client.charges.get(provider, subscription.id, charge.id))
    assert after.status is ChargeStatus.PARTIALLY_REFUNDED and after.refunded_amount == 2500

    with pytest.raises(SubscriptionsApiError) as too_much:
        await api(
            client.charges.refund(
                provider, {"subscriptionId": subscription.id, "chargeId": charge.id, "refundId": "rf_2", "amount": 9999}
            )
        )
    assert too_much.value.code is ErrorCode.VALIDATION
    assert too_much.value.status_code == HttpStatus.BAD_REQUEST


async def test_a_lost_answer_is_outcome_unknown_and_is_not_retried(api: Api) -> None:
    provider = Provider.RAZORPAY
    subscription = await api(
        api.client.subscriptions.create(
            provider,
            {"plan": {"name": "P", "amount": 100, "interval": {"unit": IntervalUnit.DAY, "count": 1}}, "customer": {"name": "C"}},
        )
    )

    with pytest.raises(SubscriptionsApiError) as caught:
        await api(
            api.client.charges.create(
                provider, {"subscriptionId": subscription.id, "chargeId": UNKNOWN_OUTCOME_CHARGE_ID, "amount": 100}
            )
        )

    assert caught.value.code is ErrorCode.OUTCOME_UNKNOWN
    assert caught.value.outcome_unknown is True
    assert caught.value.retryable is False
    assert caught.value.status_code == HttpStatus.GATEWAY_TIMEOUT
    assert caught.value.provider is provider


async def test_errors_from_the_service(api: Api) -> None:
    provider = Provider.RAZORPAY

    with pytest.raises(SubscriptionsApiError) as unknown:
        await api(api.client.subscriptions.get(provider, "sub_does_not_exist"))
    assert unknown.value.code is ErrorCode.NOT_FOUND
    assert unknown.value.status_code == HttpStatus.NOT_FOUND
    assert unknown.value.provider is provider
    assert unknown.value.documented_shape is True

    with pytest.raises(SubscriptionsApiError) as not_configured:
        await api(api.client.capabilities(Provider.PAYU))
    assert not_configured.value.code is ErrorCode.NOT_FOUND
    assert "not configured" in not_configured.value.message

    # Rules the Zod schemas enforce but the OpenAPI document cannot express come back as VALIDATION.
    with pytest.raises(SubscriptionsApiError) as both:
        await api(
            api.client.subscriptions.create(
                provider,
                {"plan": "plan_x", "customer": {"name": "A"}, "trial": {"days": 5, "endsAt": datetime(2031, 1, 1, tzinfo=timezone.utc)}},
            )
        )
    assert both.value.code is ErrorCode.VALIDATION
    assert both.value.status_code == HttpStatus.BAD_REQUEST
    assert "exactly one of days or endsAt" in both.value.message

    with pytest.raises(SubscriptionsApiError) as nothing:
        await api(api.client.subscriptions.update(provider, "sub_x", {}))
    assert nothing.value.code is ErrorCode.VALIDATION

    with pytest.raises(SubscriptionsApiError) as no_scheduler:
        await api(api.client.scheduler.tick({"limit": 5}))
    assert no_scheduler.value.code is ErrorCode.CONFIG
    assert no_scheduler.value.status_code == HttpStatus.INTERNAL_SERVER_ERROR


async def test_a_body_over_the_size_limit_is_payload_too_large(api: Api) -> None:
    huge = {"name": "Big", "amount": 1, "interval": {"unit": IntervalUnit.DAY, "count": 1}, "metadata": {"blob": "x" * (2 * 1024 * 1024)}}

    with pytest.raises((SubscriptionsApiError, SubscriptionsTransportError)) as caught:
        await api(api.client.plans.create(Provider.RAZORPAY, huge))

    # The service answers 413 and closes the connection; depending on timing the client may instead see the
    # connection drop while it was still uploading. Both are errors, and the outcome is not "success".
    if isinstance(caught.value, SubscriptionsApiError):
        assert caught.value.code is ErrorCode.PAYLOAD_TOO_LARGE
        assert caught.value.status_code == HttpStatus.PAYLOAD_TOO_LARGE


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
async def test_authentication(kind: ClientKind, service: Service) -> None:
    wrong = Api(kind, service, api_key="not-the-key")
    try:
        with pytest.raises(SubscriptionsApiError) as caught:
            await wrong(wrong.client.providers())
        assert caught.value.code is ErrorCode.UNAUTHORIZED
        assert caught.value.status_code == HttpStatus.UNAUTHORIZED
        assert caught.value.provider is None
        assert "not-the-key" not in str(caught.value)

        # Health needs no key at all.
        assert (await wrong(wrong.client.health())).status is HealthStatus.OK
    finally:
        await wrong.close()


async def test_checkout_verification(api: Api, service: Service) -> None:
    provider = Provider.RAZORPAY
    subscription = await api(
        api.client.subscriptions.create(
            provider,
            {"plan": {"name": "V", "amount": 100, "interval": {"unit": IntervalUnit.DAY, "count": 1}}, "customer": {"name": "C"}},
        )
    )
    good = {"subscription_id": subscription.id, "signature": sign(service.webhook_secret, subscription.id), "extra": None}

    verification = await api(api.client.checkout.verify(provider, good, subscription.id))

    assert verification.authorized is True
    assert verification.subscription_id == subscription.id
    assert verification.status is SubscriptionStatus.ACTIVE
    assert verification.raw == good  # forwarded untouched, nulls included

    with pytest.raises(SubscriptionsApiError) as tampered:
        await api(api.client.checkout.verify(provider, {**good, "signature": "0" * 64}, subscription.id))
    assert tampered.value.code is ErrorCode.SIGNATURE_INVALID
    assert tampered.value.status_code == HttpStatus.UNAUTHORIZED

    # A genuine result for another subscription is refused too, when the expected id is passed.
    other = await api(
        api.client.subscriptions.create(
            provider,
            {"plan": {"name": "W", "amount": 100, "interval": {"unit": IntervalUnit.DAY, "count": 1}}, "customer": {"name": "D"}},
        )
    )
    with pytest.raises(SubscriptionsApiError) as replayed:
        await api(api.client.checkout.verify(provider, good, other.id))
    assert replayed.value.code is ErrorCode.SIGNATURE_INVALID
    assert "different subscription" in replayed.value.message


WEBHOOK_BODY = '{ "id":"evt_42" , "event":"subscription.charged",\r\n "subscription_id":"sub_7", "note":"₹499 \U0001f4b8"}\n'


async def test_webhooks_are_verified_over_the_exact_bytes(api: Api, service: Service) -> None:
    raw = WEBHOOK_BODY.encode("utf-8")
    headers = {"X-Fake-Signature": sign(service.webhook_secret, WEBHOOK_BODY), "Content-Type": ContentType.JSON.value}

    events = await api.parse_webhook(Provider.RAZORPAY, raw, headers)

    assert len(events) == 1
    assert events[0].id == "evt_42"
    assert events[0].type is EventType.SUBSCRIPTION_CHARGED
    assert events[0].subscription_id == "sub_7"
    assert events[0].provider is Provider.RAZORPAY
    assert events[0].raw["note"] == "₹499 \U0001f4b8"

    # A body that was parsed and re-serialised no longer matches the signature.
    reserialised = json.dumps(json.loads(WEBHOOK_BODY))
    with pytest.raises(SubscriptionsApiError) as caught:
        await api.parse_webhook(Provider.RAZORPAY, reserialised, headers)
    assert caught.value.code is ErrorCode.SIGNATURE_INVALID

    unknown_event = WEBHOOK_BODY.replace("subscription.charged", "something.new")
    events = await api.parse_webhook(
        Provider.RAZORPAY, unknown_event, {SIGNATURE_HEADER: sign(service.webhook_secret, unknown_event)}
    )
    assert events[0].type is EventType.UNKNOWN


async def test_the_gateway_facing_webhook_route_needs_no_api_key(api: Api, service: Service) -> None:
    headers = {SIGNATURE_HEADER: sign(service.webhook_secret, WEBHOOK_BODY)}

    receipt = await api(api.client.webhooks.receive(Provider.CASHFREE, WEBHOOK_BODY.encode("utf-8"), headers))
    assert receipt.received == 1

    with pytest.raises(SubscriptionsApiError) as caught:
        await api(api.client.webhooks.receive(Provider.CASHFREE, WEBHOOK_BODY.encode("utf-8"), {SIGNATURE_HEADER: "bad"}))
    assert caught.value.code is ErrorCode.SIGNATURE_INVALID


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
async def test_a_dead_service_is_a_transport_error(kind: ClientKind, service: Service) -> None:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        closed_port = sock.getsockname()[1]
    dead = Service(f"http://127.0.0.1:{closed_port}", service.api_key, service.webhook_secret)
    unreachable = Api(kind, dead)
    try:
        with pytest.raises(SubscriptionsTransportError) as caught:
            await unreachable(unreachable.client.subscriptions.cancel(Provider.RAZORPAY, "sub_1"))
        assert caught.value.request_sent is False
        assert caught.value.outcome_unknown is False  # it never left this machine: safe to repeat
    finally:
        await unreachable.close()
