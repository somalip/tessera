"""Build and smoke-test local text specialists with unchanged Qwen tensor data."""

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

from eval.inference import serve
from eval.report import digest
from package.build_manifest import build

LICENSE = Path(__file__).resolve().parents[1] / "docs/research/general-models/LICENSE"
REVISION = "004fd086eccea9f7cf867aa07ba328773beef81d"
WEIGHTS_SHA256 = "37ae482d336108d23516fa35e8e0c4126688d81018b87178a18d752a1357814f"
SPECIALTIES = {
    "documentation": (
        "Write factual Markdown documentation. Use headings, clear steps, and examples grounded in supplied facts. Preserve command names verbatim.",
        ["markdown"],
        ["**/README.md", "**/docs/**/*.md"],
        "Write a Markdown Quick Start section for a tool named Brisk. Installation: brisk setup. Verification: brisk status. Use a fenced shell block.",
        [r"(?im)^#+ Quick Start", r"```", r"brisk setup", r"brisk status"],
    ),
    "english": (
        "Edit English for grammar, clarity, and concision while preserving meaning, names, and numbers. When asked to rewrite a sentence, return only the revision.",
        ["plaintext"],
        ["**/*.txt"],
        "Correct this sentence and return only the corrected sentence: The three lanterns was delivered on Tuesday.",
        [r"^The three lanterns were delivered on Tuesday\.$"],
    ),
    "diagrams": (
        "Convert descriptions to concise, valid Mermaid diagrams by default. Preserve node names and edge directions. Honor requests for raw Mermaid or fenced Markdown.",
        ["mermaid"],
        ["**/*.mmd", "**/*.mermaid"],
        "Return a raw Mermaid flowchart. Use node IDs and labels Intake, Review, and Archive, with the edges Intake to Review and Review to Archive.",
        [
            r"(?m)^(flowchart|graph) (TD|TB|LR|RL|BT)",
            r"Intake[^\n]*-->[^\n]*Review",
            r"Review[^\n]*-->[^\n]*Archive",
        ],
    ),
    "summaries": (
        "Summarize source material faithfully. Keep decisions, owners, deadlines, and unresolved questions distinct. Omit unsupported details.",
        ["plaintext"],
        ["**/meeting-notes/*.txt"],
        "Summarize in two bullets. Priya will send the draft by Thursday. The team has yet to select a venue.",
        [
            r"(?im)^[-*] .*Priya.*Thursday",
            r"(?im)^[-*] .*(venue.*(select|decid|open)|(?:select|decid|open).*venue)",
        ],
    ),
}


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument(
        "--source",
        type=Path,
        required=True,
        help="Snapshot metadata with the upstream template",
    )
    parser.add_argument(
        "--metadata-editor",
        type=Path,
        required=True,
        help="llama.cpp gguf_new_metadata.py",
    )
    parser.add_argument("--server", required=True)
    parser.add_argument("--output", type=Path, default=Path("artifacts/general-models"))
    args = parser.parse_args()
    source = json.loads(args.source.read_text())
    if source["sha"] != REVISION or source["cardData"]["license"] != "apache-2.0":
        raise ValueError("Unexpected model source revision or license")
    if digest(args.base) != WEIGHTS_SHA256:
        raise ValueError("Unexpected base GGUF digest")
    original = source["gguf"]["chat_template"]
    completions = {}
    for name, (instruction, languages, globs, prompt, checks) in SPECIALTIES.items():
        model_id = f"{name}-tiny"
        directory = args.output / name
        directory.mkdir(parents=True, exist_ok=True)
        # Combine the specialty with a caller-supplied system message, if present.
        bootstrap = """
{%- set specialty = INSTRUCTION %}
{%- if messages and messages[0].role == 'system' %}
    {%- set messages = [{'role': 'system', 'content': specialty + '\\n\\n' + messages[0].content}] + messages[1:] %}
{%- elif messages %}
    {%- set messages = [{'role': 'system', 'content': specialty}] + messages %}
{%- endif %}
""".replace("INSTRUCTION", json.dumps(instruction))
        template = directory / "chat_template.jinja"
        template.write_text(bootstrap + original, encoding="utf8")
        gguf = directory / f"{model_id}.Q8_0.gguf"
        if not gguf.exists():
            temporary = gguf.with_suffix(".partial")
            subprocess.run(
                [
                    sys.executable,
                    str(args.metadata_editor),
                    str(args.base),
                    str(temporary),
                    "--general-name",
                    model_id,
                    "--general-description",
                    instruction,
                    "--chat-template-file",
                    str(template),
                    "--force",
                ],
                check=True,
            )
            temporary.replace(gguf)
        package = directory / f"{model_id}.tcm"
        if package.exists():
            raise FileExistsError(package)
        with serve(gguf, args.server, 2048) as client:
            for messages in (
                [{"role": "user", "content": prompt}],
                [
                    {
                        "role": "system",
                        "content": "Follow the requested output format.",
                    },
                    {"role": "user", "content": prompt},
                ],
            ):
                payload = {
                    "messages": messages,
                    "chat_template_kwargs": {"enable_thinking": False},
                }
                rendered = client.request("/apply-template", payload)["prompt"]
                if instruction not in rendered or any(
                    message["content"] not in rendered for message in messages
                ):
                    raise ValueError(f"Missing chat instructions for {model_id}")
            response = client.request(
                "/v1/chat/completions",
                {
                    **payload,
                    "max_tokens": 240,
                    "temperature": 0,
                    "seed": 42,
                },
            )
            answer = response["choices"][0]["message"]["content"].strip()
        results = [bool(re.search(check, answer)) for check in checks]
        report = directory / "eval_report.json"
        write_json(
            report,
            {
                "language": name,
                "model_sha256": digest(gguf),
                "gate_passed": False,
                "smoke": True,
                "fixture_license": "CC0-1.0",
                "training_examples": 0,
                "base_revision": REVISION,
                "base_gguf_sha256": WEIGHTS_SHA256,
                "template_sha256": hashlib.sha256(template.read_bytes()).hexdigest(),
                "prompt": prompt,
                "completion": answer,
                "checks": dict(zip(checks, results, strict=True)),
            },
        )
        build(
            gguf,
            {
                "id": model_id,
                "version": "0.1.0",
                "language_ids": [name],
                "vscode_language_ids": languages,
                "file_globs": globs,
                "base_model": "Qwen/Qwen3.5-0.8B",
                "params": 772845888,
                "quant": "Q8_0",
                "context_length": 2048,
                "capabilities": ["chat", "edit"],
                "prompt_formats": {
                    "fim": {
                        "prefix": "<|fim_prefix|>",
                        "suffix": "<|fim_suffix|>",
                        "middle": "<|fim_middle|>",
                    },
                    "chat_template": "chatml",
                },
                "min_runtime": {"llama_cpp_build": "b12244"},
            },
            report,
            LICENSE,
            "Apache-2.0",
            package,
            smoke=True,
        )
        completions[name] = {
            "bytes": package.stat().st_size,
            "passed": sum(results),
            "checks": len(checks),
        }
        print(name, completions[name], flush=True)
    write_json(args.output / "results.json", completions)


if __name__ == "__main__":
    main()
