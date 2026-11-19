# TinyCoders architecture

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

## Capsule task routing

The optional task runtime plans a request into JSON work orders. Cursor
language is a hint to the planner. The task router selects a model by role,
difficulty, tier, and language. An exact language match wins against a
generalist at the same difficulty. A local model entry can name a GGUF and
a GGUF LoRA. Their total must be below 1 GB.

The Python sidecar hashes saved workspace files and uses tree-sitter to
reparse changed content. SQLite records symbols, file versions, deleted paths,
decisions, and recipes as append-only rows. The capsule retrieves requested
symbols and follows their workspace references. It sends paths, names, and
signatures. The full rendered chat prompt, including the system preamble,
must fit the default 1,500-token cap as counted by llama.cpp.

The planner selects check IDs from a user-supplied catalog. Every supplied
check must appear in a work order and every order needs a language-matched
execution test. The verifier uses fixed Docker commands and preinstalled
images. Each check runs without network or a workspace mount. A failed check
is summarized by its ID and exit or timeout status. A stable fingerprint goes
into the next attempt. After the configured small-model retries, the router
tries a larger local model if configured. Remote escalation is opt-in.

After verification passes, delta debugging reruns chat and verification
while removing groups of signatures. It finds a context where removing any
one remaining signature breaks verification. The runtime caches signature
positions by model and task type and verifies each reuse. If the recipe
fails, it falls back to the full capsule within the cap. Task results show
verified standalone source for review in VS Code.
