"""One-time payments, routing, purchases and entitlements: error mapping, retries, inputs and enums.

The exact request and the parsed result of every one of these operations is covered, through both clients, by
``test_operations.py`` (the cases in ``cases.py``). This module covers what is specific to them.
"""

from __future__ import annotations

import json
from typing import Any, Callable, List, Tuple

import httpx
import pytest
from pydantic import ValidationError

from india_subscriptions import (
    ChannelPolicy,
    ErrorCode,
    Platform,
    ProductKind,
    Provider,
    SubscriptionsApiError,
    SubscriptionsError,
    SubscriptionsTransportError,
)
from india_subscriptions.constants import ApiPath, HttpMethod, HttpStatus
from india_subscriptions.models import PaymentStatus, SessionStatus

from .cases import (
    CUSTOMER_REF,
    ENTITLEMENTS_JSON,
    FLUSH_RESULT_JSON,
    GATEWAY_RESULT,
    PAYMENT_ID,
    PAYMENT_JSON,
    PAYMENT_REFUND_JSON,
    PAYMENT_VERIFICATION_JSON,
    PURCHASE_SESSION_JSON,
    PURCHASE_TOKEN_RESULT,
    ROUTING_DECISION_JSON,
    SESSION_ID,
)
from .conftest import BASE_URL, BOTH_KINDS, ClientKind, Recorder, json_response, run
from .test_errors import error_body

Call = Callable[[Any], Any]

PAYMENT_INPUT = {"amount": 29900, "customer": {"name": "Asha", "email": "asha@example.com"}}
ROUTE_INPUT = {"kind": ProductKind.ONE_TIME, "amount": 29900}
PURCHASE_INPUT = {
    "platform": Platform.WEB,
    "product": "pro_monthly",
    "customer": {"name": "Asha"},
    "customer_ref": CUSTOMER_REF,
}

# (id, the call, the success body the service would answer with)
WRITES: List[Tuple[str, Call, Any]] = [
    ("payments.create", lambda c: c.payments.create(Provider.RAZORPAY, PAYMENT_INPUT), PAYMENT_JSON),
    (
        "payments.verify",
        lambda c: c.payments.verify(Provider.RAZORPAY, GATEWAY_RESULT, PAYMENT_ID),
        PAYMENT_VERIFICATION_JSON,
    ),
    (
        "payments.refund",
        lambda c: c.payments.refund(Provider.RAZORPAY, {"payment_id": PAYMENT_ID, "refund_id": "rf_1"}),
        PAYMENT_REFUND_JSON,
    ),
    ("routing.decide", lambda c: c.routing.decide(ROUTE_INPUT), ROUTING_DECISION_JSON),
    (
        "routing.record_outcome",
        lambda c: c.routing.record_outcome({"provider": Provider.CASHFREE, "kind": "payment", "result": "success"}),
        {"recorded": True},
    ),
    ("purchases.start", lambda c: c.purchases.start(PURCHASE_INPUT), PURCHASE_SESSION_JSON),
    ("purchases.choose_alternative", lambda c: c.purchases.choose_alternative(SESSION_ID, "token_1"), PURCHASE_SESSION_JSON),
    (
        "purchases.complete",
        lambda c: c.purchases.complete(SESSION_ID, Provider.GOOGLE_PLAY, PURCHASE_TOKEN_RESULT),
        PURCHASE_SESSION_JSON,
    ),
    ("purchases.flush", lambda c: c.purchases.flush(), FLUSH_RESULT_JSON),
]

READS: List[Tuple[str, Call, Any]] = [
    ("payments.get", lambda c: c.payments.get(Provider.RAZORPAY, PAYMENT_ID), PAYMENT_JSON),
    ("purchases.get", lambda c: c.purchases.get(SESSION_ID), PURCHASE_SESSION_JSON),
    ("entitlements.get", lambda c: c.entitlements.get(CUSTOMER_REF), ENTITLEMENTS_JSON),
]

ALL = WRITES + READS


def retryable_error_response() -> httpx.Response:
    return json_response(HttpStatus.SERVICE_UNAVAILABLE, error_body(ErrorCode.PROVIDER_UNAVAILABLE, retryable=True))


