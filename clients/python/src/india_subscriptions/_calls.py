"""One function per operation: arguments in, a fully specified ``Call`` out (no I/O).

The input models and the response types are the generated ones from ``models``; each ``*_input``
parameter also takes a plain ``dict`` (JSON names or snake_case names), validated into the model.
"""

from __future__ import annotations

from typing import Any, List, Mapping, Optional, Union

from pydantic import TypeAdapter

from ._core import Call, coerce, dump_keeping_nulls, dump_request
from .constants import OperationId, PathParam, QueryParam, ROUTES
from .models import (
    CancelSubscriptionOptions,
    Capabilities,
    Charge,
    ChargeNotification,
    CheckoutVerification,
    ChooseAlternativeInput,
    CompletePurchaseInput,
    CreateChargeInput,
    CreatePaymentInput,
    CreatePlanInput,
    CreateSubscriptionInput,
    Entitlements,
    FlushOptions,
    FlushResult,
    Health,
    ListChargesOptions,
    NotifyChargeInput,
    OpenApiDocument,
    PauseSubscriptionOptions,
    Payment,
    PaymentVerification,
    Plan,
    Provider,
    PurchaseSession,
    Refund,
    RefundInput,
    RefundPaymentInput,
    ResumeSubscriptionOptions,
    RouteOutcome,
    RouteRequest,
    RoutingDecision,
    RoutingReceipt,
    StartPurchaseInput,
    Subscription,
    SubscriptionEvent,
    TickRequest,
    TickResult,
    UpdateSubscriptionInput,
    VerifyCheckoutInput,
    VerifyPaymentInput,
    WebhookReceipt,
    WebhookRequest,
)

Input = Mapping[str, Any]

_HEALTH = TypeAdapter(Health)
_OPENAPI = TypeAdapter(OpenApiDocument)
_CAPABILITIES = TypeAdapter(Capabilities)
_CAPABILITIES_LIST = TypeAdapter(List[Capabilities])
_PLAN = TypeAdapter(Plan)
_SUBSCRIPTION = TypeAdapter(Subscription)
_CHARGE = TypeAdapter(Charge)
_CHARGE_LIST = TypeAdapter(List[Charge])
_NOTIFICATION = TypeAdapter(ChargeNotification)
_REFUND = TypeAdapter(Refund)
_VERIFICATION = TypeAdapter(CheckoutVerification)
_EVENT_LIST = TypeAdapter(List[SubscriptionEvent])
_RECEIPT = TypeAdapter(WebhookReceipt)
_TICK = TypeAdapter(TickResult)
_PAYMENT = TypeAdapter(Payment)
_PAYMENT_VERIFICATION = TypeAdapter(PaymentVerification)
_DECISION = TypeAdapter(RoutingDecision)
_ROUTING_RECEIPT = TypeAdapter(RoutingReceipt)
_PURCHASE = TypeAdapter(PurchaseSession)
_FLUSH = TypeAdapter(FlushResult)
_ENTITLEMENTS = TypeAdapter(Entitlements)


def _provider(provider: Provider) -> Mapping[PathParam, str]:
    # Provider(...) also rejects an unknown name before any request is made.
    return {PathParam.PROVIDER: Provider(provider).value}


def _provider_and(provider: Provider, name: PathParam, value: str) -> Mapping[PathParam, str]:
    return {PathParam.PROVIDER: Provider(provider).value, name: value}


def _subscription_path(provider: Provider, subscription_id: str) -> Mapping[PathParam, str]:
    return _provider_and(provider, PathParam.SUBSCRIPTION_ID, subscription_id)


def get_health() -> Call[Health]:
    return Call(ROUTES[OperationId.GET_HEALTH], _HEALTH)


def get_openapi() -> Call[OpenApiDocument]:
    return Call(ROUTES[OperationId.GET_OPENAPI], _OPENAPI)


def list_providers() -> Call[List[Capabilities]]:
    return Call(ROUTES[OperationId.LIST_PROVIDERS], _CAPABILITIES_LIST)


def get_capabilities(provider: Provider) -> Call[Capabilities]:
    return Call(ROUTES[OperationId.GET_CAPABILITIES], _CAPABILITIES, _provider(provider))


def create_plan(provider: Provider, plan: Union[CreatePlanInput, Input]) -> Call[Plan]:
    body = dump_request(coerce(CreatePlanInput, plan))
    return Call(ROUTES[OperationId.CREATE_PLAN], _PLAN, _provider(provider), body=body)


def get_plan(provider: Provider, plan_id: str) -> Call[Plan]:
    return Call(ROUTES[OperationId.GET_PLAN], _PLAN, _provider_and(provider, PathParam.PLAN_ID, plan_id))


