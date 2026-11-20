"""Filtering, fuzzy deduplication, and benchmark overlap detection."""
import gzip
import hashlib
import json
import re
from collections import defaultdict
from collections.abc import Iterator
from pathlib import Path
from typing import Any

TOKEN = re.compile(r"\w+|[^\w\s]")
SECRET = re.compile(
    r"-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\b(?:AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36})\b"
    r"|\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"
    r"|\b(?:api_key|access_token|password)\s*=\s*['\"][^'\"]{12,}['\"]",
    re.IGNORECASE,
)
AUTOGEN = re.compile(r"generated (?:automatically|by)|do not edit|@generated", re.IGNORECASE)
PRIME = 4_294_967_311
PERMUTATIONS = tuple(
    (int.from_bytes(hashlib.sha256(f"a{i}".encode()).digest()[:4]) or 1,
     int.from_bytes(hashlib.sha256(f"b{i}".encode()).digest()[:4]))
    for i in range(48)
)


def records(path: Path) -> Iterator[dict[str, Any]]:
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf8") as stream:
        for line in stream:
            if line.strip():
                yield json.loads(line)


def tokens(text: str) -> list[str]:
    return TOKEN.findall(text)


def shingles(parts: list[str], size: int) -> set[bytes]:
    return {
        hashlib.blake2b(" ".join(parts[index:index + size]).encode(), digest_size=8).digest()
        for index in range(len(parts) - size + 1)
    }


class Contamination:
    def __init__(self, sources: list[Path]) -> None:
        self.by_length: dict[int, set[bytes]] = defaultdict(set)
        self.source_hashes: set[str] = set()
        if not sources:
            raise ValueError("Supply a decontamination snapshot for every evaluation suite")
        for path in sources:
            loaded = False
            for row in records(path):
                if "source_sha256" in row:
                    self.source_hashes.add(row["source_sha256"])
                prompt = row.get("prompt", "")
                expected = row.get("canonical_solution") or row.get("expected", "")
                fields = [row.get(key, "") for key in ("text", "code", "test", "tests", "suffix")]
                fields += [prompt, expected, prompt + expected + row.get("suffix", "")]
                for text in fields:
                    if isinstance(text, list):
                        text = "\n".join(text)
                    if not isinstance(text, str):
                        continue
                    parts = tokens(text)
                    if parts:
                        length = min(len(parts), 10)
                        self.by_length[length].update(shingles(parts, length))
                        loaded = True
            if not loaded:
                raise ValueError(f"No benchmark text in {path}")

    def overlaps(self, text: str, parts: list[str]) -> bool:
        return hashlib.sha256(text.encode()).hexdigest() in self.source_hashes or any(
            forbidden & shingles(parts, length) for length, forbidden in self.by_length.items()
        )


class Dedupe:
    def __init__(self) -> None:
        self.exact: set[bytes] = set()
        self.bands: dict[tuple[int, tuple[int, ...]], set[int]] = defaultdict(set)
        self.rows: list[set[bytes]] = []

    def seen(self, parts: list[str]) -> str | None:
        digest = hashlib.sha256(" ".join(parts).encode()).digest()
        if digest in self.exact:
            return "exact_duplicate"
        features = shingles(parts, min(5, len(parts)))
        keys = {int.from_bytes(item[:4], "big") for item in features}
        signature = tuple(min((a * key + b) % PRIME for key in keys) for a, b in PERMUTATIONS)
        bands = [(i, signature[i:i + 4]) for i in range(0, len(signature), 4)]
        for index in set().union(*(self.bands[key] for key in bands)):
            other = self.rows[index]
            if len(other & features) / len(other | features) >= 0.8:
                return "near_duplicate"
        for key in bands:
            self.bands[key].add(len(self.rows))
        self.rows.append(features)
        self.exact.add(digest)
        return None
