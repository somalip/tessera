import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from eval.report import digest
from package.build_manifest import build
from train.config import load


class PackageTests(unittest.TestCase):
    def test_gate_and_size_are_required(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model, report, license_file = [root / name for name in ("model.gguf", "report.json", "LICENSE")]
            model.write_bytes(b"GGUFtest")
            license_file.write_text("fixture license")
            package = root / "model.tcm"
            metadata = dict(id="python-tiny", version="0.1.0", language_ids=["python"],
                            vscode_language_ids=["python"], file_globs=["**/*.py"],
                            base_model="qwen", params=1, quant="Q4_K_M", context_length=2048,
                            prompt_formats=dict(fim=dict(prefix="P", suffix="S", middle="M"),
                                                chat_template="chatml"),
                            capabilities=["fim"], min_runtime=dict(llama_cpp_build="b8180"))
            evaluation = dict(language="python", model_sha256=digest(model), gate_passed=False)
            report.write_text(json.dumps(evaluation))
            with self.assertRaisesRegex(ValueError, "passing evaluation"):
                build(model, metadata, report, license_file, "MIT", package)
            build(model, metadata, report, license_file, "MIT", package, smoke=True)
            with zipfile.ZipFile(package) as archive:
                self.assertEqual(archive.read("model.Q4_K_M.gguf"), b"GGUFtest")
                manifest = json.loads(archive.read("manifest.json"))
                self.assertEqual(manifest["sha256"], digest(model))
            with self.assertRaises(FileExistsError):
                build(model, metadata, report, license_file, "MIT", package, smoke=True)
            with model.open("r+b") as weights:
                weights.truncate(1_000_000_000)
            with self.assertRaisesRegex(ValueError, "size ceiling"):
                build(model, metadata, report, license_file, "MIT", root / "large.tcm")

    def test_config_inheritance(self) -> None:
        config = load(Path("train/configs/python-smoke.yaml"))
        self.assertEqual(config["language"], "python")
        self.assertEqual(config["quant"], "Q4_K_M")
        self.assertTrue(config["smoke"])
