"""Webhook helpers for Python web frameworks.

A payment gateway posts webhooks to *your* app. This module hands the exact raw request body and
the headers to the service, which verifies the gateway's signature and returns normalised events::

    events = parse_webhook(client, Provider.RAZORPAY, request_body_bytes, request_headers)

The body must be forwarded byte for byte: the signature is computed over the exact bytes the gateway
sent, so never pass a body you have parsed and re-serialised. Read the raw bytes (``await request.body()``
in FastAPI, ``request.get_data()`` in Flask) before anything touches the JSON. A bad signature raises
``SubscriptionsApiError`` with ``ErrorCode.SIGNATURE_INVALID`` (HTTP 401 from the service).
"""

from __future__ import annotations

from typing import Any, List, Mapping, Union

from ._webhook_input import HeadersLike, RawBody, body_to_text, build_webhook_request, normalise_headers
from .async_client import AsyncSubscriptionsClient
from .client import SubscriptionsClient
from .models import Provider, SubscriptionEvent, WebhookRequest


def parse_webhook(
    client: SubscriptionsClient,
    provider: Provider,
    raw_body: RawBody,
    headers: Union[HeadersLike, Mapping[str, Any]],
) -> List[SubscriptionEvent]:
    """Verifies and normalises a gateway webhook through the service (``POST /v1/{provider}/webhooks/parse``).

    Args:
        client: A ``SubscriptionsClient``.
        provider: The gateway that sent the webhook.
        raw_body: The request body exactly as received (``bytes``, or the ``str`` it decodes to).
        headers: The request headers: any mapping or headers object with ``items()``. Names are
            lower-cased; a header that appears twice is forwarded as a list.
    """
    return client.webhooks.parse(provider, build_webhook_request(raw_body, headers))


async def parse_webhook_async(
    client: AsyncSubscriptionsClient,
    provider: Provider,
    raw_body: RawBody,
    headers: Union[HeadersLike, Mapping[str, Any]],
) -> List[SubscriptionEvent]:
    """The same as ``parse_webhook``, for ``AsyncSubscriptionsClient``."""
    return await client.webhooks.parse(provider, build_webhook_request(raw_body, headers))


__all__ = [
    "HeadersLike",
    "WebhookRequest",
    "body_to_text",
    "build_webhook_request",
    "normalise_headers",
    "parse_webhook",
    "parse_webhook_async",
]
