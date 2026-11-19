"""Verify model packages and sign a release registry with an Ed25519 key."""
import argparse
import hashlib
import json
import re
import zipfile
from pathlib import Path

from cryptography.hazmat.primitives.serialization import load_pem_private_key
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from jsonschema import Draft202012Validator  # type: ignore[import-untyped]

from eval.report import digest
from package.build_manifest import LIMIT, SCHEMAS


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--key", type=Path, required=True, help="Trusted Ed25519 private PEM")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model", action="append", required=True, metavar="HTTPS_URL=PATH")
    args = parser.parse_args()
    key = load_pem_private_key(args.key.read_bytes(), password=None)
    if not isinstance(key, Ed25519PrivateKey):
        parser.error("Expected an Ed25519 private key")
    models = []
    versions = set()
    for description in args.model:
        url, separator, filename = description.rpartition("=")
        if not separator or not url.startswith("https://"):
            parser.error(f"Invalid model descriptor: {description}")
        path = Path(filename)
        size = path.stat().st_size
        if size >= LIMIT:
            parser.error(f"Package exceeds the hard size ceiling: {path}")
        with zipfile.ZipFile(path) as archive:
            if sum(entry.file_size for entry in archive.infolist()) >= LIMIT:
                parser.error(f"Expanded package exceeds the hard size ceiling: {path}")
            for field in ("manifest.json", "eval_report.json"):
                if archive.getinfo(field).file_size > 1_000_000:
                    parser.error(f"Model metadata exceeds its size limit: {path}")
            manifest = json.loads(archive.read("manifest.json"))
            report = json.loads(archive.read("eval_report.json"))
            Draft202012Validator(json.loads((SCHEMAS / "manifest.json").read_text())).validate(manifest)
            if not re.fullmatch(r"[A-Za-z0-9_-]+", manifest["quant"]):
                parser.error(f"Invalid package quantization: {path}")
            name = f"model.{manifest['quant']}.gguf"
            entries = archive.namelist()
            required = {name, "manifest.json", "eval_report.json", "LICENSE"}
            if (set(entries) not in (required, required | {"NOTICE"}) or
                    len(entries) != len(set(entries)) or
                    archive.getinfo(name).file_size != manifest["size_bytes"]):
                parser.error(f"Invalid package contents: {path}")
            with archive.open(name) as weights:
                checksum = hashlib.sha256()
                for chunk in iter(lambda: weights.read(1024 * 1024), b""):
                    checksum.update(chunk)
                if checksum.hexdigest() != manifest["sha256"]:
                    parser.error(f"Model weights do not match the package manifest: {path}")
        if report.get("smoke") or report.get("gate_passed") is not True:
            parser.error(f"Package has not passed release evaluation: {path}")
        if report.get("model_sha256") != manifest["sha256"]:
            parser.error(f"Package evaluation and model digest differ: {path}")
        version = (manifest["id"], manifest["version"])
        if version in versions:
            parser.error(f"Duplicate registry model version: {version}")
        versions.add(version)
        models.append({
            "id": version[0], "version": version[1], "url": url, "size_bytes": size,
            "language_ids": manifest["language_ids"], "sha256": digest(path),
        })
    index = {"schema_version": 1, "models": models}
    Draft202012Validator(json.loads((SCHEMAS / "registry.json").read_text())).validate(index)
    content = json.dumps(index, indent=2).encode() + b"\n"
    args.output.write_bytes(content)
    args.output.with_name(args.output.name + ".sig").write_bytes(key.sign(content))


if __name__ == "__main__":
    main()
