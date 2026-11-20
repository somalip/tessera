import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import * as vscode from "vscode";
import type { InstalledModel } from "../registry/download";
import { builtInModels } from "../registry/catalog";
import { stageCapabilities, workflowLanguage, type Stage, type Workflow, type Workflows } from "../router/workflow";

const stageLabels: Record<Stage, string> = {
  router: "Router", autocomplete: "Autocomplete", parser: "Comment parser", generator: "Generator",
};
const stageDefaults: Record<Stage, string> = {
  router: "Language rules", autocomplete: "Choose autocomplete model", parser: "Pass comment through",
  generator: "Choose generator model",
};

function modelLabel({ manifest, path }: Pick<InstalledModel, "manifest" | "path">): string {
  if (manifest.quant === "local") return vscode.Uri.file(path).path.split("/").at(-1) ?? manifest.id;
  return builtInModels.find(model => model.id === manifest.id)?.label ??
    (manifest.id.startsWith("hf-") ? `${manifest.base_model} · ${manifest.quant}` : manifest.id);
}

export const cppFineTunedAutocomplete = "cpp-autocomplete.IQ4_NL.gguf";

const presets: Array<{ id: string; label: string; detail: string; workflow: Workflow }> = [
  { id: "coding", label: "Coding pair", detail: "Qwen Coder autocomplete and code generation.",
    workflow: { router: "", autocomplete: "qwen-coder-autocomplete", parser: "", generator: "qwen-coder-chat" } },
  { id: "routed", label: "Routed coding", detail: "SmolLM2 routes comments through a Qwen Coder parser when needed.",
    workflow: { router: "smollm2-router", autocomplete: "qwen-coder-autocomplete",
      parser: "qwen-coder-autocomplete", generator: "qwen-coder-chat" } },
  { id: "chat", label: "General writing and chat", detail: "Qwen3 handles chat and text editing.",
    workflow: { router: "", autocomplete: "", parser: "", generator: "qwen3-small" } },
  { id: "cpp", label: "C++ generation with Qwen autocomplete", detail: "Use your linked C++ generator with Qwen Coder autocomplete.",
    workflow: { router: "", autocomplete: "qwen-coder-autocomplete", parser: "", generator: "cpp-local" } },
  { id: "cpp-pair", label: "Fine-tuned C++ pair", detail: "Link the fine-tuned C++ autocomplete GGUF and pair it with your C++ generator.",
    workflow: { router: "", autocomplete: "", parser: "", generator: "cpp-local" } },
];

