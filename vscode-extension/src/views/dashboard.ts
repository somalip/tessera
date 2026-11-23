import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { SystemResources } from "../host/resources";
import type { InstalledModel } from "../registry/download";
import type { InlineRoute } from "../providers/inlineCompletion";
import type { LocalMetrics } from "../telemetry";
import { dashboardHtml, renderDashboard, renderResources } from "./dashboardHtml";

import { visibleSections, type SidebarSection } from "./sidebarSections";

export const dashboardId = "tessera.dashboard";

export interface DashboardState {
  trusted: boolean;
  advanced: boolean;
  sections?: readonly SidebarSection[];
  language?: string;
  active?: InstalledModel;
  lastInline?: InlineRoute;
  models: readonly InstalledModel[];
  usage: ReturnType<LocalMetrics["usage"]>;
}

const editorActions = [
  { id: "ask", label: "Ask Tessera…", command: "tessera.ask" },
  { id: "chat", label: "Open Chat", command: "tessera.openChat" },
  { id: "complete", label: "Trigger Completion", command: "tessera.triggerCompletion" },
  { id: "explain", label: "Explain Code", command: "tessera.explain" },
  { id: "refactor", label: "Refactor Code", command: "tessera.refactor" },
  { id: "rewrite", label: "Rewrite with Instructions…", command: "tessera.rewrite" },
  { id: "fix-diagnostics", label: "Fix Diagnostics", command: "tessera.fixDiagnostics" },
  { id: "test", label: "Write Tests", command: "tessera.writeTests" },
];

function actions({ trusted, language, advanced, sections }: DashboardState) {
  const visible = visibleSections(advanced, sections);
  return {
    routing: !visible.includes("routing") ? [] : !trusted
      ? [{ id: "trust", label: "Manage Workspace Trust…", command: "workbench.trust.manage" }]
      : language ? [
        { id: "route", label: "Choose Model…", command: "tessera.pickModel" },
        { id: "inspect-route", label: "Inspect Model Routing…", command: "tessera.inspectRoute" },
      ] : [],
    editor: trusted && visible.includes("editor") ? (advanced && language ? editorActions : editorActions.slice(0, 2)) : [],
    models: trusted && visible.includes("models") ? [
      { id: "workflow", label: "Models & Workflow", command: "tessera.openWorkflow" },
      { id: "install", label: "Download Models…", command: "tessera.installModel" },
      { id: "manage", label: "Manage Models…", command: "tessera.manageModels" },
      { id: "add", label: "Add Local GGUF…", command: "tessera.addLocalModel" },
    ] : [],
    tools: visible.includes("tools") ? [
      {
        id: "settings", label: "Settings", command: "workbench.action.openSettings",
        args: ["@ext:tessera.tessera"]
      },
      { id: "output", label: "Show Output", command: "tessera.showOutput" },
      { id: "metrics", label: "Export Local Metrics…", command: "tessera.exportMetrics" },
    ] : [],
  };
}

export class Dashboard implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private subscriptions: vscode.Disposable[] = [];
  private markup?: string;
  private polling?: AbortController;
  private nextSample?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly state: () => DashboardState,
    private readonly reportError: (error: unknown) => void,
    private readonly setAdvanced: (advanced: boolean) => PromiseLike<void>,
  ) { }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.dispose();
    this.view = view;
    const { webview } = view;
    webview.options = { enableScripts: true, localResourceRoots: [] };
    this.subscriptions = [
      view.onDidDispose(() => this.dispose()),
      view.onDidChangeVisibility(() => {
        if (view.visible) this.monitor(view);
        else this.stopMonitoring();
      }),
      webview.onDidReceiveMessage((message: unknown) => {
        if (typeof message !== "string") return;
        if (message === "ready") {
          this.markup = undefined;
          this.refresh();
          if (view.visible) this.monitor(view);
          return;
        }
        if (message === "simple" || message === "advanced") {
          void this.setAdvanced(message === "advanced").then(() => this.refresh(), this.reportError);
          return;
        }
        if (message === "customize-sidebar") {
          void vscode.commands.executeCommand("tessera.customizeSidebar").then(undefined, this.reportError);
          return;
        }
        const state = this.state();
        if (message === "resource-limits" && visibleSections(state.advanced, state.sections).includes("resources")) {
          void vscode.commands.executeCommand("tessera.resourceLimits").then(undefined, this.reportError);
          return;
        }
        const action = Object.values(actions(state)).flat().find(item => item.id === message);
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
    if (!visibleSections(state.advanced, state.sections).includes("resources")) this.stopMonitoring();
    else if (this.view.visible) this.monitor(this.view);
    if (markup === this.markup) return;
    this.markup = markup;
    void this.view.webview.postMessage(markup);
  }

  private monitor(view: vscode.WebviewView): void {
    const state = this.state();
    if (this.polling || !visibleSections(state.advanced, state.sections).includes("resources")) return;
    const controller = new AbortController();
    const { signal } = controller;
    this.polling = controller;
    const resources = new SystemResources();
    const poll = async () => {
      const sample = await resources.sample(signal);
      if (signal.aborted) return;
      void view.webview.postMessage({ resources: renderResources(sample) });
      this.nextSample = setTimeout(() => { void poll(); }, 2000);
    };
    void poll();
  }

  private stopMonitoring(): void {
    this.polling?.abort();
    this.polling = undefined;
    clearTimeout(this.nextSample);
  }

  dispose(): void {
    this.stopMonitoring();
    this.view = undefined;
    this.markup = undefined;
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
  }
}
