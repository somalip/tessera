"""Fine-tune and rank local Qwen3.5 web specialists within an overnight budget."""

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import sys
import tempfile
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from data.pipelines.filtering import Contamination, records, tokens
from data.sources.licensing import licenses
from eval.inference import serve
from eval.report import digest
from package.build_manifest import TARGET
from package.export_gguf import export
from package.quantize import quantize
from tools.build_specialties import SPECIALTIES
from train.config import load
from train.cpp_overnight import CPP, ROOT, RUNTIME, read_report, run_stage
from train.run import write_json
from train.stages.optimizer import Pair, optimize

LANGUAGES = ("javascript", "html", "css")
RATES = (2e-5, 6e-5, 1e-4)
FIXTURE_LICENSE = "CC0-1.0"
MODEL_LICENSE = "Apache-2.0"
BASE_SHA256 = "04b1c301231dd422b8860db31311ab2721511346a32cb1e079c4c4e5f1fe4696"
BASE_WEIGHTS = "model.safetensors-00001-of-00001.safetensors"


def freeze_inputs(output: Path) -> dict[str, Any]:
    if not {FIXTURE_LICENSE, MODEL_LICENSE} <= licenses():
        raise ValueError("Web training requires allowlisted model and fixture licenses")
    inputs: dict[str, Any] = {}
    holdouts = []
    for language in LANGUAGES:
        config = load(ROOT / f"train/configs/{language}.yaml")
        training = config["web_training"]
        holdout = config["web_holdout"]
        if config["language"] != language or not training or not holdout:
            raise ValueError(f"Incomplete web training configuration for {language}")
        folder = output / language
        folder.mkdir()
        snapshot = folder / "holdout.jsonl"
        with snapshot.open("w", encoding="utf8") as stream:
            for case in holdout:
                if not case["checks"]:
                    raise ValueError(f"A holdout case has no checks for {language}")
                for check in case["checks"]:
                    re.compile(check)
                stream.write(json.dumps({**case, "license": FIXTURE_LICENSE}) + "\n")
        holdouts.append(snapshot)
        examples = folder / "training.json"
        write_json(examples, {"license": FIXTURE_LICENSE, "examples": training})
        inputs[language] = {
            "training": str(examples),
            "training_sha256": digest(examples),
            "holdout": str(snapshot),
            "holdout_sha256": digest(snapshot),
        }
    contamination = Contamination(holdouts)
    for language in LANGUAGES:
        for prompt, answer in read_report(Path(inputs[language]["training"]))[
            "examples"
        ]:
            for text in (prompt, answer, prompt + answer):
                if contamination.overlaps(text, tokens(text)):
                    raise ValueError(
                        f"Training overlaps the frozen web holdout for {language}"
                    )
    return inputs


def score(model: Path, holdout: Path, server: str) -> dict[str, Any]:
    results = []
    with serve(model, server, 2048) as client:
        for case in records(holdout):
            if case["license"] not in licenses():
                raise ValueError("Web holdout case has a disallowed license")
            payload = {
                "messages": [{"role": "user", "content": case["prompt"]}],
                "chat_template_kwargs": {"enable_thinking": False},
                "temperature": 0,
                "seed": 42,
                "max_tokens": 192,
            }
            response = client.request("/v1/chat/completions", payload)
            completion = response["choices"][0]
            content = (completion["message"]["content"] or "").strip()
            checks = [bool(re.search(check, content)) for check in case["checks"]]
            complete = completion["finish_reason"] == "stop"
            raw = bool(content) and "```" not in content
            results.append(
                {
                    "prompt": case["prompt"],
                    "completion": content,
                    "checks": checks,
                    "passed": complete and all(checks),
                    "raw": raw,
                }
            )
    return {
        "model_sha256": digest(model),
        "holdout_sha256": digest(holdout),
        "passed": sum(row["passed"] for row in results),
        "raw_passed": sum(row["passed"] and row["raw"] for row in results),
        "results": results,
    }


