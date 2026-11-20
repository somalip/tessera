# Structured-data autocomplete

The local parsing route uses a stock Apache-2.0 Qwen2.5-Coder-0.5B base
checkpoint at revision `8123ea2e9354afb7ffcc6c8641d1b2f5ecf18301`, converted
to GGUF with Q4_K_M quantization. It completes JSON, JSONC, YAML, TOML,
SQL and regex. It also handles recognized SQL strings and the first pattern
argument of common `re` calls or the input string to `json.loads` in Python.

Set `tinycoders.parsingAutocompleteModelPath` to the included GGUF, or choose
**Structured data and SQL (autocomplete)** in **TinyCoders: Add Local GGUF**.
The setting accepts a compatible Qwen2.5-Coder fill-in-the-middle checkpoint.

Markdown prose goes to the configured documentation model. Inside tagged
Markdown fences, the fence language picks the completion model. Python
docstrings go to documentation, and regular Python code and comment
instructions go to the Python autocomplete model. Explicit model pins still
take precedence.
