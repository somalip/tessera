"""Build licensed, decontaminated Python CPT shards."""
import argparse
import hashlib
import json
import random
import tempfile
from collections import Counter
from pathlib import Path
from typing import cast

import tree_sitter_python
from tokenizers import Tokenizer  # type: ignore[import-untyped]
from tree_sitter import Language, Parser

from data.pipelines.filtering import AUTOGEN, SECRET, Contamination, Dedupe, records, tokens
from data.sources.licensing import licenses

FIM = ("<|fim_prefix|>", "<|fim_suffix|>", "<|fim_middle|>")
EOS = "<|endoftext|>"
MAX_SOURCE_BYTES = 256_000


def encode(text: str, tokenizer: Tokenizer, rng: random.Random) -> list[int]:
    lines = text.splitlines(keepends=True)
    if len(lines) >= 3 and rng.random() < 0.5:
        first = rng.randrange(1, len(lines) - 1)
        last = rng.randrange(first + 1, len(lines))
        prefix, suffix, middle = FIM
        left, right = "".join(lines[:first]), "".join(lines[last:])
        if rng.random() < 0.5:
            left, right = suffix + right, middle + left
            text = prefix + left + right + "".join(lines[first:last])
        else:
            text = prefix + left + suffix + right + middle + "".join(lines[first:last])
    return cast(list[int], tokenizer.encode(text + EOS, add_special_tokens=False).ids)


def build(source: Path, benchmarks: list[Path], tokenizer_path: Path,
          output: Path, sample: float, shard_size: int, seed: int) -> Counter[str]:
    if not 0 < sample <= 1 or shard_size < 1 or output.exists():
        raise ValueError("Use a fresh output directory, a sample in (0,1], and positive shard size")
    decontamination = Contamination(benchmarks)
    tokenizer = Tokenizer.from_file(str(tokenizer_path))
    if any(tokenizer.token_to_id(token) is None for token in (*FIM, EOS)):
        raise ValueError("Tokenizer is missing required FIM or EOS tokens")
    parser = Parser(Language(tree_sitter_python.language()))
    eligible = licenses()
    dedupe = Dedupe()
    counters: Counter[str] = Counter()
    rng = random.Random(seed)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".corpus-", dir=output.parent) as temporary:
        target = Path(temporary) / "corpus"
        target.mkdir()
        shard: list[dict[str, object]] = []

        def flush() -> None:
            if not shard:
                return
            (target / f"shard-{counters['shards']:06d}.jsonl").write_text(
                "".join(json.dumps(row) + "\n" for row in shard), encoding="utf8")
            counters["shards"] += 1
            shard.clear()

        for row in records(source):
            counters["input"] += 1
            text = row["text"]
            if not isinstance(text, str) or not isinstance(row.get("path"), str) or not row.get("repo"):
                raise ValueError("Source records require text, repo, and path")
            identity = f"{seed}:{row['repo']}:{row['path']}"
            bucket = int.from_bytes(hashlib.sha256(identity.encode()).digest()[:8])
            if bucket >= sample * 2**64:
                counters["outside_sample"] += 1
                continue
            counters["sampled"] += 1
            language = row.get("language", "python")
            if row.get("license") not in eligible or row.get("license") is None:
                counters["license"] += 1
                continue
            if language not in ("python", "text"):
                counters["language"] += 1
                continue
            raw = text.encode()
            parts = tokens(text)
            if (not parts or len(raw) > MAX_SOURCE_BYTES or AUTOGEN.search(text[:512])
                    or max(map(len, text.splitlines()), default=0) > 500):
                counters["quality"] += 1
                continue
            if SECRET.search(text) or any(token in text for token in (*FIM, EOS)):
                counters["sensitive_or_reserved"] += 1
                continue
            if language == "python" and parser.parse(raw).root_node.has_error:
                counters["parse"] += 1
                continue
            if decontamination.overlaps(text, parts):
                counters["contamination"] += 1
                continue
            duplicate = dedupe.seen(parts)
            if duplicate:
                counters[duplicate] += 1
                continue
            if decontamination.overlaps(text, parts):
                raise RuntimeError("Contamination audit failed")
            token_ids = (encode(text, tokenizer, rng) if language == "python" else
                         tokenizer.encode(text + EOS, add_special_tokens=False).ids)
            counters["accepted"] += 1
            counters[f"{language}_tokens"] += len(token_ids)
            shard.append({
                "input_ids": token_ids, "license": row["license"], "language": language,
                "repo": row["repo"], "path": row["path"], "sha256": hashlib.sha256(raw).hexdigest(),
            })
            if len(shard) == shard_size:
                flush()
        flush()
        counters["accepted_overlap"] = 0
        if not counters["accepted"]:
            raise ValueError(f"No eligible source records: {dict(counters)}")
        (target / "stats.json").write_text(json.dumps(counters, indent=2) + "\n", encoding="utf8")
        target.rename(output)
    return counters


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--benchmark", type=Path, action="append", required=True)
    parser.add_argument("--tokenizer", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--sample", type=float, default=0.01)
    parser.add_argument("--shard-size", type=int, default=2048)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    print(json.dumps(build(args.source, args.benchmark, args.tokenizer, args.output,
                           args.sample, args.shard_size, args.seed), indent=2))


if __name__ == "__main__":
    main()