export class WorkflowPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;

  constructor(
    private readonly models: () => readonly InstalledModel[],
    private readonly workflows: () => Workflows,
    private readonly save: (language: string, value: unknown) => Promise<void>,
  ) {}

  open(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const languageAtOpen = vscode.window.activeTextEditor?.document.languageId;
    const panel = vscode.window.createWebviewPanel("tessera.workflow", "Tessera Models & Workflow", vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true });
    this.panel = panel;
    panel.onDidDispose(() => { this.panel = undefined; });
    panel.webview.onDidReceiveMessage((message: unknown) => {
      if (!message || typeof message !== "object") return;
      const { action, language, value } = message as Record<string, unknown>;
      if (action === "ready") {
        this.refresh(languageAtOpen);
        return;
      }
      void this.receive(action, language, value).catch(error => {
        void panel.webview.postMessage({ action, error: error instanceof Error ? error.message : String(error) });
      });
    });
    panel.webview.html = html(randomBytes(16).toString("hex"));
  }

  refresh(language?: string): void {
    if (!this.panel) return;
    const models = this.models().map(({ manifest, path }) => ({
      id: manifest.id, label: modelLabel({ manifest, path }),
      size: Math.ceil(manifest.size_bytes / 1_000_000), capabilities: manifest.capabilities,
      version: manifest.quant === "local" ? "Linked GGUF" : manifest.version,
      languages: manifest.vscode_language_ids,
    }));
    void this.panel.webview.postMessage({
      state: { models, language, workflows: this.workflows(), trusted: vscode.workspace.isTrusted,
        catalog: builtInModels.map(model => ({ id: model.id, label: model.label, size: Math.ceil(model.size_bytes / 1_000_000),
          capabilities: model.upstreamManifest?.capabilities ?? [] })) },
    });
  }

  private async receive(action: unknown, language: unknown, value: unknown): Promise<void> {
    if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace to manage models and workflows.");
    if (action === "save" || action === "reset") {
      const route = workflowLanguage(language);
      if (!route) throw new Error("Enter a language ID such as cpp or python, or use * for the default workflow.");
      await this.save(route, action === "reset" ? undefined : value);
      void this.panel?.webview.postMessage({ saved: route, action });
    } else if (action === "download" && (value === "@all" || builtInModels.some(model => model.id === value))) {
      await vscode.commands.executeCommand("tessera.installModel", value);
    } else if (action === "browse" && typeof value === "string") {
      await vscode.commands.executeCommand("tessera.browseModels", value);
    } else if (action === "test" && typeof value === "string") {
      await vscode.commands.executeCommand("tessera.testModel", value);
    } else if (action === "pick-stage") {
      const route = workflowLanguage(language);
      if (!route || typeof value !== "string" || !Object.hasOwn(stageCapabilities, value)) {
        throw new Error("Choose a workflow language and stage.");
      }
      const stage = value as Stage;
      const items = this.models().filter(model => model.manifest.capabilities.includes(stageCapabilities[stage]))
        .map(model => ({
          label: modelLabel(model), description: `${Math.ceil(model.manifest.size_bytes / 1_000_000)} MB`,
          detail: model.manifest.id, id: model.manifest.id,
        }));
      const selected = await vscode.window.showQuickPick([
        { label: stage === "router" || stage === "parser" ? stageDefaults[stage] : "Disconnect stage", id: "" },
        ...items,
      ], { title: `Tessera · ${stageLabels[stage]}`, placeHolder: "Search compatible installed models" });
      void this.panel?.webview.postMessage({ action, language: route, stage, selected: selected?.id });
    } else if (action === "preset") {
      const route = workflowLanguage(language);
      if (!route) throw new Error("Choose a workflow language.");
      const installed = new Set(this.models().map(model => model.manifest.id));
      const cppAutocomplete = () => this.models().find(model => basename(model.path) === cppFineTunedAutocomplete &&
        model.manifest.capabilities.includes("fim"));
      const items = presets.filter(preset => !preset.id.startsWith("cpp") || installed.has("cpp-local")).map(preset => {
        const required = new Set(Object.values(preset.workflow).filter(Boolean));
        const downloads = builtInModels.filter(model => required.has(model.id) && !installed.has(model.id));
        const size = Math.ceil(downloads.reduce((bytes, entry) => bytes + entry.size_bytes, 0) / 1_000_000);
        return { label: preset.label, detail: preset.detail,
          description: size ? `Download ${size} MB` : preset.id === "cpp-pair" && !cppAutocomplete()
            ? "Link local GGUF" : "Ready to preview", preset, downloads };
      });
      const choice = await vscode.window.showQuickPick(items, {
        title: "Tessera · Workflow presets", placeHolder: "Choose a starting point", matchOnDetail: true,
      });
      if (choice?.downloads.length) {
        await vscode.commands.executeCommand("tessera.installModel", choice.downloads.map(model => model.id));
        const available = new Set(this.models().map(model => model.manifest.id));
        if (Object.values(choice.preset.workflow).some(id => id && !available.has(id))) {
          throw new Error("The preset is waiting on model downloads. Choose it again to retry.");
        }
      }
      if (choice?.preset.id === "cpp-pair") {
        if (!cppAutocomplete()) await vscode.commands.executeCommand("tessera.linkCppPresetModel");
        const model = cppAutocomplete();
        void this.panel?.webview.postMessage({ action, language: "cpp",
          preset: model && { ...choice.preset.workflow, autocomplete: model.manifest.id } });
        return;
      }
      void this.panel?.webview.postMessage({ action, preset: choice?.preset.workflow, language: route });
    } else if (action === "registry") {
      await vscode.commands.executeCommand("tessera.installModel", "@registry");
    } else if (action === "import") {
      await vscode.commands.executeCommand("tessera.importModels");
    } else if (action === "manage") {
      await vscode.commands.executeCommand("tessera.manageModels");
    }
  }

  dispose(): void {
    this.panel?.dispose();
  }
}

