import type { DashboardState } from "./dashboard";

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

export function renderDashboard({ trusted, language, active, models }: DashboardState, groups: Groups): string {
  const routing = !trusted ? "Workspace trust required" : active?.manifest.id ??
    (language ? "No matching model" : "Open a source file");
  const routingDetail = !trusted ? "Trust this workspace to use local models and code actions."
    : active ? "Selected for inline completion."
    : language ? "Choose a routing model or add one below."
    : "Routing follows the language at your cursor.";
  const modelRows = models.map(model => {
    const { manifest } = model;
    const details = [
      manifest.language_ids.join(", "),
      manifest.quant === "local" ? "Local GGUF" : manifest.version,
      `${Math.ceil(manifest.size_bytes / 1_000_000)} MB`,
    ].filter(Boolean).join(" · ");
    const selected = trusted && active?.manifest.id === manifest.id && active.manifest.version === manifest.version;
    return `<li title="${escapeHtml(manifest.capabilities.join(", "))}">
      <div class="model-heading"><strong>${escapeHtml(manifest.id)}</strong>${selected ? '<span class="badge">Routed</span>' : ""}</div>
      <div class="muted">${escapeHtml(details)}</div>
    </li>`;
  }).join("");

  return `<section aria-labelledby="routing-heading">
    <div class="section-heading"><h2 id="routing-heading">Current editor</h2>
      ${trusted && language ? `<span class="badge">${escapeHtml(language)}</span>` : ""}
    </div>
    <div class="routing card">
      <strong>${escapeHtml(routing)}</strong>
      <p class="muted">${routingDetail}</p>
      ${buttons(groups.routing)}
    </div>
  </section>
  ${groups.editor.length ? `<section aria-labelledby="editor-heading">
    <h2 id="editor-heading">Code actions</h2>
    ${buttons(groups.editor, "ask")}
  </section>` : ""}
  ${models.length || groups.models.length ? `<section aria-labelledby="models-heading">
    <div class="section-heading"><h2 id="models-heading">Installed models</h2>
      <span class="badge" aria-label="${models.length} installed models">${models.length}</span>
    </div>
    <div class="card">
      ${modelRows ? `<ul aria-label="Installed models">${modelRows}</ul>` : '<p class="muted">No models installed.</p>'}
      ${buttons(groups.models)}
    </div>
  </section>` : ""}
  <section class="tools" aria-labelledby="tools-heading">
    <h2 id="tools-heading">Tools</h2>
    ${buttons(groups.tools)}
  </section>`;
}

export function dashboardHtml(markup: string, nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>TinyCoders Dashboard</title>
  <style nonce="${nonce}">
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 16px 12px;
      background: var(--vscode-sideBar-background);
      color: var(--vscode-sideBar-foreground, var(--vscode-foreground));
      font: var(--vscode-font-size, 13px)/1.45 var(--vscode-font-family, sans-serif);
      overflow-wrap: anywhere;
    }
    main { display: grid; gap: 18px; max-width: 600px; margin: auto; }
    h2 { margin: 0 0 7px; font-size: 1em; font-weight: 600; }
    p { margin: 0; }
    .section-heading, .model-heading {
      display: flex; align-items: baseline; flex-wrap: wrap; justify-content: space-between; gap: 4px 8px;
    }
    .section-heading { margin-bottom: 7px; }
    .section-heading h2 { margin: 0; }
    .badge {
      padding: 1px 7px; border-radius: 10px; font-size: .85em;
      background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    }
    .card {
      min-width: 0;
      padding: 10px;
      border: 1px solid var(--vscode-contrastBorder, var(--vscode-widget-border, var(--vscode-sideBarSectionHeader-border, transparent)));
      border-radius: 8px;
      background: var(--vscode-sideBarSectionHeader-background, var(--vscode-editorWidget-background));
    }
    .routing { border-inline-start: 3px solid var(--vscode-focusBorder); }
    .routing strong { font-size: 1.1em; }
    .routing p { margin-top: 3px; }
    .muted { color: var(--vscode-descriptionForeground, inherit); font-size: .92em; }
    ul { list-style: none; padding: 0; margin: 0; }
    li + li {
      margin-top: 7px; padding-top: 7px;
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-widget-border, transparent));
    }
    .card .actions { margin-top: 9px; }
    .actions { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 106px), 1fr)); gap: 5px; }
    button {
      min-width: 0; min-height: 29px; padding: 4px 7px; border-radius: 5px;
      border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder, transparent));
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      font: inherit; text-align: start; overflow-wrap: anywhere; cursor: pointer;
    }
    button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px; }
    .tools button { background: transparent; color: inherit; }
    .tools button:hover { background: var(--vscode-list-hoverBackground); }
  </style>
</head>
<body>
  <main aria-label="TinyCoders dashboard">${markup}</main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const main = document.querySelector('main');
    main.addEventListener('click', event => {
      const button = event.target.closest('button[data-action]');
      if (button) vscode.postMessage(button.dataset.action);
    });
    window.addEventListener('message', event => {
      if (typeof event.data !== 'string' || main.innerHTML === event.data) return;
      const focusedAction = main.contains(document.activeElement) && document.activeElement.dataset.action;
      main.innerHTML = event.data;
      if (focusedAction) {
        const button = Array.from(main.querySelectorAll('button'))
          .find(item => item.dataset.action === focusedAction);
        button?.focus({ preventScroll: true });
      }
    });
    vscode.postMessage('ready');
  </script>
</body>
</html>`;
}
