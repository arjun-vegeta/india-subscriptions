# GENERATED FILE - DO NOT EDIT.
# Source: openapi/openapi.json (generated from the TypeScript Zod schemas by `npm run openapi`).
# Regenerate with: clients/python/scripts/generate_models.sh
# tests/test_models_generated.py fails when this file drifts from the spec.
# ruff: noqa
# mypy: ignore-errors

from __future__ import annotations

from enum import Enum
from typing import Annotated, Any, Dict, Literal, Optional, Union

from pydantic import (
    AnyUrl,
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    RootModel,
    StringConstraints,
)


class Provider(str, Enum):
    RAZORPAY = 'razorpay'
    CASHFREE = 'cashfree'
    PAYU = 'payu'


class Currency(str, Enum):
    INR = 'INR'


class SubscriptionStatus(str, Enum):
    CREATED = 'created'
    PENDING_AUTHORIZATION = 'pending_authorization'
    TRIALING = 'trialing'
    ACTIVE = 'active'
    PAST_DUE = 'past_due'
    HALTED = 'halted'
    PAUSED = 'paused'
    CANCELLED = 'cancelled'
    COMPLETED = 'completed'
    EXPIRED = 'expired'
    FAILED = 'failed'


class ChargeStatus(str, Enum):
    SCHEDULED = 'scheduled'
    PENDING = 'pending'
    SUCCEEDED = 'succeeded'
    FAILED = 'failed'
    CANCELLED = 'cancelled'
    REFUNDED = 'refunded'
    PARTIALLY_REFUNDED = 'partially_refunded'


class ChargeKind(str, Enum):
    AUTHORIZATION = 'authorization'
    RECURRING = 'recurring'
    UPFRONT = 'upfront'


class RefundStatus(str, Enum):
    PENDING = 'pending'
    SUCCEEDED = 'succeeded'
    FAILED = 'failed'


class PaymentMethod(str, Enum):
    UPI = 'upi'
    CARD = 'card'
    ENACH = 'enach'
    PHYSICAL_NACH = 'physical_nach'


class SchedulingMode(str, Enum):
    GATEWAY = 'gateway'
    MERCHANT = 'merchant'


class EventType(str, Enum):
    SUBSCRIPTION_AUTHORIZED = 'subscription.authorized'
    SUBSCRIPTION_AUTHORIZATION_FAILED = 'subscription.authorization_failed'
    SUBSCRIPTION_ACTIVATED = 'subscription.activated'
    SUBSCRIPTION_CHARGED = 'subscription.charged'
    SUBSCRIPTION_CHARGE_FAILED = 'subscription.charge_failed'
    SUBSCRIPTION_CHARGE_SCHEDULED = 'subscription.charge_scheduled'
    SUBSCRIPTION_PAST_DUE = 'subscription.past_due'
    SUBSCRIPTION_HALTED = 'subscription.halted'
    SUBSCRIPTION_PAUSED = 'subscription.paused'
    SUBSCRIPTION_RESUMED = 'subscription.resumed'
    SUBSCRIPTION_UPDATED = 'subscription.updated'
    SUBSCRIPTION_CANCELLED = 'subscription.cancelled'
    SUBSCRIPTION_COMPLETED = 'subscription.completed'
    SUBSCRIPTION_EXPIRED = 'subscription.expired'
    REFUND_SUCCEEDED = 'refund.succeeded'
    REFUND_FAILED = 'refund.failed'
    UNKNOWN = 'unknown'


class Environment(str, Enum):
    TEST = 'test'
    LIVE = 'live'


class BillingIntervalUnit(str, Enum):
    DAY = 'day'
    WEEK = 'week'
    MONTH = 'month'
    YEAR = 'year'


class BillingInterval(BaseModel):
    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    unit: BillingIntervalUnit
    count: Annotated[int, Field(ge=1, le=9007199254740991)]


class Customer(BaseModel):
    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    id: Annotated[Optional[str], Field(min_length=1)] = None
    name: Annotated[Optional[str], Field(min_length=1)] = None
    email: Annotated[
        Optional[str],
        Field(
            pattern="^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
        ),
    ] = None
    phone: Annotated[Optional[str], Field(pattern='^\\+?[0-9]{10,15}$')] = None


