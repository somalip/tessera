const { runTests } = require("@vscode/test-electron");
const { mkdtemp, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

async function main() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tinycoders-vscode-"));
  try {
    await runTests({
      vscodeExecutablePath: process.env.VSCODE_EXECUTABLE || undefined,
      extensionDevelopmentPath: path.resolve(__dirname, ".."),
      extensionTestsPath: path.join(__dirname, "extension.cjs"),
      extensionTestsEnv: {
        TINYCODERS_TEST_HOME: directory,
        TINYCODERS_REAL_SERVER: process.env.TINYCODERS_REAL_SERVER ?? "",
        TINYCODERS_REAL_MODEL: process.env.TINYCODERS_REAL_MODEL ?? "",
        TINYCODERS_REAL_PARSING: process.env.TINYCODERS_REAL_PARSING ?? "",
        TINYCODERS_REAL_DOCS: process.env.TINYCODERS_REAL_DOCS ?? "",
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
