import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { InstalledModel } from "../registry/download";
import { dashboardHtml, renderDashboard } from "./dashboardHtml";

export const dashboardId = "tinycoders.dashboard";

export interface DashboardState {
  trusted: boolean;
  language?: string;
  active?: InstalledModel;
  models: readonly InstalledModel[];
}

const editorActions = [
  { id: "ask", label: "Ask TinyCoders…", command: "tinycoders.ask" },
  { id: "chat", label: "Open Chat", command: "tinycoders.openChat" },
  { id: "complete", label: "Trigger Completion", command: "tinycoders.triggerCompletion" },
  { id: "explain", label: "Explain Code", command: "tinycoders.explain" },
  { id: "refactor", label: "Refactor Code", command: "tinycoders.refactor" },
  { id: "test", label: "Write Tests", command: "tinycoders.writeTests" },
];

function actions({ trusted, language, models }: DashboardState) {
  return {
    routing: !trusted
      ? [{ id: "trust", label: "Manage Workspace Trust…", command: "workbench.trust.manage" }]
      : language ? [{ id: "route", label: "Choose Routing Model…", command: "tinycoders.pickModel" }] : [],
    editor: trusted && language ? editorActions : [],
    models: trusted ? [
      { id: "add", label: "Add Local GGUF…", command: "tinycoders.addLocalModel" },
      { id: "install", label: "Install From Registry…", command: "tinycoders.installModel" },
      ...(models.some(model => model.manifest.quant !== "local")
        ? [{ id: "version", label: "Switch Version…", command: "tinycoders.switchVersion" }] : []),
    ] : [],
    tools: [
      { id: "settings", label: "Settings", command: "workbench.action.openSettings",
        args: ["@ext:tinycoders.tinycoders"] },
      { id: "output", label: "Show Output", command: "tinycoders.showOutput" },
      { id: "metrics", label: "Export Local Metrics…", command: "tinycoders.exportMetrics" },
    ],
  };
}

export class Dashboard implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private subscriptions: vscode.Disposable[] = [];
  private markup?: string;

  constructor(
    private readonly state: () => DashboardState,
    private readonly reportError: (error: unknown) => void,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.dispose();
    this.view = view;
    const { webview } = view;
    webview.options = { enableScripts: true, localResourceRoots: [] };
    this.subscriptions = [
      view.onDidDispose(() => this.dispose()),
      webview.onDidReceiveMessage((message: unknown) => {
        if (typeof message !== "string") return;
        if (message === "ready") {
          this.markup = undefined;
          this.refresh();
          return;
        }
        const action = Object.values(actions(this.state())).flat().find(item => item.id === message);
        if (action) {
          const args = "args" in action ? action.args : [];
          void vscode.commands.executeCommand(action.command, ...(args ?? [])).then(undefined, this.reportError);
        }
      }),
    ];
    const state = this.state();
    this.markup = renderDashboard(state, actions(state));
    webview.html = dashboardHtml(this.markup, randomBytes(16).toString("hex"));
  }

  refresh(): void {
    if (!this.view) return;
    const state = this.state();
    const markup = renderDashboard(state, actions(state));
    if (markup === this.markup) return;
    this.markup = markup;
    void this.view.webview.postMessage(markup);
  }

  dispose(): void {
    this.view = undefined;
    this.markup = undefined;
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
  }
}
