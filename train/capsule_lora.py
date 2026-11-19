"""Train a Qwen LoRA using licensed and reverified escalation examples."""
import argparse
import os
from collections.abc import Callable, Iterator
from pathlib import Path

from capsule.router import Check, Message
from capsule.verify import supported, verify
from data.pipelines.filtering import SECRET, Contamination, records, tokens
from data.sources.licensing import licenses
from train.stages.examples import CHAT_MARKERS
from train.stages.optimizer import Pair, optimize
from verifiers.sandbox import Outcome


def examples(log: Path, benchmarks: list[Path], language: str,
             verifier: Callable[[Check, str], Outcome]) -> Iterator[tuple[list[Message], str]]:
    contamination = Contamination(benchmarks)
    allowed = licenses()
    for row in records(log):
        code = row.get("fixed_code")
        if not code or row["order"]["language"] != language:
            continue
        messages = row["capsule"]
        checks = [Check(**check) for check in row["checks"]]
        if (row.get("license") not in allowed
                or [message["role"] for message in messages] != ["system", "user"]
                or not any(c.kind == "test" for c in checks)
                or any(c.language != language or not supported(c) for c in checks)):
            continue
        text = "\n".join([*(message["content"] for message in messages), code, *(c.source for c in checks)])
        if (SECRET.search(text) or any(marker in text for marker in CHAT_MARKERS)
                or contamination.overlaps(text, tokens(text))):
            continue
        if all(verifier(check, code).passed for check in checks):
            yield messages, code


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--log", type=Path, required=True)
    parser.add_argument("--benchmark", type=Path, action="append", required=True)
    parser.add_argument("--language", required=True)
    parser.add_argument("--base", type=Path, required=True, help="Local Qwen safetensors snapshot")
    parser.add_argument("--base-license", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--docker", default="docker")
    parser.add_argument("--steps", type=int, default=20)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--confirm-training-rights", action="store_true")
    args = parser.parse_args()
    if not args.confirm_training_rights or args.base_license not in licenses():
        parser.error("Confirm training rights and provide an allowlisted base model license")
    rows = list(examples(args.log, args.benchmark, args.language, lambda c, code: verify(c, code, args.docker)))
    if not rows:
        parser.error("No licensed, decontaminated escalation examples passed verification")
    os.environ["HF_HUB_OFFLINE"] = "1"
    import torch
    from peft import LoraConfig, get_peft_model
    from transformers import AutoModelForCausalLM, AutoTokenizer

    torch.manual_seed(0)
    tokenizer = AutoTokenizer.from_pretrained(args.base, local_files_only=True, trust_remote_code=False)
    base = AutoModelForCausalLM.from_pretrained(
        args.base, local_files_only=True, trust_remote_code=False, use_safetensors=True,
    )
    model = get_peft_model(base, LoraConfig(
        task_type="CAUSAL_LM", r=8, lora_alpha=16, target_modules=["q_proj", "v_proj"],
    )).to(args.device)
    pairs = []
    for messages, code in rows:
        prefix: list[int] = tokenizer.apply_chat_template(messages, tokenize=True, add_generation_prompt=True)
        target: list[int] = tokenizer.encode(code, add_special_tokens=False) + [tokenizer.eos_token_id]
        if len(prefix) + len(target) <= 4096:
            pairs.append((prefix + target, [-100] * len(prefix) + target))

    def batches() -> Iterator[Pair]:
        return iter(pairs)

    optimize(model, torch, batches, args.device, args.steps, 1, 2e-4)
    args.output.mkdir(parents=True, exist_ok=False)
    model.save_pretrained(args.output, safe_serialization=True)


if __name__ == "__main__":
    main()
