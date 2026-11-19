import * as vscode from "vscode";
import { qwenFim } from "./context/builder";
import { LlamaServer } from "./host/llamaServer";
import { InlineCompletion } from "./providers/inlineCompletion";

export function activate(context: vscode.ExtensionContext): InlineCompletion {
  const log = vscode.window.createOutputChannel("TinyCoders");
  let server: LlamaServer | undefined;
  const reset = () => { server?.dispose(); server = undefined; };
  const provider = new InlineCompletion(document => {
    if (document.languageId !== "python" || !vscode.workspace.isTrusted) return;
    const config = vscode.workspace.getConfiguration("tinycoders");
    const modelPath = config.get<string>("pythonModelPath");
    if (!modelPath) return;
    const contextLength = 2048;
    return {
      contextLength, tokens: qwenFim,
      async use(operation) {
        server ??= new LlamaServer(config.get("serverPath", "llama-server"),
          modelPath, contextLength, config.get("gpuLayers", 0));
        const current = server;
        try {
          return await operation(await current.start());
        } finally {
          if (!current.alive && server === current) reset();
        }
      },
    };
  }, log);
  context.subscriptions.push(
    log, provider, { dispose: reset },
    vscode.languages.registerInlineCompletionItemProvider({ language: "python" }, provider),
    vscode.workspace.onDidChangeTextDocument(event => provider.cancel(event.document)),
    vscode.workspace.onDidCloseTextDocument(document => provider.cancel(document)),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration("tinycoders")) reset();
    }),
  );
  return provider;
}
