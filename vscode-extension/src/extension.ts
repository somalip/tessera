import { statSync } from "node:fs";
import { freemem } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { qwenFim } from "./context/builder";
import { WorkspaceContext } from "./context/workspace";
import type { Manifest } from "./contracts";
import type { InferenceHost } from "./host/client";
import { LlamaServer } from "./host/llamaServer";
import { registerChat } from "./providers/chat";
import { registerCodeActions } from "./providers/codeActions";
import { InlineCompletion } from "./providers/inlineCompletion";
import { fetchIndex, ModelStore, type InstalledModel } from "./registry/download";
import { embeddedLanguage, projectLanguage } from "./router/detector";
import { Lifecycle } from "./router/lifecycle";
import { selectModel } from "./router/policy";

export function activate(context: vscode.ExtensionContext): InlineCompletion {
  const log = vscode.window.createOutputChannel("TinyCoders");
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 25);
  const config = () => vscode.workspace.getConfiguration("tinycoders");
  const repository = new WorkspaceContext();
  const pins = new Map<string, string>();
  const store = new ModelStore(join(context.globalStorageUri.fsPath, "models"));
  let localModels: InstalledModel[] = [];
  let installedModels: InstalledModel[] = [];
  const models = () => [...installedModels, ...localModels];
  let lifecycle: Lifecycle;
  let projectFiles = new Set<string>();
  let projectFolder: string | undefined;
  let projectScan = 0;

  const refresh = () => {
    lifecycle?.dispose();
    const settings = config();
    lifecycle = new Lifecycle(settings.get("memoryMiB", 0) * 1024 ** 2 || freemem() * 0.6,
      settings.get("maxModels", 2), settings.get("idleMinutes", 5) * 60_000);
    localModels = [];
    for (const language of ["python", "typescript"]) {
      const path = settings.get<string>(`${language}ModelPath`);
      if (!path) continue;
      try {
        const file = statSync(path);
        if (!file.isFile() || file.size >= 1_000_000_000) throw new Error("Invalid GGUF file size");
        localModels.push({
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
    return selectModel(models(), {
      language: document.languageId,
      filename: document.uri.fsPath,
      embedded: embeddedLanguage(document.languageId, document.getText(), document.offsetAt(position)),
      project: projectLanguage(document.uri.fsPath, folder === projectFolder ? projectFiles : new Set()),
      override: pins.get(document.uri.toString()) ??
        (folder ? context.workspaceState.get<string>(`model:${folder}`) : undefined),
      generalist: config().get("generalist"), capability,
    });
  };
  const endpoint = (model: InstalledModel) => ({
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
  }, log, (document, position) => config().get("repositoryContext", true)
    ? repository.retrieve(document, position) : Promise.resolve([]));

  const chatModel = (editor: vscode.TextEditor, capability: "chat" | "edit") => {
    const model = candidate(editor.document, editor.selection.active, capability);
    return model && endpoint(model);
  };
  registerCodeActions(context, (editor, action) => chatModel(editor, action === "explain" ? "chat" : "edit"), log);

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
    if (editor && config().get("repositoryContext", true)) void repository.warm(editor.document);
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

  const loadInstalled = async () => {
    installedModels = await store.installed();
    updateStatus();
  };
  const showError = (error: unknown) => {
    log.appendLine(String(error));
    void vscode.window.showErrorMessage(`TinyCoders: ${String(error)}`);
  };

  refresh();
  status.command = "tinycoders.pickModel";
  status.show();
  updateStatus();
  context.subscriptions.push(
    log, provider, status, repository, registerChat(() => {
      const editor = vscode.window.activeTextEditor;
      return editor && chatModel(editor, "chat");
    }, log), { dispose: () => lifecycle.dispose() },
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
    vscode.commands.registerCommand("tinycoders.installModel", async () => {
      if (!vscode.workspace.isTrusted) return;
      const settings = config();
      const url = settings.get("registryUrl", "");
      const key = settings.get("registryPublicKey", "");
      if (!url || !key) {
        await vscode.commands.executeCommand("workbench.action.openSettings", "tinycoders.registry");
        return;
      }
      try {
        const index = await fetchIndex(url, key, AbortSignal.timeout(15_000));
        const entries = index.models.map(entry => ({
          label: entry.id, description: entry.version, detail: entry.language_ids.join(", "), entry,
        }));
        const choice = await vscode.window.showQuickPick(entries, { placeHolder: "Select a model version" });
        if (!choice) return;
        await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification, title: `Installing ${choice.label}`, cancellable: true,
        }, async (_progress, token) => {
          const controller = new AbortController();
          const cancellation = token.onCancellationRequested(() => controller.abort());
          try {
            await store.install(choice.entry, AbortSignal.any([controller.signal, AbortSignal.timeout(900_000)]));
            await loadInstalled();
            prewarm();
          } catch (error) {
            if (!controller.signal.aborted) throw error;
          } finally {
            cancellation.dispose();
          }
        });
      } catch (error) {
        showError(error);
      }
    }),
    vscode.commands.registerCommand("tinycoders.switchVersion", async () => {
      if (!vscode.workspace.isTrusted) return;
      try {
        const id = await vscode.window.showQuickPick(installedModels.map(model => model.manifest.id));
        if (!id) return;
        const version = await vscode.window.showQuickPick(await store.versions(id));
        if (!version) return;
        await store.activate(id, version);
        await loadInstalled();
        prewarm();
      } catch (error) {
        showError(error);
      }
    }),
    vscode.commands.registerCommand("tinycoders.pickModel", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const options = [
        { label: "Automatic", id: "" },
        ...models().map(({ manifest }) => ({ label: manifest.id, id: manifest.id })),
      ];
      options.push({ label: "Install a model…", id: "install" });
      const choice = await vscode.window.showQuickPick(options, { placeHolder: "Select a model" });
      if (!choice) return;
      if (choice.id === "install") {
        await vscode.commands.executeCommand("tinycoders.installModel");
        return;
      }
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
  void loadInstalled().then(scan).catch(error => log.appendLine(String(error)));
  return provider;
}
