import type { Workflow } from "../router/workflow";
import { setTimeout as delay } from "node:timers/promises";
import * as vscode from "vscode";
import type { Snippet } from "../context/bm25";
import { buildDocumentation, buildFim, type FimTokens } from "../context/builder";
import type { LocalMetrics } from "../telemetry";
import { IncompleteCodeError, type InferenceHost } from "../host/client";
import { fitMessages, type ChatModel } from "./chat";
import type { InstalledModel } from "../registry/download";
import { isPythonProject, projectMessages } from "./projectPrompt";
import { cppAnswerKind, cppCommentRequest, cppFinishedCode, cppGenerationProblem, cppShouldContinue, cppSystemPrompt, foreignCppSnippet } from "./cppSnippet";

export interface InlineRoute {
  mode: "Autocomplete" | "Comment routing" | "Comment parsing" | "Inline generation";
  parser?: InstalledModel;
  model?: InstalledModel;
}

export type InlineModelRole = "router" | "chat" | "comment-parser" | "python-comment";

export interface CompletionModel {
  installed: InstalledModel;
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
    case "cpp":
      return /^\s*\/\/\s*\S/.test(previous);
    case "ruby": case "shellscript": case "yaml":
      return /^\s*#\s*tessera:\s*\S/.test(previous);
    case "sql":
      return /^\s*--\s*tessera:\s*\S/.test(previous);
    case "css":
      return /^\s*\/\*\s*tessera:\s*\S.*\*\/\s*$/.test(previous);
    case "html": case "markdown":
      return /^\s*<!--\s*tessera:\s*\S.*-->\s*$/.test(previous);
    default:
      return /^\s*\/\/\s*tessera:\s*\S/.test(previous);
  }
}

