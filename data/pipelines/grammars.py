"""Select pinned local tree-sitter grammars per source language."""
import importlib

from tree_sitter import Language, Parser

GRAMMARS = {
    "python": ("python", "language"),
    "typescript": ("typescript", "language_typescript"),
    "tsx": ("typescript", "language_tsx"),
    "rust": ("rust", "language"),
    "go": ("go", "language"),
    "java": ("java", "language"),
    "c": ("c", "language"),
    "cpp": ("cpp", "language"),
}


def parser_for(language: str) -> Parser:
    module, factory = GRAMMARS[language]
    grammar = importlib.import_module(f"tree_sitter_{module}")
    return Parser(Language(getattr(grammar, factory)()))
