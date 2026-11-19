import * as vscode from "vscode";
import type { InstalledModel } from "../registry/download";

export const dashboardId = "tinycoders.dashboard";

interface DashboardState {
  trusted: boolean;
  language?: string;
  active?: InstalledModel;
  models: readonly InstalledModel[];
}

class Row extends vscode.TreeItem {
  constructor(
    id: string, label: string, icon: string, command?: vscode.Command,
    readonly children: Row[] = [],
  ) {
    super(label, children.length ? vscode.TreeItemCollapsibleState.Expanded :
      vscode.TreeItemCollapsibleState.None);
    this.id = id;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.command = command;
  }
}

function action(label: string, icon: string, command: string, args?: unknown[]): Row {
  return new Row(command, label, icon, { title: label, command, arguments: args });
}

export class Dashboard implements vscode.TreeDataProvider<Row>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly state: () => DashboardState) {}

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(row: Row): Row {
    return row;
  }

  getChildren(row?: Row): Row[] {
    if (row) return row.children;
    const { trusted, language, active, models } = this.state();
    const status = new Row("routing", active?.manifest.id ??
      (language ? "No matching model" : "Open a source file"), active ? "chip" : "info");
    status.description = language;
    if (active) status.tooltip = `Inline completion model for ${language}`;
    const current = trusted
      ? [status, ...(language ? [action("Choose Routing Model…", "pin", "tinycoders.pickModel")] : [])]
      : [action("Manage Workspace Trust…", "shield", "workbench.trust.manage")];

    const available = models.map(model => {
      const manifest = model.manifest;
      const local = manifest.quant === "local";
      const item = new Row(`model:${manifest.id}:${manifest.version}`, manifest.id, model === active ? "check" : "chip");
      item.description = `${manifest.language_ids.join(", ")} · ${local ? "Local GGUF" : manifest.version}`;
      item.tooltip = `${manifest.id} · ${manifest.capabilities.join(", ")} · ${Math.ceil(manifest.size_bytes / 1_000_000)} MB`;
      return item;
    });
    const modelActions = trusted ? [
      action("Add Local GGUF…", "folder-opened", "tinycoders.addLocalModel"),
      action("Install From Registry…", "cloud-download", "tinycoders.installModel"),
      ...(models.some(model => model.manifest.quant !== "local")
        ? [action("Switch Installed Version…", "history", "tinycoders.switchVersion")] : []),
    ] : [];

    return [
      new Row("editor", "Current Editor", "file-code", undefined, current),
      ...(available.length || modelActions.length
        ? [new Row("models", "Models", "database", undefined, [...available, ...modelActions])] : []),
      ...(trusted && language ? [new Row("code", "Code Actions", "code", undefined, [
        action("Open TinyCoders Chat", "comment-discussion", "tinycoders.openChat"),
        action("Explain Code", "book", "tinycoders.explain"),
        action("Refactor Code", "replace", "tinycoders.refactor"),
        action("Write Tests", "beaker", "tinycoders.writeTests"),
      ])] : []),
      new Row("tools", "Tools", "tools", undefined, [
        action("Settings", "gear", "workbench.action.openSettings", ["@ext:tinycoders.tinycoders"]),
        action("Show Output", "output", "tinycoders.showOutput"),
        action("Export Local Metrics…", "graph", "tinycoders.exportMetrics"),
      ]),
    ];
  }

  dispose(): void {
    this.changed.dispose();
  }
}
