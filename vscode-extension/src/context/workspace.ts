import * as vscode from "vscode";
import { BM25, type Snippet } from "./bm25";

const sources = "**/*.{py,pyi,ts,tsx,js,jsx,rs,go,java,c,h,cpp,hpp}";
const exclusions = "**/{.git,.venv,node_modules,vendor,dist,build,target}/**";
const maxFileBytes = 64_000;

interface FolderIndex {
  index: BM25;
  expires: number;
}

export class WorkspaceContext implements vscode.Disposable {
  private readonly indexes = new Map<string, Promise<FolderIndex>>();
  private readonly recent = new Map<string, { uri: vscode.Uri; snippet: Snippet }>();
  private readonly watched: vscode.Disposable[];

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher(sources);
    const invalidate = (uri: vscode.Uri) => {
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (folder) this.indexes.delete(folder.uri.toString());
    };
    this.watched = [
      watcher, watcher.onDidCreate(invalidate), watcher.onDidChange(invalidate),
      watcher.onDidDelete(uri => {
        this.recent.delete(uri.toString());
        invalidate(uri);
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.indexes.clear()),
      vscode.workspace.onDidChangeTextDocument(event => {
        const { document, contentChanges } = event;
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        const last = contentChanges.at(-1);
        if (!folder || !last || !vscode.workspace.isTrusted) return;
        const first = Math.max(0, last.range.start.line - 3);
        const end = Math.min(document.lineCount - 1, first + 12);
        const key = document.uri.toString();
        this.recent.delete(key);
        this.recent.set(key, {
          uri: document.uri,
          snippet: {
            path: vscode.workspace.asRelativePath(document.uri, false),
            text: document.getText(new vscode.Range(first, 0, end, 0)).slice(0, 512)
          },
        });
        if (this.recent.size > 12) this.recent.delete(this.recent.keys().next().value!);
      }),
    ];
  }

  private async index(folder: vscode.WorkspaceFolder): Promise<FolderIndex> {
    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, sources), exclusions, 80);
    const texts = await Promise.all(files.map(async uri => {
      try {
        const metadata = await vscode.workspace.fs.stat(uri);
        if (metadata.type !== vscode.FileType.File || metadata.size > maxFileBytes) return [];
        const source = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
        const lines = source.split(/\r?\n/);
        const path = vscode.workspace.asRelativePath(uri, false);
        return Array.from({ length: Math.min(20, Math.ceil(lines.length / 20)) }, (_, i) => ({
          path, text: lines.slice(i * 20, i * 20 + 24).join("\n").slice(0, 1200),
        }));
      } catch {
        return [];
      }
    }));
    return { index: new BM25(texts.flat()), expires: Date.now() + 60_000 };
  }

  async warm(document: vscode.TextDocument): Promise<void> {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder || !vscode.workspace.isTrusted) return;
    const key = folder.uri.toString();
    const ready = await this.indexes.get(key);
    if (ready && ready.expires > Date.now()) return;
    const pending = this.index(folder);
    this.indexes.set(key, pending);
    try {
      await pending;
    } catch {
      if (this.indexes.get(key) === pending) this.indexes.delete(key);
    }
  }

  private async definition(
    document: vscode.TextDocument, position: vscode.Position, folder: vscode.WorkspaceFolder,
  ): Promise<Snippet | undefined> {
    const before = document.lineAt(position.line).text.slice(0, position.character);
    const symbol = [...before.matchAll(/[$\p{L}_][$\p{L}\p{N}_]*/gu)].at(-1);
    if (!symbol) return;
    const target = new vscode.Position(position.line, (symbol.index ?? 0) + symbol[0].length - 1);
    const locations = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
      "vscode.executeDefinitionProvider", document.uri, target,
    );
    const location = locations?.[0];
    if (!location) return;
    const uri = "targetUri" in location ? location.targetUri : location.uri;
    const range = "targetRange" in location ? location.targetRange : location.range;
    if (uri.toString() === document.uri.toString() ||
      vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() !== folder.uri.toString()) return;
    const metadata = await vscode.workspace.fs.stat(uri);
    if (metadata.type !== vscode.FileType.File || metadata.size > maxFileBytes) return;
    const targetDocument = await vscode.workspace.openTextDocument(uri);
    const line = targetDocument.lineAt(range.start.line);
    return { path: vscode.workspace.asRelativePath(uri, false), text: line.text.trim().slice(0, 240) };
  }

  async retrieve(document: vscode.TextDocument, position: vscode.Position): Promise<Snippet[]> {
    if (!vscode.workspace.isTrusted) return [];
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder) return [];
    const key = document.uri.toString();
    const source = document.getText();
    const offset = document.offsetAt(position);
    const imports = source.slice(0, 2000).split(/\r?\n/)
      .filter(line => /^\s*(?:import |from |package |use |#include)/.test(line)).join("\n");
    const query = imports + "\n" + source.slice(Math.max(0, offset - 512), offset + 80);
    const recent = [...this.recent.entries()].reverse().find(([uri, item]) => uri !== key &&
      vscode.workspace.getWorkspaceFolder(item.uri)?.uri.toString() === folder.uri.toString());
    const candidates = [
      this.indexes.get(folder.uri.toString())?.then(entry => entry.index.search(
        query, vscode.workspace.asRelativePath(document.uri, false), 2,
      )) ?? Promise.resolve([]),
      this.definition(document, position, folder).catch(() => undefined),
    ] as const;
    const [retrieved, definition] = await Promise.all(candidates);
    return [...(definition ? [definition] : []), ...retrieved, ...(recent ? [recent[1].snippet] : [])];
  }

  dispose(): void {
    for (const subscription of this.watched) subscription.dispose();
    this.indexes.clear();
    this.recent.clear();
  }
}