class CreatePlanInput(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
        populate_by_name=True,
    )
    id: Annotated[Optional[str], Field(max_length=40, min_length=1)] = None
    name: Annotated[str, Field(max_length=100, min_length=1)]
    description: Annotated[Optional[str], Field(max_length=500)] = None
    amount: Annotated[int, Field(gt=0, le=9007199254740991)]
    currency: Currency = Currency.INR
    interval: BillingInterval
    scheduling: Optional[SchedulingMode] = None
    max_amount: Annotated[
        Optional[int], Field(alias='maxAmount', gt=0, le=9007199254740991)
    ] = None
    max_cycles: Annotated[
        Optional[int], Field(alias='maxCycles', gt=0, le=9007199254740991)
    ] = None
    metadata: Optional[dict[str, str]] = None


class Plan(BaseModel):
    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    provider: Provider
    id: str
    name: str
    description: Optional[str] = None
    amount: Annotated[int, Field(ge=0, le=9007199254740991)]
    currency: Currency
    interval: Optional[BillingInterval] = None
    scheduling: SchedulingMode
    max_amount: Annotated[
        Optional[int], Field(alias='maxAmount', ge=0, le=9007199254740991)
    ] = None
    max_cycles: Annotated[
        Optional[int],
        Field(alias='maxCycles', ge=-9007199254740991, le=9007199254740991),
    ] = None
    provider_status: Annotated[Optional[str], Field(alias='providerStatus')] = None
    created_at: Annotated[Optional[AwareDatetime], Field(alias='createdAt')] = None
    metadata: Optional[dict[str, str]] = None
    raw: Any


class CheckoutInstructionCheckoutInstructionRedirect(BaseModel):
    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    kind: Literal['redirect']
    url: AnyUrl


class CheckoutInstructionCheckoutInstructionFormPost(BaseModel):
    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    kind: Literal['form_post']
    url: AnyUrl
    fields: dict[str, str]


class CheckoutInstructionCheckoutInstructionRazorpayCheckout(BaseModel):
    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    kind: Literal['razorpay_checkout']
    key_id: Annotated[str, Field(alias='keyId')]
    subscription_id: Annotated[str, Field(alias='subscriptionId')]
    hosted_url: Annotated[Optional[AnyUrl], Field(alias='hostedUrl')] = None
    callback_url: Annotated[Optional[AnyUrl], Field(alias='callbackUrl')] = None
    prefill: Optional[Customer] = None


class CheckoutInstructionCheckoutInstructionCashfreeCheckout(BaseModel):
    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    kind: Literal['cashfree_checkout']
    session_id: Annotated[str, Field(alias='sessionId')]
    environment: Environment


class Trial(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
        populate_by_name=True,
    )
    days: Annotated[Optional[int], Field(gt=0, le=9007199254740991)] = None
    ends_at: Annotated[Optional[AwareDatetime], Field(alias='endsAt')] = None


class CreateSubscriptionInput(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
        populate_by_name=True,
    )
    reference: Annotated[Optional[str], Field(max_length=60, min_length=1)] = None
    plan: Union[CreatePlanInput, Annotated[str, StringConstraints(min_length=1)]]
    customer: Customer
    quantity: Annotated[Optional[int], Field(gt=0, le=9007199254740991)] = None
    total_cycles: Annotated[
        Optional[int], Field(alias='totalCycles', gt=0, le=9007199254740991)
    ] = None
    trial: Optional[Trial] = None
    start_at: Annotated[Optional[AwareDatetime], Field(alias='startAt')] = None
    upfront_amount: Annotated[
        Optional[int], Field(alias='upfrontAmount', gt=0, le=9007199254740991)
    ] = None
    upfront_label: Annotated[
        Optional[str], Field(alias='upfrontLabel', max_length=100, min_length=1)
    ] = None
    payment_methods: Annotated[
        Optional[list[PaymentMethod]], Field(alias='paymentMethods', min_length=1)
    ] = None
    authorize_by: Annotated[Optional[AwareDatetime], Field(alias='authorizeBy')] = None
    mandate_ends_at: Annotated[
        Optional[AwareDatetime], Field(alias='mandateEndsAt')
    ] = None
    return_url: Annotated[Optional[AnyUrl], Field(alias='returnUrl')] = None
    notify_customer: Annotated[Optional[bool], Field(alias='notifyCustomer')] = None
    metadata: Optional[dict[str, str]] = None
    idempotency_key: Annotated[
        Optional[str], Field(alias='idempotencyKey', max_length=255, min_length=1)
    ] = None


