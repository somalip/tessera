const assert = require("node:assert/strict");
const { createHash, generateKeyPairSync, sign } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { mkdtemp, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { ModelStore, verifyIndex } = require("../dist/registry/download");

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const keyPair = generateKeyPairSync("ed25519");
const key = keyPair.publicKey.export({ type: "spki", format: "pem" });

test("registry verifies raw signed bytes and rejects altered or invalid indexes", () => {
  const index = { schema_version: 1, models: [] };
  const content = Buffer.from(JSON.stringify(index));
  const signature = sign(null, content, keyPair.privateKey);
  assert.deepEqual(verifyIndex(content, signature, key), index);
  assert.throws(() => verifyIndex(Buffer.concat([content, Buffer.from(" ")]), signature, key), /signature/);
  const invalid = Buffer.from(JSON.stringify({ ...index, schema_version: 2 }));
  assert.throws(() => verifyIndex(invalid, sign(null, invalid, keyPair.privateKey), key), /schema/);
});

function fixture(version, pathOverride) {
  const model = Buffer.from("GGUF mock bytes");
  const manifest = {
    schema_version: 1, id: "python-tiny", version, language_ids: ["python"],
    vscode_language_ids: ["python"], file_globs: ["**/*.py"], base_model: "qwen",
    params: 500000000, quant: "Q4_K_M", size_bytes: model.length, context_length: 2048,
    prompt_formats: { fim: { prefix: "P", suffix: "S", middle: "M" }, chat_template: "chatml" },
    capabilities: ["fim"], min_runtime: { llama_cpp_build: "test" }, sha256: hash(model),
  };
  const files = {
    "manifest.json": JSON.stringify(manifest), "eval_report.json": "{}", LICENSE: "test",
    [pathOverride ?? "model.Q4_K_M.gguf"]: model.toString(),
  };
  return execFileSync(process.env.PYTHON || "python3", ["-c", `
import io, json, sys, zipfile
buffer = io.BytesIO()
with zipfile.ZipFile(buffer, "w") as archive:
    for name, value in json.load(sys.stdin).items():
        archive.writestr(name, value)
sys.stdout.buffer.write(buffer.getvalue())
`], { input: JSON.stringify(files) });
}

test("installer fails closed on tampering, installs upgrades, and switches offline", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tinycoders-store-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const store = new ModelStore(root);
  let payload;
  t.mock.method(globalThis, "fetch", async () => new Response(payload));
  const entry = (version, bytes) => ({
    id: "python-tiny", version, size_bytes: bytes.length, sha256: hash(bytes),
    url: "https://example.org/python.tcm", language_ids: ["python"],
  });
  const signal = new AbortController().signal;
  const original = fixture("1.0.0");
  payload = Buffer.from(original);
  payload[40] ^= 1;
  await assert.rejects(store.install(entry("1.0.0", original), signal), /SHA-256/);
  assert.deepEqual(await store.installed(), []);
  payload = fixture("1.0.0", "../model.Q4_K_M.gguf");
  await assert.rejects(store.install(entry("1.0.0", payload), signal), /invalid/i);
  payload = original;
  await store.install(entry("1.0.0", payload), signal);
  payload = fixture("2.0.0");
  await store.install(entry("2.0.0", payload), signal);
  assert.equal((await store.installed())[0].manifest.version, "2.0.0");
  globalThis.fetch.mock.mockImplementation(() => { throw new Error("offline"); });
  await store.activate("python-tiny", "1.0.0");
  const [active] = await store.installed();
  assert.equal(active.manifest.version, "1.0.0");
  await writeFile(active.path, "GGUF mock bytex");
  assert.deepEqual(await store.installed(), []);
  await assert.rejects(store.activate("python-tiny", "1.0.0"), /SHA-256/);
});
