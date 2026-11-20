# Local general-purpose TinyCoders models

These four experimental GGUFs use the same Apache-2.0 Qwen3.5-0.8B Q8_0 tensors.
Each embeds its own text chat instructions. They are prompt-specialized
variants with no additional training. The build uses original CC0-1.0 smoke
fixtures and records the actual responses and checks per variant.

| Variant | Task |
| --- | --- |
| documentation-tiny | Markdown documentation and quick starts |
| english-tiny | English grammar and copyediting |
| diagrams-tiny | Mermaid diagrams derived from text |
| summaries-tiny | Meeting summaries and action items |

Run a GGUF from the repository root with the local runtime. Change the path to
select another specialty.

```sh
artifacts/python-v2/llama-b12244/llama-cli \
  -m artifacts/general-models/documentation/documentation-tiny.Q8_0.gguf \
  --jinja --reasoning off -c 2048
```

The TCM files are experimental packages built with the repository's smoke
path, which verifies the manifest, evaluation digest, and package size.
They are ineligible for registry signing under the release gates.

The base is the [official ggml-org conversion](https://huggingface.co/ggml-org/Qwen3.5-0.8B-GGUF/tree/004fd086eccea9f7cf867aa07ba328773beef81d).
Its original filename, upstream metadata and runtime can be found in the local
Python experiment directory. The builder reads those inputs and writes only
within this directory. To see the required build arguments, run
`PYTHONPATH=. .venv/bin/python artifacts/general-models/build.py --help`.

Each specialty was exercised on one original prompt. The documentation output
replaced `brisk setup` with `brisk install`. The Mermaid output included the
requested arrows but added start and end nodes and wrapped the diagram in a
code fence. Review commands and diagram structure before using generated output.
