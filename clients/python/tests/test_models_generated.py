"""models.py must be exactly what scripts/generate_models.sh produces from openapi/openapi.json."""

from __future__ import annotations

import difflib
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "generate_models.sh"
COMMITTED = ROOT / "src" / "india_subscriptions" / "models.py"
GENERATOR = Path(sys.executable).parent / "datamodel-codegen"
HEADER_START = "# GENERATED FILE - DO NOT EDIT."


def test_the_committed_models_are_what_the_generator_produces(tmp_path: Path) -> None:
    if not GENERATOR.exists() and not any(
        (Path(directory) / "datamodel-codegen").exists() for directory in os.environ.get("PATH", "").split(os.pathsep)
    ):
        pytest.fail('datamodel-codegen is not installed: pip install -e ".[dev]" (it is pinned there)')
    regenerated = tmp_path / "models.py"
    env = {**os.environ, "PATH": f"{GENERATOR.parent}{os.pathsep}{os.environ.get('PATH', '')}"}

    result = subprocess.run(["bash", str(SCRIPT), str(regenerated)], capture_output=True, text=True, env=env, check=False)

    assert result.returncode == 0, result.stderr
    expected = regenerated.read_text(encoding="utf-8")
    actual = COMMITTED.read_text(encoding="utf-8")
    diff = "".join(
        difflib.unified_diff(
            actual.splitlines(keepends=True), expected.splitlines(keepends=True), "committed models.py", "regenerated", n=2
        )
    )
    assert actual == expected, f"models.py has drifted from openapi/openapi.json or was edited by hand:\n{diff[:3000]}"


def test_the_committed_file_says_it_is_generated() -> None:
    assert COMMITTED.read_text(encoding="utf-8").startswith(HEADER_START)
