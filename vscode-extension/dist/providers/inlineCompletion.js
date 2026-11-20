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
exports.InlineCompletion = void 0;
const promises_1 = require("node:timers/promises");
const vscode = __importStar(require("vscode"));
const builder_1 = require("../context/builder");
const { streamCommentSuggestion } = require("./commentPreview");
function isCommentTrigger(document, position) {
    if (!position.line || document.lineAt(position.line).text.trim())
        return false;
    const previous = document.lineAt(position.line - 1).text;
    switch (document.languageId) {
        case "python":
        case "ruby":
        case "shellscript":
        case "yaml":
            return /^\s*#\s*\S/.test(previous);
        case "sql":
            return /^\s*--\s*\S/.test(previous);
        case "css":
            return /^\s*\/\*\s*\S.*\*\/\s*$/.test(previous);
        case "html":
        case "markdown":
            return /^\s*<!--\s*\S.*-->\s*$/.test(previous);
        default:
            return /^\s*\/\/\s*\S/.test(previous);
    }
}
function startsBlock(document, position) {
    const line = document.lineAt(position.line).text;
    const before = line.slice(0, position.character);
    const after = line.slice(position.character);
    if (document.languageId === "python")
        return !after && /^\s*(?:async\s+)?(?:def|class|if|elif|else|for|while|try|except|finally|with|match|case)\b.*:\s*$/.test(line);
    return ["javascript", "javascriptreact", "typescript", "typescriptreact"].includes(document.languageId) &&
        (!after || /^\s*}\s*$/.test(after)) &&
        !/^\s*(?:\/\/|\/\*|\*)/.test(before) && /\{\s*$/.test(before);
}

function blockText(document, position, text, originalLine) {
    if (!text.trim())
        return "";
    const newline = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    const normalized = (/^\r?\n/.test(text) ? "" : newline) + text.replace(/\r?\n/g, newline);
    if (originalLine === undefined || position.character === originalLine.length)
        return normalized;
    const indent = originalLine.match(/^\s*/)[0];
    return normalized.trimEnd() + newline + indent;
}

class InlineCompletion {
    select;
    log;
    metrics;
    settings;
    retrieve;
    pending = new Map();
    commentPreview;
    constructor(select, log, metrics, settings, retrieve) {
        this.select = select;
        this.log = log;
        this.metrics = metrics;
        this.settings = settings;
        this.retrieve = retrieve;
    }
    async provideInlineCompletionItems(document, position, context, token) {
        const key = document.uri.toString();
        if (token.isCancellationRequested)
            return [];
        if (this.commentPreview?.document === document && this.commentPreview.accepting)
            return [];
        if (this.commentPreview?.matches(document, position))
            return this.commentPreview.suggestions();
        this.cancel(document);
        const { automatic, comments } = this.settings(document);
        if (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic &&
            !automatic && !(comments && isCommentTrigger(document, position)))
            return [];
        const model = this.select(document, position);
        if (!model || token.isCancellationRequested)
            return [];
        const controller = new AbortController();
        const { signal } = controller;
        this.pending.set(key, controller);
        const cancellation = token.onCancellationRequested(() => controller.abort());
        const version = document.version;
        const block = startsBlock(document, position);
        const originalLine = document.lineAt(position.line).text;
        const generate = async (signal, update) => {
            try {
                const snippets = this.retrieve?.(document, position).catch(() => []);
                await (0, promises_1.setTimeout)(180, undefined, { signal });
                const context = snippets ? await Promise.race([snippets, (0, promises_1.setTimeout)(25, [])]) : [];
                const lineComment = ["python", "ruby", "shellscript", "yaml"].includes(document.languageId) ? "#" : "//";
                const prompt = (0, builder_1.buildFim)(document.getText(), document.offsetAt(position), model.contextLength, model.tokens, context, lineComment);
                const requested = performance.now();
                let firstToken;
                const result = await model.use(async (host) => {
                    signal.throwIfAborted();
                    const started = performance.now();
                    return host.complete(prompt, [...Object.values(model.tokens), "<|endoftext|>"], signal, () => { firstToken ??= performance.now() - started; }, update && (text => update(block ? blockText(document, position, text) : text)));
                });
                if (signal.aborted || (!update && document.version !== version) || !result?.trim())
                    return [];
                const item = new vscode.InlineCompletionItem(block ? blockText(document, position, result, originalLine) : result, new vscode.Range(position, position));
                item.command = {
                    title: "Record accepted Tessera suggestion", command: "tessera.acceptCompletion",
                    arguments: [this.metrics.record(firstToken, performance.now() - requested)],
                };
                return [item];
            }
            catch (error) {
                if (!signal.aborted)
                    this.log.appendLine(String(error));
                return [];
            }
        };
        if (block || (comments && isCommentTrigger(document, position))) {
            cancellation.dispose();
            this.pending.delete(key);
            this.commentPreview = streamCommentSuggestion(document, position, generate, { rawIndentation: block });
            return this.commentPreview?.suggestions() ?? [];
        }
        try {
            return await generate(signal);
        }
        finally {
            cancellation.dispose();
            if (this.pending.get(key) === controller)
                this.pending.delete(key);
        }
    }
    cancel(document, documentChanged = false) {
        if (documentChanged && this.commentPreview?.document === document && this.commentPreview.accepting)
            return;
        if (this.commentPreview?.document === document) {
            this.commentPreview.dispose();
            this.commentPreview = undefined;
        }
        this.pending.get(document.uri.toString())?.abort();
    }
    dispose() {
        this.commentPreview?.dispose();
        this.commentPreview = undefined;
        for (const controller of this.pending.values())
            controller.abort();
        this.pending.clear();
    }
}
exports.InlineCompletion = InlineCompletion;
