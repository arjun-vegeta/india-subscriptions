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
    ChannelPolicy,
    CheckoutVerification,
    CreatePlanInput,
    Currency,
    Entitlements,
    EventType,
    FlushResult,
    Health,
    NotifyChargeInput,
    PauseSubscriptionOptions,
    Payment,
    PaymentMethod,
    PaymentStatus,
    PaymentVerification,
    Plan,
    Platform,
    ProductKind,
    Provider,
    PurchaseSession,
    Refund,
    RefundStatus,
    RouteOutcomeKind,
    RouteOutcomeResult,
    RoutingDecision,
    RoutingReceipt,
    SalesChannel,
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
    IntervalUnit,
    CancelMode,
    ChangeTiming,
    CashfreeCheckout,
    EntitlementStatus,
    GooglePlayBillingCheckout,
    RazorpayCheckout,
    ReportKind,
    HealthStatus,
    OpenApiDocument,
    RouteExclusion,
    SessionStatus,
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
    "interval": {"unit": IntervalUnit.MONTH.value, "count": 1},
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
    "kind": "gateway",
    "cancel": True,
    "oneTimePayments": False,
    "oneTimePaymentMethods": [],
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

PAYMENT_ID = "pay_one_1"
SESSION_ID = "ps_0123456789abcdef0123456789abcdef"
CUSTOMER_REF = "cust_42"
PHONEPE = Provider.PHONEPE.value
PAYMENT_JSON = {
    "provider": RAZORPAY,
    "id": PAYMENT_ID,
    "reference": "order_77",
    "status": PaymentStatus.SUCCEEDED.value,
    "providerStatus": "captured",
    "amount": 29900,
    "currency": Currency.INR.value,
    "paymentMethod": PaymentMethod.UPI.value,
    "paidAt": "2026-11-17T10:31:00Z",
    "checkout": {"kind": "razorpay_checkout", "keyId": "rzp_test_1", "orderId": "order_1"},
    "raw": {"id": PAYMENT_ID},
}
PAYMENT_VERIFICATION_JSON = {
    "provider": RAZORPAY,
    "paymentId": PAYMENT_ID,
    "reference": "order_77",
    "paid": True,
    "status": PaymentStatus.SUCCEEDED.value,
    "raw": {},
}
PAYMENT_REFUND_JSON = {**REFUND_JSON, "chargeId": PAYMENT_ID, "paymentId": PAYMENT_ID}
ROUTING_DECISION_JSON = {
    "provider": CASHFREE,
    "ranked": [CASHFREE, RAZORPAY],
    "candidates": [
        {
            "provider": CASHFREE,
            "eligible": True,
            "exclusions": [],
            "score": 0.91,
            "factors": {"successRate": 0.97, "samples": 120, "cost": 590.0, "priority": 1.0, "healthy": True},
        },
        {"provider": RAZORPAY, "eligible": True, "exclusions": [], "score": 0.88},
        {
            "provider": PHONEPE,
            "eligible": False,
            "exclusions": [RouteExclusion.UNHEALTHY.value],
            "details": ["phonepe is on probation"],
        },
    ],
}
PURCHASE_SESSION_JSON = {
    "id": SESSION_ID,
    "platform": Platform.ANDROID.value,
    "product": "pro_monthly",
    "policy": ChannelPolicy.USER_CHOICE.value,
    "status": SessionStatus.OPEN.value,
    "customerRef": CUSTOMER_REF,
    "reference": "buy_1",
    "options": [
        {
            "channel": SalesChannel.STORE.value,
            "provider": Provider.GOOGLE_PLAY.value,
            "checkout": {
                "kind": "google_play_billing",
                "productKind": ProductKind.SUBSCRIPTION.value,
                "productId": "pro_monthly",
                "basePlanId": "monthly",
                "obfuscatedAccountId": "acct_abc",
                "userChoiceBilling": True,
            },
            "handle": "sub_g1",
        }
    ],
    "attempts": [],
    "createdAt": "2026-11-17T10:30:00Z",
    "expiresAt": "2026-11-17T11:30:00Z",
}
PURCHASE_SESSION_WITH_ALTERNATIVE_JSON = {
    **PURCHASE_SESSION_JSON,
    "status": SessionStatus.AWAITING_PAYMENT.value,
    "externalTransactionToken": "token_1",
    "options": [
        *PURCHASE_SESSION_JSON["options"],
        {
            "channel": SalesChannel.GATEWAY.value,
            "provider": CASHFREE,
            "checkout": {"kind": "cashfree_checkout", "sessionId": "session_1", "environment": "test"},
            "handle": "sub_c1",
            "hostedUrl": "https://pay.example.test/checkout/ps_1",
        },
    ],
}
PURCHASE_SESSION_COMPLETED_JSON = {
    **PURCHASE_SESSION_JSON,
    "status": SessionStatus.COMPLETED.value,
    "completedAt": "2026-11-17T10:40:00Z",
    "subscriptionId": "sub_g1",
    "provider": Provider.GOOGLE_PLAY.value,
}
FLUSH_RESULT_JSON = {
    "sent": 2,
    "retrying": 1,
    "blocked": 0,
    "rejected": 0,
    "skipped": 0,
    "entries": [],
    "overdue": [
        {
            "id": "rep_1",
            "kind": "transaction",
            "attempts": 3,
            "dueBy": "2026-11-17T09:00:00Z",
            "overdue": True,
            "errorCode": "PROVIDER_ERROR",
        }
    ],
}
ENTITLEMENTS_JSON = {
    "customerRef": CUSTOMER_REF,
    "active": True,
    "items": [
        {
            "product": "pro_monthly",
            "kind": ProductKind.SUBSCRIPTION.value,
            "provider": Provider.GOOGLE_PLAY.value,
            "channel": SalesChannel.STORE.value,
            "platform": Platform.ANDROID.value,
            "subscriptionId": "sub_g1",
            "status": "active",
            "active": True,
            "cancelAtPeriodEnd": False,
            "currentPeriodEnd": "2026-12-17T10:30:00Z",
            "updatedAt": "2026-11-17T10:40:00Z",
        }
    ],
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
    assert result.interval == BillingInterval(unit=IntervalUnit.MONTH, count=1)
    assert result.created_at == datetime(2026, 11, 17, 10, 30, tzinfo=timezone.utc)


def _check_subscription(result: Any) -> None:
    assert isinstance(result, Subscription)
    assert result.id == SUBSCRIPTION_ID
    assert result.status is SubscriptionStatus.TRIALING
    assert result.provider_status == "authenticated"
    assert result.trial_ends_at == datetime(2026, 12, 1, 10, 30, tzinfo=IST)
    assert isinstance(result.checkout, RazorpayCheckout)
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


def _check_payment(result: Any) -> None:
    assert isinstance(result, Payment)
    assert result.provider is Provider.RAZORPAY
    assert result.id == PAYMENT_ID
    assert result.status is PaymentStatus.SUCCEEDED
    assert result.amount == 29900
    assert result.payment_method is PaymentMethod.UPI
    assert result.paid_at == datetime(2026, 11, 17, 10, 31, tzinfo=timezone.utc)
    assert isinstance(result.checkout, RazorpayCheckout)
    assert result.checkout.order_id == "order_1"


def _check_payment_verification(result: Any) -> None:
    assert isinstance(result, PaymentVerification)
    assert result.paid is True
    assert result.payment_id == PAYMENT_ID
    assert result.status is PaymentStatus.SUCCEEDED


def _check_payment_refund(result: Any) -> None:
    assert isinstance(result, Refund)
    assert result.status is RefundStatus.SUCCEEDED
    assert result.charge_id == PAYMENT_ID
    assert result.amount == 1000


def _check_decision(result: Any) -> None:
    assert isinstance(result, RoutingDecision)
    assert result.provider is Provider.CASHFREE
    assert result.ranked == [Provider.CASHFREE, Provider.RAZORPAY]
    assert [candidate.eligible for candidate in result.candidates] == [True, True, False]
    assert result.candidates[0].factors is not None and result.candidates[0].factors.samples == 120
    assert result.candidates[2].exclusions == [RouteExclusion.UNHEALTHY]


def _check_routing_receipt(result: Any) -> None:
    assert isinstance(result, RoutingReceipt)
    assert result.recorded is True


def _check_session(result: Any) -> None:
    assert isinstance(result, PurchaseSession)
    assert result.id == SESSION_ID
    assert result.platform is Platform.ANDROID
    assert result.policy is ChannelPolicy.USER_CHOICE
    assert result.status is SessionStatus.OPEN
    assert [option.channel for option in result.options] == [SalesChannel.STORE]
    assert isinstance(result.options[0].checkout, GooglePlayBillingCheckout)
    assert result.options[0].checkout.user_choice_billing is True
    assert result.options[0].checkout.product_kind is ProductKind.SUBSCRIPTION
    assert result.expires_at == datetime(2026, 11, 17, 11, 30, tzinfo=timezone.utc)


def _check_session_with_alternative(result: Any) -> None:
    assert isinstance(result, PurchaseSession)
    assert result.status is SessionStatus.AWAITING_PAYMENT
    assert result.external_transaction_token == "token_1"
    assert [option.channel for option in result.options] == [SalesChannel.STORE, SalesChannel.GATEWAY]
    assert str(result.options[1].hosted_url) == "https://pay.example.test/checkout/ps_1"
    assert isinstance(result.options[1].checkout, CashfreeCheckout)


def _check_completed_session(result: Any) -> None:
    assert isinstance(result, PurchaseSession)
    assert result.status is SessionStatus.COMPLETED
    assert result.provider is Provider.GOOGLE_PLAY
    assert result.subscription_id == "sub_g1"
    assert result.completed_at == datetime(2026, 11, 17, 10, 40, tzinfo=timezone.utc)


def _check_flush(result: Any) -> None:
    assert isinstance(result, FlushResult)
    assert (result.sent, result.retrying, result.rejected) == (2, 1, 0)
    assert len(result.overdue) == 1
    assert result.overdue[0].overdue is True
    assert result.overdue[0].kind is ReportKind.TRANSACTION


def _check_entitlements(result: Any) -> None:
    assert isinstance(result, Entitlements)
    assert result.customer_ref == CUSTOMER_REF
    assert result.active is True
    assert result.items[0].provider is Provider.GOOGLE_PLAY
    assert result.items[0].status is EntitlementStatus.ACTIVE
    assert result.items[0].current_period_end == datetime(2026, 12, 17, 10, 30, tzinfo=timezone.utc)


VERIFICATION_JSON = {"provider": RAZORPAY, "subscriptionId": SUBSCRIPTION_ID, "authorized": True, "raw": {}}
PURCHASE_TOKEN_RESULT = {"purchaseToken": "tok_123", "productId": "pro_monthly", "orderId": None}
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
                interval=BillingInterval(unit=IntervalUnit.MONTH, count=1),
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
            "interval": {"unit": IntervalUnit.MONTH.value, "count": 1},
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
            {"quantity": 2, "timing": ChangeTiming.AT_PERIOD_END},
        ),
        _path(ApiPath.SUBSCRIPTION, provider=RAZORPAY, subscriptionId=SUBSCRIPTION_ID),
        200,
        SUBSCRIPTION_JSON,
        _check_subscription,
        method=HttpMethod.PATCH,
        body={"quantity": 2, "timing": ChangeTiming.AT_PERIOD_END.value},
    ),
    Case(
        OperationId.CANCEL_SUBSCRIPTION,
        lambda c: c.subscriptions.cancel(
            Provider.RAZORPAY,
            SUBSCRIPTION_ID,
            CancelSubscriptionOptions(mode=CancelMode.AT_PERIOD_END),
        ),
        _path(ApiPath.SUBSCRIPTION_CANCEL, provider=RAZORPAY, subscriptionId=SUBSCRIPTION_ID),
        200,
        SUBSCRIPTION_JSON,
        _check_subscription,
        body={"mode": CancelMode.AT_PERIOD_END.value},
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
        lambda c: c.checkout.verify(Provider.RAZORPAY, GATEWAY_RESULT, expected_subscription_id=SUBSCRIPTION_ID),
        _path(ApiPath.CHECKOUT_VERIFY, provider=RAZORPAY),
        200,
        VERIFICATION_JSON,
        _check_verification,
        body={"result": GATEWAY_RESULT, "expectedSubscriptionId": SUBSCRIPTION_ID},
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
    Case(
        OperationId.CREATE_PAYMENT,
        lambda c: c.payments.create(
            Provider.RAZORPAY,
            {
                "reference": "order_77",
                "amount": 29900,
                "customer": {"name": "Asha", "email": "asha@example.com", "phone": "9876543210", "state": "Karnataka"},
                "payment_methods": [PaymentMethod.UPI, PaymentMethod.NETBANKING],
                "returnUrl": "https://shop.example.com/return",
                "store_product": {"productId": "coins_100", "consumable": True},
            },
        ),
        _path(ApiPath.PAYMENTS, provider=RAZORPAY),
        201,
        PAYMENT_JSON,
        _check_payment,
        body={
            "reference": "order_77",
            "amount": 29900,
            "customer": {"name": "Asha", "email": "asha@example.com", "phone": "9876543210", "state": "Karnataka"},
            "paymentMethods": [PaymentMethod.UPI.value, PaymentMethod.NETBANKING.value],
            "returnUrl": "https://shop.example.com/return",
            "storeProduct": {"productId": "coins_100", "consumable": True},
        },
    ),
    Case(
        OperationId.GET_PAYMENT,
        lambda c: c.payments.get(Provider.RAZORPAY, PAYMENT_ID),
        _path(ApiPath.PAYMENT, provider=RAZORPAY, paymentId=PAYMENT_ID),
        200,
        PAYMENT_JSON,
        _check_payment,
    ),
    Case(
        OperationId.VERIFY_PAYMENT,
        lambda c: c.payments.verify(Provider.RAZORPAY, GATEWAY_RESULT, expected_payment_id="order_77"),
        _path(ApiPath.PAYMENT_VERIFY, provider=RAZORPAY),
        200,
        PAYMENT_VERIFICATION_JSON,
        _check_payment_verification,
        body={"result": GATEWAY_RESULT, "expectedPaymentId": "order_77"},
    ),
    Case(
        OperationId.CREATE_PAYMENT_REFUND,
        lambda c: c.payments.refund(
            Provider.RAZORPAY, {"paymentId": PAYMENT_ID, "refundId": "rf_1", "amount": 1000, "reason": "duplicate"}
        ),
        _path(ApiPath.PAYMENT_REFUNDS, provider=RAZORPAY),
        201,
        PAYMENT_REFUND_JSON,
        _check_payment_refund,
        body={"paymentId": PAYMENT_ID, "refundId": "rf_1", "amount": 1000, "reason": "duplicate"},
    ),
    Case(
        OperationId.DECIDE_ROUTE,
        lambda c: c.routing.decide(
            {
                "kind": ProductKind.ONE_TIME,
                "amount": 29900,
                "payment_methods": [PaymentMethod.UPI],
                "needs": {"refunds": True},
                "exclude": [Provider.PAYU],
                "prefer": Provider.CASHFREE,
            }
        ),
        ApiPath.ROUTING_DECIDE,
        200,
        ROUTING_DECISION_JSON,
        _check_decision,
        body={
            "kind": ProductKind.ONE_TIME.value,
            "amount": 29900,
            "paymentMethods": [PaymentMethod.UPI.value],
            "needs": {"refunds": True},
            "exclude": [Provider.PAYU.value],
            "prefer": CASHFREE,
        },
    ),
    Case(
        OperationId.RECORD_ROUTE_OUTCOME,
        lambda c: c.routing.record_outcome(
            {
                "provider": Provider.CASHFREE,
                "kind": RouteOutcomeKind.PAYMENT,
                "result": RouteOutcomeResult.FAILURE,
                "payment_method": PaymentMethod.UPI,
                "at": datetime(2026, 11, 17, 10, 0, tzinfo=IST),
            }
        ),
        ApiPath.ROUTING_OUTCOMES,
        200,
        {"recorded": True},
        _check_routing_receipt,
        body={
            "provider": CASHFREE,
            "kind": RouteOutcomeKind.PAYMENT.value,
            "result": RouteOutcomeResult.FAILURE.value,
            "paymentMethod": PaymentMethod.UPI.value,
            "at": "2026-11-17T10:00:00+05:30",
        },
    ),
    Case(
        OperationId.START_PURCHASE,
        lambda c: c.purchases.start(
            {
                "platform": Platform.ANDROID,
                "product": "pro_monthly",
                "customer": {"name": "Asha", "email": "asha@example.com", "state": "Karnataka"},
                "customer_ref": CUSTOMER_REF,
                "reference": "buy_1",
                "returnUrl": "myapp://done",
            }
        ),
        ApiPath.PURCHASES,
        201,
        PURCHASE_SESSION_JSON,
        _check_session,
        body={
            "platform": Platform.ANDROID.value,
            "product": "pro_monthly",
            "customer": {"name": "Asha", "email": "asha@example.com", "state": "Karnataka"},
            "customerRef": CUSTOMER_REF,
            "reference": "buy_1",
            "returnUrl": "myapp://done",
        },
    ),
    Case(
        OperationId.GET_PURCHASE,
        lambda c: c.purchases.get(SESSION_ID),
        _path(ApiPath.PURCHASE, sessionId=SESSION_ID),
        200,
        PURCHASE_SESSION_JSON,
        _check_session,
    ),
    Case(
        OperationId.CHOOSE_ALTERNATIVE,
        lambda c: c.purchases.choose_alternative(SESSION_ID, "token_1"),
        _path(ApiPath.PURCHASE_ALTERNATIVE, sessionId=SESSION_ID),
        200,
        PURCHASE_SESSION_WITH_ALTERNATIVE_JSON,
        _check_session_with_alternative,
        body={"externalTransactionToken": "token_1"},
    ),
    Case(
        OperationId.COMPLETE_PURCHASE,
        lambda c: c.purchases.complete(SESSION_ID, Provider.GOOGLE_PLAY, PURCHASE_TOKEN_RESULT),
        _path(ApiPath.PURCHASE_COMPLETE, sessionId=SESSION_ID),
        200,
        PURCHASE_SESSION_COMPLETED_JSON,
        _check_completed_session,
        body={"provider": Provider.GOOGLE_PLAY.value, "result": PURCHASE_TOKEN_RESULT},
    ),
    Case(
        OperationId.FLUSH_PURCHASE_REPORTS,
        lambda c: c.purchases.flush({"limit": 100}),
        ApiPath.PURCHASES_FLUSH,
        200,
        FLUSH_RESULT_JSON,
        _check_flush,
        body={"limit": 100},
    ),
    Case(
        OperationId.GET_ENTITLEMENTS,
        lambda c: c.entitlements.get(CUSTOMER_REF),
        _path(ApiPath.ENTITLEMENTS, customerRef=CUSTOMER_REF),
        200,
        ENTITLEMENTS_JSON,
        _check_entitlements,
    ),
]

# Request-shape variants that are not an operation of their own.
EMPTY_BODY_OPERATIONS = [
    (OperationId.CANCEL_SUBSCRIPTION, lambda c: c.subscriptions.cancel(Provider.RAZORPAY, SUBSCRIPTION_ID)),
    (OperationId.PAUSE_SUBSCRIPTION, lambda c: c.subscriptions.pause(Provider.RAZORPAY, SUBSCRIPTION_ID)),
    (OperationId.RESUME_SUBSCRIPTION, lambda c: c.subscriptions.resume(Provider.RAZORPAY, SUBSCRIPTION_ID)),
    (OperationId.RUN_SCHEDULER_TICK, lambda c: c.scheduler.tick()),
    (OperationId.FLUSH_PURCHASE_REPORTS, lambda c: c.purchases.flush()),
]


def case_id(case: Case) -> str:
    return case.operation.value


def parsed(content: bytes) -> Any:
    return json.loads(content)
