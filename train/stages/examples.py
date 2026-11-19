"""Prepare CPT sequences and execution-verified ChatML supervision."""
import hashlib
import json
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

from data.pipelines.filtering import SECRET, Contamination, records, tokens
from data.sources.licensing import licenses
from verifiers.python.runner import verify

CHAT_MARKERS = ("<|im_start|>", "<|im_end|>")


def cpt_batches(root: Path, sequence_length: int, benchmarks: list[Path], smoke: bool,
                tokenizer_digest: str, language: str) -> Iterator[tuple[list[int], list[int]]]:
    audit = json.loads((root / "stats.json").read_text(encoding="utf8"))
    if audit.get("accepted_overlap") != 0:
        raise ValueError("CPT corpus must pass the contamination audit")
    digests = sorted(hashlib.sha256(path.read_bytes()).hexdigest() for path in benchmarks)
    if audit.get("benchmarks") != digests:
        raise ValueError("CPT corpus was filtered against a different benchmark snapshot")
    if audit.get("tokenizer_sha256") != tokenizer_digest:
        raise ValueError("CPT shards were encoded with a different tokenizer")
    if not smoke:
        text = audit.get("text_tokens", 0)
        if not 0.10 <= text / max(1, text + audit.get(f"{language}_tokens", 0)) <= 0.15:
            raise ValueError("Full CPT training requires 10–15% general text replay")
    allowed = licenses()
    shards = sorted(root.glob("shard-*.jsonl"))
    if not shards:
        raise ValueError("CPT corpus has no shards")
    buffer: list[int] = []
    for shard in shards:
        for row in records(shard):
            if row.get("license") not in allowed:
                raise ValueError("CPT shard contains content outside the license allowlist")
            if row.get("language") not in {language, "text"}:
                raise ValueError("CPT shard contains content from another language")
            ids = row["input_ids"]
            if not isinstance(ids, list) or not all(isinstance(value, int) and value >= 0 for value in ids):
                raise ValueError("Invalid token sequence in CPT corpus")
            buffer.extend(ids)
            while len(buffer) >= sequence_length:
                block, buffer = buffer[:sequence_length], buffer[sequence_length:]
                yield block, block[:]
    if len(buffer) >= 2:
        yield buffer, buffer[:]


def prompt_text(prompt: str) -> str:
    return f"<|im_start|>user\n{prompt}<|im_end|>\n<|im_start|>assistant\n"


def training_pair(tokenizer: Any, prompt: str, solution: str,
                  sequence_length: int) -> tuple[list[int], list[int]]:
    prefix = tokenizer.encode(prompt_text(prompt), add_special_tokens=False)
    target = tokenizer.encode(solution + "<|im_end|>", add_special_tokens=False)
    if len(target) >= sequence_length:
        raise ValueError("A supervised completion exceeds the configured training sequence length")
    prefix = prefix[-(sequence_length - len(target)):]
    return prefix + target, [-100] * len(prefix) + target


class Supervision:
    def __init__(self, path: Path, benchmarks: list[Path], docker: str) -> None:
        self.contamination = Contamination(benchmarks)
        self.docker = docker
        self.rows = list(records(path))
        allowed = licenses()
        for row in self.rows:
            if row.get("license") not in allowed or not self.safe(
                row["prompt"], row["solution"], row["tests"],
            ):
                raise ValueError("Supervised input failed license, privacy, or contamination checks")

    def safe(self, prompt: str, solution: str, tests: str) -> bool:
        content = "\n".join([prompt, solution, tests])
        return not (SECRET.search(content) or any(mark in content for mark in CHAT_MARKERS)
                    or self.contamination.overlaps(content, tokens(content)))

    def accepted(self, generate: Callable[[str], list[str]] | None = None) -> Iterator[tuple[str, str]]:
        for row in self.rows:
            candidates = (generate(row["prompt"]) if generate else
                          row.get("candidates", [row["solution"]]))
            for candidate in candidates:
                if (self.safe(row["prompt"], candidate, row["tests"])
                        and verify(candidate, row["tests"], docker=self.docker).passed):
                    yield row["prompt"], candidate
                    break

    def teacher(self) -> Iterator[tuple[str, str]]:
        for row in self.rows:
            if verify(row["solution"], row["tests"], docker=self.docker).passed:
                yield row["prompt"], row["solution"]
