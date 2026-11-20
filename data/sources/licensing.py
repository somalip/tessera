"""Shared conservative SPDX allowlist for training and evaluation inputs."""
from pathlib import Path

import yaml

ALLOWLIST = Path(__file__).with_name("license_allowlist.yaml")


def licenses() -> frozenset[str]:
    return frozenset(yaml.safe_load(ALLOWLIST.read_text(encoding="utf8"))["licenses"])
