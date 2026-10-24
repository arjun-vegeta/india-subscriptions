"""Every string that carries meaning in the client lives here, as a named constant.

Nothing outside this module (and the generated ``models``) spells out a route, a header
name, an operation id, an HTTP method or a content type. Enumerations the service
publishes (``Provider``, ``SubscriptionStatus``, ...) are not repeated here: they come only
from the generated ``india_subscriptions.models``.

The ``ROUTES`` table is checked against ``openapi/openapi.json`` by
``tests/test_contract.py``, so this module cannot silently fall behind the service.
"""

from __future__ import annotations

from enum import Enum, IntEnum
from typing import Mapping, NamedTuple

API_PREFIX = "/v1"
"""The API version prefix every route starts with."""

BEARER_SCHEME = "Bearer"
PACKAGE_NAME = "india-subscriptions"

DEFAULT_TIMEOUT_SECONDS = 30.0
"""Default for ``timeout``: the service may itself be waiting on a payment gateway."""

DEFAULT_MAX_RETRIES = 2
"""Extra attempts for a failed GET. Never applied to any other method."""

DEFAULT_RETRY_BACKOFF_SECONDS = 0.25
"""First retry delay; it doubles on every further attempt."""

ERROR_BODY_SNIPPET_CHARS = 500
"""How much of an unrecognised response body an error keeps."""


class HttpMethod(str, Enum):
    GET = "GET"
    POST = "POST"
    PATCH = "PATCH"


class HeaderName(str, Enum):
    """Header names, lower case (as HTTP/2 and the service normalise them)."""

    AUTHORIZATION = "authorization"
    CONTENT_TYPE = "content-type"
    ACCEPT = "accept"
    USER_AGENT = "user-agent"
    WWW_AUTHENTICATE = "www-authenticate"


class ContentType(str, Enum):
    JSON = "application/json"


class AuthMode(str, Enum):
    """How a route is protected (mirrors the service's ``AuthMode``)."""

    NONE = "none"
    """Public: no key sent."""
    BEARER = "bearer"
    """``Authorization: Bearer <api_key>``."""
    SIGNATURE = "signature"
    """No API key: authenticated by the gateway's webhook signature over the raw body."""


class HttpStatus(IntEnum):
    OK = 200
    CREATED = 201
    BAD_REQUEST = 400
    UNAUTHORIZED = 401
    NOT_FOUND = 404
    METHOD_NOT_ALLOWED = 405
    CONFLICT = 409
    PAYLOAD_TOO_LARGE = 413
    UNPROCESSABLE = 422
    TOO_MANY_REQUESTS = 429
    INTERNAL_SERVER_ERROR = 500
    BAD_GATEWAY = 502
    SERVICE_UNAVAILABLE = 503
    GATEWAY_TIMEOUT = 504


RETRYABLE_STATUSES = frozenset(
    {
        HttpStatus.TOO_MANY_REQUESTS,
        HttpStatus.BAD_GATEWAY,
        HttpStatus.SERVICE_UNAVAILABLE,
        HttpStatus.GATEWAY_TIMEOUT,
    }
)
"""Statuses worth repeating a GET for, when the body is not a documented error."""


NON_FORWARDED_HEADERS = frozenset(
    {
        "host",
        "content-length",
        "connection",
        "keep-alive",
        "transfer-encoding",
        "te",
        "trailer",
        "upgrade",
        "proxy-authorization",
        "authorization",
    }
)
"""Headers that are never copied onto a forwarded webhook: connection-level headers belong to the
hop, and the gateway's own ``Authorization`` must not replace (or be sent as) the service key."""


class PathParam(str, Enum):
    """Names of the ``{placeholders}`` in the route templates."""

    PROVIDER = "provider"
    PLAN_ID = "planId"
    SUBSCRIPTION_ID = "subscriptionId"
    CHARGE_ID = "chargeId"
    PAYMENT_ID = "paymentId"
    SESSION_ID = "sessionId"
    CUSTOMER_REF = "customerRef"


class QueryParam(str, Enum):
    LIMIT = "limit"


