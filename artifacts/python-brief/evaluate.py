"""Evaluate the deployed brief-to-Python prompt against isolated behavior checks."""
import argparse
import json
from dataclasses import asdict
from pathlib import Path
import re
from time import monotonic

from data.pipelines.filtering import records
from data.sources.licensing import licenses
from eval.inference import serve
from eval.report import digest
from verifiers.python.runner import verify

from finetune import ARTIFACTS, HOLDOUT, messages


def evaluate(model, report):
    size = model.stat().st_size
    if not 0 < size < 1_000_000_000:
        raise ValueError("Model must be smaller than one decimal GB")
    tasks = list(records(HOLDOUT))
    allowed = licenses()
    if any(task["license"] not in allowed for task in tasks):
        raise ValueError("Holdout license is outside the allowlist")

    results = []
    server = ARTIFACTS / "python-strength/serve-metal"
    with serve(model, str(server), context_length=2048) as client:
        for task in tasks:
            prompt = messages(task["prompt"])
            prompt_bytes = sum(len(message["content"].encode()) + 24 for message in prompt)
            output_tokens = min(1536, max(1024, 2048 - prompt_bytes))
            start = monotonic()
            result = client.request("/v1/chat/completions", {
                "messages": prompt, "temperature": 0, "max_tokens": output_tokens,
                "chat_template_kwargs": {"enable_thinking": False},
            }, timeout=180)
            choice = result["choices"][0]
            content = (choice["message"].get("content") or "").strip()
            fence = re.fullmatch(r"```[^\r\n]*\r?\n([\s\S]*?)\r?\n```", content)
            code = fence[1] if fence else content
            setup = f"CANDIDATE = {code!r}" if task.get("standalone") else code
            outcome = verify(setup, task["tests"])
            results.append({
                "id": task["id"], **asdict(outcome),
                "passed": outcome.passed and choice.get("finish_reason") == "stop",
                "finish_reason": choice.get("finish_reason"), "code": code,
                "completion_tokens": result["usage"]["completion_tokens"], "seconds": round(monotonic() - start, 2),
            })
            print(task["id"], results[-1]["passed"], choice.get("finish_reason"), flush=True)
    report.write_text(json.dumps({
        "model": str(model), "model_sha256": digest(model), "size_bytes": size,
        "fixture_sha256": digest(HOLDOUT), "runtime": str(server),
        "passed": sum(row["passed"] for row in results), "total": len(results), "results": results,
    }, indent=2) + "\n")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model", type=Path)
    parser.add_argument("report", type=Path)
    args = parser.parse_args()
    evaluate(args.model, args.report)
