"""Error mapping: every documented status and code, undocumented bodies, transport failures, retries."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import httpx
import pytest

from india_subscriptions import (
    ErrorCode,
    Provider,
    SubscriptionsApiError,
    SubscriptionsClient,
    SubscriptionsError,
    SubscriptionsTransportError,
)
from india_subscriptions.constants import RETRYABLE_STATUSES, HttpMethod, HttpStatus

from .cases import SUBSCRIPTION_ID, SUBSCRIPTION_JSON, TICK_JSON
from .conftest import API_KEY, BASE_URL, BOTH_KINDS, ClientKind, Recorder, json_response, run

# What the service answers for each code (src/server/constants.ts: ERROR_HTTP_STATUS and SERVER_ERROR_HTTP_STATUS).
STATUS_OF_CODE: Dict[ErrorCode, HttpStatus] = {
    ErrorCode.VALIDATION: HttpStatus.BAD_REQUEST,
    ErrorCode.SIGNATURE_INVALID: HttpStatus.UNAUTHORIZED,
    ErrorCode.UNAUTHORIZED: HttpStatus.UNAUTHORIZED,
    ErrorCode.NOT_FOUND: HttpStatus.NOT_FOUND,
    ErrorCode.METHOD_NOT_ALLOWED: HttpStatus.METHOD_NOT_ALLOWED,
    ErrorCode.CONFLICT: HttpStatus.CONFLICT,
    ErrorCode.PAYLOAD_TOO_LARGE: HttpStatus.PAYLOAD_TOO_LARGE,
    ErrorCode.UNSUPPORTED: HttpStatus.UNPROCESSABLE,
    ErrorCode.NO_ROUTE: HttpStatus.UNPROCESSABLE,
    ErrorCode.RATE_LIMITED: HttpStatus.TOO_MANY_REQUESTS,
    ErrorCode.CONFIG: HttpStatus.INTERNAL_SERVER_ERROR,
    ErrorCode.INTERNAL_ERROR: HttpStatus.INTERNAL_SERVER_ERROR,
    ErrorCode.AUTH: HttpStatus.BAD_GATEWAY,
    ErrorCode.PROVIDER_ERROR: HttpStatus.BAD_GATEWAY,
    ErrorCode.UNEXPECTED_RESPONSE: HttpStatus.BAD_GATEWAY,
    ErrorCode.NETWORK: HttpStatus.BAD_GATEWAY,
    ErrorCode.PROVIDER_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
    ErrorCode.TIMEOUT: HttpStatus.GATEWAY_TIMEOUT,
    ErrorCode.OUTCOME_UNKNOWN: HttpStatus.GATEWAY_TIMEOUT,
}

GET_SUBSCRIPTION = lambda c: c.subscriptions.get(Provider.RAZORPAY, SUBSCRIPTION_ID)  # noqa: E731
CANCEL_SUBSCRIPTION = lambda c: c.subscriptions.cancel(Provider.RAZORPAY, SUBSCRIPTION_ID)  # noqa: E731


def error_body(code: ErrorCode, **fields: Any) -> Dict[str, Any]:
    error: Dict[str, Any] = {"code": code.value, "message": f"{code.value} happened", "retryable": False}
    error.update(fields)
    return {"error": error}


def test_the_status_table_covers_every_error_code() -> None:
    assert set(STATUS_OF_CODE) == set(ErrorCode)


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
@pytest.mark.parametrize("code", list(ErrorCode), ids=lambda code: code.value)
async def test_every_documented_code_becomes_an_api_error(kind: ClientKind, code: ErrorCode) -> None:
    status = STATUS_OF_CODE[code]
    body = error_body(
        code, provider=Provider.PAYU.value, httpStatus=502, providerCode="GATEWAY_BAD", retryable=code is ErrorCode.RATE_LIMITED
    )
    recorder = Recorder(json_response(status, body))

    with pytest.raises(SubscriptionsApiError) as caught:
        await run(kind, recorder, CANCEL_SUBSCRIPTION)

    error = caught.value
    assert error.code is code
    assert error.message == f"{code.value} happened"
    assert error.provider is Provider.PAYU
    assert error.http_status == 502  # the gateway's status, from the body
    assert error.status_code == status  # this response's status
    assert error.provider_code == "GATEWAY_BAD"
    assert error.retryable is (code is ErrorCode.RATE_LIMITED)
    assert error.documented_shape is True
    assert error.outcome_unknown is (code is ErrorCode.OUTCOME_UNKNOWN)
    assert isinstance(error, SubscriptionsError)
    assert code.value in str(error)
    assert len(recorder.requests) == 1


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
async def test_optional_error_fields_may_be_absent(kind: ClientKind) -> None:
    recorder = Recorder(json_response(HttpStatus.NOT_FOUND, error_body(ErrorCode.NOT_FOUND)))

    with pytest.raises(SubscriptionsApiError) as caught:
        await run(kind, recorder, GET_SUBSCRIPTION)

    assert (caught.value.provider, caught.value.http_status, caught.value.provider_code) == (None, None, None)


UNDOCUMENTED: List[Any] = [
    pytest.param(httpx.Response(HttpStatus.BAD_GATEWAY, text="<html>502 Bad Gateway</html>"), id="html-from-a-proxy"),
    pytest.param(httpx.Response(HttpStatus.INTERNAL_SERVER_ERROR), id="empty-body"),
    pytest.param(httpx.Response(HttpStatus.BAD_REQUEST, json=["not", "an", "object"]), id="json-array"),
    pytest.param(httpx.Response(HttpStatus.BAD_REQUEST, json={"detail": "FastAPI style"}), id="other-json-object"),
    pytest.param(
        httpx.Response(HttpStatus.BAD_REQUEST, json={"error": {"code": "SOMETHING_NEW", "message": "x", "retryable": False}}),
        id="code-from-a-newer-service",
    ),
    pytest.param(
        httpx.Response(HttpStatus.BAD_REQUEST, json={"error": {"code": ErrorCode.VALIDATION.value}}),
        id="missing-fields",
    ),
    pytest.param(httpx.Response(302, headers={"location": "/login"}), id="redirect"),
]


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
@pytest.mark.parametrize("response", UNDOCUMENTED)
async def test_a_body_that_is_not_the_documented_error_still_raises_something_useful(
    kind: ClientKind, response: httpx.Response
) -> None:
    recorder = Recorder(response)

    with pytest.raises(SubscriptionsApiError) as caught:
        await run(kind, recorder, GET_SUBSCRIPTION)

    error = caught.value
    assert error.code is ErrorCode.UNEXPECTED_RESPONSE
    assert error.documented_shape is False
    assert error.status_code == response.status_code
    assert str(int(response.status_code)) in str(error)  # int(): str() of an IntEnum differs before Python 3.11
    assert error.response_body == response.text[:500]
    assert error.retryable is (response.status_code in RETRYABLE_STATUSES)


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
@pytest.mark.parametrize(
    "response",
    [
        pytest.param(httpx.Response(HttpStatus.OK, text="not json"), id="not-json"),
        pytest.param(httpx.Response(HttpStatus.OK), id="empty"),
        pytest.param(httpx.Response(HttpStatus.OK, json={"id": SUBSCRIPTION_ID}), id="missing-required-fields"),
        pytest.param(httpx.Response(HttpStatus.OK, json=[SUBSCRIPTION_JSON]), id="wrong-container"),
        pytest.param(
            httpx.Response(HttpStatus.OK, json={**SUBSCRIPTION_JSON, "status": "not-a-status"}), id="unknown-enum-value"
        ),
    ],
)
async def test_a_success_body_that_does_not_match_the_schema_is_an_api_error_not_a_validation_error(
    kind: ClientKind, response: httpx.Response
) -> None:
    recorder = Recorder(response)

    with pytest.raises(SubscriptionsApiError) as caught:
        await run(kind, recorder, GET_SUBSCRIPTION)

    assert caught.value.code is ErrorCode.UNEXPECTED_RESPONSE
    assert caught.value.documented_shape is False
    assert caught.value.status_code == HttpStatus.OK
    assert caught.value.__cause__ is not None


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
async def test_a_newer_service_adding_response_fields_does_not_break_the_client(kind: ClientKind) -> None:
    recorder = Recorder(json_response(HttpStatus.OK, {**SUBSCRIPTION_JSON, "somethingNew": {"a": 1}}))

    subscription = await run(kind, recorder, GET_SUBSCRIPTION)

    assert subscription.id == SUBSCRIPTION_ID


# -- transport failures ----------------------------------------------------------------------------------


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
@pytest.mark.parametrize(
    ("failure", "timed_out", "request_sent"),
    [
        (httpx.ConnectError("refused"), False, False),
        (httpx.ConnectTimeout("connect timed out"), True, False),
        (httpx.ReadTimeout("read timed out"), True, True),
        (httpx.RemoteProtocolError("peer closed the connection"), False, True),
        (httpx.ReadError("reset"), False, True),
    ],
    ids=["connect-error", "connect-timeout", "read-timeout", "protocol-error", "read-error"],
)
async def test_transport_errors(kind: ClientKind, failure: Exception, timed_out: bool, request_sent: bool) -> None:
    recorder = Recorder([failure])

    with pytest.raises(SubscriptionsTransportError) as caught:
        await run(kind, recorder, CANCEL_SUBSCRIPTION)

    error = caught.value
    assert isinstance(error, SubscriptionsError)
    assert not isinstance(error, SubscriptionsApiError)
    assert error.timed_out is timed_out
    assert error.request_sent is request_sent
    assert error.method is HttpMethod.POST
    assert "?" not in error.url and error.url.startswith(BASE_URL)
    # A write that may have been sent has an unknown outcome; a GET never does.
    assert error.outcome_unknown is request_sent
    assert error.__cause__ is failure
    assert API_KEY not in str(error)


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
async def test_a_get_that_times_out_has_no_unknown_outcome(kind: ClientKind) -> None:
    recorder = Recorder([httpx.ReadTimeout("slow")])

    with pytest.raises(SubscriptionsTransportError) as caught:
        await run(kind, recorder, GET_SUBSCRIPTION)

    assert caught.value.timed_out is True
    assert caught.value.outcome_unknown is False


# -- retries: GET only -----------------------------------------------------------------------------------


def retryable_error_response() -> httpx.Response:
    return json_response(
        HttpStatus.SERVICE_UNAVAILABLE, error_body(ErrorCode.PROVIDER_UNAVAILABLE, retryable=True)
    )


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
async def test_a_get_is_retried_after_a_network_failure(kind: ClientKind) -> None:
    recorder = Recorder([httpx.ConnectError("refused"), httpx.ReadTimeout("slow"), json_response(200, SUBSCRIPTION_JSON)])

    subscription = await run(kind, recorder, GET_SUBSCRIPTION, max_retries=2)

    assert subscription.id == SUBSCRIPTION_ID
    assert len(recorder.requests) == 3


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
async def test_a_get_is_retried_when_the_service_says_retryable(kind: ClientKind) -> None:
    recorder = Recorder([retryable_error_response(), json_response(200, SUBSCRIPTION_JSON)])

    subscription = await run(kind, recorder, GET_SUBSCRIPTION, max_retries=1)

    assert subscription.id == SUBSCRIPTION_ID
    assert len(recorder.requests) == 2


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
async def test_retries_stop_at_max_retries(kind: ClientKind) -> None:
    recorder = Recorder([retryable_error_response()])

    with pytest.raises(SubscriptionsApiError) as caught:
        await run(kind, recorder, GET_SUBSCRIPTION, max_retries=2)

    assert caught.value.code is ErrorCode.PROVIDER_UNAVAILABLE
    assert len(recorder.requests) == 3


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
async def test_a_get_is_not_retried_when_the_error_is_final(kind: ClientKind) -> None:
    recorder = Recorder([json_response(HttpStatus.NOT_FOUND, error_body(ErrorCode.NOT_FOUND))])

    with pytest.raises(SubscriptionsApiError):
        await run(kind, recorder, GET_SUBSCRIPTION, max_retries=5)

    assert len(recorder.requests) == 1


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
@pytest.mark.parametrize(
    "failure",
    [
        pytest.param(retryable_error_response(), id="retryable-error-body"),
        pytest.param(json_response(HttpStatus.TOO_MANY_REQUESTS, error_body(ErrorCode.RATE_LIMITED, retryable=True)), id="rate-limited"),
        pytest.param(httpx.Response(HttpStatus.BAD_GATEWAY, text="proxy error"), id="undocumented-502"),
        pytest.param(httpx.ConnectError("refused"), id="connect-error"),
        pytest.param(httpx.ReadTimeout("slow"), id="read-timeout"),
    ],
)
async def test_a_write_is_never_retried(kind: ClientKind, failure: Any) -> None:
    recorder = Recorder([failure, json_response(200, SUBSCRIPTION_JSON)])

    with pytest.raises(SubscriptionsError):
        await run(kind, recorder, CANCEL_SUBSCRIPTION, max_retries=5)

    assert len(recorder.requests) == 1


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
async def test_the_scheduler_tick_is_never_retried(kind: ClientKind) -> None:
    recorder = Recorder([retryable_error_response(), json_response(200, TICK_JSON)])

    with pytest.raises(SubscriptionsApiError):
        await run(kind, recorder, lambda c: c.scheduler.tick(), max_retries=5)

    assert len(recorder.requests) == 1


def test_outcome_unknown_is_documented() -> None:
    doc = " ".join((SubscriptionsApiError.__doc__ or "").replace("*", "").split())
    assert ErrorCode.OUTCOME_UNKNOWN.value in doc
    assert "may or may not have happened" in doc and "fetch the current state" in doc and "never retries" in doc


def test_the_api_key_is_not_in_repr_or_errors() -> None:
    client = SubscriptionsClient(BASE_URL, API_KEY, transport=httpx.MockTransport(Recorder(json_response(500, {}))))
    assert API_KEY not in repr(client)
    with pytest.raises(SubscriptionsApiError) as caught:
        client.subscriptions.get(Provider.RAZORPAY, SUBSCRIPTION_ID)
    assert API_KEY not in str(caught.value) and API_KEY not in repr(caught.value)


def test_retryable_error_default_is_off_for_documented_errors_without_the_flag() -> None:
    recorder = Recorder([json_response(HttpStatus.SERVICE_UNAVAILABLE, error_body(ErrorCode.PROVIDER_UNAVAILABLE)), json_response(200, SUBSCRIPTION_JSON)])
    client = SubscriptionsClient(BASE_URL, API_KEY, transport=httpx.MockTransport(recorder), max_retries=3, retry_backoff=0)
    with pytest.raises(SubscriptionsApiError):
        client.subscriptions.get(Provider.RAZORPAY, SUBSCRIPTION_ID)
    assert len(recorder.requests) == 1  # the service said retryable=false: believe it
