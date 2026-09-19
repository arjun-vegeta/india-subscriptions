"""The asyncio client. It mirrors ``AsyncSubscriptionsClient`` (``client.py``) method for method, with ``await``."""

from __future__ import annotations

import asyncio
from types import TracebackType
from typing import Any, List, Mapping, Optional, Type, TypeVar, Union

import httpx

from . import _calls as calls
from ._core import (
    Call,
    PreparedRequest,
    interpret,
    may_retry,
    normalise_base_url,
    prepare,
    retry_delay,
    transport_error,
)
from ._webhook_input import HeadersLike, RawBody, body_to_bytes, content_type_of, single_valued
from .constants import DEFAULT_MAX_RETRIES, DEFAULT_RETRY_BACKOFF_SECONDS, DEFAULT_TIMEOUT_SECONDS
from .errors import SubscriptionsApiError, SubscriptionsTransportError
from .models import (
    CancelSubscriptionOptions,
    Capabilities,
    Charge,
    ChargeNotification,
    CheckoutResult,
    CheckoutVerification,
    CreateChargeInput,
    CreatePlanInput,
    CreateSubscriptionInput,
    Health,
    ListChargesOptions,
    NotifyChargeInput,
    OpenApiDocument,
    PauseSubscriptionOptions,
    Plan,
    Provider,
    Refund,
    RefundInput,
    ResumeSubscriptionOptions,
    Subscription,
    SubscriptionEvent,
    TickRequest,
    TickResult,
    UpdateSubscriptionInput,
    WebhookReceipt,
    WebhookRequest,
)

T = TypeVar("T")
Input = Mapping[str, Any]
Timeout = Union[float, httpx.Timeout]


