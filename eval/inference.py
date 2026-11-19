"""Launch a local llama.cpp server for deterministic offline evaluation."""
import contextlib
import json
import secrets
import socket
import subprocess
import time
import urllib.error
import urllib.request
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str,
                         headers: Any, newurl: str) -> None:
        return None


@dataclass(frozen=True)
class Client:
    port: int
    key: str

    def request(self, path: str, body: dict[str, Any] | None = None,
                timeout: float = 120) -> dict[str, Any]:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=None if body is None else json.dumps(body).encode(),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.key}"},
        )
        with opener.open(request, timeout=timeout) as response:
            result: dict[str, Any] = json.load(response)
            return result

    def complete(self, prompt: str, max_tokens: int = 256, extra_stop: tuple[str, ...] = ()) -> str:
        result = self.request("/v1/completions", {
            "prompt": prompt, "temperature": 0, "seed": 0, "max_tokens": max_tokens,
            "stop": ["<|endoftext|>", "<|fim_prefix|>", "<|fim_suffix|>", "<|fim_middle|>", *extra_stop],
        })
        return str(result["choices"][0]["text"])


@contextlib.contextmanager
def serve(model: Path, executable: str, context_length: int = 4096) -> Iterator[Client]:
    if not model.is_file():
        raise FileNotFoundError(model)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port: int = sock.getsockname()[1]
    client = Client(port, secrets.token_hex(24))
    with subprocess.Popen([
        executable, "--host", "127.0.0.1", "--port", str(port), "--model", str(model),
        "--ctx-size", str(context_length), "--parallel", "1", "--n-gpu-layers", "0",
        "--api-key", client.key,
    ], stdout=subprocess.DEVNULL, stdin=subprocess.DEVNULL) as process:
        try:
            for _ in range(300):
                if process.poll() is not None:
                    raise RuntimeError(f"llama-server exited with {process.returncode}")
                try:
                    client.request("/health", timeout=0.5)
                except (urllib.error.URLError, TimeoutError):
                    time.sleep(0.1)
                else:
                    break
            else:
                raise TimeoutError("llama-server did not become ready")
            yield client
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