def rank(report: dict[str, Any]) -> tuple[int, int]:
    return int(report["passed"]), int(report["raw_passed"])


def train_candidate(job: dict[str, Any], temporary: Path) -> Path:
    import torch
    from transformers import AutoTokenizer, Qwen3_5ForConditionalGeneration

    torch.set_num_threads(job["threads"])
    torch.manual_seed(42)
    base = Path(job["base"])
    tokenizer: Any = AutoTokenizer.from_pretrained(base, local_files_only=True)
    tokenizer.chat_template = Path(job["template"]).read_text(encoding="utf8")
    model: Any = Qwen3_5ForConditionalGeneration.from_pretrained(
        base, local_files_only=True, use_safetensors=True, dtype=torch.bfloat16
    )
    model.requires_grad_(False)
    # Updating the last two MLPs leaves the embeddings and vision tower frozen.
    for layer in model.model.language_model.layers[-2:]:
        layer.mlp.float().requires_grad_(True)
    model.to(job["device"])

    pairs: list[Pair] = []
    examples = read_report(Path(job["training"]))["examples"]
    for prompt, answer in examples:
        prefix = tokenizer.apply_chat_template(
            [{"role": "user", "content": prompt}],
            tokenize=False,
            add_generation_prompt=True,
            enable_thinking=False,
        )
        prompt_ids = tokenizer.encode(prefix, add_special_tokens=False)
        answer_ids = tokenizer.encode(answer + "<|im_end|>", add_special_tokens=False)
        if len(prompt_ids) + len(answer_ids) > 512:
            raise ValueError("Web training example exceeds 512 tokens")
        pairs.append((prompt_ids + answer_ids, [-100] * len(prompt_ids) + answer_ids))

    def batches() -> Iterator[Pair]:
        return iter(pairs)

    # Keep optimizer updates in float32 while the frozen model stays compact.
    with torch.autocast(job["device"], dtype=torch.bfloat16, cache_enabled=False):
        metrics = optimize(
            model, torch, batches, job["device"], job["steps"], 1, job["rate"]
        )
    write_json(
        Path(job["round"]) / "training_report.json",
        {
            **metrics,
            "training_sha256": job["training_sha256"],
            "holdout_sha256": job["holdout_sha256"],
            "tokenizer_sha256": digest(base / "tokenizer.json"),
            "template_sha256": digest(Path(job["template"])),
            "tokenized_sha256": hashlib.sha256(json.dumps(pairs).encode()).hexdigest(),
        },
    )
    checkpoint = temporary / "checkpoint"
    model.save_pretrained(checkpoint, safe_serialization=True, max_shard_size="256MB")
    tokenizer.save_pretrained(checkpoint)
    # The converter reads this file when embedding the template in the GGUF.
    shutil.copyfile(job["template"], checkpoint / "chat_template.jinja")
    del model
    intermediate = temporary / "model.f16.gguf"
    # Transformers does not preserve Qwen's auxiliary draft-prediction head.
    export(checkpoint, Path(job["converter"]), intermediate, exclude_mtp=True)
    candidate = temporary / "model.Q8_0.gguf"
    quantize(intermediate, candidate, "Q8_0", job["quantizer"])
    if not 0 < candidate.stat().st_size < TARGET:
        raise ValueError(
            "Web candidate exceeds the 900 MB packaging target or is empty"
        )
    return candidate


