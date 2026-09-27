"""Checks one documentation sample: every name it imports from the `india_subscriptions` client must exist.

Usage: python python_check.py sample.py   (exit 0 when the sample's imports are all real)
Third-party imports (fastapi, flask, ...) are not checked: they need not be installed to read the documentation.
"""
import ast
import importlib
import sys

path = sys.argv[1]
tree = ast.parse(open(path).read(), path)
problems = []
for node in ast.walk(tree):
    if isinstance(node, ast.ImportFrom) and node.module and node.module.split(".")[0] == "india_subscriptions":
        module = importlib.import_module(node.module)
        for alias in node.names:
            if alias.name != "*" and not hasattr(module, alias.name):
                try:
                    importlib.import_module(f"{node.module}.{alias.name}")
                except ImportError:
                    problems.append(f"{node.module} has no name {alias.name}")
    elif isinstance(node, ast.Import):
        for alias in node.names:
            if alias.name.split(".")[0] == "india_subscriptions":
                try:
                    importlib.import_module(alias.name)
                except ImportError:
                    problems.append(f"cannot import {alias.name}")
if problems:
    print("\n".join(problems))
    sys.exit(1)
