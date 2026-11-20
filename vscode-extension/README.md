# Tessera

Tessera supplies local fill-in-the-middle completion and chat in VS Code.
It routes the current file and cursor to a compatible GGUF model and runs
the model in a CPU-first llama.cpp server on loopback.

Open **Tessera** from the Activity Bar, click its status bar item, or run
**Tessera: Open Dashboard**. **Simple** mode shows the current model route,
chat, and model management. **Advanced** mode adds code actions, route details,
system resources, and diagnostics. Tessera remembers your mode selection.

- **Download Models** opens the built-in Tessera catalog or a signed registry.
  The built-in catalog includes Qwen coding models for autocomplete, chat,
  and code edits. For a custom registry, enter its HTTPS URL
  and trusted Ed25519 public key in Tessera settings. Verified downloads install
  into VS Code's extension storage and are available for routing immediately.
- **Manage Models** lists downloaded versions and linked GGUFs. Activate a
  downloaded version, remove its files from Tessera storage, or unlink an
  existing GGUF while keeping its file on disk.
- **Add Local GGUF** lets you choose a model role and browse to an existing file.
- **Choose Model** pins a compatible model for the current file or workspace.

In **Advanced** mode, **System resources** shows machine-wide CPU usage,
non-free RAM (including cached memory), and per-device GPU utilization when
available. GPU readings use macOS accelerator counters or `nvidia-smi`.
**Resource Limits** opens the settings for Tessera model servers.

- **Model RAM budget** uses estimated resident model memory in MiB.
- **CPU threads** limits inference and prompt processing threads per server.
  Zero uses the runtime defaults.
- **GPU layers** sets the number of model layers offloaded per server.
  Zero selects CPU-only inference.
- **Resident models** limits how many model servers can be loaded at once.

Set `tessera.serverPath` in **Settings** if the compatible `llama-server`
executable is outside PATH. With the default `tessera.memoryMiB: 0`, a model
that exceeds the automatic RAM target can run alone on the CPU with unlocked,
memory-mapped GGUF weights. The operating system can reclaim these pages and
read them back from the model file as needed. Context and compute buffers still
require system memory, and paging can slow inference. A positive memory limit
enforces the configured budget.

Open a supported file and type for suggestions. Set `tessera.autocomplete`
to `false` to stop suggestions as you type. Run **Tessera: Trigger Inline
Completion** for a suggestion on demand. Or type `# tessera: return the sum`
in Python (use `// tessera: return the sum` in TypeScript) and press Enter.
Set `tessera.commentCompletions` to `false` to disable this comment trigger
while automatic suggestions are off. Keep VS Code inline suggestions enabled.

To generate a standalone Python program, type a top-level comment such as
`#make a snake game` and press Enter. The **Python** model receives the full
request and defaults to a terminal interface when the comment leaves the
interface open. Tessera checks the Python syntax and retries once when
the response is incomplete. For short Python comments, the **Structured data
and SQL (autocomplete)** model can condense the request before generation.
Configure these roles under **Add Local GGUF**. **Python (fast autocomplete)**
handles ordinary code suggestions.
The status bar and dashboard show the GGUF from the current editor's last
inline request. Hover over the status bar item for the request type, model ID,
and full path. For Python comments, the tooltip and dashboard also show the
parsing model. **Show Output** records route changes.

Run **Tessera: Ask** to enter a prompt and open the response beside your editor.
For a conversation, open Tessera Chat from the dashboard or use
`@tessera` in VS Code Chat.
Select code to explain, refactor, or generate tests from the dashboard.
Refactors and generated tests open in a diff preview for review.

The extension retains aggregate completion metrics in memory for the current
session. **Tessera: Export Local Metrics** writes them to a file you choose.
The extension sends inference requests only to its local model process.
