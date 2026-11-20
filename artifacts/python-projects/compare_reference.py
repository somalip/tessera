"""Score the pinned larger model on the same standalone-program fixtures."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
from time import monotonic

from data.pipelines.filtering import records
from data.sources.licensing import licenses
from eval.inference import serve
from eval.report import digest
from verifiers.python.runner import verify

from distill import TEACHER_HASH, completion, extract_source, project_messages
from fixtures import ROOT


def compare(model, server, suite, workers, output):
    if digest(model) != TEACHER_HASH:
        raise ValueError("The reference model does not match the pinned 7B GGUF")
    fixture = ROOT / f"{suite}.jsonl"
    tasks = list(records(fixture))
    if any(task["license"] not in licenses() for task in tasks):
        raise ValueError("Evaluation data uses an unapproved license")
    prompts = project_messages([task["prompt"] for task in tasks])
    with serve(model, server, context_length=2048) as client, ThreadPoolExecutor(workers) as pool:
        def generate(messages):
            start = monotonic()
            code, status, count = completion(client, messages, 1250)
            return {"code": extract_source(code), "status": status, "completion_tokens": count,
                    "seconds": monotonic() - start}

        candidates = []
        for task, candidate in zip(tasks, pool.map(generate, prompts), strict=True):
            candidates.append(candidate)
            print(task["id"], candidate["status"], candidate["completion_tokens"], flush=True)

    results = []
    for task, candidate in zip(tasks, candidates, strict=True):
        code = candidate["code"]
        outcome = verify(f"CANDIDATE = {code!r}", task["tests"]) if candidate["status"] == "stop" and code else None
        result = {"id": task["id"], "passed": bool(outcome and outcome.passed), **candidate}
        print(task["id"], result["passed"], flush=True)
        results.append(result)

    report = {"model": "Qwen2.5-Coder-7B-Instruct/Q4_K_M", "model_sha256": TEACHER_HASH,
              "size_bytes": model.stat().st_size, "passed": sum(x["passed"] for x in results),
              "total": len(results), "results": results, "fixture_sha256": digest(fixture),
              "inference": "non-streaming, 2048-token slots, greedy, 1250 generated tokens max"}
    output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model", type=Path)
    parser.add_argument("server")
    parser.add_argument("output", type=Path)
    parser.add_argument("--suite", choices=("diagnostic", "holdout"), default="holdout")
    parser.add_argument("--workers", type=int, default=1, help="Set to the number of server slots")
    args = parser.parse_args()
    compare(args.model, args.server, args.suite, args.workers, args.output)
