"""One case per operation: the call, the exact request it must make, and the model it must return.

Used by the unit tests and by the contract test, so the requests the client really makes are the
ones checked against ``openapi.json``.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional

from india_subscriptions import (
    CancelSubscriptionOptions,
    Capabilities,
    Charge,
    ChargeNotification,
    ChargeKind,
    ChargeStatus,
    CheckoutVerification,
    CreatePlanInput,
    Currency,
    EventType,
    Health,
    NotifyChargeInput,
    PauseSubscriptionOptions,
    Plan,
    Provider,
    Refund,
    RefundStatus,
    SchedulingMode,
    Subscription,
    SubscriptionEvent,
    SubscriptionStatus,
    TickResult,
    WebhookReceipt,
)
from india_subscriptions.constants import ApiPath, AuthMode, ContentType, HttpMethod, OperationId, PathParam, QueryParam
from india_subscriptions.models import (
    BillingInterval,
    BillingIntervalUnit,
    CancelSubscriptionOptionsMode,
    CheckoutInstructionCheckoutInstructionRazorpayCheckout,
    HealthStatus,
    OpenApiDocument,
)

SUBSCRIPTION_ID = "sub_1"
PLAN_ID = "plan_1"
CHARGE_ID = "pay_1"
IST = timezone(timedelta(hours=5, minutes=30))

RAZORPAY = Provider.RAZORPAY.value
CASHFREE = Provider.CASHFREE.value

PLAN_JSON = {
    "provider": RAZORPAY,
    "id": PLAN_ID,
    "name": "Gold",
    "amount": 49900,
    "currency": Currency.INR.value,
    "interval": {"unit": BillingIntervalUnit.MONTH.value, "count": 1},
    "scheduling": SchedulingMode.GATEWAY.value,
    "maxAmount": 60000,
    "createdAt": "2026-11-17T10:30:00Z",
    "raw": {"id": PLAN_ID},
}
SUBSCRIPTION_JSON = {
    "provider": RAZORPAY,
    "id": SUBSCRIPTION_ID,
    "status": SubscriptionStatus.TRIALING.value,
    "providerStatus": "authenticated",
    "scheduling": SchedulingMode.GATEWAY.value,
    "trialEndsAt": "2026-12-01T10:30:00+05:30",
    "checkout": {"kind": "razorpay_checkout", "keyId": "rzp_test_1", "subscriptionId": SUBSCRIPTION_ID},
    "raw": None,
}
CHARGE_JSON = {
    "provider": RAZORPAY,
    "id": CHARGE_ID,
    "subscriptionId": SUBSCRIPTION_ID,
    "kind": ChargeKind.RECURRING.value,
    "status": ChargeStatus.SUCCEEDED.value,
    "amount": 49900,
    "raw": {},
}
CAPABILITIES_JSON = {
    "provider": CASHFREE,
    "scheduling": [SchedulingMode.MERCHANT.value],
    "gatewayPlans": False,
    "trial": True,
    "upfrontAmount": False,
    "quantity": False,
    "pause": False,
    "resume": False,
    "cancelAtPeriodEnd": False,
    "changePlan": False,
    "merchantCharges": True,
    "merchantPreDebitNotification": True,
    "merchantChargeLeadHours": 24,
    "listCharges": True,
    "refunds": True,
    "signedWebhooks": True,
    "idempotencyKeys": False,
    "paymentMethods": [],
}
REFUND_JSON = {
    "provider": RAZORPAY,
    "id": "rf_1",
    "chargeId": CHARGE_ID,
    "status": RefundStatus.SUCCEEDED.value,
    "amount": 1000,
    "raw": {},
}
EVENT_JSON = {
    "id": "evt_1",
    "provider": RAZORPAY,
    "type": EventType.SUBSCRIPTION_CHARGED.value,
    "providerEventType": "subscription.charged",
    "subscriptionId": SUBSCRIPTION_ID,
    "raw": {},
}
HEALTH_JSON = {"status": HealthStatus.OK.value, "providers": [RAZORPAY, CASHFREE]}
TICK_JSON = {
    "at": "2026-11-17T10:00:00Z",
    "due": 3,
    "locked": 0,
    "notified": 1,
    "charged": 2,
    "reconciled": 0,
    "succeeded": 2,
    "failed": 0,
    "awaiting": 0,
    "completed": 0,
    "halted": 0,
    "expired": 0,
    "errors": [],
}

WEBHOOK_BODY = '{"event": "subscription.charged",  "id":"evt_1"}\r\n'
WEBHOOK_SIGNATURE_HEADER = "x-test-signature"


@dataclass
class Case:
    operation: OperationId
    call: Callable[[Any], Any]
    path: str
    status: int
    response: Any
    check: Callable[[Any], None]
    method: Optional[HttpMethod] = None
    body: Any = None
    """Expected JSON body; ``None`` means the request must carry no body."""
    raw_body: Optional[bytes] = None
    query: Dict[str, str] = field(default_factory=dict)
    sends_auth: bool = True
    headers: Dict[str, str] = field(default_factory=dict)
    """Headers the request must carry (name lower case)."""


def _path(template: str, **params: str) -> str:
    return template.format(**params)


def _check_health(result: Any) -> None:
    assert isinstance(result, Health)
    assert result.status is HealthStatus.OK
    assert result.providers == [Provider.RAZORPAY, Provider.CASHFREE]


def _check_openapi(result: Any) -> None:
    assert isinstance(result, OpenApiDocument)
    assert result.openapi == "3.1.0"
    assert result.model_extra is not None and "paths" in result.model_extra


def _check_providers(result: Any) -> None:
    assert isinstance(result, list) and len(result) == 1
    assert isinstance(result[0], Capabilities)
    assert result[0].provider is Provider.CASHFREE
    assert result[0].scheduling == [SchedulingMode.MERCHANT]
    assert result[0].merchant_charge_lead_hours == 24


def _check_plan(result: Any) -> None:
    assert isinstance(result, Plan)
    assert result.provider is Provider.RAZORPAY
    assert result.id == PLAN_ID
    assert result.amount == 49900
    assert result.currency is Currency.INR
    assert result.max_amount == 60000
    assert result.interval == BillingInterval(unit=BillingIntervalUnit.MONTH, count=1)
    assert result.created_at == datetime(2026, 11, 17, 10, 30, tzinfo=timezone.utc)


def _check_subscription(result: Any) -> None:
    assert isinstance(result, Subscription)
    assert result.id == SUBSCRIPTION_ID
    assert result.status is SubscriptionStatus.TRIALING
    assert result.provider_status == "authenticated"
    assert result.trial_ends_at == datetime(2026, 12, 1, 10, 30, tzinfo=IST)
    assert isinstance(result.checkout, CheckoutInstructionCheckoutInstructionRazorpayCheckout)
    assert result.checkout.key_id == "rzp_test_1"


def _check_charge(result: Any) -> None:
    assert isinstance(result, Charge)
    assert result.id == CHARGE_ID
    assert result.kind is ChargeKind.RECURRING
    assert result.status is ChargeStatus.SUCCEEDED


def _check_charges(result: Any) -> None:
    assert isinstance(result, list) and len(result) == 1
    _check_charge(result[0])


def _check_notification(result: Any) -> None:
    assert isinstance(result, ChargeNotification)
    assert result.accepted is True
    assert result.debit_at == datetime(2026, 12, 1, 10, 0, tzinfo=IST)


def _check_refund(result: Any) -> None:
    assert isinstance(result, Refund)
    assert result.status is RefundStatus.SUCCEEDED
    assert result.charge_id == CHARGE_ID


def _check_verification(result: Any) -> None:
    assert isinstance(result, CheckoutVerification)
    assert result.authorized is True
    assert result.subscription_id == SUBSCRIPTION_ID


def _check_events(result: Any) -> None:
    assert isinstance(result, list) and len(result) == 1
    assert isinstance(result[0], SubscriptionEvent)
    assert result[0].type is EventType.SUBSCRIPTION_CHARGED
    assert result[0].subscription_id == SUBSCRIPTION_ID


def _check_receipt(result: Any) -> None:
    assert isinstance(result, WebhookReceipt)
    assert result.received == 1


def _check_tick(result: Any) -> None:
    assert isinstance(result, TickResult)
    assert (result.due, result.charged, result.errors) == (3, 2, [])


VERIFICATION_JSON = {"provider": RAZORPAY, "subscriptionId": SUBSCRIPTION_ID, "authorized": True, "raw": {}}
GATEWAY_RESULT = {"razorpay_payment_id": "pay_1", "razorpay_subscription_id": SUBSCRIPTION_ID, "extra": None, "n": 1}

CASES: List[Case] = [
    Case(
        OperationId.GET_HEALTH,
        lambda c: c.health(),
        ApiPath.HEALTH,
        200,
        HEALTH_JSON,
        _check_health,
        sends_auth=False,
    ),
    Case(
        OperationId.GET_OPENAPI,
        lambda c: c.openapi(),
        ApiPath.OPENAPI,
        200,
        {"openapi": "3.1.0", "paths": {}},
        _check_openapi,
        sends_auth=False,
    ),
    Case(
        OperationId.LIST_PROVIDERS,
        lambda c: c.providers(),
        ApiPath.PROVIDERS,
        200,
        [CAPABILITIES_JSON],
        _check_providers,
    ),
    Case(
        OperationId.GET_CAPABILITIES,
        lambda c: c.capabilities(Provider.CASHFREE),
        _path(ApiPath.CAPABILITIES, provider=CASHFREE),
        200,
        CAPABILITIES_JSON,
        lambda r: _check_providers([r]),
    ),
    Case(
        OperationId.CREATE_PLAN,
        lambda c: c.plans.create(
            Provider.RAZORPAY,
            CreatePlanInput(
                name="Gold",
                amount=49900,
                interval=BillingInterval(unit=BillingIntervalUnit.MONTH, count=1),
                max_amount=60000,
            ),
        ),
        _path(ApiPath.PLANS, provider=RAZORPAY),
        201,
        PLAN_JSON,
        _check_plan,
        body={
            "name": "Gold",
            "amount": 49900,
            "interval": {"unit": BillingIntervalUnit.MONTH.value, "count": 1},
            "maxAmount": 60000,
        },
    ),
    Case(
        OperationId.GET_PLAN,
        lambda c: c.plans.get(Provider.RAZORPAY, PLAN_ID),
        _path(ApiPath.PLAN, provider=RAZORPAY, planId=PLAN_ID),
        200,
        PLAN_JSON,
        _check_plan,
    ),
    Case(
        OperationId.CREATE_SUBSCRIPTION,
        # A plain dict, mixing the JSON names and the snake_case names, validated into the model.
        lambda c: c.subscriptions.create(
            Provider.RAZORPAY,
            {
                "plan": PLAN_ID,
                "customer": {"name": "Asha", "email": "asha@example.com", "phone": "9876543210"},
                "trial": {"days": 14},
                "totalCycles": 12,
                "notify_customer": True,
            },
        ),
        _path(ApiPath.SUBSCRIPTIONS, provider=RAZORPAY),
        201,
        SUBSCRIPTION_JSON,
        _check_subscription,
        body={
            "plan": PLAN_ID,
            "customer": {"name": "Asha", "email": "asha@example.com", "phone": "9876543210"},
            "trial": {"days": 14},
            "totalCycles": 12,
            "notifyCustomer": True,
        },
    ),
    Case(
        OperationId.GET_SUBSCRIPTION,
        lambda c: c.subscriptions.get(Provider.RAZORPAY, SUBSCRIPTION_ID),
        _path(ApiPath.SUBSCRIPTION, provider=RAZORPAY, subscriptionId=SUBSCRIPTION_ID),
        200,
        SUBSCRIPTION_JSON,
        _check_subscription,
    ),
    Case(
        OperationId.UPDATE_SUBSCRIPTION,
        lambda c: c.subscriptions.update(
            Provider.RAZORPAY,
            SUBSCRIPTION_ID,
            {"quantity": 2, "timing": CancelSubscriptionOptionsMode.AT_PERIOD_END},
        ),
        _path(ApiPath.SUBSCRIPTION, provider=RAZORPAY, subscriptionId=SUBSCRIPTION_ID),
        200,
        SUBSCRIPTION_JSON,
        _check_subscription,
        method=HttpMethod.PATCH,
        body={"quantity": 2, "timing": CancelSubscriptionOptionsMode.AT_PERIOD_END.value},
    ),
    Case(
        OperationId.CANCEL_SUBSCRIPTION,
        lambda c: c.subscriptions.cancel(
            Provider.RAZORPAY,
            SUBSCRIPTION_ID,
            CancelSubscriptionOptions(mode=CancelSubscriptionOptionsMode.AT_PERIOD_END),
        ),
        _path(ApiPath.SUBSCRIPTION_CANCEL, provider=RAZORPAY, subscriptionId=SUBSCRIPTION_ID),
        200,
        SUBSCRIPTION_JSON,
        _check_subscription,
        body={"mode": CancelSubscriptionOptionsMode.AT_PERIOD_END.value},
    ),
    Case(
        OperationId.PAUSE_SUBSCRIPTION,
        lambda c: c.subscriptions.pause(
            Provider.RAZORPAY,
            SUBSCRIPTION_ID,
            PauseSubscriptionOptions(resume_at=datetime(2026, 12, 1, 10, 0, tzinfo=IST)),
        ),
        _path(ApiPath.SUBSCRIPTION_PAUSE, provider=RAZORPAY, subscriptionId=SUBSCRIPTION_ID),
        200,
        SUBSCRIPTION_JSON,
        _check_subscription,
        body={"resumeAt": "2026-12-01T10:00:00+05:30"},
    ),
    Case(
        OperationId.RESUME_SUBSCRIPTION,
        lambda c: c.subscriptions.resume(Provider.RAZORPAY, SUBSCRIPTION_ID),
        _path(ApiPath.SUBSCRIPTION_RESUME, provider=RAZORPAY, subscriptionId=SUBSCRIPTION_ID),
        200,
        SUBSCRIPTION_JSON,
        _check_subscription,
    ),
    Case(
        OperationId.LIST_CHARGES,
        lambda c: c.charges.list(Provider.RAZORPAY, SUBSCRIPTION_ID, {"limit": 5}),
        _path(ApiPath.SUBSCRIPTION_CHARGES, provider=RAZORPAY, subscriptionId=SUBSCRIPTION_ID),
        200,
        [CHARGE_JSON],
        _check_charges,
        query={QueryParam.LIMIT.value: "5"},
    ),
    Case(
        OperationId.GET_CHARGE,
        lambda c: c.charges.get(Provider.RAZORPAY, SUBSCRIPTION_ID, CHARGE_ID),
        _path(ApiPath.SUBSCRIPTION_CHARGE, provider=RAZORPAY, subscriptionId=SUBSCRIPTION_ID, chargeId=CHARGE_ID),
        200,
        CHARGE_JSON,
        _check_charge,
    ),
    Case(
        OperationId.CREATE_CHARGE,
        lambda c: c.charges.create(
            Provider.CASHFREE,
            {"subscriptionId": SUBSCRIPTION_ID, "chargeId": "chg_cycle_3", "amount": 49900, "invoiceNumber": "INV-3"},
        ),
        _path(ApiPath.CHARGES, provider=CASHFREE),
        201,
        CHARGE_JSON,
        _check_charge,
        body={"subscriptionId": SUBSCRIPTION_ID, "chargeId": "chg_cycle_3", "amount": 49900, "invoiceNumber": "INV-3"},
    ),
    Case(
        OperationId.NOTIFY_CHARGE,
        lambda c: c.charges.notify(
            Provider.CASHFREE,
            NotifyChargeInput(
                subscription_id=SUBSCRIPTION_ID,
                notification_id="note_1",
                amount=49900,
                debit_at=datetime(2026, 12, 1, 10, 0, tzinfo=IST),
            ),
        ),
        _path(ApiPath.CHARGE_NOTIFICATIONS, provider=CASHFREE),
        201,
        {
            "provider": CASHFREE,
            "id": "note_1",
            "subscriptionId": SUBSCRIPTION_ID,
            "accepted": True,
            "amount": 49900,
            "debitAt": "2026-12-01T10:00:00+05:30",
            "raw": {},
        },
        _check_notification,
        body={
            "subscriptionId": SUBSCRIPTION_ID,
            "notificationId": "note_1",
            "amount": 49900,
            "debitAt": "2026-12-01T10:00:00+05:30",
        },
    ),
    Case(
        OperationId.CREATE_REFUND,
        lambda c: c.charges.refund(
            Provider.RAZORPAY, {"chargeId": CHARGE_ID, "refundId": "rf_1", "amount": 1000, "reason": "duplicate"}
        ),
        _path(ApiPath.REFUNDS, provider=RAZORPAY),
        201,
        REFUND_JSON,
        _check_refund,
        body={"chargeId": CHARGE_ID, "refundId": "rf_1", "amount": 1000, "reason": "duplicate"},
    ),
    Case(
        OperationId.VERIFY_CHECKOUT,
        lambda c: c.checkout.verify(Provider.RAZORPAY, GATEWAY_RESULT),
        _path(ApiPath.CHECKOUT_VERIFY, provider=RAZORPAY),
        200,
        VERIFICATION_JSON,
        _check_verification,
        body=GATEWAY_RESULT,
    ),
    Case(
        OperationId.PARSE_WEBHOOK,
        lambda c: c.webhooks.parse(
            Provider.RAZORPAY, {"rawBody": WEBHOOK_BODY, "headers": {WEBHOOK_SIGNATURE_HEADER: "abc"}}
        ),
        _path(ApiPath.WEBHOOKS_PARSE, provider=RAZORPAY),
        200,
        [EVENT_JSON],
        _check_events,
        body={"rawBody": WEBHOOK_BODY, "headers": {WEBHOOK_SIGNATURE_HEADER: "abc"}},
    ),
    Case(
        OperationId.RECEIVE_WEBHOOK,
        lambda c: c.webhooks.receive(
            Provider.RAZORPAY,
            WEBHOOK_BODY.encode("utf-8"),
            {WEBHOOK_SIGNATURE_HEADER: "abc", "Content-Type": ContentType.JSON.value, "Authorization": "gateway"},
        ),
        _path(ApiPath.WEBHOOKS, provider=RAZORPAY),
        200,
        {"received": 1},
        _check_receipt,
        raw_body=WEBHOOK_BODY.encode("utf-8"),
        sends_auth=False,
        headers={WEBHOOK_SIGNATURE_HEADER: "abc"},
    ),
    Case(
        OperationId.RUN_SCHEDULER_TICK,
        lambda c: c.scheduler.tick({"limit": 10}),
        ApiPath.SCHEDULER_TICK,
        200,
        TICK_JSON,
        _check_tick,
        body={"limit": 10},
    ),
]

# Request-shape variants that are not an operation of their own.
EMPTY_BODY_OPERATIONS = [
    (OperationId.CANCEL_SUBSCRIPTION, lambda c: c.subscriptions.cancel(Provider.RAZORPAY, SUBSCRIPTION_ID)),
    (OperationId.PAUSE_SUBSCRIPTION, lambda c: c.subscriptions.pause(Provider.RAZORPAY, SUBSCRIPTION_ID)),
    (OperationId.RESUME_SUBSCRIPTION, lambda c: c.subscriptions.resume(Provider.RAZORPAY, SUBSCRIPTION_ID)),
    (OperationId.RUN_SCHEDULER_TICK, lambda c: c.scheduler.tick()),
]


def case_id(case: Case) -> str:
    return case.operation.value


def parsed(content: bytes) -> Any:
    return json.loads(content)
