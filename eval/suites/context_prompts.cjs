const fs = require("node:fs");
const { BM25 } = require("../../vscode-extension/dist/context/bm25");
const { buildFim, qwenFim } = require("../../vscode-extension/dist/context/builder");

const cases = JSON.parse(fs.readFileSync(0, "utf8"));
const prompts = cases.map(row => {
  const code = row.prompt + row.suffix;
  const imports = code.slice(0, 2000).split(/\r?\n/)
    .filter(line => /^\s*(?:import |from |package |use |#include)/.test(line)).join("\n");
  const query = imports + "\n" + row.prompt.slice(-512) + row.suffix.slice(0, 80);
  const snippets = new BM25(row.context).search(query, row.path, 2);
  return [buildFim(code, row.prompt.length, 2048, qwenFim),
    buildFim(code, row.prompt.length, 2048, qwenFim, snippets)];
});
process.stdout.write(JSON.stringify(prompts));
