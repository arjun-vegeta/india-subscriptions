"""Turning what a web framework hands you (raw body, headers) into what the service takes."""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Mapping, Protocol, Sequence, Tuple, Union

from .constants import ContentType, HeaderName
from .models import WebhookRequest

RawBody = Union[bytes, bytearray, memoryview, str]


class HeadersLike(Protocol):
    """Any headers object with ``items()``: a ``dict``, Starlette/FastAPI ``request.headers``,
    Flask/Werkzeug ``request.headers``, ``http.client.HTTPMessage``, ``httpx.Headers``."""

    def items(self) -> Iterable[Tuple[str, Any]]: ...


def body_to_text(raw_body: RawBody) -> str:
    """The body as the exact string the gateway signed. Bytes are decoded as UTF-8 and nothing else is done to them.

    The service takes the body as a JSON string, so it has to be valid UTF-8. A byte-order mark is kept,
    not stripped, because the gateway's signature covers it.
    """
    if isinstance(raw_body, str):
        return raw_body
    try:
        return bytes(raw_body).decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError(
            "The webhook body is not valid UTF-8, so it cannot be forwarded to the service unchanged. "
            "Pass the raw request bytes, not a re-encoded copy."
        ) from exc


def body_to_bytes(raw_body: RawBody) -> bytes:
    """The body as bytes, unchanged (a ``str`` is encoded as UTF-8)."""
    return raw_body.encode("utf-8") if isinstance(raw_body, str) else bytes(raw_body)


def normalise_headers(headers: Union[HeadersLike, Mapping[str, Any]]) -> Dict[str, Union[str, List[str]]]:
    """Lower-cased names; a header that appears more than once becomes a list, in order."""
    merged: Dict[str, List[str]] = {}
    for name, value in headers.items():
        values: Sequence[str] = [value] if isinstance(value, str) else [str(item) for item in value]
        merged.setdefault(name.lower(), []).extend(values)
    return {name: values[0] if len(values) == 1 else values for name, values in merged.items()}


def build_webhook_request(raw_body: RawBody, headers: Union[HeadersLike, Mapping[str, Any]]) -> WebhookRequest:
    """The service's ``WebhookRequest``: the body byte for byte, the headers by lower-case name."""
    return WebhookRequest(raw_body=body_to_text(raw_body), headers=normalise_headers(headers))


def single_valued(headers: Union[HeadersLike, Mapping[str, Any]]) -> Dict[str, str]:
    """Headers for a forwarded request: one string per name (repeated headers joined with ``, ``)."""
    return {
        name: value if isinstance(value, str) else ", ".join(value) for name, value in normalise_headers(headers).items()
    }


def content_type_of(headers: Mapping[str, str]) -> str:
    return headers.get(HeaderName.CONTENT_TYPE.value, ContentType.JSON.value)
