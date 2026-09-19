"""No bare route, header, method, operation id or enum value in the client's code or the tests' paths.

The rule (CONTRIBUTING.md, rule 1, in Python): anything that carries meaning is a named constant.
Every route, header name, operation id and API prefix lives in ``constants.py``; enum values come only
from the generated enums. This test reads the source and fails on a string literal that equals one.
"""

from __future__ import annotations

import ast
from enum import Enum
from pathlib import Path
from typing import Iterator, Set, Tuple

import pytest

from india_subscriptions import constants, models
from india_subscriptions.constants import API_PREFIX, ApiPath

PACKAGE = Path(constants.__file__).parent
TESTS = Path(__file__).parent
EXEMPT_PACKAGE_FILES = {"constants.py", "models.py", "version.py"}
GENERIC_WORDS = {"", "id", "name", "message", "code", "provider", "limit"}  # ordinary words that are also enum values


def enum_values() -> Set[str]:
    values: Set[str] = set()
    for module in (models, constants):
        for member in vars(module).values():
            if isinstance(member, type) and issubclass(member, Enum) and member.__module__ == module.__name__:
                values |= {str(item.value) for item in member if isinstance(item.value, str)}
    values |= {value for key, value in vars(ApiPath).items() if key.isupper()}
    values.add(API_PREFIX)
    return values - GENERIC_WORDS


def literals(path: Path) -> Iterator[Tuple[int, str]]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    docstrings = {
        id(node.body[0].value)
        for node in ast.walk(tree)
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))
        and node.body
        and isinstance(node.body[0], ast.Expr)
        and isinstance(node.body[0].value, ast.Constant)
    }
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docstrings:
            yield node.lineno, node.value


@pytest.mark.parametrize(
    "path", sorted(p for p in PACKAGE.glob("*.py") if p.name not in EXEMPT_PACKAGE_FILES), ids=lambda p: p.name
)
def test_client_code_has_no_bare_constants(path: Path) -> None:
    forbidden = enum_values()
    offenders = [(line, text) for line, text in literals(path) if text in forbidden or text.startswith(API_PREFIX)]
    assert offenders == [], f"{path.name}: use the named constant instead of {offenders}"


@pytest.mark.parametrize("path", sorted(TESTS.glob("*.py")), ids=lambda p: p.name)
def test_tests_do_not_spell_out_paths_or_provider_names(path: Path) -> None:
    provider_names = {str(provider.value) for provider in models.Provider}
    offenders = [
        (line, text)
        for line, text in literals(path)
        if text.startswith(API_PREFIX) or text in provider_names
    ]
    assert offenders == [], f"{path.name}: build paths from ApiPath and use Provider members: {offenders}"
