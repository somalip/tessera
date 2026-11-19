# Local runtime

Download the pinned llama.cpp build and Apache-2.0 Python starter model with
Python 3.12 or newer.

```sh
python -m tools.fetch_runtime --starter
```

The installer verifies the upstream SHA-256 digests before extracting the
runtime and prints the two VS Code settings to update. The pinned release
covers macOS ARM64 and x64, Linux x64, and Windows x64. You can also set
`tinycoders.serverPath` to an existing compatible `llama-server`, and
`tinycoders.pythonModelPath` or `tinycoders.typescriptModelPath` to a local
Qwen2.5-Coder GGUF. Use the status bar to choose the model.
The starter comes from the official [Qwen2.5-Coder-0.5B-Instruct GGUF](https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF/tree/main).

Inference defaults to CPU. Set `tinycoders.gpuLayers` to offload layers to a
supported GPU. The TinyCoders Output channel shows server startup and inference
errors.
