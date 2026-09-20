"""A typed Python client for the ``india-subscriptions`` HTTP service.

One gateway-neutral API over subscriptions on Razorpay, Cashfree and PayU::

    from india_subscriptions import Provider, SubscriptionsClient

    with SubscriptionsClient("http://localhost:8080", api_key="...") as client:
        subscription = client.subscriptions.get(Provider.RAZORPAY, "sub_123")

All request and response types are the Pydantic models in ``india_subscriptions.models``, generated
from the service's OpenAPI document. Errors are ``SubscriptionsApiError`` (the service answered with
an error) and ``SubscriptionsTransportError`` (no usable answer).
"""

from . import constants, models
from .async_client import AsyncSubscriptionsClient
from .client import SubscriptionsClient
from .errors import (
    ErrorCode,
    SubscriptionsApiError,
    SubscriptionsError,
    SubscriptionsTransportError,
)
from .models import (
    CancelSubscriptionOptions,
    Capabilities,
    Charge,
    ChargeKind,
    ChargeNotification,
    ChargeStatus,
    CheckoutVerification,
    VerifyCheckoutInput,
    CreateChargeInput,
    CreatePlanInput,
    CreateSubscriptionInput,
    Currency,
    Customer,
    Environment,
    EventType,
    Health,
    ListChargesOptions,
    NotifyChargeInput,
    PauseSubscriptionOptions,
    PaymentMethod,
    Plan,
    Provider,
    Refund,
    RefundInput,
    RefundStatus,
    ResumeSubscriptionOptions,
    SchedulingMode,
    Subscription,
    SubscriptionEvent,
    SubscriptionStatus,
    TickRequest,
    TickResult,
    Trial,
    UpdateSubscriptionInput,
    WebhookReceipt,
    WebhookRequest,
)
from .version import __version__
from .webhooks import build_webhook_request, parse_webhook, parse_webhook_async

__all__ = [
    "AsyncSubscriptionsClient",
    "CancelSubscriptionOptions",
    "Capabilities",
    "Charge",
    "ChargeKind",
    "ChargeNotification",
    "ChargeStatus",
    "CheckoutVerification",
    "VerifyCheckoutInput",
    "CreateChargeInput",
    "CreatePlanInput",
    "CreateSubscriptionInput",
    "Currency",
    "Customer",
    "Environment",
    "ErrorCode",
    "EventType",
    "Health",
    "ListChargesOptions",
    "NotifyChargeInput",
    "PauseSubscriptionOptions",
    "PaymentMethod",
    "Plan",
    "Provider",
    "Refund",
    "RefundInput",
    "RefundStatus",
    "ResumeSubscriptionOptions",
    "SchedulingMode",
    "Subscription",
    "SubscriptionEvent",
    "SubscriptionStatus",
    "SubscriptionsApiError",
    "SubscriptionsClient",
    "SubscriptionsError",
    "SubscriptionsTransportError",
    "TickRequest",
    "TickResult",
    "Trial",
    "UpdateSubscriptionInput",
    "WebhookReceipt",
    "WebhookRequest",
    "__version__",
    "build_webhook_request",
    "constants",
    "models",
    "parse_webhook",
    "parse_webhook_async",
]
