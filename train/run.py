"""Run CPT, verified SFT, rejection sampling, and GGUF export."""
import argparse
import json
import os
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from data.sources.licensing import licenses
from eval.report import digest
from package.build_manifest import build
from package.export_gguf import export
from package.quantize import quantize
from train.config import load
from train.stages.examples import Supervision, cpt_batches, prompt_text, training_pair
from train.stages.optimizer import Pair, optimize
from train.stages.vocab import experiment


def write_json(path: Path, content: object) -> None:
    path.write_text(json.dumps(content, indent=2) + "\n", encoding="utf8")


def run(config: dict[str, Any]) -> Path:
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer, Qwen2Config

    os.environ["HF_HUB_OFFLINE"] = "1"
    if config["base_license"] not in licenses():
        raise ValueError("Base model license is outside the allowlist")
    if not config["teacher_terms_permit_training"]:
        raise ValueError("Confirm the teacher's terms permit model training before running SFT")
    benchmarks = [Path(path) for path in config["benchmarks"]]
    if not benchmarks:
        raise ValueError("Configure every frozen evaluation snapshot before training")
    seed = config["seed"]
    torch.manual_seed(seed)
    device = config["device"]
    if device == "auto":
        device = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
    base = Path(config["base_dir"])
    tokenizer: Any = AutoTokenizer.from_pretrained(
        base, local_files_only=True, trust_remote_code=False)
    model: Any
    tokenizer_digest = digest(base / "tokenizer.json")
    smoke = config["smoke"]
    if smoke:
        model = AutoModelForCausalLM.from_config(Qwen2Config(
            vocab_size=((max(tokenizer.get_vocab().values()) + 256) // 256) * 256,
            hidden_size=256, intermediate_size=512, num_hidden_layers=2,
            num_attention_heads=4, num_key_value_heads=2, tie_word_embeddings=True,
            eos_token_id=tokenizer.eos_token_id,
        ))
    else:
        model = AutoModelForCausalLM.from_pretrained(
            base, local_files_only=True, trust_remote_code=False, use_safetensors=True,
        )
    model.to(device)
    output = Path(config["output"])
    output.mkdir(parents=True)
    sequence_length = config["sequence_length"]
    gradient_accumulation = config["gradient_accumulation"]
    rate = config["learning_rate"]

    def cpt() -> Iterator[Pair]:
        return cpt_batches(Path(config["corpus"]), sequence_length, benchmarks, smoke,
                           tokenizer_digest, config["language"])

    stages: dict[str, Any] = {}
    stages["cpt"] = optimize(model, torch, cpt, device, config["cpt_steps"],
                             gradient_accumulation, rate)
    supervision = Supervision(Path(config["supervised"]), benchmarks, config["docker"], config["language"])

    def pairs(examples: list[tuple[str, str]]) -> Iterator[Pair]:
        return (training_pair(tokenizer, prompt, solution, sequence_length) for prompt, solution in examples)

    teacher = list(supervision.teacher())
    stages["sft"] = optimize(model, torch, lambda: pairs(teacher), device, config["sft_steps"],
                             gradient_accumulation, rate)

    def generate(prompt: str) -> list[str]:
        ids = tokenizer(prompt_text(prompt), return_tensors="pt").input_ids.to(device)
        with torch.inference_mode():
            outputs = model.generate(
                ids, do_sample=True, temperature=0.7, top_p=0.95, max_new_tokens=512,
                num_return_sequences=config["rejection_candidates"],
                eos_token_id=[tokenizer.eos_token_id, tokenizer.convert_tokens_to_ids("<|im_end|>")],
                pad_token_id=tokenizer.eos_token_id,
            )
        return [tokenizer.decode(row[ids.shape[-1]:], skip_special_tokens=True) for row in outputs]

    model.eval()
    if not smoke and config["rejection_candidates"] < 1:
        raise ValueError("Release training requires on-policy rejection sampling")
    candidates = list(supervision.accepted(generate if config["rejection_candidates"] else None))
    stages["rejection_sampling"] = optimize(
        model, torch, lambda: pairs(candidates), device, config["rs_steps"], gradient_accumulation, rate,
    )
    stages["vocab_padding"] = experiment(model, tokenizer, config["trim_vocab_padding"])
    stages["device"] = device
    write_json(output / "training_report.json", stages)
    checkpoint = output / "checkpoint"
    model.save_pretrained(checkpoint, safe_serialization=True)
    tokenizer.save_pretrained(checkpoint)
    quant = config["quant"]
    uncompressed = output / "model.f16.gguf"
    gguf = output / f"model.{quant}.gguf"
    export(checkpoint, Path(config["converter"]), uncompressed)
    matrix = config.get("importance_matrix")
    quantize(uncompressed, gguf, quant, config["quantizer"], Path(matrix) if matrix else None)
    language = config["language"]
    metadata = {
        "id": config["model_id"], "version": config["version"], "language_ids": [language],
        "vscode_language_ids": config["vscode_language_ids"], "file_globs": config["file_globs"],
        "base_model": config["base_model"], "params": model.num_parameters(), "quant": quant,
        "context_length": config["context_length"], "capabilities": ["fim", "chat", "edit"],
        "prompt_formats": {
            "fim": {"prefix": "<|fim_prefix|>", "suffix": "<|fim_suffix|>", "middle": "<|fim_middle|>"},
            "chat_template": "chatml",
        },
        "min_runtime": {"llama_cpp_build": config["min_runtime"]},
    }
    write_json(output / "metadata.json", metadata)
    report = output / "eval_report.json"
    if smoke:
        write_json(report, {"language": language, "model_sha256": digest(gguf),
                            "gate_passed": False, "smoke": True})
    elif config.get("eval_args"):
        subprocess.run([sys.executable, "-m", "eval.report", "--lang", language,
                        "--model", str(gguf), "--output", str(report), "--training-audit",
                        str(Path(config["corpus"]) / "stats.json"), *config["eval_args"]], check=True)
    else:
        return gguf
    package = output / f"{config['model_id']}-{config['version']}.tcm"
    build(gguf, metadata, report, Path(config["license_file"]), config["base_license"], package,
          notice=Path(config["notice"]) if config.get("notice") else None, smoke=smoke)
    return package


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--lang", required=True)
    args = parser.parse_args()
    config = load(args.config)
    if config["language"] != args.lang:
        parser.error("Configured training language differs from --lang")
    print(run(config))


if __name__ == "__main__":
    main()