class Subscription(BaseModel):
    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    provider: Provider
    id: str
    reference: Optional[str] = None
    plan_id: Annotated[Optional[str], Field(alias='planId')] = None
    status: SubscriptionStatus
    provider_status: Annotated[str, Field(alias='providerStatus')]
    scheduling: SchedulingMode
    customer: Optional[Customer] = None
    quantity: Annotated[
        Optional[int], Field(ge=-9007199254740991, le=9007199254740991)
    ] = None
    amount: Annotated[Optional[int], Field(ge=0, le=9007199254740991)] = None
    max_amount: Annotated[
        Optional[int], Field(alias='maxAmount', ge=0, le=9007199254740991)
    ] = None
    currency: Optional[Currency] = None
    interval: Optional[BillingInterval] = None
    total_cycles: Annotated[
        Optional[int],
        Field(alias='totalCycles', ge=-9007199254740991, le=9007199254740991),
    ] = None
    paid_cycles: Annotated[
        Optional[int],
        Field(alias='paidCycles', ge=-9007199254740991, le=9007199254740991),
    ] = None
    remaining_cycles: Annotated[
        Optional[int],
        Field(alias='remainingCycles', ge=-9007199254740991, le=9007199254740991),
    ] = None
    created_at: Annotated[Optional[AwareDatetime], Field(alias='createdAt')] = None
    start_at: Annotated[Optional[AwareDatetime], Field(alias='startAt')] = None
    trial_ends_at: Annotated[Optional[AwareDatetime], Field(alias='trialEndsAt')] = None
    current_period_start: Annotated[
        Optional[AwareDatetime], Field(alias='currentPeriodStart')
    ] = None
    current_period_end: Annotated[
        Optional[AwareDatetime], Field(alias='currentPeriodEnd')
    ] = None
    next_charge_at: Annotated[Optional[AwareDatetime], Field(alias='nextChargeAt')] = (
        None
    )
    ended_at: Annotated[Optional[AwareDatetime], Field(alias='endedAt')] = None
    mandate_ends_at: Annotated[
        Optional[AwareDatetime], Field(alias='mandateEndsAt')
    ] = None
    cancel_at_period_end: Annotated[
        Optional[bool], Field(alias='cancelAtPeriodEnd')
    ] = None
    payment_method: Annotated[Optional[PaymentMethod], Field(alias='paymentMethod')] = (
        None
    )
    checkout: Annotated[
        Optional[
            Union[
                CheckoutInstructionCheckoutInstructionRedirect,
                CheckoutInstructionCheckoutInstructionFormPost,
                CheckoutInstructionCheckoutInstructionRazorpayCheckout,
                CheckoutInstructionCheckoutInstructionCashfreeCheckout,
            ]
        ],
        Field(discriminator='kind'),
    ] = None
    metadata: Optional[dict[str, str]] = None
    raw: Any


class CancelSubscriptionOptionsMode(str, Enum):
    IMMEDIATELY = 'immediately'
    AT_PERIOD_END = 'at_period_end'


class CancelSubscriptionOptions(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
        populate_by_name=True,
    )
    mode: CancelSubscriptionOptionsMode = CancelSubscriptionOptionsMode.IMMEDIATELY


class PauseSubscriptionOptions(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
        populate_by_name=True,
    )
    resume_at: Annotated[Optional[AwareDatetime], Field(alias='resumeAt')] = None


class ResumeSubscriptionOptions(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
        populate_by_name=True,
    )
    next_charge_at: Annotated[Optional[AwareDatetime], Field(alias='nextChargeAt')] = (
        None
    )


