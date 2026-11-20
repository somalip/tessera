const defaultMessages = exports.projectMessages;
exports.projectMessages = function (instruction, before, after) {
  const messages = defaultMessages(instruction, before, after);
  if (!/\b(?:game|interactive|tui)\b/i.test(instruction) || /\b(?:stdin|per line|pygame|tkinter)\b/i.test(instruction)) return messages;
  messages[1].content += `

Here is a small moving-marker example showing how to structure a timed grid loop. Adapt the pattern for the game requested and implement all its rules. Return the entire new program, with wrapper called only once.
import curses

MOVES = {curses.KEY_UP: (-1, 0), curses.KEY_DOWN: (1, 0),
         curses.KEY_LEFT: (0, -1), curses.KEY_RIGHT: (0, 1)}

def main(screen):
    screen.keypad(True)
    screen.timeout(120)
    height, width = screen.getmaxyx()
    if height < 5 or width < 10:
        return
    row, col = height // 2, width // 2
    dr, dc = 0, 1
    while True:
        screen.erase()
        screen.addnstr(0, 0, 'Arrows to steer, q to quit', width - 1)
        screen.addch(row, col, '@')
        screen.refresh()
        key = screen.getch()
        if key == ord('q'):
            return
        dr, dc = MOVES.get(key, (dr, dc))
        nr, nc = row + dr, col + dc
        if not (1 <= nr < height - 1 and 0 <= nc < width - 1):
            screen.addnstr(0, 0, 'Game over', width - 1)
            screen.refresh()
            screen.getch()
            return
        row, col = nr, nc

if __name__ == '__main__':
    curses.wrapper(main)
`;
  return messages;
};
