# Local runtime

Install llama.cpp and set `tinycoders.serverPath` in VS Code if `llama-server`
is outside PATH. Set `tinycoders.pythonModelPath` to a local GGUF. For the initial
Python slice, use the Apache-2.0 [Qwen2.5-Coder-0.5B-Instruct GGUF](https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF/tree/main)
Q4_K_M artifact. Open a Python file and type or invoke inline suggestions in
the Command Palette. Runtime logs appear in the TinyCoders output channel.
