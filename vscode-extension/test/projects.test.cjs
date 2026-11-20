const assert = require("node:assert/strict");
const { test } = require("node:test");
const { isPythonProject, projectMessages } = require("../dist/providers/projectPrompt");

test("standalone requests preserve their requirements and add the relevant terminal reference", () => {
  const request = "make a snake game in a terminal window\nUse WASD besides the arrow keys.";
  assert.equal(isPythonProject(request), true);
  const prompt = projectMessages(request)[1].content;
  assert.ok(prompt.includes(request));
  assert.ok(prompt.includes("if eating:"));
  assert.ok(prompt.includes("head in occupied"));
  assert.equal(isPythonProject("write a loop"), false);
});

test("graphical requests, other libraries, and short contexts skip the terminal reference", () => {
  for (const request of ["build a pygame snake game", "build a snake game without curses",
    "make a two-player terminal tic-tac-toe game with one numbered square per line"]) {
    assert.ok(projectMessages(request)[1].content.includes(request));
    assert.doesNotMatch(projectMessages(request)[1].content, /import curses/);
  }
  assert.doesNotMatch(projectMessages("make a snake game", "", "", 2048)[1].content, /import curses/);
});
