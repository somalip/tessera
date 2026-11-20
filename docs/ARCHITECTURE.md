# Tessera architecture

The offline build plane produces size-bounded GGUF packages. The local VS Code
runtime consumes the versioned model manifest and registry schemas, and sends
inference requests to a llama.cpp process on loopback.

The manifest SHA-256 covers the GGUF bytes. The registry entry SHA-256 covers
the entire .tcm ZIP. Registry signatures cover the raw UTF-8 index bytes.
Model packages have a strict decimal 1 GB limit.

Milestones M0 through M9 and their acceptance criteria are defined in the README.

## Model selection and residency

The router honors the file or workspace pin first. It prefers embedded and
project-specific languages when the cursor or build files disambiguate the
document, then tries its VS Code language, filename globs, siblings, and the
configured generalist. Tree-sitter detects SQL inside Python strings. Markdown
fences and HTML script/style regions use local delimiter detection.

The lifecycle serializes changes to model residency and waits for an evicted
server to exit before starting its replacement. Inference leases protect
models in use. The memory budget uses model size, runtime overhead, and context
length estimates. Under the automatic budget, a model above the RAM target can
run as the sole resident model with CPU-only, unlocked memory-mapped weights
and reduced startup overhead. Explicit budgets are enforced. The server
disables the separate RAM prompt cache while retaining the active slot's
reusable prefix.

## Evaluation and release

Build inputs are local snapshots. The training audit ties tokenized data
to benchmark digests and tokenizer bytes. Release evaluation compares
the candidate with base and competitor reports from the same fixtures.
Package creation and registry signing verify the reported candidate weight
digest and the size ceiling. Publish a registry only after independently
running the reference hardware profiles for the candidate.
