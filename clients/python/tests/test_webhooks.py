"""The webhook helper: the raw body goes to the service byte for byte, with the headers by lower-case name."""

from __future__ import annotations

import json
from typing import Any, Dict, Iterable, List, Tuple, Union

import httpx
import pytest

from india_subscriptions import (
    ErrorCode,
    EventType,
    Provider,
    SubscriptionEvent,
    SubscriptionsApiError,
    SubscriptionsClient,
    AsyncSubscriptionsClient,
    build_webhook_request,
    parse_webhook,
    parse_webhook_async,
)
from india_subscriptions.constants import ApiPath, ContentType, HeaderName, HttpStatus

from .cases import EVENT_JSON, SUBSCRIPTION_ID, WEBHOOK_SIGNATURE_HEADER
from .conftest import API_KEY, BASE_URL, Recorder, json_response

# Nothing a JSON round trip would preserve: odd spacing, CRLF, a BOM, non-ASCII, escapes, a trailing newline.
AWKWARD_BODY = '﻿{ "event" :"subscription.charged",\r\n\t"note":"₹499 \\u20b9 \U0001f4b8  ",  "id" : "evt_1" }\n\n'
SIGNATURE = "5f2a0c"


class MultiHeaders:
    """What Starlette and Werkzeug hand you: not a Mapping, but with ``items()`` (repeats allowed)."""

    def __init__(self, pairs: List[Tuple[str, str]]) -> None:
        self._pairs = pairs

    def items(self) -> Iterable[Tuple[str, str]]:
        return list(self._pairs)


def sent_request(recorder: Recorder) -> Dict[str, Any]:
    assert len(recorder.requests) == 1
    request = recorder.last
    assert request.method == "POST"
    assert request.url.path == ApiPath.WEBHOOKS_PARSE.format(provider=Provider.RAZORPAY.value)
    assert request.headers[HeaderName.AUTHORIZATION.value] == f"Bearer {API_KEY}"
    body = json.loads(request.content)
    assert isinstance(body, dict)
    return body


def sync_client(recorder: Recorder) -> SubscriptionsClient:
    return SubscriptionsClient(BASE_URL, API_KEY, transport=httpx.MockTransport(recorder), max_retries=0)


@pytest.mark.parametrize(
    "raw",
    [
        pytest.param(AWKWARD_BODY.encode("utf-8"), id="bytes"),
        pytest.param(AWKWARD_BODY, id="str"),
        pytest.param(bytearray(AWKWARD_BODY.encode("utf-8")), id="bytearray"),
        pytest.param(memoryview(AWKWARD_BODY.encode("utf-8")), id="memoryview"),
    ],
)
def test_the_body_is_forwarded_byte_for_byte(raw: Union[bytes, str, bytearray, memoryview]) -> None:
    recorder = Recorder(json_response(200, [EVENT_JSON]))

    events = parse_webhook(sync_client(recorder), Provider.RAZORPAY, raw, {WEBHOOK_SIGNATURE_HEADER: SIGNATURE})

    forwarded = sent_request(recorder)["rawBody"]
    assert forwarded.encode("utf-8") == AWKWARD_BODY.encode("utf-8")  # a signature over these bytes still verifies
    assert forwarded.startswith("﻿")  # the BOM is part of what the gateway signed
    assert len(events) == 1 and isinstance(events[0], SubscriptionEvent)
    assert events[0].type is EventType.SUBSCRIPTION_CHARGED
    assert events[0].subscription_id == SUBSCRIPTION_ID


async def test_the_async_helper_does_the_same() -> None:
    recorder = Recorder(json_response(200, [EVENT_JSON]))
    client = AsyncSubscriptionsClient(BASE_URL, API_KEY, transport=httpx.MockTransport(recorder), max_retries=0)

    events = await parse_webhook_async(client, Provider.RAZORPAY, AWKWARD_BODY.encode("utf-8"), {WEBHOOK_SIGNATURE_HEADER: SIGNATURE})
    await client.aclose()

    assert sent_request(recorder)["rawBody"] == AWKWARD_BODY
    assert events[0].id == EVENT_JSON["id"]


def test_a_body_that_is_not_utf8_is_refused_rather_than_altered() -> None:
    recorder = Recorder(json_response(200, [EVENT_JSON]))

    with pytest.raises(ValueError, match="UTF-8"):
        parse_webhook(sync_client(recorder), Provider.RAZORPAY, b"\xff\xfe{}", {})

    assert recorder.requests == []


def test_headers_are_forwarded_by_lower_case_name() -> None:
    recorder = Recorder(json_response(200, [EVENT_JSON]))
    headers = {"X-Razorpay-Signature": SIGNATURE, "Content-Type": ContentType.JSON.value}

    parse_webhook(sync_client(recorder), Provider.RAZORPAY, "{}", headers)

    assert sent_request(recorder)["headers"] == {"x-razorpay-signature": SIGNATURE, "content-type": ContentType.JSON.value}


def test_framework_header_objects_and_repeated_headers_work() -> None:
    recorder = Recorder(json_response(200, [EVENT_JSON]))
    headers = MultiHeaders([("X-Sig", "a"), ("Via", "one"), ("via", "two"), ("Via", "three")])

    parse_webhook(sync_client(recorder), Provider.RAZORPAY, "{}", headers)

    assert sent_request(recorder)["headers"] == {"x-sig": "a", "via": ["one", "two", "three"]}


def test_header_values_that_are_already_lists_are_kept() -> None:
    request = build_webhook_request("{}", {"X-Multi": ["a", "b"]})
    assert request.headers == {"x-multi": ["a", "b"]}


def test_the_result_is_a_list_of_models_even_when_empty() -> None:
    recorder = Recorder(json_response(200, []))
    assert parse_webhook(sync_client(recorder), Provider.RAZORPAY, "{}", {}) == []


def test_a_bad_signature_is_a_signature_invalid_error() -> None:
    body = {"error": {"code": ErrorCode.SIGNATURE_INVALID.value, "message": "razorpay webhook signature does not match", "provider": Provider.RAZORPAY.value, "retryable": False}}
    recorder = Recorder(json_response(HttpStatus.UNAUTHORIZED, body))

    with pytest.raises(SubscriptionsApiError) as caught:
        parse_webhook(sync_client(recorder), Provider.RAZORPAY, "{}", {WEBHOOK_SIGNATURE_HEADER: "wrong"})

    assert caught.value.code is ErrorCode.SIGNATURE_INVALID
    assert caught.value.status_code == HttpStatus.UNAUTHORIZED
    assert caught.value.provider is Provider.RAZORPAY
    assert caught.value.retryable is False


def test_receive_forwards_the_gateways_own_headers_but_never_an_api_key_or_hop_headers() -> None:
    recorder = Recorder(json_response(200, {"received": 2}))
    form = b"txnid=1&hash=abc%20def"
    headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Gateway-Signature": SIGNATURE,
        "Authorization": "Bearer from-the-gateway",
        "Host": "gateway.example",
        "Content-Length": "999",
        "Connection": "keep-alive",
    }

    receipt = sync_client(recorder).webhooks.receive(Provider.PAYU, form, headers)

    request = recorder.last
    assert receipt.received == 2
    assert request.url.path == ApiPath.WEBHOOKS.format(provider=Provider.PAYU.value)
    assert request.content == form
    assert request.headers[HeaderName.CONTENT_TYPE.value] == "application/x-www-form-urlencoded"
    assert request.headers["x-gateway-signature"] == SIGNATURE
    assert HeaderName.AUTHORIZATION.value not in request.headers
    assert request.headers["host"] == "service.test"
    assert request.headers["content-length"] == str(len(form))
