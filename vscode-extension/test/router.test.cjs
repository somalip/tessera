const assert = require("node:assert/strict");
const { test } = require("node:test");
const { embeddedLanguage, projectLanguage } = require("../dist/router/detector");
const { selectModel } = require("../dist/router/policy");
const { Lifecycle } = require("../dist/router/lifecycle");
const ids = ["python", "typescript", "javascript", "c", "cpp", "kotlin", "sql", "rust",
  "css", "go", "general"];
const models = ids.map(id => ({
  manifest: {
    id, language_ids: [id], vscode_language_ids: id === "typescript" ? [id, "typescriptreact"] : [id],
    file_globs: id === "python" ? ["**/*.py"] : [], capabilities: ["fim"],
  }
}));
const cases = [
  ...ids.filter(id => id !== "general").map(id => [id, "", {}, id]),
  ["typescriptreact", "", {}, "typescript"],
  ["plaintext", "a.py", {}, "python"],
  ["plaintext", "src/a.py", {}, "python"],
  ["plaintext", "src\\a.py", {}, "python"],
  ["plaintext", "a.txt", {}, undefined],
  ["python", "", { override: "rust" }, "rust"],
  ["python", "", { override: "missing" }, "python"],
  ["python", "", { embedded: "sql" }, "sql"],
  ["python", "", { embedded: "missing" }, "python"],
  ["markdown", "", { embedded: "typescript" }, "typescript"],
  ["html", "", { embedded: "javascript" }, "javascript"],
  ["html", "", { embedded: "css" }, "css"],
  ["java", "", {}, "kotlin"],
  ["javascriptreact", "", {}, "typescript"],
  ["javascript", "a.js", { project: "typescript" }, "typescript"],
  ["javascript", "a.js", {}, "javascript"],
  ["c", "a.h", { project: "cpp" }, "cpp"],
  ["cpp", "a.h", { project: "c" }, "c"],
  ["cpp", "a.h", {}, "cpp"],
  ["c", "a.h", { project: "missing" }, "c"],
  ["text", "", { generalist: "general" }, "general"],
  ["python", "", { generalist: "general" }, "python"],
  ["python", "", { capability: "edit" }, undefined],
  ["text", "", { generalist: "missing" }, undefined],
];
for (const [index, [language, filename, extra, expected]] of cases.entries()) {
  test(`route ${index + 1}: ${language}, ${filename}, ${JSON.stringify(extra)}`, () => {
    assert.equal(selectModel(models, { language, filename, capability: "fim", ...extra })
      ?.manifest.id, expected);
  });
}

test("embedded regions and project hints distinguish mixed-language files", () => {
  const embedded = (language, source) => embeddedLanguage(language, source, source.length);
  assert.equal(embedded("markdown", "````ts\n```\nlet x"), "typescript");
  assert.equal(embedded("markdown", "~~~py\nvalue\n~~~\ntext"), undefined);
  assert.equal(embedded("html", "<script lang='ts'>\nlet x"), "typescript");
  assert.equal(embedded("html", "<script>hi</script>\noutside"), undefined);
  assert.equal(embedded("python", 'query = """\nSELECT *'), "sql");
  assert.equal(projectLanguage("x.h", new Set(["c", "cpp"])), "cpp");
  assert.equal(projectLanguage("x.h", new Set(["c"])), "c");
  assert.equal(projectLanguage("x.js", new Set(["tsconfig.json"])), "typescript");
});

test("lifecycle evicts the least recently used model and protects in-flight leases", async () => {
  const lifecycle = new Lifecycle(20, 2, 5000);
  const disposed = [];
  const use = (key, bytes, operation = async () => undefined) => lifecycle.use(key, bytes, () => ({
    alive: true, start: async () => ({}), dispose: () => disposed.push(key),
  }), operation);
  try {
    await use("typescript", 10);
    let finish;
    const python = use("python", 10, () => new Promise(resolve => { finish = resolve; }));
    await use("rust", 10);
    assert.deepEqual(disposed, ["typescript"]);
    await assert.rejects(use("go", 15), /active/);
    await assert.rejects(use("java", 21), /exceeds/);
    finish();
    await python;
    await use("go", 15);
    assert.deepEqual(disposed, ["typescript", "rust", "python"]);
  } finally {
    await lifecycle.dispose();
  }
});

test("eviction waits for shutdown and a crashed host is restarted", async () => {
  const lifecycle = new Lifecycle(10, 1, 5000);
  let release;
  let running = false;
  let started = 0;
  const first = () => ({
    get alive() { return running; },
    async start() { running = true; started += 1; return {}; },
    async dispose() {
      if (running) await new Promise(resolve => { release = resolve; });
      running = false;
    },
  });
  const useFirst = () => lifecycle.use("first", 10, first, async () => { });
  try {
    await useFirst();
    running = false;
    await useFirst();
    assert.equal(started, 2);
    const next = lifecycle.use("next", 10, () => {
      assert.equal(running, false);
      return { alive: true, start: async () => ({}), dispose() { } };
    }, async () => true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof release, "function");
    assert.equal(running, true);
    release();
    assert.equal(await next, true);
  } finally {
    await lifecycle.dispose();
  }
});

test("the automatic budget admits a paged model alone and protects its active lease", async () => {
  const lifecycle = new Lifecycle(10, 2, 5000, Promise.resolve(), true);
  const events = [];
  const use = (key, bytes, operation = async () => { }) => lifecycle.use(key, bytes, paged => ({
    alive: true,
    start: async () => { events.push([key, paged]); return {}; },
    dispose: () => events.push(["disposed", key]),
  }), operation);
  try {
    await use("normal", 5);
    await use("large", 20, async () => {
      await assert.rejects(use("other", 5), /active/);
    });
    await use("other", 5);
    assert.deepEqual(events, [
      ["normal", false], ["disposed", "normal"], ["large", true],
      ["disposed", "large"], ["other", false],
    ]);
  } finally {
    await lifecycle.dispose();
  }
});

test("Python syntax trees distinguish SQL strings from comments and ordinary strings", async () => {
  const { PythonRegions } = require("../dist/router/pythonRegions");
  const regions = new PythonRegions();
  try {
    await regions.initialize();
    const source = '# """SELECT 1\nlabel = "café"\nquery = r"""\nSELECT * FROM a\n"""\n';
    assert.equal(regions.at("test", 1, source, source.indexOf("SELECT")), undefined);
    assert.equal(regions.at("test", 1, source, source.lastIndexOf("SELECT")), "sql");
    assert.equal(regions.at("test", 1, source, source.length), undefined);
    for (const [source, needle, expected] of [
      ['def f():\n    # comment\n    """Add details."""\n    pass', "details", "python-docstring"],
      [`x = json.loads('{"ok":true}')`, "true", "json"],
      ['x = re.compile(r"[a-z]+")', "a-z", "regex"],
      ['x = """Regular string"""', "Regular", undefined],
      ['def g():\n    """Describe', "Describe", "python-docstring"],
      ['def g():\n    x = 2\n    """Temporary text', "Temporary", undefined],
    ]) {
      assert.equal(regions.at(source, 1, source, source.indexOf(needle)), expected);
    }
    const editing = 'query = """SELECT * FROM a';
    assert.equal(regions.at("test", 2, editing, editing.length), "sql");
  } finally {
    regions.dispose();
  }
});
