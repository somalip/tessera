"""Train the final four Qwen2 blocks with a frozen, layer-streamed CPU prefix."""
import argparse
import json
from pathlib import Path
import random
import subprocess

from gguf import GGUFReader
import numpy as np
import torch
from torch import nn
from torch.nn import functional as F
from transformers import AutoConfig, AutoTokenizer
from transformers.models.qwen2.modeling_qwen2 import Qwen2DecoderLayer, Qwen2RMSNorm, Qwen2RotaryEmbedding

from data.pipelines.filtering import records
from eval.report import digest
from finetune import ACTIVE, BASE, ROOT, cpu_adapter, messages

LAYER_COUNT = 4
PROJECTIONS = {
    "self_attn.q_proj": "attn_q",
    "self_attn.k_proj": "attn_k",
    "self_attn.v_proj": "attn_v",
    "self_attn.o_proj": "attn_output",
    "mlp.gate_proj": "ffn_gate",
    "mlp.up_proj": "ffn_up",
    "mlp.down_proj": "ffn_down",
    "input_layernorm": "attn_norm",
    "post_attention_layernorm": "ffn_norm",
}
ADAPTED = ("self_attn.q_proj", "self_attn.v_proj", "self_attn.o_proj", "mlp.down_proj")


def make_layer(config, weights, index):
    with torch.device("meta"):
        layer = Qwen2DecoderLayer(config, index)
    state = {}
    for key in layer.state_dict():
        module, parameter = key.rsplit(".", 1)
        original = weights[f"blk.{index}.{PROJECTIONS[module]}.{parameter}"]
        state[key] = torch.from_numpy(original.astype(np.float32))
    layer.load_state_dict(state, assign=True)
    return layer.requires_grad_(False)


def checked_corpus():
    dataset = ROOT / "training-briefs.jsonl"
    audit = json.loads((ROOT / "corpus-audit.json").read_text())
    if audit["overlap"] != 0 or audit["data_sha256"] != digest(dataset) or any(
        digest(Path(path)) != checksum for path, checksum in audit["benchmarks"].items()
    ):
        raise ValueError("Training or evaluation snapshot changed")
    return list(records(dataset)), audit


