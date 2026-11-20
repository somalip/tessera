import json
import os
import tempfile
import unittest
from pathlib import Path

from eval.report import gate, score
from eval.suites.heldout import build
from eval.suites.records import load_tasks
from verifiers.python.runner import verify
from verifiers.sandbox import Outcome


class EvaluationTests(unittest.TestCase):
    def test_humaneval_import_and_deterministic_scoring(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "sample.jsonl"
            file.write_text(json.dumps(dict(task_id="example", prompt="def f():\n",
                                           test="def check(f): assert f() == 42",
                                           entry_point="f")), encoding="utf8")
            with self.assertRaisesRegex(ValueError, "license"):
                load_tasks(file, "humaneval", "python", "GPL-3.0-only")
            tasks = load_tasks(file, "humaneval", "python", "MIT")

        def verifier(code: str, tests: str) -> Outcome:
            self.assertEqual(code, "def f():\n    return 42\n")
            self.assertIn("check(f)", tests)
            return Outcome(True, 0)

        scores = [score(tasks, lambda _: "    return 42\n", verifier)["metrics"] for _ in range(3)]
        self.assertEqual(scores, [{"pass_at_1": 1.0}] * 3)
        self.assertTrue(gate({"humaneval": {"metrics": scores[0]}}, {}, {}))

    def test_heldout_builder_preserves_indentation_and_suffix(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "sample.py").write_text("def f():\n    value = 42\n    return value\n\n")
            example, = build(root, "MIT")
        self.assertEqual(example["expected"], "    return value\n")
        self.assertEqual(example["suffix"], "\n")
        self.assertEqual(len(example["source_sha256"]), 64)

    @unittest.skipUnless(os.environ.get("TESSERA_DOCKER"), "Docker integration is opt-in")
    def test_python_isolated_verifier(self) -> None:
        docker = os.environ["TESSERA_DOCKER"]
        self.assertTrue(verify("def f(): return 42", "assert f() == 42", docker=docker).passed)
        self.assertFalse(verify("def f(): return 0", "assert f() == 42", docker=docker).passed)
        self.assertFalse(verify("open('/etc/tessera', 'w')", "assert True", docker=docker).passed)
        self.assertTrue(verify("while True: pass", "assert True", timeout=3, docker=docker).timed_out)
