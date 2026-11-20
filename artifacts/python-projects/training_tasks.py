"""Original CC0-1.0 prompts and tests for execution-filtered distillation."""
from fixtures import CLI

TASKS = [
    ("rectangle", "Create a terminal game for two players who alternate coloring numbered cells on a 3-by-3 grid. Read cell numbers from stdin. Skip invalid or already used cells without switching players. When every cell is colored print the board as three lines of X and O with no separators, then exit.", CLI + '''
p = run(stdin="1\\n1\\nx\\n2\\n0\\n3\\n4\\n5\\n6\\n7\\n8\\n9\\n")
assert p.returncode == 0 and p.stdout.rstrip().splitlines()[-3:] == ["XOX", "OXO", "XOX"], p
'''),
    ("higher-lower", "Write a number guessing game for the terminal. Take the secret as a positional integer for testing. Read guesses until correct. Print 'higher' when the guess is too low, 'lower' when too high, and 'won in N' with the number of valid guesses. Ignore invalid text.", CLI + '''
p = run("7", stdin="abc\\n2\\n10\\n7\\n")
text = p.stdout.lower()
assert p.returncode == 0 and 0 <= text.find("higher") < text.find("lower") < text.find("won in 3"), p
'''),
    ("grapheme-tally", "Build a Python command line tool that reads lines from stdin, trims leading and trailing spaces, and outputs each nonblank line with its occurrence count in JSON. Preserve the case by default and provide --ignore-case using Unicode casefold.", CLI + '''
p = run("--ignore-case", stdin=" Straße \\nSTRASSE\\n\\n A \\na\\n")
assert p.returncode == 0 and json.loads(p.stdout) == {"strasse": 2, "a": 2}, p
p = run(stdin="A\\na\\nA\\n")
assert p.returncode == 0 and json.loads(p.stdout) == {"A": 2, "a": 1}, p
'''),
    ("duration-list", "Make a CLI that takes durations as args in M:SS format and prints their sum as M:SS. Minutes may exceed 59. Reject negative values, seconds >=60, and missing values.", CLI + '''
p = run("59:45", "1:20", "0:01")
assert p.returncode == 0 and p.stdout.strip() == "61:06", p
for args in [(), ("-1:00",), ("1:61",)]:
    assert run(*args).returncode != 0, args
'''),
    ("calories", "Write a file-based CLI to summarize meal calories. Read a positional JSON file of meals with date and integer calories. Print one YYYY-MM-DD TOTAL line per date, sorted by date. Add --date for an exact date filter.", CLI + '''
meals = Path("meals.json")
meals.write_text('[{"date":"2027-05-04","calories":100},{"date":"2027-05-03","calories":200},{"date":"2027-05-04","calories":48}]')
p = run("meals.json")
assert p.returncode == 0 and p.stdout.splitlines() == ["2027-05-03 200", "2027-05-04 148"], p
assert run("meals.json", "--date", "2027-05-04").stdout.splitlines() == ["2027-05-04 148"]
'''),
    ("shopping", "Implement a CLI shopping list. Commands are add ITEM, checked ITEM, and show. Use --file PATH for the saved JSON. show prints unchecked items in insertion order, one per line. Adding a duplicate must not change the list order.", CLI + '''
base = ("--file", "items.json")
for args in [("add","milk"), ("add","bread"), ("add","milk"), ("add","apple"), ("checked","bread")]:
    assert run(*base, *args).returncode == 0, args
p = run(*base, "show")
assert p.returncode == 0 and p.stdout.splitlines() == ["milk", "apple"], p
'''),
    ("weather-table", "Build a CSV printer CLI. Given a positional file with station and temperature columns, print station names with degrees below freezing. Preserve the order and print only the station name. --threshold overrides 0 degrees.", CLI + '''
Path("temp.csv").write_text("station,temperature\\na,-3\\nb,2\\nc,1.25\\nd,-1\\n")
assert run("temp.csv").stdout.splitlines() == ["a", "d"]
assert run("temp.csv", "--threshold", "2").stdout.splitlines() == ["a", "c", "d"]
'''),
    ("paragraphs", "Create a CLI program that numbers paragraphs read from stdin. A blank or whitespace-only line separates paragraphs. Join trimmed lines of each paragraph with a single space and print 'N. content'. Runs of blank lines are one separator.", CLI + '''
p = run(stdin=" \\none\\n two\\n \\n\\nthree\\n\\t\\nfour\\nfive")
assert p.returncode == 0 and p.stdout.splitlines() == ["1. one two", "2. three", "3. four five"], p
assert run(stdin=" \\n\\n").stdout == ""
'''),
    ("binary-notes", "Build a terminal CLI that converts positional binary text arguments to decimal. Accept leading zeros, and print one number on each line. If any argument is invalid, print an error on stderr, exit nonzero, and leave stdout empty.", CLI + '''
p = run("010", "0", "11111111")
assert p.returncode == 0 and p.stdout.splitlines() == ["2", "0", "255"], p
for text in ("102", "-1", "0b101"):
    p = run("110", text)
    assert p.returncode != 0 and p.stderr and not p.stdout, p
'''),
    ("random-stats", "Write a CLI dice roller. Accept count and sides as two positive integer positional arguments and optional --seed. Print a JSON list containing count independent rolls from 1 through sides. A supplied seed makes results repeatable.", CLI + '''
a = run("10", "6", "--seed", "23")
b = run("10", "6", "--seed", "23")
assert a.returncode == b.returncode == 0 and a.stdout == b.stdout
rolls = json.loads(a.stdout)
assert len(rolls) == 10 and min(rolls) >= 1 and max(rolls) <= 6
assert run("0", "6").returncode != 0
'''),
    ("text-chunks", "Write a CLI that wraps stdin text to a positional integer width. Split on whitespace, fit as many words on each line as possible, and split words longer than the width. Print the wrapped lines. Reject nonpositive widths.", CLI + '''
p = run("5", stdin="x  abc d\\n  e fghijkl   q")
assert p.returncode == 0 and p.stdout.splitlines() == ["x abc", "d e f", "ghijk", "l q"], p
assert run("0", stdin="words").returncode != 0
'''),
    ("arithmetic-repl", "Make a terminal arithmetic program. Read newline-separated requests like add 3 8 or multiply 4 -2 and print the result. Only add, subtract and multiply are available. Print 'error' on invalid input and continue, q exits.", CLI + '''
p = run(stdin="add 3 8\\nsubtract 12 3\\nmultiply 4 -2\\ninvalid!\\nadd a b\\nq\\nadd 1 2\\n")
assert p.returncode == 0 and p.stdout.strip().splitlines() == ["11", "9", "-8", "error", "error"], p
'''),
    ("runner-stats", "Build a Python CLI for running split times. Read CSV from stdin with athlete and seconds columns; report the fastest time per athlete in JSON as numbers. --under accepts a time limit and filters out anything at or above it.", CLI + '''
s = "athlete,seconds\\nBlue,61.4\\nGold,57.3\\nBlue,59.9\\n"
p = run(stdin=s)
assert p.returncode == 0 and json.loads(p.stdout) == {"Blue": 59.9, "Gold": 57.3}, p
p = run("--under", "59.9", stdin=s)
assert p.returncode == 0 and json.loads(p.stdout) == {"Gold": 57.3}, p
'''),
    ("curses-marker", "Make a curses terminal dashboard with a marker. Start a cursor at row 2 column 3, let arrow keys move it inside the screen leaving row 0 for a status line, and draw the position and a marker. Keep controls responsive when idle and exit with q.", None),
    ("curses-metronome", "Write a curses interactive metronome. Display a beats counter, increase it on a timed update, press p to pause and resume, and q to quit. Draw the counter first and isolate setup in main(stdscr).", None),
    ("curses-reaction", "Build a terminal reaction game with curses. Press space to increase hits, and timeouts increase misses. Start at zero, show the two totals, and let r reset both, q exit. Use a timed keypad loop and render before polling.", None),
]

