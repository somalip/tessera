"""CC0 training targets for tasks the teacher failed in isolated execution."""

REFERENCES = {
    "rectangle": '''import sys


def main():
    board = ["-"] * 9
    player = "X"
    for line in sys.stdin:
        try:
            square = int(line) - 1
        except ValueError:
            continue
        if not 0 <= square < len(board) or board[square] != "-":
            continue
        board[square] = player
        player = "O" if player == "X" else "X"
        if "-" not in board:
            for offset in range(0, len(board), 3):
                print("".join(board[offset:offset + 3]))
            return


if __name__ == "__main__":
    main()
''',
    "higher-lower": '''import argparse
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("secret", type=int)
    secret = parser.parse_args().secret
    guesses = 0
    for line in sys.stdin:
        try:
            guess = int(line)
        except ValueError:
            continue
        guesses += 1
        if guess == secret:
            print(f"won in {guesses}")
            return
        print("higher" if guess < secret else "lower")


if __name__ == "__main__":
    main()
''',
    "duration-list": '''import argparse
import re


def parse_duration(value):
    if not re.fullmatch(r"[0-9]+:[0-5][0-9]", value):
        raise argparse.ArgumentTypeError("expected a nonnegative duration in M:SS format")
    minutes, seconds = map(int, value.split(":"))
    return minutes * 60 + seconds


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("durations", type=parse_duration, nargs="+")
    minutes, seconds = divmod(sum(parser.parse_args().durations), 60)
    print(f"{minutes}:{seconds:02d}")


if __name__ == "__main__":
    main()
''',
    "calories": '''import argparse
from collections import Counter
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("file", type=Path)
    parser.add_argument("--date")
    args = parser.parse_args()
    totals = Counter()
    for meal in json.loads(args.file.read_text(encoding="utf-8")):
        day = meal["date"]
        if args.date is None or day == args.date:
            totals[day] += meal["calories"]
    for day in sorted(totals):
        print(day, totals[day])


if __name__ == "__main__":
    main()
''',
    "shopping": '''import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", required=True, type=Path)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("add").add_argument("item")
    commands.add_parser("checked").add_argument("item")
    commands.add_parser("show")
    args = parser.parse_args()
    try:
        items = json.loads(args.file.read_text(encoding="utf-8"))
    except FileNotFoundError:
        items = {}
    if args.command == "show":
        for name, checked in items.items():
            if not checked:
                print(name)
        return
    if args.command == "add":
        items.setdefault(args.item, False)
    elif args.item in items:
        items[args.item] = True
    else:
        parser.error("item does not exist")
    args.file.write_text(json.dumps(items), encoding="utf-8")


if __name__ == "__main__":
    main()
''',
    "binary-notes": '''import argparse
import re


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("values", nargs="+")
    values = parser.parse_args().values
    for value in values:
        if not re.fullmatch(r"[01]+", value):
            parser.error(f"invalid binary integer {value!r}")
    for value in values:
        print(int(value, 2))


if __name__ == "__main__":
    main()
''',
    "random-stats": '''import argparse
import json
from random import Random


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("count", type=int)
    parser.add_argument("sides", type=int)
    parser.add_argument("--seed", type=int)
    args = parser.parse_args()
    if args.count <= 0 or args.sides <= 0:
        parser.error("count and sides must be positive")
    rng = Random(args.seed)
    print(json.dumps([rng.randint(1, args.sides) for _ in range(args.count)]))


if __name__ == "__main__":
    main()
''',
    "text-chunks": '''import argparse
import sys
import textwrap


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("width", type=int)
    args = parser.parse_args()
    if args.width < 1:
        parser.error("width must be positive")
    text = " ".join(sys.stdin.read().split())
    for line in textwrap.wrap(text, args.width, break_on_hyphens=False):
        print(line)


if __name__ == "__main__":
    main()
''',
    "arithmetic-repl": '''import operator
import sys


def main():
    operations = {"add": operator.add, "subtract": operator.sub, "multiply": operator.mul}
    for line in sys.stdin:
        if line.strip() == "q":
            break
        try:
            operation, left, right = line.split()
            print(operations[operation](int(left), int(right)))
        except (KeyError, ValueError):
            print("error")


if __name__ == "__main__":
    main()
''',
    "curses-marker": '''import curses


MOVES = {curses.KEY_UP: (-1, 0), curses.KEY_DOWN: (1, 0),
         curses.KEY_LEFT: (0, -1), curses.KEY_RIGHT: (0, 1)}


def main(screen):
    screen.keypad(True)
    screen.timeout(100)
    row, col = 2, 3
    while True:
        height, width = screen.getmaxyx()
        screen.erase()
        if height > 1 and width > 1:
            row = max(1, min(row, height - 1))
            col = max(0, min(col, width - 2))
            screen.addnstr(0, 0, f"Position: {row}, {col}", width - 1)
            screen.addch(row, col, "@")
        screen.refresh()
        key = screen.getch()
        if key == ord("q"):
            return
        dr, dc = MOVES.get(key, (0, 0))
        row, col = row + dr, col + dc


if __name__ == "__main__":
    curses.wrapper(main)
''',
    "curses-reaction": '''import curses


def main(screen):
    screen.timeout(550)
    screen.keypad(True)
    hits, misses = 0, 0
    while True:
        _, width = screen.getmaxyx()
        screen.erase()
        screen.addnstr(0, 0, f"Hits: {hits}  Misses: {misses}", width - 1)
        screen.refresh()
        key = screen.getch()
        if key == ord("q"):
            return
        if key == ord(" "):
            hits += 1
        elif key == -1:
            misses += 1
        elif key == ord("r"):
            hits, misses = 0, 0


if __name__ == "__main__":
    curses.wrapper(main)
''',
}