class UpdateSubscriptionInput(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
        populate_by_name=True,
    )
    plan_id: Annotated[Optional[str], Field(alias='planId', min_length=1)] = None
    quantity: Annotated[Optional[int], Field(gt=0, le=9007199254740991)] = None
    remaining_cycles: Annotated[
        Optional[int], Field(alias='remainingCycles', gt=0, le=9007199254740991)
    ] = None
    amount: Annotated[Optional[int], Field(gt=0, le=9007199254740991)] = None
    next_charge_at: Annotated[Optional[AwareDatetime], Field(alias='nextChargeAt')] = (
        None
    )
    mandate_ends_at: Annotated[
        Optional[AwareDatetime], Field(alias='mandateEndsAt')
    ] = None
    timing: CancelSubscriptionOptionsMode = CancelSubscriptionOptionsMode.IMMEDIATELY
    notify_customer: Annotated[Optional[bool], Field(alias='notifyCustomer')] = None


class Charge(BaseModel):
    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    provider: Provider
    id: str
    reference: Optional[str] = None
    subscription_id: Annotated[Optional[str], Field(alias='subscriptionId')] = None
    kind: ChargeKind
    status: ChargeStatus
    provider_status: Annotated[Optional[str], Field(alias='providerStatus')] = None
    amount: Annotated[int, Field(ge=0, le=9007199254740991)]
    currency: Optional[Currency] = None
    cycle: Annotated[
        Optional[int], Field(ge=-9007199254740991, le=9007199254740991)
    ] = None
    scheduled_at: Annotated[Optional[AwareDatetime], Field(alias='scheduledAt')] = None
    paid_at: Annotated[Optional[AwareDatetime], Field(alias='paidAt')] = None
    failure_code: Annotated[Optional[str], Field(alias='failureCode')] = None
    failure_reason: Annotated[Optional[str], Field(alias='failureReason')] = None
    payment_method: Annotated[Optional[PaymentMethod], Field(alias='paymentMethod')] = (
        None
    )
    refunded_amount: Annotated[
        Optional[int], Field(alias='refundedAmount', ge=0, le=9007199254740991)
    ] = None
    raw: Any


class CreateChargeInput(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
        populate_by_name=True,
    )
    subscription_id: Annotated[str, Field(alias='subscriptionId', min_length=1)]
    charge_id: Annotated[str, Field(alias='chargeId', max_length=50, min_length=1)]
    amount: Annotated[int, Field(gt=0, le=9007199254740991)]
    scheduled_at: Annotated[Optional[AwareDatetime], Field(alias='scheduledAt')] = None
    invoice_number: Annotated[
        Optional[str], Field(alias='invoiceNumber', max_length=50, min_length=1)
    ] = None
    description: Annotated[Optional[str], Field(max_length=200)] = None
    customer: Optional[Customer] = None
    metadata: Optional[dict[str, str]] = None


class NotifyChargeInput(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
        populate_by_name=True,
    )
    subscription_id: Annotated[str, Field(alias='subscriptionId', min_length=1)]
    notification_id: Annotated[
        str, Field(alias='notificationId', max_length=50, min_length=1)
    ]
    amount: Annotated[int, Field(gt=0, le=9007199254740991)]
    debit_at: Annotated[AwareDatetime, Field(alias='debitAt')]
    invoice_number: Annotated[
        Optional[str], Field(alias='invoiceNumber', max_length=50, min_length=1)
    ] = None


class ChargeNotification(BaseModel):
    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    provider: Provider
    id: str
    subscription_id: Annotated[str, Field(alias='subscriptionId')]
    accepted: bool
    provider_status: Annotated[Optional[str], Field(alias='providerStatus')] = None
    amount: Annotated[int, Field(ge=0, le=9007199254740991)]
    debit_at: Annotated[AwareDatetime, Field(alias='debitAt')]
    invoice_number: Annotated[Optional[str], Field(alias='invoiceNumber')] = None
    raw: Any


class ListChargesOptions(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
        populate_by_name=True,
    )
    limit: Annotated[Optional[int], Field(ge=1, le=100)] = None


