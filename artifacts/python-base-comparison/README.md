# Python fine-tuning versus the untuned checkpoint

The baseline is Apache-2.0 Qwen2.5-Coder-1.5B-Instruct at revision
`2e1fd397ee46e1388853d2af2c993145b0f1098a`, directly converted and quantized
to Q4_0. Both fine-tunes descended from those same weights and use the same
Q4_0 format. Each GGUF is 934,954,496 bytes.

The paired comparisons cover two Python chat sets with eight tasks each,
four inline tasks, and 48 HumanEval completion tasks. The HumanEval sample
was drawn with seed 42 from the frozen MIT fixture after excluding the five
previously scored smoke tasks. Both fine-tunes were decontaminated against
the full HumanEval snapshot. The second chat set and inline set also pass the
repository overlap check against both accepted local training sets.

Inference uses the same llama.cpp build and request parameters within each
comparison. Docker executes generated code with networking disabled in the
repository's pinned Python sandbox. Each score is first-attempt execution
pass count. The chat run uses temperature zero, seed 42 and a 512-token
output cap. Inline uses the FIM prompt and a 96-token cap. HumanEval uses the
repository completion evaluator with its 256-token cap.

The 16 chat tasks are short implementation and bug repair requests. The
four inline tasks and 48 HumanEval tasks are completion checks. These
comparisons support local model selection. They do not cover multi-file
repository work or all release suites.

| Q4_0 checkpoint | CPU chat | Metal chat | CPU inline | Metal HumanEval |
| --- | ---: | ---: | ---: | ---: |
| Untuned | 2/16 | 2/16 | 3/4 | 27/48 |
| First fine-tune | 4/16 | 4/16 | 3/4 | 26/48 |
| Second fine-tune | 3/16 | 4/16 | 3/4 | 26/48 |
| Mixed-format fine-tune | 1/16 | — | 3/4 | 23/48 |
| Scaled first fine-tune | 4/16 | — | 3/4 | 28/48 |

The active VS Code checkpoint is the first fine-tune at the start of the
comparison. Its chat advantage on CPU came from the fresh set with a score of
2/8 versus 0/8 untuned. Both scored 2/8 on the original set. The second
fine-tune scored 1/8 on the fresh CPU set and 2/8 on the original set.

The mixed-format run used 74 examples derived from 21 original Python
solutions, including sandbox-verified repairs and completions. It used one
rank-8 LoRA epoch. The scaled candidate interpolates 75% of the first
fine-tune's learned weight changes into the untuned checkpoint before Q4_0
quantization. The original and blended GGUFs were scored before any default
change. Its 48-task HumanEval result was then checked with a disjoint 24-task
confirmation sample drawn with seed 73.

The confirmation sample scored 14/24 for both the untuned and scaled models.
Across the two nonoverlapping completion samples, the scaled fine-tune scored
42/72 and the untuned model scored 41/72. The scaled model matched the first
fine-tune's CPU chat and inline scores and exceeded its 48-task completion
score by two tasks.

TinyCoders in VS Code now points to `scaled.Q4_0.gguf`. The installed
extension's CPU host loaded that exact file and returned streamed chat and
inline completions before the settings update.
