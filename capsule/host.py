"""Capsule chat transport. Use llama.cpp's rendered prompt for token accounting."""
import contextlib
import urllib.parse
import urllib.request
from collections.abc import Iterator
from contextlib import ExitStack
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from capsule.memory import canonical
from capsule.router import DIFFICULTIES, ROLES, Message
from eval.inference import Client, NoRedirect, serve

MODEL_LIMIT = 1_000_000_000


@dataclass(frozen=True)
class RemoteClient:
    url: str
    key: str

    def request(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        import json

        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        request = urllib.request.Request(
            self.url + path, data=canonical(body).encode(),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.key}"},
        )
        with opener.open(request, timeout=120) as response:
            result: dict[str, Any] = json.load(response)
            return result


class ChatModel:
    def __init__(self, spec: dict[str, Any], server: str, stack: ExitStack, *, remote: bool = False) -> None:
        self.id = str(spec["id"])
        self.language = str(spec.get("language", "*"))
        self.roles = tuple(spec.get("roles", ["planner", *ROLES]))
        self.difficulty = str(spec.get("difficulty", "routine"))
        self.tier = int(spec.get("tier", 0))
        self.preamble = str(spec.get("preamble", ""))
        self.server = server
        self.stack = stack
        self.client: Client | RemoteClient | None = None
        self.path = Path()
        self.adapter: Path | None = None
        if (self.tier not in (0, 1, 2) or self.difficulty not in DIFFICULTIES
                or not set(self.roles) <= {"planner", *ROLES}):
            raise ValueError(f"Invalid model routing configuration: {self.id}")
        if self.tier == 2:
            if not remote:
                raise ValueError("Remote escalation is disabled")
            url = str(spec["url"]).rstrip("/")
            parsed = urllib.parse.urlsplit(url)
            if (parsed.scheme != "https" or not parsed.hostname or parsed.username is not None
                    or parsed.query or parsed.fragment or not 0 < int(spec["size_bytes"]) < MODEL_LIMIT):
                raise ValueError("Remote models require HTTPS and a declared size below 1 GB")
            self.client = RemoteClient(url, str(spec.get("key", "")))
        else:
            self.path = Path(spec["path"]).resolve()
            if spec.get("adapter"):
                self.adapter = Path(spec["adapter"]).resolve()
            files = [self.path, *([self.adapter] if self.adapter else [])]
            if (any(not f.is_file() or f.stat().st_size == 0 for f in files)
                    or sum(f.stat().st_size for f in files) >= MODEL_LIMIT):
                raise ValueError(f"Model and adapter must total less than 1 GB: {self.id}")

    def transport(self) -> Client | RemoteClient:
        if self.client is None:
            self.client = self.stack.enter_context(serve(self.path, self.server, adapter=self.adapter))
        return self.client

    def messages(self, messages: list[Message]) -> list[Message]:
        if self.preamble:
            return [{**messages[0], "content": self.preamble + "\n" + messages[0]["content"]}, *messages[1:]]
        return messages

    def count(self, messages: list[Message]) -> int:
        transport = self.transport()
        prompt = transport.request("/apply-template", {"messages": self.messages(messages)})["prompt"]
        return len(transport.request("/tokenize", {"content": prompt, "add_special": True,
                                                  "parse_special": True})["tokens"])

    def chat(self, messages: list[Message], seed: int = 0, *,
             schema: dict[str, object] | None = None) -> str:
        result = self.transport().request("/v1/chat/completions", {
            "messages": self.messages(messages), "temperature": 0 if seed == 0 else 0.25,
            "seed": seed, "max_tokens": 768, "stream": False, "cache_prompt": False,
            **({"response_format": {"type": "json_schema", "json_schema": {"schema": schema}}} if schema else {}),
        })
        return str(result["choices"][0]["message"]["content"])


@contextlib.contextmanager
def load_models(specs: list[dict[str, Any]], server: str, *, remote: bool = False) -> Iterator[list[ChatModel]]:
    with ExitStack() as stack:
        yield [ChatModel(spec, server, stack, remote=remote)
               for spec in specs if spec.get("tier", 0) != 2 or remote]
