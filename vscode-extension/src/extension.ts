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
import { InlineCompletion, type InlineRoute } from "./providers/inlineCompletion";
import { builtInModels, type CatalogEntry } from "./registry/catalog";
import { fetchIndex, ModelStore, type InstalledModel } from "./registry/download";
import { embeddedLanguage, projectLanguage } from "./router/detector";
import { Lifecycle } from "./router/lifecycle";
import { selectModel } from "./router/policy";
import { PythonRegions } from "./router/pythonRegions";
import { LocalMetrics } from "./telemetry";
import { Dashboard, dashboardId } from "./views/dashboard";
import { inlineRouteName } from "./views/dashboardHtml";

export function activate(context: vscode.ExtensionContext): InlineCompletion {
  const metrics = new LocalMetrics();
  const log = vscode.window.createOutputChannel("Tessera");
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 25);
  const config = () => vscode.workspace.getConfiguration("tessera");
  const repository = new WorkspaceContext();
  const python = new PythonRegions();
  const pins = new Map<string, string>();
  const inlineRoutes = new Map<string, InlineRoute>();
  const store = new ModelStore(join(context.globalStorageUri.fsPath, "models"));
  let localModels: InstalledModel[] = [];
  let installedModels: InstalledModel[] = [];
  const models = () => [
    ...localModels.filter(model => model.manifest.capabilities.length === 1),
    ...installedModels,
    ...localModels.filter(model => model.manifest.capabilities.length > 1),
  ];
  let lifecycle: Lifecycle;
  let projectFiles = new Set<string>();
  let projectFolder: string | undefined;
  let projectScan = 0;

  const cppGlobs = ["**/*.cpp", "**/*.cc", "**/*.cxx", "**/*.hpp", "**/*.hh", "**/*.hxx"];
  const localRoles = [
    ["cpp-autocomplete-local", "cppAutocompleteModelPath", ["cpp"], cppGlobs, true],
    ["cpp-local", "cppModelPath", ["cpp"], cppGlobs, false],
    ["python-autocomplete-local", "pythonAutocompleteModelPath", ["python"], ["**/*.py", "**/*.pyi"], true],
    ["parsing-autocomplete-local", "parsingAutocompleteModelPath",
      ["json", "jsonc", "yaml", "toml", "sql", "regex"],
      ["**/*.json", "**/*.jsonc", "**/*.yaml", "**/*.yml", "**/*.toml", "**/*.sql"], true],
    ["documentation-autocomplete-local", "documentationAutocompleteModelPath",
      ["markdown", "mdx", "restructuredtext", "asciidoc", "python-docstring"],
      ["**/*.md", "**/*.mdx", "**/*.rst", "**/*.adoc"], true],
    ["python-local", "pythonModelPath", ["python"], ["**/*.py", "**/*.pyi"], false],
    ["typescript-local", "typescriptModelPath", ["typescript", "typescriptreact"],
      ["**/*.ts", "**/*.tsx"], false],
  ] satisfies Array<[string, string, string[], string[], boolean]>;

  const refresh = () => {
    const stopped = lifecycle?.dispose();
    const settings = config();
    const budget = settings.get("memoryMiB", 0) * 1024 ** 2;
    lifecycle = new Lifecycle(budget || freemem() * 0.6,
      settings.get("maxModels", 2), settings.get("idleMinutes", 5) * 60_000, stopped, budget === 0);
    localModels = [];
    for (const [id, setting, languages, globs, inlineOnly] of localRoles) {
      const path = settings.get<string>(setting);
      if (!path) continue;
      try {
        const file = statSync(path);
        if (!file.isFile() || file.size === 0 || file.size >= 1_000_000_000) throw new Error("Invalid GGUF file size");
        const contextLength = inlineOnly ? 768 : ["python-local", "cpp-local"].includes(id) ? 4096 : 2048;
        localModels.push({
          path, memoryBytes: modelMemoryBytes(file.size, contextLength),
          manifest: {
            schema_version: 1, id, version: "0.0.0",
            language_ids: languages, vscode_language_ids: languages, file_globs: globs,
            base_model: id === "documentation-autocomplete-local" ? "qwen3.5" : "qwen2.5-coder",
            params: id === "documentation-autocomplete-local" ? 800_000_000 : 500_000_000,
            quant: "local", size_bytes: file.size, context_length: contextLength,
            capabilities: inlineOnly ? ["fim"] : ["fim", "chat", "edit"], min_runtime: { llama_cpp_build: "local" },
            prompt_formats: { fim: qwenFim, chat_template: "chatml" }, sha256: "0".repeat(64),
          },
        });
      } catch (error) {
        log.appendLine(String(error));
      }
    }
    return stopped;
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
    if (["python", "markdown", "mdx", "html"].includes(language)) {
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
      installed: model,
      contextLength: model.manifest.context_length,
      tokens: model.manifest.prompt_formats.fim,
      short: model.manifest.capabilities.length === 1 && model.manifest.id.endsWith("-autocomplete-local"),
      documentation: model.manifest.id === "documentation-autocomplete-local",
      python: model.manifest.id === "python-autocomplete-local",
      use<T>(operation: (host: InferenceHost) => Promise<T>) {
        const settings = config();
        return active.use<T>(model.path, model.memoryBytes,
          paged => new LlamaServer(settings.get("serverPath", "llama-server"), model.path,
            model.manifest.context_length, settings.get("gpuLayers", 0),
            model.manifest.min_runtime.llama_cpp_build, paged, settings.get("cpuThreads", 0)), operation);
      },
    };
  };
  const completionSettings = (document: vscode.TextDocument) => {
    const settings = vscode.workspace.getConfiguration("tessera", document);
    return {
      automatic: settings.get("autocomplete", true),
      comments: settings.get("commentCompletions", true),
    };
  };
  const provider = new InlineCompletion((document, position, role) => {
    const localId = role === "comment-parser" ? "parsing-autocomplete-local"
      : role === "python-comment" ? "python-local" : undefined;
    const model = localModels.find(entry => entry.manifest.id === localId) ?? (role !== "comment-parser"
      ? candidate(document, position, role ? "chat" : "fim") : undefined);
    return model && endpoint(model);
  }, log, metrics, completionSettings, (document, position) => config().get("repositoryContext", true)
    ? repository.retrieve(document, position) : Promise.resolve([]), (document, route) => {
    const key = document.uri.toString();
    const previous = inlineRoutes.get(key);
    if (previous?.mode === route.mode && previous.model === route.model && previous.parser === route.parser) return;
    inlineRoutes.set(key, route);
    log.appendLine(`${route.mode} → ${route.model?.path ?? inlineRouteName(route)}`);
    if (vscode.window.activeTextEditor?.document === document) updateStatus();
  }, (code, newFile) => python.projectProblem(code, newFile));

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
    void vscode.window.showErrorMessage(`Tessera: ${String(error)}`);
  };
  const dashboard = new Dashboard(() => {
    const editor = vscode.window.activeTextEditor;
    return {
      trusted: vscode.workspace.isTrusted,
      advanced: context.globalState.get("advancedDashboard", false),
      language: editor?.document.languageId,
      active: editor && (candidate(editor.document, editor.selection.active) ??
        candidate(editor.document, editor.selection.active, "chat")),
      lastInline: editor && inlineRoutes.get(editor.document.uri.toString()),
      models: models(),
    };
  }, showError, advanced => context.globalState.update("advancedDashboard", advanced));

  const updateStatus = () => {
    const editor = vscode.window.activeTextEditor;
    const lastInline = editor && vscode.workspace.isTrusted && inlineRoutes.get(editor.document.uri.toString());
    const model = lastInline ? lastInline.model : editor && candidate(editor.document, editor.selection.active);
    status.text = `$(chip) ${lastInline ? inlineRouteName(lastInline) : model?.manifest.id ?? "Tessera"}`;
    status.tooltip = lastInline
      ? [`Last inline request · ${lastInline.mode}`, model?.manifest.id, model?.path,
        lastInline.parser && `Parsed by ${lastInline.parser.path}`].filter(Boolean).join("\n")
      : "Open the Tessera sidebar";
    dashboard.refresh();
  };
  const prewarm = () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const { automatic, comments } = completionSettings(editor.document);
    if (!automatic && !comments) return;
    const model = candidate(editor.document, editor.selection.active);
    if (!model) return;
    const route = endpoint(model);
    if (automatic || route.short) {
      void route.use(async () => undefined).catch(error => log.appendLine(String(error)));
    }
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

  let modelOperation = false;
  const manage = (operation: () => Promise<void>) => async () => {
    if (!vscode.workspace.isTrusted || modelOperation) return;
    modelOperation = true;
    try {
      await operation();
    } catch (error) {
      showError(error);
    } finally {
      modelOperation = false;
    }
  };

  const chooseStoredModel = async (includeLocal: boolean) => {
    const inventory = [...(includeLocal ? localModels : []), ...await store.inventory()];
    if (!inventory.length) {
      void vscode.window.showInformationMessage("Tessera has no models to manage.");
      return;
    }
    const choice = await vscode.window.showQuickPick(inventory.map(model => ({
      label: model.manifest.id,
      description: model.manifest.quant === "local" ? "Linked GGUF"
        : model.manifest.version + (installedModels.some(active => active.path === model.path) ? " · Active version" : ""),
      detail: `${Math.ceil(model.manifest.size_bytes / 1_000_000)} MB · ${model.manifest.capabilities.join(", ")}`,
      model,
    })), { placeHolder: "Select a model or installed version" });
    return choice?.model;
  };

  const activateVersion = async ({ manifest }: InstalledModel) => {
    await store.activate(manifest.id, manifest.version);
    inlineRoutes.clear();
    await loadInstalled();
    prewarm();
  };

  refresh();
  status.command = "tessera.openDashboard";
  status.show();
  updateStatus();
  context.subscriptions.push(
    log, provider, status, repository, python, dashboard,
    vscode.window.registerWebviewViewProvider(dashboardId, dashboard),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      updateStatus();
      void scan().catch(showError);
    }),
    vscode.commands.registerCommand("tessera.openDashboard",
      () => vscode.commands.executeCommand(`${dashboardId}.focus`)),
    vscode.commands.registerCommand("tessera.showOutput", () => log.show()),
    vscode.commands.registerCommand("tessera.openChat", () =>
      vscode.commands.executeCommand("workbench.action.chat.open", { query: "@tessera ", isPartialQuery: true })),
    vscode.commands.registerCommand("tessera.addLocalModel", manage(async () => {
      const language = await vscode.window.showQuickPick([
        { label: "Python (fast autocomplete)", setting: "pythonAutocompleteModelPath" },
        { label: "Structured data and SQL (autocomplete)", setting: "parsingAutocompleteModelPath" },
        { label: "Documentation (autocomplete)", setting: "documentationAutocompleteModelPath" },
        { label: "Python", setting: "pythonModelPath" },
        { label: "C++ (fast autocomplete)", setting: "cppAutocompleteModelPath" },
        { label: "C++", setting: "cppModelPath" },
        { label: "TypeScript", setting: "typescriptModelPath" },
      ], { placeHolder: "Choose a role for the local model" });
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
    })),
    registerChat(selectChat, log), registerPrompt(async () => {
      if (!vscode.workspace.isTrusted) return;
      const preferred = selectChat();
      if (preferred) return preferred;
      const choices = models().filter(model => model.manifest.capabilities.includes("chat"));
      if (!choices.length) {
        void vscode.window.showInformationMessage("Download or link a Tessera chat model from the sidebar.");
        return;
      }
      const choice = await vscode.window.showQuickPick(choices.map(model => ({
        label: model.manifest.id, description: model.manifest.language_ids.join(", "), model,
      })), { placeHolder: "Choose a model for this prompt" });
      return choice && endpoint(choice.model);
    }, showError),
    { dispose: () => { void lifecycle.dispose(); } },
    vscode.commands.registerCommand("tessera.triggerCompletion", () =>
      vscode.commands.executeCommand("editor.action.inlineSuggest.trigger")),
    vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, provider),
    vscode.workspace.onDidChangeTextDocument(event => provider.cancel(event.document)),
    vscode.workspace.onDidCloseTextDocument(document => {
      provider.cancel(document);
      inlineRoutes.delete(document.uri.toString());
      python.close(document.uri.toString());
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      updateStatus();
      void scan().catch(error => log.appendLine(String(error)));
    }),
    vscode.window.onDidChangeWindowState(state => { if (state.focused) prewarm(); }),
    vscode.window.onDidChangeTextEditorSelection(updateStatus),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (["memoryMiB", "maxModels", "idleMinutes", "serverPath", "gpuLayers", "cpuThreads", "pythonModelPath",
        "pythonAutocompleteModelPath", "parsingAutocompleteModelPath",
        "documentationAutocompleteModelPath", "cppAutocompleteModelPath", "cppModelPath",
        "typescriptModelPath"].some(setting => event.affectsConfiguration(`tessera.${setting}`))) {
        inlineRoutes.clear();
        refresh();
        prewarm();
      }
      if (event.affectsConfiguration("tessera")) updateStatus();
    }),
    vscode.commands.registerCommand("tessera.resourceLimits", async () => {
      const settings = config();
      const memory = settings.get("memoryMiB", 0);
      const threads = settings.get("cpuThreads", 0);
      const layers = settings.get("gpuLayers", 0);
      const selection = await vscode.window.showQuickPick([
        { label: "Model RAM budget", description: memory ? `${memory} MiB` : "Automatic",
          detail: "Estimated memory for resident models", setting: "memoryMiB" },
        { label: "CPU threads", description: threads ? String(threads) : "Automatic",
          detail: "Inference threads per model server", setting: "cpuThreads" },
        { label: "GPU layers", description: layers ? String(layers) : "CPU only",
          detail: "Layers to offload per model server", setting: "gpuLayers" },
        { label: "Resident models", description: String(settings.get("maxModels", 2)),
          detail: "Maximum number of loaded models", setting: "maxModels" },
      ], { placeHolder: "Choose a Tessera resource limit to edit" });
      if (selection) {
        await vscode.commands.executeCommand("workbench.action.openSettings", `@id:tessera.${selection.setting}`);
      }
    }),
    vscode.commands.registerCommand("tessera.acceptCompletion", (id: string) => metrics.accept(id)),
    vscode.commands.registerCommand("tessera.exportMetrics", async () => {
      const uri = await vscode.window.showSaveDialog({
        filters: { JSON: ["json"] }, saveLabel: "Export Tessera Metrics",
      });
      if (uri?.scheme !== "file") return;
      try {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(metrics.export(), null, 2) + "\n"));
      } catch (error) {
        showError(error);
      }
    }),
    vscode.commands.registerCommand("tessera.installModel", manage(async () => {
      const settings = config();
      const url = settings.get("registryUrl", "");
      const key = settings.get("registryPublicKey", "");
      const source = await vscode.window.showQuickPick([
        { label: "Tessera catalog", description: "Qwen coding models for autocomplete and chat", builtIn: true },
        { label: "Signed registry", description: url || "Configure an HTTPS registry", builtIn: false },
      ], { placeHolder: "Choose a model catalog" });
      if (!source) return;
      if (!source.builtIn && (!url || !key)) {
        await vscode.commands.executeCommand("workbench.action.openSettings", "tessera.registry");
        return;
      }
      const catalog: CatalogEntry[] = source.builtIn ? builtInModels
        : (await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification, title: "Loading Tessera registry",
        }, () => fetchIndex(url, key, AbortSignal.timeout(15_000)))).models;
      const inventory = await store.inventory();
      const available = catalog.filter(entry => !inventory.some(({ manifest }) =>
        manifest.id === entry.id && manifest.version === entry.version));
      if (!available.length) {
        void vscode.window.showInformationMessage("No new model versions are available from this catalog.");
        return;
      }
      const choice = await vscode.window.showQuickPick(available.map(entry => ({
        label: entry.id, description: `${entry.version} · ${Math.ceil(entry.size_bytes / 1_000_000)} MB`,
        detail: entry.upstreamManifest?.capabilities.join(", ") ?? entry.language_ids.join(", "), entry,
      })), { placeHolder: "Choose a model to download and install" });
      if (!choice) return;
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: `Installing ${choice.label}`, cancellable: true,
      }, async (progress, token) => {
        const controller = new AbortController();
        const cancellation = token.onCancellationRequested(() => controller.abort());
        if (token.isCancellationRequested) controller.abort();
        let reported = 0;
        try {
          await store.install(choice.entry, AbortSignal.any([controller.signal, AbortSignal.timeout(900_000)]),
            { upstreamManifest: choice.entry.upstreamManifest, progress: bytes => {
              const percent = Math.floor(100 * bytes / choice.entry.size_bytes);
              if (percent === reported) return;
              progress.report({ increment: percent - reported,
                message: percent === 100 ? "Verifying and unpacking…" : `${percent}% downloaded` });
              reported = percent;
            } });
          inlineRoutes.clear();
          await loadInstalled();
          prewarm();
          void vscode.window.showInformationMessage(`Installed ${choice.label} ${choice.entry.version}.`);
        } catch (error) {
          if (!controller.signal.aborted) throw error;
        } finally {
          cancellation.dispose();
        }
      });
    })),
    vscode.commands.registerCommand("tessera.switchVersion", manage(async () => {
      const model = await chooseStoredModel(false);
      if (model) await activateVersion(model);
    })),
    vscode.commands.registerCommand("tessera.manageModels", manage(async () => {
      const model = await chooseStoredModel(true);
      if (!model) return;
      const { manifest } = model;
      const role = localRoles.find(([id]) => id === manifest.id && localModels.includes(model));
      const action = await vscode.window.showQuickPick(role
        ? ["Unlink local GGUF"]
        : ["Activate this version", "Remove this version"], { placeHolder: `Manage ${manifest.id}` });
      if (action === "Activate this version") await activateVersion(model);
      if (action === "Unlink local GGUF" && role) {
        if (config().get(role[1]) !== model.path) return;
        await config().update(role[1], undefined, vscode.ConfigurationTarget.Global);
        inlineRoutes.clear();
        refresh();
        updateStatus();
        prewarm();
      }
      if (action === "Remove this version") {
        const confirmed = await vscode.window.showWarningMessage(
          `Remove ${manifest.id} ${manifest.version} from Tessera storage?`, { modal: true }, "Remove");
        if (confirmed !== "Remove") return;
        // Stop the current server before removing weights, including on Windows.
        installedModels = installedModels.filter(active => active.path !== model.path);
        inlineRoutes.clear();
        updateStatus();
        const stopped = refresh();
        try {
          await stopped;
          await store.remove(manifest.id, manifest.version);
        } finally {
          await loadInstalled();
          prewarm();
        }
      }
    })),
    vscode.commands.registerCommand("tessera.pickModel", async () => {
      if (!vscode.workspace.isTrusted) return;
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
        await vscode.commands.executeCommand("tessera.installModel");
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
      inlineRoutes.delete(editor.document.uri.toString());
      updateStatus();
      prewarm();
    }),
  );
  void python.initialize().then(updateStatus).catch(error => log.appendLine(String(error)));
  void loadInstalled().then(scan).catch(error => log.appendLine(String(error)));
  return provider;
}
