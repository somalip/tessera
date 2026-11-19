# Offline corpus build

Prepare licensed JSONL or gzipped JSONL snapshots with `repo`, `path`, `text`,
`license` (one SPDX identifier), and optional `language` (`python` or `text`).
Preserve license evidence and source revision separately when adapting The Stack
or repository exports. Keep general text replay to 10–15% of accepted tokens
for full CPT runs, as measured in `stats.json`.

```sh
python -m data.pipelines.build --source sources.jsonl.gz \
  --benchmark HumanEval.jsonl.gz --benchmark held-out-fim.jsonl \
  --tokenizer /path/to/qwen/tokenizer.json --output artifacts/corpus --sample 0.01
```

Pass every frozen evaluation snapshot as a separate benchmark input. The pipeline
rejects matching source digests and overlapping normalized token shingles. It
rejects detected PII and credentials before emitting tokenized shards. Run with
`--sample 1` for the full corpus after checking the sample's stage counts.

Teacher responses must be licensed for model training. Prepare JSONL records
with `prompt`, `solution`, `tests`, and `license`. Run
`python -m data.synth.verify input.jsonl vetted.jsonl --benchmark held-out.jsonl --terms-permit-training`
to check them against the same frozen fixtures and keep only passing triples.
