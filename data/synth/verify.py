"""Filter teacher-provided triples before supervised training."""
import argparse
import json
from pathlib import Path

from data.pipelines.filtering import SECRET, Contamination, records, tokens
from data.sources.licensing import licenses
from verifiers.compiled import LANGUAGES, verifier


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--benchmark", type=Path, action="append", required=True)
    parser.add_argument("--terms-permit-training", action="store_true", required=True)
    parser.add_argument("--docker", default="docker")
    parser.add_argument("--language", choices=LANGUAGES, default="python")
    args = parser.parse_args()
    contamination = Contamination(args.benchmark)
    allowed = licenses()
    verify = verifier(args.language, args.docker)
    with args.output.open("x", encoding="utf8") as output:
        for row in records(args.input):
            source = "\n".join(row[field] for field in ("prompt", "solution", "tests"))
            if (row.get("license") in allowed and not SECRET.search(source)
                    and not contamination.overlaps(source, tokens(source))
                    and verify(row["solution"], row["tests"]).passed):
                output.write(json.dumps(row) + "\n")


if __name__ == "__main__":
    main()
