"""Evaluate quantization-matched C++ checkpoints using Tessera's isolated verifier."""
import argparse
from dataclasses import asdict
import json
from pathlib import Path
import re
import time

from data.pipelines.filtering import records
from data.sources.licensing import licenses
from eval.inference import serve
from eval.report import digest
from verifiers.compiled import verify_compiled


def code_from_answer(text):
    blocks = re.findall(r"^```(?:cpp|c\+\+|cxx)?[^\S\n]*\n(.*?)^```[^\S\n]*$", text, re.S | re.M | re.I)
    return blocks[0].strip() if len(blocks) == 1 else text.strip()


def evaluate(role, model, server, fixtures):
    size = model.stat().st_size
    if not 0 < size < 1_000_000_000:
        raise ValueError(f"Model is outside the package size limit: {size} bytes")
    results = []
    with serve(model, server, 768 if role == "fim" else 2048) as client:
        for row in fixtures:
            start = time.monotonic()
            if role == "fim":
                prefix, suffix = row["prompt"], row["suffix"]
                prompt = f"<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>"
                answer = client.complete(prompt, 32, ("\n", "\r"))
                source = prefix + answer + suffix
            else:
                response = client.request("/v1/chat/completions", {
                    "messages": [
                        {"role": "system", "content": "Return only C++20 source code."},
                        {"role": "user", "content": row["prompt"]},
                    ],
                    "temperature": 0, "seed": 0, "max_tokens": 512,
                })
                answer = response["choices"][0]["message"]["content"]
                source = code_from_answer(answer)
            duration = round(1000 * (time.monotonic() - start))
            verdict = verify_compiled("cpp", source, row["tests"])
            results.append({"id": row["id"], "answer": answer, "inference_ms": duration, **asdict(verdict)})
    return {"model": model.name, "sha256": digest(model), "size_bytes": size,
            "passed": sum(row["passed"] for row in results), "total": len(results), "results": results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("role", choices=("fim", "chat"))
    parser.add_argument("--server", required=True)
    parser.add_argument("--run", required=True, type=Path)
    parser.add_argument("models", nargs="+", type=Path)
    args = parser.parse_args()
    run = args.run
    audit = json.loads((run / "training.json").read_text())["corpus_audit"]
    holdout = run / "holdout.jsonl"
    if digest(holdout) != audit["holdout_sha256"] or digest(run / "training.jsonl") != audit["training_sha256"]:
        raise ValueError("Training or holdout snapshot differs from the training report")
    fixtures = [row for row in records(holdout) if row["role"] == args.role]
    allowed = licenses()
    if not fixtures or any(row["license"] not in allowed for row in fixtures):
        raise ValueError("Missing fixtures or unexpected benchmark license")
    for row in fixtures:
        source = row["expected"]
        if args.role == "fim":
            source = row["prompt"] + source + row["suffix"]
        if not verify_compiled("cpp", source, row["tests"]).passed:
            raise ValueError(f"Invalid canonical fixture: {row['id']}")
    results = [evaluate(args.role, model, args.server, fixtures) for model in args.models]
    print(json.dumps({"role": args.role, "holdout_sha256": digest(holdout), "checkpoints": results}, indent=2))


if __name__ == "__main__":
    main()
