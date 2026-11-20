"""Original CC0 Python programs and executable checks for brief-to-code SFT."""

PROGRAMS = [
    (
        "curses-cursor",
        "TUI coordinate viewer. Arrow keys move a marker within the current terminal; show row/col on top; q exits.",
        r'''import curses

def main(stdscr):
    stdscr.keypad(True)
    row, col = 1, 0
    moves = {curses.KEY_UP: (-1, 0), curses.KEY_DOWN: (1, 0),
             curses.KEY_LEFT: (0, -1), curses.KEY_RIGHT: (0, 1)}
    while True:
        height, width = stdscr.getmaxyx()
        row = max(1, min(row, height - 2))
        col = max(0, min(col, width - 2))
        stdscr.erase()
        if height > 2 and width > 1:
            stdscr.addnstr(0, 0, f"row={row} col={col} (q quits)", width - 1)
            stdscr.addch(row, col, "+")
        stdscr.refresh()
        key = stdscr.getch()
        if key == ord("q"):
            return
        dy, dx = moves.get(key, (0, 0))
        row += dy
        col += dx

if __name__ == "__main__":
    curses.wrapper(main)
''',
        r'''class Screen:
    def __init__(self):
        self.keys = iter([curses.KEY_RIGHT, curses.KEY_DOWN, ord("q")])
        self.points = []
    def keypad(self, enabled): assert enabled
    def getmaxyx(self): return 10, 20
    def erase(self): pass
    def addnstr(self, *args): pass
    def addch(self, y, x, glyph): self.points.append((y,x,glyph))
    def refresh(self): pass
    def getch(self): return next(self.keys)

screen = Screen()
main(screen)
assert screen.points == [(1,0,"+"), (1,1,"+"), (2,1,"+")]
''',
    ),
    (
        "curses-clicker",
        "TUI reaction practice: display hit and miss totals, increment on space, count 1s timeouts as misses, r resets, q exits.",
        r'''import curses

def main(stdscr):
    stdscr.timeout(1000)
    hits = misses = 0
    while True:
        _, width = stdscr.getmaxyx()
        stdscr.erase()
        stdscr.addnstr(0, 0, f"Hits {hits} | Misses {misses}", max(0, width - 1))
        stdscr.refresh()
        key = stdscr.getch()
        if key == ord("q"):
            break
        if key == ord(" "):
            hits += 1
        elif key == -1:
            misses += 1
        elif key == ord("r"):
            hits = misses = 0

if __name__ == "__main__":
    curses.wrapper(main)
''',
        r'''class Display:
    def __init__(self):
        self.keys = iter([ord(" "), -1, ord("r"), ord("q")])
        self.frames = []
    def timeout(self, ms): assert ms == 1000
    def getmaxyx(self): return 5, 50
    def erase(self): pass
    def addnstr(self, y, x, text, limit): self.frames.append(text)
    def refresh(self): pass
    def getch(self): return next(self.keys)

display = Display()
main(display)
assert display.frames == ["Hits 0 | Misses 0", "Hits 1 | Misses 0", "Hits 1 | Misses 1", "Hits 0 | Misses 0"]
''',
    ),
    (
        "cli-column",
        "CLI: read CSV stdin; print named column values in order. Positional column arg; --unique keeps first occurrences; unknown column exits with error.",
        r'''import argparse
import csv
import sys

def main(argv=None, source=None, output=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("column")
    parser.add_argument("--unique", action="store_true")
    args = parser.parse_args(argv)
    reader = csv.DictReader(sys.stdin if source is None else source)
    if args.column not in (reader.fieldnames or ()):
        parser.error(f"unknown column {args.column!r}")
    seen = set()
    for row in reader:
        value = row[args.column]
        if not args.unique or value not in seen:
            print(value, file=sys.stdout if output is None else output)
            if args.unique:
                seen.add(value)

if __name__ == "__main__":
    main()
''',
        r'''from io import StringIO
for flags, expected in [([], "b\na\nb\n"), (["--unique"], "b\na\n")]:
    out = StringIO()
    main(["name", *flags], StringIO("name,n\nb,1\na,2\nb,3\n"), out)
    assert out.getvalue() == expected
try:
    main(["missing"], StringIO("name\nx\n"), StringIO())
except SystemExit as exc:
    assert exc.code != 0
else:
    raise AssertionError("Unknown column should fail")
''',
    ),
    (
        "cli-json-count",
        "CLI: tally nonempty top-level key names from JSON objects in a JSONL file. Print JSON mapping sorted by key. Skip blank lines. --min-count filters counts.",
        r'''import argparse
import json
from collections import Counter
from pathlib import Path

def count_keys(lines):
    counts = Counter()
    for line in lines:
        if not line.strip():
            continue
        record = json.loads(line)
        if not isinstance(record, dict):
            raise ValueError("expected a JSON object")
        counts.update(key for key in record if key)
    return counts

def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("file", type=Path)
    parser.add_argument("--min-count", type=int, default=1)
    args = parser.parse_args(argv)
    with args.file.open(encoding="utf-8") as stream:
        counts = count_keys(stream)
    print(json.dumps({key: n for key, n in counts.items() if n >= args.min_count}, sort_keys=True))

if __name__ == "__main__":
    main()
''',
        r'''import contextlib
import io
import tempfile

assert count_keys(iter(['{"a":1,"":0}', '\n', '{"a":0,"z":1}'])) == {"a": 2, "z": 1}
with tempfile.TemporaryDirectory() as folder:
    file = Path(folder) / "input"
    file.write_text('{"b":1,"a":2}\n{"b":3,"z":4}\n', encoding="utf-8")
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        main([str(file), "--min-count", "2"])
    assert json.loads(out.getvalue()) == {"b": 2}
''',
    ),
    (
        "cli-countdown",
        "CLI countdown. Positional nonnegative seconds; print remaining seconds through zero with one-second waits. Invalid duration exits 2; Ctrl-C exits 130.",
        r'''import argparse
import time

def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("seconds", type=int)
    args = parser.parse_args(argv)
    if args.seconds < 0:
        parser.error("seconds must be nonnegative")
    try:
        for remaining in range(args.seconds, -1, -1):
            print(remaining, flush=True)
            if remaining:
                time.sleep(1)
    except KeyboardInterrupt:
        return 130
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
''',
        r'''from contextlib import redirect_stdout
from io import StringIO
from unittest.mock import patch, call
output = StringIO()
with redirect_stdout(output), patch.object(time, "sleep") as sleep:
    assert main(["2"]) == 0
    assert sleep.call_args_list == [call(1), call(1)]
assert output.getvalue() == "2\n1\n0\n"
with patch.object(time, "sleep", side_effect=KeyboardInterrupt):
    assert main(["2"]) == 130
''',
    ),
    (
        "cli-vocabulary",
        "CLI: print count and word for each whitespace token from stdin, highest count first and alphabetical ties. --limit defaults to 10; --fold casefolds.",
        r'''import argparse
import sys
from collections import Counter

def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--fold", action="store_true")
    options = parser.parse_args(argv)
    counts = Counter()
    for line in sys.stdin:
        counts.update((line.casefold() if options.fold else line).split())
    for word, count in sorted(counts.items(), key=lambda pair: (-pair[1], pair[0]))[:max(0, options.limit)]:
        print(f"{count}\t{word}")

if __name__ == "__main__":
    main()
''',
        r'''from contextlib import redirect_stdout
from io import StringIO
from unittest.mock import patch

out = StringIO()
with patch.object(sys, "stdin", StringIO("z A a\nb b\n")), redirect_stdout(out):
    main(["--fold", "--limit", "2"])
assert out.getvalue() == "2\ta\n2\tb\n"
''',
    ),
    (
        "rename-preview",
        "Implement plan_renames(root, old, new). Return ordered pairs of Path objects for direct regular files with a case-sensitive suffix. Reject multiple files mapping to the same destination or an occupied target. No writes.",
        r'''from pathlib import Path

def plan_renames(root, old, new):
    pending = []
    reserved = set()
    for source in sorted(Path(root).iterdir()):
        if not source.is_file() or source.suffix != old:
            continue
        destination = source.with_suffix(new)
        if destination == source:
            continue
        if destination.exists() or destination.is_symlink() or destination in reserved:
            raise FileExistsError(destination)
        pending.append((source, destination))
        reserved.add(destination)
    return pending
''',
        r'''from tempfile import TemporaryDirectory

with TemporaryDirectory() as base:
    root = Path(base)
    (root / "z.txt").touch()
    (root / "a.txt").touch()
    (root / "other.TXT").touch()
    assert plan_renames(root, ".txt", ".md") == [(root/"a.txt", root/"a.md"), (root/"z.txt", root/"z.md")]
    assert not (root / "a.md").exists()
    (root / "z.md").touch()
    try:
        plan_renames(root, ".txt", ".md")
    except FileExistsError:
        pass
    else:
        raise AssertionError("Must reject target collisions")
''',
    ),
]
