# TinyCoders

TinyCoders supplies local fill-in-the-middle completion and chat in VS Code.
It routes the current file and cursor to a compatible GGUF model and runs
the model in a CPU-first llama.cpp server on loopback.

Open **TinyCoders** from the Activity Bar, click its status bar item, or run
**TinyCoders: Open Dashboard**. The dashboard shows the model routed to the
current editor and the configured models. Use **Add Local GGUF** to browse for
a Python or TypeScript Qwen2.5-Coder model. To install from a signed registry,
configure its HTTPS URL and trusted Ed25519 public key in **Settings**, then
choose **Install From Registry**.

Set `tinycoders.serverPath` in **Settings** if the compatible `llama-server`
executable is outside PATH. With the default `tinycoders.memoryMiB: 0`, a model
that exceeds the automatic RAM target can run alone on the CPU with unlocked,
memory-mapped GGUF weights. The operating system can reclaim these pages and
read them back from the model file as needed. Context and compute buffers still
require system memory, and paging can slow inference. A positive memory limit
enforces the configured budget.

Open a supported file and type for suggestions. Set `tinycoders.autocomplete`
to `false` to stop suggestions as you type. Run **TinyCoders: Trigger Inline
Completion** for a suggestion on demand. Or type `# tinycoders: return the sum`
in Python (use `// tinycoders: return the sum` in TypeScript) and press Enter.
Set `tinycoders.commentCompletions` to `false` to disable this comment trigger
while automatic suggestions are off. Keep VS Code inline suggestions enabled.
Use **Choose Routing Model** to pin a model for the file or workspace.

Run **TinyCoders: Ask** to enter a prompt and open the response beside your editor.
For a conversation, open TinyCoders Chat from the dashboard or use
`@tinycoders` in VS Code Chat.
Select code to explain, refactor, or generate tests from the dashboard.
Refactors and generated tests open in a diff preview for review.

The extension retains aggregate completion metrics in memory for the current
session. **TinyCoders: Export Local Metrics** writes them to a file you choose.
The extension sends inference requests only to its local model process.

## Tessera capsule tasks

Use Python 3.11+ with the repository's `requirements-dev.txt`, a local
llama.cpp server with `/apply-template` and `/tokenize`, and the preinstalled
Docker verifier image for your language. From the Tessera source directory,
run `python -m verifiers.prepare python` once for Python execution checks.
Run `python -m verifiers.prepare python-quality` for mypy and Ruff checks.
Verifier runs use preinstalled images with the network disabled.

Set `tinycoders.capsule.runtimePath` to the absolute path of this source checkout.
The task command is enabled by default through `tinycoders.capsule.enabled`.
Set `tinycoders.capsule.pythonPath` if the dependencies are in a virtual
environment. The task command uses `tinycoders.serverPath` and defaults to
installed chat-capable models. Inline completion, chat, and code actions keep
their existing routing while `tinycoders.legacy.enabled` is true.

Use **Tessera: Run task** in a trusted local workspace, describe the contract,
and choose a JSON file of acceptance checks. For example, ask the model to
implement a typed Python function called `answer()` that returns 42, and supply:

```json
[
  {"id":"answer-test","kind":"test","language":"python","source":"assert answer() == 42"},
  {"id":"answer-types","kind":"typecheck","language":"python","source":""}
]
```

Use `test` for trusted test source and `typecheck` or `lint` for a fixed
toolchain check. Each work order produces a standalone candidate file.
The panel shows the plan, model, capsule tokens, verifier outcome, and
verified code you can copy. Workspace signatures come from saved files.
SQLite and escalation logs live in the extension's local workspace storage.

To choose a generalist and a Python specialist, configure
`tinycoders.capsule.models` in your user settings:

```json
[
  {"id":"qwen-small","path":"/models/qwen-0.5b.gguf","language":"*","tier":0},
  {"id":"python-specialist","path":"/models/qwen-0.5b.gguf","adapter":"/models/python-lora.gguf",
   "language":"python","roles":["implement","repair","refactor"],"difficulty":"routine","tier":0,
   "preamble":"You specialize in typed Python."},
  {"id":"qwen-larger","path":"/models/qwen-1.5b.gguf","language":"*","tier":1}
]
```

Difficulty is `routine` or `complex`. Tier 0 is the initial route and tier 1
is local escalation. Model and adapter bytes together must total less than
1 GB. The token cap and small-model retry count are configurable.

Optional tier 2 requires `tinycoders.capsule.remote` and an HTTPS llama.cpp
endpoint with a declared `size_bytes` below 1 GB. The client uses
`TESSERA_REMOTE_KEY` from the extension environment when provided. Enabling
this route permits the endpoint to receive the request and retrieved
signatures, including during token counting. The endpoint operator supplies
the model size declaration.
