"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const vscode = __importStar(require("vscode"));
const builder_1 = require("./context/builder");
const workspace_1 = require("./context/workspace");
const llamaServer_1 = require("./host/llamaServer");
const memory_1 = require("./host/memory");
const chat_1 = require("./providers/chat");
const codeActions_1 = require("./providers/codeActions");
const inlineCompletion_1 = require("./providers/inlineCompletion");
const { registerCommentPreviewCommands } = require("./providers/commentPreview");
const download_1 = require("./registry/download");
const detector_1 = require("./router/detector");
const lifecycle_1 = require("./router/lifecycle");
const policy_1 = require("./router/policy");
const pythonRegions_1 = require("./router/pythonRegions");
const telemetry_1 = require("./telemetry");
const dashboard_1 = require("./views/dashboard");
function activate(context) {
    const metrics = new telemetry_1.LocalMetrics();
    const log = vscode.window.createOutputChannel("Tessera");
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 25);
    const config = () => vscode.workspace.getConfiguration("tessera");
    const repository = new workspace_1.WorkspaceContext();
    const python = new pythonRegions_1.PythonRegions();
    const pins = new Map();
    const store = new download_1.ModelStore((0, node_path_1.join)(context.globalStorageUri.fsPath, "models"));
    let localModels = [];
    let installedModels = [];
    const models = () => [...installedModels, ...localModels];
    let lifecycle;
    let projectFiles = new Set();
    let projectFolder;
    let projectScan = 0;
    const refresh = () => {
        const stopped = lifecycle?.dispose();
        const settings = config();
        const budget = settings.get("memoryMiB", 0) * 1024 ** 2;
        lifecycle = new lifecycle_1.Lifecycle(budget || (0, node_os_1.freemem)() * 0.6, settings.get("maxModels", 2), settings.get("idleMinutes", 5) * 60_000, stopped, budget === 0);
        localModels = [];
        for (const language of ["python", "typescript"]) {
            const path = settings.get(`${language}ModelPath`);
            if (!path)
                continue;
            try {
                const file = (0, node_fs_1.statSync)(path);
                if (!file.isFile() || file.size === 0 || file.size >= 1_000_000_000)
                    throw new Error("Invalid GGUF file size");
                localModels.push({
                    path, memoryBytes: (0, memory_1.modelMemoryBytes)(file.size, 2048),
                    manifest: {
                        schema_version: 1, id: `${language}-local`, version: "0.0.0",
                        language_ids: language === "python" ? [language] : [language, "javascript"], base_model: "qwen2.5-coder", params: 500_000_000,
                        vscode_language_ids: language === "python" ? [language] : [language, "typescriptreact", "javascript", "javascriptreact"],
                        file_globs: language === "python" ? ["**/*.py", "**/*.pyi"] : ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"],
                        quant: "local", size_bytes: file.size, context_length: 2048,
                        capabilities: ["fim", "chat", "edit"], min_runtime: { llama_cpp_build: "local" },
                        prompt_formats: { fim: builder_1.qwenFim, chat_template: "chatml" }, sha256: "0".repeat(64),
                    },
                });
            }
            catch (error) {
                log.appendLine(String(error));
            }
        }
    };
    const candidate = (document, position, capability = "fim") => {
        if (!vscode.workspace.isTrusted)
            return;
        const folder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString();
        const docsKey = document.uri.toString();
        const language = document.languageId;
        let embedded;
        if (["python", "markdown", "html"].includes(language)) {
            const source = document.getText();
            const offset = document.offsetAt(position);
            embedded = language === "python" && python.available
                ? python.at(docsKey, document.version, source, offset)
                : (0, detector_1.embeddedLanguage)(language, source, offset);
        }
        return (0, policy_1.selectModel)(models(), {
            language, embedded,
            filename: document.uri.fsPath,
            project: (0, detector_1.projectLanguage)(document.uri.fsPath, folder === projectFolder ? projectFiles : new Set()),
            override: pins.get(document.uri.toString()) ??
                (folder ? context.workspaceState.get(`model:${folder}`) : undefined),
            generalist: config().get("generalist"), capability,
        });
    };
    const endpoint = (model) => {
        const active = lifecycle;
        return {
            contextLength: model.manifest.context_length,
            tokens: model.manifest.prompt_formats.fim,
            use(operation) {
                const settings = config();
                return active.use(model.path, model.memoryBytes, paged => new llamaServer_1.LlamaServer(settings.get("serverPath", "llama-server"), model.path, model.manifest.context_length, settings.get("gpuLayers", 0), model.manifest.min_runtime.llama_cpp_build, paged), operation);
            },
        };
    };
    const completionSettings = (document) => {
        const settings = vscode.workspace.getConfiguration("tessera", document);
        return {
            automatic: settings.get("autocomplete", true),
            comments: settings.get("commentCompletions", true),
        };
    };
    const provider = new inlineCompletion_1.InlineCompletion((document, position) => {
        const model = candidate(document, position);
        return model && endpoint(model);
    }, log, metrics, completionSettings, (document, position) => config().get("repositoryContext", true)
        ? repository.retrieve(document, position) : Promise.resolve([]));
    context.subscriptions.push(registerCommentPreviewCommands("tessera.acceptStreamingComment", "tessera.dismissCommentPreview"));
    const chatModel = (editor, capability) => {
        const model = candidate(editor.document, editor.selection.active, capability);
        return model && endpoint(model);
    };
    const selectChat = () => {
        if (!vscode.workspace.isTrusted)
            return;
        const editor = vscode.window.activeTextEditor;
        const routed = editor && chatModel(editor, "chat");
        if (routed)
            return routed;
        const available = models().filter(model => model.manifest.capabilities.includes("chat"));
        const fallback = available.find(model => model.manifest.id === config().get("generalist")) ??
            (available.length === 1 ? available[0] : undefined);
        return fallback && endpoint(fallback);
    };
    (0, codeActions_1.registerCodeActions)(context, (editor, action) => chatModel(editor, action === "explain" ? "chat" : "edit"), log);
    const showError = (error) => {
        log.appendLine(String(error));
        void vscode.window.showErrorMessage(`Tessera: ${String(error)}`);
    };
    const dashboard = new dashboard_1.Dashboard(() => {
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
        status.text = model ? `$(chip) ${model.manifest.id}` : "$(chip) Tessera";
        status.tooltip = "Open the Tessera sidebar";
        dashboard.refresh();
    };
    const prewarm = () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !completionSettings(editor.document).automatic)
            return;
        const model = editor && candidate(editor.document, editor.selection.active);
        if (model)
            void endpoint(model).use(async () => undefined).catch(error => log.appendLine(String(error)));
    };
    const scan = async () => {
        const generation = ++projectScan;
        const editor = vscode.window.activeTextEditor;
        const folder = editor && vscode.workspace.getWorkspaceFolder(editor.document.uri);
        const files = new Set();
        if (editor && config().get("repositoryContext", true))
            void repository.warm(editor.document);
        if (folder && vscode.workspace.isTrusted) {
            await Promise.all([
                ["tsconfig.json", "tsconfig.json"],
                ["cpp", "**/*.{cpp,cc,cxx,hpp}"],
                ["c", "**/*.c"],
            ].map(async ([key, pattern]) => {
                const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, pattern), undefined, 1);
                if (found.length)
                    files.add(key);
            }));
            await Promise.all(["CMakeLists.txt", "compile_flags.txt", "Makefile"].map(async (filename) => {
                const uri = vscode.Uri.joinPath(folder.uri, filename);
                try {
                    const item = await vscode.workspace.fs.stat(uri);
                    if (item.type !== vscode.FileType.File || item.size > 64_000)
                        return;
                    const flags = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
                    if (/\b(?:CXX|CMAKE_CXX_[A-Z_]+)\b|-std=(?:gnu|c)\+\+|\b(?:clang|g)\+\+/i.test(flags)) {
                        files.add("compile_flags_cpp");
                    }
                    else if (/\bCMAKE_C_STANDARD\b|-std=(?:gnu|c)(?:89|90|99|11|17|23)\b/i.test(flags)) {
                        files.add("c");
                    }
                }
                catch {
                    // Projects may omit any of these conventional build files.
                }
            }));
        }
        if (generation !== projectScan)
            return;
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
    status.command = "tessera.openDashboard";
    status.show();
    updateStatus();
    context.subscriptions.push(log, provider, status, repository, python, dashboard, vscode.window.registerWebviewViewProvider(dashboard_1.dashboardId, dashboard), vscode.workspace.onDidGrantWorkspaceTrust(() => {
        updateStatus();
        void scan().catch(showError);
    }), vscode.commands.registerCommand("tessera.openDashboard", () => vscode.commands.executeCommand(`${dashboard_1.dashboardId}.focus`)), vscode.commands.registerCommand("tessera.showOutput", () => log.show()), vscode.commands.registerCommand("tessera.openChat", () => vscode.commands.executeCommand("workbench.action.chat.open", { query: "@tessera ", isPartialQuery: true })), vscode.commands.registerCommand("tessera.addLocalModel", async () => {
        if (!vscode.workspace.isTrusted)
            return;
        const language = await vscode.window.showQuickPick([
            { label: "Python", setting: "pythonModelPath" },
            { label: "TypeScript", setting: "typescriptModelPath" },
        ], { placeHolder: "Choose a language for the local Qwen2.5-Coder model" });
        if (!language)
            return;
        const [file] = await vscode.window.showOpenDialog({
            canSelectMany: false, canSelectFolders: false, filters: { GGUF: ["gguf"] }, openLabel: "Use Model",
        }) ?? [];
        if (!file || file.scheme !== "file")
            return;
        try {
            const model = await vscode.workspace.fs.stat(file);
            if (!(model.type & vscode.FileType.File) || model.size === 0 || model.size >= 1_000_000_000 ||
                !file.fsPath.toLowerCase().endsWith(".gguf")) {
                throw new Error("Choose a nonempty local GGUF file smaller than 1 GB.");
            }
            await config().update(language.setting, file.fsPath, vscode.ConfigurationTarget.Global);
        }
        catch (error) {
            showError(error);
        }
    }), (0, chat_1.registerChat)(selectChat, log), (0, chat_1.registerPrompt)(selectChat, showError), { dispose: () => { void lifecycle.dispose(); } }, vscode.commands.registerCommand("tessera.triggerCompletion", () => vscode.commands.executeCommand("editor.action.inlineSuggest.trigger")), vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, provider), vscode.workspace.onDidChangeTextDocument(event => provider.cancel(event.document, true)), vscode.workspace.onDidCloseTextDocument(document => {
        provider.cancel(document);
        python.close(document.uri.toString());
    }), vscode.window.onDidChangeActiveTextEditor(() => {
        updateStatus();
        void scan().catch(error => log.appendLine(String(error)));
    }), vscode.window.onDidChangeWindowState(state => { if (state.focused)
        prewarm(); }), vscode.window.onDidChangeTextEditorSelection(updateStatus), vscode.workspace.onDidChangeConfiguration(event => {
        if (["memoryMiB", "maxModels", "idleMinutes", "serverPath", "gpuLayers", "pythonModelPath",
            "typescriptModelPath"].some(setting => event.affectsConfiguration(`tessera.${setting}`))) {
            refresh();
        }
        if (event.affectsConfiguration("tessera"))
            updateStatus();
    }), vscode.commands.registerCommand("tessera.acceptCompletion", (id) => metrics.accept(id)), vscode.commands.registerCommand("tessera.exportMetrics", async () => {
        const uri = await vscode.window.showSaveDialog({
            filters: { JSON: ["json"] }, saveLabel: "Export Tessera Metrics",
        });
        if (uri?.scheme !== "file")
            return;
        try {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(metrics.export(), null, 2) + "\n"));
        }
        catch (error) {
            showError(error);
        }
    }), vscode.commands.registerCommand("tessera.installModel", async () => {
        if (!vscode.workspace.isTrusted)
            return;
        const settings = config();
        const url = settings.get("registryUrl", "");
        const key = settings.get("registryPublicKey", "");
        if (!url || !key) {
            await vscode.commands.executeCommand("workbench.action.openSettings", "tessera.registry");
            return;
        }
        try {
            const index = await (0, download_1.fetchIndex)(url, key, AbortSignal.timeout(15_000));
            const entries = index.models.map(entry => ({
                label: entry.id, description: entry.version, detail: entry.language_ids.join(", "), entry,
            }));
            const choice = await vscode.window.showQuickPick(entries, { placeHolder: "Select a model version" });
            if (!choice)
                return;
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification, title: `Installing ${choice.label}`, cancellable: true,
            }, async (_progress, token) => {
                const controller = new AbortController();
                const cancellation = token.onCancellationRequested(() => controller.abort());
                try {
                    await store.install(choice.entry, AbortSignal.any([controller.signal, AbortSignal.timeout(900_000)]));
                    await loadInstalled();
                    prewarm();
                }
                catch (error) {
                    if (!controller.signal.aborted)
                        throw error;
                }
                finally {
                    cancellation.dispose();
                }
            });
        }
        catch (error) {
            showError(error);
        }
    }), vscode.commands.registerCommand("tessera.switchVersion", async () => {
        if (!vscode.workspace.isTrusted)
            return;
        try {
            const id = await vscode.window.showQuickPick(installedModels.map(model => model.manifest.id));
            if (!id)
                return;
            const version = await vscode.window.showQuickPick(await store.versions(id));
            if (!version)
                return;
            await store.activate(id, version);
            await loadInstalled();
            prewarm();
        }
        catch (error) {
            showError(error);
        }
    }), vscode.commands.registerCommand("tessera.pickModel", async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor)
            return;
        const options = [
            { label: "Automatic", id: "" },
            ...models().map(({ manifest }) => ({ label: manifest.id, id: manifest.id })),
        ];
        options.push({ label: "Install a model…", id: "@install" });
        const choice = await vscode.window.showQuickPick(options, { placeHolder: "Select a model" });
        if (!choice)
            return;
        if (choice.id === "@install") {
            await vscode.commands.executeCommand("tessera.installModel");
            return;
        }
        const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        const scope = folder ? await vscode.window.showQuickPick(["File", "Workspace"]) : "File";
        if (scope === "File") {
            if (choice.id)
                pins.set(editor.document.uri.toString(), choice.id);
            else
                pins.delete(editor.document.uri.toString());
        }
        else if (scope === "Workspace" && folder) {
            pins.delete(editor.document.uri.toString());
            await context.workspaceState.update(`model:${folder.uri.toString()}`, choice.id || undefined);
        }
        updateStatus();
        prewarm();
    }));
    void python.initialize().then(updateStatus).catch(error => log.appendLine(String(error)));
    void loadInstalled().then(scan).catch(error => log.appendLine(String(error)));
    return provider;
}
