# Tessera C++ models

[Higher-capacity C++ generation and stopping work](competency/README.md)

Install `tessera-cpp.vsix` using **Extensions: Install from VSIX**. In a
trusted workspace, run **Tessera: Add Local GGUF** and register both models.

| Role | GGUF | Use |
| --- | --- | --- |
| C++ (fast autocomplete) | `fim/cpp-autocomplete.IQ4_NL.gguf` | Complete an expression or add a line after a C++ comment. |
| C++ | `chat/cpp-generation.Q4_K_M.gguf` | Use chat, or write `// tessera: Implement …` and move to the next line for inline generation. |

The extension needs a local llama.cpp server. Set `tessera.serverPath` to
the executable if it is outside your PATH.

## Training and evaluation

Both variants use Qwen2.5-Coder-0.5B and follow the Python autocomplete
experiment’s merged rank-8 LoRA recipe. Autocomplete starts from the base
checkpoint. Generation starts from the Instruct checkpoint. Each trains
for two epochs on 96 original CC0-1.0 C++20 examples. The pinned upstream
revisions, weight hashes, losses, and corpus and holdout hashes are in each
run’s `training.json`. Each run includes its Apache-2.0 upstream license.

Install `train/requirements.txt` in the training environment. From the
repository root, point `converter` and `runtime` to the llama.cpp
b12244 converter script and binary directory. Use local Hugging Face
snapshots that match the revisions and hashes in the training reports.

```sh
export PYTHONPATH=.
root=artifacts/cpp-models
python "$root/train_cpp.py" fim "$root/base" "$root/fim" \
  --revision 8123ea2e9354afb7ffcc6c8641d1b2f5ecf18301
python "$root/train_cpp.py" chat "$root/instruct" "$root/chat" \
  --revision ea3f2471cf1b1f0db85067f1ef93848e38e88c25

for role in fim chat; do
  if [ "$role" = fim ]; then
    base=base
    name=cpp-autocomplete
    quant=IQ4_NL
  else
    base=instruct
    name=cpp-generation
    quant=Q4_K_M
  fi
  run="$root/$role"
  cp "$root/$base/LICENSE" "$run/LICENSE"
  python "$converter" "$root/$base" --outtype f16 --outfile "$run/untuned.f16.gguf"
  python "$converter" "$run/checkpoint" --outtype f16 --outfile "$run/$name.f16.gguf"
  for target in "$run/untuned" "$run/$name"; do
    "$runtime/llama-quantize" "$target.f16.gguf" "$target.$quant.gguf" "$quant"
  done
  python "$root/evaluate_cpp.py" "$role" --run "$run" \
    --server "$runtime/llama-server" "$run/untuned.$quant.gguf" "$run/$name.$quant.gguf" \
    > "$run/evaluation.json"
done
```

Evaluation uses CPU inference, matching quantization for base and tuned
weights, and the existing pinned, network-disabled GCC verifier. The
fixtures cover single-line completion and short function generation. The
local GGUFs can be loaded directly in Tessera. Registry release requires
the broader evaluation and reference hardware profiles.

| Role | Tuned GGUF size | Untuned | Tuned |
| --- | ---: | ---: | ---: |
| Autocomplete | 354,304,768 bytes | 3/6 | 1/6 |
| Generation | 397,807,584 bytes | 1/6 | 5/6 |

The generation fine-tune improved short C++ function generation on this
suite. The autocomplete fine-tune regressed. The six cases per role are a
local smoke benchmark. See `fim/evaluation.json` and
`chat/evaluation.json` for source outputs, verifier results, and weight hashes.
