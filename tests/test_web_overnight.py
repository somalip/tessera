import json
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch

from train.web_overnight import LANGUAGES, freeze_inputs, search


class WebOvernightTest(unittest.TestCase):
    def test_default_fixtures_pass_decontamination(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            inputs = freeze_inputs(Path(temp))
            self.assertEqual(tuple(inputs), LANGUAGES)

    def test_search_rotates_languages_and_keeps_one_candidate_each(self) -> None:
        attempted = []

        def stage(
            command: list[str], log: Path, deadline: float, env: dict[str, str]
        ) -> None:
            job = json.loads(Path(command[-1]).read_text())
            round_dir = Path(job["round"])
            language = round_dir.parent.name
            attempted.append(language)
            if language == "html" and round_dir.name == "round-2":
                raise TimeoutError("test deadline")
            scores = {"round-1": 0, "round-2": 2, "round-3": 1}
            (round_dir / "model.Q8_0.gguf").write_bytes(b"GGUF")
            (round_dir / "evaluation.json").write_text(
                json.dumps(
                    {
                        "holdout_sha256": job["holdout_sha256"],
                        "passed": scores[round_dir.name],
                        "raw_passed": 0,
                    }
                )
            )

        args = Namespace(
            base=Path("base"),
            specialists=Path("specialists"),
            converter=Path("converter"),
            server=Path("server"),
            quantizer=Path("quantizer"),
            hours=1,
            threads=1,
            device="cpu",
            steps=1,
            rounds=3,
        )
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp)
            with patch("train.web_overnight.run_stage", side_effect=stage):
                search(args, output)
            self.assertEqual(attempted, list(LANGUAGES) * 3)
            summary = json.loads((output / "summary.json").read_text())
            self.assertEqual(summary["status"], "finished")
            for language in LANGUAGES:
                best_round = "round-3" if language == "html" else "round-2"
                folder = output / language
                winner = folder / best_round / "model.Q8_0.gguf"
                self.assertEqual((folder / "best.gguf").resolve(), winner.resolve())
                self.assertEqual(list(folder.glob("round-*/*.gguf")), [winner])
