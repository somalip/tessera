"""Build a validated .tcm package from evaluated GGUF weights."""

import argparse
import json
import re
import tempfile
import zipfile
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator  # type: ignore[import-untyped]

from data.sources.licensing import licenses
from eval.report import digest

LIMIT = 1_000_000_000
TARGET = 900_000_000
SCHEMAS = Path(__file__).resolve().parents[1] / "schemas"


def build(
    gguf: Path,
    metadata: dict[str, Any],
    report: Path,
    license_file: Path,
    license_id: str,
    output: Path,
    notice: Path | None = None,
    smoke: bool = False,
) -> dict[str, Any]:
    if (
        license_id not in licenses()
        or not license_file.is_file()
        or not license_file.stat().st_size
    ):
        raise ValueError("An allowlisted SPDX identifier and license text are required")
    size = gguf.stat().st_size
    if not 0 < size < LIMIT:
        raise ValueError("GGUF exceeds the hard model size ceiling or is empty")
    with gguf.open("rb") as stream:
        if stream.read(4) != b"GGUF":
            raise ValueError("Invalid GGUF header")
    quant = metadata["quant"]
    if not re.fullmatch(r"[A-Za-z0-9_-]+", quant):
        raise ValueError("Invalid quantization identifier")
    manifest = {
        **metadata,
        "schema_version": 1,
        "size_bytes": size,
        "sha256": digest(gguf),
    }
    Draft202012Validator(json.loads((SCHEMAS / "manifest.json").read_text())).validate(
        manifest
    )
    evaluation = json.loads(report.read_text(encoding="utf8"))
    if (
        evaluation.get("model_sha256") != manifest["sha256"]
        or evaluation.get("language") not in manifest["language_ids"]
    ):
        raise ValueError(
            "Evaluation report does not match the GGUF and package language"
        )
    if not smoke and evaluation.get("gate_passed") is not True:
        raise ValueError("Release packaging requires a passing evaluation report")
    if not smoke and evaluation.get("smoke"):
        raise ValueError("Smoke output is ineligible for release")
    encoded = json.dumps(manifest, indent=2).encode() + b"\n"
    files = {"LICENSE": license_file, "eval_report.json": report}
    if notice is not None:
        files["NOTICE"] = notice
    if any(file.stat().st_size > 1_000_000 for file in files.values()):
        raise ValueError("Package metadata exceeds its size limit")
    total = (
        manifest["size_bytes"]
        + len(encoded)
        + sum(file.stat().st_size for file in files.values())
    )
    if total >= LIMIT or total > TARGET:
        raise ValueError("Package exceeds the 900 MB release target")
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise FileExistsError(output)
    with tempfile.TemporaryDirectory(prefix=".tcm-", dir=output.parent) as temporary:
        archive = Path(temporary) / "model.tcm"
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED) as zipped:
            zipped.writestr("manifest.json", encoded)
            zipped.write(gguf, f"model.{quant}.gguf")
            for name, file in files.items():
                zipped.write(file, name)
        if archive.stat().st_size >= LIMIT:
            raise ValueError("Archive reaches the 1 GB hard ceiling")
        output.hardlink_to(archive)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ("gguf", "metadata", "report", "license-file", "output"):
        parser.add_argument(f"--{flag}", type=Path, required=True)
    parser.add_argument("--license-id", required=True)
    parser.add_argument("--notice", type=Path)
    args = parser.parse_args()
    build(
        args.gguf,
        json.loads(args.metadata.read_text()),
        args.report,
        args.license_file,
        args.license_id,
        args.output,
        args.notice,
    )


if __name__ == "__main__":
    main()