def worker(job: dict[str, Any]) -> None:
    holdout = Path(job["holdout"])
    training = Path(job["training"])
    if (
        digest(holdout) != job["holdout_sha256"]
        or digest(training) != job["training_sha256"]
    ):
        raise ValueError("Frozen web inputs changed")
    if read_report(training)["license"] not in licenses() or any(
        case["license"] not in licenses() for case in records(holdout)
    ):
        raise ValueError("Web training or evaluation license is outside the allowlist")
    folder = Path(job["round"])
    baseline_report = folder.parent / "baseline.json"
    if not baseline_report.exists():
        baseline = score(Path(job["baseline"]), holdout, job["server"])
        pending = baseline_report.with_suffix(".partial")
        write_json(pending, baseline)
        pending.replace(baseline_report)
    with tempfile.TemporaryDirectory(dir=folder) as workspace:
        candidate = train_candidate(job, Path(workspace))
        result = score(candidate, holdout, job["server"])
        write_json(folder / "evaluation.json", result)
        candidate.replace(folder / "model.Q8_0.gguf")


def search(args: argparse.Namespace, output: Path) -> None:
    inputs = freeze_inputs(output)
    settings = {
        "base": str(args.base),
        "converter": str(args.converter),
        "server": str(args.server),
        "quantizer": str(args.quantizer),
        "threads": args.threads,
        "device": args.device,
        "steps": args.steps,
    }
    environment = {
        **os.environ,
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "PYTORCH_ENABLE_MPS_FALLBACK": "1",
        "PYTHONUNBUFFERED": "1",
        "LLAMA_ARG_THREADS": str(args.threads),
    }
    best: dict[str, dict[str, Any]] = {}
    attempts: list[dict[str, Any]] = []
    summary = {
        "status": "running",
        "base_sha256": BASE_SHA256,
        "best": best,
        "attempts": attempts,
        "inputs": inputs,
    }

    def save() -> None:
        pending = output / ".summary.json"
        write_json(pending, summary)
        pending.replace(output / "summary.json")

    deadline = time.monotonic() + args.hours * 3600
    schedule = [
        (index, rate, language)
        for index, rate in enumerate(RATES[: args.rounds], 1)
        for language in LANGUAGES
    ]
    save()
    try:
        for position, (index, rate, language) in enumerate(schedule):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            count = len(schedule) - position
            slot_deadline = time.monotonic() + remaining / count
            folder = output / language / f"round-{index}"
            folder.mkdir()
            model = folder / "model.Q8_0.gguf"
            source = args.specialists / language
            job = {
                **settings,
                **inputs[language],
                "round": str(folder),
                "rate": rate,
                "template": str(source / "chat_template.jinja"),
                "baseline": str(source / f"{language}-tiny.Q8_0.gguf"),
            }
            job_path = folder / "job.json"
            write_json(job_path, job)
            attempt: dict[str, Any] = {
                "language": language,
                "round": index,
                "learning_rate": rate,
            }
            attempts.append(attempt)
            try:
                run_stage(
                    [
                        sys.executable,
                        "-m",
                        "train.web_overnight",
                        "_worker",
                        str(job_path),
                    ],
                    folder / "run.log",
                    slot_deadline,
                    environment,
                )
                report = read_report(folder / "evaluation.json")
                if report["holdout_sha256"] != inputs[language]["holdout_sha256"]:
                    raise ValueError("Candidate used a different holdout")
                incumbent = best.get(language)
                if incumbent is None or rank(report) > rank(incumbent):
                    link = folder.parent / "best.gguf"
                    pending = link.with_suffix(".partial")
                    pending.symlink_to(model.relative_to(folder.parent))
                    pending.replace(link)
                    best[language] = {
                        "model": str(link),
                        "checkpoint": str(model),
                        "report": str(folder / "evaluation.json"),
                        "passed": report["passed"],
                        "raw_passed": report["raw_passed"],
                    }
                    if incumbent is not None:
                        Path(incumbent["checkpoint"]).unlink()
                    attempt["status"] = "selected"
                else:
                    attempt["status"] = "discarded"
            except (TimeoutError, RuntimeError) as error:
                attempt.update(status="failed", error=str(error))
            finally:
                if best.get(language, {}).get("checkpoint") != str(model):
                    model.unlink(missing_ok=True)
                # A killed worker cannot close its TemporaryDirectory.
                for directory in folder.glob("tmp*"):
                    shutil.rmtree(directory)
                save()
        summary["status"] = "finished" if len(best) == len(LANGUAGES) else "incomplete"
    except KeyboardInterrupt:
        summary["status"] = "interrupted"
        raise
    except Exception:
        summary["status"] = "failed"
        raise
    finally:
        save()
    if len(best) != len(LANGUAGES):
        raise RuntimeError(
            f"Some languages produced no evaluated candidate. See {output / 'summary.json'}"
        )
    print(f"Results in {output / 'summary.json'}", flush=True)


