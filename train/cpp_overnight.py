"""Run an unattended, local C++ generation fine-tune and quantization sweep."""

import argparse
import contextlib
import importlib
import json
import math
import os
import shutil
import signal
import subprocess
import sys
import time
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from data.pipelines.filtering import Contamination, records, tokens
from data.sources.licensing import licenses
from eval.report import digest
from package.build_manifest import LIMIT
from train.run import write_json
from verifiers.compiled import COMPILERS
from verifiers.python.runner import IMAGE as PYTHON_IMAGE
from verifiers.sandbox import run_container

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "artifacts"
CPP = ARTIFACTS / "cpp-models"
SUITE = CPP / "competency"
RUNTIME = ARTIFACTS / "python-v2/llama-b12244"
BASE = ARTIFACTS / "python-local/base"
START = SUITE / "v4/cpp-generation.f16.gguf"
DEPLOYED = SUITE / "v4/cpp-generation-v4.Q4_0.gguf"
SERVER = ARTIFACTS / "python-strength/serve-metal"
PREDECESSOR = ARTIFACTS / "python-base-comparison/supervised.jsonl"


def read_report(path: Path) -> dict[str, Any]:
    report: dict[str, Any] = json.loads(path.read_text(encoding="utf8"))
    return report


def preflight(server: Path) -> None:
    paths = (
        SUITE / "run.py",
        SUITE / "v4/training.json",
        SUITE / "v4/training-report.json",
        ARTIFACTS / "python-base-comparison/training_report.json",
        SUITE / "v4/training.jsonl",
        CPP / "chat/holdout.jsonl",
        CPP / "tooling/llama.cpp-b12244/gguf-py/gguf/__init__.py",
        ARTIFACTS / "python-brief/streaming_finetune.py",
        PREDECESSOR,
        START,
        DEPLOYED,
        BASE / "model.safetensors",
        BASE / "LICENSE",
        RUNTIME / "llama-server",
        RUNTIME / "llama-quantize",
        RUNTIME / "llama-imatrix",
        server,
    )
    missing = [str(path) for path in paths if not path.is_file()]
    if missing:
        raise FileNotFoundError("Missing local inputs\n" + "\n".join(missing))
    if shutil.disk_usage(ARTIFACTS).free < 8_000_000_000:
        raise ValueError("Need at least 8 GB free for the fine-tune and candidates")
    subprocess.run(
        ["docker", "image", "inspect", COMPILERS["cpp"][0], PYTHON_IMAGE],
        stdout=subprocess.DEVNULL,
        timeout=30,
        check=True,
    )


def run_stage(
    command: list[str], log: Path, deadline: float, environment: dict[str, str]
) -> None:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("Overnight time budget expired")
    print(f"Running {log.stem}. Details in {log}", flush=True)
    with (
        log.open("wb") as stream,
        subprocess.Popen(
            command,
            cwd=ROOT,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=stream,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        ) as process,
    ):
        try:
            code = process.wait(timeout=remaining)
        except (subprocess.TimeoutExpired, KeyboardInterrupt) as error:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
            if isinstance(error, KeyboardInterrupt):
                raise
            raise TimeoutError(f"Time budget expired during {log.stem}") from error
        if code:
            raise RuntimeError(f"{log.stem} exited with status {code}. See {log}")


def audited_rows(path: Path, contamination: Contamination) -> Iterator[dict[str, Any]]:
    allowed = licenses()
    for row in records(path):
        if row["license"] not in allowed or any(
            contamination.overlaps(row[key], tokens(row[key]))
            for key in ("prompt", "solution")
        ):
            raise ValueError(
                f"{path} failed the license or overlap audit at {row['id']}"
            )
        yield row


def audit_inputs(output: Path) -> None:
    sys.path.insert(0, str(SUITE))
    benchmark = importlib.import_module("benchmark")
    holdout = output / "holdout.jsonl"
    allowed = licenses()
    rows = list(benchmark.rows())
    earlier = CPP / "chat/holdout.jsonl"
    if any(row["license"] not in allowed for row in [*rows, *records(earlier)]):
        raise ValueError("A benchmark license is outside the allowlist")
    holdout.write_text(
        "".join(json.dumps(row, sort_keys=True) + "\n" for row in rows),
        encoding="utf8",
    )
    training = read_report(SUITE / "v4/training.json")
    audit = training["corpus_audit"]
    stream = read_report(SUITE / "v4/training-report.json")
    predecessor = read_report(PREDECESSOR.with_name("training_report.json"))
    if (
        "Apache-2.0" not in allowed
        or stream["trained_f16_sha256"] != digest(START)
        or stream["dataset"] != audit
        or predecessor["supervised_sha256"] != digest(PREDECESSOR)
    ):
        raise ValueError(
            "The starting weights or predecessor corpus failed provenance checks"
        )
    corpus = SUITE / "v4/training.jsonl"
    if (
        audit["holdout_sha256"] != digest(holdout)
        or audit["training_sha256"] != digest(corpus)
        or audit["benchmarks"]["v1-holdout.jsonl"] != digest(earlier)
    ):
        raise ValueError("The v4 training or benchmark snapshot changed")
    contamination = Contamination([holdout, earlier])
    for path in (corpus, PREDECESSOR):
        for _ in audited_rows(path, contamination):
            pass


