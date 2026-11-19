"""Build line-aligned FIM examples from explicitly licensed held-out sources."""
import ast
import hashlib
from pathlib import Path
from typing import Any

from data.sources.licensing import licenses


def build(root: Path, license_id: str) -> list[dict[str, Any]]:
    if license_id not in licenses():
        raise ValueError("Held-out repository license is outside the allowlist")
    examples = []
    for path in sorted(root.rglob("*.py")):
        if path.is_symlink() or any(part.startswith(".") for part in path.relative_to(root).parts):
            continue
        source = path.read_text(encoding="utf8")
        try:
            tree = ast.parse(source)
        except SyntaxError:
            continue
        lines = source.splitlines(keepends=True)
        digest = hashlib.sha256(source.encode()).hexdigest()
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) or len(node.body) < 2:
                continue
            middle = node.body[-1]
            first, last = middle.lineno - 1, middle.end_lineno
            if last is None or last - first > 8 or not lines[last:]:
                continue
            examples.append({
                "id": f"{path.relative_to(root).as_posix()}:{middle.lineno}",
                "prompt": "".join(lines[:first]), "suffix": "".join(lines[last:]),
                "expected": "".join(lines[first:last]), "source_sha256": digest,
                "license": license_id,
            })
    return examples
