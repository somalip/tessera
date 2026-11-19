import { setTimeout as delay } from "node:timers/promises";
import * as vscode from "vscode";
import type { Snippet } from "../context/bm25";
import { buildFim, type FimTokens } from "../context/builder";
import type { InferenceHost } from "../host/client";

export interface CompletionModel {
  contextLength: number;
  tokens: FimTokens;
  use<T>(operation: (host: InferenceHost) => Promise<T>): Promise<T>;
}

export class InlineCompletion implements vscode.InlineCompletionItemProvider, vscode.Disposable {
  private readonly pending = new Map<string, AbortController>();

  constructor(
    private readonly select: (document: vscode.TextDocument, position: vscode.Position) =>
      CompletionModel | undefined,
    private readonly log: vscode.OutputChannel,
    private readonly retrieve?: (document: vscode.TextDocument, position: vscode.Position) => Promise<Snippet[]>,
  ) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument, position: vscode.Position,
    _context: vscode.InlineCompletionContext, token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[]> {
    const key = document.uri.toString();
    this.cancel(document);
    const model = this.select(document, position);
    if (!model || token.isCancellationRequested) return [];
    const controller = new AbortController();
    const { signal } = controller;
    this.pending.set(key, controller);
    const cancellation = token.onCancellationRequested(() => controller.abort());
    const version = document.version;
    try {
      const snippets = this.retrieve?.(document, position).catch(() => []);
      await delay(180, undefined, { signal });
      const context = snippets ? await Promise.race([snippets, delay(25, [])]) : [];
      const lineComment = ["python", "ruby", "shellscript", "yaml"].includes(document.languageId) ? "#" : "//";
      const prompt = buildFim(document.getText(), document.offsetAt(position),
        model.contextLength, model.tokens, context, lineComment);
      const result = await model.use(async host => {
        signal.throwIfAborted();
        return host.complete(prompt, [...Object.values(model.tokens), "<|endoftext|>"], signal);
      });
      return !signal.aborted && document.version === version && result
        ? [new vscode.InlineCompletionItem(result, new vscode.Range(position, position))]
        : [];
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
