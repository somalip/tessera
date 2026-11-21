"""Score a local GGUF against versioned, licensed evaluation fixtures."""

import argparse
import hashlib
import json
import time
from collections.abc import Callable
from dataclasses import asdict
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

import yaml

from eval.inference import serve
from eval.suites.records import Task, load_tasks
from verifiers.compiled import LANGUAGES, verifier
from verifiers.sandbox import Outcome

GATES = Path(__file__).with_name("gates.yaml")
Verifier = Callable[[str, str], Outcome]


def fim(prefix: str, suffix: str, budget: int = 2048) -> str:
    right = suffix.encode()[: budget // 4]
    left = prefix.encode()[-(budget - len(right)) :]
    return (
        "<|fim_prefix|>"
        + left.decode(errors="ignore")
        + "<|fim_suffix|>"
        + right.decode(errors="ignore")
        + "<|fim_middle|>"
    )


def score(
    tasks: list[Task], complete: Callable[[str], str], verifier: Verifier
) -> dict[str, Any]:
    results = []
    for task in tasks:
        prompt = fim(task.prompt, task.suffix) if task.suite == "fim" else task.prompt
        start = time.perf_counter()
        candidate = complete(prompt)
        row: dict[str, Any] = {
            "id": task.id,
            "latency_seconds": time.perf_counter() - start,
        }
        if task.tests:
            row.update(
                asdict(verifier(task.prompt + candidate + task.suffix, task.tests))
            )
        if task.expected is not None:
            prediction = candidate.strip()
            expected = task.expected.strip()
            row["exact_match"] = prediction == expected
            row["edit_similarity"] = SequenceMatcher(
                None, expected, prediction, autojunk=False
            ).ratio()
        results.append(row)
    metrics = {}
    for metric, key in [
        ("pass_at_1", "passed"),
        ("exact_match", "exact_match"),
        ("edit_similarity", "edit_similarity"),
    ]:
        if all(key in row for row in results):
            metrics[metric] = sum(row[key] for row in results) / len(results)
    return {"metrics": metrics, "tasks": results}


def gate(
    suites: dict[str, Any],
    baseline: dict[str, Any],
    competitor: dict[str, Any],
    language: str = "python",
) -> list[str]:
    requirements = yaml.safe_load(GATES.read_text(encoding="utf8"))
    failures = []
    for suite, metrics in requirements.items():
        if suite == "humaneval" and language != "python":
            continue
        for metric, thresholds in metrics.items():

            def get(
                report: dict[str, Any], suite_name: str, metric_name: str
            ) -> float | None:
                value = report.get(suite_name, {}).get("metrics", {}).get(metric_name)
                return (
                    float(value)
                    if isinstance(value, (float, int)) and 0 <= value <= 1
                    else None
                )

            actual, base, alternate = (
                get(report, suite, metric) for report in (suites, baseline, competitor)
            )
            if actual is None or base is None or alternate is None:
                failures.append(f"{suite}.{metric}: missing comparable metrics")
            elif actual + 1e-12 < max(
                thresholds["minimum"], base + thresholds["improvement"], alternate
            ):
                failures.append(f"{suite}.{metric}: score {actual:.4f} below gate")
    return failures


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lang", default="python", choices=LANGUAGES)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--suite", action="append", required=True, metavar="NAME=PATH")
    parser.add_argument(
        "--license",
        help="Verified source SPDX identifier for records without a license",
    )
    parser.add_argument(
        "--output", type=Path, default=Path("artifacts/eval_report.json")
    )
    parser.add_argument("--server", default="llama-server")
    parser.add_argument("--docker", default="docker")
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--competitor", type=Path)
    parser.add_argument("--training-audit", type=Path)
    parser.add_argument("--system-report", type=Path, action="append", default=[])
    args = parser.parse_args()
    if bool(args.baseline) != bool(args.competitor):
        parser.error(
            "Specify both baseline and competitor reports for release evaluation"
        )
    data = {}
    for argument in args.suite:
        name, _, filename = argument.partition("=")
        if (
            not filename
            or name in data
            or name not in yaml.safe_load(GATES.read_text(encoding="utf8"))
        ):
            parser.error(f"Invalid suite: {argument}")
        path = Path(filename)
        data[name] = (digest(path), load_tasks(path, name, args.lang, args.license))
    suites = {}
    with serve(args.model, args.server) as client:
        for name, (sha, tasks) in data.items():
            stop = (
                ("\ndef ", "\nclass ", "\n#", "\nif ", "\nprint(", "\n```")
                if name == "humaneval"
                else ()
            )
            suites[name] = {
                "dataset_sha256": sha,
                **score(
                    tasks,
                    lambda prompt: client.complete(prompt, extra_stop=stop),
                    verifier(args.lang, args.docker),
                ),
            }
    failures = ["Baseline and competitor reports are required for release"]
    if args.baseline and args.competitor:
        baseline = json.loads(args.baseline.read_text(encoding="utf8"))
        competitor = json.loads(args.competitor.read_text(encoding="utf8"))
        failures = gate(suites, baseline["suites"], competitor["suites"], args.lang)
        for reference in (baseline, competitor):
            if reference.get("language") != args.lang:
                failures.append("A reference was scored on a different language")
            for name, result in suites.items():
                if result["dataset_sha256"] != reference["suites"].get(name, {}).get(
                    "dataset_sha256"
                ):
                    failures.append(
                        f"{name}: reference evaluated on different fixtures"
                    )
        if not args.training_audit:
            failures.append(
                "A licensed, decontaminated training corpus audit is required"
            )
        else:
            audit = json.loads(args.training_audit.read_text(encoding="utf8"))
            required = {suite["dataset_sha256"] for suite in suites.values()}
            if audit.get("accepted_overlap") != 0 or not required <= set(
                audit.get("benchmarks", [])
            ):
                failures.append(
                    "Training audit does not cover every evaluation fixture"
                )
    model_hash = digest(args.model)
    hardware = []
    for path in args.system_report:
        profile = json.loads(path.read_text(encoding="utf8"))
        hardware.append(profile)
        gates = profile.get("gates", {})
        required_gates = {
            "size",
            "prompt_window",
            "load_time",
            "first_token",
            "throughput",
            "resident_memory",
        }
        if profile.get("model_sha256") != model_hash or not all(
            gates.get(gate) is True for gate in required_gates
        ):
            failures.append(f"System profile failed for {path.name}")
    report = {
        "language": args.lang,
        "model_sha256": model_hash,
        "system_profiles": [
            {key: value for key, value in profile.items() if key != "runs"}
            for profile in hardware
        ],
        "model_size_bytes": args.model.stat().st_size,
        "suites": suites,
        "gate_passed": not failures,
        "gate_failures": failures,
    }
    if report["model_size_bytes"] >= 1_000_000_000:
        failures.append("GGUF is at or above the 1 GB size ceiling")
        report["gate_passed"] = False
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf8")
    if args.baseline and args.competitor and failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
