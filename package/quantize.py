"""Post-training GGUF quantization using llama.cpp."""

import subprocess
from pathlib import Path


def quantize(
    source: Path,
    destination: Path,
    quant: str,
    executable: str,
    importance_matrix: Path | None = None,
) -> None:
    calibration = ["--imatrix", str(importance_matrix)] if importance_matrix else []
    subprocess.run(
        [executable, *calibration, str(source), str(destination), quant], check=True
    )
