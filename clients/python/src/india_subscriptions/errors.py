"""The two exceptions the client raises, and the enum of error codes.

``SubscriptionsApiError``
    The service answered, and the answer was an error (or was not the documented success
    shape). Branch on ``code``, never on ``message``.
``SubscriptionsTransportError``
    No usable answer arrived: connection refused, DNS failure, timeout, broken stream.

Both derive from ``SubscriptionsError``. Mistakes in the arguments you pass (a dict that
does not validate against the input model) raise ``pydantic.ValidationError`` before any
request is made.
"""

from __future__ import annotations

from typing import Optional

from .constants import ERROR_BODY_SNIPPET_CHARS, HttpMethod
from .models import ErrorResponse, ErrorResponseErrorCode, Provider

ErrorCode = ErrorResponseErrorCode
"""Every code the service can return: the library's codes plus the service's own
(``UNAUTHORIZED``, ``METHOD_NOT_ALLOWED``, ``PAYLOAD_TOO_LARGE``, ``INTERNAL_ERROR``).
This is the generated enum, under a readable name."""


class SubscriptionsError(Exception):
    """Base class of everything this client raises on purpose."""


class SubscriptionsApiError(SubscriptionsError):
    """The service returned an error, or a body that is not the documented shape.

    Attributes:
        code: What went wrong. For a body that is not the documented error shape (an HTML page
            from a proxy, an empty body, a success body that fails its schema) this is
            ``ErrorCode.UNEXPECTED_RESPONSE`` and ``documented_shape`` is ``False``.
        message: Human readable. May change between releases.
        provider: The gateway the failing call was for, when the service says.
        http_status: The *gateway's* HTTP status when it answered (the body's ``httpStatus``).
            This is not the status of the service's own response: see ``status_code``.
        provider_code: The gateway's own error code, verbatim.
        retryable: True when repeating the same call later is safe and may succeed.
        status_code: The HTTP status of the service's response.
        documented_shape: True when the body parsed as the service's documented error body.
        response_body: The start of the response body, for diagnosing undocumented answers.

    ``ErrorCode.OUTCOME_UNKNOWN`` deserves special care. A money-moving request was sent to
    the gateway and no (or a server-error) answer came back. The charge, refund or
    subscription change **may or may not have happened**. Do not repeat the call: fetch the
    current state first (``subscriptions.get``, ``charges.list``, ...) and act on what you
    find. This client never retries a request that is not a GET, so the decision is yours.
    """

    def __init__(
        self,
        code: ErrorCode,
        message: str,
        *,
        status_code: int,
        provider: Optional[Provider] = None,
        http_status: Optional[int] = None,
        provider_code: Optional[str] = None,
        retryable: bool = False,
        documented_shape: bool = True,
        response_body: str = "",
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.provider = provider
        self.http_status = http_status
        self.provider_code = provider_code
        self.retryable = retryable
        self.status_code = status_code
        self.documented_shape = documented_shape
        self.response_body = response_body

    @property
    def outcome_unknown(self) -> bool:
        """True for ``OUTCOME_UNKNOWN``: the write may or may not have taken effect."""
        return self.code is ErrorCode.OUTCOME_UNKNOWN

    def __str__(self) -> str:
        return f"{self.code.value}: {self.message} (HTTP {self.status_code})"

    def __repr__(self) -> str:
        return (
            f"SubscriptionsApiError(code={self.code.value!r}, status_code={self.status_code}, "
            f"retryable={self.retryable}, message={self.message!r})"
        )

    @classmethod
    def from_error_body(cls, body: ErrorResponse, *, status_code: int, response_body: str) -> SubscriptionsApiError:
        """Builds the error from the service's documented error body."""
        error = body.error
        return cls(
            error.code,
            error.message,
            status_code=status_code,
            provider=error.provider,
            http_status=error.http_status,
            provider_code=error.provider_code,
            retryable=error.retryable,
            documented_shape=True,
            response_body=response_body[:ERROR_BODY_SNIPPET_CHARS],
        )

    @classmethod
    def unexpected(cls, message: str, *, status_code: int, response_body: str, retryable: bool = False) -> SubscriptionsApiError:
        """Builds the error for an answer that is not the documented shape."""
        return cls(
            ErrorCode.UNEXPECTED_RESPONSE,
            message,
            status_code=status_code,
            retryable=retryable,
            documented_shape=False,
            response_body=response_body[:ERROR_BODY_SNIPPET_CHARS],
        )


class SubscriptionsTransportError(SubscriptionsError):
    """No answer from the service: the network failed or the request timed out.

    Attributes:
        method: The HTTP method of the failed request.
        url: The URL without its query string.
        timed_out: True when a timeout fired.
        request_sent: False when the request provably never left this machine (connection
            refused, DNS failure, connect timeout); True when it may have reached the service.
        outcome_unknown: True when the request was not a GET and may have been sent. The
            service may have carried it out: fetch the current state before retrying.

    The underlying ``httpx`` exception is chained as ``__cause__``.
    """

    def __init__(
        self,
        message: str,
        *,
        method: HttpMethod,
        url: str,
        timed_out: bool = False,
        request_sent: bool = True,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.method = method
        self.url = url
        self.timed_out = timed_out
        self.request_sent = request_sent

    @property
    def outcome_unknown(self) -> bool:
        return self.request_sent and self.method is not HttpMethod.GET
