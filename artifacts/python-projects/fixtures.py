"""Behavior checks for single-file Python programs generated from comments."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent

# Each command runs the proposed file in the same isolated container as the tests.
CLI = '''import json
import subprocess
import sys
from pathlib import Path

app = Path("program.py")
app.write_text(CANDIDATE, encoding="utf-8")

def run(*args, stdin=""):
    return subprocess.run([sys.executable, "-I", str(app), *args], input=stdin,
                          capture_output=True, text=True, timeout=3)
'''

SNAKE = '''import errno
import fcntl
import os
import pty
import re
import select
import struct
import subprocess
import sys
import termios
import time
from pathlib import Path

Path("game.py").write_text(CANDIDATE, encoding="utf-8")

def session(quit_early):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    process = subprocess.Popen([sys.executable, "-I", "game.py"], stdin=slave, stdout=slave,
                               stderr=slave, env={"TERM": "xterm"})
    os.close(slave)
    frames = bytearray()

    def read_for(seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.02)[0]:
                try:
                    frames.extend(os.read(master, 4096))
                except OSError as exc:
                    if exc.errno == errno.EIO:
                        break
                    raise
            if process.poll() is not None:
                break

    try:
        read_for(0.65)
        assert process.poll() is None, bytes(frames)
        assert re.search(rb"score", frames, re.I), bytes(frames)
        if quit_early:
            os.write(master, b"q")
        else:
            # xterm sends application-cursor sequences with keypad mode active.
            os.write(master, b"\\x1bOB")
            read_for(3.5)
            if process.poll() is None:
                os.write(master, b"q")
            assert re.search(rb"game[ -]?over|you (?:lose|lost)|collision", frames, re.I), bytes(frames)
        assert process.wait(timeout=3) == 0, bytes(frames)
        assert b"Traceback" not in frames, bytes(frames)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)

session(True)
session(False)
'''

DIAGNOSTIC = [
    ("snake-vague", "make a snake game", SNAKE),
    ("snake-terminal", "create a tui based snake game", SNAKE),
    ("snake-detailed", "Build a terminal Snake game using curses, with arrow keys, random food, score, growth, wall and body collisions, and q to quit.", SNAKE),
]

HOLDOUT = [
    ("histogram", "Build a stdin histogram CLI. Count whitespace-separated integers and print each value and count separated by one space in numeric order. Add --min to drop values below the supplied integer.", CLI + '''
p = run("--min", "0", stdin="-3 10 2 10\\n0 2 2\\n")
assert p.returncode == 0 and p.stdout.strip().splitlines() == ["0 1", "2 3", "10 2"], p
p = run(stdin="-3 -3 2")
assert p.returncode == 0 and p.stdout.strip().splitlines() == ["-3 2", "2 1"], p
assert run(stdin="oops").returncode != 0
'''),
    ("bookmark-store", "Make a persistent command-line bookmark manager. First arg is the JSON data file, then add NAME URL, list, or remove NAME. list prints name and URL separated by a tab, sorted by name. Removing a missing name exits nonzero.", CLI + '''
assert run("bookmarks.json", "add", "Zulu", "https://example.org/z").returncode == 0
assert run("bookmarks.json", "add", "Alpha", "https://example.org/a").returncode == 0
p = run("bookmarks.json", "list")
assert p.returncode == 0 and p.stdout.splitlines() == ["Alpha\\thttps://example.org/a", "Zulu\\thttps://example.org/z"], p
assert run("bookmarks.json", "remove", "Alpha").returncode == 0
assert run("bookmarks.json", "list").stdout.splitlines() == ["Zulu\\thttps://example.org/z"]
assert run("bookmarks.json", "remove", "Alpha").returncode != 0
'''),
    ("expense-report", "Write a CLI to summarize CSV expenses from stdin with category and amount columns. Use exact decimal money arithmetic and print a JSON object mapping category to 2-decimal strings. --category limits results to that name.", CLI + '''
data = "category,amount\\nFood,0.10\\nFood,0.20\\nRent,123.45\\nFood,-0.05\\n"
p = run(stdin=data)
assert p.returncode == 0 and json.loads(p.stdout) == {"Food": "0.25", "Rent": "123.45"}, p
p = run("--category", "Rent", stdin=data)
assert p.returncode == 0 and json.loads(p.stdout) == {"Rent": "123.45"}, p
assert run(stdin="category,amount\\nRent,broken\\n").returncode != 0
'''),
    ("tic-tac-toe", "Make a two-player terminal tic-tac-toe game. X goes first. Read one square numbered 1 to 9 per line, retry invalid or occupied moves without switching turns, and print 'X wins', 'O wins', or 'Draw' when done.", CLI + '''
for moves, result in [("1 1 4 2 5 3", "X wins"), ("1 4 2 5 9 6", "O wins"),
                      ("1 2 3 5 4 6 8 7 9", "Draw")]:
    p = run(stdin="invalid\\n10\\n" + "\\n".join(moves.split()) + "\\n")
    assert p.returncode == 0 and result.casefold() in p.stdout.casefold(), p
'''),
    ("countdown", "Create a command-line Pomodoro timer. Accept --work and --break durations in seconds and --rounds. Run work followed by break for every round except the last. Print phase names and round numbers. Reject negative durations.", CLI + '''
import re
p = run("--work", "0", "--break", "0", "--rounds", "3")
assert p.returncode == 0, p
assert re.findall(r"\\b(?:work|break)\\b", p.stdout.casefold()) == ["work", "break", "work", "break", "work"], p
assert all(str(n) in p.stdout for n in (1, 2, 3)), p
assert run("--work", "-1", "--break", "0", "--rounds", "1").returncode != 0
'''),
    ("directory-inventory", "Build a directory inventory command. Take a directory and optional --suffix. Recursively print a JSON mapping of relative POSIX file paths to byte sizes. Skip hidden files, hidden directories, and symlinks.", CLI + '''
root = Path("project")
(root / "nested").mkdir(parents=True)
(root / ".hidden").mkdir()
for name, data in [("top.txt", b"abc"), ("nested/child.txt", b""), ("a.json", b"{}"),
                   (".hidden/x.txt", b"y"), (".dot", b"zz")]:
    (root / name).write_bytes(data)
(root / "nested/link.txt").symlink_to("../top.txt")
p = run(str(root))
assert p.returncode == 0 and json.loads(p.stdout) == {"top.txt": 3, "nested/child.txt": 0, "a.json": 2}, p
p = run(str(root), "--suffix", ".txt")
assert p.returncode == 0 and json.loads(p.stdout) == {"top.txt": 3, "nested/child.txt": 0}, p
'''),
    ("checkbook", "Create a CLI to validate transactions in a JSONL file given as its positional argument. Each row needs a nonempty string id and integer cents, with unique ids. Ignore blank lines. Print the total cents as an integer, or exit nonzero and report the original line number to stderr.", CLI + '''
ledger = Path("ledger.jsonl")
ledger.write_text('{"id":"x","cents":120}\\n\\n{"id":"y","cents":-9}\\n')
p = run(str(ledger))
assert p.returncode == 0 and p.stdout.strip() == "111", p
for invalid in ['{"id":"x","cents":1}', '{"id":"z","cents":true}', '{"id":"","cents":0}', 'oops']:
    with ledger.open("a") as f:
        f.write(invalid + "\\n")
    p = run(str(ledger))
    assert p.returncode != 0 and "4" in p.stderr, p
    ledger.write_text('{"id":"x","cents":120}\\n\\n{"id":"y","cents":-9}\\n')
'''),
    ("quiz", "Build a terminal quiz from a positional JSON file containing a list of objects with question and answer fields. Print each question, read one answer per line, compare case-insensitively after trimming, and show the score as correct/total at the end.", CLI + '''
questions = Path("quiz.json")
questions.write_text(json.dumps([{"question": "Capital of Italy?", "answer": "Rome"},
                                 {"question": "5+7?", "answer": "12"},
                                 {"question": "Color of snow?", "answer": "white"}]))
p = run(str(questions), stdin=" ROME \\n13\\nwhite\\n")
assert p.returncode == 0 and "2/3" in p.stdout.replace(" ", ""), p
assert all(q in p.stdout for q in ("Capital of Italy?", "5+7?", "Color of snow?")), p
'''),
]


def snapshot(name, rows):
    path = ROOT / f"{name}.jsonl"
    path.write_text("".join(json.dumps({"id": id_, "prompt": request, "tests": tests,
                                        "license": "CC0-1.0"}) + "\n"
                            for id_, request, tests in rows), encoding="utf-8")


if __name__ == "__main__":
    snapshot("diagnostic", DIAGNOSTIC)
    snapshot("holdout", HOLDOUT)