# -- the service's error codes ----------------------------------------------------------------------------


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
async def test_no_route_is_a_recognised_code(kind: ClientKind) -> None:
    recorder = Recorder(json_response(HttpStatus.UNPROCESSABLE, error_body(ErrorCode.NO_ROUTE)))

    with pytest.raises(SubscriptionsApiError) as caught:
        await run(kind, recorder, lambda c: c.routing.decide(ROUTE_INPUT))

    error = caught.value
    assert error.code is ErrorCode.NO_ROUTE
    assert error.documented_shape is True
    assert error.status_code == HttpStatus.UNPROCESSABLE
    assert error.retryable is False
    assert len(recorder.requests) == 1


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
@pytest.mark.parametrize(("name", "call", "success"), ALL, ids=[entry[0] for entry in ALL])
@pytest.mark.parametrize(
    ("code", "status"),
    [
        (ErrorCode.VALIDATION, HttpStatus.BAD_REQUEST),
        (ErrorCode.UNAUTHORIZED, HttpStatus.UNAUTHORIZED),
        (ErrorCode.NOT_FOUND, HttpStatus.NOT_FOUND),
        (ErrorCode.CONFLICT, HttpStatus.CONFLICT),
        (ErrorCode.SIGNATURE_INVALID, HttpStatus.UNAUTHORIZED),
        (ErrorCode.CONFIG, HttpStatus.INTERNAL_SERVER_ERROR),
        (ErrorCode.NO_ROUTE, HttpStatus.UNPROCESSABLE),
        (ErrorCode.PROVIDER_ERROR, HttpStatus.BAD_GATEWAY),
    ],
    ids=lambda value: getattr(value, "value", None) or str(int(value)),
)
async def test_every_new_operation_raises_the_typed_error(
    kind: ClientKind, name: str, call: Call, success: Any, code: ErrorCode, status: HttpStatus
) -> None:
    body = error_body(code, provider=Provider.CASHFREE.value, httpStatus=400, providerCode="GATEWAY_SAYS_NO")
    recorder = Recorder(json_response(status, body))

    with pytest.raises(SubscriptionsApiError) as caught:
        await run(kind, recorder, call)

    error = caught.value
    assert error.code is code
    assert error.provider is Provider.CASHFREE
    assert error.http_status == 400
    assert error.provider_code == "GATEWAY_SAYS_NO"
    assert error.status_code == status
    assert error.outcome_unknown is False
    assert len(recorder.requests) == 1


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
@pytest.mark.parametrize(("name", "call", "success"), WRITES, ids=[entry[0] for entry in WRITES])
async def test_outcome_unknown_from_the_service_is_reported_and_not_repeated(
    kind: ClientKind, name: str, call: Call, success: Any
) -> None:
    body = error_body(ErrorCode.OUTCOME_UNKNOWN, provider=Provider.RAZORPAY.value, retryable=False)
    recorder = Recorder([json_response(HttpStatus.GATEWAY_TIMEOUT, body), json_response(200, success)])

    with pytest.raises(SubscriptionsApiError) as caught:
        await run(kind, recorder, call, max_retries=5)

    assert caught.value.code is ErrorCode.OUTCOME_UNKNOWN
    assert caught.value.outcome_unknown is True
    assert len(recorder.requests) == 1


