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

## Capsule verifier comparison

Pass each candidate GGUF to `eval.capsule_report` with an identical licensed,
frozen execution fixture set. The benchmark fixes work orders so it measures
the coder route without planner variation. Pass `--escalation-model` to use
the same larger local GGUF across all arms.

```sh
python -m eval.capsule_report --lang python --fixtures python-heldout.jsonl \
  --model base-0.5b.gguf --model python-tuned.gguf --retries 1 \
  --output artifacts/capsule-python-comparison.json
```

Reports include first-attempt pass rate, the fraction of tasks that reached
escalation, average rendered prompt tokens across candidate attempts, and
final pass rate. Without an escalation model the escalation rate is zero.
Check benchmark digests against each fine-tune's contamination audit before
interpreting the scores.

### Initial Python result

The local CC0-1.0 Python held-out suite had eight tasks. The fine-tune's
training audit records no accepted overlap and includes the fixture digest
`a21a15d4297f9fe3dcbb78b4a99071fed3bb57f344344ebc72e530a19fb110ba`.
Each run allowed one small-model retry, with escalation and minimization
disabled.

| Model | Pass@1 | Final passes | Escalation rate | Mean capsule tokens |
| --- | ---: | ---: | ---: | ---: |
| Qwen2.5-Coder-0.5B-Instruct, Q4_K_M | 0/8 | 0/8 | 0% | 138.25 |
| Qwen2.5-Coder-1.5B-Instruct, Q4_0, untuned | 1/8 | 1/8 | 0% | 137.33 |
| Qwen2.5-Coder-1.5B-Instruct, Q4_0, Python fine-tune | 1/8 | 1/8 | 0% | 137.33 |

The fine-tune beat the smaller baseline by one task. Both 1.5B models
passed the same task. This suite gives no evidence of a fine-tuning gain
at matched model size.
