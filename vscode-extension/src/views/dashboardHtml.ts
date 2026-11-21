import { basename } from "node:path";
import type { ResourceSample } from "../host/resources";
import type { InlineRoute } from "../providers/inlineCompletion";
import type { DashboardState } from "./dashboard";

import { visibleSections } from "./sidebarSections";

interface Action {
  id: string;
  label: string;
}

interface Groups {
  routing: readonly Action[];
  editor: readonly Action[];
  models: readonly Action[];
  tools: readonly Action[];
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function buttons(actions: readonly Action[], primary?: string): string {
  if (!actions.length) return "";
  return `<div class="actions">${actions.map(({ id, label }) =>
    `<button type="button" data-action="${id}"${id === primary ? ' class="primary"' : ""}>${label}</button>`
  ).join("")}</div>`;
}

export function inlineRouteName(route: InlineRoute): string {
  if (route.model) return basename(route.model.path);
  return "No matching model";
}

export function renderDashboard({ trusted, advanced, language, active, lastInline, models, usage, sections }: DashboardState, groups: Groups): string {
  const visible = visibleSections(advanced, sections);
  const routed = lastInline?.model ?? active;
  const routing = !trusted ? "Workspace trust required" : (advanced && lastInline ? inlineRouteName(lastInline) : routed?.manifest.id) ??
    (language ? "No matching model" : "Open a source file");
  const routingDetail = !trusted ? "Trust this workspace to use local models and code actions."
    : advanced && lastInline ? `Last inline request · ${lastInline.mode}`
      : active ? "Automatic routing for this editor."
        : language ? "Download a compatible model or choose an installed one."
          : "Routing follows the language at your cursor.";
  const modelRows = models.map(model => {
    const { manifest } = model;
    const details = [
      manifest.language_ids.join(", "),
      manifest.quant === "local" ? "Local GGUF" : manifest.version,
      `${Math.ceil(manifest.size_bytes / 1_000_000)} MB`,
    ].filter(Boolean).join(" · ");
    const selected = trusted && routed?.manifest.id === manifest.id && routed.manifest.version === manifest.version;
    return `<li title="${escapeHtml(manifest.capabilities.join(", "))}">
      <div class="model-heading"><strong>${escapeHtml(manifest.id)}</strong>${selected ? '<span class="model-status">Routed</span>' : ""}</div>
      <div class="muted">${escapeHtml(details)}</div>
    </li>`;
  }).join("");

  return `<div class="mode-picker" role="group" aria-label="Sidebar controls" data-resources="${visible.includes("resources")}">
    <button type="button" data-action="simple" aria-pressed="${!advanced}">Simple</button>
    <button type="button" data-action="advanced" aria-pressed="${advanced}">Advanced</button>
    <button type="button" data-action="customize-sidebar" title="Choose visible sidebar sections">Customize…</button>
  </div>
  ${visible.includes("routing") ? `<section aria-labelledby="routing-heading">
    <h2 id="routing-heading">Current editor</h2>
    <div class="section-content">
      <div class="routing-heading">
        <strong>${escapeHtml(routing)}</strong>
        ${trusted && language ? `<span class="language">${escapeHtml(language)}</span>` : ""}
      </div>
      <p class="muted">${escapeHtml(routingDetail)}</p>
      ${trusted && advanced && lastInline?.model ? `<p class="muted" title="${escapeHtml(lastInline.model.path)}">${escapeHtml(lastInline.model.manifest.id)}</p>` : ""}
      ${trusted && advanced && lastInline?.parser ? `<p class="muted" title="${escapeHtml(lastInline.parser.path)}">Parsed by ${escapeHtml(basename(lastInline.parser.path))}</p>` : ""}
      ${buttons(groups.routing)}
    </div>
  </section>` : ""}
  ${groups.editor.length ? `<section aria-labelledby="editor-heading">
    <h2 id="editor-heading">Code actions</h2>
    <div class="section-content">${buttons(groups.editor, "ask")}</div>
  </section>` : ""}
  ${visible.includes("models") && (models.length || groups.models.length) ? `<section aria-labelledby="models-heading">
    <h2 id="models-heading">Installed models</h2>
    <div class="section-content">
      ${modelRows ? `<ul aria-labelledby="models-heading">${modelRows}</ul>` : '<p class="muted">No models installed.</p>'}
      ${groups.models.length ? `<div class="model-actions">${buttons(groups.models, "workflow")}</div>` : ""}
    </div>
  </section>` : ""}
  ${visible.includes("usage") ? renderUsage(usage, advanced) : ""}
  ${groups.tools.length ? `<section aria-labelledby="tools-heading">
    <h2 id="tools-heading">Tools</h2>
    <div class="section-content">${buttons(groups.tools)}</div>
  </section>` : ""}`;
}

function renderUsage(usage: DashboardState["usage"], advanced: boolean): string {
  const { requests, outputTokens, mostUsed, latestSpeed, completions } = usage;
  const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
  const count = (value: number) => number.format(value);
  const latency = (value: number | null) => value === null ? "—" : `${count(value)} ms`;
  const row = (label: string, value: string) => `<div class="usage-row"><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`;
  const acceptance = completions.acceptance_rate === null ? "—"
    : `${count(completions.acceptance_rate * 100)}% (${count(completions.accepted)} / ${count(completions.offered)})`;
  return `<section aria-labelledby="usage-heading">
    <h2 id="usage-heading">Session usage</h2>
    <div class="section-content">
      ${requests ? `<dl class="usage">
        ${row("Latest reported speed", latestSpeed ? `${count(latestSpeed.tokensPerSecond)} tok/s · ${latestSpeed.model}` : "Unavailable")}
        ${row("Most-used model", mostUsed ? `${mostUsed.model} · ${count(mostUsed.requests)} requests` : "—")}
        ${row("Completed model requests", count(requests))}
        ${row("Reported output tokens", outputTokens === null ? "Unavailable" : count(outputTokens))}
        ${row("Inline acceptance", acceptance)}
        ${advanced ? row("Inline first token (p95)", latency(completions.first_token_p95_ms)) +
        row("Inline completion latency (p95)", latency(completions.completed_request_p95_ms)) : ""}
      </dl>` : '<p class="muted">Usage appears after your first completed model request.</p>'}
    </div>
  </section>`;
}

export function renderResources(sample: ResourceSample): string {
  const row = (label: string, value: string, percent?: number) => `<div class="resource">
    <div class="resource-label"><span>${label}</span><span>${value}</span></div>
    ${percent === undefined ? "" : `<meter min="0" max="100" value="${percent}" aria-label="${label}"></meter>`}
  </div>`;
  const gib = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
  const { cpu, ramUsed, ramTotal, gpu } = sample;
  return row("CPU", cpu === undefined ? "Sampling…" : `${Math.round(cpu)}%`, cpu) +
    row("RAM (non-free)", `${gib(ramUsed)} / ${gib(ramTotal)} GiB`,
      ramTotal > 0 ? 100 * ramUsed / ramTotal : undefined) +
    (gpu.length ? gpu.map((value, index) =>
      row(gpu.length === 1 ? "GPU" : `GPU ${index + 1}`, `${value}%`, value)).join("")
      : row("GPU", "Unavailable"));
}

export function dashboardHtml(markup: string, nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>Tessera Dashboard</title>
  <style nonce="${nonce}">
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      background: var(--vscode-sideBar-background);
      color: var(--vscode-sideBar-foreground, var(--vscode-foreground));
      font: var(--vscode-font-size, 13px)/1.45 var(--vscode-font-family, sans-serif);
      overflow-wrap: anywhere;
    }
    main {
      --section-divider: var(--vscode-sideBarSectionHeader-border, var(--vscode-widget-border, transparent));
      padding-block: 4px 12px;
    }
    .mode-picker {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr)) auto;
      margin: 6px 12px 12px;
      gap: 2px;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-widget-border, transparent);
      border-radius: 4px;
      padding: 2px;
    }
    .mode-picker button { text-align: center; }
    .mode-picker button[aria-pressed="true"] {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    main:not(:has([data-resources="true"])) #resources { display: none; }
    h2 {
      margin: 0;
      padding: 5px 16px;
      border-block-start: 1px solid var(--section-divider);
      background: var(--vscode-sideBarSectionHeader-background);
      color: var(--vscode-sideBarSectionHeader-foreground, inherit);
      font-size: .85em;
      font-weight: 600;
      letter-spacing: .025em;
      text-transform: uppercase;
    }
    section:first-child h2 { border-block-start: 0; }
    .section-content { padding: 8px 12px 12px; }
    .routing-heading, .model-heading {
      display: flex;
      align-items: baseline;
      flex-wrap: wrap;
      gap: 2px 10px;
    }
    .routing-heading { justify-content: space-between; padding-inline: 4px; }
    .routing-heading strong { font-weight: 600; }
    .routing-heading + p, .section-content > p { margin: 3px 4px 6px; }
    .language, .muted, .model-status {
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
      font-size: .92em;
    }
    .language { font-family: var(--vscode-editor-font-family, monospace); }
    .model-status { white-space: nowrap; }
    .model-status::before {
      content: "";
      display: inline-block;
      width: 6px;
      height: 6px;
      margin-inline-end: 5px;
      border-radius: 50%;
      background: var(--vscode-testing-iconPassed, currentColor);
      vertical-align: .12em;
    }
    ul { list-style: none; padding: 0; margin: 0; }
    li { padding: 5px 4px; }
    li + li { border-block-start: 1px solid var(--section-divider); }
    .model-heading { justify-content: space-between; }
    .model-heading strong { font-weight: 600; }
    .model-actions { margin-block-start: 5px; }
    .usage { margin: 0 4px; }
    .usage-row { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 0 8px; padding-block: 3px; }
    .usage-row dd { margin: 0; font-variant-numeric: tabular-nums; }
    .resource { margin: 4px 4px 8px; }
    .resource-label { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 0 8px; }
    meter { display: block; width: 100%; height: 8px; margin-top: 3px; }
    meter::-webkit-meter-bar { border: 0; background: var(--vscode-scrollbarSlider-background); }
    meter::-webkit-meter-optimum-value { background: var(--vscode-progressBar-background); }
    .actions { display: grid; gap: 2px; }
    button {
      min-width: 0;
      min-height: 26px;
      padding: 3px 7px;
      border: 1px solid var(--vscode-contrastBorder, transparent);
      border-radius: 2px;
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: start;
      overflow-wrap: anywhere;
      cursor: pointer;
    }
    button:hover {
      background: var(--vscode-list-hoverBackground);
      color: var(--vscode-list-hoverForeground, inherit);
    }
    button.primary {
      margin-block: 2px 4px;
      border-color: var(--vscode-button-border, var(--vscode-contrastBorder, transparent));
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      text-align: center;
    }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    @media (min-width: 350px) {
      #editor-heading + .section-content .actions {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .actions .primary { grid-column: 1 / -1; }
    }
  </style>
</head>
<body>
  <main aria-label="Tessera dashboard">
    <div id="dashboard-content">${markup}</div>
    <section id="resources" aria-labelledby="resources-heading">
      <h2 id="resources-heading">System resources</h2>
      <div class="section-content">
        <div id="resource-usage"><p class="muted">Sampling…</p></div>
        ${buttons([{ id: "resource-limits", label: "Resource Limits…" }])}
      </div>
    </section>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const content = document.querySelector('#dashboard-content');
    const resources = document.querySelector('#resource-usage');
    document.querySelector('main').addEventListener('click', event => {
      const button = event.target.closest('button[data-action]');
      if (button) vscode.postMessage(button.dataset.action);
    });
    window.addEventListener('message', event => {
      if (typeof event.data?.resources === 'string') {
        if (resources.innerHTML !== event.data.resources) resources.innerHTML = event.data.resources;
        return;
      }
      if (typeof event.data !== 'string' || content.innerHTML === event.data) return;
      const focusedAction = content.contains(document.activeElement) && document.activeElement.dataset.action;
      content.innerHTML = event.data;
      if (focusedAction) {
        const button = Array.from(content.querySelectorAll('button'))
          .find(item => item.dataset.action === focusedAction);
        button?.focus({ preventScroll: true });
      }
    });
    vscode.postMessage('ready');
  </script>
</body>
</html>`;
}