class ApiPath:
    """Route templates, character for character as in the OpenAPI document."""

    HEALTH = f"{API_PREFIX}/health"
    OPENAPI = f"{API_PREFIX}/openapi.json"
    PROVIDERS = f"{API_PREFIX}/providers"
    CAPABILITIES = f"{API_PREFIX}/{{provider}}/capabilities"
    PLANS = f"{API_PREFIX}/{{provider}}/plans"
    PLAN = f"{API_PREFIX}/{{provider}}/plans/{{planId}}"
    SUBSCRIPTIONS = f"{API_PREFIX}/{{provider}}/subscriptions"
    SUBSCRIPTION = f"{API_PREFIX}/{{provider}}/subscriptions/{{subscriptionId}}"
    SUBSCRIPTION_CANCEL = f"{SUBSCRIPTION}/cancel"
    SUBSCRIPTION_PAUSE = f"{SUBSCRIPTION}/pause"
    SUBSCRIPTION_RESUME = f"{SUBSCRIPTION}/resume"
    SUBSCRIPTION_CHARGES = f"{SUBSCRIPTION}/charges"
    SUBSCRIPTION_CHARGE = f"{SUBSCRIPTION}/charges/{{chargeId}}"
    CHARGES = f"{API_PREFIX}/{{provider}}/charges"
    CHARGE_NOTIFICATIONS = f"{API_PREFIX}/{{provider}}/charge-notifications"
    REFUNDS = f"{API_PREFIX}/{{provider}}/refunds"
    CHECKOUT_VERIFY = f"{API_PREFIX}/{{provider}}/checkout/verify"
    WEBHOOKS_PARSE = f"{API_PREFIX}/{{provider}}/webhooks/parse"
    WEBHOOKS = f"{API_PREFIX}/{{provider}}/webhooks"
    SCHEDULER_TICK = f"{API_PREFIX}/scheduler/tick"
    PAYMENTS = f"{API_PREFIX}/{{provider}}/payments"
    PAYMENT = f"{PAYMENTS}/{{paymentId}}"
    PAYMENT_VERIFY = f"{PAYMENTS}/verify"
    PAYMENT_REFUNDS = f"{API_PREFIX}/{{provider}}/payment-refunds"
    ROUTING_DECIDE = f"{API_PREFIX}/routing/decide"
    ROUTING_OUTCOMES = f"{API_PREFIX}/routing/outcomes"
    PURCHASES = f"{API_PREFIX}/purchases"
    PURCHASES_FLUSH = f"{PURCHASES}/flush"
    PURCHASE = f"{PURCHASES}/{{sessionId}}"
    PURCHASE_ALTERNATIVE = f"{PURCHASE}/alternative"
    PURCHASE_COMPLETE = f"{PURCHASE}/complete"
    ENTITLEMENTS = f"{API_PREFIX}/entitlements/{{customerRef}}"


class OperationId(str, Enum):
    """The ``operationId`` of every operation in the OpenAPI document."""

    GET_HEALTH = "getHealth"
    GET_OPENAPI = "getOpenApi"
    LIST_PROVIDERS = "listProviders"
    GET_CAPABILITIES = "getCapabilities"
    CREATE_PLAN = "createPlan"
    GET_PLAN = "getPlan"
    CREATE_SUBSCRIPTION = "createSubscription"
    GET_SUBSCRIPTION = "getSubscription"
    UPDATE_SUBSCRIPTION = "updateSubscription"
    CANCEL_SUBSCRIPTION = "cancelSubscription"
    PAUSE_SUBSCRIPTION = "pauseSubscription"
    RESUME_SUBSCRIPTION = "resumeSubscription"
    LIST_CHARGES = "listCharges"
    GET_CHARGE = "getCharge"
    CREATE_CHARGE = "createCharge"
    NOTIFY_CHARGE = "notifyCharge"
    CREATE_REFUND = "createRefund"
    VERIFY_CHECKOUT = "verifyCheckout"
    PARSE_WEBHOOK = "parseWebhook"
    RECEIVE_WEBHOOK = "receiveWebhook"
    RUN_SCHEDULER_TICK = "runSchedulerTick"
    CREATE_PAYMENT = "createPayment"
    GET_PAYMENT = "getPayment"
    VERIFY_PAYMENT = "verifyPayment"
    CREATE_PAYMENT_REFUND = "createPaymentRefund"
    DECIDE_ROUTE = "decideRoute"
    RECORD_ROUTE_OUTCOME = "recordRouteOutcome"
    START_PURCHASE = "startPurchase"
    GET_PURCHASE = "getPurchase"
    CHOOSE_ALTERNATIVE = "chooseAlternative"
    COMPLETE_PURCHASE = "completePurchase"
    FLUSH_PURCHASE_REPORTS = "flushPurchaseReports"
    GET_ENTITLEMENTS = "getEntitlements"


