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
exports.Dashboard = exports.dashboardId = void 0;
const node_crypto_1 = require("node:crypto");
const vscode = __importStar(require("vscode"));
const dashboardHtml_1 = require("./dashboardHtml");
exports.dashboardId = "tessera.dashboard";
const editorActions = [
    { id: "ask", label: "Ask Tessera…", command: "tessera.ask" },
    { id: "chat", label: "Open Chat", command: "tessera.openChat" },
    { id: "complete", label: "Trigger Completion", command: "tessera.triggerCompletion" },
    { id: "explain", label: "Explain Code", command: "tessera.explain" },
    { id: "refactor", label: "Refactor Code", command: "tessera.refactor" },
    { id: "test", label: "Write Tests", command: "tessera.writeTests" },
];
function actions({ trusted, language, models }) {
    return {
        routing: !trusted
            ? [{ id: "trust", label: "Manage Workspace Trust…", command: "workbench.trust.manage" }]
            : language ? [{ id: "route", label: "Choose Routing Model…", command: "tessera.pickModel" }] : [],
        editor: trusted && language ? editorActions : [],
        models: trusted ? [
            { id: "add", label: "Add Local GGUF…", command: "tessera.addLocalModel" },
            { id: "install", label: "Install From Registry…", command: "tessera.installModel" },
            ...(models.some(model => model.manifest.quant !== "local")
                ? [{ id: "version", label: "Switch Version…", command: "tessera.switchVersion" }] : []),
        ] : [],
        tools: [
            { id: "settings", label: "Settings", command: "workbench.action.openSettings",
                args: ["@ext:tessera.tessera"] },
            { id: "output", label: "Show Output", command: "tessera.showOutput" },
            { id: "metrics", label: "Export Local Metrics…", command: "tessera.exportMetrics" },
        ],
    };
}
class Dashboard {
    state;
    reportError;
    view;
    subscriptions = [];
    markup;
    constructor(state, reportError) {
        this.state = state;
        this.reportError = reportError;
    }
    resolveWebviewView(view) {
        this.dispose();
        this.view = view;
        const { webview } = view;
        webview.options = { enableScripts: true, localResourceRoots: [] };
        this.subscriptions = [
            view.onDidDispose(() => this.dispose()),
            webview.onDidReceiveMessage((message) => {
                if (typeof message !== "string")
                    return;
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
        this.markup = (0, dashboardHtml_1.renderDashboard)(state, actions(state));
        webview.html = (0, dashboardHtml_1.dashboardHtml)(this.markup, (0, node_crypto_1.randomBytes)(16).toString("hex"));
    }
    refresh() {
        if (!this.view)
            return;
        const state = this.state();
        const markup = (0, dashboardHtml_1.renderDashboard)(state, actions(state));
        if (markup === this.markup)
            return;
        this.markup = markup;
        void this.view.webview.postMessage(markup);
    }
    dispose() {
        this.view = undefined;
        this.markup = undefined;
        for (const subscription of this.subscriptions.splice(0))
            subscription.dispose();
    }
}
exports.Dashboard = Dashboard;
