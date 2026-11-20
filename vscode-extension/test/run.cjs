const { runTests } = require("@vscode/test-electron");
const { mkdir, mkdtemp, rm, writeFile } = require("node:fs/promises");
const { createHash } = require("node:crypto");
const os = require("node:os");
const path = require("node:path");

async function main() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tessera-vscode-"));
  try {
    if (!process.env.TESSERA_REAL_MODEL) {
      const { builtInModels } = require("../dist/registry/catalog");
      const data = Buffer.from("stub");
      for (const { upstreamManifest } of builtInModels) {
        const manifest = { ...upstreamManifest, language_ids: ["cpp"], vscode_language_ids: ["cpp"],
          file_globs: ["**/*.cpp"], size_bytes: data.length,
          sha256: createHash("sha256").update(data).digest("hex") };
        const modelRoot = path.join(directory, "User", "globalStorage", "tessera.tessera", "models", manifest.id);
        const version = path.join(modelRoot, manifest.version);
        await mkdir(version, { recursive: true });
        await Promise.all([
          writeFile(path.join(version, "manifest.json"), JSON.stringify(manifest)),
          writeFile(path.join(version, `model.${manifest.quant}.gguf`), data),
          writeFile(path.join(modelRoot, "active"), manifest.version),
        ]);
      }
    }
    await runTests({
      vscodeExecutablePath: process.env.VSCODE_EXECUTABLE || undefined,
      extensionDevelopmentPath: path.resolve(__dirname, ".."),
      extensionTestsPath: path.join(__dirname, "extension.cjs"),
      extensionTestsEnv: {
        TESSERA_TEST_HOME: directory,
        TESSERA_REAL_SERVER: process.env.TESSERA_REAL_SERVER ?? "",
        TESSERA_REAL_MODEL: process.env.TESSERA_REAL_MODEL ?? "",
        TESSERA_REAL_PARSING: process.env.TESSERA_REAL_PARSING ?? "",
        TESSERA_REAL_DOCS: process.env.TESSERA_REAL_DOCS ?? "",
      },
      launchArgs: ["--disable-extensions", "--disable-workspace-trust", "--user-data-dir", directory],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
