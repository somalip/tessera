"""Prepare tiny synthetic inputs for the Python packaging smoke run."""

import argparse
import json
from pathlib import Path

from data.pipelines.build import build


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--converter", type=Path, required=True)
    parser.add_argument("--quantizer", type=Path, required=True)
    parser.add_argument("--docker", default="docker")
    parser.add_argument("--device", default="auto")
    args = parser.parse_args()
    root = args.output.resolve()
    root.mkdir(parents=True)
    corpus = root / "source.jsonl"
    benchmark = root / "heldout.jsonl"
    teacher = root / "teacher.jsonl"
    sample = {
        "repo": "smoke",
        "path": "total.py",
        "license": "CC0-1.0",
        "text": "def total(values):\n    result = 0\n    for value in values:\n"
        "        result += value\n    return result\n",
    }
    corpus.write_text(json.dumps(sample) + "\n", encoding="utf8")
    benchmark.write_text(
        json.dumps(
            {
                "text": "def evaluate_nebula_count(data): return tuple(data)",
                "license": "CC0-1.0",
            }
        )
        + "\n",
        encoding="utf8",
    )
    teacher.write_text(
        json.dumps(
            {
                "prompt": "Write Python function double_it(x) that returns twice its input.",
                "solution": "def double_it(x):\n    return x * 2",
                "candidates": [
                    "def double_it(x):\n    return x",
                    "def double_it(x):\n    return x + x",
                ],
                "tests": "assert double_it(5) == 10 and double_it(-2) == -4",
                "license": "CC0-1.0",
            }
        )
        + "\n",
        encoding="utf8",
    )
    base = args.base.resolve()
    build(corpus, [benchmark], base / "tokenizer.json", root / "corpus", 1.0, 32, 42)
    config = {
        "extends": str(
            (Path(__file__).with_name("configs") / "python-smoke.yaml").resolve()
        ),
        "base_dir": str(base),
        "license_file": str(base / "LICENSE"),
        "corpus": str(root / "corpus"),
        "supervised": str(teacher),
        "benchmarks": [str(benchmark)],
        "teacher_terms_permit_training": True,
        "output": str(root / "build"),
        "converter": str(args.converter.resolve()),
        "quantizer": str(args.quantizer.resolve()),
        "docker": args.docker,
        "device": args.device,
    }
    (root / "config.yaml").write_text(
        json.dumps(config, indent=2) + "\n", encoding="utf8"
    )
    print(root / "config.yaml")


if __name__ == "__main__":
    main()