def fit(output, epochs, learning_rate, program_repeat, *, corpus_snapshot=None, max_length=768,
        active=ACTIVE, output_name="python-brief"):
    torch.set_num_threads(5)
    torch.manual_seed(42)
    config = AutoConfig.from_pretrained(BASE, local_files_only=True)
    config._attn_implementation = "sdpa"
    config.use_cache = False
    tokenizer = AutoTokenizer.from_pretrained(BASE, local_files_only=True)
    examples, audit = checked_corpus() if corpus_snapshot is None else corpus_snapshot
    reader = GGUFReader(active)
    weights = {tensor.name: tensor.data for tensor in reader.tensors}
    embedding = weights["token_embd.weight"]
    rope = Qwen2RotaryEmbedding(config)
    entries = []
    for row in examples:
        prompt = row.get("messages") or messages(row["brief"])
        prefix = tokenizer.apply_chat_template(prompt, tokenize=True, add_generation_prompt=True)
        target = tokenizer.encode(row["solution"].strip() + "<|im_end|>", add_special_tokens=False)
        ids = prefix + target
        if len(ids) > max_length:
            raise ValueError(f"Overlong training sample: {row['id']}")
        hidden = torch.from_numpy(embedding[ids].astype(np.float32))
        entries.append((hidden, len(prefix) - 1, torch.tensor(target)))

    stop = config.num_hidden_layers - LAYER_COUNT
    groups = [entries[index:index + 4] for index in range(0, len(entries), 4)]
    batches = []
    for group in groups:
        hidden = nn.utils.rnn.pad_sequence([item[0] for item in group], batch_first=True)
        pos = torch.arange(hidden.shape[1])[None, :]
        batches.append([hidden, pos, rope(hidden, pos)])
    del entries
    with torch.no_grad():
        for index in range(stop):
            block = make_layer(config, weights, index).eval()
            for batch in batches:
                hidden, positions, position_embeddings = batch
                batch[0] = block(hidden, position_ids=positions, position_embeddings=position_embeddings)
            del block
            if (index + 1) % 4 == 0 or index + 1 == stop:
                print(f"Cached frozen layers {index + 1}/{stop}", flush=True)

    blocks = nn.ModuleList(make_layer(config, weights, idx) for idx in range(stop, config.num_hidden_layers))
    adapters = {}
    for index, block in enumerate(blocks, start=stop):
        for module in ADAPTED:
            group_name, attr = module.split(".")
            parent = getattr(block, group_name)
            adapter = cpu_adapter(getattr(parent, attr))
            setattr(parent, attr, adapter)
            adapters[index, module] = adapter
    norm = Qwen2RMSNorm(config.hidden_size, eps=config.rms_norm_eps).requires_grad_(False)
    norm.weight.copy_(torch.from_numpy(weights["output_norm.weight"].astype(np.float32)))
    lm_head = torch.from_numpy(weights.get("output.weight", embedding).astype(np.float32))
    parameters = [parameter for parameter in blocks.parameters() if parameter.requires_grad]
    optimizer = torch.optim.AdamW(parameters, lr=learning_rate)
    order = list(range(len(examples)))
    programs = [index for index, row in enumerate(examples) if row["training_source"] == "programs"]
    order.extend(programs * (program_repeat - 1))
    shuffle = random.Random(42)
    losses = []
    print(f"Training {len(examples)} briefs through {LAYER_COUNT} layers", flush=True)
    for epoch in range(1, epochs + 1):
        shuffle.shuffle(order)
        epoch_losses = []
        for step, entry in enumerate(order, 1):
            batch_index, batch_row = divmod(entry, 4)
            _, start, target = groups[batch_index][batch_row]
            length = start + 1 + len(target)
            hidden, positions, (cos, sin) = batches[batch_index]
            hidden = hidden[batch_row:batch_row + 1, :length]
            positions = positions[:, :length]
            position_embeddings = cos[:, :length], sin[:, :length]
            optimizer.zero_grad(set_to_none=True)
            for block in blocks:
                hidden = block(hidden, position_ids=positions, position_embeddings=position_embeddings)
            answer = norm(hidden[0, start:-1])
            # Backpropagate through the frozen vocabulary projection in chunks.
            # Retain the decoder graph once without retaining every token's logits.
            hidden_for_loss = answer.detach().requires_grad_(True)
            loss_value = 0.0
            for offset in range(0, len(target), 128):
                logits = F.linear(hidden_for_loss[offset:offset + 128], lm_head)
                loss = F.cross_entropy(logits, target[offset:offset + 128], reduction="sum") / len(target)
                if not torch.isfinite(loss).item():
                    raise RuntimeError("Nonfinite training loss")
                loss.backward()
                loss_value += loss.item()
            answer.backward(hidden_for_loss.grad)
            nn.utils.clip_grad_norm_(parameters, 1.0)
            optimizer.step()
            epoch_losses.append(loss_value)
            if step == 1 or step % 8 == 0 or step == len(order):
                print(f"Epoch {epoch}/{epochs}, {step}/{len(order)}, loss {loss_value:.4f}", flush=True)
        losses.append(sum(epoch_losses) / len(epoch_losses))

    output.mkdir(parents=True, exist_ok=True)
    pending = output / f"{output_name}.f16.part"
    final = output / f"{output_name}.f16.gguf"
    if final.exists() or pending.exists():
        raise FileExistsError(final)
    subprocess.run(["cp", "-c", str(active), str(pending)], check=True)
    target_reader = GGUFReader(pending, "r+")
    target_weights = {tensor.name: tensor.data for tensor in target_reader.tensors}
    with torch.no_grad():
        for (index, module), adapter in adapters.items():
            dest = target_weights[f"blk.{index}.{PROJECTIONS[module]}.weight"]
            merged = adapter.merge().weight.detach().numpy()
            if dest.dtype != np.float16 or dest.shape != merged.shape:
                raise ValueError("Unexpected target tensor format")
            dest[:] = merged
    target_reader.data.flush()
    pending.rename(final)
    report = {"active_f16_sha256": digest(active), "trained_f16_sha256": digest(final),
              "dataset": audit, "seed": 42, "epochs": epochs, "loss": losses,
              "learning_rate": learning_rate, "program_repeat": program_repeat,
              "trainable_parameters": sum(parameter.numel() for parameter in parameters),
              "trained_layers": list(range(stop, config.num_hidden_layers))}
    (output / "training-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print("Merged LoRA weights into GGUF", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "streaming")
    parser.add_argument("--epochs", type=int, default=2)
    parser.add_argument("--learning-rate", type=float, default=8e-5)
    parser.add_argument("--program-repeat", type=int, default=1)
    args = parser.parse_args()
    if args.epochs < 1 or args.learning_rate <= 0 or args.program_repeat < 1:
        parser.error("Training settings must be positive")
    fit(args.output, args.epochs, args.learning_rate, args.program_repeat)
