"""Import licensed HumanEval, MultiPL-E, or held-out JSONL fixtures."""

import gzip
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from data.sources.licensing import licenses


@dataclass(frozen=True)
class Task:
    id: str
    suite: str
    language: str
    prompt: str
    tests: str
    expected: str | None
    suffix: str
    license: str


def load_tasks(
    path: Path, suite: str, language: str, source_license: str | None
) -> list[Task]:
    allowlist = licenses()
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf8") as stream:
        records: list[dict[str, Any]] = [
            json.loads(line) for line in stream if line.strip()
        ]
    tasks = []
    for record in records:
        license_id = record.get("license", source_license)
        if license_id not in allowlist:
            raise ValueError(f"Unapproved evaluation license: {license_id}")
        if suite == "humaneval":
            tests = f"{record['test']}\ncheck({record['entry_point']})"
        elif suite == "multiple":
            tests = record["tests"]
            if isinstance(tests, list):
                tests = "\n".join(tests)
        else:
            tests = record.get("tests", "")
        task = Task(
            id=str(record.get("task_id") or record.get("name") or record["id"]),
            suite=suite,
            language=language,
            prompt=record["prompt"],
            tests=tests,
            expected=record.get("expected"),
            suffix=record.get("suffix", ""),
            license=license_id,
        )
        if not (task.tests or task.expected is not None):
            raise ValueError(f"No expected output or execution tests: {task.id}")
        tasks.append(task)
    if not tasks or len({task.id for task in tasks}) != len(tasks):
        raise ValueError("Evaluation requires a nonempty set of unique task IDs")
    return tasks