class Route(NamedTuple):
    operation_id: OperationId
    method: HttpMethod
    path: str
    auth: AuthMode


def _route(operation_id: OperationId, method: HttpMethod, path: str, auth: AuthMode = AuthMode.BEARER) -> Route:
    return Route(operation_id, method, path, auth)


ROUTES: Mapping[OperationId, Route] = {
    route.operation_id: route
    for route in (
        _route(OperationId.GET_HEALTH, HttpMethod.GET, ApiPath.HEALTH, AuthMode.NONE),
        _route(OperationId.GET_OPENAPI, HttpMethod.GET, ApiPath.OPENAPI, AuthMode.NONE),
        _route(OperationId.LIST_PROVIDERS, HttpMethod.GET, ApiPath.PROVIDERS),
        _route(OperationId.GET_CAPABILITIES, HttpMethod.GET, ApiPath.CAPABILITIES),
        _route(OperationId.CREATE_PLAN, HttpMethod.POST, ApiPath.PLANS),
        _route(OperationId.GET_PLAN, HttpMethod.GET, ApiPath.PLAN),
        _route(OperationId.CREATE_SUBSCRIPTION, HttpMethod.POST, ApiPath.SUBSCRIPTIONS),
        _route(OperationId.GET_SUBSCRIPTION, HttpMethod.GET, ApiPath.SUBSCRIPTION),
        _route(OperationId.UPDATE_SUBSCRIPTION, HttpMethod.PATCH, ApiPath.SUBSCRIPTION),
        _route(OperationId.CANCEL_SUBSCRIPTION, HttpMethod.POST, ApiPath.SUBSCRIPTION_CANCEL),
        _route(OperationId.PAUSE_SUBSCRIPTION, HttpMethod.POST, ApiPath.SUBSCRIPTION_PAUSE),
        _route(OperationId.RESUME_SUBSCRIPTION, HttpMethod.POST, ApiPath.SUBSCRIPTION_RESUME),
        _route(OperationId.LIST_CHARGES, HttpMethod.GET, ApiPath.SUBSCRIPTION_CHARGES),
        _route(OperationId.GET_CHARGE, HttpMethod.GET, ApiPath.SUBSCRIPTION_CHARGE),
        _route(OperationId.CREATE_CHARGE, HttpMethod.POST, ApiPath.CHARGES),
        _route(OperationId.NOTIFY_CHARGE, HttpMethod.POST, ApiPath.CHARGE_NOTIFICATIONS),
        _route(OperationId.CREATE_REFUND, HttpMethod.POST, ApiPath.REFUNDS),
        _route(OperationId.VERIFY_CHECKOUT, HttpMethod.POST, ApiPath.CHECKOUT_VERIFY),
        _route(OperationId.PARSE_WEBHOOK, HttpMethod.POST, ApiPath.WEBHOOKS_PARSE),
        _route(OperationId.RECEIVE_WEBHOOK, HttpMethod.POST, ApiPath.WEBHOOKS, AuthMode.SIGNATURE),
        _route(OperationId.RUN_SCHEDULER_TICK, HttpMethod.POST, ApiPath.SCHEDULER_TICK),
        _route(OperationId.CREATE_PAYMENT, HttpMethod.POST, ApiPath.PAYMENTS),
        _route(OperationId.GET_PAYMENT, HttpMethod.GET, ApiPath.PAYMENT),
        _route(OperationId.VERIFY_PAYMENT, HttpMethod.POST, ApiPath.PAYMENT_VERIFY),
        _route(OperationId.CREATE_PAYMENT_REFUND, HttpMethod.POST, ApiPath.PAYMENT_REFUNDS),
        _route(OperationId.DECIDE_ROUTE, HttpMethod.POST, ApiPath.ROUTING_DECIDE),
        _route(OperationId.RECORD_ROUTE_OUTCOME, HttpMethod.POST, ApiPath.ROUTING_OUTCOMES),
        _route(OperationId.START_PURCHASE, HttpMethod.POST, ApiPath.PURCHASES),
        _route(OperationId.GET_PURCHASE, HttpMethod.GET, ApiPath.PURCHASE),
        _route(OperationId.CHOOSE_ALTERNATIVE, HttpMethod.POST, ApiPath.PURCHASE_ALTERNATIVE),
        _route(OperationId.COMPLETE_PURCHASE, HttpMethod.POST, ApiPath.PURCHASE_COMPLETE),
        _route(OperationId.FLUSH_PURCHASE_REPORTS, HttpMethod.POST, ApiPath.PURCHASES_FLUSH),
        _route(OperationId.GET_ENTITLEMENTS, HttpMethod.GET, ApiPath.ENTITLEMENTS),
    )
}
"""One entry per operation: HTTP method, route template and how it is authenticated."""


