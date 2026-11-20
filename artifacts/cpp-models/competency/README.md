# C++ generation and stopping

The latest candidate starts from the F16 weights behind the configured
Python generation checkpoint, derived from Qwen2.5-Coder-1.5B-Instruct. It adapts
the final four blocks with rank-8 LoRA on original, allowlisted C++20 data.
The pinned GCC container checked the supervision before training. The audit
records the examples excluded by the 10-token overlap screen, which compares
model-visible training examples with both the paired suite and the earlier
C++ smoke suite.

TinyCoders treats imperative C++ comment blocks as generation requests.
Requests use separate prompts for complete functions, standalone programs,
and insertions into existing code. The provider checks the finished
answer for JavaScript syntax, unmatched delimiters, obvious statements
outside functions, and repeated blocks. It ends generation when a complete code fence closes
or an extra entry point begins. It retries once and skips automatic
autocomplete on the empty line after a complete statement or block.

## Reproduce the candidate

From the repository root, use the dependencies in
`train/requirements.txt`, the pinned 1.5B tokenizer snapshot and the scaled F16 GGUF from the
Python experiment, and the llama.cpp b12244 converter checkout and binaries.
The GCC and Python verifier images must already be available locally.

```sh
suite=artifacts/cpp-models/competency
run="$suite/v4"
runtime=artifacts/python-v2/llama-b12244
export PYTHONPATH=".:artifacts/cpp-models/tooling/llama.cpp-b12244/gguf-py"

python "$suite/run.py" train "$run" artifacts/python-local/base \
  --base-gguf artifacts/python-base-comparison/scaled.f16.gguf --epochs 2 --learning-rate 0.00008
"$runtime/llama-quantize" "$run/cpp-generation.f16.gguf" \
  "$run/cpp-generation-v4.Q4_0.gguf" Q4_0 4

python "$suite/run.py" evaluate "$run" "$runtime/llama-server" \
  --model cpp-v4 cpp "$run/cpp-generation-v4.Q4_0.gguf" \
  --model deployed-python python artifacts/python-base-comparison/scaled.Q4_0.gguf \
  --model cpp-v1 cpp artifacts/cpp-models/chat/cpp-generation.Q4_K_M.gguf \
  --model cpp-base cpp artifacts/python-local/base.Q4_0.gguf
```

The matched tasks cover interval merging, a sliding window, dependency
ordering, stable frequency ranking, a standalone command-line application,
and insertion into an existing function. Each pass requires a normal
end-of-answer and successful execution in an isolated verifier.

The first 1.5B trial used a single prompt format for both whole implementations
and insertions. It stopped normally on all six cases and passed zero. Many
answers consisted of a function body without its definition. The revised run
uses the same task requirements and tests with mode-specific prompts. The
paired suite informed the prompt revisions. The scores cover this six-task
comparison.

## Results

| Checkpoint and prompt | Size in bytes | Passed | Stopped normally |
| --- | ---: | ---: | ---: |
| Configured Python with the final prompt modes | 934,954,496 | 3/6 | 6/6 |
| Existing C++ generation default with the final prompt modes | 397,807,584 | 0/6 | 5/6 |
| C++ 1.5B adapted from the upstream checkpoint, final prompt modes | 934,954,496 | 1/6 | 6/6 |
| C++ 1.5B adapted from the configured Python weights, Q4_0 | 934,954,496 | 0/6 | 5/6 |
| Same adapter, Q4_K_M with a planning pass | 986,048,000 | 2/6 in the standard verifier | 6/6 |

One of the planned run's two apparent passes used an out-of-range iterator
in `std::partial_sort`. It failed when rerun with GCC's debug iterator
checks, leaving one verified success. These tests leave the Python parity
target unmet.

The [screenshot regression](v4/screenshot-regression.json) used the actual
TinyCoders provider and the Q4_0 adapter trained from the configured
Python weights. It returned a single C++ loop inside a complete program.
The isolated GCC verifier compiled and ran it, and TinyCoders produced no
subsequent suggestion on the blank line.
The previous default generated a loop that failed compilation because it
omitted `<iostream>`. TinyCoders 0.1.23 uses the validated 935 MB checkpoint
for C++ generation and the previous untuned 354 MB checkpoint for
single-line C++ autocomplete, which scored 3/6 against the earlier
autocomplete fine-tune's 1/6.

For the local TinyCoders installer, build the extension and apply the C++
provider update to the 0.1.22 VSIX.

```sh
npm --prefix vscode-extension run build
python artifacts/cpp-models/competency/update_tinycoders.py \
  artifacts/cpp-models/tinycoders-0.1.22-cpp.vsix \
  vscode-extension/dist/providers/cppSnippet.js \
  artifacts/cpp-models/competency/tinycoders-0.1.23-cpp.vsix
```
