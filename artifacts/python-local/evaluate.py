"""Compare local GGUF variants on the frozen Python implementation and repair suite."""
import argparse
import json
import re
import time
from dataclasses import asdict
from pathlib import Path

from eval.inference import serve
from eval.report import digest
from eval.suites.records import load_tasks
from verifiers.python.runner import verify

ROOT = Path(__file__).resolve().parent
FIXTURES = ROOT / "heldout.jsonl"
SERVER = "/private/tmp/tessera-model/llama-b8180/llama-server"

def evaluate(model, output):
    tasks = load_tasks(FIXTURES, "real_world", "python", None)
    results = []
    with serve(model, SERVER) as client:
        for task in tasks:
            start = time.monotonic()
            reply = client.request("/v1/chat/completions", {
                "messages": [
                    {"role": "system", "content": "You are a Python coding assistant. Return only runnable Python code."},
                    {"role": "user", "content": task.prompt},
                ],
                "temperature": 0,
                "seed": 42,
                "max_tokens": 384,
            })["choices"][0]["message"]["content"]
            latency = time.monotonic() - start
            fenced = re.fullmatch(r"\s*```(?:python|py)?\s*\n(.*?)\n```\s*", reply, flags=re.S)
            source = fenced[1] if fenced else reply
            outcome = verify(source, task.tests)
            results.append(dict(id=task.id, seconds=round(latency, 3), **asdict(outcome)))
            print(results[-1], flush=True)
    passed = sum(row["passed"] for row in results)
    output.write_text(json.dumps({
        "model_size_bytes": model.stat().st_size,
        "model_sha256": digest(model),
        "dataset_sha256": digest(FIXTURES),
        "passed": passed,
        "total": len(results),
        "pass_at_1": passed / len(results),
        "results": results,
    }, indent=2) + "\n")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    evaluate(args.model, args.output)
