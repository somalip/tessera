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
    fit(args.base, args.output, args.revision, examples())


def fit(base, output, revision, samples, *, base_id="Qwen/Qwen2.5-Coder-0.5B",
        end_token=None, audit=None, cpu_float32=False, layers=8, epochs=2, batch_size=4, learning_rate=1e-4):
    """Train the final Qwen layers on completion-only supervision."""
    torch.manual_seed(42)
    rng = random.Random(42)
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    torch.set_num_threads(4)
    tokenizer = AutoTokenizer.from_pretrained(base, local_files_only=True)
    model = AutoModelForCausalLM.from_pretrained(
        base, local_files_only=True,
        dtype=torch.float32 if device == "cpu" and cpu_float32 else torch.bfloat16,
    ).requires_grad_(False).to(device)
    model.train()
    model.config.use_cache = False
    adapters = []
    for block in model.model.layers[-layers:]:
        for parent, names in ((block.self_attn, ("q_proj", "v_proj", "o_proj")),
                              (block.mlp, ("down_proj",))):
            for name in names:
                adapter = Adapter(getattr(parent, name))
                setattr(parent, name, adapter)
                adapters.append((parent, name, adapter))

    optimizer = torch.optim.AdamW(
        (parameter for parameter in model.parameters() if parameter.requires_grad), lr=learning_rate,
    )
    batches = []
    eos = tokenizer.eos_token_id if end_token is None else tokenizer.convert_tokens_to_ids(end_token)
    for prompt, completion in samples:
        prefix = tokenizer.encode(prompt, add_special_tokens=False)
        target = tokenizer.encode(completion, add_special_tokens=False) + [eos]
        batches.append((prefix, target))

    if not batches:
        raise ValueError("No training examples")
    print(f"Training {len(batches)} examples on {device}", flush=True)
    average_losses = []
    for epoch in range(epochs):
        rng.shuffle(batches)
        losses = []
        for start in range(0, len(batches), batch_size):
            batch = batches[start:start + batch_size]
            width = max(len(prefix) + len(target) for prefix, target in batch)
            inputs, labels = [], []
            for prefix, target in batch:
                padding = width - len(prefix) - len(target)
                inputs.append(prefix + target + [eos] * padding)
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
    model.save_pretrained(output / "checkpoint")
    tokenizer.save_pretrained(output / "checkpoint")
    with (base / "model.safetensors").open("rb") as weights:
        digest = hashlib.file_digest(weights, "sha256").hexdigest()
    (output / "training.json").write_text(json.dumps({
        "base": base_id, "revision": revision,
        "base_sha256": digest, "data_license": "CC0-1.0", "seed": 42,
        "device": device, "examples": len(batches), "epoch_losses": average_losses,
        **({"corpus_audit": audit} if audit is not None else {}),
    }, indent=2) + "\n")


if __name__ == "__main__":
    main()
