"""What the client accepts and refuses before it sends anything."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

import httpx
import pytest
from pydantic import ValidationError

from india_subscriptions import (
    AsyncSubscriptionsClient,
    CreatePlanInput,
    CreateSubscriptionInput,
    Provider,
    SubscriptionsClient,
)
from india_subscriptions.constants import ApiPath, HeaderName
from india_subscriptions.models import BillingInterval, BillingIntervalUnit, Currency, SchedulingMode

from .cases import CHARGE_JSON, GATEWAY_RESULT, PLAN_JSON, SUBSCRIPTION_ID, SUBSCRIPTION_JSON, VERIFICATION_JSON
from .conftest import API_KEY, BASE_URL, BOTH_KINDS, ClientKind, Recorder, json_response, run

PLAN_DICT = {"name": "Gold", "amount": 49900, "interval": {"unit": BillingIntervalUnit.MONTH.value, "count": 1}}


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
async def test_a_dict_may_use_json_names_or_python_names(kind: ClientKind) -> None:
    recorder = Recorder(json_response(201, PLAN_JSON))

    await run(kind, recorder, lambda c: c.plans.create(Provider.RAZORPAY, {**PLAN_DICT, "max_amount": 60000, "maxCycles": 12}))

    assert recorder.last.content == b'{"name":"Gold","amount":49900,"interval":{"unit":"month","count":1},"maxAmount":60000,"maxCycles":12}'


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
@pytest.mark.parametrize(
    "bad",
    [
        pytest.param({**PLAN_DICT, "amout": 1}, id="typo-in-a-key"),
        pytest.param({**PLAN_DICT, "amount": -5}, id="negative-amount"),
        pytest.param({**PLAN_DICT, "amount": 499.5}, id="fractional-paise"),
        pytest.param({**PLAN_DICT, "currency": "USD"}, id="unknown-enum-value"),
        pytest.param({"name": "Gold"}, id="missing-required-fields"),
        pytest.param({**PLAN_DICT, "name": ""}, id="empty-name"),
    ],
)
async def test_a_bad_input_fails_before_any_request(kind: ClientKind, bad: Any) -> None:
    recorder = Recorder(json_response(201, PLAN_JSON))

    with pytest.raises(ValidationError):
        await run(kind, recorder, lambda c: c.plans.create(Provider.RAZORPAY, bad))

    assert recorder.requests == []


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
async def test_a_typo_in_a_nested_request_model_is_not_silently_dropped(kind: ClientKind) -> None:
    recorder = Recorder(json_response(201, SUBSCRIPTION_JSON))

    with pytest.raises(ValidationError):
        await run(
            kind,
            recorder,
            lambda c: c.subscriptions.create(
                Provider.RAZORPAY, {"plan": "plan_1", "customer": {"name": "A"}, "trail": {"days": 14}}
            ),
        )

    assert recorder.requests == []


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
async def test_only_what_the_caller_set_is_sent(kind: ClientKind) -> None:
    """Defaults (currency) are the service's to apply, and a `None` is never sent as `null`."""
    recorder = Recorder(json_response(201, PLAN_JSON))
    plan = CreatePlanInput(
        name="Gold",
        amount=49900,
        interval=BillingInterval(unit=BillingIntervalUnit.MONTH, count=1),
        description=None,
    )
    assert plan.currency is Currency.INR  # the model knows the default ...

    await run(kind, recorder, lambda c: c.plans.create(Provider.RAZORPAY, plan))

    assert b"currency" not in recorder.last.content  # ... but the request leaves it to the service
    assert b"null" not in recorder.last.content
    assert b"description" not in recorder.last.content


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
async def test_a_value_set_to_the_default_is_still_sent(kind: ClientKind) -> None:
    recorder = Recorder(json_response(201, PLAN_JSON))

    await run(kind, recorder, lambda c: c.plans.create(Provider.RAZORPAY, {**PLAN_DICT, "currency": Currency.INR, "scheduling": SchedulingMode.MERCHANT}))

    assert b'"currency":"INR"' in recorder.last.content
    assert b'"scheduling":"merchant"' in recorder.last.content


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
async def test_an_inline_plan_and_a_plan_id_are_both_accepted(kind: ClientKind) -> None:
    recorder = Recorder(json_response(201, SUBSCRIPTION_JSON))
    customer = {"name": "Asha"}

    await run(kind, recorder, lambda c: c.subscriptions.create(Provider.RAZORPAY, {"plan": "plan_1", "customer": customer}))
    await run(kind, recorder, lambda c: c.subscriptions.create(Provider.RAZORPAY, {"plan": PLAN_DICT, "customer": customer}))
    typed = CreateSubscriptionInput(plan="plan_1", customer={"name": "Asha"})  # type: ignore[arg-type]
    await run(kind, recorder, lambda c: c.subscriptions.create(Provider.RAZORPAY, typed))

    assert [request.content for request in recorder.requests] == [
        b'{"plan":"plan_1","customer":{"name":"Asha"}}',
        b'{"plan":{"name":"Gold","amount":49900,"interval":{"unit":"month","count":1}},"customer":{"name":"Asha"}}',
        b'{"plan":"plan_1","customer":{"name":"Asha"}}',
    ]


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
async def test_datetimes_are_sent_as_iso_8601_with_their_offset(kind: ClientKind) -> None:
    recorder = Recorder(json_response(200, SUBSCRIPTION_JSON))

    await run(
        kind,
        recorder,
        lambda c: c.subscriptions.resume(
            Provider.RAZORPAY, SUBSCRIPTION_ID, {"nextChargeAt": datetime(2026, 12, 1, 4, 30, tzinfo=timezone.utc)}
        ),
    )
    assert recorder.last.content == b'{"nextChargeAt":"2026-12-01T04:30:00Z"}'


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
async def test_a_naive_datetime_is_refused(kind: ClientKind) -> None:
    recorder = Recorder(json_response(200, SUBSCRIPTION_JSON))

    with pytest.raises(ValidationError):
        await run(
            kind,
            recorder,
            lambda c: c.subscriptions.resume(Provider.RAZORPAY, SUBSCRIPTION_ID, {"nextChargeAt": datetime(2026, 12, 1)}),
        )
    assert recorder.requests == []


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
@pytest.mark.parametrize("limit", [0, 101, -1])
async def test_the_charge_limit_is_checked_locally(kind: ClientKind, limit: int) -> None:
    recorder = Recorder(json_response(200, [CHARGE_JSON]))

    with pytest.raises(ValidationError):
        await run(kind, recorder, lambda c: c.charges.list(Provider.RAZORPAY, SUBSCRIPTION_ID, {"limit": limit}))
    assert recorder.requests == []


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
async def test_no_limit_means_no_query_string(kind: ClientKind) -> None:
    recorder = Recorder(json_response(200, [CHARGE_JSON]))

    await run(kind, recorder, lambda c: c.charges.list(Provider.RAZORPAY, SUBSCRIPTION_ID))

    assert recorder.last.url.query == b""


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
async def test_ids_are_percent_encoded_and_cannot_change_the_route(kind: ClientKind) -> None:
    recorder = Recorder(json_response(200, SUBSCRIPTION_JSON))

    await run(kind, recorder, lambda c: c.subscriptions.get(Provider.RAZORPAY, "a/b c?d#e"))

    assert recorder.last.url.raw_path == (ApiPath.SUBSCRIPTION.format(provider=Provider.RAZORPAY.value, subscriptionId="a%2Fb%20c%3Fd%23e")).encode()


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
async def test_an_empty_id_is_refused(kind: ClientKind) -> None:
    recorder = Recorder(json_response(200, SUBSCRIPTION_JSON))

    with pytest.raises(ValueError, match="must not be empty"):
        await run(kind, recorder, lambda c: c.subscriptions.get(Provider.RAZORPAY, ""))
    assert recorder.requests == []


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
async def test_an_unknown_provider_is_refused(kind: ClientKind) -> None:
    recorder = Recorder(json_response(200, SUBSCRIPTION_JSON))

    with pytest.raises(ValueError):
        await run(kind, recorder, lambda c: c.subscriptions.get("stripe", SUBSCRIPTION_ID))  # type: ignore[arg-type]
    assert recorder.requests == []


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
async def test_the_checkout_result_is_forwarded_untouched(kind: ClientKind) -> None:
    recorder = Recorder(json_response(200, VERIFICATION_JSON))
    result = {**GATEWAY_RESULT, "nested": {"a": [1, None, "x"], "empty": ""}, "unicode": "₹499"}

    await run(kind, recorder, lambda c: c.checkout.verify(Provider.RAZORPAY, result))

    assert json.loads(recorder.last.content) == result  # nulls, nesting and key names intact


