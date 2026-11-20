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
exports.WorkspaceContext = void 0;
const vscode = __importStar(require("vscode"));
const bm25_1 = require("./bm25");
const sources = "**/*.{py,pyi,ts,tsx,js,jsx,rs,go,java,c,h,cpp,hpp}";
const exclusions = "**/{.git,.venv,node_modules,vendor,dist,build,target}/**";
const maxFileBytes = 64_000;
class WorkspaceContext {
    indexes = new Map();
    recent = new Map();
    watched;
    constructor() {
        const watcher = vscode.workspace.createFileSystemWatcher(sources);
        const invalidate = (uri) => {
            const folder = vscode.workspace.getWorkspaceFolder(uri);
            if (folder)
                this.indexes.delete(folder.uri.toString());
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
                if (!folder || !last || !vscode.workspace.isTrusted)
                    return;
                const first = Math.max(0, last.range.start.line - 3);
                const end = Math.min(document.lineCount - 1, first + 12);
                const key = document.uri.toString();
                this.recent.delete(key);
                this.recent.set(key, {
                    uri: document.uri,
                    snippet: { path: vscode.workspace.asRelativePath(document.uri, false),
                        text: document.getText(new vscode.Range(first, 0, end, 0)).slice(0, 512) },
                });
                if (this.recent.size > 12)
                    this.recent.delete(this.recent.keys().next().value);
            }),
        ];
    }
    async index(folder) {
        const files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, sources), exclusions, 80);
        const texts = await Promise.all(files.map(async (uri) => {
            try {
                const metadata = await vscode.workspace.fs.stat(uri);
                if (metadata.type !== vscode.FileType.File || metadata.size > maxFileBytes)
                    return [];
                const source = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
                const lines = source.split(/\r?\n/);
                const path = vscode.workspace.asRelativePath(uri, false);
                return Array.from({ length: Math.min(20, Math.ceil(lines.length / 20)) }, (_, i) => ({
                    path, text: lines.slice(i * 20, i * 20 + 24).join("\n").slice(0, 1200),
                }));
            }
            catch {
                return [];
            }
        }));
        return { index: new bm25_1.BM25(texts.flat()), expires: Date.now() + 60_000 };
    }
    async warm(document) {
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!folder || !vscode.workspace.isTrusted)
            return;
        const key = folder.uri.toString();
        const ready = await this.indexes.get(key);
        if (ready && ready.expires > Date.now())
            return;
        const pending = this.index(folder);
        this.indexes.set(key, pending);
        try {
            await pending;
        }
        catch {
            if (this.indexes.get(key) === pending)
                this.indexes.delete(key);
        }
    }
    async definition(document, position, folder) {
        const before = document.lineAt(position.line).text.slice(0, position.character);
        const symbol = [...before.matchAll(/[$\p{L}_][$\p{L}\p{N}_]*/gu)].at(-1);
        if (!symbol)
            return;
        const target = new vscode.Position(position.line, (symbol.index ?? 0) + symbol[0].length - 1);
        const locations = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", document.uri, target);
        const location = locations?.[0];
        if (!location)
            return;
        const uri = "targetUri" in location ? location.targetUri : location.uri;
        const range = "targetRange" in location ? location.targetRange : location.range;
        if (uri.toString() === document.uri.toString() ||
            vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() !== folder.uri.toString())
            return;
        const metadata = await vscode.workspace.fs.stat(uri);
        if (metadata.type !== vscode.FileType.File || metadata.size > maxFileBytes)
            return;
        const targetDocument = await vscode.workspace.openTextDocument(uri);
        const line = targetDocument.lineAt(range.start.line);
        return { path: vscode.workspace.asRelativePath(uri, false), text: line.text.trim().slice(0, 240) };
    }
    async retrieve(document, position) {
        if (!vscode.workspace.isTrusted)
            return [];
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!folder)
            return [];
        const key = document.uri.toString();
        const source = document.getText();
        const offset = document.offsetAt(position);
        const imports = source.slice(0, 2000).split(/\r?\n/)
            .filter(line => /^\s*(?:import |from |package |use |#include)/.test(line)).join("\n");
        const query = imports + "\n" + source.slice(Math.max(0, offset - 512), offset + 80);
        const recent = [...this.recent.entries()].reverse().find(([uri, item]) => uri !== key &&
            vscode.workspace.getWorkspaceFolder(item.uri)?.uri.toString() === folder.uri.toString());
        const candidates = [
            this.indexes.get(folder.uri.toString())?.then(entry => entry.index.search(query, vscode.workspace.asRelativePath(document.uri, false), 2)) ?? Promise.resolve([]),
            this.definition(document, position, folder).catch(() => undefined),
        ];
        const [retrieved, definition] = await Promise.all(candidates);
        return [...(definition ? [definition] : []), ...retrieved, ...(recent ? [recent[1].snippet] : [])];
    }
    dispose() {
        for (const subscription of this.watched)
            subscription.dispose();
        this.indexes.clear();
        this.recent.clear();
    }
}
exports.WorkspaceContext = WorkspaceContext;