class RefundInput(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
        populate_by_name=True,
    )
    subscription_id: Annotated[
        Optional[str], Field(alias='subscriptionId', min_length=1)
    ] = None
    charge_id: Annotated[str, Field(alias='chargeId', min_length=1)]
    refund_id: Annotated[str, Field(alias='refundId', max_length=40, min_length=1)]
    amount: Annotated[Optional[int], Field(gt=0, le=9007199254740991)] = None
    reason: Annotated[Optional[str], Field(max_length=250)] = None


class Refund(BaseModel):
    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    provider: Provider
    id: str
    reference: Optional[str] = None
    charge_id: Annotated[str, Field(alias='chargeId')]
    subscription_id: Annotated[Optional[str], Field(alias='subscriptionId')] = None
    status: RefundStatus
    provider_status: Annotated[Optional[str], Field(alias='providerStatus')] = None
    amount: Annotated[int, Field(ge=0, le=9007199254740991)]
    currency: Optional[Currency] = None
    created_at: Annotated[Optional[AwareDatetime], Field(alias='createdAt')] = None
    raw: Any


class CheckoutResult(RootModel[dict[str, Any]]):
    root: dict[str, Any]


class CheckoutVerification(BaseModel):
    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    provider: Provider
    subscription_id: Annotated[str, Field(alias='subscriptionId')]
    reference: Optional[str] = None
    authorized: bool
    status: Optional[SubscriptionStatus] = None
    charge: Optional[Charge] = None
    raw: Any


class WebhookRequest(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
        populate_by_name=True,
    )
    raw_body: Annotated[str, Field(alias='rawBody')]
    headers: dict[str, Union[str, list[str]]]


class SubscriptionEvent(BaseModel):
    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    id: str
    provider: Provider
    type: EventType
    provider_event_type: Annotated[str, Field(alias='providerEventType')]
    occurred_at: Annotated[Optional[AwareDatetime], Field(alias='occurredAt')] = None
    subscription_id: Annotated[Optional[str], Field(alias='subscriptionId')] = None
    subscription: Optional[Subscription] = None
    charge: Optional[Charge] = None
    refund: Optional[Refund] = None
    raw: Any


class Capabilities(BaseModel):
    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    provider: Provider
    scheduling: Annotated[list[SchedulingMode], Field(min_length=1)]
    gateway_plans: Annotated[bool, Field(alias='gatewayPlans')]
    trial: bool
    upfront_amount: Annotated[bool, Field(alias='upfrontAmount')]
    quantity: bool
    pause: bool
    resume: bool
    cancel_at_period_end: Annotated[bool, Field(alias='cancelAtPeriodEnd')]
    change_plan: Annotated[bool, Field(alias='changePlan')]
    merchant_charges: Annotated[bool, Field(alias='merchantCharges')]
    merchant_pre_debit_notification: Annotated[
        bool, Field(alias='merchantPreDebitNotification')
    ]
    merchant_charge_lead_hours: Annotated[
        Optional[int], Field(alias='merchantChargeLeadHours', ge=0, le=9007199254740991)
    ] = None
    merchant_charge_max_ahead_hours: Annotated[
        Optional[int],
        Field(alias='merchantChargeMaxAheadHours', gt=0, le=9007199254740991),
    ] = None
    list_charges: Annotated[bool, Field(alias='listCharges')]
    refunds: bool
    signed_webhooks: Annotated[bool, Field(alias='signedWebhooks')]
    idempotency_keys: Annotated[bool, Field(alias='idempotencyKeys')]
    payment_methods: Annotated[list[PaymentMethod], Field(alias='paymentMethods')]


