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

## Website downloads

The landing page links to the upstream Qwen coding model on Hugging Face and
to release assets for TinyCoders and the experimental Qwen3.5 specialty
variants. Each specialty is available as a standalone GGUF and as a TCM
archive with its manifest, license, and evaluation report.

Publish the assets before deploying the landing page. From this worktree,
with the TinyCoders VSIX built by `make vsix` and the general-purpose model
artifacts available from the parent checkout, run:

```sh
gh release create tinycoders-downloads-v1 \
  --repo somalip/tessera --target codex/tinycoders \
  --title "TinyCoders downloads" --prerelease \
  --notes "TinyCoders VS Code installer and four experimental specialty variants based on Apache-2.0 Qwen3.5-0.8B Q8_0. The variants share the upstream weights and add specialty chat templates." \
  artifacts/tinycoders.vsix \
  ../artifacts/general-models/LICENSE \
  ../artifacts/general-models/{documentation,english,diagrams,summaries}/*-tiny.Q8_0.gguf \
  ../artifacts/general-models/{documentation,english,diagrams,summaries}/*-tiny.tcm
```

The release tag is part of the public download URLs. Verify the linked assets
are present on the release before deploying `index.html`.
