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
  const commands = await vscode.commands.getCommands();
  assert.ok(commands.includes(dashboardId + ".focus"));
  await vscode.commands.executeCommand("tinycoders.openDashboard");

  const installed = {
    manifest: { id: "python-tiny", quant: "Q4_K_M", version: "1.0.0",
      language_ids: ["python"], capabilities: ["fim", "chat"], size_bytes: 490000000 },
  };
  let state = { trusted: true, language: "python", active: installed, models: [installed] };
  const dashboard = new Dashboard(() => state);
  let refreshed = false;
  const listener = dashboard.onDidChangeTreeData(() => { refreshed = true; });
  try {
    const [editorGroup, models, actions] = dashboard.getChildren();
    assert.equal(dashboard.getChildren(editorGroup)[0].label, "python-tiny");
    const modelRows = dashboard.getChildren(models);
    assert.equal(modelRows[0].description, "python · 1.0.0");
    assert.equal(modelRows.find(row => row.id === "tinycoders.addLocalModel").command.command,
      "tinycoders.addLocalModel");
    assert.ok(modelRows.some(row => row.id === "tinycoders.switchVersion"));
    assert.ok(dashboard.getChildren(actions).some(row => row.id === "tinycoders.refactor"));

    state = { trusted: true, language: "rust", models: [] };
    dashboard.refresh();
    assert.equal(refreshed, true);
    assert.equal(dashboard.getChildren(dashboard.getChildren()[0])[0].label, "No matching model");
    state = { trusted: false, models: [] };
    assert.deepEqual(dashboard.getChildren().map(row => row.id), ["editor", "tools"]);
  } finally {
    listener.dispose();
    dashboard.dispose();
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
