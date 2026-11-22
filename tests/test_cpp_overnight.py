import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from eval.report import digest
from package.build_manifest import LIMIT
from train.cpp_overnight import improves, reuse_checkpoint, run_stage
from train.run import write_json


class OvernightSelectionTests(unittest.TestCase):
    def test_requires_retained_passes_speed_and_strict_size_limit(self) -> None:
        baseline = {"passed": ["loop"], "stopped": 6, "inference_ms": 1_000}
        candidate = {
            "passed": ["loop", "parse"],
            "stopped": 6,
            "inference_ms": 950,
            "size_bytes": LIMIT - 1,
        }
        self.assertTrue(improves(candidate, baseline))
        for regression in (
            {"passed": ["loop"]},
            {"passed": ["parse", "sort"]},
            {"stopped": 5},
            {"inference_ms": 951},
            {"size_bytes": LIMIT},
        ):
            with self.subTest(regression=regression):
                self.assertFalse(improves({**candidate, **regression}, baseline))

    def test_child_is_stopped_when_budget_expires(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "stage.log"
            command = [
                sys.executable,
                "-u",
                "-c",
                "import time; print('started'); time.sleep(60)",
            ]
            with self.assertRaisesRegex(TimeoutError, "stage"):
                run_stage(command, log, time.monotonic() + 1, dict(os.environ))
            self.assertEqual(log.read_text(), "started\n")


class OvernightCheckpointTests(unittest.TestCase):
    def test_reuse_rejects_weights_that_changed_since_training(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "new"
            output.mkdir()
            base = root / "v4"
            base.mkdir()
            write_json(base / "training-report.json", {"trained_f16_sha256": "start"})
            weights = root / "cpp-generation.f16.gguf"
            weights.write_bytes(b"original")
            write_json(root / "training.json", {"corpus_audit": {}})
            write_json(
                root / "training-report.json",
                {
                    "dataset": {},
                    "active_f16_sha256": "start",
                    "trained_f16_sha256": digest(weights),
                },
            )
            (root / "training.jsonl").write_text("{}", encoding="utf8")
            with patch("train.cpp_overnight.SUITE", root):
                reuse_checkpoint(root, output)
                self.assertEqual((output / weights.name).read_bytes(), b"original")
                weights.write_bytes(b"changed")
                with self.assertRaisesRegex(ValueError, "provenance checks"):
                    reuse_checkpoint(root, output)
                self.assertEqual((output / weights.name).read_bytes(), b"original")


class ContinuousSearchTests(unittest.TestCase):
    def test_promoted_weights_are_used_by_next_round_until_deadline(self) -> None:
        from train.cpp_overnight import search

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            round_one = output / "round-001"
            best = round_one / "cpp-generation.Q4_0.gguf"
            full = round_one / "cpp-generation.f16.gguf"

            def promote(run: Path, *args: object, **kwargs: object) -> None:
                best.touch()
                full.touch()
                (run / "cpp-generation.IQ4_NL.gguf").touch()
                write_json(
                    run / "summary.json",
                    {"status": "finished", "best": {"model": str(best)}},
                )

            def time_out(run: Path, *args: object, **kwargs: object) -> None:
                self.assertEqual(kwargs["start"], full)
                self.assertEqual(kwargs["baseline_model"], best)
                write_json(run / "summary.json", {"status": "timed_out", "best": None})
                raise TimeoutError

            with patch("train.cpp_overnight.sweep", side_effect=[None]) as sweep:
                from collections.abc import Callable

                rounds: list[Callable[..., None]] = [promote, time_out]
                sweep.side_effect = lambda *args, **kwargs: rounds.pop(0)(
                    *args, **kwargs
                )
                search(output, Path("server"), 6, None, 6, 99)
                self.assertEqual(sweep.call_count, 2)
            self.assertTrue(best.exists())
            self.assertTrue(full.exists())
            self.assertFalse((round_one / "cpp-generation.IQ4_NL.gguf").exists())
