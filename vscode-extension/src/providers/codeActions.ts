import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { bindCancellation, fitMessages, type ChatModel } from "./chat";

const actions = {
  explain: "Explain Code",
  refactor: "Refactor Code",
  writeTests: "Write Tests",
} as const;
type Action = keyof typeof actions;

function unwrap(result: string): string {
  const fenced = /^\s*```[^\n]*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(result);
  return fenced?.[1] ?? result;
}

export function registerCodeActions(
  context: vscode.ExtensionContext,
  select: (editor: vscode.TextEditor, action: Action) => ChatModel | undefined,
  log: vscode.OutputChannel,
): void {
  const scheme = "tessera-preview";
  const previews = new Map<string, string>();
  const preview = (content: string) => {
    const uri = vscode.Uri.from({ scheme, path: `/${randomUUID()}` });
    previews.set(uri.toString(), content);
    return uri;
  };
  const instructions: Record<Action, string> = {
    explain: "Explain the selected source code clearly in Markdown.",
    refactor: "Refactor the selected source code and preserve its behavior and indentation. Return only replacement code.",
    writeTests: "Write tests for the selected source code. Return only the test source code.",
  };

  async function invoke(action: Action) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !vscode.workspace.isTrusted) return;
    const model = select(editor, action);
    if (!model) {
      void vscode.window.showInformationMessage("Select or install a model from the Tessera status bar.");
      return;
    }
    const { document, selection } = editor;
    const range = selection.isEmpty ? document.lineAt(selection.active.line).range : selection;
    const original = document.getText(range);
    if (!original.trim()) return;
    const version = document.version;
    try {
      const completion = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, cancellable: true, title: `Tessera: ${actions[action]}`,
      }, async (_progress, token) => {
        const cancellation = bindCancellation(token);
        let response = "";
        try {
          await model.use(async host => {
            const messages = fitMessages([
              { role: "system", content: instructions[action] },
              { role: "user", content: `Language: ${document.languageId}\n\n${original}` },
            ], model.contextLength);
            if (!messages.some(message => message.role === "system")) {
              throw new Error("The selection exceeds the model context window");
            }
            for await (const chunk of host.chat(messages, cancellation.signal)) response += chunk;
          });
          return cancellation.signal.aborted ? undefined : response;
        } catch (error) {
          if (!cancellation.signal.aborted) throw error;
        } finally {
          cancellation.dispose();
        }
      });
      if (!completion?.trim()) return;
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
      await vscode.commands.executeCommand("vscode.diff", preview(before), preview(after),
        `Tessera: ${actions[action]}`, { preview: true });
      if (await vscode.window.showInformationMessage(`Apply Tessera ${action === "refactor" ? "edit" : "tests"}?`,
        "Apply") !== "Apply") return;
      if (document.isClosed || document.version !== version) {
        void vscode.window.showWarningMessage("The source changed while the preview was open. Run the command again.");
        return;
      }
      if (action === "writeTests") {
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({
          language: document.languageId, content: after,
        }));
      } else {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, range, replacement);
        if (!await vscode.workspace.applyEdit(edit)) throw new Error("VS Code could not apply the edit");
      }
    } catch (error) {
      log.appendLine(String(error));
      void vscode.window.showErrorMessage(`Tessera: ${String(error)}`);
    }
  }

  const commands = Object.keys(actions) as Action[];
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(scheme, {
      provideTextDocumentContent: uri => previews.get(uri.toString()) ?? "",
    }),
    vscode.workspace.onDidCloseTextDocument(document => {
      if (document.uri.scheme === scheme) previews.delete(document.uri.toString());
    }),
    vscode.languages.registerCodeActionsProvider({ scheme: "file" }, {
      provideCodeActions: (_document, range) => range.isEmpty ? [] : commands.map(action => ({
        title: `Tessera: ${actions[action]}`, command: `tessera.${action}`,
      })),
    }),
    ...commands.map(action => vscode.commands.registerCommand(`tessera.${action}`, () => invoke(action))),
  );
}
