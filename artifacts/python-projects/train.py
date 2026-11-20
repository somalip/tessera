"""Fine-tune the deployed Qwen2.5-Coder weights on verified project supervision."""
import argparse
import json
from pathlib import Path
import sys

from data.pipelines.filtering import records
from data.sources.licensing import licenses
from eval.report import digest
from fixtures import ROOT

sys.path.insert(0, str(ROOT.parent / "python-brief"))
from streaming_finetune import fit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--epochs", type=int, default=2)
    parser.add_argument("--learning-rate", type=float, default=1.2e-4)
    args = parser.parse_args()
    if args.epochs < 1 or args.learning_rate <= 0:
        parser.error("Training settings must be positive")
    dataset = ROOT / "training.jsonl"
    audit = json.loads((ROOT / "corpus-audit.json").read_text())
    if audit["overlap"] != 0 or audit["data_sha256"] != digest(dataset) or any(
        digest(Path(path)) != checksum for path, checksum in audit["benchmarks"].items()
    ):
        raise ValueError("Training or benchmark snapshot changed")
    examples = list(records(dataset))
    if any(row["license"] not in licenses() for row in examples):
        raise ValueError("Training snapshot contains an unapproved license")
    fit(args.output, args.epochs, args.learning_rate, 1, corpus_snapshot=(examples, audit), max_length=1400)


if __name__ == "__main__":
    main()
