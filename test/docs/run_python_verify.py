"""Runs the documentation's Python events-signature sample on one case read from stdin (JSON)."""
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("sample", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
case = json.load(sys.stdin)
try:
    module.verify_events_signature(case["secret"], case["body"].encode(), case["headers"], now=case["now"])
    print("OK")
except ValueError as error:
    print(f"ERROR: {error}")
