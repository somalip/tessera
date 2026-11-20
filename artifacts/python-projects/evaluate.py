"""Score code from the real VS Code inline provider in an isolated container."""
import argparse
from dataclasses import asdict
import json
import os
from pathlib import Path
import subprocess

from data.pipelines.filtering import records
from data.sources.licensing import licenses
from eval.report import digest
from verifiers.python.runner import verify
from fixtures import ROOT

ARTIFACTS = ROOT.parent
EXTENSION = ARTIFACTS.parent / ".capsule-router/vscode-extension"
SIZE_LIMIT = 1_000_000_000


def evaluate(args):
    fixture = ROOT / f"{args.suite}.jsonl"
    tasks = {row["id"]: row for row in records(fixture)}
    if any(task["license"] not in licenses() for task in tasks.values()):
        raise ValueError("Evaluation data uses an unapproved license")
    size = args.model.stat().st_size
    if not 0 < size or (size >= SIZE_LIMIT and not args.reference):
        raise ValueError("Candidate must be under Tessera's existing 1,000,000,000-byte ceiling")
    parser = ARTIFACTS / "structured-autocomplete/structured-autocomplete.Q4_K_M.gguf"
    config = {"tasks": [{"id": task["id"], "prompt": task["prompt"]} for task in tasks.values()],
              "server": str(args.server.resolve()), "model": str(args.model.resolve()),
              "parser": str(parser), "contextLength": args.context,
              "gpuLayers": args.gpu_layers, "dist": str(args.dist.resolve()), "workers": args.workers}
    results = []
    # NODE_PATH also supports a saved baseline dist directory outside the extension.
    env = {**os.environ, "NODE_PATH": str(EXTENSION / "node_modules")}
    with subprocess.Popen(["node", str(ROOT / "provider.cjs")], env=env,
                          stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True) as worker:
        assert worker.stdin is not None and worker.stdout is not None
        worker.stdin.write(json.dumps(config))
        worker.stdin.close()
        try:
            for line in worker.stdout:
                result = json.loads(line)
                results.append(result)
                print(result["id"], "generated", f"{result['seconds']:.1f}s", result["diagnostics"], flush=True)
        finally:
            if len(results) < len(tasks) and worker.poll() is None:
                worker.terminate()
        if worker.wait(timeout=15) or len(results) != len(tasks):
            raise RuntimeError("Incomplete evaluation")
    order = {name: index for index, name in enumerate(tasks)}
    results.sort(key=lambda row: order[row["id"]])
    # Shut down inference before Docker starts to keep memory pressure from
    # turning an infrastructure timeout into a candidate failure.
    for result in results:
        code = result["code"]
        syntax = None
        if code:
            try:
                compile(code, "<candidate>", "exec")
            except SyntaxError as error:
                syntax = error.msg
        outcome = verify(f"CANDIDATE = {code!r}", tasks[result["id"]]["tests"]) if code and not syntax else None
        result.update(asdict(outcome) if outcome is not None else {"passed": False})
        result["syntax_error"] = syntax
        print(result["id"], result["passed"], flush=True)
    report = {"model": args.model.name, "model_sha256": digest(args.model), "size_bytes": size,
              "reference_only": args.reference, "context": args.context, "gpu_layers": args.gpu_layers,
              "fixture_sha256": digest(fixture), "suite": args.suite,
              "passed": sum(row["passed"] for row in results), "total": len(results), "results": results}
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model", type=Path)
    parser.add_argument("report", type=Path)
    parser.add_argument("--server", type=Path, default=ARTIFACTS / "python-v2/llama-b12244/llama-server")
    parser.add_argument("--suite", choices=["diagnostic", "holdout"], required=True)
    parser.add_argument("--dist", type=Path, default=EXTENSION / "dist")
    parser.add_argument("--context", type=int, default=4096)
    parser.add_argument("--gpu-layers", type=int, default=0)
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("--reference", action="store_true")
    evaluate(parser.parse_args())
