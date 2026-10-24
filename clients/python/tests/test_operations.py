"""Every operation, through both clients: the exact request on the wire and the model that comes back."""

from __future__ import annotations

from typing import Any

import pytest

from india_subscriptions.constants import ROUTES, ApiPath, AuthMode, ContentType, HeaderName, OperationId

from .cases import CASES, EMPTY_BODY_OPERATIONS, FLUSH_RESULT_JSON, HEALTH_JSON, SUBSCRIPTION_JSON, TICK_JSON, Case, case_id, parsed
from .conftest import API_KEY, BASE_URL, BOTH_KINDS, ClientKind, Recorder, json_response, run


def test_there_is_one_case_per_operation() -> None:
    assert sorted(case.operation.value for case in CASES) == sorted(operation.value for operation in OperationId)


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
@pytest.mark.parametrize("case", CASES, ids=case_id)
async def test_request_and_result(kind: ClientKind, case: Case) -> None:
    recorder = Recorder(json_response(case.status, case.response))

    result = await run(kind, recorder, case.call)

    request = recorder.last
    assert len(recorder.requests) == 1
    route = ROUTES[case.operation]
    assert request.method == (case.method or route.method).value
    assert request.url.path == case.path
    assert str(request.url).startswith(BASE_URL)
    assert dict(request.url.params) == case.query

    # Authentication: the key goes only where the route needs it.
    assert case.sends_auth == (route.auth is AuthMode.BEARER)
    if case.sends_auth:
        assert request.headers[HeaderName.AUTHORIZATION.value] == f"Bearer {API_KEY}"
    else:
        assert HeaderName.AUTHORIZATION.value not in request.headers
    assert request.headers[HeaderName.ACCEPT.value] == ContentType.JSON.value
    assert request.headers[HeaderName.USER_AGENT.value].startswith("india-subscriptions-python/")
    for name, value in case.headers.items():
        assert request.headers[name] == value

    if case.raw_body is not None:
        assert request.content == case.raw_body
        assert request.headers[HeaderName.CONTENT_TYPE.value] == ContentType.JSON.value
    elif case.body is None:
        assert request.content == b""
        assert HeaderName.CONTENT_TYPE.value not in request.headers
    else:
        assert parsed(request.content) == case.body
        assert request.headers[HeaderName.CONTENT_TYPE.value] == ContentType.JSON.value

    case.check(result)


EMPTY_BODY_RESPONSES = {
    OperationId.CANCEL_SUBSCRIPTION: SUBSCRIPTION_JSON,
    OperationId.PAUSE_SUBSCRIPTION: SUBSCRIPTION_JSON,
    OperationId.RESUME_SUBSCRIPTION: SUBSCRIPTION_JSON,
    OperationId.RUN_SCHEDULER_TICK: TICK_JSON,
    OperationId.FLUSH_PURCHASE_REPORTS: FLUSH_RESULT_JSON,
}


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
@pytest.mark.parametrize(("operation", "call"), EMPTY_BODY_OPERATIONS, ids=lambda value: getattr(value, "value", ""))
async def test_optional_body_is_left_out_when_not_given(kind: ClientKind, operation: OperationId, call: Any) -> None:
    recorder = Recorder(json_response(200, EMPTY_BODY_RESPONSES[operation]))

    await run(kind, recorder, call)

    assert recorder.last.method == ROUTES[operation].method.value
    assert recorder.last.content == b""
    assert HeaderName.CONTENT_TYPE.value not in recorder.last.headers


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
async def test_base_url_may_carry_a_mount_prefix(kind: ClientKind) -> None:
    recorder = Recorder(json_response(200, HEALTH_JSON))

    await run(kind, recorder, lambda client: client.health(), base_url=f"{BASE_URL}/billing/")

    assert recorder.last.url.path == f"/billing{ApiPath.HEALTH}"
