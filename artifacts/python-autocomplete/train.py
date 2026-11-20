"""Train a short Python FIM adapter and export merged Hugging Face weights."""
import argparse
import ast
import hashlib
import json
from pathlib import Path
import random

import torch
from torch import nn
from transformers import AutoModelForCausalLM, AutoTokenizer

# Original CC0-1.0 examples. Each family provides comment and partial-code prompts.
FAMILIES = [
    ("Strip whitespace from {x}", "{y} = {x}.strip()"),
    ("Split {x} on commas", "{y} = {x}.split(',')"),
    ("Make {x} lowercase", "{y} = {x}.lower()"),
    ("Keep only positive values in {x}", "{y} = [value for value in {x} if value > 0]"),
    ("Drop None values from {x}", "{y} = [value for value in {x} if value is not None]"),
    ("Remove duplicates from {x} while preserving order", "{y} = list(dict.fromkeys({x}))"),
    ("Sort {x} in descending order", "{y} = sorted({x}, reverse=True)"),
    ("Get the last three elements of {x}", "{y} = {x}[-3:]"),
    ("Copy {x} into a new list", "{y} = list({x})"),
    ("Build a set of the values in {x}", "{y} = set({x})"),
    ("Count the values in {x}", "{y} = len({x})"),
    ("Get the first item of {x} or None when empty", "{y} = {x}[0] if {x} else None"),
    ("Get the status from {x}, defaulting to pending", "{y} = {x}.get('status', 'pending')"),
    ("Check whether {x} contains an enabled key", "{y} = 'enabled' in {x}"),
    ("Get the keys from {x} as a list", "{y} = list({x})"),
    ("Reverse the order of {x}", "{y} = {x}[::-1]"),
    ("Join {x} into a single string separated by spaces", "{y} = ' '.join({x})"),
    ("Convert {x} to an integer", "{y} = int({x})"),
    ("Round {x} to two decimal places", "{y} = round({x}, 2)"),
    ("Clamp {x} to the range zero through one", "{y} = max(0, min(1, {x}))"),
    ("Check whether every entry of {x} is truthy", "{y} = all({x})"),
    ("Remove the extension from the Path {x}", "{y} = {x}.stem"),
    ("Sum the values in {x}", "{y} = sum({x})"),
    ("Read UTF-8 text from the Path {x}", "{y} = {x}.read_text(encoding='utf-8')"),
    ("Parse JSON stored in {x}", "{y} = json.loads({x})"),
    ("Get the smallest number in {x}", "{y} = min({x})"),
    ("Replace spaces with dashes in {x}", "{y} = {x}.replace(' ', '-')"),
    ("Reverse the characters of {x} and uppercase them", "{y} = {x}[::-1].upper()"),
    ("Make a shallow copy of the dictionary {x}", "{y} = {x}.copy()"),
    ("Drop the first element of {x}", "{y} = {x}[1:]"),
    ("Check whether {x} starts with a slash", "{y} = {x}.startswith('/')"),
    ("Convert {x} to a tuple", "{y} = tuple({x})"),
]


class Adapter(nn.Module):
    def __init__(self, linear):
        super().__init__()
        self.linear = linear
        self.down = nn.Linear(linear.in_features, 8, bias=False, device=linear.weight.device)
        self.up = nn.Linear(8, linear.out_features, bias=False, device=linear.weight.device)
        nn.init.zeros_(self.up.weight)

    def forward(self, hidden):
        return self.linear(hidden) + (2 * self.up(self.down(hidden.float()))).to(hidden.dtype)

    def merge(self):
        weight = self.linear.weight
        weight.copy_((weight.float() + 2 * (self.up.weight @ self.down.weight)).to(weight.dtype))
        return self.linear


def examples():
    for comment, statement in FAMILIES:
        for index, (source, result) in enumerate([
            ("value", "result"), ("raw", "clean"), ("items", "output"),
        ]):
            description = comment.format(x=source)
            code = statement.format(x=source, y=result)
            header = f"def transform({source}):\n    # {description}\n    "
            prefix, target = (header, code) if index != 2 else (
                header + f"{result} = ", code.split(" = ", 1)[1]
            )
            suffix = f"\n    return {result}\n" if index != 1 else ""
            ast.parse(prefix + target + suffix)
            yield f"<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>", target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--revision", required=True)
    args = parser.parse_args()
    torch.manual_seed(42)
    rng = random.Random(42)
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    torch.set_num_threads(4)
    tokenizer = AutoTokenizer.from_pretrained(args.base, local_files_only=True)
    model = AutoModelForCausalLM.from_pretrained(
        args.base, local_files_only=True, dtype=torch.bfloat16,
    ).requires_grad_(False).to(device)
    model.train()
    model.config.use_cache = False
    adapters = []
    for block in model.model.layers[-8:]:
        for parent, names in ((block.self_attn, ("q_proj", "v_proj", "o_proj")),
                              (block.mlp, ("down_proj",))):
            for name in names:
                adapter = Adapter(getattr(parent, name))
                setattr(parent, name, adapter)
                adapters.append((parent, name, adapter))

    optimizer = torch.optim.AdamW(
        (parameter for parameter in model.parameters() if parameter.requires_grad), lr=1e-4,
    )
    batches = []
    for prompt, completion in examples():
        prefix = tokenizer.encode(prompt, add_special_tokens=False)
        target = tokenizer.encode(completion, add_special_tokens=False) + [tokenizer.eos_token_id]
        batches.append((prefix, target))

    average_losses = []
    for epoch in range(2):
        rng.shuffle(batches)
        losses = []
        for start in range(0, len(batches), 4):
            batch = batches[start:start + 4]
            width = max(len(prefix) + len(target) for prefix, target in batch)
            inputs, labels = [], []
            for prefix, target in batch:
                padding = width - len(prefix) - len(target)
                inputs.append(prefix + target + [tokenizer.eos_token_id] * padding)
                labels.append([-100] * len(prefix) + target + [-100] * padding)
            optimizer.zero_grad(set_to_none=True)
            expected = torch.tensor(labels, device=device)[:, 1:]
            positions = torch.where(expected.ne(-100).any(dim=0))[0]
            logits = model(
                input_ids=torch.tensor(inputs, device=device), logits_to_keep=positions,
            ).logits
            loss = nn.functional.cross_entropy(
                logits.float().flatten(0, 1), expected[:, positions].flatten(),
            )
            if not torch.isfinite(loss).item():
                raise RuntimeError("Non-finite training loss")
            loss.backward()
            optimizer.step()
            losses.append(loss.item())
        average_losses.append(sum(losses) / len(losses))
        print(f"Epoch {epoch + 1}: {average_losses[-1]:.4f}", flush=True)

    model.to("cpu")
    with torch.no_grad():
        for parent, name, adapter in adapters:
            setattr(parent, name, adapter.merge())
    model.config.use_cache = True
    model.save_pretrained(args.output / "checkpoint")
    tokenizer.save_pretrained(args.output / "checkpoint")
    with (args.base / "model.safetensors").open("rb") as weights:
        digest = hashlib.file_digest(weights, "sha256").hexdigest()
    (args.output / "training.json").write_text(json.dumps({
        "base": "Qwen/Qwen2.5-Coder-0.5B", "revision": args.revision,
        "base_sha256": digest, "data_license": "CC0-1.0", "seed": 42,
        "device": device, "examples": len(batches), "epoch_losses": average_losses,
    }, indent=2) + "\n")


if __name__ == "__main__":
    main()
