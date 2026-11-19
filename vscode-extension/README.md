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
executable is outside PATH. Open a supported file and type to trigger inline
suggestions. Use **Choose Routing Model** to pin a model for the file or workspace.

Open TinyCoders Chat from the dashboard or use `@tinycoders` in VS Code Chat.
Select code to explain, refactor, or generate tests from the dashboard.
Refactors and generated tests open in a diff preview for review.

The extension retains aggregate completion metrics in memory for the current
session. **TinyCoders: Export Local Metrics** writes them to a file you choose.
The extension sends inference requests only to its local model process.
