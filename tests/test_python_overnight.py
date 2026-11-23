import unittest
from typing import Any

from package.build_manifest import LIMIT
from train.python_overnight import improves


class PythonOvernightTests(unittest.TestCase):
    def test_promotion_prefers_test_passes_and_enforces_size(self) -> None:
        baseline: dict[str, Any] = {
            "passed": 2,
            "size_bytes": LIMIT - 1,
            "results": [{"seconds": 10}],
        }
        self.assertTrue(improves({**baseline, "passed": 3}, baseline))
        self.assertFalse(
            improves({**baseline, "passed": 3, "size_bytes": LIMIT}, baseline)
        )
        self.assertFalse(improves(baseline, baseline))
        self.assertTrue(improves({**baseline, "results": [{"seconds": 9}]}, baseline))
