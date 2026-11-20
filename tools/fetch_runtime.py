"""Install a checksum-pinned llama.cpp runtime and optional Python starter GGUF."""
import argparse
import hashlib
import json
import platform
import shutil
import tempfile
import urllib.request
from pathlib import Path

ASSETS = Path(__file__).resolve().parents[1] / "runtime-bin" / "assets.json"


def fetch(url: str, destination: Path, expected: str, limit: int) -> None:
    with urllib.request.urlopen(url, timeout=30) as response, destination.open("xb") as output:
        if not response.url.startswith("https://"):
            raise ValueError("Runtime and model downloads require HTTPS")
        checksum = hashlib.sha256()
        length = 0
        while chunk := response.read(1024 * 1024):
            length += len(chunk)
            if length > limit:
                raise ValueError("Download exceeds its expected size")
            checksum.update(chunk)
            output.write(chunk)
        if checksum.hexdigest() != expected:
            raise ValueError("Pinned download checksum mismatch")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("artifacts/local-runtime"))
    parser.add_argument("--starter", action="store_true")
    args = parser.parse_args()
    assets = json.loads(ASSETS.read_text(encoding="utf8"))
    cpu = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x64", "amd64": "x64"}
    system = platform.system().lower()
    target = f"{system}-{cpu.get(platform.machine().lower(), '')}"
    asset = assets["runtime"].get(target)
    if asset is None:
        parser.error(f"No bundled release asset for {target}")
    output = args.output.resolve()
    if output.exists():
        parser.error(f"Output already exists: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".runtime-", dir=output.parent) as temporary:
        staging = Path(temporary)
        archive = staging / asset["name"]
        fetch(f"https://github.com/ggml-org/llama.cpp/releases/download/{assets['build']}/{asset['name']}",
              archive, asset["sha256"], 250_000_000)
        unpacked = staging / "runtime"
        shutil.unpack_archive(archive, unpacked, filter="data" if archive.name.endswith(".tar.gz") else None)
        executable = "llama-server.exe" if system == "windows" else "llama-server"
        matches = list(unpacked.rglob(executable))
        if len(matches) != 1:
            raise ValueError("Pinned release has an unexpected directory layout")
        relative_server = matches[0].relative_to(unpacked)
        if args.starter:
            starter = assets["starter"]
            fetch(starter["url"], unpacked / "python-starter.gguf",
                  starter["sha256"], starter["size_bytes"])
        unpacked.rename(output)
    print(f"tessera.serverPath = {output / relative_server}")
    if args.starter:
        print(f"tessera.pythonModelPath = {output / 'python-starter.gguf'}")


if __name__ == "__main__":
    main()
