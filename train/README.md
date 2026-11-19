# Train Python

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
the build directory before running `make package`. Release packages require a
passing evaluation report for the exact candidate GGUF.
