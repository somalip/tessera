# Local Python coding experiment

The candidate starts from Apache-2.0 Qwen2.5-Coder-1.5B-Instruct, revision
`2e1fd397ee46e1388853d2af2c993145b0f1098a`. The upstream license is in
`base/LICENSE`. The original examples in this directory are CC0-1.0.

`finetune.py` applies rank-8 LoRA to attention and MLP projections in the final
eight transformer blocks. It uses the repository's overlap filter and Docker
verifier, updates on assistant code tokens, then merges the adaptation into the
checkpoint. `training_report.json` records the dataset and checkpoint provenance.
The original GGUF, the untuned 1.5B model and the fine-tuned 1.5B model are
compared by `evaluate.py` on the same eight frozen Python chat prompts.
Generation runs through local llama.cpp. Python output runs only in the pinned
Docker verifier. The evaluation accepts raw Python or a single fenced code block.

`tuned.Q4_0.gguf` is the local candidate and occupies 934,954,496 bytes. The
repository's .tcm release target is 900 MB and its hard ceiling is 1 GB.
This run evaluates Python chat requests for implementation and repair. Release
gates, broad benchmark regressions, inline completion and multi-file repository
work are outside the measurement.

| Model | Python chat tasks | HumanEval smoke |
| --- | ---: | ---: |
| Previous 0.5B GGUF | 0/8 | 4/5 |
| Untuned 1.5B, Q4_0 | 2/8 | 4/5 |
| Fine-tuned 1.5B, Q4_0 | 2/8 | 4/5 |

Both 1.5B variants passed log summarization. The fine-tuned variant passed
integer duration repair and failed JSON record decoding. The untuned variant
had the reverse result. The higher-capacity checkpoint scored better than the
previous model on these chat prompts. The fine-tune did not increase the total
score over the untuned checkpoint on either suite.
