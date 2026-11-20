"""Evaluate local Python chat over loopback with container-isolated execution."""
import argparse
import hashlib
import json
import os
import re
from dataclasses import asdict
from pathlib import Path

from data.pipelines.filtering import Contamination, records, tokens
from eval.inference import serve
from eval.report import digest
from eval.suites.records import load_tasks
from verifiers.python.runner import verify

ROOT = Path(__file__).resolve().parent
PREVIOUS = ROOT.parent / "python-local"
SERVER = os.environ.get("TINY_PY_EVAL_SERVER", "/private/tmp/tessera-model/llama-b8180/llama-server")
SUITES = (PREVIOUS / "heldout.jsonl", ROOT / "heldout.jsonl")
SYSTEM = "You are a Python coding assistant. Return only runnable Python code."

def code_from_reply(reply):
    fenced = re.fullmatch(r"\s*```(?:python|py)?[ \t]*\n(.*?)\n```\s*", reply, flags=re.S)
    return fenced[1] if fenced else reply

def audit():
    contamination = Contamination(list(SUITES))
    for row in records(PREVIOUS / "supervised-filtered.jsonl"):
        sample = "\n".join(row[key] for key in ("prompt", "solution", "tests"))
        if contamination.overlaps(sample, tokens(sample)):
            raise ValueError(f"Prior training overlaps evaluation: {row['id']}")
    for fixtures in SUITES:
        tasks = load_tasks(fixtures, "real_world", "python", None)
        for task, row in zip(tasks, records(fixtures), strict=True):
            if not verify(row["canonical_solution"], task.tests).passed:
                raise ValueError(f"Invalid evaluation reference: {task.id}")

def evaluate(model, output, thinking, thinking_budget):
    size = model.stat().st_size
    if not 0 < size < 1_000_000_000:
        raise ValueError("GGUF exceeds the local model size limit")
    suites = []
    with serve(model, SERVER, context_length=2048) as client:
        for fixtures in SUITES:
            tasks = load_tasks(fixtures, "real_world", "python", None)
            results = []
            for task in tasks:
                request = {
                    "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": task.prompt}],
                    "temperature": 0, "seed": 42, "max_tokens": 512,
                    "chat_template_kwargs": {"enable_thinking": thinking},
                }
                if thinking_budget is not None:
                    request["reasoning_budget"] = thinking_budget
                    request["max_tokens"] += thinking_budget
                response = client.request("/v1/chat/completions", request)["choices"][0]
                reply = response["message"].get("content") or ""
                code = code_from_reply(reply)
                outcome = verify(code, task.tests) if code.strip() else None
                result = dict(
                    id=task.id, finish_reason=response.get("finish_reason"),
                    generated_code_sha256=hashlib.sha256(code.encode()).hexdigest(),
                    reply=reply,
                    **(asdict(outcome) if outcome else {"passed": False, "empty": True}),
                )
                results.append(result)
                print(task.id, result["passed"], result["finish_reason"], flush=True)
            suites.append(dict(dataset_sha256=digest(fixtures), results=results,
                               passed=sum(r["passed"] for r in results), total=len(results)))
    output.write_text(json.dumps(dict(model_sha256=digest(model), size_bytes=size, thinking=thinking,
                                      thinking_budget=thinking_budget, suites=suites), indent=2) + "\n")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model", nargs="?", type=Path)
    parser.add_argument("output", nargs="?", type=Path)
    parser.add_argument("--audit", action="store_true")
    parser.add_argument("--thinking", action="store_true")
    parser.add_argument("--thinking-budget", type=int)
    args = parser.parse_args()
    if args.audit:
        audit()
    if args.model:
        evaluate(args.model, args.output, args.thinking, args.thinking_budget)
