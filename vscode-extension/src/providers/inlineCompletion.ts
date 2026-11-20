import { setTimeout as delay } from "node:timers/promises";
import * as vscode from "vscode";
import type { Snippet } from "../context/bm25";
import { buildDocumentation, buildFim, type FimTokens } from "../context/builder";
import type { LocalMetrics } from "../telemetry";
import type { InferenceHost } from "../host/client";
import { fitMessages, type ChatModel } from "./chat";

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

function inlineInstruction(document: vscode.TextDocument, position: vscode.Position): string | undefined {
  const comment = document.lineAt(position.line - 1).text.trim();
  const instruction = comment.replace(/^(?:#|\/\/|--|\/\*|<!--)\s*(?:tinycoders:\s*)?/i, "")
    .replace(/\s*(?:\*\/|-->)$/, "").trim();
  if (/^(?:make|build|create|implement|write|generate)\s+\S/i.test(instruction)) return instruction;
}

async function generateCode(
  model: ChatModel, document: vscode.TextDocument, position: vscode.Position,
  instruction: string, signal: AbortSignal, onFirstToken: () => void,
): Promise<string> {
  const offset = document.offsetAt(position);
  const source = document.getText();
  const commentOffset = document.offsetAt(document.lineAt(position.line - 1).range.start);
  const before = source.slice(Math.max(0, commentOffset - 240), commentOffset).trimEnd();
  const after = source.slice(offset, offset + 160).trim();
  const terminal = document.languageId === "python" && /\b(?:tui|terminal ui|text user interface)\b/i.test(instruction);
  const guidance = terminal
    ? "\nUse Python curses. Define main(stdscr) with initialization and the entire timed event loop. " +
      "Call curses.wrapper(main) once under the __main__ guard. Avoid nested functions. " +
      "Use stdscr.keypad(True), stdscr.timeout(120), and getch(). Handle q before updating state. " +
      "For grid movement, represent positions and direction as (row, column) pairs, with a key-to-direction map. " +
      "For games, implement the core mechanics, collisions, score, and game over."
    : "";
  const messages = [
    { role: "system" as const, content: "Return only complete, runnable code for insertion at the cursor. " +
      "Use the file language and honor the request. Do not include explanations, placeholders, or repeat existing code. " +
      "Prefer standard library APIs unless the request requires a dependency. Indent relative to column zero. " +
      "Define everything the code uses and include a runnable entry point for a standalone program. " +
      "For interactive programs, implement input handling, state updates, rendering, and a clean exit." },
    { role: "user" as const, content: `Language: ${document.languageId}\nRequest: ${instruction}\n` +
      `Before cursor:\n${before}\nAfter cursor:\n${after}${guidance}` },
  ];
  const promptBytes = messages.reduce((bytes, message) => bytes + Buffer.byteLength(message.content) + 24, 0);
  const tokens = Math.min(3072, Math.floor(model.contextLength * 0.75),
    Math.max(Math.floor(model.contextLength / 2), model.contextLength - promptBytes));
  return model.use(async host => {
    signal.throwIfAborted();
    let result = "";
    for await (const chunk of host.chat(fitMessages(messages, model.contextLength, tokens), signal, tokens)) {
      if (!result) onFirstToken();
      result += chunk;
    }
    const code = result.trimEnd().replace(/^(?:[ \t]*\r?\n)+/, "");
    const fenced = /^\x60{3}[^\r\n]*\r?\n([\s\S]*?)\r?\n\x60{3}$/.exec(code);
    if (!fenced && /^\x60{3}/m.test(code)) return "";
    const indent = document.lineAt(position.line).text;
    const newline = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    return (fenced?.[1] ?? code).split(/\r?\n/).map((line, index) =>
      index && line ? indent + line : line).join(newline);
  });
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
    private readonly selectInstruction?: (document: vscode.TextDocument, position: vscode.Position) => ChatModel | undefined,
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
    if (!vscode.workspace.isTrusted || token.isCancellationRequested) return [];
    const model = this.select(document, position);
    if (automaticRequest && model?.python && document.languageId === "python" &&
        !afterComment && !document.lineAt(position.line).text.trim()) {
      const previous = position.line > 0 ? document.lineAt(position.line - 1).text.trimEnd() : "";
      // An empty line after a complete statement is a stopping point. New
      // blocks and explicit continuations still need their first line.
      if (!previous || previous.trimStart().startsWith("#") || !/[:([{\\]$/.test(previous)) return [];
    }
    const loop = afterComment && document.languageId === "python" ? genericPythonLoop(document, position) : undefined;
    if (loop && model?.python) return [new vscode.InlineCompletionItem(loop, new vscode.Range(position, position))];
    const instruction = afterComment && !loop && position.character === document.lineAt(position.line).text.length
      ? inlineInstruction(document, position) : undefined;
    const chat = instruction ? this.selectInstruction?.(document, position) : undefined;
    if (instruction && !chat) {
      const message = "Set up a TinyCoders chat-capable model for inline code generation.";
      this.log.appendLine(message);
      if (!automaticRequest) void vscode.window.showInformationMessage(message);
      return [];
    }
    if (!chat && !model) return [];
    const controller = new AbortController();
    const { signal } = controller;
    this.pending.set(key, controller);
    const cancellation = token.onCancellationRequested(() => controller.abort());
    const version = document.version;
    try {
      if (chat && instruction) {
        await delay(180, undefined, { signal });
        const requested = performance.now();
        let firstToken: number | undefined;
        const result = await generateCode(chat, document, position, instruction, signal,
          () => { firstToken = performance.now() - requested; });
        return this.suggestion(document, position, version, signal, result, firstToken, requested);
      }
      if (!model) return [];
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
      return this.suggestion(document, position, version, signal, result, firstToken, requested);
    } catch (error) {
      if (!signal.aborted) this.log.appendLine(String(error));
      return [];
    } finally {
      cancellation.dispose();
      if (this.pending.get(key) === controller) this.pending.delete(key);
    }
  }

  private suggestion(
    document: vscode.TextDocument, position: vscode.Position, version: number, signal: AbortSignal,
    result: string, firstToken: number | undefined, requested: number,
  ): vscode.InlineCompletionItem[] {
    if (signal.aborted || document.version !== version || !result.trim()) return [];
    const item = new vscode.InlineCompletionItem(result, new vscode.Range(position, position));
    item.command = {
      title: "Record accepted TinyCoders suggestion", command: "tinycoders.acceptCompletion",
      arguments: [this.metrics.record(firstToken, performance.now() - requested)],
    };
    return [item];
  }

  cancel(document: vscode.TextDocument): void {
    this.pending.get(document.uri.toString())?.abort();
  }

  dispose(): void {
    for (const controller of this.pending.values()) controller.abort();
    this.pending.clear();
  }
}
