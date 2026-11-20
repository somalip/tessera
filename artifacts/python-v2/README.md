# Python model comparison

These are local experiments for TinyCoders. The chat evaluation runs eight
previous Python prompts and eight new Python implementation and maintenance
prompts. The inline evaluation runs four fresh fill-in-the-middle tasks. Each
generated answer receives one attempt and is executed inside the repository's
network-disabled, resource-limited Python sandbox. The fixture authors'
solutions passed the same checks. The local fine-tuning examples were checked
against these fixtures and the frozen HumanEval snapshot using the repository's
existing overlap detector. No new benchmark task was used as supervision.

The chat comparison uses temperature zero, seed 42 and 512 output tokens. Inline
completion uses the project's FIM token order and 96 output tokens. The Qwen2.5
models run on CPU with llama.cpp b8180. The Qwen3.5 comparisons use Metal and
verified llama.cpp b12244 after problems with older CPU inference.

| GGUF | Previous chat | Fresh chat | Inline |
| --- | ---: | ---: | ---: |
| Previous Qwen2.5-Coder-1.5B fine-tune (935 MB) | 2/8 | 2/8 | 3/4 |
| Qwen3.5-2B IQ3_XXS (932 MB) | 1/8 | 1/8 | 0/4 |
| Qwen3.5-0.8B Q8_0 (834 MB) | 1/8 | 1/8 | 0/4 |
| Second Qwen2.5-Coder-1.5B fine-tune (935 MB) | 2/8 | 1/8 | 3/4 |
| Previous weights re-quantized to Q4_K_M (986 MB) | 1/8 | 0/8 | 3/4 |

The Qwen3.5 downloads are pinned and verified against their published SHA-256
digests. The two `*-source.json` files record the source revisions and the
published Apache-2.0 metadata. The original fixtures and supervision are
CC0-1.0. These narrow evaluations measure short code generation and editing
tasks. Multi-file programming and the full TinyCoders release gates require
separate evaluation.

The second fine-tune used 21 sandbox-verified examples, including 13 new
examples, over two epochs. Three new examples were filtered for overlap.
See `training_report.json` for the checkpoint and fixture hashes. All four
challengers scored below the active model on chat. The
original 935 MB Qwen2.5-Coder fine-tune remains the VS Code selection.
