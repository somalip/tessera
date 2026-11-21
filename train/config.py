"""Load explicitly inherited training settings."""

from pathlib import Path
from typing import Any

import yaml


def load(path: Path, visited: frozenset[Path] = frozenset()) -> dict[str, Any]:
    resolved = path.resolve()
    if resolved in visited:
        raise ValueError("Training configuration contains an inheritance cycle")
    values = yaml.safe_load(resolved.read_text(encoding="utf8"))
    if not isinstance(values, dict):
        raise ValueError(f"Training settings must be a mapping: {path}")
    parent = values.pop("extends", None)
    inherited = load(resolved.parent / parent, visited | {resolved}) if parent else {}
    return {**inherited, **values}
