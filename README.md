# Tessera

Tessera is a VS Code extension for running coding models locally. It offers inline code suggestions and manages how many models stay loaded in memory. It can choose a model based on the language at your cursor, including SQL inside a Python string. You can also pin a model from the status bar.

Tessera starts and stops local llama.cpp servers as you switch models. It unloads idle models to free memory and keeps models loaded while they are in use. Inference works offline once the runtime and model are installed.

Each model package Tessera ships must be under 1 GB on disk. Runtime memory also depends on the model, context length, and server overhead.

## Try it in VS Code

See [GitHub Releases](https://github.com/somalip/tessera/releases) for downloads and the [release guide](releases/README.md) for the experimental model packages.

Use Python 3.12 and Node.js 22. Run these commands from the repository root.

```sh
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
npm ci --prefix vscode-extension
make vsix
.venv/bin/python -m tools.fetch_runtime --starter
```

1. In the VS Code Extensions view, choose **Install from VSIX…** and select `artifacts/tessera.vsix`.
2. Apply the two VS Code settings printed by the runtime installer. The installer downloads llama.cpp and a small Qwen Python starter model.
3. Open a Python file and start typing to try inline suggestions.

See the [runtime guide](runtime-bin/README.md) for supported platforms, GPU settings, and using an existing GGUF model.

## Develop Tessera

- Run `make check PYTHON=.venv/bin/python` for lint, type checks, and unit tests.
- Run `make test-ext` for the VS Code integration test with a mock inference server.
  The test runner downloads VS Code by default. To use an existing installation, run
  `make test-ext VSCODE_EXECUTABLE="/path/to/vscode-executable"`.
- Read the [architecture guide](docs/ARCHITECTURE.md) for routing, memory management, and the release process.
- See [AGENTS.md](AGENTS.md) for contributor rules.

The [registry guide](registry/README.md) explains how the extension verifies and installs signed model releases. Tessera model packages use the `.tcm` format and include GGUF weights, a manifest, an evaluation report, and licensing files. The [JSON schemas](schemas/) define the manifest and registry contracts.

## Model development

The project explores whether small models tuned for one language can outperform a generalist of the same size. Python is the first target. Training starts from a permissively licensed base model and uses allowlisted data with evaluation examples removed.

Candidate models are evaluated against their base model and a competitor on the same fixtures. Release checks cover code quality, package size, and runtime performance on reference hardware.

See the [data](data/README.md), [training](train/README.md), [evaluation](eval/README.md), and [CI](ci/README.md) guides for the workflow and release criteria.

## Project milestones

### M0 — Skeleton & contracts

- Create repo layout, `manifest.json` / `registry.json` JSON Schemas, TypeScript + Python types generated from schema.
- Done when schema validation tests pass and `make check` runs lint and tests for Python and TypeScript.

### M1 — Vertical slice with an off-the-shelf model (no training)

- Extension spawns llama.cpp with a downloaded GGUF, provides FIM inline completion for one language.
- Done when Python inline completions appear in VS Code, cancellation and debouncing work, and the `@vscode/test-electron` integration test passes with a mock server.

### M2 — Router + lifecycle

- Implement detector/policy/lifecycle with two stub models (e.g., Python + TypeScript GGUFs), LRU eviction, status bar picker, fallback chain, mixed-file region routing.
- Done when unit tests cover at least 30 routing cases, including ambiguous `.h` files, `.js` files in TypeScript projects, and Markdown code fences. Tests also verify the memory budget.

### M3 — Registry & installer

- Download, sha256 verify, install to globalStorage, version upgrade/rollback, signed registry verification.
- Done when tests reject tampered releases and installed models work offline.

### M4 — Verifier harness + eval suite (Python first)

- Sandboxed test runner, MultiPL-E/HumanEval wiring, FIM eval builder from held-out repos, `gates.yaml`.
- Done when baseline scores are reproducible within one point across three runs and the suite writes a JSON report.

### M5 — Data pipeline (Python first)

- License filter, MinHash dedupe, tree-sitter parse filter, decontamination, FIM formatting, sharded tokenized output.
- Done when the pipeline runs end to end on a 1% sample, reports zero overlap with evaluation sets, and reports statistics for each stage.

### M6 — Training stages (Python first)

- Config-driven CPT → SFT → rejection-sampling FT → QAT/quantize → package. Add vocab-pruning experiment.
- Done when `make train LANG=python` with a smoke-test config produces a valid `.tcm` under 1 GB in less than an hour on one GPU, and the full config is documented.

### M7 — Context builder & chat/edit features

- BM25 repo context, LSP hints, chat panel, explain/refactor/test-gen commands with edit diff preview.
- Done when A/B harness shows context builder improves FIM eval on repo-level set.

### M8 — Language fan-out

- Add TypeScript, Rust, Go, Java, C/C++ by copying `configs/python.yaml` and implementing `verifiers/<lang>`.
- Done when each language passes its evaluation gate and CI builds all packages.

### M9 — Hardening

- Perf profiling on reference machines, crash recovery for server processes, telemetry (local), docs, marketplace packaging.
- Done when p95 first-token latency and memory use meet their targets on the reference machines.
