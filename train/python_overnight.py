"""Search for a better local Python GGUF within a wall-clock budget."""

import argparse
import math
import os
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any

from data.pipelines.filtering import records
from data.sources.licensing import licenses
from eval.report import digest
from package.build_manifest import LIMIT
from train.cpp_overnight import (
    ARTIFACTS,
    CPP,
    ROOT,
    RUNTIME,
    cleanup_sandboxes,
    read_report,
    run_stage,
)
from train.run import write_json
from verifiers.python.runner import IMAGE

BRIEF = ARTIFACTS / "python-brief"
BASE = ARTIFACTS / "python-base-comparison/scaled"


def improves(candidate: dict[str, Any], incumbent: dict[str, Any]) -> bool:
    if not 0 < candidate["size_bytes"] < LIMIT:
        return False
    if candidate["passed"] != incumbent["passed"]:
        return bool(candidate["passed"] > incumbent["passed"])
    speed = sum(float(case["seconds"]) for case in candidate["results"])
    previous = sum(float(case["seconds"]) for case in incumbent["results"])
    return 0 < speed <= previous * 0.95


def search(output: Path, hours: float, threads: int) -> None:
    deadline = time.monotonic() + hours * 3600
    run_id = uuid.uuid4().hex
    environment = {
        **os.environ,
        "PYTHONPATH": f"{ROOT}:{CPP / 'tooling/llama.cpp-b12244/gguf-py'}",
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "TESSERA_TRAIN_THREADS": str(threads),
        "LLAMA_ARG_THREADS": str(threads),
        "PYTHONUNBUFFERED": "1",
        "TESSERA_VERIFIER_RUN_ID": run_id,
    }
    trainer = BRIEF / "streaming_finetune.py"
    evaluator = BRIEF / "evaluate.py"
    server = RUNTIME / "llama-server"
    quantizer = RUNTIME / "llama-quantize"
    incumbent = Path(f"{BASE}.f16.gguf")
    baseline = Path(f"{BASE}.Q4_0.gguf")
    summary: dict[str, Any] = {"status": "running", "best": None, "rounds": []}

    def save() -> None:
        pending = output / ".summary.json"
        write_json(pending, summary)
        pending.replace(output / "summary.json")

    def stage(log: Path, *command: str) -> None:
        run_stage(list(command), log, deadline, environment)

    def evaluate(model: Path, folder: Path) -> dict[str, Any]:
        report = folder / "evaluation.json"
        stage(
            folder / "evaluate.log",
            sys.executable,
            str(evaluator),
            str(model),
            str(report),
            "--server",
            str(server),
            # A single CPU thread can need much longer than the interactive limit.
            "--request-timeout",
            str(max(1, deadline - time.monotonic())),
        )
        return read_report(report)

    save()
    try:
        audit = read_report(BRIEF / "corpus-audit.json")
        corpus = BRIEF / "training-briefs.jsonl"
        allowed = licenses()
        if (
            audit["overlap"] != 0
            or digest(corpus) != audit["data_sha256"]
            or any(row["license"] not in allowed for row in records(corpus))
        ):
            raise ValueError("Python training corpus failed its audit")
        holdout = BRIEF / "heldout-briefs.jsonl"
        frozen = audit["benchmarks"][str(holdout)]
        if digest(holdout) != frozen:
            raise ValueError("Python evaluation snapshot changed")
        initial = evaluate(baseline, output)
        if initial["fixture_sha256"] != frozen or initial["total"] <= 0:
            raise ValueError("Baseline benchmark did not use the frozen fixtures")
        summary.update(baseline=initial, best=initial)
        save()
        settings = ((4e-5, 1), (8e-5, 2), (2e-5, 2), (1.2e-4, 1))
        iteration = 0
        while time.monotonic() < deadline:
            if shutil.disk_usage(output).free < 5_000_000_000:
                raise ValueError("Need 5 GB of free disk space for the next round")
            cycle, index = divmod(iteration, len(settings))
            rate, epochs = settings[index]
            rate /= math.sqrt(cycle + 1)
            iteration += 1
            folder = output / f"round-{iteration:03}"
            folder.mkdir()
            checkpoint = folder / "python-brief.f16.gguf"
            model = folder / "python-brief.Q4_0.gguf"
            entry: dict[str, Any] = {
                "round": iteration,
                "learning_rate": rate,
                "epochs": epochs,
                "parent": str(incumbent),
                "promoted": False,
            }
            try:
                stage(
                    folder / "train.log",
                    sys.executable,
                    str(trainer),
                    "--output",
                    str(folder),
                    "--active",
                    str(incumbent),
                    "--epochs",
                    str(epochs),
                    "--learning-rate",
                    str(rate),
                )
                stage(
                    folder / "quantize.log",
                    str(quantizer),
                    str(checkpoint),
                    str(model),
                    "Q4_0",
                    str(threads),
                )
                if not 0 < model.stat().st_size < LIMIT:
                    raise ValueError(
                        "Quantized Python candidate exceeds the size limit"
                    )
                result = evaluate(model, folder)
                if (
                    result["fixture_sha256"] != frozen
                    or result["total"] != initial["total"]
                ):
                    raise ValueError(
                        "Candidate benchmark did not use the frozen fixtures"
                    )
                entry["evaluation"] = str(folder / "evaluation.json")
                if improves(result, summary["best"]):
                    incumbent = checkpoint
                    summary.update(best=result, training_checkpoint=str(checkpoint))
                    entry["promoted"] = True
            except (TimeoutError, KeyboardInterrupt):
                entry["status"] = "interrupted"
                raise
            finally:
                summary["rounds"].append(entry)
                save()
                if not entry["promoted"]:
                    for weights in folder.glob("python-brief.*"):
                        weights.unlink()
        summary["status"] = "finished"
    except (TimeoutError, KeyboardInterrupt) as error:
        summary["status"] = (
            "finished" if isinstance(error, TimeoutError) else "interrupted"
        )
        try:
            cleanup_sandboxes(run_id)
        except (OSError, subprocess.SubprocessError) as cleanup_error:
            summary["sandbox_cleanup_error"] = str(cleanup_error)
        if isinstance(error, KeyboardInterrupt):
            raise
    except Exception as error:
        summary.update(status="failed", error=str(error))
        raise
    finally:
        save()
    print(f"Results in {output / 'summary.json'}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--hours", type=float, default=24)
    parser.add_argument("--threads", type=int, default=1)
    args = parser.parse_args()
    if not math.isfinite(args.hours) or args.hours <= 0 or args.threads < 1:
        parser.error("Hours and threads must be positive")
    try:
        subprocess.run(
            ["docker", "image", "inspect", IMAGE],
            stdout=subprocess.DEVNULL,
            check=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as error:
        parser.exit(
            1,
            f"Docker verifier unavailable. Start Docker and run docker pull '{IMAGE}'\n{error}\n",
        )
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    try:
        search(output, args.hours, args.threads)
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
