"""Exercise growth and steering in the existing isolated Python verifier."""
import argparse
from dataclasses import asdict
import json
from pathlib import Path

from eval.report import digest
from verifiers.python.runner import verify

# The prompts request a curses game. Drive the program through a fake screen,
# and discover the starting chain and food from its Python state at input time.
# The PTY smoke separately covers actual terminal setup and clean exit.
CHECK = '''import curses
import random
from collections import deque
from types import SimpleNamespace
from unittest.mock import patch
import sys

HEIGHT, WIDTH = 24, 42
DIRECTIONS = {(0, 1): curses.KEY_RIGHT, (0, -1): curses.KEY_LEFT,
              (1, 0): curses.KEY_DOWN, (-1, 0): curses.KEY_UP}


def point(value):
    return isinstance(value, (tuple, list)) and len(value) == 2 and all(type(v) is int for v in value)


def chain(value):
    return isinstance(value, (list, tuple, deque)) and 2 <= len(value) < 20 and all(map(point, value)) and all(
        abs(a - c) + abs(b - d) == 1 for (a, b), (c, d) in zip(value, list(value)[1:]))


def cells(scope):
    chains = [tuple(map(tuple, v)) for v in scope.values() if chain(v)]
    assert chains, "No chain of consecutive body segments"
    body = max(chains, key=len)
    food = next((tuple(v) for k, v in scope.items() if 'food' in k.lower() and point(v) and tuple(v) not in body), None)
    return body, food


class Screen:
    def __init__(self, collide=False):
        self.frames = []
        self.scores = []
        self.drawn = set()
        self.score = None
        self.direction = None
        self.collide = collide
        self.game_over = False
        self.turns = iter([curses.KEY_DOWN, curses.KEY_LEFT, curses.KEY_UP])

    def getmaxyx(self): return HEIGHT, WIDTH
    def keypad(self, *args): pass
    def timeout(self, *args): pass
    def nodelay(self, *args): pass
    def leaveok(self, *args): pass
    def border(self, *args): pass
    def box(self, *args): pass
    def refresh(self): pass
    def erase(self): self.drawn.clear()
    clear = erase

    def addch(self, y, x, ch, *args):
        assert 0 <= y < HEIGHT and 0 <= x < WIDTH, (y, x)
        if ch != ' ':
            self.drawn.add((y, x))

    def addstr(self, y, x, content, *args):
        import re
        if re.search(r'game[ -]?over|you (?:lose|lost)|collision', str(content), re.I):
            self.game_over = True
        match = re.search(r'score\\W*(\\d+)', str(content), re.I)
        if match:
            self.score = int(match[1])
        if len(content) == 1:
            self.addch(y, x, content)

    addnstr = addstr

    def getch(self):
        if self.game_over:
            return ord('q')
        frame = sys._getframe(1)
        scope = {**frame.f_globals, **frame.f_locals}
        body, food = cells(scope)
        assert food is not None, "Missing drawable food outside the snake"
        self.frames.append((body, food, set(self.drawn)))
        self.scores.append(self.score)
        assert len(self.frames) < 20, "Timed loop ignored q"
        growth = len(body) - len(self.frames[0][0])
        if self.collide and growth >= 2:
            return next(self.turns)
        if not self.collide and growth >= 1:
            return ord('q')
        # Start by steering along the first segment. This also works for a
        # chain displayed tail-first when the seeded target is off that end.
        if self.direction is None:
            head, neck = body[:2]
            candidate = head[0] - neck[0], head[1] - neck[1]
            dr, dc = candidate
            if (food[0] - head[0]) * dr + (food[1] - head[1]) * dc < 0:
                head, neck = body[-1], body[-2]
                candidate = head[0] - neck[0], head[1] - neck[1]
            self.direction = candidate
            return DIRECTIONS[candidate]
        return -1 if len(self.frames) < 8 else ord('q')


def play(screen):
    food_offsets = iter((2, 3 if screen.collide else 5, 5))
    random_calls = 0

    def choose(options):
        assert options, "Food selection has no vacant cell"
        target = (HEIGHT // 2, WIDTH // 2 + next(food_offsets, 5))
        if point(options[0]):
            return min(options, key=lambda p: (abs(p[0] - target[0]) + abs(p[1] - target[1]), p))
        return options[0]

    def randint(a, b):
        nonlocal random_calls
        random_calls += 1
        center = (a + b + 1) // 2
        return min(b, center + (next(food_offsets, 5) if random_calls % 2 == 0 else 0))

    with (patch.object(curses, 'wrapper', lambda entry: entry(screen)), patch.object(curses, 'curs_set'),
          patch.object(random, 'choice', choose), patch.object(random, 'randint', randint)):
        exec(compile(CANDIDATE, 'snake.py', 'exec'), {'__name__': '__main__'})


screen = Screen()
play(screen)
start_body, first_food, first_drawn = screen.frames[0]
end_body, last_food, last_drawn = screen.frames[-1]
assert len(end_body) == len(start_body) + 1, 'Eating food must keep one additional body segment'
assert last_food != first_food, 'Food must respawn after being eaten'
assert set(start_body) | {first_food} <= first_drawn and set(end_body) | {last_food} <= last_drawn, 'Draw all body cells and food'
assert screen.scores[0] == 0 and screen.scores[-1] == 1, screen.scores

collision = Screen(collide=True)
play(collision)
assert collision.scores[-1] == 2 and collision.game_over, 'Turning into the body must end play'
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    original = json.loads(args.report.read_text(encoding="utf-8"))
    rows = []
    for row in original["results"]:
        code = row["code"]
        result = verify(f"CANDIDATE = {code!r}", CHECK) if code else None
        passed = row["passed"] and result is not None and result.passed
        rows.append({"id": row["id"], "passed": passed, "terminal_smoke": row["passed"],
                     "mechanics": asdict(result) if result else None})
        print(row["id"], passed, flush=True)
    args.output.write_text(json.dumps({"generation_report_sha256": digest(args.report),
                                      "model_sha256": original["model_sha256"],
                                      "passed": sum(row["passed"] for row in rows),
                                      "total": len(rows), "results": rows}, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
