const assert = require("node:assert/strict");
const { writeFile } = require("node:fs/promises");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const vscode = require("vscode");

exports.run = async function () {
  const config = vscode.workspace.getConfiguration("tinycoders");
  const global = vscode.ConfigurationTarget.Global;
  const real = Boolean(process.env.TINYCODERS_REAL_SERVER && process.env.TINYCODERS_REAL_MODEL);
  const server = real ? process.env.TINYCODERS_REAL_SERVER : path.join(__dirname, "mock-server.cjs");
  await config.update("serverPath", server, global);
  await config.update("memoryMiB", 2048, global);
  const model = real ? process.env.TINYCODERS_REAL_MODEL :
    path.join(process.env.TINYCODERS_TEST_HOME, "mock.gguf");
  if (!real) await writeFile(model, "stub");
  await config.update("pythonModelPath", model, global);
  const document = await vscode.workspace.openTextDocument({
    language: "python", content: "def f():\n    \n",
  });
  await vscode.window.showTextDocument(document);
  const provider = await vscode.extensions.getExtension("tinycoders.tinycoders").activate();
  const { Dashboard, dashboardId } = require("../dist/views/dashboard");
  const { taskHtml } = require("../dist/providers/task");
  const taskPanel = taskHtml([
    { phase: "plan", model: "local-planner", orders: [{ id: "<task>", role: "repair", language: "python" }] },
    { phase: "candidate", id: "<task>", model: "local-coder", tokens: 115, passed: false, fingerprint: "test:1" },
    { phase: "result", order: { id: "<task>" }, passed: true, code: "<script>alert(1)</script>" },
  ], "Finished");
  assert.match(taskPanel, /&lt;task&gt; · repair · python/);
  assert.match(taskPanel, /local-planner/);
  assert.match(taskPanel, /local-coder/);
  assert.match(taskPanel, /115/);
  assert.match(taskPanel, /test:1/);
  assert.match(taskPanel, /Verified/);
  assert.doesNotMatch(taskPanel, /<script>/);
  const commands = await vscode.commands.getCommands();
  assert.ok(commands.includes(dashboardId + ".focus"));
  assert.ok(commands.includes("tinycoders.ask"));
  assert.ok(commands.includes("tinycoders.runTask"));
  assert.ok(commands.includes("tinycoders.triggerCompletion"));
  await vscode.commands.executeCommand("tinycoders.openDashboard");

  const installed = {
    manifest: { id: "python-tiny", quant: "Q4_K_M", version: "1.0.0",
      language_ids: ["python"], capabilities: ["fim", "chat"], size_bytes: 490000000 },
  };
  let state = { trusted: true, language: "python", active: installed, models: [installed] };
  const messages = [];
  const received = new vscode.EventEmitter();
  const disposed = new vscode.EventEmitter();
  const errors = [];
  const dashboard = new Dashboard(() => state, error => errors.push(error));
  const webview = {
    postMessage: async markup => messages.push(markup),
    onDidReceiveMessage: received.event,
  };
  try {
    dashboard.resolveWebviewView({ webview, onDidDispose: disposed.event });
    assert.match(webview.html, /python-tiny/);
    assert.match(webview.html, /python · 1.0.0 · 490 MB/);
    assert.match(webview.html, /Routed/);
    assert.match(webview.html, /data-action="add"/);
    assert.match(webview.html, /data-action="version"/);
    assert.match(webview.html, /data-action="refactor"/);
    assert.deepEqual(webview.options.localResourceRoots, []);

    state = { trusted: true, language: "<rust>", models: [] };
    dashboard.refresh();
    assert.match(messages.at(-1), /No matching model/);
    assert.match(messages.at(-1), /&lt;rust&gt;/);
    assert.match(messages.at(-1), /No models installed/);
    dashboard.refresh();
    assert.equal(messages.length, 1);

    state = { trusted: false, models: [] };
    received.fire("ready");
    assert.match(messages.at(-1), /Workspace trust required/);
    assert.match(messages.at(-1), /data-action="trust"/);
    assert.doesNotMatch(messages.at(-1), /data-action="refactor"|Installed models/);
    assert.deepEqual(errors, []);
    disposed.fire();
    dashboard.refresh();
    assert.equal(messages.length, 2);
  } finally {
    dashboard.dispose();
    received.dispose();
    disposed.dispose();
  }
  const cursor = new vscode.Position(1, 4);
  const context = { triggerKind: vscode.InlineCompletionTriggerKind.Invoke };
  const cancelled = new vscode.CancellationTokenSource();
  try {
    const pending = provider.provideInlineCompletionItems(document, cursor, context, cancelled.token);
    cancelled.cancel();
    assert.deepEqual(await pending, []);
    const current = new vscode.CancellationTokenSource();
    try {
      const items = await provider.provideInlineCompletionItems(document, cursor, context, current.token);
      if (real) assert.ok(typeof items[0]?.insertText === "string" && items[0].insertText.trim());
      else assert.equal(items[0]?.insertText, "return 42");
    } finally {
      current.dispose();
    }
    if (!real) {
      const disabled = new vscode.CancellationTokenSource();
      try {
        await config.update("legacy.enabled", false, global);
        assert.deepEqual(await provider.provideInlineCompletionItems(document, cursor, context, disabled.token), []);
      } finally {
        await config.update("legacy.enabled", true, global);
        disabled.dispose();
      }
      await config.update("autocomplete", false, global);
      const marked = await vscode.workspace.openTextDocument({
        language: "python", content: "def f():\n    # tinycoders: return an answer\n    ",
      });
      const automatic = { triggerKind: vscode.InlineCompletionTriggerKind.Automatic };
      const markedCursor = new vscode.Position(2, 4);
      const token = new vscode.CancellationTokenSource();
      try {
        const complete = (doc, position, trigger) =>
          provider.provideInlineCompletionItems(doc, position, trigger, token.token);
        assert.deepEqual(await complete(document, cursor, automatic), []);
        assert.equal((await complete(document, cursor, context))[0]?.insertText, "return 42");
        assert.equal((await complete(marked, markedCursor, automatic))[0]?.insertText, "return 42");
        await config.update("commentCompletions", false, global);
        assert.deepEqual(await complete(marked, markedCursor, automatic), []);
      } finally {
        token.dispose();
      }
      const slow = await vscode.workspace.openTextDocument({ language: "python", content: "def slow():\n    " });
      const cancellation = new vscode.CancellationTokenSource();
      try {
        const pending = provider.provideInlineCompletionItems(slow, cursor, context, cancellation.token);
        await delay(500);
        cancellation.cancel();
        const result = await Promise.race([pending, delay(1200, "timed out")]);
        assert.deepEqual(result, []);
      } finally {
        cancellation.dispose();
      }
    }
  } finally {
    cancelled.dispose();
  }
};
