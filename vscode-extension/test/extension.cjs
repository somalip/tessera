const assert = require("node:assert/strict");
const { writeFile } = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

exports.run = async function () {
  const config = vscode.workspace.getConfiguration("tinycoders");
  const global = vscode.ConfigurationTarget.Global;
  await config.update("serverPath", path.join(__dirname, "mock-server.cjs"), global);
  const model = path.join(process.env.TINYCODERS_TEST_HOME, "mock.gguf");
  await writeFile(model, "stub");
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
    const items = await provider.provideInlineCompletionItems(
      document, cursor, context, new vscode.CancellationTokenSource().token,
    );
    assert.equal(items[0]?.insertText, "return 42");
  } finally {
    cancelled.dispose();
  }
};
