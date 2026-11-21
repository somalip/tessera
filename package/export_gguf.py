"""Export a local Transformers checkpoint with the pinned llama.cpp converter."""

import subprocess
import sys
from pathlib import Path


def export(checkpoint: Path, converter: Path, output: Path) -> None:
    subprocess.run(
        [
            sys.executable,
            str(converter),
            str(checkpoint),
            "--outfile",
            str(output),
            "--outtype",
            "f16",
        ],
        check=True,
    )
