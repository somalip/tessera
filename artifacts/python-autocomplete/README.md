# TinyCoders Python autocomplete

Type a Python comment and press Enter. TinyCoders uses the comment and the
code on both sides of the cursor to offer a short inline suggestion. Press
Tab to accept it. It also completes partially typed expressions.

```python
def is_even(number):
    # Return whether the number is divisible by two
    return number % 2 == 0
```

Use the included TinyCoders VSIX and run **TinyCoders: Add Local GGUF**.
Choose **Python (fast autocomplete)** and select
`python-autocomplete.IQ4_NL.gguf`. The extension needs a local llama.cpp
server. Set `tinycoders.serverPath` if it is outside your PATH.
To show suggestions only after comments, turn off `tinycoders.autocomplete`
and keep `tinycoders.commentCompletions` enabled.

The router registers this checkpoint for fill-in-the-middle only. It uses a
768-token context, a 32-token generation cap, and stops at the first line
break. It skips repository retrieval on this route. The existing model
cache can keep it resident within the configured memory budget.

## Model and evaluation

This is a 354,304,640-byte IQ4_NL GGUF derived from the Apache-2.0
Qwen2.5-Coder-0.5B base. The rank-8 LoRA update was trained on 96 original
CC0-1.0 comment and partial-line examples, then merged before quantization.
The base revision and training loss are recorded in `training.json`.

| Checkpoint | Model size | AST matches | Median first token | Median completion | Server startup |
| --- | ---: | ---: | ---: | ---: | ---: |
| Tuned 0.5B IQ4_NL | 354 MB | 9/12 | 75 ms | 121 ms | 1.05 s |
| Stock 0.5B Q4_K_M | 398 MB | 7/12 | 167 ms | 260 ms | 0.77 s |
| Previous tuned 1.5B Q4_0 | 935 MB | 8/12 | 195 ms | 362 ms | 1.94 s |

The timings are from a local CPU-only llama.cpp b12244 run. Startup is
launch-to-health with normal filesystem caching. Request timings exclude
VS Code debounce, rendering, and router waits. AST matches compare against
listed answers and can miss equivalent code. This is a 12-prompt smoke
test with held-out operations, and results may differ with longer context,
other hardware, or other codebases. See `evaluation.json` for all generations
and quantizations tested. IQ4_NL was the quickest in this run among the
quantizations that matched nine prompts.
