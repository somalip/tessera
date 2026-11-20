"""Train and compare a local C++ generation model with the deployed Python model."""
import argparse
import json
import math
from pathlib import Path
import re
import sys
import time

from benchmark import insert, rows
from data.pipelines.filtering import Contamination, records, tokens
from data.sources.licensing import licenses
from eval.inference import serve
from eval.report import digest
from training_cases import program_harness, system_prompt, training_rows
from verifiers.compiled import verify_compiled
from verifiers.python.runner import verify as verify_python

HERE = Path(__file__).resolve().parent


def write_rows(path, entries):
    path.write_text("".join(json.dumps(row, sort_keys=True) + "\n" for row in entries))
    return digest(path)


def verify(language, source, tests):
    return verify_compiled("cpp", source, tests) if language == "cpp" else verify_python(source, tests)


def verify_predecessor(benchmark, corpus, allowed):
    contamination = Contamination([benchmark])
    for row in records(corpus):
        if row["license"] not in allowed or any(
            contamination.overlaps(row[key], tokens(row[key])) for key in ("prompt", "solution")
        ):
            raise ValueError(f"Predecessor corpus failed the paired holdout audit: {row['id']}")


def train(output, base, epochs, base_gguf, learning_rate):
    if not math.isfinite(learning_rate) or learning_rate <= 0:
        raise ValueError("The learning rate must be positive and finite")

    output.mkdir(parents=True, exist_ok=True)
    benchmark = output / "holdout.jsonl"
    holdout = list(rows())
    candidate = list(training_rows())
    allowed = licenses()
    if any(row["license"] not in allowed for row in holdout + candidate) or "Apache-2.0" not in allowed:
        raise ValueError("Unapproved license")
    holdout_hash = write_rows(benchmark, holdout)
    predecessor = HERE.parent.parent / "python-base-comparison"
    if base_gguf and base_gguf.resolve() == (predecessor / "scaled.f16.gguf").resolve():
        verify_predecessor(benchmark, predecessor / "supervised.jsonl", allowed)
    snapshots = [benchmark, HERE.parent / "chat/holdout.jsonl"]
    contamination = Contamination(snapshots)
    accepted, rejected = [], []
    for row in candidate:
        # The chat template separates the user message from the assistant target.
        if any(contamination.overlaps(row[key], tokens(row[key])) for key in ("prompt", "solution")):
            rejected.append(row["id"])
            continue
        if not verify("cpp", row["code"], row["tests"]).passed:
            raise ValueError(f"Supervision failed verification: {row['id']}")
        accepted.append(row)
    training_hash = write_rows(output / "training.jsonl", accepted)
    audit = {"benchmarks": {p.name if p == benchmark else "v1-holdout.jsonl": digest(p) for p in snapshots},
             "holdout_sha256": holdout_hash, "training_sha256": training_hash,
             "excluded_for_overlap": rejected, "layers": 4, "epochs": epochs, "batch_size": 1}
    for row in accepted:
        row["messages"] = [
            {"role": "system", "content": system_prompt("cpp", row["contextual"], row["prompt"].split("\nRequest: ", 1)[1])},
            {"role": "user", "content": row["prompt"]},
        ]
        row["training_source"] = "original"
    artifacts = HERE.parent.parent
    if base_gguf:
        if base.resolve() != (artifacts / "python-local/base").resolve():
            raise ValueError("The streamed trainer uses the pinned local 1.5B tokenizer and config")
        sys.path.insert(0, str(artifacts / "python-brief"))
        from streaming_finetune import fit

        fit(output, epochs, learning_rate, 1, corpus_snapshot=(accepted, audit),
            active=base_gguf, output_name="cpp-generation")
        streaming = json.loads((output / "training-report.json").read_text())
        report = {"base": "Qwen/Qwen2.5-Coder-1.5B-Instruct",
                  "revision": "2e1fd397ee46e1388853d2af2c993145b0f1098a",
                  "base_sha256": digest(base / "model.safetensors"), "data_license": "CC0-1.0",
                  "starting_gguf_sha256": digest(base_gguf), "device": "cpu", "examples": len(accepted), "epoch_losses": streaming["loss"],
                  "corpus_audit": audit}
        (output / "training.json").write_text(json.dumps(report, indent=2) + "\n")
    else:
        from transformers import AutoTokenizer

        sys.path.insert(0, str(artifacts / "python-autocomplete"))
        from train import fit

        tokenizer = AutoTokenizer.from_pretrained(base, local_files_only=True)
        samples = [(tokenizer.apply_chat_template(row["messages"], tokenize=False, add_generation_prompt=True),
                    row["solution"]) for row in accepted]
        fit(base, output, "2e1fd397ee46e1388853d2af2c993145b0f1098a", samples,
            end_token="<|im_end|>", base_id="Qwen/Qwen2.5-Coder-1.5B-Instruct", audit=audit,
            layers=4, epochs=epochs, batch_size=1, cpu_float32=True, learning_rate=learning_rate)


