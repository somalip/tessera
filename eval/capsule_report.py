"""Compare model routes on fixed verifier work orders."""
import argparse
import json
import tempfile
from contextlib import closing
from pathlib import Path
from statistics import mean
from typing import Any

from capsule.host import load_models
from capsule.memory import Memory
from capsule.router import Check, WorkOrder, run
from capsule.verify import verify
from eval.report import digest
from eval.suites.records import load_tasks
from verifiers.compiled import LANGUAGES


def metrics(runs: list[dict[str, Any]]) -> dict[str, float]:
    attempts = [[a for a in run["attempts"] if a["phase"] == "candidate"] for run in runs]
    return {
        "pass_at_1": mean(attempt[0]["passed"] for attempt in attempts),
        "escalation_rate": mean(any(a["tier"] > 0 for a in attempt) for attempt in attempts),
        "avg_capsule_tokens": mean(a["tokens"] for attempt in attempts for a in attempt),
        "final_pass_rate": mean(run["passed"] for run in runs),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, action="append", required=True)
    parser.add_argument("--escalation-model", type=Path)
    parser.add_argument("--suite", default="heldout")
    parser.add_argument("--fixtures", type=Path, required=True)
    parser.add_argument("--license")
    parser.add_argument("--lang", choices=LANGUAGES, default="python")
    parser.add_argument("--server", default="llama-server")
    parser.add_argument("--docker", default="docker")
    parser.add_argument("--retries", type=int, default=1)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    tasks = load_tasks(args.fixtures, args.suite, args.lang, args.license)
    if any(not task.tests or task.suffix for task in tasks):
        parser.error("Capsule evaluation requires complete-source execution fixtures")
    report: dict[str, Any] = {"suite": args.suite, "fixture_sha256": digest(args.fixtures),
                              "retries": args.retries, "models": []}
    for path in args.model:
        specs = [{"id": path.name, "path": str(path)}]
        if args.escalation_model:
            specs.append({"id": args.escalation_model.name, "path": str(args.escalation_model), "tier": 1})
        with tempfile.TemporaryDirectory() as tmp, load_models(specs, args.server) as models:
            memory = Memory(Path(tmp) / "memory.sqlite3")
            with closing(memory.db):
                runs = []
                for task in tasks:
                    check = Check("suite", "test", task.language, task.tests)
                    # The contract comes from the frozen fixture, so planner errors cannot confound this comparison.
                    order = WorkOrder(task.id, "implement", task.language, task.prompt, ("suite",), ())
                    result = run(order, "", {"suite": check}, models, memory,
                                 lambda c, code: verify(c, code, args.docker), retries=args.retries,
                                 minimize_context=False)
                    result.pop("code", None)
                    runs.append(result)
        report["models"].append({"id": path.name, "sha256": digest(path), **metrics(runs), "results": runs})
        args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf8")


if __name__ == "__main__":
    main()
