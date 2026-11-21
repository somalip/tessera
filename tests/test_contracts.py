import json
import unittest
from pathlib import Path

from jsonschema import Draft202012Validator  # type: ignore[import-untyped]

SCHEMAS = Path(__file__).resolve().parents[1] / "schemas"


class ContractTests(unittest.TestCase):
    def test_schemas_are_valid(self) -> None:
        for path in SCHEMAS.glob("*.json"):
            Draft202012Validator.check_schema(json.loads(path.read_text()))

    def test_registry_rejects_unsafe_entries(self) -> None:
        schema = json.loads((SCHEMAS / "registry.json").read_text())
        validator = Draft202012Validator(schema)
        entry = dict(
            id="python-tiny",
            version="0.1.0",
            url="https://example.org/python.tcm",
            sha256="0" * 64,
            size_bytes=100,
            language_ids=["python"],
        )
        self.assertTrue(validator.is_valid(dict(schema_version=1, models=[entry])))
        for field, value in [
            ("id", "../python"),
            ("url", "file:///tmp/model"),
            ("size_bytes", 1_000_000_000),
            ("sha256", "invalid"),
        ]:
            with self.subTest(field=field):
                changed = {**entry, field: value}
                self.assertFalse(
                    validator.is_valid(dict(schema_version=1, models=[changed]))
                )