def main() -> None:
    if len(sys.argv) == 3 and sys.argv[1] == "_worker":
        worker(read_report(Path(sys.argv[2])))
        return
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base",
        type=Path,
        required=True,
        help="Local Apache-2.0 Qwen/Qwen3.5-0.8B Transformers snapshot",
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--specialists", type=Path, default=ROOT / "artifacts/web-models"
    )
    parser.add_argument(
        "--converter",
        type=Path,
        default=CPP / "tooling/llama.cpp-b12244/convert_hf_to_gguf.py",
    )
    parser.add_argument("--server", type=Path, default=RUNTIME / "llama-server")
    parser.add_argument("--quantizer", type=Path, default=RUNTIME / "llama-quantize")
    parser.add_argument("--hours", type=float, default=8)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--steps", type=int, default=12)
    parser.add_argument(
        "--rounds", type=int, choices=range(1, len(RATES) + 1), default=len(RATES)
    )
    parser.add_argument(
        "--device", choices=("auto", "cpu", "cuda", "mps"), default="auto"
    )
    args = parser.parse_args()
    if (
        not math.isfinite(args.hours)
        or args.hours <= 0
        or min(args.threads, args.steps) < 1
    ):
        parser.error("Hours, threads, and steps must be positive")
    for name in ("base", "output", "specialists", "converter", "server", "quantizer"):
        setattr(args, name, getattr(args, name).resolve())
    try:
        import torch
        from transformers import Qwen3_5ForConditionalGeneration  # noqa: F401

        if args.device == "auto":
            args.device = (
                "cuda"
                if torch.cuda.is_available()
                else "mps"
                if torch.backends.mps.is_available()
                else "cpu"
            )
        config = read_report(args.base / "config.json")
        if (
            config.get("model_type") != "qwen3_5"
            or config["text_config"]["hidden_size"] != 1024
        ):
            raise ValueError(
                "--base must point to the official Qwen/Qwen3.5-0.8B snapshot"
            )
        for path in (
            args.base / "LICENSE",
            args.base / "tokenizer.json",
            args.converter,
            args.server,
            args.quantizer,
        ):
            if not path.is_file():
                raise FileNotFoundError(path)
        weights = set(
            read_report(args.base / "model.safetensors.index.json")[
                "weight_map"
            ].values()
        )
        if (
            weights != {BASE_WEIGHTS}
            or (args.base / "model.safetensors").exists()
            or digest(args.base / BASE_WEIGHTS) != BASE_SHA256
        ):
            raise ValueError(
                "Unexpected weights. Use the pinned Apache-2.0 Qwen3.5 snapshot."
            )
        for language in LANGUAGES:
            folder = args.specialists / language
            template = folder / "chat_template.jinja"
            baseline = folder / f"{language}-tiny.Q8_0.gguf"
            if SPECIALTIES[language][0] not in template.read_text(encoding="utf8"):
                raise ValueError(f"Missing specialist instructions in {template}")
            if not 0 < baseline.stat().st_size < TARGET:
                raise ValueError(f"Invalid baseline size for {language}")
        args.output.mkdir(parents=True, exist_ok=False)
        search(args, args.output)
    except ImportError as error:
        parser.exit(
            1, f"Install Qwen3.5-compatible Transformers and PyTorch first. {error}\n"
        )
    except (OSError, RuntimeError, ValueError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
