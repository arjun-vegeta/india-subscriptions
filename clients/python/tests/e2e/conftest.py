"""Starts the real TypeScript service (tests/e2e/fixture_server.ts) once per test session."""

from __future__ import annotations

import os
import queue
import secrets
import shutil
import subprocess
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Iterator, Optional

import pytest

REPO_ROOT = Path(__file__).resolve().parents[4]
FIXTURE = Path(__file__).with_name("fixture_server.ts")
STARTUP_TIMEOUT_SECONDS = 60.0
HOST = "127.0.0.1"


@dataclass(frozen=True)
class Service:
    base_url: str
    api_key: str
    webhook_secret: str


def _first_line(stream: IO[str], lines: "queue.Queue[str]") -> None:
    lines.put(stream.readline())


@pytest.fixture(scope="session")
def service() -> Iterator[Service]:
    npx = shutil.which("npx")
    if shutil.which("node") is None or npx is None:
        pytest.skip("node/npx are not available: the end-to-end tests drive the real TypeScript service")
    if not (REPO_ROOT / "node_modules" / ".bin" / "tsx").exists():
        pytest.skip(f"tsx is not installed in {REPO_ROOT} (run `npm install` there)")

    api_key = secrets.token_hex(16)
    webhook_secret = secrets.token_hex(16)
    env = {**os.environ, "E2E_API_KEY": api_key, "E2E_WEBHOOK_SECRET": webhook_secret}
    with tempfile.TemporaryFile(mode="w+") as stderr:
        process = subprocess.Popen(
            [npx, "--no-install", "tsx", str(FIXTURE)],
            cwd=REPO_ROOT,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=stderr,
            text=True,
        )
        try:
            assert process.stdout is not None
            lines: "queue.Queue[str]" = queue.Queue()
            threading.Thread(target=_first_line, args=(process.stdout, lines), daemon=True).start()
            port: Optional[int] = None
            try:
                line = lines.get(timeout=STARTUP_TIMEOUT_SECONDS)
                port = int(line.strip()) if line.strip().isdigit() else None
            except queue.Empty:
                line = ""
            if port is None:
                process.kill()
                stderr.seek(0)
                pytest.fail(f"the fixture server did not print its port (got {line!r}):\n{stderr.read()}")
            yield Service(f"http://{HOST}:{port}", api_key, webhook_secret)
        finally:
            if process.stdin:
                process.stdin.close()  # the fixture exits when stdin closes
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
