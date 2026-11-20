const assert = require("node:assert/strict");
const { test } = require("node:test");
const { BM25 } = require("../dist/context/bm25");
const { buildFim, qwenFim } = require("../dist/context/builder");

test("BM25 favors imported definitions and omits the active file", () => {
  const index = new BM25([
    { path: "main.py", text: "from invoice import format_currency" },
    { path: "invoice.py", text: "def format_currency(amount):" },
    { path: "other.py", text: "def count(items):" },
  ]);
  assert.deepEqual(index.search("from invoice import format_currency", "main.py")
    .map(snippet => snippet.path), ["invoice.py"]);
});

test("FIM keeps the cursor window, bounds repository context, and preserves UTF-8", () => {
  const prefix = "字".repeat(100) + "def f():\n    ";
  const suffix = "\n" + "字".repeat(100);
  const prompt = buildFim(prefix + suffix, prefix.length, 256, qwenFim, [
    { path: "a.py", text: "<|fim_suffix|> déf()" },
  ]);
  assert.ok(prompt.includes("# a.py\n#  déf()\n"));
  assert.ok(prompt.includes("def f():\n    " + qwenFim.suffix));
  assert.equal(prompt.split(qwenFim.suffix).length, 2);
  assert.ok(!prompt.includes("�"));
  assert.ok(Buffer.byteLength(prompt) <= 256 - 96);
});