function inlineInstruction(document: vscode.TextDocument, position: vscode.Position): string | undefined {
  const comment = document.lineAt(position.line - 1).text.trim();
  const instruction = comment.replace(/^(?:#|\/\/|--|\/\*|<!--)\s*(?:tessera:\s*)?/i, "")
    .replace(/\s*(?:\*\/|-->)$/, "").trim();
  if (document.languageId === "cpp") return undefined;
  if (document.languageId === "python" ||
      /^(?:make|build|create|implement|write|generate)\s+\S/i.test(instruction)) return instruction;
}

function pythonProjectComment(document: vscode.TextDocument, position: vscode.Position) {
  if (document.languageId !== "python" || position.character !== 0) return;
  const lines: string[] = [];
  for (let line = position.line - 1; line >= 0; line--) {
    const comment = /^#[ \t]*(?![!#])(.+)$/.exec(document.lineAt(line).text);
    if (!comment) break;
    lines.push(comment[1].trim());
  }
  lines.reverse();
  const start = lines.findIndex(line => isPythonProject(line.replace(/^tessera:\s*/i, "")));
  if (start === -1) return;
  const instruction = lines.slice(start).join("\n").replace(/^tessera:\s*/i, "");
  return { instruction, line: position.line - lines.length + start };
}

function cppProjectComment(document: vscode.TextDocument, position: vscode.Position) {
  const lines: string[] = [];
  for (let line = position.line - 1; line >= 0; line--) {
    const match = /^\s*\/\/\s*(.*)$/.exec(document.lineAt(line).text);
    if (!match) break;
    lines.unshift(match[1]);
  }
  const request = cppCommentRequest(lines);
  return request && { instruction: request.instruction, line: position.line - lines.length + request.start };
}

async function shouldParse(model: CompletionModel, instruction: string, signal: AbortSignal): Promise<boolean> {
  return model.use(async host => {
    signal.throwIfAborted();
    const messages = fitMessages([
      { role: "system", content: "Classify this coding request. Output PARSE for a verbose request that benefits from a short brief. Output DIRECT if it is concise or has precise formatting or implementation details. Output one word only." },
      { role: "user", content: instruction.slice(0, 600) },
    ], model.contextLength, 8);
    let route = "";
    try {
      for await (const chunk of host.chat(messages, signal, 8)) route += chunk;
    } catch (error) {
      if (error instanceof IncompleteCodeError) return false;
      throw error;
    }
    return /^PARSE[.!]?$/i.test(route.trim());
  });
}

async function condenseInstruction(model: CompletionModel, instruction: string, signal: AbortSignal): Promise<string> {
  const request = instruction.replace(/<\|[^\r\n|]*\|>/g, "").trim();
  const examples = "# Request: Please write a command-line tool that reads a CSV from stdin and prints sorted unique IDs.\n" +
    "# Brief: CLI: read CSV stdin; print sorted unique IDs.\n\n" +
    "# Request: Could you make an HTTP client with a 5-second timeout and no retries?\n" +
    "# Brief: HTTP client, timeout 5s, no retries.\n\n";
  const source = examples + `# Request: ${request}\n# Brief:`;
  const prompt = buildFim(source, source.length, model.contextLength, model.tokens);
  const stop = ["\n", "\r", "<|endoftext|>", ...Object.values(model.tokens)];
  const parsed = (await model.use(host => {
    signal.throwIfAborted();
    return host.complete(prompt, stop, signal, undefined, 64);
  })).trim();

  // Compact requests may already be as short as a useful model-produced brief.
  const markers = (text: string): string[] => text.toLowerCase()
    .replace(/\bcommand[ -]line\b/g, "cli").replace(/\b(?:terminal ui|text user interface)\b/g, "tui")
    .match(/\b(?:cli|tui|stdin|stdout|ctrl-[a-z])\b/g) ?? [];
  const requestMarkers = markers(request);
  const parsedMarkers = markers(parsed);
  const interfaces = ["cli", "tui"].filter(kind => requestMarkers.includes(kind) && !parsedMarkers.includes(kind));
  const brief = parsed && interfaces.length ? `${interfaces.join(" / ").toUpperCase()}: ${parsed}` : parsed;
  const literals = /\d+(?:\.\d+)?|`[^`]+`|"[^"]+"/g;
  const sourceLiterals: string[] = request.match(literals) ?? [];
  const briefLiterals: string[] = brief.match(literals) ?? [];
  const briefMarkers = markers(brief);
  if (brief && !/[\r\n]/.test(brief) && Buffer.byteLength(brief) < Buffer.byteLength(request) &&
      sourceLiterals.every(literal => briefLiterals.includes(literal)) &&
      briefLiterals.every(literal => sourceLiterals.includes(literal)) &&
      requestMarkers.every(marker => briefMarkers.includes(marker)) &&
      (!/\b(?:no|not|never|without)\b/i.test(request) || /\b(?:no|not|never|without)\b/i.test(brief))) return brief;
  return request.replace(/^(?:could you\s+)?(?:please\s+)?(?:make|build|create|implement|write|generate)\s+an?\s+(?=\S)/i, "");
}

async function generateCode(
  model: ChatModel, document: vscode.TextDocument, position: vscode.Position,
  instruction: string, signal: AbortSignal, onFirstToken: () => void, projectLine?: number,
  validateProject?: (code: string, newFile: boolean) => string | undefined,
): Promise<string> {
  const offset = document.offsetAt(position);
  const source = document.getText();
  const cpp = document.languageId === "cpp";
  const project = !cpp && projectLine !== undefined;
  const commentOffset = document.offsetAt(document.lineAt(projectLine ?? position.line - 1).range.start);
  const before = source.slice(Math.max(0, commentOffset - (cpp ? 1200 : 240)), commentOffset).trimEnd();
  const tail = source.slice(offset, offset + (cpp ? 600 : 160));
  const after = cpp ? tail.replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd() : tail.trim();
  const terminal = document.languageId === "python" && /\b(?:tui|terminal ui|text user interface)\b/i.test(instruction);
  const guidance = terminal
    ? "\nUse Python curses. Define main(stdscr) with initialization and the entire timed event loop. " +
      "Call curses.wrapper(main) once under the __main__ guard. Avoid nested functions. " +
      "Use stdscr.keypad(True), stdscr.timeout(120), and getch(). Handle q before updating state. " +
      "For grid movement, represent positions and direction as (row, column) pairs, with a key-to-direction map. " +
      "For games, implement the core mechanics, collisions, score, and game over."
    : "";
  const contextual = Boolean(before.trim() || after.trim());
  const cppKind = cppAnswerKind(instruction, contextual);
  const messages = project ? projectMessages(instruction, before, after, model.contextLength) : [
    { role: "system" as const, content: cpp ? cppSystemPrompt(cppKind) : "Return only complete, runnable code for insertion at the cursor. " +
      "Use the file language and honor the request. Do not include explanations, placeholders, or repeat existing code. " +
      "Prefer standard library APIs unless the request requires a dependency. Indent relative to column zero. " +
      "Define everything the code uses and include a runnable entry point for a standalone program. " +
      "For interactive programs, implement input handling, state updates, rendering, and a clean exit." },
    { role: "user" as const, content: `Language: ${document.languageId}\nRequest: ${instruction}` +
      (cpp && !contextual ? "" : `\nBefore cursor:\n${before}\nAfter cursor:\n${after}${guidance}`) },
  ];
  const promptBytes = messages.reduce((bytes, message) => bytes + Buffer.byteLength(message.content) + 24, 0);
  const tokens = cpp ? 768 : project ? Math.min(2304, Math.floor(model.contextLength * 0.625), model.contextLength - promptBytes - 64)
    : Math.min(3072, Math.floor(model.contextLength * 0.75),
      Math.max(Math.floor(model.contextLength / 2), model.contextLength - promptBytes));
  if (project && tokens < 384) throw new Error("The full request needs a larger model context.");
  return model.use(async host => {
    let problem: string | undefined;
    for (let attempt = 0; attempt < (project || cpp ? 2 : 1); attempt++) {
      signal.throwIfAborted();
      const retry = cpp ? "Return complete C++ code for the original request."
        : "Generate a shorter complete program from scratch.";
      const retryMessages = problem ? messages.map(message => message.role === "user"
        ? { ...message, content: message.content + `\n${problem} ${retry}` }
        : message) : messages;
      const prompt = project ? retryMessages : fitMessages(retryMessages, model.contextLength, tokens);
      let result = "";
      try {
        for await (const chunk of host.chat(prompt, signal, tokens)) {
          if (!result) onFirstToken();
          result += chunk;
          const finished = cpp ? cppFinishedCode(result, cppKind) : undefined;
          if (finished !== undefined) {
            result = finished;
            break;
          }
        }
      } catch (error) {
        if (!(project || cpp) || !(error instanceof IncompleteCodeError)) throw error;
        problem = "The previous answer was cut off.";
        continue;
      }
      const code = result.trimEnd().replace(/^(?:[ \t]*\r?\n)+/, "");
      const fenced = /^\x60{3}[^\r\n]*\r?\n([\s\S]*?)\r?\n\x60{3}$/.exec(code);
      const pythonBlocks = project ? [...code.matchAll(/^\x60{3}(?:python|py)[ \t]*\r?\n([\s\S]*?)\r?\n\x60{3}[ \t]*$/gim)] : [];
      const block = pythonBlocks.length === 1 ? pythonBlocks[0][1] : fenced?.[1];
      const snippet = block ?? code;
      problem = !snippet.trim() || (!block && /^\x60{3}/m.test(code))
        ? "The previous answer did not contain a complete code block."
        : cpp ? cppGenerationProblem(snippet, code, cppKind) : project ? validateProject?.(snippet, !before && !after) : undefined;
      if (problem) continue;
      const indent = document.lineAt(position.line).text;
      const newline = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
      return snippet.split(/\r?\n/).map((line, index) => index && line ? indent + line : line).join(newline);
    }
    if ((project || cpp) && problem) throw new Error(problem);
    return "";
  });
}

export class InlineCompletion implements vscode.InlineCompletionItemProvider, vscode.Disposable {
  private readonly pending = new Map<string, AbortController>();

  constructor(
    private readonly select: (document: vscode.TextDocument, position: vscode.Position, role?: InlineModelRole) =>
      CompletionModel | undefined,
    private readonly log: vscode.OutputChannel,
    private readonly metrics: LocalMetrics,
    private readonly settings: (document: vscode.TextDocument) => { automatic: boolean; comments: boolean },
    private readonly retrieve?: (document: vscode.TextDocument, position: vscode.Position) => Promise<Snippet[]>,
    private readonly reportRoute?: (document: vscode.TextDocument, route: InlineRoute) => void,
    private readonly validateProject?: (code: string, newFile: boolean) => string | undefined,
    private readonly workflow?: (document: vscode.TextDocument) => Workflow | undefined,
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
    const cpp = document.languageId === "cpp";
    const line = document.lineAt(position.line).text;
    if (cpp && automaticRequest && !afterComment && !line.trim() &&
        (!position.line || !cppShouldContinue(document.lineAt(position.line - 1).text))) return [];
    const project = !afterComment ? undefined : !cpp ? pythonProjectComment(document, position)
      : position.character === line.length ? cppProjectComment(document, position) : undefined;
    const instruction = project?.instruction ?? (afterComment && position.character === document.lineAt(position.line).text.length
      ? inlineInstruction(document, position) : undefined);
    const pythonComment = instruction !== undefined && document.languageId === "python";
    const configured = this.workflow?.(document);
    const needsParser = instruction !== undefined && (configured ? Boolean(configured.parser) : pythonComment && !project);
    const needsRouter = needsParser && Boolean(configured?.router);
    const router = needsRouter ? this.select(document, position, "router") : undefined;
    const parser = needsParser ? this.select(document, position, "comment-parser") : undefined;
    const chat = instruction ? this.select(document, position, pythonComment ? "python-comment" : "chat") : undefined;
    const parserUnavailable = needsParser && !parser;
    const routerUnavailable = needsRouter && !router;
    if (instruction && (!chat || parserUnavailable || routerUnavailable)) {
      const missing = routerUnavailable ? "router" : parserUnavailable ? "parser" : "generator";
      this.reportRoute?.(document, { mode: routerUnavailable ? "Comment routing"
        : parserUnavailable ? "Comment parsing" : "Inline generation" });
      const message = configured ? `Connect an available ${missing} in the Tessera workflow.` : parserUnavailable
        ? "Set tessera.parsingAutocompleteModelPath to parse Python comment requests."
        : pythonComment ? "Set tessera.pythonModelPath to generate code from Python comment requests."
        : "Set up a Tessera chat-capable model for inline code generation.";
      this.log.appendLine(message);
      if (!automaticRequest) void vscode.window.showInformationMessage(message);
      return [];
    }
    if (!chat && !model) {
      this.reportRoute?.(document, { mode: "Autocomplete" });
      return [];
    }
    const controller = new AbortController();
    const { signal } = controller;
    this.pending.set(key, controller);
    const cancellation = token.onCancellationRequested(() => controller.abort());
    const version = document.version;
    try {
      if (chat && instruction) {
        await delay(180, undefined, { signal });
        const requested = performance.now();
        let brief = instruction;
        if (router) this.reportRoute?.(document, { mode: "Comment routing", model: router.installed });
        const parsedBy = parser && (!router || await shouldParse(router, instruction, signal)) ? parser : undefined;
        if (parsedBy) {
          this.reportRoute?.(document, { mode: "Comment parsing", model: parsedBy.installed });
          brief = await condenseInstruction(parsedBy, instruction, signal);
        }
        signal.throwIfAborted();
        this.reportRoute?.(document, { mode: "Inline generation", model: chat.installed, parser: parsedBy?.installed });
        let firstToken: number | undefined;
        const result = await generateCode(chat, document, position, brief, signal,
          () => { firstToken ??= performance.now() - requested; }, project?.line, this.validateProject);
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
      if (model.documentation || cpp) stop.push("<|im_end|>");
      if (model.short) stop.push("\n", "\r");
      const requested = performance.now();
      let firstToken: number | undefined;
      signal.throwIfAborted();
      this.reportRoute?.(document, { mode: "Autocomplete", model: model.installed });
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
    if (signal.aborted || document.version !== version || !result.trim() ||
        (document.languageId === "cpp" && foreignCppSnippet(result))) return [];
    const item = new vscode.InlineCompletionItem(result, new vscode.Range(position, position));
    item.command = {
      title: "Record accepted Tessera suggestion", command: "tessera.acceptCompletion",
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
