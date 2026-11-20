"""Verify Python track examples in the project's isolated sandbox."""
import ast
from concurrent.futures import ThreadPoolExecutor
import json
import re
from pathlib import Path

from tokenizers import Tokenizer

from data.pipelines.filtering import Contamination, SECRET, tokens
from data.sources.licensing import licenses
from eval.report import digest
from verifiers.python.runner import verify

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "exercism"
BENCHMARKS = [
    Path("/private/tmp/tessera-model/HumanEval.jsonl.gz"),
    ROOT.parent / "python-local/heldout.jsonl",
    ROOT.parent / "python-v2/heldout.jsonl",
    ROOT.parent / "python-v2/fim.jsonl",
    ROOT / "fresh-audited.jsonl",
]
NOTICE = re.compile(r"SPDX-License-Identifier:\s*(\S+)|licensed under ([^\n]+)", re.I)

def verify_record(row):
    module = row["module"]
    setup = (
        "import sys, types, unittest\n"
        f"module = types.ModuleType({module!r})\n"
        f"sys.modules[{module!r}] = module\n"
        f"exec(compile({row['solution']!r}, {module + '.py'!r}, 'exec'), module.__dict__)\n"
    )
    checks = (
        "test_module = types.ModuleType('isolated_tests')\n"
        f"exec(compile({row['tests']!r}, 'isolated_tests.py', 'exec'), test_module.__dict__)\n"
        "suite = unittest.defaultTestLoader.loadTestsFromModule(test_module)\n"
        "result = unittest.TextTestRunner().run(suite)\n"
        "raise SystemExit(not (result.testsRun > 0 and result.wasSuccessful()))\n"
    )
    return row, verify(setup, checks).passed

def main():
    allowed = licenses()
    if "MIT" not in allowed or not (SOURCE / "LICENSE").read_text().startswith("MIT License"):
        raise ValueError("Exercism track license is outside the allowlist")
    contamination = Contamination(BENCHMARKS)
    tokenizer = Tokenizer.from_file(str(ROOT.parent / "python-local/base/tokenizer.json"))
    revision = json.loads((ROOT / "exercism-revision.json").read_text())["sha"]
    candidate_rows = []
    skipped = {}
    for exercise in sorted((SOURCE / "exercises/practice").iterdir()):
        mod = exercise.name.replace("-", "_")
        paths = [
            exercise / ".docs/instructions.md", exercise / ".meta/example.py",
            exercise / f"{mod}_test.py", exercise / f"{mod}.py",
        ]
        if not all(path.is_file() for path in paths):
            skipped[exercise.name] = "missing inputs"
            continue
        instructions, solution, tests, starter = (path.read_text() for path in paths)
        content = "\n".join((instructions, solution, tests, starter))
        if any((s or text).strip() not in {"MIT", "the MIT License", "the MIT license."}
               for s, text in NOTICE.findall(content)):
            skipped[exercise.name] = "alternate license notice"
            continue
        cleaned = instructions.removeprefix("# Instructions").strip()
        prompt = f"Implement the required Python API.\n\n{cleaned}\n\nStarter code:\n{starter.strip()}"
        if SECRET.search(content) or contamination.overlaps(content, tokens(content)):
            skipped[exercise.name] = "overlap or private data"
            continue
        if "<|im_" in content or "<|fim_" in content:
            skipped[exercise.name] = "prompt control token"
            continue
        try:
            ast.parse(solution)
            tree = ast.parse(tests)
        except SyntaxError:
            skipped[exercise.name] = "invalid or unsupported Python syntax"
            continue
        if not any(isinstance(node, ast.Import) and any(alias.name == "unittest" for alias in node.names)
                   for node in tree.body):
            skipped[exercise.name] = "non-unittest test dependencies"
            continue
        lengths = [len(tokenizer.encode(value).ids) for value in (prompt, solution)]
        if sum(lengths) > 460 or lengths[-1] > 170:
            skipped[exercise.name] = "outside local sequence budget"
            continue
        candidate_rows.append(dict(id=exercise.name, module=mod, prompt=prompt, solution=solution.strip(),
                                   tests=tests, license="MIT", source_revision=revision,
                                   source_files=[str(path.relative_to(SOURCE)) for path in paths],
                                   format="chat"))
    accepted = []
    with ThreadPoolExecutor(max_workers=2) as pool:
        for row, passed in pool.map(verify_record, candidate_rows):
            print(row["id"], passed, flush=True)
            if passed:
                accepted.append(row)
            else:
                skipped[row["id"]] = "sandbox verification failed"
    if not accepted:
        raise RuntimeError("No approved training examples verified")
    output = ROOT / "exercism-verified.jsonl"
    output.write_text("".join(json.dumps(row) + "\n" for row in accepted))
    audit = dict(source="https://github.com/exercism/python", revision=revision, license="MIT",
                 source_license_sha256=digest(SOURCE/"LICENSE"), benchmarks=[digest(p) for p in BENCHMARKS],
                 accepted_overlap=0, accepted=len(accepted), data_sha256=digest(output), skipped=skipped)
    (ROOT / "corpus-audit.json").write_text(json.dumps(audit, indent=2) + "\n")
    print(f"Accepted {len(accepted)} verified exercises", flush=True)

if __name__ == "__main__":
    main()
