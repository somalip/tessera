"""Run the local Python SFT experiment and save merged Hugging Face weights."""
import json
import random
import os
from pathlib import Path

import torch
from torch import nn
from transformers import AutoModelForCausalLM, AutoTokenizer

from data.pipelines.filtering import records
from eval.report import digest
from eval.suites.records import load_tasks
from train.stages.examples import Supervision, prompt_text
from verifiers.python.runner import verify

ROOT = Path(__file__).resolve().parent
PREVIOUS = ROOT.parent / "python-local"
BASE = PREVIOUS / "checkpoint"
CHECKPOINT = ROOT / "checkpoint"
HUMANEVAL = Path("/private/tmp/tessera-model/HumanEval.jsonl.gz")
HELDOUT = ROOT / "heldout.jsonl"
PREVIOUS_HELDOUT = PREVIOUS / "heldout.jsonl"
FIM_HELDOUT = ROOT / "fim.jsonl"
BASE_REVISION = "2e1fd397ee46e1388853d2af2c993145b0f1098a"
SEED = 42
RANK = 8
SCALE = 2
EPOCHS = 2


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

    for task, row in zip(load_tasks(HELDOUT, "real_world", "python", None), records(HELDOUT), strict=True):
        if not verify(row["canonical_solution"], task.tests).passed:
            raise ValueError(f"Held-out reference failed: {task.id}")

    # Preserve the repository's exact filtering check and audit rejected rows.
    train_path = ROOT / "supervised.jsonl"
    benchmarks = [HUMANEVAL, PREVIOUS_HELDOUT, HELDOUT, FIM_HELDOUT]
    from data.pipelines.filtering import Contamination, tokens
    contamination = Contamination(benchmarks)
    rejected = []
    filtered = ROOT / "supervised-filtered.jsonl"
    with filtered.open("w") as stream:
        for row in [*records(PREVIOUS / "supervised-filtered.jsonl"), *records(train_path)]:
            content = "\n".join(row[key] for key in ("prompt", "solution", "tests"))
            if contamination.overlaps(content, tokens(content)):
                rejected.append(row["id"])
                continue
            stream.write(json.dumps(row) + "\n")

    supervision = Supervision(filtered, benchmarks, "docker", "python")
    examples = list(supervision.teacher())
    if len(examples) != len(supervision.rows) or not examples:
        rejected_by_sandbox = [row["id"] for row in supervision.rows
                               if (row["prompt"], row["solution"]) not in examples]
        raise ValueError(f"Supervision failed verification: {rejected_by_sandbox}")

    tokenizer = AutoTokenizer.from_pretrained(BASE, local_files_only=True)
    model = AutoModelForCausalLM.from_pretrained(
        BASE, local_files_only=True, use_safetensors=True, dtype=torch.bfloat16,
    ).requires_grad_(False).to("mps")
    model.config.use_cache = False
    model.train()

    adapters = []
    for block in model.model.layers[-8:]:
        for group, names in ((block.self_attn, ("q_proj", "v_proj", "o_proj")),
                             (block.mlp, ("down_proj",))):
            for name in names:
                adapter = LoRA(getattr(group, name))
                setattr(group, name, adapter)
                adapters.append((group, name, adapter))

    parameters = [parameter for parameter in model.parameters() if parameter.requires_grad]
    optimizer = torch.optim.AdamW(parameters, lr=5e-5)
    encoded = []
    for prompt, source in examples:
        prefix = tokenizer.encode(prompt_text(prompt), add_special_tokens=False)
        target = tokenizer.encode(source + "<|im_end|>", add_special_tokens=False)
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
        "rejected_overlap": rejected,
        "accepted_overlap": 0,
        "benchmarks": sorted(digest(path) for path in benchmarks),
        "supervised_sha256": digest(filtered),
        "trainable_parameters": sum(parameter.numel() for parameter in parameters),
        "rank": RANK,
        "epochs": EPOCHS,
        "loss": epoch_losses,
    }, indent=2) + "\n")


if __name__ == "__main__":
    main()
