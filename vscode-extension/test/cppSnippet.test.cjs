const assert = require("node:assert/strict");
const { test } = require("node:test");
const { cppAnswerKind, cppCommentRequest, cppFinishedCode, cppGenerationProblem, cppShouldContinue, foreignCppSnippet } =
  require("../dist/providers/cppSnippet");

test("C++ imperative comment blocks preserve subsequent requirements", () => {
  assert.deepEqual(cppCommentRequest(["Utility", "write a for loop", "Print the index."]), {
    start: 1, instruction: "write a for loop\nPrint the index.",
  });
  assert.equal(cppCommentRequest(["Return the sum"]), undefined);
  assert.equal(cppCommentRequest(["TinyCoders: show an example"]).instruction, "show an example");
});

test("C++ guard rejects JavaScript, truncated blocks and repeated code", () => {
  assert.ok(foreignCppSnippet("for (let i = 0; i < 10; i++) console.log(i);"));
  assert.ok(cppGenerationProblem("return x;", "```js\nreturn x;\n```"));
  assert.ok(cppGenerationProblem("for (int i = 0; i < 10; ++i) {", ""));
  assert.ok(cppGenerationProblem("for (;;) { break; }", "", "program"));
  assert.ok(cppGenerationProblem("i++;\nj++;\nk++;\ni++;\nj++;\nk++;", ""));
  assert.equal(cppGenerationProblem('puts(R"(console.log("[}"))");', ""), undefined);
  assert.equal(cppGenerationProblem("for (int i = 0; i < 10; ++i) {\n    f(i);\n}", ""), undefined);
  assert.equal(cppShouldContinue("for (;;) { // comment"), true);
  assert.equal(cppShouldContinue("    } // done"), false);
  assert.equal(cppShouldContinue('std::string s = "{";'), false);
});

test("C++ generation ends at the first complete answer", () => {
  assert.equal(cppAnswerKind("Implement int length(const Item& value).", false), "function");
  assert.equal(cppAnswerKind("write a for loop", false), "program");
  assert.equal(cppAnswerKind("Implement length", true), "insertion");
  const implementation = "int f() { return 1; }";
  assert.equal(cppFinishedCode(implementation + "\n\nint main(", "function"), implementation);
  assert.equal(cppFinishedCode("```cpp\nint main() { return 0; }\n```", "program"), "int main() { return 0; }");
  assert.equal(cppFinishedCode("```cpp\nint main() {\n```", "program"), undefined);
});
