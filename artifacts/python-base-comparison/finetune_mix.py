"""Run the local Python SFT experiment and save merged Hugging Face weights."""
import json
import random
import os
from collections import Counter
from pathlib import Path

import torch
from torch import nn
from transformers import AutoModelForCausalLM, AutoTokenizer

from data.pipelines.filtering import records
from eval.report import digest
from data.sources.licensing import licenses
from build_supervision import BENCHMARKS

ROOT = Path(__file__).resolve().parent
PREVIOUS = ROOT.parent / "python-local"
BASE = PREVIOUS / "base"
CHECKPOINT = ROOT / "checkpoint"
BASE_REVISION = "2e1fd397ee46e1388853d2af2c993145b0f1098a"
SEED = 42
RANK = 8
SCALE = 2
EPOCHS = 1


class LoRA(nn.Module):
    def __init__(self, linear):
        super().__init__()
        self.linear = linear
        self.down = nn.Linear(linear.in_features, RANK, bias=False, device="mps")
        self.up = nn.Linear(RANK, linear.out_features, bias=False, device="mps")
        nn.init.zeros_(self.up.weight)

    def forward(self, hidden):
        delta = self.up(self.down(hidden.float())) * SCALE
        return self.linear(hidden) + delta.to(hidden.dtype)

    def merge(self):
        delta = (self.up.weight @ self.down.weight).cpu() * SCALE
        weight = self.linear.weight
        weight.copy_((weight.cpu().float() + delta).to(weight.dtype))
        return self.linear


def main():
    if not torch.backends.mps.is_available():
        raise RuntimeError("This local experiment requires Apple MPS")
    torch.manual_seed(SEED)
    randomizer = random.Random(SEED)

    train_path = ROOT / "supervised.jsonl"
    from data.pipelines.filtering import Contamination, tokens
    contamination = Contamination(BENCHMARKS)
    allowed = licenses()
    examples = list(records(train_path))
    for row in examples:
        if row["license"] not in allowed:
            raise ValueError(f"License is outside the allowlist: {row['id']}")
        prompt_source = row["prompt"] + row["solution"] + row.get("suffix", "")
        content = "\n".join([row["prompt"], row["solution"], prompt_source, row["tests"]])
        if contamination.overlaps(content, tokens(content)):
            raise ValueError(f"Overlapping training example: {row['id']}")

    tokenizer = AutoTokenizer.from_pretrained(BASE, local_files_only=True)
    model = AutoModelForCausalLM.from_pretrained(
        BASE, local_files_only=True, use_safetensors=True, dtype=torch.bfloat16,
    ).requires_grad_(False).to("mps")
    model.config.use_cache = False
    model.train()

    adapters = []
    for block in model.model.layers[-4:]:
        for group, names in ((block.self_attn, ("q_proj", "v_proj", "o_proj")),
                             (block.mlp, ("down_proj",))):
            for name in names:
                adapter = LoRA(getattr(group, name))
                setattr(group, name, adapter)
                adapters.append((group, name, adapter))

    parameters = [parameter for parameter in model.parameters() if parameter.requires_grad]
    optimizer = torch.optim.AdamW(parameters, lr=1.8e-4)
    encoded = []
    for row in examples:
        if row["format"] == "fim":
            prompt = "<|fim_prefix|>" + row["prompt"] + "<|fim_suffix|>" + row["suffix"] + "<|fim_middle|>"
            solution = row["solution"] + "<|endoftext|>"
        elif row["format"] == "raw":
            prompt = row["prompt"]
            solution = row["solution"] + "<|endoftext|>"
        else:
            prompt = tokenizer.apply_chat_template([
                {"role": "system", "content": "You are a Python coding assistant. Return only runnable Python code."},
                {"role": "user", "content": row["prompt"]},
            ], tokenize=False, add_generation_prompt=True)
            solution = row["solution"] + "<|im_end|>"
        prefix = tokenizer.encode(prompt, add_special_tokens=False)
        target = tokenizer.encode(solution, add_special_tokens=False)
        encoded.append((prefix, target))
    max_input = max(len(prefix) + len(target) for prefix, target in encoded)
    max_target = max(len(target) for _, target in encoded)
    epoch_losses = []
    for epoch in range(EPOCHS):
        randomizer.shuffle(encoded)
        losses = []
        for position, (prefix, target) in enumerate(encoded, start=1):
            padding = max_input - len(prefix) - len(target)
            ids = torch.tensor([prefix + target + [tokenizer.eos_token_id] * padding], device="mps")
            indices = list(range(len(prefix) - 1, len(prefix) + len(target) - 1))
            target_positions = torch.tensor(indices + [0] * (max_target - len(indices)), device="mps")
            labels = torch.tensor(target + [-100] * (max_target - len(target)), device="mps")
            optimizer.zero_grad(set_to_none=True)
            logits = model(input_ids=ids, logits_to_keep=target_positions).logits
            loss = nn.functional.cross_entropy(logits[0].float(), labels)
            if not torch.isfinite(loss).item():
                raise RuntimeError("Nonfinite SFT loss")
            loss.backward()
            nn.utils.clip_grad_norm_(parameters, 1.0)
            optimizer.step()
            losses.append(loss.item())
            torch.mps.empty_cache()
            if position % 5 == 0 or position == len(encoded):
                print(f"Epoch {epoch + 1}/{EPOCHS}, sample {position}/{len(encoded)}", flush=True)
        epoch_losses.append(sum(losses) / len(losses))
        temporary = ROOT / "adapter.part"
        torch.save([parameter.detach().cpu() for parameter in parameters], temporary)
        os.replace(temporary, ROOT / "adapter.pt")
        print(f"Epoch {epoch + 1}/{EPOCHS}: loss {epoch_losses[-1]:.4f}", flush=True)

    with torch.no_grad():
        for group, name, adapter in adapters:
            setattr(group, name, adapter.merge())
    model.config.use_cache = True
    model.to("cpu").save_pretrained(CHECKPOINT, safe_serialization=True, max_shard_size="4GB")
    tokenizer.save_pretrained(CHECKPOINT)
    (ROOT / "training_report.json").write_text(json.dumps({
        "base": "Qwen/Qwen2.5-Coder-1.5B-Instruct",
        "base_revision": BASE_REVISION,
        "base_weights_sha256": digest(BASE / "model.safetensors"),
        "seed": SEED,
        "license": "CC0-1.0",
        "examples": len(examples),
        "formats": dict(Counter(row["format"] for row in examples)),
        "accepted_overlap": 0,
        "benchmarks": sorted(digest(path) for path in BENCHMARKS),
        "supervised_sha256": digest(train_path),
        "trainable_parameters": sum(parameter.numel() for parameter in parameters),
        "rank": RANK,
        "epochs": EPOCHS,
        "loss": epoch_losses,
    }, indent=2) + "\n")


if __name__ == "__main__":
    main()