function html(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>Tessera Models &amp; Workflow</title>
<style nonce="${nonce}">
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body { margin: 0; padding: 0; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background);
    font: var(--vscode-font-size, 13px)/1.45 var(--vscode-font-family, sans-serif); }
  main { max-width: 1120px; padding: 0 clamp(12px, 3vw, 32px) 24px; margin: auto; }
  header { position: sticky; top: 0; z-index: 2; padding-top: 8px; background: var(--vscode-editor-background); }
  nav, .actions, .controls { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  nav { gap: 14px; border-bottom: 1px solid var(--vscode-panel-border); }
  nav button { border: 0; border-radius: 0; border-bottom: 1px solid transparent; margin-bottom: -1px;
    padding: 6px 4px; color: var(--vscode-descriptionForeground); }
  nav button[aria-selected="true"] { color: var(--vscode-editor-foreground);
    border-bottom-color: var(--vscode-panelTitle-activeBorder, var(--vscode-focusBorder)); }
  .toolbar { min-height: 43px; display: flex; justify-content: space-between; align-items: center;
    flex-wrap: wrap; gap: 6px 14px; padding: 6px 0; border-bottom: 1px solid var(--vscode-panel-border); }
  .toolbar input { width: 104px; }
  .status, p { color: var(--vscode-descriptionForeground); margin: 0; }
  .error { color: var(--vscode-errorForeground); margin: 6px 0; }
  .error:empty { display: none; }
  input, button { font: inherit; min-height: 24px; border-radius: 2px; }
  input { color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding: 2px 6px; }
  button { border: 1px solid transparent; padding: 2px 7px; cursor: pointer; color: inherit; background: transparent; }
  button:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
  button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background);
    border-color: var(--vscode-button-border, transparent); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: .55; cursor: default; }
  :focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  h2 { font-size: 1em; font-weight: 600; margin: 0; }
  .browse, .section-heading { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 12px 0 6px; }
  .section-heading { justify-content: space-between; }
  .browse input { flex: 1; min-width: min(220px, 100%); }
  .rows { border-block-start: 1px solid var(--vscode-panel-border); }
  .row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(135px, .7fr) auto; align-items: center;
    padding: 4px 6px; min-height: 31px; gap: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row strong { font-weight: 500; overflow-wrap: anywhere; }
  .row p { font-size: .92em; }
  .row button { justify-self: end; white-space: nowrap; }
  .graph { display: grid; grid-template-columns: minmax(115px, .85fr) 32px minmax(125px, 1fr) 26px minmax(125px, 1fr);
    grid-template-rows: repeat(2, minmax(62px, auto)); align-items: stretch; row-gap: 12px;
    margin: 12px 0; padding: 12px; border: 1px solid var(--vscode-panel-border);
    background: var(--vscode-editor-background); }
  .router { grid-column: 1; grid-row: 1 / 3; align-self: center; }
  .auto { grid-column: 3 / 6; grid-row: 1; }
  .parser { grid-column: 3; grid-row: 2; }
  .generator { grid-column: 5; grid-row: 2; }
  .node { min-width: 0; padding: 6px; border-radius: 3px;
    border: 1px solid var(--vscode-panel-border); background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); }
  .node h2 { padding: 0 4px 4px; }
  .node button { display: flex; align-items: start; justify-content: space-between; gap: 4px;
    text-align: start; width: 100%; overflow-wrap: anywhere; padding: 3px 4px;
    color: var(--vscode-descriptionForeground); }
  .node button::after { content: "›"; font-weight: 600; }
  .node[data-connected="true"] button { color: var(--vscode-editor-foreground); }
  .node[data-drop="true"] { outline: 2px dashed var(--vscode-focusBorder); }
  #branch { grid-column: 2; grid-row: 1 / 3; position: relative; }
  #branch::before { content: ""; position: absolute; top: 50%; left: 0; width: 39%;
    border-top: 1px solid var(--vscode-descriptionForeground); opacity: .65; }
  #branch::after { content: ""; position: absolute; top: calc(25% - 3px); bottom: calc(25% - 3px);
    left: 38%; border-left: 1px solid var(--vscode-descriptionForeground); opacity: .65; }
  .wire { position: relative; align-self: center; border-top: 1px dashed currentColor;
    color: var(--vscode-descriptionForeground); opacity: .65; }
  .wire::after { content: ""; width: 5px; height: 5px; position: absolute; inset: -3px 1px auto auto;
    border-right: 1px solid currentColor; border-top: 1px solid currentColor; transform: rotate(45deg); }
  .wire[data-connected="true"] { color: var(--vscode-textLink-foreground); border-top-style: solid; opacity: 1; }
  #to-auto { grid-column: 2; grid-row: 1; margin-left: 38%; }
  #to-parser { grid-column: 2; grid-row: 2; margin-left: 38%; }
  #to-generator { grid-column: 4; grid-row: 2; }
  .palette { display: flex; flex-wrap: wrap; gap: 4px; margin-block: 6px; }
  .palette span { padding: 2px 6px; border: 1px solid var(--vscode-panel-border); border-radius: 2px;
    cursor: grab; overflow-wrap: anywhere; }
  .palette span:hover { background: var(--vscode-list-hoverBackground); }
  details { margin: 10px 0; }
  summary { cursor: pointer; color: var(--vscode-descriptionForeground); }
  details p { margin: 5px 0; }
  @media (max-width: 530px) {
    .graph { grid-template-columns: minmax(0, .85fr) 16px minmax(0, 1fr) 16px minmax(0, 1fr);
      padding: 6px; row-gap: 8px; }
    .node { padding: 3px; overflow-wrap: anywhere; }
    .row { grid-template-columns: minmax(0, 1fr) auto; }
    .row p { grid-row: 2; }
    .row button { grid-area: 1 / 2 / 3 / 3; }
  }
