import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline";
import * as vscode from "vscode";

interface TaskEvent {
  phase: string;
  id?: string;
  model?: string;
  tokens?: number;
  passed?: boolean;
  fingerprint?: string;
  orders?: Record<string, unknown>[];
  order?: { id: string; language: string };
  code?: string;
}

function escape(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, char =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

export function taskHtml(events: TaskEvent[], status: string): string {
  const plans = events.flatMap(event => (event.orders ?? []).map(order =>
    `<details><summary>${escape(order.id)} · ${escape(order.role)} · ${escape(order.language)}</summary>
     <pre>${escape(JSON.stringify(order, null, 2))}</pre></details>`));
  const steps = events.filter(event => event.phase !== "result").map(event =>
    `<tr><td>${escape(event.id)}</td><td>${escape(event.phase)}</td><td>${escape(event.model)}</td>
    <td>${escape(event.tokens)}</td><td>${event.passed === undefined ? "" : event.passed ? "Pass" : "Fail"}
    ${escape(event.fingerprint)}</td></tr>`);
  const results = events.filter(event => event.phase === "result").map(event =>
    `<h3>${escape(event.order?.id)} · ${event.passed ? "Verified" : "Failed"}</h3>
     ${event.code ? `<pre>${escape(event.code)}</pre>` : ""}`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
    <style>body{padding:1rem}table{border-collapse:collapse}td,th{padding:.45rem;text-align:left;
    border-bottom:1px solid var(--vscode-panel-border)}pre{white-space:pre-wrap;overflow-wrap:anywhere}
    details{margin:.5rem 0}</style></head><body><h1>Tessera task</h1><p>${escape(status)}</p>
    ${plans.join("")}<table><thead><tr><th scope="col">Order</th><th scope="col">Step</th>
    <th scope="col">Model</th><th scope="col">Tokens</th><th scope="col">Verifier</th></tr></thead>
    <tbody>${steps.join("")}</tbody></table>${results.join("")}</body></html>`;
}

export function registerTask(
  context: vscode.ExtensionContext,
  languageHint: () => string,
  installedModels: () => { id: string; language: string; path: string }[],
  log: vscode.OutputChannel,
) {
  let active = false;
  return vscode.commands.registerCommand("tinycoders.runTask", async () => {
    if (!vscode.workspace.isTrusted || active) return;
    const settings = vscode.workspace.getConfiguration("tinycoders");
    if (!settings.get("capsule.enabled", true)) {
      await vscode.window.showInformationMessage("Enable TinyCoders › Capsule: Enabled to run tasks.");
      return;
    }
    active = true;
    try {
      const editor = vscode.window.activeTextEditor;
      const folder = (editor && vscode.workspace.getWorkspaceFolder(editor.document.uri)) ??
        vscode.workspace.workspaceFolders?.[0];
      const runtime = settings.get("capsule.runtimePath", "");
      if (!folder || folder.uri.scheme !== "file" || !context.storageUri || !runtime) {
        throw new Error("Open a local workspace and configure tinycoders.capsule.runtimePath.");
      }
      const request = await vscode.window.showInputBox({
        title: "Tessera: Run task", prompt: "Describe the code and behavior you want verified",
      });
      if (!request?.trim()) return;
      const [checksFile] = await vscode.window.showOpenDialog({ defaultUri: folder.uri,
        filters: { "Acceptance checks": ["json"] }, canSelectMany: false, openLabel: "Use Acceptance Checks" }) ?? [];
      if (!checksFile) return;
      const checks: unknown = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(checksFile)).toString("utf8"));
      const configured = settings.get<Record<string, unknown>[]>("capsule.models", []);
      const specs = configured.length ? configured : installedModels();
      if (!specs.length) throw new Error("Configure a capsule model or install a chat-capable local model.");
      const remote = settings.get("capsule.remote", false);

      const panel = vscode.window.createWebviewPanel("tinycoders.capsuleTask", "Tessera task", vscode.ViewColumn.Beside);
      const events: TaskEvent[] = [];
      let closed = false;
      const update = (status: string) => { if (!closed) panel.webview.html = taskHtml(events, status); };
      update("Planning and indexing…");
      const child = spawn(settings.get("capsule.pythonPath", "python3"), [
        "-m", "capsule.cli", "--workspace", folder.uri.fsPath,
        "--storage", join(context.storageUri.fsPath, "capsule", createHash("sha256").update(folder.uri.toString()).digest("hex")),
        "--server", settings.get("serverPath", "llama-server"),
      ], { cwd: runtime, shell: false });
      panel.onDidDispose(() => { closed = true; });
      const lines = createInterface({ input: child.stdout });
      lines.on("line", line => {
        try {
          events.push(JSON.parse(line) as TaskEvent);
          update("Running…");
        } catch (error) {
          log.appendLine(String(error));
        }
      });
      let errorTail = "";
      child.stderr.on("data", (chunk: Buffer) => {
        const message = chunk.toString();
        errorTail = (errorTail + message).slice(-1500);
        log.append(message);
      });
      child.stdin.on("error", error => log.appendLine(String(error)));
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", code => {
          update(code === 0 ? "Finished" : `Task stopped. ${errorTail.trim().split("\n").at(-1) ?? ""}`);
          resolve();
        });
        child.stdin.end(JSON.stringify({
          request, checks, models: specs, language: languageHint(), remote,
          cap: settings.get("capsule.tokenCap", 1500),
          retries: settings.get("capsule.retries", 2),
          training_license: settings.get("capsule.trainingLicense", ""),
        }));
      }).catch((error: unknown) => { update(String(error)); });
    } catch (error) {
      log.appendLine(String(error));
      void vscode.window.showErrorMessage(`Tessera: ${String(error)}`);
    } finally {
      active = false;
    }
  });
}
