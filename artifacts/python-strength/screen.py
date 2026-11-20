"""Measure first-answer Python coding at a fixed model size and generation budget."""
import argparse
import json
import os
import re
import time
from dataclasses import asdict
from pathlib import Path

from eval.inference import serve
from eval.report import digest
from eval.suites.records import load_tasks
from verifiers.python.runner import verify

ROOT = Path(__file__).resolve().parent
FIXTURES = (ROOT.parent / "python-local/heldout.jsonl", ROOT.parent / "python-v2/heldout.jsonl")
SYSTEM = "You are a Python coding assistant. Return only runnable Python code."
CONTRACT = (
    "Implement the exact Python contract in the request. Preserve names, signatures, "
    "return types, ordering, and mutation behavior. Honor edge cases and include "
    "all imports. Return only the runnable implementation; no examples or tests."
)
DELIBERATE = (
    "You are a Python maintenance programmer. Identify the function contract, "
    "check boundary cases and imports, then provide the full runnable implementation "
    "in exactly one Python code block. Omit demonstrations and tests."
)

def code_from_reply(reply):
    blocks = re.findall(r"^\s*```(?:python|py)?[ \t]*\r?\n(.*?)\r?\n```[ \t]*$", reply, re.M | re.S)
    return blocks[0] if len(blocks) == 1 else reply

def run(model, result, mode, fixtures):
    size = model.stat().st_size
    if not 0 < size < 1_000_000_000:
        raise ValueError("GGUF is outside the project size cap")
    thinking = mode == "think"
    if thinking:
        os.environ["TINY_STRENGTH_REASONING_BUDGET"] = "256"
    settings = {
        "temperature": 0.6 if thinking else 0,
        "seed": 42,
        "max_tokens": 768 if thinking else 512,
        "chat_template_kwargs": {"enable_thinking": thinking},
    }
    if thinking:
        settings.update(top_p=0.95, top_k=20, min_p=0)
    system = {"contract": CONTRACT, "deliberate": DELIBERATE}.get(mode, SYSTEM)
    suites = []
    server = os.environ.get("TINY_STRENGTH_SERVER", str(ROOT / "serve-metal"))
    with serve(model, server, context_length=2048) as client:
        for path in fixtures:
            results = []
            for task in load_tasks(path, "real_world", "python", None):
                start = time.monotonic()
                output = client.request("/v1/chat/completions", {
                    **settings, "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": task.prompt},
                    ]
                }, timeout=180)
                choice = output["choices"][0]
                message = choice["message"]
                reply = message.get("content") or ""
                code = code_from_reply(reply)
                outcome = verify(code, task.tests)
                results.append(dict(id=task.id, finish_reason=choice.get("finish_reason"),
                    reply=reply, reasoning_chars=len(message.get("reasoning_content") or ""),
                    tokens=output.get("usage", {}).get("completion_tokens"),
                    wall_seconds=round(time.monotonic()-start, 2), **asdict(outcome)))
                print(task.id, outcome.passed, choice.get("finish_reason"),
                      "reasoning_chars", results[-1]["reasoning_chars"], flush=True)
            suites.append(dict(path=str(path), sha256=digest(path), passed=sum(r["passed"] for r in results),
                               total=len(results), results=results))
    result.write_text(json.dumps(dict(model_sha256=digest(model), size_bytes=size, mode=mode,
                                     settings=settings, server=server, suites=suites), indent=2) + "\n")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model", type=Path)
    parser.add_argument("result", type=Path)
    parser.add_argument("--mode", choices=["greedy", "think", "deliberate", "contract"], default="greedy")
    parser.add_argument("--fixture", type=Path, action="append")
    args = parser.parse_args()
    run(args.model, args.result, args.mode, args.fixture or FIXTURES)