def create_subscription(provider: Provider, subscription: Union[CreateSubscriptionInput, Input]) -> Call[Subscription]:
    body = dump_request(coerce(CreateSubscriptionInput, subscription))
    return Call(ROUTES[OperationId.CREATE_SUBSCRIPTION], _SUBSCRIPTION, _provider(provider), body=body)


def get_subscription(provider: Provider, subscription_id: str) -> Call[Subscription]:
    return Call(ROUTES[OperationId.GET_SUBSCRIPTION], _SUBSCRIPTION, _subscription_path(provider, subscription_id))


def update_subscription(
    provider: Provider, subscription_id: str, changes: Union[UpdateSubscriptionInput, Input]
) -> Call[Subscription]:
    body = dump_request(coerce(UpdateSubscriptionInput, changes))
    return Call(
        ROUTES[OperationId.UPDATE_SUBSCRIPTION], _SUBSCRIPTION, _subscription_path(provider, subscription_id), body=body
    )


def cancel_subscription(
    provider: Provider, subscription_id: str, options: Union[CancelSubscriptionOptions, Input, None]
) -> Call[Subscription]:
    body = None if options is None else dump_request(coerce(CancelSubscriptionOptions, options))
    return Call(
        ROUTES[OperationId.CANCEL_SUBSCRIPTION], _SUBSCRIPTION, _subscription_path(provider, subscription_id), body=body
    )


def pause_subscription(
    provider: Provider, subscription_id: str, options: Union[PauseSubscriptionOptions, Input, None]
) -> Call[Subscription]:
    body = None if options is None else dump_request(coerce(PauseSubscriptionOptions, options))
    return Call(
        ROUTES[OperationId.PAUSE_SUBSCRIPTION], _SUBSCRIPTION, _subscription_path(provider, subscription_id), body=body
    )


def resume_subscription(
    provider: Provider, subscription_id: str, options: Union[ResumeSubscriptionOptions, Input, None]
) -> Call[Subscription]:
    body = None if options is None else dump_request(coerce(ResumeSubscriptionOptions, options))
    return Call(
        ROUTES[OperationId.RESUME_SUBSCRIPTION], _SUBSCRIPTION, _subscription_path(provider, subscription_id), body=body
    )


def list_charges(
    provider: Provider, subscription_id: str, options: Union[ListChargesOptions, Input, None]
) -> Call[List[Charge]]:
    limit = None if options is None else coerce(ListChargesOptions, options).limit
    query = {} if limit is None else {QueryParam.LIMIT: str(limit)}
    return Call(
        ROUTES[OperationId.LIST_CHARGES], _CHARGE_LIST, _subscription_path(provider, subscription_id), query=query
    )


def get_charge(provider: Provider, subscription_id: str, charge_id: str) -> Call[Charge]:
    path = {**_subscription_path(provider, subscription_id), PathParam.CHARGE_ID: charge_id}
    return Call(ROUTES[OperationId.GET_CHARGE], _CHARGE, path)


def create_charge(provider: Provider, charge: Union[CreateChargeInput, Input]) -> Call[Charge]:
    body = dump_request(coerce(CreateChargeInput, charge))
    return Call(ROUTES[OperationId.CREATE_CHARGE], _CHARGE, _provider(provider), body=body)


def notify_charge(provider: Provider, notification: Union[NotifyChargeInput, Input]) -> Call[ChargeNotification]:
    body = dump_request(coerce(NotifyChargeInput, notification))
    return Call(ROUTES[OperationId.NOTIFY_CHARGE], _NOTIFICATION, _provider(provider), body=body)


def create_refund(provider: Provider, refund: Union[RefundInput, Input]) -> Call[Refund]:
    body = dump_request(coerce(RefundInput, refund))
    return Call(ROUTES[OperationId.CREATE_REFUND], _REFUND, _provider(provider), body=body)


def verify_checkout(
    provider: Provider, result: Input, expected_subscription_id: Optional[str]
) -> Call[CheckoutVerification]:
    """The gateway's result is forwarded untouched (nothing is dropped, not even a null)."""
    # Only a given id is "set", so an absent one is not sent as null.
    body = (
        VerifyCheckoutInput(result=dict(result))
        if expected_subscription_id is None
        else VerifyCheckoutInput(result=dict(result), expected_subscription_id=expected_subscription_id)
    )
    return Call(ROUTES[OperationId.VERIFY_CHECKOUT], _VERIFICATION, _provider(provider), body=dump_keeping_nulls(body))


def parse_webhook(provider: Provider, request: Union[WebhookRequest, Input]) -> Call[List[SubscriptionEvent]]:
    body = dump_request(coerce(WebhookRequest, request))
    return Call(ROUTES[OperationId.PARSE_WEBHOOK], _EVENT_LIST, _provider(provider), body=body)