# -- construction ----------------------------------------------------------------------------------------


def test_constructor_arguments_are_checked() -> None:
    transport = httpx.MockTransport(Recorder(json_response(200, {})))
    with pytest.raises(ValueError, match="api_key"):
        SubscriptionsClient(BASE_URL, "", transport=transport)
    with pytest.raises(ValueError, match="base_url"):
        SubscriptionsClient("  ", API_KEY, transport=transport)
    with pytest.raises(ValueError, match="http"):
        SubscriptionsClient("service.test", API_KEY, transport=transport)
    with pytest.raises(ValueError, match="max_retries"):
        SubscriptionsClient(BASE_URL, API_KEY, transport=transport, max_retries=-1)
    with pytest.raises(ValueError, match="not both"):
        SubscriptionsClient(BASE_URL, API_KEY, transport=transport, http_client=httpx.Client())


def test_an_injected_client_is_used_and_left_open() -> None:
    recorder = Recorder(json_response(200, SUBSCRIPTION_JSON))
    http = httpx.Client(transport=httpx.MockTransport(recorder))
    with SubscriptionsClient(BASE_URL, API_KEY, http_client=http) as client:
        client.subscriptions.get(Provider.RAZORPAY, SUBSCRIPTION_ID)
    assert recorder.last.headers[HeaderName.AUTHORIZATION.value] == f"Bearer {API_KEY}"
    assert not http.is_closed
    http.close()


def test_an_owned_client_is_closed_by_the_context_manager() -> None:
    client = SubscriptionsClient(BASE_URL, API_KEY, transport=httpx.MockTransport(Recorder(json_response(200, {}))))
    inner = client._http
    with client:
        assert not inner.is_closed
    assert inner.is_closed


async def test_the_async_client_closes_its_own_client_and_leaves_an_injected_one() -> None:
    recorder = Recorder(json_response(200, SUBSCRIPTION_JSON))
    async with AsyncSubscriptionsClient(BASE_URL, API_KEY, transport=httpx.MockTransport(recorder)) as client:
        inner = client._http
        await client.subscriptions.get(Provider.RAZORPAY, SUBSCRIPTION_ID)
    assert inner.is_closed

    http = httpx.AsyncClient(transport=httpx.MockTransport(recorder))
    async with AsyncSubscriptionsClient(BASE_URL, API_KEY, http_client=http) as client:
        await client.subscriptions.get(Provider.RAZORPAY, SUBSCRIPTION_ID)
    assert not http.is_closed
    await http.aclose()


def test_the_timeout_reaches_httpx() -> None:
    client = SubscriptionsClient(BASE_URL, API_KEY, timeout=7.5)
    assert client._http.timeout == httpx.Timeout(7.5)
    client.close()
