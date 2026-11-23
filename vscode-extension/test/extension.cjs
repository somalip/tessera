const assert = require("node:assert/strict");
const { writeFile } = require("node:fs/promises");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const vscode = require("vscode");

exports.run = async function() {
  const config = vscode.workspace.getConfiguration("tessera");
  const global = vscode.ConfigurationTarget.Global;
  const real = Boolean(process.env.TESSERA_REAL_SERVER && process.env.TESSERA_REAL_MODEL);
  const server = real ? process.env.TESSERA_REAL_SERVER : path.join(__dirname, "mock-server.cjs");
  await config.update("serverPath", server, global);
  await config.update("memoryMiB", 2048, global);
  const model = real ? process.env.TESSERA_REAL_MODEL :
    path.join(process.env.TESSERA_TEST_HOME, "mock.gguf");
  if (!real) await writeFile(model, "stub");
  await config.update(real ? "pythonAutocompleteModelPath" : "pythonModelPath", model, global);
  const document = await vscode.workspace.openTextDocument({
    language: "python", content: real
      ? "def is_even(number):\n    "
      : "def f():\n    \n",
  });
  await vscode.window.showTextDocument(document);
  const provider = await vscode.extensions.getExtension("tessera.tessera").activate();
  const { Dashboard, dashboardId } = require("../dist/views/dashboard");
  const commands = await vscode.commands.getCommands();
  assert.ok(commands.includes(dashboardId + ".focus"));
  assert.ok(commands.includes("tessera.ask"));
  assert.ok(commands.includes("tessera.triggerCompletion"));
  for (const command of ["inspectRoute", "rewrite", "fixDiagnostics"]) {
    assert.ok(commands.includes(`tessera.${command}`));
  }
  const collection = vscode.languages.createDiagnosticCollection("tessera-test");
  try {
    const range = new vscode.Range(0, 0, 0, 3);
    collection.set(document.uri, [new vscode.Diagnostic(range, "Example diagnostic")]);
    const fixesAt = position => vscode.commands.executeCommand(
      "vscode.executeCodeActionProvider", document.uri, new vscode.Range(position, position),
      vscode.CodeActionKind.QuickFix.value,
    );
    const fixes = await fixesAt(new vscode.Position(0, 1));
    assert.ok(fixes.some(fix => fix.command?.command === "tessera.fixDiagnostics"));
    const unrelated = await fixesAt(new vscode.Position(1, 0));
    assert.ok(!unrelated.some(fix => fix.command?.command === "tessera.fixDiagnostics"));
  } finally {
    collection.dispose();
  }
  await vscode.commands.executeCommand("tessera.openDashboard");

  const installed = {
    manifest: {
      id: "python-tiny", quant: "Q4_K_M", version: "1.0.0",
      language_ids: ["python"], capabilities: ["fim", "chat"], size_bytes: 490000000
    },
  };
  const { LocalMetrics } = require("../dist/telemetry");
  const metrics = new LocalMetrics();
  let state = { trusted: true, advanced: true, language: "python", active: installed, models: [installed] };
  const messages = [];
  const received = new vscode.EventEmitter();
  const disposed = new vscode.EventEmitter();
  const errors = [];
  const dashboard = new Dashboard(() => ({ ...state, usage: metrics.usage() }), error => errors.push(error), async advanced => { state = { ...state, advanced }; });
  const webview = {
    postMessage: async markup => messages.push(markup),
    onDidReceiveMessage: received.event,
  };
  try {
    dashboard.resolveWebviewView({
      webview, visible: false, onDidDispose: disposed.event,
      onDidChangeVisibility: () => new vscode.Disposable(() => { }),
    });
    assert.match(webview.html, /System resources/);
    assert.match(webview.html, /Usage appears after your first completed model request/);
    metrics.recordInference("python<&>", { outputTokens: 20, tokensPerSecond: 10 });
    metrics.accept(metrics.record(50, 120));
    assert.match(webview.html, /data-action="resource-limits"/);
    assert.match(webview.html, /python-tiny/);
    assert.match(webview.html, /python · 1.0.0 · 490 MB/);
    assert.match(webview.html, /Routed/);
    assert.match(webview.html, /data-action="add"/);
    assert.match(webview.html, /data-action="manage"/);
    assert.match(webview.html, /data-action="workflow" class="primary"/);
    assert.match(webview.html, /data-action="advanced" aria-pressed="true"/);
    received.fire("simple");
    await Promise.resolve();
    const simpleMarkup = messages.pop();
    assert.match(simpleMarkup, /data-action="simple" aria-pressed="true"/);
    assert.match(simpleMarkup, /data-action="install"/);
    assert.match(simpleMarkup, /data-action="manage"/);
    assert.match(simpleMarkup, /10 tok\/s · python&lt;&amp;&gt;/);
    assert.match(simpleMarkup, /Most-used model/);
    assert.match(simpleMarkup, /100% \(1 \/ 1\)/);
    assert.doesNotMatch(simpleMarkup, /data-action="refactor"|Inline first token/);
    received.fire("advanced");
    await Promise.resolve();
    const advancedMarkup = messages.pop();
    assert.match(advancedMarkup, /data-action="advanced" aria-pressed="true"/);
    assert.match(advancedMarkup, /Inline first token \(p95\)<\/dt><dd>50 ms/);
    assert.match(webview.html, /data-action="refactor"/);
    assert.match(webview.html, /data-action="rewrite"/);
    assert.match(webview.html, /data-action="fix-diagnostics"/);
    assert.match(webview.html, /data-action="inspect-route"/);
    assert.match(webview.html, /data-action="ask" class="primary"/);
    assert.match(webview.html, /<ul aria-labelledby="models-heading">/);
    assert.deepEqual(webview.options.localResourceRoots, []);

    state = {
      ...state,
      lastInline: {
        mode: "Inline generation", model: { ...installed, path: "/models/chat<&>.gguf" },
        parser: { ...installed, path: "/models/parsing.gguf" }
      },
    };
    dashboard.refresh();
    assert.match(messages.at(-1), /Last inline request · Inline generation/);
    assert.match(messages.at(-1), /Parsed by parsing\.gguf/);
    assert.match(messages.at(-1), /<strong>chat&lt;&amp;&gt;\.gguf<\/strong>/);
    assert.match(messages.at(-1), /title="\/models\/chat&lt;&amp;&gt;\.gguf"/);

    state = { trusted: true, language: "<rust>", models: [] };
    dashboard.refresh();
    assert.match(messages.at(-1), /No matching model/);
    assert.match(messages.at(-1), /&lt;rust&gt;/);
    assert.match(messages.at(-1), /No models installed/);
    assert.match(messages.at(-1), /data-action="workflow" class="primary"/);
    dashboard.refresh();
    assert.equal(messages.length, 2);

    state = { ...state, sections: ["resources"] };
    dashboard.refresh();
    const resourcesOnly = messages.pop();
    assert.match(resourcesOnly, /data-resources="true"/);
    assert.match(resourcesOnly, /data-action="customize-sidebar"/);
    assert.doesNotMatch(resourcesOnly, /Current editor|Code actions|Installed models|Session usage|Tools/);
    state = { ...state, advanced: true, sections: [] };
    dashboard.refresh();
    const emptySidebar = messages.pop();
    assert.match(emptySidebar, /data-resources="false"/);
    assert.match(emptySidebar, /data-action="customize-sidebar"/);
    assert.doesNotMatch(emptySidebar, /<section/);

    state = { trusted: false, models: [] };
    received.fire("ready");
    assert.match(messages.at(-1), /Workspace trust required/);
    assert.match(messages.at(-1), /data-action="trust"/);
    assert.doesNotMatch(messages.at(-1), /data-action="refactor"|Installed models/);
    assert.deepEqual(errors, []);
    disposed.fire();
    dashboard.refresh();
    assert.equal(messages.length, 3);
  } finally {
    dashboard.dispose();
    received.dispose();
    disposed.dispose();
  }
  const cursor = new vscode.Position(1, 4);
  const context = { triggerKind: vscode.InlineCompletionTriggerKind.Invoke };
  const cancelled = new vscode.CancellationTokenSource();
  try {
    const pending = provider.provideInlineCompletionItems(document, cursor, context, cancelled.token);
    cancelled.cancel();
    assert.deepEqual(await pending, []);
    const current = new vscode.CancellationTokenSource();
    try {
      const items = await provider.provideInlineCompletionItems(document, cursor, context, current.token);
      if (real) assert.match(items[0]?.insertText, /^return number % 2 == 0$/);
      else assert.equal(items[0]?.insertText, "return 42");
    } finally {
      current.dispose();
    }
    if (!real) {
      const cppFim = path.join(process.env.TESSERA_TEST_HOME, "cpp-fim.gguf");
      const cppChat = path.join(process.env.TESSERA_TEST_HOME, "cpp-chat.gguf");
      await Promise.all([writeFile(cppFim, "stub"), writeFile(cppChat, "stub")]);
      await config.update("cppModelPath", cppChat, global);
      const token = new vscode.CancellationTokenSource();
      try {
        const cpp = await vscode.workspace.openTextDocument({
          language: "cpp", content: "int answer() {\n    // Return the C++ answer\n    \n}\n",
        });
        const originalReport = provider.reportRoute;
        const routed = [];
        provider.reportRoute = (doc, route) => {
          if (doc === cpp) routed.push(route.model?.path);
          originalReport(doc, route);
        };
        try {
          await provider.provideInlineCompletionItems(cpp, new vscode.Position(2, 4), context, token.token);
          assert.equal(routed.at(-1), cppChat);
          await assert.rejects(async () => vscode.commands.executeCommand("tessera.saveWorkflow", "C / C++", {}), /Enter a language ID/);
          await vscode.commands.executeCommand("tessera.saveWorkflow", "C/C++", {
            router: "", autocomplete: "qwen-coder-autocomplete", parser: "", generator: "cpp-local",
          });
          await provider.provideInlineCompletionItems(cpp, new vscode.Position(2, 4), context, token.token);
          assert.match(routed.at(-1), /qwen-coder-autocomplete/);
          await vscode.commands.executeCommand("tessera.saveWorkflow", "cpp");
          await provider.provideInlineCompletionItems(cpp, new vscode.Position(2, 4), context, token.token);
          assert.equal(routed.at(-1), cppChat);
        } finally {
          provider.reportRoute = originalReport;
        }
        await config.update("cppAutocompleteModelPath", cppFim, global);
        const complete = await provider.provideInlineCompletionItems(cpp, new vscode.Position(2, 4), context, token.token);
        assert.equal(complete[0]?.insertText, "return 42;");
        const instruction = await vscode.workspace.openTextDocument({
          language: "cpp", content: "// tessera: Implement answer\n",
        });
        const generate = await provider.provideInlineCompletionItems(instruction, new vscode.Position(1, 0), context, token.token);
        assert.equal(generate[0]?.insertText, "int answer() { return 42; }");
        const priorReport = provider.reportRoute;
        const stages = [];
        provider.reportRoute = (doc, route) => {
          if (doc === instruction) stages.push(route.mode);
          priorReport(doc, route);
        };
        try {
          await vscode.commands.executeCommand("tessera.saveWorkflow", "cpp", {
            router: "qwen-coder-chat", autocomplete: "", parser: "cpp-autocomplete-local", generator: "cpp-local",
          });
          const result = await provider.provideInlineCompletionItems(instruction, new vscode.Position(1, 0), context, token.token);
          assert.deepEqual(stages, ["Comment routing", "Comment parsing", "Inline generation"]);
          assert.equal(result[0]?.insertText, "int answer() { return 42; }");
        } finally {
          provider.reportRoute = priorReport;
          await vscode.commands.executeCommand("tessera.saveWorkflow", "cpp");
        }
        const automatic = { triggerKind: vscode.InlineCompletionTriggerKind.Automatic };
        const loop = await vscode.workspace.openTextDocument({
          language: "cpp", content: "// write a for loop\n// Print the loop index.\n",
        });
        const retry = await provider.provideInlineCompletionItems(loop, new vscode.Position(2, 0), automatic, token.token);
        assert.match(retry[0]?.insertText, /int main\(\) \{\n    for \(int i/);
        const finished = await vscode.workspace.openTextDocument({
          language: "cpp", content: "int test_javascript_guard() { return 42; }\n",
        });
        const stopped = await provider.provideInlineCompletionItems(finished, new vscode.Position(1, 0), automatic, token.token);
        assert.deepEqual(stopped, []);
        const contaminated = await provider.provideInlineCompletionItems(finished, new vscode.Position(1, 0), context, token.token);
        assert.deepEqual(contaminated, []);
      } finally {
        token.dispose();
        await config.update("cppAutocompleteModelPath", undefined, global);
        await config.update("cppModelPath", undefined, global);
      }
    }
    if (!real || (process.env.TESSERA_REAL_PARSING && process.env.TESSERA_REAL_DOCS)) {
      const parsing = process.env.TESSERA_REAL_PARSING ||
        path.join(process.env.TESSERA_TEST_HOME, "parsing.gguf");
      const docs = process.env.TESSERA_REAL_DOCS ||
        path.join(process.env.TESSERA_TEST_HOME, "docs.gguf");
      if (!real) {
        await writeFile(parsing, "stub");
        await writeFile(docs, "stub");
        await config.update("pythonAutocompleteModelPath", model, global);
      }
      await config.update("parsingAutocompleteModelPath", parsing, global);
      await config.update("documentationAutocompleteModelPath", docs, global);
      await config.update("maxModels", 3, global);
      const markdown = await vscode.workspace.openTextDocument({
        language: "markdown",
        content: "# Installation\nInstall the extension by \n\n" +
          "```sql\nSELECT name FROM users WHERE active = \n```\n\n" +
          "```python\ndef is_even(number):\n    # Return whether the number is divisible by two\n    \n```\n",
      });
      const switching = new vscode.CancellationTokenSource();
      try {
        for (const [line, expected] of [[1, "docs"], [4, "parsing"], [10, "python"], [1, "docs"]]) {
          const position = markdown.lineAt(line).range.end;
          const result = await provider.provideInlineCompletionItems(markdown, position, context, switching.token);
          const text = result[0]?.insertText;
          if (real) assert.ok(typeof text === "string" && text.trim(), `empty ${expected} completion`);
          else assert.equal(text, expected);
        }
        const automatic = { triggerKind: vscode.InlineCompletionTriggerKind.Automatic };
        const finished = await vscode.workspace.openTextDocument({
          language: "python",
          content: '#write a python script to print binary of a given number\nnum=int(input("enter the number"))\nprint(bin(num))\n',
        });
        const finish = new vscode.Position(3, 0);
        assert.deepEqual(await provider.provideInlineCompletionItems(
          finished, finish, automatic, switching.token), []);
        if (!real) {
          assert.equal((await provider.provideInlineCompletionItems(
            finished, finish, context, switching.token))[0]?.insertText, "print(num)");
          assert.equal((await provider.provideInlineCompletionItems(
            document, cursor, automatic, switching.token))[0]?.insertText, "return 42");
        }
      } finally {
        switching.dispose();
        if (!real) await config.update("pythonAutocompleteModelPath", undefined, global);
      }
    }
    if (!real) {
      await config.update("autocomplete", false, global);
      const marked = await vscode.workspace.openTextDocument({
        language: "python", content: "def f():\n    # tessera: return an answer\n    ",
      });
      const automatic = { triggerKind: vscode.InlineCompletionTriggerKind.Automatic };
      const markedCursor = new vscode.Position(2, 4);
      const token = new vscode.CancellationTokenSource();
      try {
        const complete = (doc, position, trigger) =>
          provider.provideInlineCompletionItems(doc, position, trigger, token.token);
        assert.deepEqual(await complete(document, cursor, automatic), []);
        assert.equal((await complete(document, cursor, context))[0]?.insertText, "return 42");
        assert.equal((await complete(marked, markedCursor, automatic))[0]?.insertText, "return 42");
        const plain = await vscode.workspace.openTextDocument({
          language: "python", content: "def answer():\n    # Return the answer\n    ",
        });
        const fastModel = path.join(process.env.TESSERA_TEST_HOME, "fast.gguf");
        await writeFile(fastModel, "stub");
        await config.update("maxModels", 1, global);
        await config.update("pythonAutocompleteModelPath", fastModel, global);
        const parsingPath = path.join(process.env.TESSERA_TEST_HOME, "parsing.gguf");
        const reportRoute = provider.reportRoute;
        const routes = [];
        provider.reportRoute = (doc, route) => {
          routes.push([doc, route.mode, route.model?.path]);
          reportRoute(doc, route);
        };
        try {
          assert.equal((await complete(document, cursor, context))[0]?.insertText, "return 42");
          assert.deepEqual(routes.at(-1), [document, "Autocomplete", fastModel]);
          assert.equal((await complete(plain, markedCursor, automatic))[0]?.insertText, "return 42");
          assert.deepEqual(routes.at(-1), [plain, "Inline generation", model]);
          assert.deepEqual(routes.at(-2), [plain, "Comment parsing", parsingPath]);
          const snake = await vscode.workspace.openTextDocument({
            language: "python", content: "#make a tui snake game\n",
          });
          const game = await complete(snake, new vscode.Position(1, 0), automatic);
          assert.equal(game[0]?.insertText, "print('Game ready')", JSON.stringify(routes.map(([, mode, weights]) => [mode, weights])));
          assert.deepEqual(routes.filter(([doc]) => doc === snake), [[snake, "Inline generation", model]]);
          const timer = await vscode.workspace.openTextDocument({
            language: "python", content: "# Build a command-line Pomodoro timer that handles Ctrl-C.\n",
          });
          assert.equal((await complete(timer, new vscode.Position(1, 0), automatic))[0]?.insertText,
            "print('Pomodoro timer')");
          const multiline = await vscode.workspace.openTextDocument({
            language: "python", content: "# Build a JSON export tool.\n# Keep UTF-8 names and an --output flag.\n",
          });
          assert.equal((await complete(multiline, new vscode.Position(2, 0), automatic))[0]?.insertText,
            "print('JSON export')");
          const loop = await vscode.workspace.openTextDocument({
            language: "python", content: "#write a loop\n",
          });
          assert.equal((await complete(loop, new vscode.Position(1, 0), automatic))[0]?.insertText,
            "for i in range(10):\n    print(i)");
          assert.deepEqual(routes.slice(-2), [
            [loop, "Comment parsing", parsingPath], [loop, "Inline generation", model],
          ]);
          await config.update("commentCompletions", false, global);
          assert.deepEqual(await complete(plain, markedCursor, automatic), []);
        } finally {
          provider.reportRoute = reportRoute;
          await config.update("pythonAutocompleteModelPath", undefined, global);
        }

        assert.deepEqual(await complete(marked, markedCursor, automatic), []);
      } finally {
        token.dispose();
      }
      const slow = await vscode.workspace.openTextDocument({ language: "python", content: "def slow():\n    " });
      const cancellation = new vscode.CancellationTokenSource();
      try {
        const pending = provider.provideInlineCompletionItems(slow, cursor, context, cancellation.token);
        await delay(500);
        cancellation.cancel();
        const result = await Promise.race([pending, delay(1200, "timed out")]);
        assert.deepEqual(result, []);
      } finally {
        cancellation.dispose();
      }
    }
  } finally {
    cancelled.dispose();
  }
};
