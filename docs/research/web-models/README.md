# TinyCoders web specialists

These experimental models share the Apache-2.0 Qwen3.5-0.8B Q8_0 weights.
Each embeds separate chat instructions for its language and supports chat and
edits. The variants use prompt specialization without additional training.

| Model | Focus | VS Code language IDs |
| --- | --- | --- |
| javascript-tiny | Modern JavaScript for browsers and Node.js | `javascript`, `javascriptreact` |
| html-tiny | Semantic markup and accessible forms | `html` |
| css-tiny | Stylesheets, responsive layouts, and interaction states | `css` |

Build all three from the repository root using the same verified base GGUF,
snapshot metadata, metadata editor, and runtime as the
[general-purpose specialists](../general-models/README.md).

```sh
.venv/bin/python -m tools.build_specialties \
  --base "$BASE_GGUF" --source "$SOURCE_METADATA" \
  --metadata-editor "$METADATA_EDITOR" --server "$LLAMA_SERVER" \
  --specialty javascript --specialty html --specialty css \
  --output artifacts/web-models
```

The output includes standalone GGUFs, TCM packages, and smoke reports with the
actual completions. The CC0-1.0 smoke prompts check array mapping, label and
input association, and a two-column grid. These checks cover specific output
features. The smoke packages are ineligible for registry signing.

To chat with a built specialist locally, pass its GGUF to `llama-cli`.

```sh
llama-cli -m artifacts/web-models/javascript/javascript-tiny.Q8_0.gguf \
  --jinja --reasoning off -c 2048
```

## Overnight fine-tuning

From the repository root, run:

```sh
make web-overnight
```

On macOS, `caffeinate -i make web-overnight` prevents idle sleep during the run.

The command runs offline, rotates through the three languages, and tries three
learning rates per language within an eight-hour budget. Each trial takes 12
training steps by default and starts from
the same Qwen3.5 checkpoint, trains the final two feed-forward blocks with the
language's existing chat template, and evaluates the resulting Q8_0 GGUF on
that language's frozen holdout. The original GGUFs are scored on the same
prompts for comparison.

The output defaults to `artifacts/web-overnight/<timestamp>/`. Each language's
`best.gguf` points to the fine-tuned candidate with the most passing cases.
Ties favor more passing completions without Markdown fences, then the earlier
trial. The original model may still score higher. Trial logs, scores and
baseline scores remain available alongside `summary.json`. The bundled cases
use a small, original CC0-1.0 fixture set for experimental comparison.

To set a different budget or run a quick pipeline check:

```sh
make web-overnight WEB_ARGS='--hours 6 --threads 4'
make web-overnight WEB_ARGS='--hours 1 --rounds 1 --steps 1'
```

The default paths use the three previously built GGUFs under
`artifacts/web-models/`, the repository's local llama.cpp b12244 converter and
runtime, and the pinned
[Qwen3.5-0.8B training snapshot](https://huggingface.co/Qwen/Qwen3.5-0.8B/tree/2fc06364715b967f1860aea9cf38778875588b17).
To provision the Python environment and snapshot on another checkout:

```sh
python3 -m venv artifacts/web-training-venv
artifacts/web-training-venv/bin/python -m pip install -r train/requirements-web.txt
artifacts/web-training-venv/bin/hf download Qwen/Qwen3.5-0.8B \
  --revision 2fc06364715b967f1860aea9cf38778875588b17 \
  --local-dir artifacts/qwen35-08b-training
```

Use `WEB_PYTHON`, `WEB_BASE`, and `WEB_OUTPUT` to override the Make paths.
Runtime paths can be passed through `WEB_ARGS` with `--converter`,
`--quantizer`, and `--server`. Training uses CUDA or Metal when available
and falls back to CPU. Use `--device cpu` to force CPU training. Evaluation
runs on CPU with two threads by default.