# -- retries: GET only ------------------------------------------------------------------------------------


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
@pytest.mark.parametrize(("name", "call", "success"), WRITES, ids=[entry[0] for entry in WRITES])
@pytest.mark.parametrize(
    "failure",
    [
        pytest.param(retryable_error_response(), id="retryable-error-body"),
        pytest.param(httpx.Response(HttpStatus.BAD_GATEWAY, text="proxy error"), id="undocumented-502"),
        pytest.param(httpx.ConnectError("refused"), id="connect-error"),
        pytest.param(httpx.ReadTimeout("slow"), id="read-timeout"),
    ],
)
async def test_a_write_is_never_retried(
    kind: ClientKind, name: str, call: Call, success: Any, failure: Any
) -> None:
    recorder = Recorder([failure, json_response(200, success)])

    with pytest.raises(SubscriptionsError):
        await run(kind, recorder, call, max_retries=5)

    assert len(recorder.requests) == 1


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
@pytest.mark.parametrize(("name", "call", "success"), WRITES, ids=[entry[0] for entry in WRITES])
async def test_a_write_that_may_have_been_sent_has_an_unknown_outcome(
    kind: ClientKind, name: str, call: Call, success: Any
) -> None:
    recorder = Recorder([httpx.ReadTimeout("slow")])

    with pytest.raises(SubscriptionsTransportError) as caught:
        await run(kind, recorder, call)

    assert caught.value.method is HttpMethod.POST
    assert caught.value.outcome_unknown is True


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
@pytest.mark.parametrize(("name", "call", "success"), READS, ids=[entry[0] for entry in READS])
async def test_a_read_is_retried(kind: ClientKind, name: str, call: Call, success: Any) -> None:
    recorder = Recorder([retryable_error_response(), httpx.ConnectError("refused"), json_response(200, success)])

    result = await run(kind, recorder, call, max_retries=2)

    assert result is not None
    assert len(recorder.requests) == 3
    assert {request.method for request in recorder.requests} == {HttpMethod.GET.value}


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
@pytest.mark.parametrize(("name", "call", "success"), READS, ids=[entry[0] for entry in READS])
async def test_a_read_is_not_retried_when_the_error_is_final(
    kind: ClientKind, name: str, call: Call, success: Any
) -> None:
    recorder = Recorder([json_response(HttpStatus.NOT_FOUND, error_body(ErrorCode.NOT_FOUND)), json_response(200, success)])

    with pytest.raises(SubscriptionsApiError):
        await run(kind, recorder, call, max_retries=5)

    assert len(recorder.requests) == 1


# -- results are real enums and models --------------------------------------------------------------------


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
async def test_results_carry_real_enums(kind: ClientKind) -> None:
    payment = await run(kind, Recorder(json_response(200, PAYMENT_JSON)), READS[0][1])
    assert payment.status is PaymentStatus.SUCCEEDED
    assert isinstance(payment.provider, Provider)

    session = await run(kind, Recorder(json_response(200, PURCHASE_SESSION_JSON)), READS[1][1])
    assert isinstance(session.platform, Platform) and session.platform is Platform.ANDROID
    assert isinstance(session.policy, ChannelPolicy) and session.policy is ChannelPolicy.USER_CHOICE
    assert isinstance(session.status, SessionStatus)


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
async def test_a_value_the_service_does_not_know_yet_is_an_unexpected_response_not_a_validation_error(
    kind: ClientKind,
) -> None:
    recorder = Recorder(json_response(200, {**PURCHASE_SESSION_JSON, "platform": "watchos"}))

    with pytest.raises(SubscriptionsApiError) as caught:
        await run(kind, recorder, READS[1][1])

    assert caught.value.code is ErrorCode.UNEXPECTED_RESPONSE
    assert caught.value.documented_shape is False


