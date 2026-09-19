"""Properties of the generated models the client relies on (guards against a generator-option regression)."""

from __future__ import annotations

from enum import Enum
from typing import Any, Dict, get_args

import pytest
from pydantic import BaseModel, ValidationError

from india_subscriptions import models
from india_subscriptions.models import (
    CancelSubscriptionOptionsMode,
    CheckoutInstructionCheckoutInstructionCashfreeCheckout,
    CheckoutInstructionCheckoutInstructionFormPost,
    CheckoutInstructionCheckoutInstructionRazorpayCheckout,
    CheckoutInstructionCheckoutInstructionRedirect,
    CreatePlanInput,
    Currency,
    Customer,
    Environment,
    ErrorResponse,
    Health,
    Provider,
    Subscription,
)

from .cases import SUBSCRIPTION_JSON

ENUMS = [member for member in vars(models).values() if isinstance(member, type) and issubclass(member, Enum) and member.__module__ == models.__name__]


@pytest.mark.parametrize("enum", ENUMS, ids=lambda enum: enum.__name__)
def test_every_enum_is_str_based_so_it_compares_to_and_serialises_as_its_value(enum: Any) -> None:
    assert issubclass(enum, str)
    for member in enum:
        assert member.name == member.name.upper()
        assert member == member.value


def test_provider_is_one_type_everywhere() -> None:
    error = ErrorResponse.model_validate({"error": {"code": "NOT_FOUND", "message": "m", "retryable": False, "provider": Provider.PAYU.value}})
    health = Health.model_validate({"status": "ok", "providers": [Provider.RAZORPAY.value]})
    assert type(error.error.provider) is Provider
    assert type(health.providers[0]) is Provider


def test_defaults_are_enum_members_not_strings() -> None:
    plan = CreatePlanInput.model_validate({"name": "G", "amount": 1, "interval": {"unit": "day", "count": 1}})
    assert plan.currency is Currency.INR
    assert models.CancelSubscriptionOptions().mode is CancelSubscriptionOptionsMode.IMMEDIATELY


def test_models_accept_json_names_and_python_names() -> None:
    by_alias = models.Plan.model_validate({"provider": Provider.RAZORPAY.value, "id": "p", "name": "n", "amount": 1, "currency": "INR", "scheduling": "gateway", "maxAmount": 5, "raw": None})
    by_name = models.Plan.model_validate({"provider": Provider.RAZORPAY.value, "id": "p", "name": "n", "amount": 1, "currency": "INR", "scheduling": "gateway", "max_amount": 5, "raw": None})
    assert by_alias == by_name and by_alias.max_amount == 5


def test_email_is_validated_without_the_optional_email_validator_package() -> None:
    assert Customer(email="asha@example.com").email == "asha@example.com"
    with pytest.raises(ValidationError):
        Customer(email="not-an-email")


REQUEST_MODELS = [
    models.CreatePlanInput,
    models.CreateSubscriptionInput,
    models.Trial,
    models.UpdateSubscriptionInput,
    models.CancelSubscriptionOptions,
    models.PauseSubscriptionOptions,
    models.ResumeSubscriptionOptions,
    models.CreateChargeInput,
    models.NotifyChargeInput,
    models.RefundInput,
    models.ListChargesOptions,
    models.WebhookRequest,
    models.TickRequest,
]
RESPONSE_MODELS = [
    models.Plan,
    models.Subscription,
    models.Charge,
    models.ChargeNotification,
    models.Refund,
    models.CheckoutVerification,
    models.SubscriptionEvent,
    models.Capabilities,
    models.Health,
    models.WebhookReceipt,
    models.TickResult,
    models.ErrorResponse,
]


@pytest.mark.parametrize("model", REQUEST_MODELS, ids=lambda model: model.__name__)
def test_request_models_refuse_unknown_keys(model: Any) -> None:
    assert model.model_config.get("extra") == "forbid"


@pytest.mark.parametrize("model", RESPONSE_MODELS, ids=lambda model: model.__name__)
def test_response_models_ignore_unknown_keys(model: Any) -> None:
    assert model.model_config.get("extra") == "ignore"


CHECKOUTS: Dict[str, Any] = {
    "redirect": ({"kind": "redirect", "url": "https://pay.example.test/x"}, CheckoutInstructionCheckoutInstructionRedirect),
    "form_post": ({"kind": "form_post", "url": "https://pay.example.test/x", "fields": {"a": "b"}}, CheckoutInstructionCheckoutInstructionFormPost),
    "razorpay_checkout": ({"kind": "razorpay_checkout", "keyId": "k", "subscriptionId": "s"}, CheckoutInstructionCheckoutInstructionRazorpayCheckout),
    "cashfree_checkout": ({"kind": "cashfree_checkout", "sessionId": "s", "environment": Environment.TEST.value}, CheckoutInstructionCheckoutInstructionCashfreeCheckout),
}


@pytest.mark.parametrize("kind", list(CHECKOUTS))
def test_the_checkout_instruction_is_a_discriminated_union(kind: str) -> None:
    payload, expected = CHECKOUTS[kind]
    subscription = Subscription.model_validate({**SUBSCRIPTION_JSON, "checkout": payload})
    assert isinstance(subscription.checkout, expected)


def test_an_unknown_checkout_kind_is_rejected_with_a_pointed_error() -> None:
    with pytest.raises(ValidationError, match="kind"):
        Subscription.model_validate({**SUBSCRIPTION_JSON, "checkout": {"kind": "carrier_pigeon"}})


def test_the_discriminated_union_has_the_four_documented_variants() -> None:
    annotation = Subscription.model_fields["checkout"].annotation
    variants = [arg for union in get_args(annotation) for arg in (get_args(union) or (union,)) if isinstance(arg, type) and issubclass(arg, BaseModel)]
    assert {variant for variant in variants} == {expected for _, expected in CHECKOUTS.values()}
