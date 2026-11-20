// Exercise the production inline provider without starting the VS Code UI.
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const { tasks, server, model, parser, dist, contextLength, gpuLayers, workers } = JSON.parse(fs.readFileSync(0, "utf8"));
const load = Module._load;
Module._load = function (id, ...args) {
  if (id !== "vscode") return load.call(this, id, ...args);
  return {
    InlineCompletionTriggerKind: { Automatic: 1 }, EndOfLine: { CRLF: 2 },
    workspace: { isTrusted: true }, window: {},
    Range: class {}, InlineCompletionItem: class { constructor(text) { this.insertText = text; } },
  };
};
const { InlineCompletion } = require(path.join(dist, "providers/inlineCompletion.js"));
const { LlamaServer } = require(path.join(dist, "host/llamaServer.js"));
const { qwenFim } = require(path.join(dist, "context/builder.js"));
const { PythonRegions } = require(path.join(dist, "router/pythonRegions.js"));
const python = new PythonRegions();
const hosts = new Map();

async function generate(task) {
  let route;
  let instruction;
  const diagnostics = [];
  const provider = new InlineCompletion((_doc, _position, role) => {
    if (role !== "python-comment" && !(role === "comment-parser" && parser)) return;
    const isParser = role === "comment-parser";
    const weights = isParser ? parser : model;
    const context = isParser ? 768 : contextLength;
    return {
      installed: { path: weights }, contextLength: context, tokens: qwenFim,
      async use(operation) {
        if (!hosts.has(weights)) hosts.set(weights, new LlamaServer(server, weights, context, gpuLayers));
        const host = await hosts.get(weights).start();
        return operation({
          complete: (...args) => host.complete(...args),
          chat(messages, ...args) {
            instruction = /^(?:Actual request|Request): (.+)$/m.exec(messages.find(message => message.role === "user")?.content)?.[1];
            return host.chat(messages, ...args);
          },
        });
      },
    };
  }, { appendLine: message => diagnostics.push(message) }, { record() {} },
  () => ({ automatic: true, comments: true }), undefined, (_document, result) => { route = result.mode; },
  (source, newFile) => python.projectProblem?.(source, newFile));
  try {
    const comment = `#${task.prompt}`;
    const source = comment + "\n";
    const doc = {
      languageId: "python", version: 1, eol: 1, uri: "untitled:" + task.id, getText: () => source,
      lineAt: line => ({ text: line ? "" : comment, range: { start: { line } } }),
      offsetAt: position => position.line ? source.length : 0,
    };
    const token = { isCancellationRequested: false, onCancellationRequested() { return { dispose() {} }; } };
    const start = performance.now();
    const suggestions = await provider.provideInlineCompletionItems(doc, { line: 1, character: 0 },
      { triggerKind: 1 }, token);
    process.stdout.write(JSON.stringify({ id: task.id, code: suggestions[0]?.insertText ?? "",
      route, instruction, diagnostics, seconds: (performance.now() - start) / 1000 }) + "\n");
  } finally {
    provider.dispose();
  }
}

(async () => {
  await python.initialize();
  const queue = tasks.values();
  await Promise.all(Array.from({ length: workers }, async () => {
    for (const task of queue) await generate(task);
  }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  python.dispose();
  await Promise.all([...hosts.values()].map(host => host.dispose()));
});
