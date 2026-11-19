"""Run one CI training, evaluation, and release-package matrix job."""
import shutil
import sys
from pathlib import Path

from package.build_manifest import LIMIT
from train.config import load
from train.run import run


def main() -> None:
    path, language = sys.argv[1:]
    config = load(Path(path))
    if config["language"] != language or config["smoke"] or not config.get("eval_args"):
        raise ValueError("CI needs a matching full training config with all evaluation inputs")
    package = run(config)
    if package.suffix != ".tcm" or package.stat().st_size >= LIMIT:
        raise ValueError("CI requires a release-gated package smaller than one decimal GB")
    target = Path("artifacts/candidate")
    target.mkdir(parents=True, exist_ok=True)
    shutil.copy2(package, target / package.name)


if __name__ == "__main__":
    main()