CLIENT_METHODS: Mapping[OperationId, str] = {
    OperationId.GET_HEALTH: "health",
    OperationId.GET_OPENAPI: "openapi",
    OperationId.LIST_PROVIDERS: "providers",
    OperationId.GET_CAPABILITIES: "capabilities",
    OperationId.CREATE_PLAN: "plans.create",
    OperationId.GET_PLAN: "plans.get",
    OperationId.CREATE_SUBSCRIPTION: "subscriptions.create",
    OperationId.GET_SUBSCRIPTION: "subscriptions.get",
    OperationId.UPDATE_SUBSCRIPTION: "subscriptions.update",
    OperationId.CANCEL_SUBSCRIPTION: "subscriptions.cancel",
    OperationId.PAUSE_SUBSCRIPTION: "subscriptions.pause",
    OperationId.RESUME_SUBSCRIPTION: "subscriptions.resume",
    OperationId.LIST_CHARGES: "charges.list",
    OperationId.GET_CHARGE: "charges.get",
    OperationId.CREATE_CHARGE: "charges.create",
    OperationId.NOTIFY_CHARGE: "charges.notify",
    OperationId.CREATE_REFUND: "charges.refund",
    OperationId.VERIFY_CHECKOUT: "checkout.verify",
    OperationId.PARSE_WEBHOOK: "webhooks.parse",
    OperationId.RECEIVE_WEBHOOK: "webhooks.receive",
    OperationId.RUN_SCHEDULER_TICK: "scheduler.tick",
    OperationId.CREATE_PAYMENT: "payments.create",
    OperationId.GET_PAYMENT: "payments.get",
    OperationId.VERIFY_PAYMENT: "payments.verify",
    OperationId.CREATE_PAYMENT_REFUND: "payments.refund",
    OperationId.DECIDE_ROUTE: "routing.decide",
    OperationId.RECORD_ROUTE_OUTCOME: "routing.record_outcome",
    OperationId.START_PURCHASE: "purchases.start",
    OperationId.GET_PURCHASE: "purchases.get",
    OperationId.CHOOSE_ALTERNATIVE: "purchases.choose_alternative",
    OperationId.COMPLETE_PURCHASE: "purchases.complete",
    OperationId.FLUSH_PURCHASE_REPORTS: "purchases.flush",
    OperationId.GET_ENTITLEMENTS: "entitlements.get",
}
"""The client attribute path that implements each operation, on both client classes."""
