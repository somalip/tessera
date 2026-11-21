"""Verify the assets for the TinyCoders experimental prerelease."""

import argparse
import hashlib
import json
from pathlib import Path
from zipfile import ZipFile

from jsonschema import Draft202012Validator  # type: ignore[import-untyped]

from eval.report import digest
from package.build_manifest import LIMIT, SCHEMAS

SPECIALTIES = ("documentation", "english", "diagrams", "summaries")


def verify_model(gguf: Path, tcm: Path, license_file: Path, model_id: str) -> None:
    size = gguf.stat().st_size
    if not 0 < size < LIMIT or not 0 < tcm.stat().st_size < LIMIT:
        raise ValueError(f"{model_id} exceeds the model size ceiling or is empty")
    with gguf.open("rb") as stream:
        if stream.read(4) != b"GGUF":
            raise ValueError(f"{gguf} has an invalid header")
    with ZipFile(tcm) as archive:
        if sum(entry.file_size for entry in archive.infolist()) >= LIMIT:
            raise ValueError(f"{tcm} exceeds the unpacked model size ceiling")
        expected = {"manifest.json", "eval_report.json", "LICENSE", "model.Q8_0.gguf"}
        if set(archive.namelist()) != expected or len(archive.infolist()) != len(
            expected
        ):
            raise ValueError(f"{tcm} has unexpected archive contents")
        manifest = json.loads(archive.read("manifest.json"))
        Draft202012Validator(
            json.loads((SCHEMAS / "manifest.json").read_text())
        ).validate(manifest)
        report = json.loads(archive.read("eval_report.json"))
        model_hash = digest(gguf)
        packaged_hash = hashlib.sha256()
        with archive.open("model.Q8_0.gguf") as weights:
            for chunk in iter(lambda: weights.read(1024 * 1024), b""):
                packaged_hash.update(chunk)
        if (
            manifest["id"] != model_id
            or manifest["size_bytes"] != size
            or manifest["sha256"] != model_hash
            or packaged_hash.hexdigest() != model_hash
            or report.get("model_sha256") != model_hash
            or report.get("language") != model_id.removesuffix("-tiny")
            or report.get("smoke") is not True
            or report.get("training_examples") != 0
            or archive.read("LICENSE") != license_file.read_bytes()
        ):
            raise ValueError(
                f"{tcm} does not match the weights, license, or experimental report"
            )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", type=Path, default=Path("artifacts"))
    args = parser.parse_args()
    models = args.artifacts / "general-models"
    license_file = Path("docs/research/general-models/LICENSE")
    vsix = args.artifacts / "tessera.vsix"
    source = json.loads(Path("vscode-extension/package.json").read_text())
    with ZipFile(vsix) as archive:
        extension = json.loads(archive.read("extension/package.json"))
        if (
            archive.testzip() is not None
            or extension["name"] != source["name"]
            or extension["version"] != source["version"]
        ):
            raise ValueError(f"{vsix} does not match the current extension package")

    assets = [vsix, license_file]
    for specialty in SPECIALTIES:
        model_id = f"{specialty}-tiny"
        gguf = models / specialty / f"{model_id}.Q8_0.gguf"
        tcm = models / specialty / f"{model_id}.tcm"
        verify_model(gguf, tcm, license_file, model_id)
        assets.extend((gguf, tcm))

    checksums = args.artifacts / "SHA256SUMS.txt"
    checksums.write_text(
        "".join(f"{digest(asset)}  {asset.name}\n" for asset in assets)
    )
    for asset in [*assets, checksums]:
        print(asset)


if __name__ == "__main__":
    main()