# -- inputs -----------------------------------------------------------------------------------------------


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
@pytest.mark.parametrize(
    "call",
    [
        pytest.param(lambda c: c.payments.create(Provider.RAZORPAY, {**PAYMENT_INPUT, "amout": 1}), id="payment-typo"),
        pytest.param(lambda c: c.payments.create(Provider.RAZORPAY, {**PAYMENT_INPUT, "amount": 0}), id="payment-zero-amount"),
        pytest.param(lambda c: c.payments.create(Provider.RAZORPAY, {**PAYMENT_INPUT, "amount": 10.5}), id="payment-fractional-paise"),
        pytest.param(lambda c: c.payments.create(Provider.RAZORPAY, {**PAYMENT_INPUT, "payment_methods": ["cheque"]}), id="payment-unknown-method"),
        pytest.param(lambda c: c.payments.create(Provider.RAZORPAY, {"amount": 100}), id="payment-no-customer"),
        pytest.param(lambda c: c.payments.refund(Provider.RAZORPAY, {"payment_id": PAYMENT_ID}), id="refund-missing-refund-id"),
        pytest.param(lambda c: c.payments.refund(Provider.RAZORPAY, {"payment_id": PAYMENT_ID, "refund_id": "x" * 41}), id="refund-id-too-long"),
        pytest.param(lambda c: c.payments.verify(Provider.RAZORPAY, GATEWAY_RESULT, ""), id="verify-empty-expected-id"),
        pytest.param(lambda c: c.routing.decide({**ROUTE_INPUT, "kinds": 1}), id="route-typo"),
        pytest.param(lambda c: c.routing.decide({**ROUTE_INPUT, "kind": "lease"}), id="route-unknown-kind"),
        pytest.param(lambda c: c.routing.decide({**ROUTE_INPUT, "needs": {"refund": True}}), id="route-needs-typo"),
        pytest.param(lambda c: c.routing.decide({**ROUTE_INPUT, "exclude": ["stripe"]}), id="route-unknown-provider"),
        pytest.param(lambda c: c.routing.record_outcome({"provider": Provider.PAYU, "kind": "payment", "result": "maybe"}), id="outcome-unknown-result"),
        pytest.param(lambda c: c.routing.record_outcome({"provider": Provider.PAYU, "kind": "payment", "result": "success", "at": "2026-11-17T10:00:00"}), id="outcome-naive-time"),
        pytest.param(lambda c: c.purchases.start({**PURCHASE_INPUT, "platform": "watchos"}), id="start-unknown-platform"),
        pytest.param(lambda c: c.purchases.start({**PURCHASE_INPUT, "reference": "has spaces"}), id="start-reference-not-allowed"),
        pytest.param(lambda c: c.purchases.start({**PURCHASE_INPUT, "reference": "r" * 26}), id="start-reference-too-long"),
        pytest.param(lambda c: c.purchases.start({"platform": Platform.WEB, "product": "p", "customer": {}}), id="start-missing-customer-ref"),
        pytest.param(lambda c: c.purchases.start({**PURCHASE_INPUT, "custmer": {}}), id="start-typo"),
        pytest.param(lambda c: c.purchases.choose_alternative(SESSION_ID, ""), id="alternative-empty-token"),
        pytest.param(lambda c: c.purchases.complete(SESSION_ID, "stripe", {}), id="complete-unknown-provider"),
        pytest.param(lambda c: c.purchases.flush({"limit": 0}), id="flush-limit-zero"),
        pytest.param(lambda c: c.purchases.flush({"limit": 501}), id="flush-limit-too-large"),
        pytest.param(lambda c: c.purchases.flush({"limt": 5}), id="flush-typo"),
    ],
)
async def test_a_bad_input_fails_before_any_request(kind: ClientKind, call: Call) -> None:
    recorder = Recorder(json_response(200, {}))

    with pytest.raises((ValidationError, ValueError)):
        await run(kind, recorder, call)

    assert recorder.requests == []


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
@pytest.mark.parametrize(
    "call",
    [
        pytest.param(lambda c: c.payments.get(Provider.RAZORPAY, ""), id="payment-id"),
        pytest.param(lambda c: c.purchases.get(""), id="session-id"),
        pytest.param(lambda c: c.purchases.choose_alternative("", "token_1"), id="session-id-alternative"),
        pytest.param(lambda c: c.purchases.complete("", Provider.GOOGLE_PLAY, {}), id="session-id-complete"),
        pytest.param(lambda c: c.entitlements.get(""), id="customer-ref"),
    ],
)
async def test_an_empty_id_is_refused(kind: ClientKind, call: Call) -> None:
    recorder = Recorder(json_response(200, {}))

    with pytest.raises(ValueError, match="must not be empty"):
        await run(kind, recorder, call)

    assert recorder.requests == []


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
async def test_an_unknown_provider_is_refused_for_a_payment(kind: ClientKind) -> None:
    recorder = Recorder(json_response(200, PAYMENT_JSON))

    with pytest.raises(ValueError):
        await run(kind, recorder, lambda c: c.payments.get("stripe", PAYMENT_ID))

    assert recorder.requests == []


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
async def test_ids_are_percent_encoded_and_cannot_change_the_route(kind: ClientKind) -> None:
    hostile = "a/b c?d#e"
    encoded = "a%2Fb%20c%3Fd%23e"
    calls: List[Tuple[Call, Any, str]] = [
        (lambda c: c.payments.get(Provider.RAZORPAY, hostile), PAYMENT_JSON, ApiPath.PAYMENT.format(provider=Provider.RAZORPAY.value, paymentId=encoded)),
        (lambda c: c.purchases.get(hostile), PURCHASE_SESSION_JSON, ApiPath.PURCHASE.format(sessionId=encoded)),
        (lambda c: c.purchases.choose_alternative(hostile, "t"), PURCHASE_SESSION_JSON, ApiPath.PURCHASE_ALTERNATIVE.format(sessionId=encoded)),
        (lambda c: c.purchases.complete(hostile, Provider.GOOGLE_PLAY, {}), PURCHASE_SESSION_JSON, ApiPath.PURCHASE_COMPLETE.format(sessionId=encoded)),
        (lambda c: c.entitlements.get(hostile), ENTITLEMENTS_JSON, ApiPath.ENTITLEMENTS.format(customerRef=encoded)),
    ]
    for call, body, expected in calls:
        recorder = Recorder(json_response(200, body))

        await run(kind, recorder, call)

        assert recorder.last.url.raw_path == expected.encode()


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
async def test_the_expected_payment_id_is_sent_only_when_given(kind: ClientKind) -> None:
    recorder = Recorder(json_response(200, PAYMENT_VERIFICATION_JSON))

    await run(kind, recorder, lambda c: c.payments.verify(Provider.RAZORPAY, GATEWAY_RESULT))
    assert json.loads(recorder.last.content) == {"result": GATEWAY_RESULT}

    await run(kind, recorder, lambda c: c.payments.verify(Provider.RAZORPAY, GATEWAY_RESULT, "order_9"))
    assert json.loads(recorder.last.content) == {"result": GATEWAY_RESULT, "expectedPaymentId": "order_9"}


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
async def test_a_checkout_result_is_forwarded_untouched(kind: ClientKind) -> None:
    result = {**GATEWAY_RESULT, "nested": {"a": [1, None, "x"], "empty": ""}, "unicode": "₹499"}

    verify = Recorder(json_response(200, PAYMENT_VERIFICATION_JSON))
    await run(kind, verify, lambda c: c.payments.verify(Provider.RAZORPAY, result))
    assert json.loads(verify.last.content) == {"result": result}

    complete = Recorder(json_response(200, PURCHASE_SESSION_JSON))
    await run(kind, complete, lambda c: c.purchases.complete(SESSION_ID, Provider.RAZORPAY, result))
    assert json.loads(complete.last.content) == {"provider": Provider.RAZORPAY.value, "result": result}


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
async def test_only_what_the_caller_set_is_sent(kind: ClientKind) -> None:
    payment = Recorder(json_response(201, PAYMENT_JSON))
    await run(kind, payment, lambda c: c.payments.create(Provider.RAZORPAY, PAYMENT_INPUT))
    assert json.loads(payment.last.content) == {"amount": 29900, "customer": {"name": "Asha", "email": "asha@example.com"}}

    route = Recorder(json_response(200, ROUTING_DECISION_JSON))
    await run(kind, route, lambda c: c.routing.decide(ROUTE_INPUT))
    assert json.loads(route.last.content) == {"kind": ProductKind.ONE_TIME.value, "amount": 29900}


@pytest.mark.parametrize("kind", BOTH_KINDS, ids=lambda kind: kind.value)
async def test_the_requests_use_the_service_base_url_and_the_documented_methods(kind: ClientKind) -> None:
    for _, call, success in ALL:
        recorder = Recorder(json_response(200, success))

        await run(kind, recorder, call)

        assert str(recorder.last.url).startswith(BASE_URL)


def test_the_purchase_input_models_are_exported() -> None:
    import india_subscriptions as package

    for name in (
        "CreatePaymentInput",
        "RefundPaymentInput",
        "VerifyPaymentInput",
        "RouteRequest",
        "RouteOutcome",
        "StartPurchaseInput",
        "CompletePurchaseInput",
        "ChooseAlternativeInput",
        "FlushOptions",
        "Payment",
        "PaymentVerification",
        "RoutingDecision",
        "PurchaseSession",
        "Entitlements",
        "FlushResult",
        "Platform",
        "ChannelPolicy",
        "ProductKind",
    ):
        assert name in package.__all__
        assert getattr(package, name) is getattr(package.models, name)