def code_only(text):
    match = re.fullmatch(r"```(?:cpp|c\+\+|cxx|python|py)?[^\S\n]*\n(.*?)\n```", text.strip(), re.S | re.I)
    return match[1] if match else text.strip()


def plan_implementation(client, prompt, language):
    return client.request("/v1/chat/completions", {
        "messages": [
            {"role": "system", "content": (
                "Give a short implementation plan in bullets, without code. "
                "Address each constraint, edge case, data structure and complexity requirement. "
                "For input commands, describe exactly how each field is parsed."
            )},
            {"role": "user", "content": f"Language: {language}\n{prompt}"},
        ], "temperature": 0, "seed": 0, "max_tokens": 160,
    })["choices"][0]["message"]["content"].strip()


def evaluate(output, server, models, plan=False):
    benchmark = output / "holdout.jsonl"
    audit = json.loads((output / "training.json").read_text())["corpus_audit"]
    if digest(benchmark) != audit["holdout_sha256"] or digest(output / "training.jsonl") != audit["training_sha256"]:
        raise ValueError("Audited training or benchmark snapshot changed")
    holdout = list(records(benchmark))
    allowed = licenses()
    for row in holdout:
        if row["license"] not in allowed or not verify(row["language"], row.get("code", row["expected"]), row["tests"]).passed:
            raise ValueError(f"Invalid holdout reference: {row['language']}/{row['id']}")
    for label, language, name in models:
        model = Path(name)
        size = model.stat().st_size
        if not 0 < size < 1_000_000_000:
            raise ValueError(f"Model exceeds size limit: {name}")
        results = []
        with serve(model, server, 4096) as client:
            for row in (row for row in holdout if row["language"] == language):
                start = time.monotonic()
                prompt = row["prompt"]
                plan_text = plan_implementation(client, prompt, language) if plan and len(prompt) > 160 else ""
                if plan_text:
                    prompt += "\n\nImplementation notes to check against the request:\n" + plan_text
                answer = client.request("/v1/chat/completions", {
                    "messages": [
                        {"role": "system",
                         "content": system_prompt(language, bool(row["before"] or row["after"]),
                                                  row["prompt"].split("\nRequest: ", 1)[1])},
                        {"role": "user", "content": prompt},
                    ], "temperature": 0, "seed": 0, "max_tokens": 768,
                    "cache_prompt": False,
                })["choices"][0]
                elapsed = round((time.monotonic() - start) * 1000)
                code = code_only(answer["message"]["content"])
                tests = row["tests"]
                if row.get("project_check"):
                    if language == "cpp":
                        code, tests = program_harness(code, row["project_check"])
                    else:
                        code = "candidate = " + repr(code)
                elif row["before"] or row["after"]:
                    code = insert(row["before"], row["after"], code)
                stopped = answer["finish_reason"] == "stop"
                passed = stopped and verify(language, code, tests).passed
                results.append({"id": row["id"], "passed": passed, "stopped": stopped,
                                "inference_ms": elapsed, "plan": plan_text, "answer": answer["message"]["content"]})
                print(f"{label} / {row['id']}: {'pass' if passed else 'fail'}", flush=True)
        (output / f"{label}.json").write_text(json.dumps({
            "benchmark_sha256": digest(benchmark), "model_sha256": digest(model),
            "model": str(model), "size_bytes": size, "language": language,
            "passed": sum(row["passed"] for row in results), "total": len(results),
            "stopped": sum(row["stopped"] for row in results), "cases": results,
        }, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    trainer = sub.add_parser("train")
    trainer.add_argument("output", type=Path)
    trainer.add_argument("base", type=Path)
    trainer.add_argument("--epochs", type=int, default=3, choices=range(1, 6))
    trainer.add_argument("--base-gguf", type=Path)
    trainer.add_argument("--learning-rate", type=float, default=1e-4)
    evaluator = sub.add_parser("evaluate")
    evaluator.add_argument("output", type=Path)
    evaluator.add_argument("server")
    evaluator.add_argument("--plan", action="store_true")
    evaluator.add_argument("--model", nargs=3, action="append", required=True,
                           metavar=("LABEL", "LANGUAGE", "GGUF"))
    args = parser.parse_args()
    if args.action == "train":
        train(args.output, args.base, args.epochs, args.base_gguf, args.learning_rate)
    else:
        evaluate(args.output, args.server, args.model, args.plan)