CURSES = '''import curses
from unittest.mock import patch

class Screen:
    def __init__(self, keys):
        self.keys = iter(keys)
        self.text = []
    def __getattr__(self, name):
        return lambda *args: None
    def getmaxyx(self): return 24, 80
    def addch(self, y, x, glyph, *args): self.text.append((y, x, glyph))
    def addstr(self, *args): self.text.extend(x for x in args if isinstance(x, str))
    def addnstr(self, *args): self.addstr(*args)
    def getch(self): return next(self.keys)

def play(keys):
    screen = Screen(keys)
    with patch.object(curses, "wrapper", lambda main: main(screen)), patch.object(curses, "curs_set"):
        exec(compile(CANDIDATE, "game.py", "exec"), {"__name__":"__main__"})
    return screen.text
'''
CHECKS = {
    "curses-marker": '''draws = play([curses.KEY_RIGHT, curses.KEY_DOWN, ord("q")])
assert all(any(isinstance(x, tuple) and x[:2] == point for x in draws) for point in [(2,3), (2,4), (3,4)]), draws
''',
    "curses-metronome": '''frames = play([-1, -1, ord("p"), -1, ord("q")])
assert any("2" in x for x in frames if isinstance(x, str)), frames
assert any("beat" in x.lower() for x in frames if isinstance(x, str)), frames
''',
    "curses-reaction": '''frames = play([ord(" "), -1, ord("r"), ord("q")])
assert any("hit" in x.lower() and "1" in x for x in frames if isinstance(x, str)), frames
assert any("miss" in x.lower() and "1" in x for x in frames if isinstance(x, str)), frames
''',
}
