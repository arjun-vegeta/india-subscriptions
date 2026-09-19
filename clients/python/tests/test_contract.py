"""The client cannot silently fall behind the OpenAPI document.

``openapi/openapi.json`` is generated from the TypeScript Zod schemas. These tests read it and check
that the client implements every operation, with the method, route and authentication the document
declares, and that every request the client really makes matches a route in the document.
"""

from __future__ import annotations

import inspect
import json
import re
from pathlib import Path
from typing import Any, Dict, List, Pattern, Tuple

import pytest

from india_subscriptions import AsyncSubscriptionsClient, ErrorCode, SubscriptionsClient
from india_subscriptions.constants import (
    API_PREFIX,
    CLIENT_METHODS,
    ROUTES,
    ApiPath,
    AuthMode,
    HttpMethod,
    OperationId,
    PathParam,
    QueryParam,
)

from .cases import CASES, Case, case_id
from .conftest import Recorder, json_response, run, ClientKind

SPEC_PATH = Path(__file__).resolve().parents[3] / "openapi" / "openapi.json"
HTTP_METHODS = {method.value.lower() for method in HttpMethod}
SECURITY_KEY = "security"
PARAMETERS_KEY = "parameters"
PLACEHOLDER = re.compile(r"\{([^}]+)\}")


def load_spec() -> Dict[str, Any]:
    spec = json.loads(SPEC_PATH.read_text(encoding="utf-8"))
    assert isinstance(spec, dict)
    return spec


SPEC = load_spec()


def spec_operations() -> Dict[str, Tuple[HttpMethod, str, Dict[str, Any]]]:
    found: Dict[str, Tuple[HttpMethod, str, Dict[str, Any]]] = {}
    for path, item in SPEC["paths"].items():
        for method, operation in item.items():
            if method in HTTP_METHODS:
                assert operation["operationId"] not in found, "operationId must be unique"
                found[operation["operationId"]] = (HttpMethod(method.upper()), path, operation)
    return found


SPEC_OPERATIONS = spec_operations()


def spec_requires_bearer(operation: Dict[str, Any]) -> bool:
    return bool(operation.get(SECURITY_KEY, SPEC.get(SECURITY_KEY)))


def test_the_spec_is_the_one_this_client_was_written_for() -> None:
    assert SPEC["openapi"].startswith("3.1")
    assert all(path.startswith(API_PREFIX + "/") for path in SPEC["paths"])


def test_every_operation_id_in_the_spec_is_known_to_the_client() -> None:
    assert set(SPEC_OPERATIONS) == {operation.value for operation in OperationId}


def test_every_operation_has_a_route_and_a_client_method() -> None:
    assert set(ROUTES) == set(OperationId)
    assert set(CLIENT_METHODS) == set(OperationId)


@pytest.mark.parametrize("operation", list(OperationId), ids=lambda operation: operation.value)
def test_method_path_and_auth_match_the_spec(operation: OperationId) -> None:
    method, path, spec_operation = SPEC_OPERATIONS[operation.value]
    route = ROUTES[operation]

    assert route.method is method
    assert route.path == path
    assert (route.auth is AuthMode.BEARER) == spec_requires_bearer(spec_operation)
    if route.auth is AuthMode.SIGNATURE:
        assert spec_operation[SECURITY_KEY] == []  # no API key: the gateway's signature authenticates it


@pytest.mark.parametrize("operation", list(OperationId), ids=lambda operation: operation.value)
def test_parameters_match_the_spec(operation: OperationId) -> None:
    _, path, spec_operation = SPEC_OPERATIONS[operation.value]
    declared = spec_operation.get(PARAMETERS_KEY, [])
    path_params = {item["name"] for item in declared if item["in"] == "path"}
    query_params = {item["name"] for item in declared if item["in"] == "query"}

    assert path_params == set(PLACEHOLDER.findall(path))
    assert path_params <= {param.value for param in PathParam}
    assert query_params <= {param.value for param in QueryParam}


def test_all_placeholders_in_the_constants_are_path_params() -> None:
    names = {param.value for param in PathParam}
    for template in (value for key, value in vars(ApiPath).items() if key.isupper()):
        assert set(PLACEHOLDER.findall(template)) <= names


def resolve(client: Any, dotted: str) -> Any:
    target = client
    for part in dotted.split("."):
        target = getattr(target, part)
    return target


@pytest.mark.parametrize("operation", list(OperationId), ids=lambda operation: operation.value)
@pytest.mark.parametrize("client_class", [SubscriptionsClient, AsyncSubscriptionsClient], ids=lambda cls: cls.__name__)
def test_the_client_implements_every_operation(operation: OperationId, client_class: Any) -> None:
    client = client_class("http://localhost", "key")
    method = resolve(client, CLIENT_METHODS[operation])
    assert callable(method)
    assert inspect.iscoroutinefunction(method) == (client_class is AsyncSubscriptionsClient)


def spec_matchers() -> List[Tuple[HttpMethod, Pattern[str], str]]:
    matchers = []
    for method, path, operation in SPEC_OPERATIONS.values():
        pattern = re.compile("^" + PLACEHOLDER.sub(r"[^/]+", re.escape(path).replace(r"\{", "{").replace(r"\}", "}")) + "$")
        matchers.append((method, pattern, operation["operationId"]))
    return matchers


@pytest.mark.parametrize("case", CASES, ids=case_id)
async def test_the_requests_the_client_makes_exist_in_the_spec(case: Case) -> None:
    recorder = Recorder(json_response(case.status, case.response))

    await run(ClientKind.SYNC, recorder, case.call)

    request = recorder.last
    hits = [
        operation_id
        for method, pattern, operation_id in spec_matchers()
        if method.value == request.method and pattern.match(request.url.path)
    ]
    assert hits == [case.operation.value]


def test_query_parameters_the_client_sends_are_declared() -> None:
    declared = {
        item["name"]
        for _, _, operation in SPEC_OPERATIONS.values()
        for item in operation.get(PARAMETERS_KEY, [])
        if item["in"] == "query"
    }
    sent = {name for case in CASES for name in case.query}
    assert sent <= declared


def success_schema_name(operation: Dict[str, Any]) -> str:
    """The component the spec names for the operation's 2xx body (an array's item type for lists)."""
    for status, response in operation["responses"].items():
        if status.startswith("2"):
            schema = response["content"]["application/json"]["schema"]
            reference = schema.get("items", schema)["$ref"]
            return str(reference).rsplit("/", 1)[-1]
    raise AssertionError("no success response")


@pytest.mark.parametrize("case", CASES, ids=case_id)
async def test_the_client_returns_the_type_the_spec_names(case: Case) -> None:
    recorder = Recorder(json_response(case.status, case.response))

    result = await run(ClientKind.SYNC, recorder, case.call)

    item = result[0] if isinstance(result, list) else result
    assert type(item).__name__ == success_schema_name(SPEC_OPERATIONS[case.operation.value][2])


def test_the_documented_error_body_is_the_one_the_client_parses() -> None:
    schema = SPEC["components"]["schemas"]["ErrorResponse"]["properties"]["error"]
    assert set(schema["properties"]) == {"code", "message", "provider", "httpStatus", "providerCode", "retryable"}
    assert set(schema["required"]) == {"code", "message", "retryable"}
    assert {code.value for code in ErrorCode} == set(schema["properties"]["code"]["enum"])
