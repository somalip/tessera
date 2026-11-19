const assert = require("node:assert/strict");
const path = require("node:path");
const vscode = require("vscode");

exports.run = async function () {
  const config = vscode.workspace.getConfiguration("tinycoders");
  const global = vscode.ConfigurationTarget.Global;
  await config.update("serverPath", path.join(__dirname, "mock-server.cjs"), global);
  await config.update("pythonModelPath", "/unused/model.gguf", global);
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
    const items = await provider.provideInlineCompletionItems(
      document, cursor, context, new vscode.CancellationTokenSource().token,
    );
    assert.equal(items[0]?.insertText, "return 42");
  } finally {
    cancelled.dispose();
  }
};
