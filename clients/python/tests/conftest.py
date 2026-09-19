"""Shared test plumbing: one scripted ``httpx.MockTransport`` driven through the sync or the async client."""

from __future__ import annotations

import inspect
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Union

import httpx

from india_subscriptions import AsyncSubscriptionsClient, SubscriptionsClient

API_KEY = "test-api-key-0123456789"
BASE_URL = "http://service.test"

Step = Union[httpx.Response, Exception]
Responder = Callable[[httpx.Request], httpx.Response]


class ClientKind(Enum):
    SYNC = "sync"
    ASYNC = "async"


BOTH_KINDS = [ClientKind.SYNC, ClientKind.ASYNC]


def _fresh(response: httpx.Response) -> httpx.Response:
    """A copy, so one scripted response can be served to a sync and an async client (a stream is read once)."""
    return httpx.Response(response.status_code, headers=response.headers, content=response.content)


class Recorder:
    """A mock transport handler that records every request and answers from a script.

    Give it one ``Responder``, or a list of steps (responses, or exceptions to raise) consumed in order;
    the last step repeats.
    """

    def __init__(self, script: Union[Responder, httpx.Response, List[Step]]) -> None:
        self.requests: List[httpx.Request] = []
        self._script = script
        self._position = 0

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        script = self._script
        if callable(script):
            return script(request)
        if isinstance(script, httpx.Response):
            return _fresh(script)
        step = script[min(self._position, len(script) - 1)]
        self._position += 1
        if isinstance(step, Exception):
            raise step
        return _fresh(step)

    @property
    def last(self) -> httpx.Request:
        return self.requests[-1]


def json_response(status: int, body: Any, headers: Optional[Dict[str, str]] = None) -> httpx.Response:
    return httpx.Response(status, json=body, headers=headers)


def make_client(
    kind: ClientKind, recorder: Recorder, base_url: str = BASE_URL, **options: Any
) -> Union[SubscriptionsClient, AsyncSubscriptionsClient]:
    options.setdefault("max_retries", 0)
    options.setdefault("retry_backoff", 0.0)
    transport = httpx.MockTransport(recorder)
    if kind is ClientKind.SYNC:
        return SubscriptionsClient(base_url, API_KEY, transport=transport, **options)
    return AsyncSubscriptionsClient(base_url, API_KEY, transport=transport, **options)


async def run(kind: ClientKind, recorder: Recorder, call: Callable[[Any], Any], **options: Any) -> Any:
    """Runs ``call(client)`` against a client of the given kind, awaiting the async one."""
    client = make_client(kind, recorder, **options)
    try:
        result = call(client)
        if inspect.isawaitable(result):
            result = await result
        return result
    finally:
        closing = client.aclose() if isinstance(client, AsyncSubscriptionsClient) else client.close()
        if inspect.isawaitable(closing):
            await closing
