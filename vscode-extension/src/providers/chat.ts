import * as vscode from "vscode";
import type { InferenceHost, Message } from "../host/client";

export interface ChatModel {
  contextLength: number;
  use<T>(operation: (host: InferenceHost) => Promise<T>): Promise<T>;
}

export function bindCancellation(token: vscode.CancellationToken) {
  const controller = new AbortController();
  if (token.isCancellationRequested) controller.abort();
  const subscription = token.onCancellationRequested(() => controller.abort());
  return { signal: controller.signal, dispose: () => subscription.dispose() };
}

async function respond(
  model: ChatModel, messages: Message[], signal: AbortSignal, write: (chunk: string) => void,
): Promise<void> {
  signal.throwIfAborted();
  await model.use(async host => {
    signal.throwIfAborted();
    for await (const chunk of host.chat(fitMessages(messages, model.contextLength), signal)) write(chunk);
  });
}

function editorContext(): Message {
  const editor = vscode.window.activeTextEditor;
  const selected = editor?.document.getText(editor.selection).slice(0, 400) ?? "";
  return {
    role: "system",
    content: "You are the TinyCoders coding assistant. Give concise answers. " +
      (selected ? `Current ${editor?.document.languageId} selection:\n${selected}` : ""),
  };
}

export function registerPrompt(select: () => ChatModel | undefined, showError: (error: unknown) => void) {
  return vscode.commands.registerCommand("tinycoders.ask", async () => {
    const model = select();
    if (!model) {
      await vscode.window.showInformationMessage("Open a supported file or install a TinyCoders chat model.");
      return;
    }
    const system = editorContext();
    const prompt = (await vscode.window.showInputBox({ title: "Ask TinyCoders", prompt: "Enter a local coding prompt" }))?.trim();
    if (!prompt) return;
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification, title: "TinyCoders is responding", cancellable: true,
    }, async (_progress, token) => {
      const cancellation = bindCancellation(token);
      try {
        let answer = "";
        await respond(model, [system, { role: "user", content: prompt }], cancellation.signal,
          chunk => { answer += chunk; });
        if (cancellation.signal.aborted) return;
        if (!answer.trim()) throw new Error("The local model returned an empty response.");
        const document = await vscode.workspace.openTextDocument({ language: "markdown", content: answer });
        await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside });
      } catch (error) {
        if (!cancellation.signal.aborted) showError(error);
      } finally {
        cancellation.dispose();
      }
    });
  });
}

export function registerChat(select: () => ChatModel | undefined, log: vscode.OutputChannel) {
  return vscode.chat.createChatParticipant("tinycoders.local", async (request, context, stream, token) => {
    const model = select();
    if (!model) {
      stream.markdown("Select or install a TinyCoders chat model from the status bar.");
      return;
    }
    const cancellation = bindCancellation(token);
    const history: Message[] = [];
    for (const turn of context.history.slice(-4)) {
      if (turn instanceof vscode.ChatRequestTurn) {
        history.push({ role: "user", content: turn.prompt });
      } else if (turn instanceof vscode.ChatResponseTurn) {
        const content = turn.response.filter(part => part instanceof vscode.ChatResponseMarkdownPart)
          .map(part => part.value.value).join("");
        if (content) history.push({ role: "assistant", content });
      }
    }
    try {
      await respond(model, [editorContext(), ...history, { role: "user", content: request.prompt }],
        cancellation.signal, chunk => { stream.markdown(new vscode.MarkdownString(chunk)); });
    } catch (error) {
      if (!cancellation.signal.aborted) {
        log.appendLine(String(error));
        stream.markdown("TinyCoders could not complete the local inference request.");
      }
    } finally {
      cancellation.dispose();
    }
  });
}

export function fitMessages(
  messages: Message[], contextLength: number, outputTokens = Math.min(512, Math.floor(contextLength / 4)),
): Message[] {
  let bytes = Math.max(0, contextLength - outputTokens);
  const retained: Message[] = [];
  for (const message of [...messages].reverse()) {
    if (bytes <= 24) break;
    const buffer = Buffer.from(message.content);
    let end = Math.min(buffer.length, bytes - 24);
    while (end > 0 && end < buffer.length && (buffer[end] & 0xC0) === 0x80) end -= 1;
    retained.unshift({ role: message.role, content: buffer.subarray(0, end).toString() });
    bytes -= 24 + end;
  }
  return retained;
}
