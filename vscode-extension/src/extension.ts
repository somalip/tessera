import { statSync } from "node:fs";
import { freemem } from "node:os";
import * as vscode from "vscode";
import { qwenFim } from "./context/builder";
import type { Manifest } from "./contracts";
import type { InferenceHost } from "./host/client";
import { LlamaServer } from "./host/llamaServer";
import { InlineCompletion } from "./providers/inlineCompletion";
import { embeddedLanguage, projectLanguage } from "./router/detector";
import { Lifecycle } from "./router/lifecycle";
import { selectModel } from "./router/policy";

interface Model {
  manifest: Manifest;
  path: string;
  memoryBytes: number;
}

export function activate(context: vscode.ExtensionContext): InlineCompletion {
  const log = vscode.window.createOutputChannel("TinyCoders");
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 25);
  const config = () => vscode.workspace.getConfiguration("tinycoders");
  const pins = new Map<string, string>();
  let models: Model[] = [];
  let lifecycle: Lifecycle;
  let projectFiles = new Set<string>();
  let projectFolder: string | undefined;
  let projectScan = 0;

  const refresh = () => {
    lifecycle?.dispose();
    const settings = config();
    lifecycle = new Lifecycle(settings.get("memoryMiB", 0) * 1024 ** 2 || freemem() * 0.6,
      settings.get("maxModels", 2), settings.get("idleMinutes", 5) * 60_000);
    models = [];
    for (const language of ["python", "typescript"]) {
      const path = settings.get<string>(`${language}ModelPath`);
      if (!path) continue;
      try {
        const file = statSync(path);
        if (!file.isFile() || file.size >= 1_000_000_000) throw new Error("Invalid GGUF file size");
        models.push({
          path, memoryBytes: file.size + 128 * 1024 ** 2,
          manifest: {
            schema_version: 1, id: `${language}-local`, version: "0.0.0",
            language_ids: [language], base_model: "qwen2.5-coder", params: 500_000_000,
            vscode_language_ids: language === "python" ? [language] : [language, "typescriptreact"],
            file_globs: language === "python" ? ["**/*.py", "**/*.pyi"] : ["**/*.ts", "**/*.tsx"],
            quant: "local", size_bytes: file.size, context_length: 2048,
            capabilities: ["fim", "chat", "edit"], min_runtime: { llama_cpp_build: "local" },
            prompt_formats: { fim: qwenFim, chat_template: "chatml" }, sha256: "0".repeat(64),
          },
        });
      } catch (error) {
        log.appendLine(String(error));
      }
    }
  };

  const candidate = (
    document: vscode.TextDocument, position: vscode.Position,
    capability: Manifest["capabilities"][number] = "fim",
  ) => {
    if (!vscode.workspace.isTrusted) return;
    const folder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString();
    return selectModel(models, {
      language: document.languageId,
      filename: document.uri.fsPath,
      embedded: embeddedLanguage(document.languageId, document.getText(), document.offsetAt(position)),
      project: projectLanguage(document.uri.fsPath, folder === projectFolder ? projectFiles : new Set()),
      override: pins.get(document.uri.toString()) ??
        (folder ? context.workspaceState.get<string>(`model:${folder}`) : undefined),
      generalist: config().get("generalist"), capability,
    });
  };
  const endpoint = (model: Model) => ({
    contextLength: model.manifest.context_length,
    tokens: model.manifest.prompt_formats.fim,
    use<T>(operation: (host: InferenceHost) => Promise<T>) {
      const settings = config();
      return lifecycle.use<T>(model.path, model.memoryBytes,
        () => new LlamaServer(settings.get("serverPath", "llama-server"), model.path,
          model.manifest.context_length, settings.get("gpuLayers", 0)), operation);
    },
  });
  const provider = new InlineCompletion((document, position) => {
    const model = candidate(document, position);
    return model && endpoint(model);
  }, log);

  const updateStatus = () => {
    const editor = vscode.window.activeTextEditor;
    const model = editor && candidate(editor.document, editor.selection.active);
    status.text = model ? `$(chip) ${model.manifest.id}` : "$(chip) TinyCoders";
    status.tooltip = model ? "Choose a TinyCoders model" : "Choose or configure a TinyCoders model";
  };
  const prewarm = () => {
    const editor = vscode.window.activeTextEditor;
    const model = editor && candidate(editor.document, editor.selection.active);
    if (model) void endpoint(model).use(async () => undefined).catch(error => log.appendLine(String(error)));
  };
  const scan = async () => {
    const generation = ++projectScan;
    const editor = vscode.window.activeTextEditor;
    const folder = editor && vscode.workspace.getWorkspaceFolder(editor.document.uri);
    const files = new Set<string>();
    if (folder) {
      await Promise.all([
        ["tsconfig.json", "tsconfig.json"],
        ["cpp", "**/*.{cpp,cc,cxx,hpp}"],
        ["c", "**/*.c"],
      ].map(async ([key, pattern]) => {
        const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, pattern), undefined, 1);
        if (found.length) files.add(key);
      }));
    }
    if (generation !== projectScan) return;
    projectFolder = folder?.uri.toString();
    projectFiles = files;
    updateStatus();
    prewarm();
  };

  refresh();
  status.command = "tinycoders.pickModel";
  status.show();
  updateStatus();
  context.subscriptions.push(
    log, provider, status, { dispose: () => lifecycle.dispose() },
    vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, provider),
    vscode.workspace.onDidChangeTextDocument(event => provider.cancel(event.document)),
    vscode.workspace.onDidCloseTextDocument(document => provider.cancel(document)),
    vscode.window.onDidChangeActiveTextEditor(() => {
      void scan().catch(error => log.appendLine(String(error)));
    }),
    vscode.window.onDidChangeWindowState(state => { if (state.focused) prewarm(); }),
    vscode.window.onDidChangeTextEditorSelection(updateStatus),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration("tinycoders")) {
        refresh();
        updateStatus();
      }
    }),
    vscode.commands.registerCommand("tinycoders.pickModel", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const options = [
        { label: "Automatic", id: "" },
        ...models.map(({ manifest }) => ({ label: manifest.id, id: manifest.id })),
      ];
      if (!models.length) {
        await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:tinycoders.tinycoders");
        return;
      }
      const choice = await vscode.window.showQuickPick(options, { placeHolder: "Select a model" });
      if (!choice) return;
      const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
      const scope = folder ? await vscode.window.showQuickPick(["File", "Workspace"]) : "File";
      if (scope === "File") {
        if (choice.id) pins.set(editor.document.uri.toString(), choice.id);
        else pins.delete(editor.document.uri.toString());
      } else if (scope === "Workspace" && folder) {
        pins.delete(editor.document.uri.toString());
        await context.workspaceState.update(`model:${folder.uri.toString()}`, choice.id || undefined);
      }
      updateStatus();
      prewarm();
    }),
  );
  void scan().catch(error => log.appendLine(String(error)));
  return provider;
}