</style>
</head>
<body>
<main>
  <header>
    <nav role="tablist" aria-label="Tessera editors">
      <button id="workflow-tab" role="tab" aria-selected="true" aria-controls="workflow">Workflow</button>
      <button id="library-tab" role="tab" aria-selected="false" aria-controls="library" tabindex="-1">Models</button>
    </nav>
    <div id="workflow-toolbar" class="toolbar">
      <div class="controls">
        <label for="language">Language</label>
        <input id="language" list="languages" maxlength="64" value="*" spellcheck="false" />
        <datalist id="languages"></datalist>
        <span id="status" class="status" role="status"></span>
      </div>
      <div class="actions">
        <button id="preset" disabled>Presets…</button>
        <button id="reset" disabled title="Restore automatic routing for this language">Reset</button>
        <button class="primary" id="save" disabled>Save workflow</button>
      </div>
    </div>
    <p id="workflow-error" class="error" role="alert"></p>
  </header>
  <section id="workflow" role="tabpanel" aria-labelledby="workflow-tab">
    <div class="graph" aria-label="Routing graph">
      <div class="node router"><h2>Router</h2><button id="router" disabled aria-label="Choose router model"></button></div>
      <span id="branch" aria-hidden="true"></span>
      <span class="wire" id="to-auto" aria-hidden="true"></span>
      <div class="node auto"><h2>Autocomplete</h2><button id="autocomplete" disabled aria-label="Choose autocomplete model"></button></div>
      <span class="wire" id="to-parser" aria-hidden="true"></span>
      <div class="node parser"><h2>Comment parser</h2><button id="parser" disabled aria-label="Choose comment parser model"></button></div>
      <span class="wire" id="to-generator" aria-hidden="true"></span>
      <div class="node generator"><h2>Generator</h2><button id="generator" disabled aria-label="Choose generator model"></button></div>
    </div>
    <details><summary>Drag installed models to nodes</summary>
      <div class="palette" id="palette" aria-label="Draggable models"></div>
    </details>
    <details><summary>Routing help</summary>
      <p>Use a language ID such as cpp or python, or * as the default.</p>
      <p>The router model decides if an inline comment needs parsing. Language rules use the connected parser for every comment. Chat and edits go directly to the generator.</p>
    </details>
  </section>
  <section id="library" role="tabpanel" aria-labelledby="library-tab" hidden>
    <p id="library-error" class="error" role="alert"></p>
    <form id="browse" class="browse">
      <input id="model-query" aria-label="Search Hugging Face" maxlength="300"
        placeholder="Search Hugging Face or paste a model URL" required>
      <button type="submit" class="primary" id="browse-button">Find models</button>
    </form>
    <div class="actions">
      <button data-action="import">Add GGUF files…</button>
      <button data-action="registry">Browse signed registry…</button>
      <button data-action="manage">Manage installed models…</button>
    </div>
    <div class="section-heading"><h2>Installed</h2>
      <input id="model-filter" aria-label="Filter installed models" placeholder="Filter installed models">
    </div>
    <div class="rows" id="models"></div>
    <div class="section-heading"><h2>Recommended downloads</h2><button id="download-all">Download all</button></div>
    <div class="rows" id="catalog"></div>
  </section>