def calibration(output: Path) -> Path:
    corpus = output / "training.jsonl"
    audit = read_report(output / "training.json")["corpus_audit"]
    holdout = output / "holdout.jsonl"
    earlier = CPP / "chat/holdout.jsonl"
    if (
        audit["training_sha256"] != digest(corpus)
        or audit["holdout_sha256"] != digest(holdout)
        or audit["benchmarks"]["v1-holdout.jsonl"] != digest(earlier)
    ):
        raise ValueError("The new training or benchmark snapshot changed")
    contamination = Contamination([holdout, earlier])
    text = "\n\n".join(row["solution"] for row in audited_rows(corpus, contamination))
    if not text.strip():
        raise ValueError("No audited C++ code for calibration")
    path = output / "cpp-calibration.txt"
    path.write_text(text + "\n", encoding="utf8")
    return path


def strict_results(
    output: Path, report: dict[str, Any], deadline: float, run_id: str
) -> dict[str, Any]:
    suite = importlib.import_module("run")
    fixtures = {
        row["id"]: row
        for row in records(output / "holdout.jsonl")
        if row["language"] == "cpp"
    }
    image, command = COMPILERS["cpp"]
    command = command.replace("g++ -std=c++20", "g++ -std=c++20 -D_GLIBCXX_DEBUG")
    cases = report["cases"]
    if len(cases) != len(fixtures) or {case["id"] for case in cases} != fixtures.keys():
        raise ValueError("Evaluation did not cover the frozen C++ suite")
    passed = []
    for result in cases:
        if not result["passed"]:
            continue
        row = fixtures[result["id"]]
        code, tests = suite.code_only(result["answer"]), row["tests"]
        if row.get("project_check"):
            code, tests = suite.program_harness(code, row["project_check"])
        elif row["before"] or row["after"]:
            code = suite.insert(row["before"], row["after"], code)
        remaining = deadline - time.monotonic()
        if remaining < 55:
            raise TimeoutError("Insufficient time for sandbox verification and cleanup")
        if run_container(
            image,
            ["/bin/sh", "-ec", command],
            f"{code}\n\n{tests}\n",
            timeout=45,
            executable_scratch=True,
            run_id=run_id,
        ).passed:
            passed.append(row["id"])
    return {
        "model": report["model"],
        "sha256": report["model_sha256"],
        "size_bytes": report["size_bytes"],
        "passed": sorted(passed),
        "stopped": report["stopped"],
        "total": len(fixtures),
        "inference_ms": sum(case["inference_ms"] for case in cases),
    }


def improves(candidate: dict[str, Any], baseline: dict[str, Any]) -> bool:
    return (
        0 < candidate["size_bytes"] < LIMIT
        and set(baseline["passed"]) < set(candidate["passed"])
        and candidate["stopped"] >= baseline["stopped"]
        and 0 < candidate["inference_ms"] <= baseline["inference_ms"] * 0.95
    )


def cleanup_sandboxes(run_id: str) -> None:
    containers = subprocess.check_output(
        [
            "docker",
            "container",
            "ls",
            "--all",
            "--quiet",
            "--filter",
            f"label=tessera.verifier-run={run_id}",
        ],
        text=True,
        timeout=10,
    ).split()
    if containers:
        subprocess.run(
            ["docker", "container", "rm", "-f", *containers], timeout=10, check=True
        )


def reuse_checkpoint(previous: Path, output: Path) -> None:
    training = read_report(previous / "training.json")
    details = read_report(previous / "training-report.json")
    expected_start = read_report(SUITE / "v4/training-report.json")[
        "trained_f16_sha256"
    ]
    weights = previous / "cpp-generation.f16.gguf"
    if (
        details["dataset"] != training["corpus_audit"]
        or details["active_f16_sha256"] != expected_start
        or details["trained_f16_sha256"] != digest(weights)
    ):
        raise ValueError("The previous checkpoint failed provenance checks")
    for name in (
        "training.json",
        "training-report.json",
        "training.jsonl",
        weights.name,
    ):
        shutil.copyfile(previous / name, output / name)


