# Model training

## Python

Install `train/requirements.txt` and provide a local Hugging Face snapshot of the
Apache-2.0 [Qwen2.5-Coder-0.5B](https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B).
Record the snapshot revision and retain the upstream LICENSE. Use the converter
and `llama-quantize` from the same llama.cpp build. Pull the verifier image
documented in `eval/README.md`.

```sh
python -m train.smoke_inputs --base /path/to/qwen-tokenizer-snapshot \
  --output artifacts/smoke-inputs --converter /path/to/llama.cpp/convert_hf_to_gguf.py \
  --quantizer /path/to/llama-quantize
make train LANG=python CONFIG=artifacts/smoke-inputs/config.yaml
```

The smoke config uses a small randomly initialized Qwen2 network with Qwen's
tokenizer. It runs one optimizer step each for CPT, verified SFT, and verified
rejection-sampling fine-tuning, followed by F16 GGUF export and Q4_K_M
quantization. It runs on CUDA, Apple MPS, or CPU. Its .tcm is for local testing.

For a full run, inherit `python.yaml`, set the actual corpus, teacher, benchmark,
and llama.cpp paths, and attest that the teacher's terms allow training. Use
the same benchmark snapshots that were supplied to the corpus pipeline.
The base configuration schedules about five billion tokens at its default
sequence length and gradient accumulation on one device. Hardware and token
budgets should be measured before scheduling a full run. The trainer currently
uses a single device.

Optionally provide an in-language importance matrix generated with
`llama-imatrix`. Set `trim_vocab_padding: true` in a separate run to measure
the effect of removing only unused trailing embedding rows. Token IDs remain
stable. Compare the resulting models using the same evaluation fixtures.

Set `eval_args` to include every suite, the benchmark license when necessary,
and the baseline and competitor reports to enable automatic release packaging.
Alternatively, run `make eval` against the candidate and write its report to
the build directory before running `make package`. Pass `--training-audit` with
the corpus pipeline’s `stats.json` when running evaluation separately. Release packages require a
passing evaluation report for the exact candidate GGUF.

## Overnight C++ generation

Run from the repository root on the Mac with the existing C++ competency
experiment under `artifacts/cpp-models`, its Qwen 1.5B snapshot and predecessor
corpus, and the local llama.cpp b12244 binaries. These are local experiment
inputs. Keep Docker Desktop running with the pinned verifier images already
present. The runner uses no Copilot, Codex API, or remote teacher.

```sh
.venv/bin/python -m train.cpp_overnight --check
run="artifacts/cpp-overnight/$(date +%Y%m%d-%H%M%S)"
caffeinate -is .venv/bin/python -m train.cpp_overnight --hours 8 --output "$run"
```

Keep the Mac on power and the terminal open. For a background run that survives
closing the terminal, use `nohup caffeinate -is` in place of `caffeinate -is`
and append `> "${run##*/}.log" 2>&1 < /dev/null &` to the command.
Each run needs a fresh output directory and at least 8 GB of free working space.

The runner continues the existing C++ generation checkpoint for one LoRA epoch.
Training applies the loss to verified C++ answers and uses the English prompts
as context. Quantization uses an importance matrix measured from C++ solutions
in the audited training split. This prioritizes precision for weights used by
C++ inputs. The sweep tests three code-calibrated quantizations and one
uncalibrated control.

Read `summary.json` for the baseline, each candidate, and the best eligible
local GGUF, if any. Eligibility requires strictly more C++ cases passing the
sandbox and GCC debug iterators, every baseline pass retained, at least as many
normal stops, at least 5% lower aggregate inference time on matched prompts, and
a GGUF smaller than 1,000,000,000 bytes. A timed-out run retains completed
results. If training finished before the deadline, rerun the sweep with a
fresh `--output` and `--reuse-training /path/to/previous-run` to skip the
fine-tune. The six-case suite provides local experimental evidence. Release
packaging and registry publication use the
existing release evaluation, hardware profiles, and package checks.
