# TinyCoders

TinyCoders supplies local fill-in-the-middle completion and chat in VS Code.
It routes the current file and cursor to a compatible GGUF model and runs
the model in a CPU-first llama.cpp server on loopback.

Set `tinycoders.serverPath` to a compatible llama-server executable and
`tinycoders.pythonModelPath` or `tinycoders.typescriptModelPath` to a local
Qwen2.5-Coder model. Open a supported file and type to trigger inline
suggestions. If you have a signed registry, configure its HTTPS URL and trusted
Ed25519 public key and run **TinyCoders: Install Model**.

Choose a model in the status bar. Use `@tinycoders` in VS Code Chat or select
code and run **TinyCoders: Explain Code**, **Refactor Code**, or **Write Tests**.
Refactors and generated tests open in a diff preview for review.

The extension retains aggregate completion metrics in memory for the current
session. **TinyCoders: Export Local Metrics** writes them to a file you choose.
The extension sends inference requests only to its local model process.