</main>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const get = id => document.getElementById(id);
  const caps = ${JSON.stringify(stageCapabilities)};
  const empty = () => ({ router: '', autocomplete: '', parser: '', generator: '' });
  const defaults = ${JSON.stringify(stageDefaults)};
  let state, language = '', drafts = new Map(), saving = false;
  const option = (label, value) => new Option(label, value);
  const saved = () => Object.hasOwn(state.workflows, language) ? state.workflows[language] : undefined;
  const inherited = () => language !== "*" && state.workflows["*"];
  const selection = () => drafts.get(language) || saved() || inherited() || empty();
  const workflowError = text => { get('workflow-error').textContent = text; };
  const libraryError = text => { get('library-error').textContent = text; };
  const normalizeLanguage = ${workflowLanguage.toString()};
  let confirmation = '', loadingPreset = false, picking = false;
  const tabs = ['workflow', 'library'];
  function selectTab(tab) {
    for (const id of tabs) {
      const selected = id === tab;
      get(id).hidden = !selected;
      get(id + '-tab').setAttribute('aria-selected', String(selected));
      get(id + '-tab').tabIndex = selected ? 0 : -1;
    }
    get('workflow-toolbar').hidden = tab !== 'workflow';
    get('workflow-error').hidden = tab !== 'workflow';
  }
  for (const tab of tabs) {
    const button = get(tab + '-tab');
    button.addEventListener('click', () => selectTab(tab));
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : tabs.find(id => id !== tab);
      selectTab(next);
      get(next + '-tab').focus();
    });
  }
  function modelRow(model, button) {
    const div = document.createElement('div');
    div.className = 'row';
    const title = document.createElement('strong');
    title.textContent = model.label || model.id;
    const details = document.createElement('p');
    const capability = { fim: 'Autocomplete / parser', chat: 'Generation / chat', edit: 'Edits' };
    details.textContent = [model.version, model.size + ' MB', ...model.capabilities.map(cap => capability[cap])].filter(Boolean).join(' · ');
    div.append(title, details);
    if (button) div.append(button);
    return div;
  }
  function renderInstalled() {
    const query = get('model-filter').value.trim().toLowerCase();
    const matching = state.models.filter(model => [model.id, model.label, ...model.capabilities].join(' ').toLowerCase().includes(query));
    get('models').replaceChildren(...matching.map(model => {
      const button = document.createElement('button');
      button.textContent = 'Test inference';
      button.disabled = !state.trusted;
      button.addEventListener('click', () => vscode.postMessage({ action: 'test', value: model.id }));
      return modelRow(model, button);
    }));
    if (!matching.length) get('models').textContent = query ? 'No matching installed models.' : 'Add or download a model to start.';
  }
  function renderLibrary() {
    renderInstalled();
    get('browse-button').disabled = !state.trusted;
    get('catalog').replaceChildren(...state.catalog.map(model => {
      const button = document.createElement('button');
      const installed = state.models.some(item => item.id === model.id);
      button.textContent = installed ? 'Installed' : 'Download';
      button.disabled = installed || !state.trusted;
      button.addEventListener('click', () => vscode.postMessage({ action: 'download', value: model.id }));
      return modelRow(model, button);
    }));
    get('library').querySelectorAll('[data-action]').forEach(button => { button.disabled = !state.trusted; });
    const count = state.catalog.filter(model => !state.models.some(item => item.id === model.id)).length;
    get('download-all').hidden = count < 2;
    get('download-all').disabled = !state.trusted;
    get('palette').replaceChildren(...state.models.map(model => {
      const chip = document.createElement('span');
      chip.textContent = model.label;
      chip.draggable = state.trusted;
      chip.addEventListener('dragstart', event => {
        event.dataTransfer.setData('application/x-tessera-model', model.id);
        event.dataTransfer.effectAllowed = 'link';
      });
      return chip;
    }));
  }
  function renderGraph() {
    const values = selection();
    for (const stage of Object.keys(caps)) {
      const button = get(stage);
      const model = state.models.find(item => item.id === values[stage]);
      const label = model?.label || (values[stage] ? 'Unavailable' : defaults[stage]);
      button.textContent = label;
      button.title = model?.label || values[stage] || defaults[stage];
      button.setAttribute('aria-label', button.closest('.node').querySelector('h2').textContent + ' · ' + label);
      button.disabled = !state.trusted || saving || picking;
      button.closest('.node').dataset.connected = String(Boolean(model));
    }
    get('to-auto').dataset.connected = String(Boolean(values.autocomplete));
    get('to-parser').dataset.connected = get('to-generator').dataset.connected = String(Boolean(values.generator));
    get('status').textContent = saving ? 'Saving…' : loadingPreset ? 'Preparing preset…' : confirmation ||
      (drafts.has(language) ? 'Unsaved changes' : saved() ? 'Custom route' : inherited() ? 'Uses default workflow' : 'Choose models to create a workflow');
    get('save').disabled = !state.trusted || saving;
    get('preset').disabled = !state.trusted || saving || loadingPreset || picking;
    get('reset').disabled = !state.trusted || saving || !saved();
    get('language').disabled = saving;
  }
  get('language').addEventListener('input', event => {
    language = normalizeLanguage(event.target.value) || event.target.value.trim();
    confirmation = '';
    workflowError('');
    if (state) renderGraph();
  });
  function connect(stage, id, route = language) {
    const base = drafts.get(route) || (Object.hasOwn(state.workflows, route) ? state.workflows[route] : state.workflows['*']) || empty();
    drafts.set(route, { ...base, [stage]: id });
    confirmation = '';
    workflowError('');
    renderGraph();
  }
  for (const stage of Object.keys(caps)) {
    const button = get(stage);
    const node = button.closest('.node');
    button.addEventListener('click', () => {
      if (!state || picking) return;
      picking = true;
      workflowError('');
      renderGraph();
      vscode.postMessage({ action: 'pick-stage', language, value: stage });
    });
    node.addEventListener('dragover', event => {
      if (!state?.trusted || saving || !event.dataTransfer.types.includes('application/x-tessera-model')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'link';
      node.dataset.drop = 'true';
    });
    node.addEventListener('dragleave', () => { delete node.dataset.drop; });
    node.addEventListener('drop', event => {
      event.preventDefault();
      delete node.dataset.drop;
      if (!state?.trusted || saving) return;
      const id = event.dataTransfer.getData('application/x-tessera-model');
      if (state.models.some(model => model.id === id && model.capabilities.includes(caps[stage]))) connect(stage, id);
      else workflowError('This model does not support the ' + stage + ' node.');
    });
  }
  get('preset').addEventListener('click', () => {
    if (!state || loadingPreset) return;
    loadingPreset = true;
    workflowError('');
    renderGraph();
    vscode.postMessage({ action: 'preset', language });
  });
  get('model-filter').addEventListener('input', () => { if (state) renderInstalled(); });
  get('browse').addEventListener('submit', event => {
    event.preventDefault();
    libraryError('');
    const value = get('model-query').value.trim();
    if (value) vscode.postMessage({ action: 'browse', value });
  });
  get('download-all').addEventListener('click', () => vscode.postMessage({ action: 'download', value: '@all' }));
  for (const action of ['save', 'reset']) get(action).addEventListener('click', () => {
    if (!state || saving) return;
    if (!normalizeLanguage(language)) {
      workflowError('Enter a language ID such as cpp or python, or use * for the default workflow.');
      return;
    }
    saving = true;
    confirmation = '';
    workflowError('');
    renderGraph();
    vscode.postMessage({ action, language, value: selection() });
  });
  get('library').querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => {
    libraryError('');
    vscode.postMessage({ action: button.dataset.action });
  }));
  window.addEventListener('message', ({ data }) => {
    if (data.state) {
      const first = !state;
      const libraryChanged = first || JSON.stringify(state.models) !== JSON.stringify(data.state.models) ||
        state.trusted !== data.state.trusted;
      state = data.state;
      if (first) get('language').value = language = state.language || '*';
      const languages = new Set(['*', language, ...(state.models.flatMap(model => model.languages)), ...Object.keys(state.workflows)]);
      get('languages').replaceChildren(...Array.from(languages).sort().map(id => option(id, id)));
      if (!state.trusted) {
        libraryError('Trust this workspace to manage models.');
        workflowError('Trust this workspace to save a workflow.');
      }
      if (libraryChanged) renderLibrary();
      renderGraph();
    }
    if (data.action === 'preset') {
      loadingPreset = false;
      if (data.preset) {
        drafts.set(data.language, data.preset);
        get('language').value = language = data.language;
        confirmation = 'Review the recommendation, then save';
      }
      workflowError(data.error || '');
      if (state) renderGraph();
    } else if (data.action === 'pick-stage') {
      picking = false;
      if (state && typeof data.selected === 'string' && Object.hasOwn(caps, data.stage)) {
        connect(data.stage, data.selected, data.language);
      }
      workflowError(data.error || '');
      if (state) renderGraph();
      if (data.stage && data.language === language) get(data.stage)?.focus();
    } else if (data.action === 'save' || data.action === 'reset') {
      saving = false;
      if (data.saved) {
        drafts.delete(data.saved);
        confirmation = data.action === 'reset' ? 'Workflow removed' : 'Saved for ' + (data.saved === '*' ? 'all other languages' : data.saved);
      }
      workflowError(data.error || '');
      if (state) renderGraph();
    } else if (data.error) libraryError(data.error);
  });
  vscode.postMessage({ action: 'ready' });
</script>
</body>
</html>`;
}
