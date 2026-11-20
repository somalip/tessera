# Evaluation

Pull `python:3.12.12-slim` before evaluating Python synthesis tasks. The verifier
uses Docker with networking disabled, a read-only root, an unprivileged user,
and bounded scratch storage, memory, CPU, process count, and wall time.

Use JSONL (optionally gzip) from a licensed, version-pinned benchmark snapshot.
HumanEval uses its upstream `task_id`, `prompt`, `test`, and `entry_point` fields.
MultiPL-E uses `name` or `id`, `prompt`, and `tests`. For held-out FIM, export
`eval.suites.heldout.build` results as JSONL. Other suites accept `id`, `prompt`,
`tests`, and optional `suffix` and `expected`. Supply SPDX per record or via
`--license` after verifying the fixture license.

```sh
make eval LANG=python MODEL=/path/to/model.gguf \
  EVAL_ARGS='--suite humaneval=/path/to/HumanEval.jsonl.gz --license MIT'
```

Repeat `--suite` for each benchmark in `gates.yaml`. Run the same fixture
snapshots for the base, competitor, and candidate. Pass `--baseline` and
`--competitor` with the two reference report paths for the release gate.
Fixture digests must match across all three reports.

For the FIM context A/B, build the extension, then run
`python -m eval.context_ab --fixtures repo-fim.jsonl --model candidate.gguf --output artifacts/context-ab.json`.
Each fixture needs `id`, `path`, `license`, `prompt`, `suffix`, `expected`,
and a `context` list of objects with `path` and `text`. The two arms use the
extension's FIM builder with identical prompts and decoding settings apart
from the BM25 context. Live language service definitions are unavailable in
this offline comparison.

For TypeScript, Rust, Go, Java, C, and C++, run
`python -m verifiers.prepare LANGUAGE` to install the pinned sandbox image.
Use MultiPL-E and the regional held-out suites for compiled languages.
Compiled execution fixtures must combine the prompt, candidate, suffix, and
tests into a single file with an entry point. Java uses `Main.java`.

Profile runtime separately with the same candidate bytes on each reference
machine. Both modes test a 1–2K-token FIM prompt. Warm mode primes the prefix
cache and varies the code near the cursor.

```sh
python -m eval.profile_runtime --model candidate.gguf --memory-mib 1024 \
  --mode cold --output artifacts/profile-cold.json --enforce
python -m eval.profile_runtime --model candidate.gguf --memory-mib 1024 \
  --mode warm --output artifacts/profile-warm.json --enforce
```

Pass a reference result with `--system-report` to include its targets in the
quality gate. Each profile records model digest, platform, load time,
time to first content token, median throughput, and sampled peak RSS.