class ErrorResponseErrorCode(str, Enum):
    CONFIG = 'CONFIG'
    VALIDATION = 'VALIDATION'
    UNSUPPORTED = 'UNSUPPORTED'
    NOT_FOUND = 'NOT_FOUND'
    AUTH = 'AUTH'
    CONFLICT = 'CONFLICT'
    RATE_LIMITED = 'RATE_LIMITED'
    PROVIDER_ERROR = 'PROVIDER_ERROR'
    PROVIDER_UNAVAILABLE = 'PROVIDER_UNAVAILABLE'
    UNEXPECTED_RESPONSE = 'UNEXPECTED_RESPONSE'
    NETWORK = 'NETWORK'
    TIMEOUT = 'TIMEOUT'
    OUTCOME_UNKNOWN = 'OUTCOME_UNKNOWN'
    SIGNATURE_INVALID = 'SIGNATURE_INVALID'
    INTERNAL_ERROR = 'INTERNAL_ERROR'
    UNAUTHORIZED = 'UNAUTHORIZED'
    METHOD_NOT_ALLOWED = 'METHOD_NOT_ALLOWED'
    PAYLOAD_TOO_LARGE = 'PAYLOAD_TOO_LARGE'


class ErrorResponseError(BaseModel):
    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    code: ErrorResponseErrorCode
    message: str
    provider: Optional[Provider] = None
    http_status: Annotated[
        Optional[int],
        Field(alias='httpStatus', ge=-9007199254740991, le=9007199254740991),
    ] = None
    provider_code: Annotated[Optional[str], Field(alias='providerCode')] = None
    retryable: bool


class ErrorResponse(BaseModel):
    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    error: ErrorResponseError


class HealthStatus(str, Enum):
    OK = 'ok'


class Health(BaseModel):
    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    status: HealthStatus
    providers: list[Provider]


class WebhookReceipt(BaseModel):
    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    received: Annotated[int, Field(ge=0, le=9007199254740991)]


class WebhookPayload(RootModel[dict[str, Any]]):
    root: dict[str, Any]


class TickRequest(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
        populate_by_name=True,
    )
    limit: Annotated[Optional[int], Field(ge=1, le=9007199254740991)] = None


class OpenApiDocument(BaseModel):
    model_config = ConfigDict(
        extra='allow',
        populate_by_name=True,
    )
    __annotations__ = {
        '__pydantic_extra__': Dict[str, Any],
    }
    openapi: str


class TickResultErrorCode(str, Enum):
    CONFIG = 'CONFIG'
    VALIDATION = 'VALIDATION'
    UNSUPPORTED = 'UNSUPPORTED'
    NOT_FOUND = 'NOT_FOUND'
    AUTH = 'AUTH'
    CONFLICT = 'CONFLICT'
    RATE_LIMITED = 'RATE_LIMITED'
    PROVIDER_ERROR = 'PROVIDER_ERROR'
    PROVIDER_UNAVAILABLE = 'PROVIDER_UNAVAILABLE'
    UNEXPECTED_RESPONSE = 'UNEXPECTED_RESPONSE'
    NETWORK = 'NETWORK'
    TIMEOUT = 'TIMEOUT'
    OUTCOME_UNKNOWN = 'OUTCOME_UNKNOWN'
    SIGNATURE_INVALID = 'SIGNATURE_INVALID'
    INTERNAL_ERROR = 'INTERNAL_ERROR'


class TickResultError(BaseModel):
    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    schedule_id: Annotated[str, Field(alias='scheduleId')]
    code: TickResultErrorCode
    message: str


class TickResult(BaseModel):
    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    at: AwareDatetime
    due: Annotated[int, Field(ge=0, le=9007199254740991)]
    locked: Annotated[int, Field(ge=0, le=9007199254740991)]
    notified: Annotated[int, Field(ge=0, le=9007199254740991)]
    charged: Annotated[int, Field(ge=0, le=9007199254740991)]
    reconciled: Annotated[int, Field(ge=0, le=9007199254740991)]
    succeeded: Annotated[int, Field(ge=0, le=9007199254740991)]
    failed: Annotated[int, Field(ge=0, le=9007199254740991)]
    awaiting: Annotated[int, Field(ge=0, le=9007199254740991)]
    completed: Annotated[int, Field(ge=0, le=9007199254740991)]
    halted: Annotated[int, Field(ge=0, le=9007199254740991)]
    expired: Annotated[int, Field(ge=0, le=9007199254740991)]
    errors: list[TickResultError]
