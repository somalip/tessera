"""Generate, verify, and audit training targets from a local teacher."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import re
import subprocess

from data.pipelines.filtering import Contamination, SECRET, records, tokens
from data.sources.licensing import licenses
from eval.inference import serve
from eval.report import digest
from verifiers.python.runner import verify
from fixtures import ROOT
from reference_programs import REFERENCES
from training_tasks import CHECKS, CURSES, TASKS

ARTIFACTS = ROOT.parent
MODULE = ARTIFACTS.parent / ".capsule-router/vscode-extension/dist/providers/projectPrompt.js"
TEACHER_HASH = "509287f78cb4d4cf6b3843734733b914b2c158e43e22a7f4bf5e963800894d3c"
TEACHER_REVISION = "13fb94bfda8c8cf22497dc57b78f391a9acb426a"


def project_messages(requests):
    result = subprocess.run(["node", "-e", '''
const { projectMessages } = require(process.argv[1]);
const requests = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
process.stdout.write(JSON.stringify(requests.map(request => projectMessages(request))));
''', str(MODULE)], input=json.dumps(requests), capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


def completion(client, messages, max_tokens=1536, temperature=0, seed=42):
    result = client.request("/v1/chat/completions", {"messages": messages, "temperature": temperature,
                             "max_tokens": max_tokens, "seed": seed,
                             "chat_template_kwargs": {"enable_thinking": False}}, timeout=240)
    choice = result["choices"][0]
    raw = (choice["message"].get("content") or "").strip()
    fenced = re.findall(r"^```(?:python|py)[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$", raw, flags=re.I | re.M)
    return (fenced[0] if len(fenced) == 1 else raw), choice.get("finish_reason"), result["usage"]["completion_tokens"]


def extract_source(raw):
    # Cached responses may contain a Markdown example following the answer.
    fenced = re.findall(r"^```(?:python|py)[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$", raw, flags=re.I | re.M)
    if len(fenced) == 1:
        return fenced[0]
    try:
        compile(raw, "<teacher>", "exec")
    except SyntaxError as error:
        prefix = "\n".join(raw.splitlines()[:max(0, (error.lineno or 1) - 1)]).strip()
        if re.search(r"^if __name__ ==", prefix, re.M):
            return prefix
    return raw


def distill(teacher, server, output, cache, workers):
    if digest(teacher) != TEACHER_HASH:
        raise ValueError("Teacher bytes differ from the pinned Apache-2.0 release")
    allowed = licenses()
    if not {"CC0-1.0", "Apache-2.0"}.issubset(allowed):
        raise ValueError("Training prompt license is outside the allowlist")
    prior = ARTIFACTS / "python-brief"
    base_audit = json.loads((prior / "corpus-audit.json").read_text())
    replay = prior / "training-briefs.jsonl"
    if base_audit["overlap"] or digest(replay) != base_audit["data_sha256"]:
        raise ValueError("Replay examples differ from the verified snapshot")
    benchmarks = {**base_audit["benchmarks"], **{str(ROOT / f"{name}.jsonl"): digest(ROOT / f"{name}.jsonl")
                                               for name in ("diagnostic", "holdout")}}
    if any(digest(Path(path)) != sha for path, sha in benchmarks.items()):
        raise ValueError("Evaluation data changed")
    contamination = Contamination([Path(path) for path in benchmarks])

    def eligible(prompt, solution):
        learnable = prompt + "\n" + solution
        return not SECRET.search(learnable) and not contamination.overlaps(learnable, tokens(learnable))

    requests = project_messages([row[1] for row in TASKS])
    generations = {row["id"]: row for row in records(cache)} if cache.exists() else {}
    pending = [(id_, messages) for (id_, _, _), messages in zip(TASKS, requests, strict=True)
               if id_ not in generations or generations[id_]["messages"] != messages]
    if pending:
        with (serve(teacher, server, context_length=4096) as client,
              cache.open("a", encoding="utf-8") as stream, ThreadPoolExecutor(workers) as pool):
            def generate(item):
                id_, messages = item
                code, status, count = completion(client, messages, 848)
                return {"id": id_, "messages": messages, "code": code, "status": status, "tokens": count}

            for row in pool.map(generate, pending):
                stream.write(json.dumps(row) + "\n")
                stream.flush()
                generations[row["id"]] = row
                print(row["id"], row["status"], row["tokens"], flush=True)

    # Release the larger model before starting the Docker VM on memory-limited hosts.
    accepted = []
    rejected = {}
    distilled = 0
    for (id_, prompt, tests), messages in zip(TASKS, requests, strict=True):
        tests = tests or CURSES + CHECKS[id_]
        generation = generations[id_]
        code = extract_source(generation["code"])
        if generation["status"] == "stop" and eligible(prompt, code) and verify(f"CANDIDATE = {code!r}", tests).passed:
            distilled += 1
            license_id = "Apache-2.0"
        elif (reference := REFERENCES.get(id_)) and eligible(prompt, reference) and verify(
            f"CANDIDATE = {reference!r}", tests
        ).passed:
            code = reference
            license_id = "CC0-1.0"
        else:
            rejected[id_] = "No complete, decontaminated answer passed isolated execution"
            print(id_, "rejected", flush=True)
            continue
        accepted.append({"id": id_, "brief": prompt, "solution": code, "license": license_id,
                         "training_source": "programs", "messages": messages})
        print(id_, "accepted", license_id, flush=True)
    if len(accepted) < 8:
        raise ValueError("Too few verified distillation examples")
    replay_examples = []
    for row in records(replay):
        prompt = row["brief"]
        if row["license"] in allowed and eligible(prompt, row["solution"]):
            replay_examples.append(row)
    data = output / "training.jsonl"
    data.write_text("".join(json.dumps(row) + "\n" for row in accepted + replay_examples), encoding="utf-8")
    audit = {"data_sha256": digest(data), "teacher_sha256": TEACHER_HASH, "teacher_revision": TEACHER_REVISION,
             "teacher_license": "Apache-2.0", "distilled": distilled, "original": len(accepted) - distilled,
             "replay": len(replay_examples),
             "benchmarks": benchmarks, "overlap": 0, "rejected": rejected}
    (output / "corpus-audit.json").write_text(json.dumps(audit, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(audit), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("teacher", type=Path)
    parser.add_argument("server")
    parser.add_argument("output", type=Path)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=1)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    distill(args.teacher, args.server, args.output, args.cache, args.workers)
