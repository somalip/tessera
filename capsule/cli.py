"""JSON-lines bridge for the VS Code task command."""
import argparse
import json
import os
import sys
from contextlib import closing
from dataclasses import asdict
from pathlib import Path

from capsule.host import load_models
from capsule.memory import Memory, canonical
from capsule.router import Check, plan, run, select
from capsule.verify import supported, verify


def main() -> None:
    args = argparse.ArgumentParser()
    args.add_argument("--workspace", type=Path, required=True)
    args.add_argument("--storage", type=Path, required=True)
    args.add_argument("--server", default="llama-server")
    args.add_argument("--docker", default="docker")
    options = args.parse_args()
    job = json.load(sys.stdin)
    checks = {}
    for record in job["checks"]:
        check = Check(**record)
        if not supported(check) or check.id in checks:
            raise ValueError(f"Duplicate or unsupported check: {check.id}")
        checks[check.id] = check
    if not checks:
        raise ValueError("Configure at least one acceptance check")
    remote = job.get("remote") is True
    for spec in job["models"]:
        if remote and spec.get("tier") == 2:
            spec["key"] = os.environ.get("TESSERA_REMOTE_KEY", "")

    def emit(event: dict[str, object]) -> None:
        print(canonical(event), flush=True)

    def training(event: dict[str, object]) -> None:
        row = canonical({**event, "license": job.get("training_license")}) + "\n"
        fd = os.open(options.storage / "escalations.jsonl", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, "wb", buffering=0) as log:
            log.write(row.encode())

    memory = Memory(options.storage / "memory.sqlite3")
    with (closing(memory.db),
          load_models(job["models"], options.server, remote=remote) as models):
        memory.index(options.workspace)
        cap = int(job.get("cap", 1500))
        if not 1 <= cap <= 3328:
            raise ValueError("Capsule token cap must be between 1 and 3328")
        hint = job.get("language", "*")
        planner = next((candidate for language in dict.fromkeys([hint, *(c.language for c in checks.values())])
                        if (candidate := select(models, "planner", "routine", language, 0)) is not None), None)
        if planner is None:
            raise ValueError("Configure a tier-0 planner for this language or for all languages")
        orders = plan(planner, job["request"], hint, checks, cap)
        emit({"phase": "plan", "model": planner.id, "orders": [asdict(order) for order in orders]})
        for order in orders:
            result = run(order, job["request"], checks, models, memory,
                         lambda check, code: verify(check, code, options.docker),
                         cap=cap, retries=int(job.get("retries", 2)), emit=emit, training=training)
            emit({"phase": "result", **result})


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError) as error:
        sys.exit(str(error))