class AsyncSubscriptionsClient:
    """The asyncio twin of ``SubscriptionsClient``: a typed client for the ``india-subscriptions`` HTTP service.

    Args:
        base_url: Where the service is mounted, e.g. ``"https://billing.internal"`` or
            ``"http://localhost:8080/billing"``. Routes are appended to it.
        api_key: The service's API key, sent as ``Authorization: Bearer <api_key>`` on every
            route that needs one. It is never put in an error message or in ``repr``.
        timeout: Seconds, or an ``httpx.Timeout``. The service may be waiting on a payment
            gateway, so the default is generous.
        max_retries: How many times a failed **GET** is repeated (network failure, or an
            error the service marks ``retryable``). Requests that are not GETs are *never*
            retried: a write that got no answer may already have happened.
        retry_backoff: Seconds before the first retry; doubles each time.
        transport: An ``httpx`` transport, e.g. ``httpx.MockTransport`` in tests.
        http_client: Your own ``httpx.AsyncClient``. You keep ownership and must close it.
            Give either ``transport`` or ``http_client``, not both.

    Every method returns a generated Pydantic model from ``india_subscriptions.models`` and
    raises ``SubscriptionsApiError`` or ``SubscriptionsTransportError``. Input parameters take
    the generated input model or a plain ``dict``.

    Use it as ``async with``, or call ``await aclose()``.
    """

    def __init__(
        self,
        base_url: str,
        api_key: str,
        *,
        timeout: Timeout = DEFAULT_TIMEOUT_SECONDS,
        max_retries: int = DEFAULT_MAX_RETRIES,
        retry_backoff: float = DEFAULT_RETRY_BACKOFF_SECONDS,
        transport: Optional[httpx.AsyncBaseTransport] = None,
        http_client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        if not api_key:
            raise ValueError("api_key must not be empty")
        if max_retries < 0:
            raise ValueError("max_retries must not be negative")
        if transport is not None and http_client is not None:
            raise ValueError("Pass transport or http_client, not both")
        self._base_url = normalise_base_url(base_url)
        self._api_key = api_key
        self._max_retries = max_retries
        self._retry_backoff = retry_backoff
        self._owns_http = http_client is None
        self._http = http_client if http_client is not None else httpx.AsyncClient(timeout=timeout, transport=transport)

        self.plans = PlansResource(self)
        self.subscriptions = SubscriptionsResource(self)
        self.charges = ChargesResource(self)
        self.checkout = CheckoutResource(self)
        self.webhooks = WebhooksResource(self)
        self.scheduler = SchedulerResource(self)

    def __repr__(self) -> str:
        return f"AsyncSubscriptionsClient(base_url={self._base_url!r})"

    async def __aenter__(self) -> "AsyncSubscriptionsClient":
        return self

    async def __aexit__(
        self,
        exc_type: Optional[Type[BaseException]],
        exc: Optional[BaseException],
        traceback: Optional[TracebackType],
    ) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        """Releases connections. A client you passed in as ``http_client`` is left open."""
        if self._owns_http:
            await self._http.aclose()

    # -- service-level operations -------------------------------------------------------------

    async def health(self) -> Health:
        """Liveness and the gateways the service is configured with. Needs no API key."""
        return await self._execute(calls.get_health())

    async def openapi(self) -> OpenApiDocument:
        """The service's own OpenAPI document. Needs no API key."""
        return await self._execute(calls.get_openapi())

    async def providers(self) -> List[Capabilities]:
        """What each configured gateway can do."""
        return await self._execute(calls.list_providers())

    async def capabilities(self, provider: Provider) -> Capabilities:
        """What one gateway can do, so callers never have to guess."""
        return await self._execute(calls.get_capabilities(provider))

    # -- plumbing -----------------------------------------------------------------------------

    async def _execute(self, call: Call[T]) -> T:
        request = prepare(self._base_url, self._api_key, call)
        attempt = 0
        while True:
            try:
                return interpret(call, await self._send(request))
            except (SubscriptionsApiError, SubscriptionsTransportError) as error:
                if not may_retry(request, error, attempt, self._max_retries):
                    raise
            await asyncio.sleep(retry_delay(attempt, self._retry_backoff))
            attempt += 1

    async def _send(self, request: PreparedRequest) -> httpx.Response:
        try:
            return await self._http.request(
                request.method.value,
                request.url,
                params=request.params,
                headers=request.headers,
                content=request.content,
            )
        except httpx.RequestError as exc:
            raise transport_error(exc, request) from exc


class _Resource:
    def __init__(self, client: AsyncSubscriptionsClient) -> None:
        self._client = client


class PlansResource(_Resource):
    async def create(self, provider: Provider, plan: Union[CreatePlanInput, Input]) -> Plan:
        """Creates a billing plan at the gateway, or registers it where the gateway has no plan object."""
        return await self._client._execute(calls.create_plan(provider, plan))

    async def get(self, provider: Provider, plan_id: str) -> Plan:
        return await self._client._execute(calls.get_plan(provider, plan_id))


class SubscriptionsResource(_Resource):
    async def create(self, provider: Provider, subscription: Union[CreateSubscriptionInput, Input]) -> Subscription:
        """Creates the subscription. The result carries ``checkout`` instructions for the customer."""
        return await self._client._execute(calls.create_subscription(provider, subscription))

    async def get(self, provider: Provider, subscription_id: str) -> Subscription:
        """The subscription with its current status."""
        return await self._client._execute(calls.get_subscription(provider, subscription_id))

    async def update(
        self, provider: Provider, subscription_id: str, changes: Union[UpdateSubscriptionInput, Input]
    ) -> Subscription:
        """Changes the plan, quantity, amount or dates of a subscription."""
        return await self._client._execute(calls.update_subscription(provider, subscription_id, changes))

    async def cancel(
        self,
        provider: Provider,
        subscription_id: str,
        options: Union[CancelSubscriptionOptions, Input, None] = None,
    ) -> Subscription:
        """Cancels now (the default) or at the end of the paid period."""
        return await self._client._execute(calls.cancel_subscription(provider, subscription_id, options))

    async def pause(
        self,
        provider: Provider,
        subscription_id: str,
        options: Union[PauseSubscriptionOptions, Input, None] = None,
    ) -> Subscription:
        """Stops charging until resumed."""
        return await self._client._execute(calls.pause_subscription(provider, subscription_id, options))

    async def resume(
        self,
        provider: Provider,
        subscription_id: str,
        options: Union[ResumeSubscriptionOptions, Input, None] = None,
    ) -> Subscription:
        """Resumes a paused subscription."""
        return await self._client._execute(calls.resume_subscription(provider, subscription_id, options))


class ChargesResource(_Resource):
    async def list(
        self,
        provider: Provider,
        subscription_id: str,
        options: Union[ListChargesOptions, Input, None] = None,
    ) -> List[Charge]:
        """The debits of a subscription, newest first where the gateway orders them. ``options.limit``: 1 to 100."""
        return await self._client._execute(calls.list_charges(provider, subscription_id, options))

    async def get(self, provider: Provider, subscription_id: str, charge_id: str) -> Charge:
        return await self._client._execute(calls.get_charge(provider, subscription_id, charge_id))

    async def create(self, provider: Provider, charge: Union[CreateChargeInput, Input]) -> Charge:
        """Raises a recurring debit against the mandate. With a billing scheduler configured you normally never call this.

        Not retried on failure. ``OUTCOME_UNKNOWN`` means the debit may have happened: read the
        subscription's charges before deciding to repeat it.
        """
        return await self._client._execute(calls.create_charge(provider, charge))

    async def notify(self, provider: Provider, notification: Union[NotifyChargeInput, Input]) -> ChargeNotification:
        """Sends the advance notice required before debiting a mandate."""
        return await self._client._execute(calls.notify_charge(provider, notification))

    async def refund(self, provider: Provider, refund: Union[RefundInput, Input]) -> Refund:
        """Refunds a charge in full or in part.

        Not retried on failure. ``OUTCOME_UNKNOWN`` means the refund may have happened: check the
        charge's ``refunded_amount`` before repeating it.
        """
        return await self._client._execute(calls.create_refund(provider, refund))


class CheckoutResource(_Resource):
    async def verify(self, provider: Provider, result: Union[CheckoutResult, Input]) -> CheckoutVerification:
        """Verifies what the gateway returned to the customer's browser after authorisation.

        ``result`` is the gateway's own data (Razorpay's checkout handler response, PayU's
        ``surl``/``furl`` parameters, Cashfree's return query), passed on untouched.
        """
        return await self._client._execute(calls.verify_checkout(provider, result))


class WebhooksResource(_Resource):
    async def parse(self, provider: Provider, request: Union[WebhookRequest, Input]) -> List[SubscriptionEvent]:
        """Has the service verify a gateway webhook's signature and return its normalised events.

        For raw bytes and framework headers, use ``india_subscriptions.webhooks.parse_webhook``.
        A bad signature raises ``SubscriptionsApiError`` with ``ErrorCode.SIGNATURE_INVALID``.
        """
        return await self._client._execute(calls.parse_webhook(provider, request))

    async def receive(self, provider: Provider, raw_body: RawBody, headers: Union[HeadersLike, Mapping[str, Any]]) -> WebhookReceipt:
        """Posts a gateway webhook to the service's own webhook URL, as the gateway would.

        The service authenticates it by the gateway's signature, so no API key is sent. The body goes
        through byte for byte, with the gateway's headers.
        """
        forwarded = single_valued(headers)
        return await self._client._execute(
            calls.receive_webhook(provider, body_to_bytes(raw_body), forwarded, content_type_of(forwarded))
        )


class SchedulerResource(_Resource):
    async def tick(self, options: Union[TickRequest, Input, None] = None) -> TickResult:
        """Runs the billing scheduler once: raises the debits that are due. Needs a scheduler on the service.

        Not retried on failure: some debits may already have been raised.
        """
        return await self._client._execute(calls.run_scheduler_tick(options))


__all__ = [
    "AsyncSubscriptionsClient",
    "PlansResource",
    "SubscriptionsResource",
    "ChargesResource",
    "CheckoutResource",
    "WebhooksResource",
    "SchedulerResource",
]
