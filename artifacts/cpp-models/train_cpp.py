"""Fit the C++ variants using the same LoRA recipe as Python autocomplete."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

from data.pipelines.filtering import Contamination, tokens
from data.sources.licensing import licenses
from fixtures import holdout_rows, training_rows
from transformers import AutoTokenizer

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python-autocomplete"))
from train import fit  # noqa: E402


def snapshot(path, rows):
    content = "".join(json.dumps(row, sort_keys=True) + "\n" for row in rows)
    path.write_text(content, encoding="utf-8")
    return hashlib.sha256(content.encode()).hexdigest()


def train(role, base, output, revision):
    output.mkdir(parents=True, exist_ok=True)
    holdout = list(holdout_rows())
    candidates = list(training_rows(role))
    allowed = licenses()
    if any(row["license"] not in allowed for row in holdout + candidates):
        raise ValueError("Fixture license is not allowlisted")
    benchmark = output / "holdout.jsonl"
    benchmark_hash = snapshot(benchmark, holdout)
    contamination = Contamination([benchmark])
    rows = []
    for row in candidates:
        combined = row["prompt"] + "\n" + row["expected"] + row.get("suffix", "")
        if not contamination.overlaps(combined, tokens(combined)):
            rows.append(row)
    corpus_hash = snapshot(output / "training.jsonl", rows)
    audit = {"holdout_sha256": benchmark_hash, "training_sha256": corpus_hash,
             "overlap_exclusions": len(candidates) - len(rows)}
    is_chat = role == "chat"
    if is_chat:
        tokenizer = AutoTokenizer.from_pretrained(base, local_files_only=True)
        samples = [
            (tokenizer.apply_chat_template([
                {"role": "system", "content": "Return only C++20 source code."},
                {"role": "user", "content": row["prompt"]},
            ], tokenize=False, add_generation_prompt=True), row["expected"])
            for row in rows
        ]
    else:
        samples = [
            (f'<|fim_prefix|>{row["prompt"]}<|fim_suffix|>{row["suffix"]}<|fim_middle|>', row["expected"])
            for row in rows
        ]
    fit(base, output, revision, samples, cpu_float32=True, audit=audit,
        base_id="Qwen/Qwen2.5-Coder-0.5B" + ("-Instruct" if is_chat else ""),
        end_token="<|im_end|>" if is_chat else None)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("role", choices=("fim", "chat"))
    parser.add_argument("base", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--revision", required=True)
    args = parser.parse_args()
    train(args.role, args.base, args.output, args.revision)
