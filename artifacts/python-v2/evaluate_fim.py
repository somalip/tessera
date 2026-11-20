"""Score Python inline completion using the existing FIM prompt and sandbox."""
import json
import os
import sys
from dataclasses import asdict
from pathlib import Path

from data.pipelines.filtering import Contamination, records, tokens
from eval.inference import serve
from eval.report import digest, fim
from eval.suites.records import load_tasks
from verifiers.python.runner import verify

root = Path(__file__).resolve().parent
fixtures = root / "fim.jsonl"
contamination = Contamination([fixtures])
for row in records(root.parent / "python-local" / "supervised-filtered.jsonl"):
    content = "\n".join(row[field] for field in ("prompt", "solution", "tests"))
    if contamination.overlaps(content, tokens(content)):
        raise ValueError(f"Overlapping prior training example: {row['id']}")

tasks = load_tasks(fixtures, "fim", "python", None)
for task in tasks:
    assert verify(task.prompt + task.expected + task.suffix, task.tests).passed, task.id

model, report = map(Path, sys.argv[1:])
results = []
with serve(model, os.environ["TINY_FIM_SERVER"], 2048) as client:
    for task in tasks:
        text = client.complete(fim(task.prompt, task.suffix), max_tokens=96)
        result = verify(task.prompt + text + task.suffix, task.tests)
        results.append(dict(id=task.id, exact=text.strip() == task.expected.strip(), **asdict(result)))

report.write_text(json.dumps(dict(model_sha256=digest(model), dataset_sha256=digest(fixtures),
                                  results=results), indent=2) + "\n")
