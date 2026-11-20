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
exports.bindCancellation = bindCancellation;
exports.registerPrompt = registerPrompt;
exports.registerChat = registerChat;
exports.fitMessages = fitMessages;
const vscode = __importStar(require("vscode"));
function bindCancellation(token) {
    const controller = new AbortController();
    if (token.isCancellationRequested)
        controller.abort();
    const subscription = token.onCancellationRequested(() => controller.abort());
    return { signal: controller.signal, dispose: () => subscription.dispose() };
}
async function respond(model, messages, signal, write) {
    signal.throwIfAborted();
    await model.use(async (host) => {
        signal.throwIfAborted();
        for await (const chunk of host.chat(fitMessages(messages, model.contextLength), signal))
            write(chunk);
    });
}
function editorContext() {
    const editor = vscode.window.activeTextEditor;
    const selected = editor?.document.getText(editor.selection).slice(0, 400) ?? "";
    return {
        role: "system",
        content: "You are the Tessera coding assistant. Give concise answers. " +
            (selected ? `Current ${editor?.document.languageId} selection:\n${selected}` : ""),
    };
}
function registerPrompt(select, showError) {
    return vscode.commands.registerCommand("tessera.ask", async () => {
        const model = select();
        if (!model) {
            await vscode.window.showInformationMessage("Open a supported file or install a Tessera chat model.");
            return;
        }
        const system = editorContext();
        const prompt = (await vscode.window.showInputBox({ title: "Ask Tessera", prompt: "Enter a local coding prompt" }))?.trim();
        if (!prompt)
            return;
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification, title: "Tessera is responding", cancellable: true,
        }, async (_progress, token) => {
            const cancellation = bindCancellation(token);
            try {
                let answer = "";
                await respond(model, [system, { role: "user", content: prompt }], cancellation.signal, chunk => { answer += chunk; });
                if (cancellation.signal.aborted)
                    return;
                if (!answer.trim())
                    throw new Error("The local model returned an empty response.");
                const document = await vscode.workspace.openTextDocument({ language: "markdown", content: answer });
                await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside });
            }
            catch (error) {
                if (!cancellation.signal.aborted)
                    showError(error);
            }
            finally {
                cancellation.dispose();
            }
        });
    });
}
function registerChat(select, log) {
    return vscode.chat.createChatParticipant("tessera.local", async (request, context, stream, token) => {
        const model = select();
        if (!model) {
            stream.markdown("Select or install a Tessera chat model from the status bar.");
            return;
        }
        const cancellation = bindCancellation(token);
        const history = [];
        for (const turn of context.history.slice(-4)) {
            if (turn instanceof vscode.ChatRequestTurn) {
                history.push({ role: "user", content: turn.prompt });
            }
            else if (turn instanceof vscode.ChatResponseTurn) {
                const content = turn.response.filter(part => part instanceof vscode.ChatResponseMarkdownPart)
                    .map(part => part.value.value).join("");
                if (content)
                    history.push({ role: "assistant", content });
            }
        }
        try {
            await respond(model, [editorContext(), ...history, { role: "user", content: request.prompt }], cancellation.signal, chunk => { stream.markdown(new vscode.MarkdownString(chunk)); });
        }
        catch (error) {
            if (!cancellation.signal.aborted) {
                log.appendLine(String(error));
                stream.markdown("Tessera could not complete the local inference request.");
            }
        }
        finally {
            cancellation.dispose();
        }
    });
}
function fitMessages(messages, contextLength) {
    let bytes = Math.max(0, contextLength - Math.min(512, Math.floor(contextLength / 4)));
    const retained = [];
    for (const message of [...messages].reverse()) {
        if (bytes <= 24)
            break;
        const buffer = Buffer.from(message.content);
        let end = Math.min(buffer.length, bytes - 24);
        while (end > 0 && end < buffer.length && (buffer[end] & 0xC0) === 0x80)
            end -= 1;
        retained.unshift({ role: message.role, content: buffer.subarray(0, end).toString() });
        bytes -= 24 + end;
    }
    return retained;
}
