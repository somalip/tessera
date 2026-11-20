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
const node_crypto_1 = require("node:crypto");
const promises_1 = require("node:fs/promises");
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
const catalog_1 = require("./registry/catalog");
const huggingFace_1 = require("./registry/huggingFace");
const download_1 = require("./registry/download");
const detector_1 = require("./router/detector");
const lifecycle_1 = require("./router/lifecycle");
const policy_1 = require("./router/policy");
const pythonRegions_1 = require("./router/pythonRegions");
const workflow_1 = require("./router/workflow");
const telemetry_1 = require("./telemetry");
const dashboard_1 = require("./views/dashboard");
const dashboardHtml_1 = require("./views/dashboardHtml");
const workflow_2 = require("./views/workflow");
const linkedModelsKey = "linkedModels";
function activate(context) {
    const metrics = new telemetry_1.LocalMetrics(() => dashboard.refresh());
    const log = vscode.window.createOutputChannel("Tessera");
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 25);
    const config = () => vscode.workspace.getConfiguration("tessera");
    const repository = new workspace_1.WorkspaceContext();
    const python = new pythonRegions_1.PythonRegions();
    const pins = new Map();
    const inlineRoutes = new Map();
    const store = new download_1.ModelStore((0, node_path_1.join)(context.globalStorageUri.fsPath, "models"));
    let localModels = [];
    let linkedModels = [];
    const linked = () => context.globalState.get(linkedModelsKey, []);
    const workflows = () => context.workspaceState.get(workflow_1.workflowKey, {});
    const workflowFor = (document) => (0, workflow_1.workflowForLanguage)(workflows(), document.languageId);
    let installedModels = [];
    const models = () => [
        ...localModels.filter(model => model.manifest.capabilities.length === 1),
        ...localModels.filter(model => model.manifest.id === "cpp-local"),
        ...installedModels,
        ...localModels.filter(model => model.manifest.capabilities.length > 1 && model.manifest.id !== "cpp-local"),
        ...linkedModels,
    ];
    let lifecycle;
    let projectFiles = new Set();
    let projectFolder;
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
    ];
    const refresh = () => {
        const stopped = lifecycle?.dispose();
        const settings = config();
        const budget = settings.get("memoryMiB", 0) * 1024 ** 2;
        lifecycle = new lifecycle_1.Lifecycle(budget || (0, node_os_1.freemem)() * 0.6, settings.get("maxModels", 2), settings.get("idleMinutes", 5) * 60_000, stopped, budget === 0);
        localModels = [];
        for (const [id, setting, languages, globs, inlineOnly] of localRoles) {
            const path = settings.get(setting);
            if (!path)
                continue;
            try {
                const file = (0, node_fs_1.statSync)(path);
                if (!file.isFile() || file.size === 0 || file.size >= 1_000_000_000)
                    throw new Error("Invalid GGUF file size");
                const contextLength = inlineOnly ? 768 : ["python-local", "cpp-local"].includes(id) ? 4096 : 2048;
                localModels.push({
                    path, memoryBytes: (0, memory_1.modelMemoryBytes)(file.size, contextLength),
                    manifest: {
                        schema_version: 1, id, version: "0.0.0",
                        language_ids: languages, vscode_language_ids: languages, file_globs: globs,
                        base_model: id === "documentation-autocomplete-local" ? "qwen3.5" : "qwen2.5-coder",
                        params: id === "documentation-autocomplete-local" ? 800_000_000 : 500_000_000,
                        quant: "local", size_bytes: file.size, context_length: contextLength,
                        capabilities: inlineOnly ? ["fim"] : ["fim", "chat", "edit"], min_runtime: { llama_cpp_build: "local" },
                        prompt_formats: { fim: builder_1.qwenFim, chat_template: "chatml" }, sha256: "0".repeat(64),
                    },
                });
            }
            catch (error) {
                log.appendLine(String(error));
            }
        }
        linkedModels = linked().flatMap(({ id, path, capabilities }) => {
            try {
                const file = (0, node_fs_1.statSync)(path);
                if (!file.isFile() || file.size === 0 || file.size >= 1_000_000_000)
                    return [];
                const contextLength = capabilities.includes("chat") ? 4096 : 2048;
                return [{
                        path, memoryBytes: (0, memory_1.modelMemoryBytes)(file.size, contextLength),
                        manifest: {
                            schema_version: 1, id, version: "0.0.0", language_ids: [], vscode_language_ids: [], file_globs: [],
                            base_model: "qwen2.5-coder", params: 500_000_000, quant: "local", size_bytes: file.size,
                            context_length: contextLength, capabilities, min_runtime: { llama_cpp_build: "local" },
                            prompt_formats: { fim: builder_1.qwenFim, chat_template: "chatml" }, sha256: "0".repeat(64),
                        },
                    }];
            }
            catch (error) {
                log.appendLine(String(error));
                return [];
            }
        });
        return stopped;
    };
    const candidate = (document, position, capability = "fim") => {
        if (!vscode.workspace.isTrusted)
            return;
        const workflow = workflowFor(document);
        if (workflow)
            return (0, workflow_1.byCapability)(models(), capability === "fim" ? workflow.autocomplete : workflow.generator, capability);
        const folder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString();
        const docsKey = document.uri.toString();
        const language = document.languageId;
        let embedded;
        if (["python", "markdown", "mdx", "html"].includes(language)) {
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
            installed: model,
            contextLength: model.manifest.context_length,
            tokens: model.manifest.prompt_formats.fim,
            short: model.manifest.capabilities.length === 1 && model.manifest.id.endsWith("-autocomplete-local"),
            documentation: model.manifest.id === "documentation-autocomplete-local",
            python: model.manifest.id === "python-autocomplete-local",
            use(operation) {
                const settings = config();
                return active.use(model.path, model.memoryBytes, paged => new llamaServer_1.LlamaServer(settings.get("serverPath", "llama-server"), model.path, model.manifest.context_length, settings.get("gpuLayers", 0), model.manifest.min_runtime.llama_cpp_build, paged, settings.get("cpuThreads", 0), usage => metrics.recordInference(model.manifest.id, usage)), operation);
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
    const provider = new inlineCompletion_1.InlineCompletion((document, position, role) => {
        if (!vscode.workspace.isTrusted)
            return;
        const workflow = workflowFor(document);
        if (workflow) {
            const model = role === "comment-parser" ? (0, workflow_1.byCapability)(models(), workflow.parser, "fim")
                : role === "router" ? (0, workflow_1.byCapability)(models(), workflow.router, "chat")
                    : candidate(document, position, role ? "chat" : "fim");
            return model && endpoint(model);
        }
        const localId = role === "comment-parser" ? "parsing-autocomplete-local"
            : role === "python-comment" ? "python-local" : undefined;
        const model = localModels.find(entry => entry.manifest.id === localId) ?? (role !== "comment-parser"
            ? candidate(document, position, role ? "chat" : "fim") : undefined);
        return model && endpoint(model);
    }, log, metrics, completionSettings, (document, position) => config().get("repositoryContext", true)
        ? repository.retrieve(document, position) : Promise.resolve([]), (document, route) => {
        const key = document.uri.toString();
        const previous = inlineRoutes.get(key);
        if (previous?.mode === route.mode && previous.model === route.model && previous.parser === route.parser)
            return;
        inlineRoutes.set(key, route);
        log.appendLine(`${route.mode} → ${route.model?.path ?? (0, dashboardHtml_1.inlineRouteName)(route)}`);
        if (vscode.window.activeTextEditor?.document === document)
            updateStatus();
    }, (code, newFile) => python.projectProblem(code, newFile), workflowFor);
    const chatModel = (editor, capability) => {
        const model = candidate(editor.document, editor.selection.active, capability);
        return model && endpoint(model);
    };
    const selectChat = () => {
        if (!vscode.workspace.isTrusted)
            return;
        const editor = vscode.window.activeTextEditor;
        const routed = editor && chatModel(editor, "chat");
        if (routed || (editor && workflowFor(editor.document)))
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
            advanced: context.globalState.get("advancedDashboard", false),
            language: editor?.document.languageId,
            active: editor && (candidate(editor.document, editor.selection.active) ??
                candidate(editor.document, editor.selection.active, "chat")),
            lastInline: editor && inlineRoutes.get(editor.document.uri.toString()),
            models: models(),
            usage: metrics.usage(),
        };
    }, showError, advanced => context.globalState.update("advancedDashboard", advanced));
    const saveWorkflow = async (input, value) => {
        if (!vscode.workspace.isTrusted)
            throw new Error("Trust this workspace to save a Tessera workflow.");
        const language = (0, workflow_1.workflowLanguage)(input);
        if (!language)
            throw new Error("Enter a language ID such as cpp or python, or use * for the default workflow.");
        const routes = { ...workflows() };
        if (value === undefined)
            delete routes[language];
        else
            routes[language] = (0, workflow_1.validateWorkflow)(value, models());
        await context.workspaceState.update(workflow_1.workflowKey, routes);
        inlineRoutes.clear();
        for (const document of vscode.workspace.textDocuments)
            provider.cancel(document);
        updateStatus();
        prewarm();
    };
    const panel = new workflow_2.WorkflowPanel(models, workflows, async (language, value) => { await vscode.commands.executeCommand("tessera.saveWorkflow", language, value); });
    const updateStatus = () => {
        const editor = vscode.window.activeTextEditor;
        const lastInline = editor && vscode.workspace.isTrusted && inlineRoutes.get(editor.document.uri.toString());
        const model = lastInline ? lastInline.model : editor && candidate(editor.document, editor.selection.active);
        status.text = `$(chip) ${lastInline ? (0, dashboardHtml_1.inlineRouteName)(lastInline) : model?.manifest.id ?? "Tessera"}`;
        status.tooltip = lastInline
            ? [`Last inline request · ${lastInline.mode}`, model?.manifest.id, model?.path,
                lastInline.parser && `Parsed by ${lastInline.parser.path}`].filter(Boolean).join("\n")
            : "Open the Tessera sidebar";
        dashboard.refresh();
        panel.refresh(editor?.document.languageId);
    };
    const prewarm = () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor)
            return;
        const { automatic, comments } = completionSettings(editor.document);
        if (!automatic && !comments)
            return;
        const model = candidate(editor.document, editor.selection.active);
        if (!model)
            return;
        const route = endpoint(model);
        if (automatic || route.short) {
            void route.use(async () => undefined).catch(error => log.appendLine(String(error)));
        }
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
    let modelOperation = false;
    const manage = (operation) => async (argument) => {
        if (!vscode.workspace.isTrusted)
            return;
        if (modelOperation) {
            void vscode.window.showInformationMessage("Finish the current Tessera model operation first.");
            return;
        }
        modelOperation = true;
        try {
            await operation(argument);
        }
        catch (error) {
            showError(error);
        }
        finally {
            modelOperation = false;
        }
    };
    const installEntries = async (selected) => {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification, title: "Installing Tessera models", cancellable: true,
        }, async (progress, token) => {
            const controller = new AbortController();
            const cancellation = token.onCancellationRequested(() => controller.abort());
            if (token.isCancellationRequested)
                controller.abort();
            try {
                for (const entry of selected) {
                    const label = entry.label ?? entry.id;
                    if (controller.signal.aborted)
                        break;
                    let reported = 0;
                    progress.report({ message: `Downloading ${label}…` });
                    await store.install(entry, AbortSignal.any([controller.signal, AbortSignal.timeout(900_000)]), { upstreamManifest: entry.upstreamManifest, progress: bytes => {
                            const percent = Math.floor(100 * bytes / entry.size_bytes);
                            if (percent === reported)
                                return;
                            progress.report({ increment: (percent - reported) / selected.length,
                                message: percent === 100 ? `Verifying ${label}…` : `${label} · ${percent}% downloaded` });
                            reported = percent;
                        } });
                    inlineRoutes.clear();
                    await loadInstalled();
                    prewarm();
                }
                if (!controller.signal.aborted) {
                    void vscode.window.showInformationMessage(`Installed ${selected.length} Tessera model(s).`);
                }
            }
            catch (error) {
                if (!controller.signal.aborted)
                    throw error;
            }
            finally {
                cancellation.dispose();
            }
        });
    };
    const chooseStoredModel = async (includeLocal) => {
        const inventory = [...(includeLocal ? [...localModels, ...linkedModels] : []), ...await store.inventory()];
        if (!inventory.length) {
            void vscode.window.showInformationMessage("Tessera has no models to manage.");
            return;
        }
        const choice = await vscode.window.showQuickPick(inventory.map(model => ({
            label: model.manifest.quant === "local" ? (0, node_path_1.basename)(model.path) : model.manifest.id,
            description: model.manifest.quant === "local" ? "Linked GGUF"
                : model.manifest.version + (installedModels.some(active => active.path === model.path) ? " · Active version" : ""),
            detail: `${Math.ceil(model.manifest.size_bytes / 1_000_000)} MB · ${model.manifest.capabilities.join(", ")}`,
            model,
        })), { placeHolder: "Select a model or installed version" });
        return choice?.model;
    };
    const activateVersion = async ({ manifest }) => {
        await store.activate(manifest.id, manifest.version);
        inlineRoutes.clear();
        await loadInstalled();
        prewarm();
    };
    refresh();
    status.command = "tessera.openDashboard";
    status.show();
    updateStatus();
    context.subscriptions.push(log, provider, status, repository, python, dashboard, panel, vscode.window.registerWebviewViewProvider(dashboard_1.dashboardId, dashboard), vscode.workspace.onDidGrantWorkspaceTrust(() => {
        updateStatus();
        void scan().catch(showError);
    }), vscode.commands.registerCommand("tessera.openDashboard", () => vscode.commands.executeCommand(`${dashboard_1.dashboardId}.focus`)), vscode.commands.registerCommand("tessera.openWorkflow", () => panel.open()), vscode.commands.registerCommand("tessera.saveWorkflow", saveWorkflow), vscode.commands.registerCommand("tessera.importModels", manage(async () => {
        const files = await vscode.window.showOpenDialog({
            canSelectMany: true, filters: { GGUF: ["gguf"] }, openLabel: "Add to Model Library",
        });
        if (!files?.length)
            return;
        const existing = linked();
        const candidates = files.filter(file => file.scheme === "file" && !models().some(model => model.path === file.fsPath));
        if (!candidates.length) {
            void vscode.window.showInformationMessage("The selected files are already in the Tessera library.");
            return;
        }
        const role = await vscode.window.showQuickPick([
            { label: "Autocomplete or parser", capabilities: ["fim"] },
            { label: "Generation, chat, and edits", capabilities: ["chat", "edit"] },
            { label: "Autocomplete and generation", capabilities: ["fim", "chat", "edit"] },
        ], { placeHolder: "Choose the supported capabilities of these Qwen-compatible GGUFs" });
        if (!role)
            return;
        const imports = await Promise.all(candidates.map(async (file) => {
            const handle = await (0, promises_1.open)(file.fsPath);
            try {
                const metadata = await handle.stat();
                const header = Buffer.alloc(4);
                await handle.read(header, 0, 4, 0);
                if (!metadata.isFile() || metadata.size >= 1_000_000_000 || header.toString() !== "GGUF") {
                    throw new Error(`${(0, node_path_1.basename)(file.fsPath)} must be a GGUF file smaller than 1 GB.`);
                }
                const id = "linked-" + (0, node_crypto_1.createHash)("sha256").update(file.fsPath).digest("hex").slice(0, 24);
                return { id, path: file.fsPath, capabilities: role.capabilities };
            }
            finally {
                await handle.close();
            }
        }));
        await context.globalState.update(linkedModelsKey, [...existing, ...imports]);
        refresh();
        updateStatus();
        prewarm();
    })), vscode.commands.registerCommand("tessera.showOutput", () => log.show()), vscode.commands.registerCommand("tessera.openChat", () => vscode.commands.executeCommand("workbench.action.chat.open", { query: "@tessera ", isPartialQuery: true })), vscode.commands.registerCommand("tessera.addLocalModel", manage(async () => {
        const language = await vscode.window.showQuickPick([
            { label: "Python (fast autocomplete)", setting: "pythonAutocompleteModelPath" },
            { label: "Structured data and SQL (autocomplete)", setting: "parsingAutocompleteModelPath" },
            { label: "Documentation (autocomplete)", setting: "documentationAutocompleteModelPath" },
            { label: "Python", setting: "pythonModelPath" },
            { label: "C++ (fast autocomplete)", setting: "cppAutocompleteModelPath" },
            { label: "C++", setting: "cppModelPath" },
            { label: "TypeScript", setting: "typescriptModelPath" },
        ], { placeHolder: "Choose a role for the local model" });
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
    })), (0, chat_1.registerChat)(selectChat, log), (0, chat_1.registerPrompt)(async () => {
        if (!vscode.workspace.isTrusted)
            return;
        const preferred = selectChat();
        if (preferred)
            return preferred;
        const editor = vscode.window.activeTextEditor;
        if (editor && workflowFor(editor.document)) {
            void vscode.window.showInformationMessage("Connect an available generator in the Tessera workflow.");
            return;
        }
        const choices = models().filter(model => model.manifest.capabilities.includes("chat"));
        if (!choices.length) {
            void vscode.window.showInformationMessage("Download or link a Tessera chat model from the sidebar.");
            return;
        }
        const choice = await vscode.window.showQuickPick(choices.map(model => ({
            label: model.manifest.id, description: model.manifest.language_ids.join(", "), model,
        })), { placeHolder: "Choose a model for this prompt" });
        return choice && endpoint(choice.model);
    }, showError), { dispose: () => { void lifecycle.dispose(); } }, vscode.commands.registerCommand("tessera.triggerCompletion", () => vscode.commands.executeCommand("editor.action.inlineSuggest.trigger")), vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, provider), vscode.workspace.onDidChangeTextDocument(event => provider.cancel(event.document)), vscode.workspace.onDidCloseTextDocument(document => {
        provider.cancel(document);
        inlineRoutes.delete(document.uri.toString());
        python.close(document.uri.toString());
    }), vscode.window.onDidChangeActiveTextEditor(() => {
        updateStatus();
        void scan().catch(error => log.appendLine(String(error)));
    }), vscode.window.onDidChangeWindowState(state => { if (state.focused)
        prewarm(); }), vscode.window.onDidChangeTextEditorSelection(updateStatus), vscode.workspace.onDidChangeConfiguration(event => {
        if (["memoryMiB", "maxModels", "idleMinutes", "serverPath", "gpuLayers", "cpuThreads", "pythonModelPath",
            "pythonAutocompleteModelPath", "parsingAutocompleteModelPath",
            "documentationAutocompleteModelPath", "cppAutocompleteModelPath", "cppModelPath",
            "typescriptModelPath"].some(setting => event.affectsConfiguration(`tessera.${setting}`))) {
            inlineRoutes.clear();
            refresh();
            prewarm();
        }
        if (event.affectsConfiguration("tessera"))
            updateStatus();
    }), vscode.commands.registerCommand("tessera.resourceLimits", async () => {
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
    }), vscode.commands.registerCommand("tessera.browseModels", manage(async (input) => {
        const query = (typeof input === "string" ? input : await vscode.window.showInputBox({
            title: "Find Hugging Face GGUF Models", prompt: "Search by name, paste publisher/model, or paste a Hugging Face URL",
        }))?.trim();
        if (!query)
            return;
        if (query.length > 300)
            throw new Error("Use a shorter search or repository URL.");
        const lookup = (title, operation) => vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification, title,
        }, operation);
        const source = (0, huggingFace_1.repositoryFromInput)(query);
        let repo = source?.repository;
        if (!repo) {
            const matches = await lookup("Searching Hugging Face GGUF repositories", () => (0, huggingFace_1.searchRepositories)(query));
            if (!matches.length)
                throw new Error("No public GGUF repositories matched. Try another search or paste a repository URL.");
            repo = await vscode.window.showQuickPick(matches, { placeHolder: "Choose a model repository" });
            if (!repo)
                return;
        }
        const repository = repo;
        const listed = await lookup(`Checking ${repository}`, () => (0, huggingFace_1.repositoryFiles)(repository, source?.revision));
        const files = source?.file ? listed.filter(file => file.name === source.file) : listed;
        if (!files.length)
            throw new Error("No single-file GGUF under 1 GB with a published SHA-256 is available in this repository.");
        const inventory = await store.inventory();
        const choices = files.map(file => ({
            label: file.name, description: `${Math.ceil(file.entry.size_bytes / 1_000_000)} MB · ${file.license}`,
            detail: [file.architecture, file.entry.upstreamManifest?.capabilities.includes("fim")
                    ? "Qwen FIM autocomplete / parser" : "Text generation / chat",
                inventory.some(({ manifest }) => manifest.id === file.entry.id) ? "Installed" : undefined].filter(Boolean).join(" · "),
            entry: file.entry,
        }));
        const selected = await vscode.window.showQuickPick(choices, {
            title: repository, placeHolder: "Select GGUF variants to download", canPickMany: true, matchOnDescription: true,
        });
        if (!selected?.length)
            return;
        const entries = selected.map(choice => choice.entry)
            .filter(entry => !inventory.some(({ manifest }) => manifest.id === entry.id));
        if (!entries.length) {
            void vscode.window.showInformationMessage("These GGUF variants are already in your model library.");
            return;
        }
        await installEntries(entries);
    })), vscode.commands.registerCommand("tessera.testModel", manage(async (id) => {
        const model = models().find(item => item.manifest.id === id);
        if (!model)
            throw new Error("Choose an installed model to test.");
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification, title: `Testing ${model.manifest.base_model}`,
        }, async () => {
            await endpoint(model).use(async (host) => {
                const signal = AbortSignal.timeout(15_000);
                if (model.manifest.capabilities.includes("chat")) {
                    for await (const chunk of host.chat([{ role: "user", content: "Reply with OK." }], signal)) {
                        if (chunk.trim())
                            return;
                    }
                }
                else {
                    const fim = model.manifest.prompt_formats.fim;
                    const output = await host.complete(`${fim.prefix}answer = ${fim.suffix}\n${fim.middle}`, Object.values(fim), signal, undefined, 8);
                    if (output.trim())
                        return;
                }
                throw new Error("The model loaded but returned no text in the inference test.");
            });
        });
        void vscode.window.showInformationMessage(`${model.manifest.base_model} loaded and generated text locally.`);
    })), vscode.commands.registerCommand("tessera.installModel", manage(async (requested) => {
        const settings = config();
        const url = settings.get("registryUrl", "");
        const key = settings.get("registryPublicKey", "");
        const direct = catalog_1.builtInModels.find(model => model.id === requested);
        const recommended = Array.isArray(requested) && requested.every(id => catalog_1.builtInModels.some(model => model.id === id))
            ? catalog_1.builtInModels.filter(model => requested.includes(model.id)) : undefined;
        const source = direct || recommended || requested === "@all" ? { builtIn: true } : requested === "@registry" ? { builtIn: false } : await vscode.window.showQuickPick([
            { label: "Tessera catalog", description: "Recommended local models for coding and chat", builtIn: true },
            { label: "Signed registry", description: url || "Configure an HTTPS registry", builtIn: false },
        ], { placeHolder: "Choose a model catalog" });
        if (!source)
            return;
        if (!source.builtIn && (!url || !key)) {
            await vscode.commands.executeCommand("workbench.action.openSettings", "tessera.registry");
            return;
        }
        const catalog = recommended ?? (direct ? [direct] : source.builtIn ? catalog_1.builtInModels
            : (await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification, title: "Loading Tessera registry",
            }, () => (0, download_1.fetchIndex)(url, key, AbortSignal.timeout(15_000)))).models);
        const inventory = await store.inventory();
        if (recommended) {
            for (const entry of recommended) {
                if (installedModels.some(model => model.manifest.id === entry.id))
                    continue;
                if (inventory.some(({ manifest }) => manifest.id === entry.id && manifest.version === entry.version)) {
                    await store.activate(entry.id, entry.version);
                }
            }
            await loadInstalled();
        }
        const available = catalog.filter(entry => !inventory.some(({ manifest }) => manifest.id === entry.id && manifest.version === entry.version));
        if (!available.length) {
            if (recommended)
                return;
            void vscode.window.showInformationMessage("No new model versions are available from this catalog.");
            return;
        }
        const choices = available.map(entry => ({
            label: entry.label ?? entry.id, description: `${entry.version} · ${Math.ceil(entry.size_bytes / 1_000_000)} MB`,
            detail: entry.upstreamManifest?.capabilities.join(", ") ?? entry.language_ids.join(", "), entry,
        }));
        const selected = direct || recommended || requested === "@all" ? choices : await vscode.window.showQuickPick(choices, {
            placeHolder: "Choose models to download and install", canPickMany: true,
        });
        if (!selected?.length)
            return;
        await installEntries(selected.map(choice => choice.entry));
    })), vscode.commands.registerCommand("tessera.switchVersion", manage(async () => {
        const model = await chooseStoredModel(false);
        if (model)
            await activateVersion(model);
    })), vscode.commands.registerCommand("tessera.manageModels", manage(async () => {
        const model = await chooseStoredModel(true);
        if (!model)
            return;
        const { manifest } = model;
        const role = localRoles.find(([id]) => id === manifest.id && localModels.includes(model));
        const libraryModel = linkedModels.includes(model);
        const action = await vscode.window.showQuickPick(role || libraryModel
            ? ["Unlink local GGUF"]
            : ["Activate this version", "Remove this version"], { placeHolder: `Manage ${manifest.id}` });
        if (action === "Activate this version")
            await activateVersion(model);
        if (action === "Unlink local GGUF") {
            if (libraryModel)
                await context.globalState.update(linkedModelsKey, linked().filter(item => item.id !== manifest.id));
            else if (role && config().get(role[1]) === model.path) {
                await config().update(role[1], undefined, vscode.ConfigurationTarget.Global);
            }
            else
                return;
            inlineRoutes.clear();
            refresh();
            updateStatus();
            prewarm();
        }
        if (action === "Remove this version") {
            const confirmed = await vscode.window.showWarningMessage(`Remove ${manifest.id} ${manifest.version} from Tessera storage?`, { modal: true }, "Remove");
            if (confirmed !== "Remove")
                return;
            // Stop the current server before removing weights, including on Windows.
            installedModels = installedModels.filter(active => active.path !== model.path);
            inlineRoutes.clear();
            updateStatus();
            const stopped = refresh();
            try {
                await stopped;
                await store.remove(manifest.id, manifest.version);
            }
            finally {
                await loadInstalled();
                prewarm();
            }
        }
    })), vscode.commands.registerCommand("tessera.pickModel", async () => {
        if (!vscode.workspace.isTrusted)
            return;
        const editor = vscode.window.activeTextEditor;
        if (!editor)
            return;
        if (workflowFor(editor.document)) {
            panel.open();
            return;
        }
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
        inlineRoutes.delete(editor.document.uri.toString());
        updateStatus();
        prewarm();
    }));
    void python.initialize().then(updateStatus).catch(error => log.appendLine(String(error)));
    void loadInstalled().then(scan).catch(error => log.appendLine(String(error)));
    return provider;
}