def receive_webhook(
    provider: Provider, raw_body: bytes, headers: Mapping[str, str], content_type: str
) -> Call[WebhookReceipt]:
    """Posts the gateway's webhook as the gateway would: raw bytes, its own headers, no API key."""
    return Call(
        ROUTES[OperationId.RECEIVE_WEBHOOK],
        _RECEIPT,
        _provider(provider),
        body=raw_body,
        content_type=content_type,
        headers=headers,
    )


def run_scheduler_tick(options: Union[TickRequest, Input, None]) -> Call[TickResult]:
    body = None if options is None else dump_request(coerce(TickRequest, options))
    return Call(ROUTES[OperationId.RUN_SCHEDULER_TICK], _TICK, body=body)


def create_payment(provider: Provider, payment: Union[CreatePaymentInput, Input]) -> Call[Payment]:
    body = dump_request(coerce(CreatePaymentInput, payment))
    return Call(ROUTES[OperationId.CREATE_PAYMENT], _PAYMENT, _provider(provider), body=body)


def get_payment(provider: Provider, payment_id: str) -> Call[Payment]:
    return Call(ROUTES[OperationId.GET_PAYMENT], _PAYMENT, _provider_and(provider, PathParam.PAYMENT_ID, payment_id))


def verify_payment(
    provider: Provider, result: Input, expected_payment_id: Optional[str]
) -> Call[PaymentVerification]:
    """The gateway's (or the store's) result is forwarded untouched (nothing is dropped, not even a null)."""
    body = (
        VerifyPaymentInput(result=dict(result))
        if expected_payment_id is None
        else VerifyPaymentInput(result=dict(result), expected_payment_id=expected_payment_id)
    )
    return Call(ROUTES[OperationId.VERIFY_PAYMENT], _PAYMENT_VERIFICATION, _provider(provider), body=dump_keeping_nulls(body))


def create_payment_refund(provider: Provider, refund: Union[RefundPaymentInput, Input]) -> Call[Refund]:
    body = dump_request(coerce(RefundPaymentInput, refund))
    return Call(ROUTES[OperationId.CREATE_PAYMENT_REFUND], _REFUND, _provider(provider), body=body)


def decide_route(request: Union[RouteRequest, Input]) -> Call[RoutingDecision]:
    body = dump_request(coerce(RouteRequest, request))
    return Call(ROUTES[OperationId.DECIDE_ROUTE], _DECISION, body=body)


def record_route_outcome(outcome: Union[RouteOutcome, Input]) -> Call[RoutingReceipt]:
    body = dump_request(coerce(RouteOutcome, outcome))
    return Call(ROUTES[OperationId.RECORD_ROUTE_OUTCOME], _ROUTING_RECEIPT, body=body)


def start_purchase(purchase: Union[StartPurchaseInput, Input]) -> Call[PurchaseSession]:
    body = dump_request(coerce(StartPurchaseInput, purchase))
    return Call(ROUTES[OperationId.START_PURCHASE], _PURCHASE, body=body)


def get_purchase(session_id: str) -> Call[PurchaseSession]:
    return Call(ROUTES[OperationId.GET_PURCHASE], _PURCHASE, {PathParam.SESSION_ID: session_id})


def choose_alternative(session_id: str, external_transaction_token: str) -> Call[PurchaseSession]:
    body = dump_request(ChooseAlternativeInput(external_transaction_token=external_transaction_token))
    return Call(ROUTES[OperationId.CHOOSE_ALTERNATIVE], _PURCHASE, {PathParam.SESSION_ID: session_id}, body=body)


def complete_purchase(session_id: str, provider: Provider, result: Input) -> Call[PurchaseSession]:
    """The checkout result (the store's transaction, or a gateway's data) is forwarded untouched."""
    body = dump_keeping_nulls(CompletePurchaseInput(provider=Provider(provider), result=dict(result)))
    return Call(ROUTES[OperationId.COMPLETE_PURCHASE], _PURCHASE, {PathParam.SESSION_ID: session_id}, body=body)


def flush_purchase_reports(options: Union[FlushOptions, Input, None]) -> Call[FlushResult]:
    body = None if options is None else dump_request(coerce(FlushOptions, options))
    return Call(ROUTES[OperationId.FLUSH_PURCHASE_REPORTS], _FLUSH, body=body)


def get_entitlements(customer_ref: str) -> Call[Entitlements]:
    return Call(ROUTES[OperationId.GET_ENTITLEMENTS], _ENTITLEMENTS, {PathParam.CUSTOMER_REF: customer_ref})
