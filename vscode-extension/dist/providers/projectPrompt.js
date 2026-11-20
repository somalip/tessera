"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isPythonProject = isPythonProject;
exports.projectMessages = projectMessages;
const projectKind = /\b(?:api|app(?:lication)?|cli|command[ -]line|converter|dashboard|game|manager|program|report|script|server|terminal|tool|tui|utility)\b/i;
const buildRequest = /\b(?:build|create|generate|implement|make|write)\b/i;
const interactiveProject = /\b(?:game|interactive|tui|text user interface)\b/i;
const lineInput = /\b(?:stdin|per line|one line|numbered square|read (?:one |each )?(?:guess|answer))\b/i;
const graphicalInterface = /\b(?:browser|graphical|gui|pygame|tkinter|turtle|windowed)\b/i;
const otherTerminalLibrary = /\b(?:blessed|prompt_toolkit|rich|textual)\b|\b(?:without|no|avoid)\s+curses\b/i;
const snakeGame = /\b(?:snake(?:[- ]style)? game|game of snake)\b/i;
// An original, execution-tested reference for the standard terminal game.
const snakeExample = `import curses
from random import choice

ARROWS = {curses.KEY_UP: (-1, 0), curses.KEY_DOWN: (1, 0),
          curses.KEY_LEFT: (0, -1), curses.KEY_RIGHT: (0, 1)}


def find_food(board, body):
    empty = sorted(board.difference(body))
    return choice(empty) if empty else None


def main(screen):
    screen.keypad(True)
    screen.timeout(110)
    height, width = screen.getmaxyx()
    if height < 8 or width < 22:
        return
    board = {(r, c) for r in range(1, height - 1) for c in range(1, width - 1)}
    row, col = height // 2, width // 2
    body = [(row, col), (row, col - 1), (row, col - 2)]
    direction = (0, 1)
    score = 0
    food = find_food(board, body)
    outcome = ''
    while not outcome:
        if screen.getmaxyx() != (height, width):
            return
        screen.erase()
        screen.addnstr(0, 0, f'Score: {score} | Arrows steer | q quits', width - 1)
        screen.addch(*food, '*')
        for segment in body[1:]:
            screen.addch(*segment, 'o')
        screen.addch(*body[0], '@')
        screen.refresh()
        key = screen.getch()
        if key in (ord('q'), ord('Q')):
            return
        turn = ARROWS.get(key, direction)
        if turn != (-direction[0], -direction[1]):
            direction = turn
        head = (body[0][0] + direction[0], body[0][1] + direction[1])
        eating = head == food
        occupied = body if eating else body[:-1]
        if head not in board or head in occupied:
            outcome = 'Game over'
            break
        body.insert(0, head)
        if eating:
            score += 1
            food = find_food(board, body)
            if food is None:
                outcome = 'You win'
        else:
            body.pop()
    screen.erase()
    screen.addnstr(0, 0, f'{outcome} | Score: {score}', width - 1)
    screen.refresh()
    screen.timeout(1000)
    screen.getch()


if __name__ == '__main__':
    curses.wrapper(main)
`;
function isPythonProject(instruction) {
    return buildRequest.test(instruction) && (projectKind.test(instruction) || instruction.length >= 160);
}
function projectMessages(instruction, before = "", after = "", contextLength = 4096) {
    const liveInput = interactiveProject.test(instruction) && !lineInput.test(instruction) &&
        !graphicalInterface.test(instruction) && !otherTerminalLibrary.test(instruction);
    const useSnakeExample = liveInput && !before && !after && snakeGame.test(instruction) &&
        contextLength >= 4096 && Buffer.byteLength(instruction) <= 768;
    const guidance = liveInput
        ? " For a live terminal program with no requested library, use curses.wrapper(main). " +
            "Keep the loop and its mutable state inside one main function without nested functions. " +
            "Enable screen.keypad(True), call screen.timeout(120), and read one key per frame. Render and refresh " +
            "before reading input. Handle q immediately. For grid movement use nonnegative (row, col) positions " +
            "and map key codes to (dr, dc) tuples. Use screen.getmaxyx() for safe bounds, reserve the top row " +
            "for status, and avoid the last column. Check the next position before updating or drawing it. " +
            "Spawn collectibles only on free cells. In a game, display the score and a clear end state."
        : " Implement the full input/output flow, including argument parsing and input validation where applicable.";
    return [
        { role: "system", content: "Write complete, runnable Python 3 code. Output code only. " +
                "Use a single file and the standard library by default. Import what you use, define all needed behavior, " +
                "and call main under the __main__ guard for a standalone program. " +
                "Honor all explicit requirements. If the user leaves the interface open, choose a terminal interface." },
        { role: "user", content: useSnakeExample
                ? `Example of the classic growing-tail terminal game with standard rules:\n\n${snakeExample}\n` +
                    `Actual request: ${instruction}\nReturn a complete Python implementation. Follow the example's working ` +
                    "defaults for unspecified details. Keep the head and body movement, distinct food, growth, score, and collision checks."
                : `Request: ${instruction}\n` +
                    (before || after ? `Existing code before the cursor:\n${before}\nExisting code after the cursor:\n${after}\n` : "") +
                    `Implement the requested program.${guidance}` },
    ];
}
