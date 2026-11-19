import { statSync } from "node:fs";
import { freemem } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { qwenFim } from "./context/builder";
import { WorkspaceContext } from "./context/workspace";
import type { Manifest } from "./contracts";
import type { InferenceHost } from "./host/client";
import { LlamaServer } from "./host/llamaServer";
import { modelMemoryBytes } from "./host/memory";
import { registerChat, registerPrompt } from "./providers/chat";
import { registerCodeActions } from "./providers/codeActions";
import { InlineCompletion } from "./providers/inlineCompletion";
import { fetchIndex, ModelStore, type InstalledModel } from "./registry/download";
import { embeddedLanguage, projectLanguage } from "./router/detector";
import { Lifecycle } from "./router/lifecycle";
import { selectModel } from "./router/policy";
import { PythonRegions } from "./router/pythonRegions";
import { LocalMetrics } from "./telemetry";
import { Dashboard, dashboardId } from "./views/dashboard";

export function activate(context: vscode.ExtensionContext): InlineCompletion {
  const metrics = new LocalMetrics();
  const log = vscode.window.createOutputChannel("TinyCoders");
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 25);
  const config = () => vscode.workspace.getConfiguration("tinycoders");
  const repository = new WorkspaceContext();
  const python = new PythonRegions();
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
    const stopped = lifecycle?.dispose();
    const settings = config();
    const budget = settings.get("memoryMiB", 0) * 1024 ** 2;
    lifecycle = new Lifecycle(budget || freemem() * 0.6,
      settings.get("maxModels", 2), settings.get("idleMinutes", 5) * 60_000, stopped, budget === 0);
    localModels = [];
    for (const language of ["python", "typescript"]) {
      const path = settings.get<string>(`${language}ModelPath`);
      if (!path) continue;
      try {
        const file = statSync(path);
        if (!file.isFile() || file.size === 0 || file.size >= 1_000_000_000) throw new Error("Invalid GGUF file size");
        localModels.push({
          path, memoryBytes: modelMemoryBytes(file.size, 2048),
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
    const docsKey = document.uri.toString();
    const language = document.languageId;
    let embedded: string | undefined;
    if (["python", "markdown", "html"].includes(language)) {
      const source = document.getText();
      const offset = document.offsetAt(position);
      embedded = language === "python" && python.available
        ? python.at(docsKey, document.version, source, offset)
        : embeddedLanguage(language, source, offset);
    }
    return selectModel(models(), {
      language, embedded,
      filename: document.uri.fsPath,
      project: projectLanguage(document.uri.fsPath, folder === projectFolder ? projectFiles : new Set()),
      override: pins.get(document.uri.toString()) ??
        (folder ? context.workspaceState.get<string>(`model:${folder}`) : undefined),
      generalist: config().get("generalist"), capability,
    });
  };
  const endpoint = (model: InstalledModel) => {
    const active = lifecycle;
    return {
      contextLength: model.manifest.context_length,
      tokens: model.manifest.prompt_formats.fim,
      use<T>(operation: (host: InferenceHost) => Promise<T>) {
        const settings = config();
        return active.use<T>(model.path, model.memoryBytes,
          paged => new LlamaServer(settings.get("serverPath", "llama-server"), model.path,
            model.manifest.context_length, settings.get("gpuLayers", 0),
            model.manifest.min_runtime.llama_cpp_build, paged), operation);
      },
    };
  };
  const completionSettings = (document: vscode.TextDocument) => {
    const settings = vscode.workspace.getConfiguration("tinycoders", document);
    return {
      automatic: settings.get("autocomplete", true),
      comments: settings.get("commentCompletions", true),
    };
  };
  const provider = new InlineCompletion((document, position) => {
    const model = candidate(document, position);
    return model && endpoint(model);
  }, log, metrics, completionSettings, (document, position) => config().get("repositoryContext", true)
    ? repository.retrieve(document, position) : Promise.resolve([]));

  const chatModel = (editor: vscode.TextEditor, capability: "chat" | "edit") => {
    const model = candidate(editor.document, editor.selection.active, capability);
    return model && endpoint(model);
  };
  const selectChat = () => {
    if (!vscode.workspace.isTrusted) return;
    const editor = vscode.window.activeTextEditor;
    const routed = editor && chatModel(editor, "chat");
    if (routed) return routed;
    const available = models().filter(model => model.manifest.capabilities.includes("chat"));
    const fallback = available.find(model => model.manifest.id === config().get("generalist")) ??
      (available.length === 1 ? available[0] : undefined);
    return fallback && endpoint(fallback);
  };
  registerCodeActions(context, (editor, action) => chatModel(editor, action === "explain" ? "chat" : "edit"), log);

  const showError = (error: unknown) => {
    log.appendLine(String(error));
    void vscode.window.showErrorMessage(`TinyCoders: ${String(error)}`);
  };
  const dashboard = new Dashboard(() => {
    const editor = vscode.window.activeTextEditor;
    return {
      trusted: vscode.workspace.isTrusted,
      language: editor?.document.languageId,
      active: editor && candidate(editor.document, editor.selection.active),
      models: models(),
    };
  }, showError);

  const updateStatus = () => {
    const editor = vscode.window.activeTextEditor;
    const model = editor && candidate(editor.document, editor.selection.active);
    status.text = model ? `$(chip) ${model.manifest.id}` : "$(chip) TinyCoders";
    status.tooltip = "Open the TinyCoders sidebar";
    dashboard.refresh();
  };
  const prewarm = () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !completionSettings(editor.document).automatic) return;
    const model = editor && candidate(editor.document, editor.selection.active);
    if (model) void endpoint(model).use(async () => undefined).catch(error => log.appendLine(String(error)));
  };
  const scan = async () => {
    const generation = ++projectScan;
    const editor = vscode.window.activeTextEditor;
    const folder = editor && vscode.workspace.getWorkspaceFolder(editor.document.uri);
    const files = new Set<string>();
    if (editor && config().get("repositoryContext", true)) void repository.warm(editor.document);
    if (folder && vscode.workspace.isTrusted) {
      await Promise.all([
        ["tsconfig.json", "tsconfig.json"],
        ["cpp", "**/*.{cpp,cc,cxx,hpp}"],
        ["c", "**/*.c"],
      ].map(async ([key, pattern]) => {
        const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, pattern), undefined, 1);
        if (found.length) files.add(key);
      }));
      await Promise.all(["CMakeLists.txt", "compile_flags.txt", "Makefile"].map(async filename => {
        const uri = vscode.Uri.joinPath(folder.uri, filename);
        try {
          const item = await vscode.workspace.fs.stat(uri);
          if (item.type !== vscode.FileType.File || item.size > 64_000) return;
          const flags = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
          if (/\b(?:CXX|CMAKE_CXX_[A-Z_]+)\b|-std=(?:gnu|c)\+\+|\b(?:clang|g)\+\+/i.test(flags)) {
            files.add("compile_flags_cpp");
          } else if (/\bCMAKE_C_STANDARD\b|-std=(?:gnu|c)(?:89|90|99|11|17|23)\b/i.test(flags)) {
            files.add("c");
          }
        } catch {
          // Projects may omit any of these conventional build files.
        }
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

  refresh();
  status.command = "tinycoders.openDashboard";
  status.show();
  updateStatus();
  context.subscriptions.push(
    log, provider, status, repository, python, dashboard,
    vscode.window.registerWebviewViewProvider(dashboardId, dashboard),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      updateStatus();
      void scan().catch(showError);
    }),
    vscode.commands.registerCommand("tinycoders.openDashboard",
      () => vscode.commands.executeCommand(`${dashboardId}.focus`)),
    vscode.commands.registerCommand("tinycoders.showOutput", () => log.show()),
    vscode.commands.registerCommand("tinycoders.openChat", () =>
      vscode.commands.executeCommand("workbench.action.chat.open", { query: "@tinycoders ", isPartialQuery: true })),
    vscode.commands.registerCommand("tinycoders.addLocalModel", async () => {
      if (!vscode.workspace.isTrusted) return;
      const language = await vscode.window.showQuickPick([
        { label: "Python", setting: "pythonModelPath" },
        { label: "TypeScript", setting: "typescriptModelPath" },
      ], { placeHolder: "Choose a language for the local Qwen2.5-Coder model" });
      if (!language) return;
      const [file] = await vscode.window.showOpenDialog({
        canSelectMany: false, canSelectFolders: false, filters: { GGUF: ["gguf"] }, openLabel: "Use Model",
      }) ?? [];
      if (!file || file.scheme !== "file") return;
      try {
        const model = await vscode.workspace.fs.stat(file);
        if (!(model.type & vscode.FileType.File) || model.size === 0 || model.size >= 1_000_000_000 ||
            !file.fsPath.toLowerCase().endsWith(".gguf")) {
          throw new Error("Choose a nonempty local GGUF file smaller than 1 GB.");
        }
        await config().update(language.setting, file.fsPath, vscode.ConfigurationTarget.Global);
      } catch (error) {
        showError(error);
      }
    }),
    registerChat(selectChat, log), registerPrompt(selectChat, showError),
    { dispose: () => { void lifecycle.dispose(); } },
    vscode.commands.registerCommand("tinycoders.triggerCompletion", () =>
      vscode.commands.executeCommand("editor.action.inlineSuggest.trigger")),
    vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, provider),
    vscode.workspace.onDidChangeTextDocument(event => provider.cancel(event.document)),
    vscode.workspace.onDidCloseTextDocument(document => {
      provider.cancel(document);
      python.close(document.uri.toString());
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      updateStatus();
      void scan().catch(error => log.appendLine(String(error)));
    }),
    vscode.window.onDidChangeWindowState(state => { if (state.focused) prewarm(); }),
    vscode.window.onDidChangeTextEditorSelection(updateStatus),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (["memoryMiB", "maxModels", "idleMinutes", "serverPath", "gpuLayers", "pythonModelPath",
        "typescriptModelPath"].some(setting => event.affectsConfiguration(`tinycoders.${setting}`))) {
        refresh();
      }
      if (event.affectsConfiguration("tinycoders")) updateStatus();
    }),
    vscode.commands.registerCommand("tinycoders.acceptCompletion", (id: string) => metrics.accept(id)),
    vscode.commands.registerCommand("tinycoders.exportMetrics", async () => {
      const uri = await vscode.window.showSaveDialog({
        filters: { JSON: ["json"] }, saveLabel: "Export TinyCoders Metrics",
      });
      if (uri?.scheme !== "file") return;
      try {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(metrics.export(), null, 2) + "\n"));
      } catch (error) {
        showError(error);
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
      options.push({ label: "Install a model…", id: "@install" });
      const choice = await vscode.window.showQuickPick(options, { placeHolder: "Select a model" });
      if (!choice) return;
      if (choice.id === "@install") {
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
  void python.initialize().then(updateStatus).catch(error => log.appendLine(String(error)));
  void loadInstalled().then(scan).catch(error => log.appendLine(String(error)));
  return provider;
}
