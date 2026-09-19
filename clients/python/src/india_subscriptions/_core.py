"""The sans-IO half of the client: build a request from a ``Call``, interpret a response.

``SubscriptionsClient`` and ``AsyncSubscriptionsClient`` differ only in how bytes move; both
use this module for everything else, so they cannot drift apart.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Generic, Mapping, Optional, Tuple, Type, TypeVar, Union
from urllib.parse import quote

import httpx
from pydantic import BaseModel, TypeAdapter, ValidationError

from .constants import (
    BEARER_SCHEME,
    NON_FORWARDED_HEADERS,
    PACKAGE_NAME,
    RETRYABLE_STATUSES,
    AuthMode,
    ContentType,
    HeaderName,
    HttpMethod,
    PathParam,
    QueryParam,
    Route,
)
from .errors import SubscriptionsApiError, SubscriptionsTransportError
from .models import ErrorResponse
from .version import __version__

T = TypeVar("T")
M = TypeVar("M", bound=BaseModel)

USER_AGENT = f"{PACKAGE_NAME}-python/{__version__}"

#: ``httpx`` failures that happen before any byte of the request can have left this machine.
_NEVER_SENT = (
    httpx.ConnectError,
    httpx.ConnectTimeout,
    httpx.PoolTimeout,
    httpx.UnsupportedProtocol,
    httpx.ProxyError,
)

_MAX_ERRORS_SHOWN = 3


@dataclass(frozen=True)
class Call(Generic[T]):
    """One operation, fully specified and not yet sent."""

    route: Route
    adapter: "TypeAdapter[T]"
    path_params: Mapping[PathParam, str] = field(default_factory=dict)
    query: Mapping[QueryParam, str] = field(default_factory=dict)
    body: Optional[bytes] = None
    #: Sent as ``Content-Type`` when there is a body. Webhook forwarding sets the gateway's own.
    content_type: str = ContentType.JSON.value
    #: Extra request headers (forwarded webhook headers).
    headers: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class PreparedRequest:
    method: HttpMethod
    url: str
    params: Dict[str, str]
    headers: Dict[str, str]
    content: Optional[bytes]


def coerce(model: Type[M], value: Union[M, Mapping[str, Any]]) -> M:
    """A model instance as is; a mapping validated into the model (``pydantic.ValidationError`` if it does not fit)."""
    if isinstance(value, model):
        return value
    return model.model_validate(dict(value))


def dump_request(model: BaseModel) -> bytes:
    """JSON for a request body: JSON field names (aliases), only what the caller set, no nulls."""
    return model.model_dump_json(by_alias=True, exclude_unset=True, exclude_none=True).encode("utf-8")


def dump_untouched(model: BaseModel) -> bytes:
    """JSON for a body the service must see exactly as given (the gateway's checkout result)."""
    return model.model_dump_json().encode("utf-8")


def render_path(template: str, params: Mapping[PathParam, str]) -> str:
    """Fills ``{placeholders}``, percent-encoding every value so an id can never change the route."""
    values: Dict[str, str] = {}
    for name, value in params.items():
        if value == "":
            raise ValueError(f"{name.value} must not be empty")
        values[name.value] = quote(value, safe="")
    return template.format_map(values)


def prepare(base_url: str, api_key: str, call: Call[Any]) -> PreparedRequest:
    route = call.route
    headers: Dict[str, str] = {
        HeaderName.ACCEPT.value: ContentType.JSON.value,
        HeaderName.USER_AGENT.value: USER_AGENT,
    }
    if route.auth is AuthMode.BEARER:
        headers[HeaderName.AUTHORIZATION.value] = f"{BEARER_SCHEME} {api_key}"
    if call.body is not None:
        headers[HeaderName.CONTENT_TYPE.value] = call.content_type
    for name, value in call.headers.items():
        lowered = name.lower()
        if lowered not in NON_FORWARDED_HEADERS:
            headers[lowered] = value
    return PreparedRequest(
        method=route.method,
        url=base_url + render_path(route.path, call.path_params),
        params={name.value: value for name, value in call.query.items()},
        headers=headers,
        content=call.body,
    )


def normalise_base_url(base_url: str) -> str:
    stripped = base_url.strip().rstrip("/")
    if not stripped:
        raise ValueError("base_url must not be empty")
    if not stripped.lower().startswith(("http://", "https://")):
        raise ValueError(f"base_url must start with http:// or https://, got {base_url!r}")
    return stripped


def _summarise(error: ValidationError) -> str:
    shown = []
    for item in error.errors(include_url=False, include_context=False, include_input=False)[:_MAX_ERRORS_SHOWN]:
        where = ".".join(str(part) for part in item["loc"]) or "(root)"
        shown.append(f"{where}: {item['msg']}")
    extra = error.error_count() - len(shown)
    return "; ".join(shown) + (f"; and {extra} more" if extra > 0 else "")


def interpret(call: Call[T], response: httpx.Response) -> T:
    """The parsed result of a 2xx answer, or a ``SubscriptionsApiError``. Never a bare ``ValidationError``."""
    status = response.status_code
    content = response.content
    if 200 <= status < 300:
        try:
            return call.adapter.validate_json(content)
        except ValidationError as exc:
            raise SubscriptionsApiError.unexpected(
                f"{call.route.operation_id.value} answered HTTP {status} with a body that does not match the "
                f"documented response ({_summarise(exc)})",
                status_code=status,
                response_body=response.text,
            ) from exc
    try:
        body = ErrorResponse.model_validate_json(content)
    except ValidationError as exc:
        raise SubscriptionsApiError.unexpected(
            f"{call.route.operation_id.value} answered HTTP {status} with a body that is not the documented "
            f"error shape ({_summarise(exc)})",
            status_code=status,
            response_body=response.text,
            retryable=status in RETRYABLE_STATUSES,
        ) from exc
    raise SubscriptionsApiError.from_error_body(body, status_code=status, response_body=response.text)


def transport_error(exc: httpx.RequestError, request: PreparedRequest) -> SubscriptionsTransportError:
    timed_out = isinstance(exc, httpx.TimeoutException)
    reason = str(exc) or type(exc).__name__
    return SubscriptionsTransportError(
        f"{request.method.value} {request.url} failed: {'timed out' if timed_out else type(exc).__name__}: {reason}",
        method=request.method,
        url=request.url,
        timed_out=timed_out,
        request_sent=not isinstance(exc, _NEVER_SENT),
    )


def retry_delay(attempt: int, backoff: float) -> float:
    return backoff * (2**attempt)


def may_retry(
    request: PreparedRequest, error: Union[SubscriptionsApiError, SubscriptionsTransportError], attempt: int, max_retries: int
) -> bool:
    """Only a GET is ever repeated: a write that got no answer may already have happened."""
    if request.method is not HttpMethod.GET or attempt >= max_retries:
        return False
    if isinstance(error, SubscriptionsTransportError):
        return True
    return error.retryable


def request_args(request: PreparedRequest) -> Tuple[str, str]:
    """``(method, url)`` as plain strings for ``httpx``."""
    return request.method.value, request.url
