"""Score the extension's production FIM builder with and without BM25 context."""

import argparse
import json
import subprocess
from difflib import SequenceMatcher
from pathlib import Path

from data.pipelines.filtering import records
from data.sources.licensing import licenses
from eval.inference import serve
from eval.report import digest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixtures", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--server", default="llama-server")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    rows = list(records(args.fixtures))
    allowed = licenses()
    if not rows or any(row["license"] not in allowed for row in rows):
        raise ValueError("Provide a nonempty, allowlisted repository FIM snapshot")
    script = Path(__file__).with_name("suites") / "context_prompts.cjs"
    prompts = json.loads(
        subprocess.check_output(
            ["node", str(script)], input=json.dumps(rows), text=True
        )
    )
    results = []
    with serve(args.model, args.server) as client:
        for row, pair in zip(rows, prompts, strict=True):
            expected = row["expected"].strip()
            variants = []
            for prompt in pair:
                prediction = client.complete(prompt, max_tokens=64).strip()
                variants.append(
                    {
                        "exact_match": prediction == expected,
                        "edit_similarity": SequenceMatcher(
                            None, expected, prediction, autojunk=False
                        ).ratio(),
                    }
                )
            results.append(
                {"id": row["id"], "control": variants[0], "treatment": variants[1]}
            )
    summary = {
        variant: {
            metric: sum(row[variant][metric] for row in results) / len(results)
            for metric in ("exact_match", "edit_similarity")
        }
        for variant in ("control", "treatment")
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(
            {
                "model_sha256": digest(args.model),
                "dataset_sha256": digest(args.fixtures),
                "summary": summary,
                "tasks": results,
            },
            indent=2,
        )
        + "\n",
        encoding="utf8",
    )


if __name__ == "__main__":
    main()
