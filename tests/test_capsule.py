import json
import os
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from capsule.host import ChatModel, load_models
from capsule.memory import Memory
from capsule.router import Check, Message, WorkOrder, minimize, plan, run, select
from capsule.verify import verify
from eval.capsule_report import metrics
from train.capsule_lora import examples
from verifiers.sandbox import Outcome


class FakeModel:
    language = "python"
    difficulty = "routine"
    roles: tuple[str, ...] = ("planner", "implement", "repair")

    def __init__(self, name: str, answers: list[str], tier: int = 0) -> None:
        self.id = name
        self.answers = iter(answers)
        self.tier = tier
        self.calls: list[list[Message]] = []

    def count(self, messages: list[Message]) -> int:
        return 50 + 10 * len(json.loads(messages[-1]["content"]).get("signatures", []))

    def chat(self, messages: list[Message], seed: int = 0, *,
             schema: dict[str, object] | None = None) -> str:
        self.calls.append(messages)
        return next(self.answers)


class Capsules(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.memory = Memory(self.root / "memory.sqlite3")
        self.enterContext(closing(self.memory.db))
        self.check = Check("contract", "test", "python", "assert answer() == 1")
        self.checks = {self.check.id: self.check}
        self.order = WorkOrder("one", "implement", "python", "def answer():", ("contract",), ("answer",))
        self.source = self.root / "main.py"
        self.source.write_text("def answer():\n    return dep()\n\ndef dep():\n    return 1\n", encoding="utf8")
        self.memory.index(self.root)

    def test_planner_validates_work_orders_and_trusted_checks(self) -> None:
        row = {"id": "one", "role": "implement", "language": "python", "signature": "def answer():",
               "acceptance_checks": ["contract"], "needs_symbols": ["answer"]}
        model = FakeModel("planner", [json.dumps([row]), json.dumps([{**row, "acceptance_checks": ["shell"]}])])
        self.assertEqual(plan(model, "write answer", "typescript", self.checks, 1500), [self.order])
        self.assertEqual(json.loads(model.calls[0][1]["content"])["language_hint"], "typescript")
        with self.assertRaisesRegex(ValueError, "known"):
            plan(model, "write answer", "python", self.checks, 1500)

    def test_index_follows_dependency_and_preserves_history_on_delete_and_restore(self) -> None:
        self.assertEqual([symbol.name for symbol in self.memory.signatures(("answer",))], ["answer", "dep"])
        source = self.source.read_bytes()
        self.memory.index(self.root)
        self.assertEqual(self.memory.db.execute("SELECT count(*) FROM files").fetchone()[0], 1)
        self.source.unlink()
        self.memory.index(self.root)
        self.assertFalse(self.memory.signatures(("answer",)))
        self.source.write_bytes(source)
        self.memory.index(self.root)
        self.assertEqual(len(self.memory.signatures(("answer",))), 2)
        self.assertEqual(self.memory.db.execute("SELECT count(*) FROM symbols").fetchone()[0], 2)

    def test_route_signature_cap_retry_and_escalation_record(self) -> None:
        small = FakeModel("small", ["bad", "bad again"])
        large = FakeModel("large", ["pass"], tier=1)
        anything = FakeModel("generic", [])
        anything.language = "*"
        complex_model = FakeModel("complex", [])
        complex_model.difficulty = "complex"
        self.assertIs(select([anything, small, complex_model], "implement", "complex", "python", 0), complex_model)
        self.assertIs(select([anything, small], "implement", "routine", "python", 0), small)
        log: list[dict[str, object]] = []
        result = run(self.order, "solve it", self.checks, [small, large], self.memory,
                     lambda _, code: Outcome(code == "pass", 1), cap=60, retries=1,
                     minimize_context=False, training=log.append)
        payload = json.loads(small.calls[0][1]["content"])
        self.assertEqual(payload["signatures"], [["main.py", "answer", "def answer():"]])
        self.assertNotIn("return dep()", small.calls[0][1]["content"])
        self.assertIn("contract:1", small.calls[1][1]["content"])
        self.assertEqual(log[0]["fixed_code"], "pass")
        self.assertTrue(result["passed"])
        self.assertEqual(self.memory.db.execute("SELECT count(*) FROM decisions").fetchone()[0], 1)
        self.assertEqual(metrics([result])["escalation_rate"], 1)
        self.assertEqual(metrics([result])["avg_capsule_tokens"], 60)
        self.assertEqual(metrics([result])["pass_at_1"], 0)

    def test_hard_cap_prevents_coder_call(self) -> None:
        model = FakeModel("small", ["unexpected"])
        with self.assertRaisesRegex(ValueError, "hard prompt token cap"):
            run(self.order, "solve it", self.checks, [model], self.memory,
                lambda _, code: Outcome(True, 0), cap=49)
        self.assertFalse(model.calls)

    def test_minimizer_and_stale_recipe_fallback(self) -> None:
        self.assertEqual(minimize([0, 1, 2, 3], lambda sub: 2 in sub), [2])
        model = FakeModel("small", ["full", "minimized", "empty", "stale", "fallback"])
        first = run(self.order, "first", self.checks, [model], self.memory,
                    lambda _, code: Outcome(code in {"full", "minimized"}, 1), retries=0)
        self.assertEqual(first["code"], "minimized")
        self.assertEqual(first["retained_signatures"], 1)
        second = run(self.order, "second", self.checks, [model], self.memory,
                     lambda _, code: Outcome(code == "fallback", 1), retries=0, minimize_context=False)
        self.assertTrue(second["passed"])
        self.assertEqual(len(json.loads(model.calls[3][1]["content"])["signatures"]), 1)
        self.assertEqual(len(json.loads(model.calls[4][1]["content"])["signatures"]), 2)

    def test_escalated_recipe_is_reused_when_the_same_model_is_reached(self) -> None:
        small = FakeModel("small", ["bad", "bad"])
        large = FakeModel("large", ["full", "minimized", "empty", "minimized"], tier=1)
        def verifier(_: Check, code: str) -> Outcome:
            return Outcome(code in {"full", "minimized"}, 1)


        first = run(self.order, "first", self.checks, [small, large], self.memory, verifier, retries=0)
        second = run(self.order, "second", self.checks, [small, large], self.memory, verifier,
                     retries=0, minimize_context=False)
        self.assertEqual(first["retained_signatures"], 1)
        self.assertTrue(second["passed"])
        self.assertEqual(len(json.loads(large.calls[-1][1]["content"])["signatures"]), 1)

    def test_checks_use_fixed_commands_in_existing_sandbox(self) -> None:
        with patch("capsule.verify.run_container", return_value=Outcome(True, 0)) as sandbox:
            self.assertTrue(verify(Check("types", "typecheck", "python", ""), "candidate").passed)
            self.assertIn("mypy --strict", sandbox.call_args.args[1][2])
            self.assertEqual(sandbox.call_args.args[2], "candidate")
            verify(Check("lint", "lint", "python", ""), "candidate")
            self.assertIn("ruff check", sandbox.call_args.args[1][2])
            with self.assertRaises(ValueError):
                verify(Check("arbitrary", "shell", "python", "unsupported"), "candidate")

    @unittest.skipUnless(os.environ.get("TESSERA_QUALITY_DOCKER"), "Capsule quality integration is opt-in")
    def test_quality_checks_run_in_preinstalled_sandbox(self) -> None:
        docker = os.environ["TESSERA_QUALITY_DOCKER"]
        code = "def answer() -> int:\n    return 42\n"
        types = Check("types", "typecheck", "python", "")
        lint = Check("lint", "lint", "python", "")
        self.assertTrue(verify(types, code, docker).passed)
        self.assertFalse(verify(types, code.replace("42", "'wrong'"), docker).passed)
        self.assertFalse(verify(lint, "import os\n" + code, docker).passed)
        self.assertTrue(verify(lint, "while True:\n    pass\n", docker).passed)

    def test_remote_off_and_base_plus_lora_size_ceiling(self) -> None:
        with load_models([{"id": "remote", "tier": 2}], "unused") as models:
            self.assertEqual(models, [])
        gguf = self.root / "base.gguf"
        gguf.write_bytes(b"model")
        with load_models([{"id": "local", "path": str(gguf), "preamble": "specialty"}], "unused") as models:
            self.assertIsInstance(models[0], ChatModel)
            self.assertEqual(models[0].messages([{"role": "system", "content": "task"}])[0]["content"],
                             "specialty\ntask")
        with gguf.open("r+b") as model:
            model.truncate(999_999_999)
        adapter = self.root / "adapter.gguf"
        adapter.write_bytes(b"lora")
        with self.assertRaisesRegex(ValueError, "less than 1 GB"):
            with load_models([{"id": "local", "path": str(gguf), "adapter": str(adapter)}], "unused"):
                self.fail("Model exceeds size ceiling")

    def test_training_ingest_reverifies_and_filters(self) -> None:
        benchmark = self.root / "benchmark.jsonl"
        duplicate = "A frozen benchmark phrase for the model to never memorize."
        benchmark.write_text(json.dumps({"prompt": duplicate}), encoding="utf8")
        log = self.root / "escalations.jsonl"
        example = {"order": {"language": "python"}, "fixed_code": "pass",
                   "capsule": [{"role": "system", "content": "Write code"}, {"role": "user", "content": "Solve it"}],
                   "license": "CC0-1.0",
                   "checks": [{"id": "contract", "kind": "test", "language": "python", "source": "assert True"}]}
        rows = [example, {**example, "license": ""}, {**example, "fixed_code": duplicate},
                {**example, "fixed_code": None}, {**example, "fixed_code": "bad"}]
        log.write_text("\n".join(json.dumps(row) for row in rows), encoding="utf8")
        self.assertEqual(list(examples(log, [benchmark], "python",
                                      lambda _, code: Outcome(code == "pass", 1))), [(example["capsule"], "pass")])
