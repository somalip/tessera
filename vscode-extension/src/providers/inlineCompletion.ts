import { setTimeout as delay } from "node:timers/promises";
import * as vscode from "vscode";
import type { Snippet } from "../context/bm25";
import { buildDocumentation, buildFim, type FimTokens } from "../context/builder";
import type { LocalMetrics } from "../telemetry";
import type { InferenceHost } from "../host/client";

export interface CompletionModel {
  contextLength: number;
  tokens: FimTokens;
  short?: boolean;
  documentation?: boolean;
  python?: boolean;
  use<T>(operation: (host: InferenceHost) => Promise<T>): Promise<T>;
}

function isCommentTrigger(document: vscode.TextDocument, position: vscode.Position): boolean {
  if (!position.line || document.lineAt(position.line).text.trim()) return false;
  const previous = document.lineAt(position.line - 1).text;
  switch (document.languageId) {
    case "python":
      return /^\s*#\s*[^#!\s]/.test(previous);
    case "ruby": case "shellscript": case "yaml":
      return /^\s*#\s*tinycoders:\s*\S/.test(previous);
    case "sql":
      return /^\s*--\s*tinycoders:\s*\S/.test(previous);
    case "css":
      return /^\s*\/\*\s*tinycoders:\s*\S.*\*\/\s*$/.test(previous);
    case "html": case "markdown":
      return /^\s*<!--\s*tinycoders:\s*\S.*-->\s*$/.test(previous);
    default:
      return /^\s*\/\/\s*tinycoders:\s*\S/.test(previous);
  }
}

function genericPythonLoop(document: vscode.TextDocument, position: vscode.Position): string | undefined {
  const current = document.lineAt(position.line).text;
  if (position.character !== current.length) return;
  const previous = document.lineAt(position.line - 1).text;
  const instruction = /^([ \t]*)#\s*(?:tinycoders:\s*)?(?:(?:write|create|make|add)\s+)?(?:a\s+)?(?:for\s+)?loop[.!]?\s*$/i.exec(previous);
  if (!instruction || !instruction[1].startsWith(current)) return;
  const editor = vscode.window.visibleTextEditors.find(editor => editor.document === document);
  const settings = vscode.workspace.getConfiguration("editor", document);
  const tabSize = editor?.options.tabSize ?? settings.get("tabSize", 4);
  const insertSpaces = editor?.options.insertSpaces ?? settings.get("insertSpaces", true);
  const indent = insertSpaces === false ? "\t" : " ".repeat(typeof tabSize === "number" ? tabSize : 4);
  const newline = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
  const base = instruction[1];
  return `${base.slice(current.length)}for i in range(10):${newline}${base}${indent}print(i)`;
}

export class InlineCompletion implements vscode.InlineCompletionItemProvider, vscode.Disposable {
  private readonly pending = new Map<string, AbortController>();

  constructor(
    private readonly select: (document: vscode.TextDocument, position: vscode.Position) =>
      CompletionModel | undefined,
    private readonly log: vscode.OutputChannel,
    private readonly metrics: LocalMetrics,
    private readonly settings: (document: vscode.TextDocument) => { automatic: boolean; comments: boolean },
    private readonly retrieve?: (document: vscode.TextDocument, position: vscode.Position) => Promise<Snippet[]>,
  ) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument, position: vscode.Position,
    context: vscode.InlineCompletionContext, token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[]> {
    const key = document.uri.toString();
    this.cancel(document);
    const { automatic, comments } = this.settings(document);
    const afterComment = comments && isCommentTrigger(document, position);
    const automaticRequest = context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic;
    if (automaticRequest && !automatic && !afterComment) return [];
    const model = this.select(document, position);
    if (!model || token.isCancellationRequested) return [];
    if (automaticRequest && model.python && document.languageId === "python" &&
        !afterComment && !document.lineAt(position.line).text.trim()) {
      const previous = position.line > 0 ? document.lineAt(position.line - 1).text.trimEnd() : "";
      // An empty line after a complete statement is a stopping point. New
      // blocks and explicit continuations still need their first line.
      if (!previous || previous.trimStart().startsWith("#") || !/[:([{\\]$/.test(previous)) return [];
    }
    if (model.python && afterComment) {
      const loop = genericPythonLoop(document, position);
      if (loop) return [new vscode.InlineCompletionItem(loop, new vscode.Range(position, position))];
    }
    const controller = new AbortController();
    const { signal } = controller;
    this.pending.set(key, controller);
    const cancellation = token.onCancellationRequested(() => controller.abort());
    const version = document.version;
    try {
      const snippets = model.short ? undefined : this.retrieve?.(document, position).catch(() => []);
      await delay(model.short ? (afterComment ? 60 : 100) : 180, undefined, { signal });
      const context = snippets ? await Promise.race([snippets, delay(25, [])]) : [];
      const lineComment = ["python", "ruby", "shellscript", "yaml"].includes(document.languageId) ? "#" : "//";
      const source = document.getText();
      const offset = document.offsetAt(position);
      const prompt = model.documentation ? buildDocumentation(source, offset)
        : buildFim(source, offset, model.contextLength, model.tokens, context, lineComment);
      const stop = [...Object.values(model.tokens), "<|endoftext|>"];
      if (model.documentation) stop.push("<|im_end|>");
      if (model.short) stop.push("\n", "\r");
      const requested = performance.now();
      let firstToken: number | undefined;
      const result = await model.use(async host => {
        signal.throwIfAborted();
        const started = performance.now();
        return host.complete(prompt, stop, signal,
          () => { firstToken ??= performance.now() - started; }, model.short ? 32 : undefined);
      });
      if (signal.aborted || document.version !== version || !result) return [];
      const item = new vscode.InlineCompletionItem(result, new vscode.Range(position, position));
      item.command = {
        title: "Record accepted TinyCoders suggestion", command: "tinycoders.acceptCompletion",
        arguments: [this.metrics.record(firstToken, performance.now() - requested)],
      };
      return [item];
    } catch (error) {
      if (!signal.aborted) this.log.appendLine(String(error));
      return [];
    } finally {
      cancellation.dispose();
      if (this.pending.get(key) === controller) this.pending.delete(key);
    }
  }

  cancel(document: vscode.TextDocument): void {
    this.pending.get(document.uri.toString())?.abort();
  }

  dispose(): void {
    for (const controller of this.pending.values()) controller.abort();
    this.pending.clear();
  }
}