def sweep(output: Path, server: Path, hours: float, previous: Path | None) -> None:
    deadline = time.monotonic() + hours * 3600
    run_id = uuid.uuid4().hex
    environment = {
        **os.environ,
        "PYTHONPATH": f"{ROOT}:{CPP / 'tooling/llama.cpp-b12244/gguf-py'}",
        "PYTHONUNBUFFERED": "1",
        "TESSERA_VERIFIER_RUN_ID": run_id,
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "TINY_STRENGTH_REASONING_BUDGET": "0",
    }
    runner = [sys.executable, str(SUITE / "run.py")]
    summary: dict[str, Any] = {"status": "running", "best": None, "candidates": {}}

    def save() -> None:
        pending = output / ".summary.json"
        write_json(pending, summary)
        pending.replace(output / "summary.json")

    def stage(name: str, command: list[str]) -> None:
        run_stage(command, output / f"{name}.log", deadline, environment)

    def evaluate(label: str, model: Path) -> dict[str, Any]:
        stage(
            f"evaluate-{label}",
            [
                *runner,
                "evaluate",
                str(output),
                str(server),
                "--model",
                label,
                "cpp",
                str(model),
            ],
        )
        report = read_report(output / f"{label}.json")
        if report["benchmark_sha256"] != summary["benchmark_sha256"]:
            raise ValueError("Evaluation benchmark changed")
        return strict_results(output, report, deadline, run_id)

    save()
    try:
        audit_inputs(output)
        summary["benchmark_sha256"] = digest(output / "holdout.jsonl")
        if previous is None:
            stage(
                "train",
                [
                    *runner,
                    "train",
                    str(output),
                    str(BASE),
                    "--base-gguf",
                    str(START),
                    "--epochs",
                    "1",
                    "--learning-rate",
                    "0.00004",
                ],
            )
        else:
            reuse_checkpoint(previous, output)
            summary["reused_training"] = str(previous)
        text = calibration(output)
        summary["calibration_sha256"] = digest(text)
        baseline = evaluate("deployed", DEPLOYED)
        summary["baseline"] = baseline
        save()
        source = output / "cpp-generation.f16.gguf"
        matrix = output / "cpp.imatrix.gguf"
        stage(
            "calibrate",
            [
                str(RUNTIME / "llama-imatrix"),
                "-m",
                str(source),
                "-f",
                str(text),
                "-o",
                str(matrix),
                "-c",
                "128",
                "-ngl",
                "0",
                "-t",
                "4",
                "--no-ppl",
            ],
        )
        failures = False
        for quant, calibrated in (
            ("IQ4_NL", True),
            ("Q3_K_M", True),
            ("Q4_K_M", True),
            ("Q4_0", False),
        ):
            model = output / f"cpp-generation.{quant}.gguf"
            options = ["--imatrix", str(matrix)] if calibrated else []
            try:
                stage(
                    f"quantize-{quant}",
                    [
                        str(RUNTIME / "llama-quantize"),
                        *options,
                        str(source),
                        str(model),
                        quant,
                        "4",
                    ],
                )
            except RuntimeError as error:
                summary["candidates"][quant] = {"error": str(error)}
                failures = True
                save()
                continue
            if not 0 < model.stat().st_size < LIMIT:
                summary["candidates"][quant] = {
                    "size_bytes": model.stat().st_size,
                    "eligible": False,
                }
                save()
                continue
            try:
                result = evaluate(quant, model)
            except RuntimeError as error:
                summary["candidates"][quant] = {"error": str(error)}
                failures = True
                save()
                continue
            result["eligible"] = improves(result, baseline)
            summary["candidates"][quant] = result
            eligible = [
                entry
                for entry in summary["candidates"].values()
                if entry.get("eligible")
            ]
            if eligible:
                summary["best"] = min(
                    eligible,
                    key=lambda entry: (
                        -len(entry["passed"]),
                        entry["inference_ms"],
                        entry["size_bytes"],
                    ),
                )
            save()
        summary["status"] = "partial" if failures else "finished"
    except (TimeoutError, KeyboardInterrupt) as error:
        summary["status"] = (
            "timed_out" if isinstance(error, TimeoutError) else "interrupted"
        )
        summary["error"] = str(error)
        try:
            cleanup_sandboxes(run_id)
        except (OSError, subprocess.SubprocessError) as cleanup_error:
            summary["sandbox_cleanup_error"] = str(cleanup_error)
        raise
    except Exception as error:
        summary.update(status="failed", error=str(error))
        raise
    finally:
        save()
    print(f"Results in {output / 'summary.json'}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hours", type=float, default=8)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--server", default=SERVER, type=Path)
    parser.add_argument(
        "--reuse-training",
        type=Path,
        help="Reuse a completed fine-tune from an earlier run",
    )
    parser.add_argument(
        "--check", action="store_true", help="Check local prerequisites only"
    )
    args = parser.parse_args()
    if not math.isfinite(args.hours) or args.hours <= 0:
        parser.error("--hours must be positive and finite")
    if not args.check and args.output is None:
        parser.error("--output is required for a training run")
    server = args.server.resolve()
    preflight(server)
    if args.check:
        print("Local C++ training prerequisites found")
        return
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    previous = args.reuse_training.resolve() if args.reuse_training else None
    try:
        sweep(output, server, args.hours, previous)
    except TimeoutError as error:
        parser.exit(1, f"{error}. Results in {output / 'summary.json'}\n")


if __name__ == "__main__":
    main()
