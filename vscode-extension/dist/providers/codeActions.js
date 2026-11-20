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
exports.registerCodeActions = registerCodeActions;
const node_crypto_1 = require("node:crypto");
const vscode = __importStar(require("vscode"));
const chat_1 = require("./chat");
const actions = {
    explain: "Explain Code",
    refactor: "Refactor Code",
    writeTests: "Write Tests",
};
function unwrap(result) {
    const fenced = /^\s*```[^\n]*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(result);
    return fenced?.[1] ?? result;
}
function registerCodeActions(context, select, log) {
    const scheme = "tessera-preview";
    const previews = new Map();
    const preview = (content) => {
        const uri = vscode.Uri.from({ scheme, path: `/${(0, node_crypto_1.randomUUID)()}` });
        previews.set(uri.toString(), content);
        return uri;
    };
    const instructions = {
        explain: "Explain the selected source code clearly in Markdown.",
        refactor: "Refactor the selected source code and preserve its behavior and indentation. Return only replacement code.",
        writeTests: "Write tests for the selected source code. Return only the test source code.",
    };
    async function invoke(action) {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !vscode.workspace.isTrusted)
            return;
        const model = select(editor, action);
        if (!model) {
            void vscode.window.showInformationMessage("Select or install a model from the Tessera status bar.");
            return;
        }
        const { document, selection } = editor;
        const range = selection.isEmpty ? document.lineAt(selection.active.line).range : selection;
        const original = document.getText(range);
        if (!original.trim())
            return;
        const version = document.version;
        try {
            const completion = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification, cancellable: true, title: `Tessera: ${actions[action]}`,
            }, async (_progress, token) => {
                const cancellation = (0, chat_1.bindCancellation)(token);
                let response = "";
                try {
                    await model.use(async (host) => {
                        const messages = (0, chat_1.fitMessages)([
                            { role: "system", content: instructions[action] },
                            { role: "user", content: `Language: ${document.languageId}\n\n${original}` },
                        ], model.contextLength);
                        if (!messages.some(message => message.role === "system")) {
                            throw new Error("The selection exceeds the model context window");
                        }
                        for await (const chunk of host.chat(messages, cancellation.signal))
                            response += chunk;
                    });
                    return cancellation.signal.aborted ? undefined : response;
                }
                catch (error) {
                    if (!cancellation.signal.aborted)
                        throw error;
                }
                finally {
                    cancellation.dispose();
                }
            });
            if (!completion?.trim())
                return;
            if (action === "explain") {
                await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({
                    language: "markdown", content: completion,
                }), { preview: true });
                return;
            }
            const updated = unwrap(completion);
            const suffix = action === "refactor" && original.endsWith("\n") && !updated.endsWith("\n") ? "\n" : "";
            const replacement = updated + suffix;
            const originalText = document.getText();
            const before = action === "refactor" ? originalText : "";
            const after = action === "refactor"
                ? originalText.slice(0, document.offsetAt(range.start)) + replacement + originalText.slice(document.offsetAt(range.end))
                : replacement;
            await vscode.commands.executeCommand("vscode.diff", preview(before), preview(after), `Tessera: ${actions[action]}`, { preview: true });
            if (await vscode.window.showInformationMessage(`Apply Tessera ${action === "refactor" ? "edit" : "tests"}?`, "Apply") !== "Apply")
                return;
            if (document.isClosed || document.version !== version) {
                void vscode.window.showWarningMessage("The source changed while the preview was open. Run the command again.");
                return;
            }
            if (action === "writeTests") {
                await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({
                    language: document.languageId, content: after,
                }));
            }
            else {
                const edit = new vscode.WorkspaceEdit();
                edit.replace(document.uri, range, replacement);
                if (!await vscode.workspace.applyEdit(edit))
                    throw new Error("VS Code could not apply the edit");
            }
        }
        catch (error) {
            log.appendLine(String(error));
            void vscode.window.showErrorMessage(`Tessera: ${String(error)}`);
        }
    }
    const commands = Object.keys(actions);
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(scheme, {
        provideTextDocumentContent: uri => previews.get(uri.toString()) ?? "",
    }), vscode.workspace.onDidCloseTextDocument(document => {
        if (document.uri.scheme === scheme)
            previews.delete(document.uri.toString());
    }), vscode.languages.registerCodeActionsProvider({ scheme: "file" }, {
        provideCodeActions: (_document, range) => range.isEmpty ? [] : commands.map(action => ({
            title: `Tessera: ${actions[action]}`, command: `tessera.${action}`,
        })),
    }), ...commands.map(action => vscode.commands.registerCommand(`tessera.${action}`, () => invoke(action))));
}
