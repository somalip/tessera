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
