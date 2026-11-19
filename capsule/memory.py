"""Content-addressed workspace memory. File observations include tombstones."""
import hashlib
import json
import os
import sqlite3
from collections import deque
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from tree_sitter import Node

from data.pipelines.grammars import parser_for

EXTENSIONS = dict(zip(
    (".py", ".ts", ".tsx", ".rs", ".go", ".java", ".c", ".cpp"),
    ("python", "typescript", "tsx", "rust", "go", "java", "c", "cpp"), strict=True,
))
DECLARATIONS = {
    "function_definition", "class_definition", "function_declaration", "class_declaration",
    "method_declaration", "method_definition", "function_item", "struct_item",
    "interface_declaration", "type_alias_declaration",
}
SKIP = {"node_modules", "dist", "build", "vendor", "target", "__pycache__", "venv"}


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@dataclass(frozen=True)
class Symbol:
    name: str
    signature: str
    body_hash: str
    deps: tuple[str, ...]
    path: str


def nodes(node: Node) -> list[Node]:
    pending = [node]
    result = []
    while pending:
        current = pending.pop()
        result.append(current)
        pending.extend(reversed(current.named_children))
    return result


def extract(path: str, source: bytes, language: str) -> list[Symbol]:
    def read(node: Node) -> str:
        return source[node.start_byte:node.end_byte].decode("utf8", errors="replace")

    result = []
    for declaration in nodes(parser_for(language).parse(source).root_node):
        if declaration.type not in DECLARATIONS:
            continue
        name = declaration.child_by_field_name("name")
        declarator = declaration.child_by_field_name("declarator")
        while name is None and declarator is not None:
            if declarator.type in {"identifier", "field_identifier", "qualified_identifier"}:
                name = declarator
            declarator = declarator.child_by_field_name("declarator")
        body = declaration.child_by_field_name("body")
        if name is None or declaration.has_error:
            continue
        end = body.start_byte if body else declaration.end_byte
        signature = source[declaration.start_byte:end].decode("utf8", errors="replace").strip()
        refs = {read(node) for node in nodes(declaration)
                if node.type in {"identifier", "type_identifier", "field_identifier", "property_identifier"}}
        result.append(Symbol(read(name), signature, digest(source[end:declaration.end_byte]),
                             tuple(sorted(refs - {read(name)})), path))
    return result


class Memory:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, timeout=30)
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS files (path TEXT, version TEXT);
            CREATE INDEX IF NOT EXISTS file_history ON files(path);
            CREATE TABLE IF NOT EXISTS symbols (
                hash TEXT PRIMARY KEY, name TEXT, signature TEXT, body_hash TEXT, deps TEXT, path TEXT
            );
            CREATE TABLE IF NOT EXISTS file_symbols (
                path TEXT, version TEXT, symbol TEXT, PRIMARY KEY(path, version, symbol)
            );
            CREATE TABLE IF NOT EXISTS decisions (hash TEXT PRIMARY KEY, payload TEXT);
            CREATE TABLE IF NOT EXISTS capsule_recipes (hash TEXT PRIMARY KEY, task_type TEXT, payload TEXT);
        """)

    def index(self, root: Path) -> None:
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            current = dict(self.db.execute("""
                SELECT path, version FROM files WHERE rowid IN (SELECT MAX(rowid) FROM files GROUP BY path)
            """))
            seen = set()
            for directory, dirs, filenames in os.walk(root):
                dirs[:] = sorted(d for d in dirs if d not in SKIP and not d.startswith("."))
                for filename in sorted(filenames):
                    path = Path(directory, filename)
                    language = EXTENSIONS.get(path.suffix)
                    if (not language or filename.startswith(".") or path.is_symlink()
                            or not path.is_file() or path.stat().st_size > 512_000):
                        continue
                    relative = path.relative_to(root).as_posix()
                    seen.add(relative)
                    source = path.read_bytes()
                    version = digest(source)
                    if current.get(relative) == version:
                        continue
                    if not self.db.execute("SELECT 1 FROM files WHERE path=? AND version=?",
                                           (relative, version)).fetchone():
                        for symbol in extract(relative, source, language):
                            key = digest(canonical(asdict(symbol)).encode())
                            self.db.execute("INSERT OR IGNORE INTO symbols VALUES (?,?,?,?,?,?)", (
                                key, symbol.name, symbol.signature, symbol.body_hash, canonical(symbol.deps), relative,
                            ))
                            self.db.execute("INSERT OR IGNORE INTO file_symbols VALUES (?,?,?)",
                                            (relative, version, key))
                    self.db.execute("INSERT INTO files VALUES (?,?)", (relative, version))
            self.db.executemany("INSERT INTO files VALUES (?,NULL)",
                                ((p,) for p in current.keys() - seen if current[p] is not None))

    def signatures(self, names: tuple[str, ...]) -> list[Symbol]:
        pending = deque(names)
        visited = set()
        result = []
        with self.db:
            self.db.execute("BEGIN")
            while pending:
                name = pending.popleft()
                if name in visited:
                    continue
                visited.add(name)
                rows = self.db.execute("""
                    SELECT s.name, s.signature, s.body_hash, s.deps, s.path
                    FROM symbols s JOIN file_symbols fs ON fs.symbol=s.hash
                    JOIN files f ON f.path=fs.path AND f.version=fs.version
                    WHERE s.name=? AND f.rowid=(SELECT MAX(rowid) FROM files WHERE path=f.path)
                    ORDER BY s.path, s.signature, s.hash
                """, (name,))
                for name, signature, body_hash, deps, path in rows:
                    symbol = Symbol(name, signature, body_hash, tuple(json.loads(deps)), path)
                    result.append(symbol)
                    pending.extend(symbol.deps)
        return result

    def decision(self, payload: object) -> None:
        encoded = canonical(payload)
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO decisions VALUES (?,?)", (digest(encoded.encode()), encoded))

    def recipe(self, task_type: str) -> list[int] | None:
        row = self.db.execute("SELECT payload FROM capsule_recipes WHERE task_type=? ORDER BY rowid DESC LIMIT 1",
                              (task_type,)).fetchone()
        return list(json.loads(row[0])) if row else None

    def remember(self, task_type: str, indexes: list[int]) -> None:
        payload = canonical(indexes)
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO capsule_recipes VALUES (?,?,?)",
                            (digest(canonical([task_type, indexes]).encode()), task_type, payload))
