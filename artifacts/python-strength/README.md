# Compact Python coding quality

The comparison starts from the active 934,954,496-byte Qwen2.5-Coder
fine-tune. The requested 35–40% improvement is interpreted as relative
improvement in first-answer Python implementation and bug-fix accuracy.
Each model uses a single response per task. No model receives the tests.
Python outputs execute in the repository's pinned, network-disabled sandbox.

The screening fixture contains eight established maintenance tasks. A separate
12-task CC0-1.0 fixture was frozen before scoring and checked against all
prior local training examples with the repository overlap detector. Every
reference solution passed the same container checks. Strong candidates advance
to this fixture and then to completion checks before a settings change.

All candidate GGUFs must be strictly below one billion bytes. Downloaded
models are pinned by upstream revision and verified by SHA-256. The
Qwen2.5 alternatives use Q6_K for the 32 adapted projections or IQ4_NL across
the model. The reasoning runs use a 256-token reasoning budget plus up to
512 generated answer tokens. Greedy runs use a 512-token cap. The fixture
harness records the token count and wall time so comparisons can account for
any interface cost.

The separate exercise fine-tune uses 44 MIT-licensed, execution-verified
Exercism Python solutions plus 28 approved local examples for replay. The
training audit records the upstream revision and hashes of the corpus and
benchmark snapshots. Accepted data passed the project license and overlap
checks before training.

| Candidate | GGUF size | Screening pass count | Fresh pass count |
| --- | ---: | ---: | ---: |
| Active Python fine-tune, greedy | 935 MB | 2/8 | 2/12 |
| Active Python fine-tune, plan-first prompt | 935 MB | 0/8 | — |
| Qwen3.5-2B with bounded reasoning | 932 MB | 0/8 | — |
| Qwen3-1.7B with bounded reasoning | 940 MB | 1/8 | — |
| MiniCPM5-1B, greedy | 688 MB | 1/8 | 1/12 |
| MiniCPM5-2B with bounded reasoning | 970 MB | 0/8 | — |
| Higher precision in the adapted projections | 974 MB | 2/8 | 2/12 |
| Nonlinear four-bit quantization | 941 MB | 1/8 | — |
| Exercise fine-tune | 935 MB | 0/8 | 3/12 |
| Half of the exercise update applied to the active weights | 935 MB | 1/8 | 3/12 |
| Compact vocabulary with five-bit weights | 959 MB | 1/8 | 0/12 |
| Active model with an explicit Python contract prompt | 935 MB | 1/8 | 2/12 |

The active model passed 4/20 across the two sets. The next count above the
requested relative gain threshold is 6/20, a 50% relative gain and a
10-percentage-point absolute gain. These counts measure only the tasks and
decoding settings in this report.


The vocabulary experiment retained 44,283 of 151,936 rows, including chat and
infill control tokens, and used the freed space for Q5_K_S weights. The
exercise fine-tune gained one fresh task but lost two screening tasks.
Applying half of the learned exercise update recovered one screening task
and tied the active model overall. The best completed challenger scored
4/20, below the 6/20 promotion threshold. VS Code points to the existing
935 MB checkpoint. No challenger advanced to completion regression testing.
