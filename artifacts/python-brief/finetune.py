"""Build a verified Python brief corpus and share the training prompt and adapter."""
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sys

from torch import nn

from data.pipelines.filtering import Contamination, SECRET, records, tokens
from data.sources.licensing import licenses
from eval.report import digest
from verifiers.python.runner import verify
from programs import PROGRAMS

ROOT = Path(__file__).resolve().parent
ARTIFACTS = ROOT.parent
sys.path.insert(0, str(ARTIFACTS / "python-strength"))
from build_corpus import BENCHMARKS, verify_record
from finetune_exercism import LoRA, RANK

BASE = ARTIFACTS / "python-local/base"
ACTIVE = ARTIFACTS / "python-base-comparison/scaled.f16.gguf"
EXERCISES = ARTIFACTS / "python-strength/exercism-verified.jsonl"
REPLAY = ARTIFACTS / "python-base-comparison/supervised.jsonl"
HOLDOUT = ROOT / "heldout-briefs.jsonl"
SYSTEM = (
    "Return only complete, runnable code for insertion at the cursor. "
    "Use the file language and honor the request. Do not include explanations, placeholders, or repeat existing code. "
    "Prefer standard library APIs unless the request requires a dependency. Indent relative to column zero. "
    "Define everything the code uses and include a runnable entry point for a standalone program. "
    "For interactive programs, implement input handling, state updates, rendering, and a clean exit."
)
TERMINAL = (
    "\nUse Python curses. Define main(stdscr) with initialization and the entire timed event loop. "
    "Call curses.wrapper(main) once under the __main__ guard. Avoid nested functions. "
    "Use stdscr.keypad(True), stdscr.timeout(120), and getch(). Handle q before updating state. "
    "For grid movement, represent positions and direction as (row, column) pairs, with a key-to-direction map. "
    "For games, implement the core mechanics, collisions, score, and game over."
)
EXERCISE_BRIEFS = {
    "allergies": "Allergies(score): bits 0..7 map to eggs, peanuts, shellfish, strawberries, tomatoes, chocolate, pollen, cats. Ignore higher bits. Provide allergic_to(item) and ordered lst property.",
    "anagram": "find_anagrams(word,candidates): retain case-insensitive anagrams in input order; exclude the same word regardless of case.",
    "collatz-conjecture": "steps(number): count Collatz steps to 1. Even n // 2, odd 3*n+1. Nonpositive raises ValueError('Only positive integers are allowed').",
    "diamond": "rows(letter): centered uppercase A-to-letter diamond, one row per step then mirror. Retain trailing spaces and return list of strings.",
    "hamming": "distance(strand_a,strand_b): count differing positions. Unequal lengths raise ValueError('Strands must be of equal length.').",
    "high-scores": "HighScores(scores): latest() returns last; personal_best() max; personal_top_three() up to three descending; retain scores attribute and source order.",
    "knapsack": "maximum_value(maximum_weight,items): 0/1 knapsack over dicts with weight/value. Return max total value within capacity; each item used once.",
    "matching-brackets": "is_paired(input_string): balanced nested (), [], {}; ignore other characters; return bool.",
    "matrix": "Matrix(matrix_string): parse whitespace-separated ints per line. row(index) and column(index) return lists using one-based indices.",
    "rotational-cipher": "rotate(text,key): Caesar shift ASCII letters preserving case, wrap alphabet; other characters unchanged.",
    "run-length-encoding": "encode(string), decode(string): run-length codec; omit count for singles; preserve whitespace; support multi-digit counts.",
    "strain": "keep(sequence,predicate) and discard(sequence,predicate): return lists of matching or nonmatching items in original order.",
    "word-count": "count_words(sentence): case-insensitive word frequency dict; split punctuation/whitespace; keep internal apostrophes and digits, discard wrapping quotes.",
}
REPLAY_BRIEFS = {
    "decimal_totals": "invoice_totals(rows): map SKU to exact Decimal sum of quantity * decimal-string price. Accumulate repeated SKU; no input mutation.",
    "jsonl": "iter_objects(lines): generator of JSONL objects; skip blank lines. Invalid JSON and nondicts raise ValueError with original one-based line number.",
    "cache_fix": "lookup(cache,key,load): return existing values including falsey values. On miss call load(key), cache success; propagate exceptions without inserting.",
    "optional_merge": "apply_options(defaults,overrides): new shallow dict; apply overrides except None, including falsey values and extra keys; no input mutation.",
    "rollback": "temporary_setting(settings,field,value): context manager sets key; restore old value in finally or delete originally absent key.",
    "csv_import": "read_inventory(stream): CSV item,stock; strip item names, skip blanks, sum integer stock for duplicate items; return dict.",
    "cli": "parse_port(value): argparse type accepting integers 1..65535 inclusive; invalid input raises argparse.ArgumentTypeError.",
    "compare_versions": "compare_version(a,b): numeric dotted nonnegative versions; pad short side with zeros; return -1,0,1.",
    "limit_bytes": "utf8_prefix(text,budget): longest prefix within UTF-8 byte budget; never split character; nonpositive budget yields empty string.",
    "duration_parts": "format_uptime(seconds): DD:HH:MM:SS, each field min 2 digits; days may exceed 99; reject negatives with ValueError.",
    "split_extension": "split_backup(filename): split final case-sensitive .bak or .old if nonempty stem; otherwise (filename,None).",
    "rolling_checksum": "in_memory_digest(chunks): stream iterable of bytes into SHA-256; return hex digest without joining input.",
    "class_copy": "UsageCounter: independent instances, value property, record(amount=1) adds and returns total, reset() returns prior total; no negative increments.",
    "filesize_labels": "filesize_label(size): nonnegative bytes; <1024 plain B, else largest reached KiB/MiB/GiB with one decimal.",
}

def messages(brief):
    terminal = TERMINAL if brief.casefold().startswith("tui") else ""
    return [{"role": "system", "content": SYSTEM}, {
        "role": "user", "content": f"Language: python\nRequest: {brief}\nBefore cursor:\n\nAfter cursor:\n{terminal}",
    }]

def corpus():
    benchmarks = [*BENCHMARKS, HOLDOUT]
    contamination = Contamination(benchmarks)
    allowed = licenses()
    if any(item["license"] not in allowed for item in records(HOLDOUT)):
        raise ValueError("Holdout license is outside the allowlist")
    audit = json.loads((EXERCISES.parent / "corpus-audit.json").read_text())
    if audit["data_sha256"] != digest(EXERCISES) or audit["accepted_overlap"] != 0:
        raise ValueError("Verified exercise snapshot changed")
    examples = []
    for path, briefs, source in [(EXERCISES, EXERCISE_BRIEFS, "exercism"), (REPLAY, REPLAY_BRIEFS, "replay")]:
        for item in records(path):
            if item["id"] in briefs and item["format"] == "chat":
                examples.append(dict(item, brief=briefs[item["id"]], training_source=source))
    examples.extend({"id": id_, "prompt": brief, "brief": brief, "solution": solution, "tests": tests,
                     "license": "CC0-1.0", "training_source": "programs"}
                    for id_, brief, solution, tests in PROGRAMS)
    approved = []
    rejected = {}
    for row in examples:
        content = "\n".join(row[key] for key in ("brief", "prompt", "solution", "tests"))
        if row["license"] not in allowed or SECRET.search(content) or contamination.overlaps(content, tokens(content)):
            rejected[row["id"]] = "license, private-data, or overlap flag"
        else:
            approved.append(row)

    def passes(row):
        if row["training_source"] == "exercism":
            return verify_record(row)[1]
        source = f"namespace = {{'__name__': 'training'}}\nexec(compile({row['solution']!r}, '<implementation>', 'exec'), namespace)\nglobals().update({{k:v for k,v in namespace.items() if not k.startswith('__')}})"
        return verify(source, row["tests"]).passed

    with ThreadPoolExecutor(max_workers=2) as pool:
        verified = []
        for row, passed in zip(approved, pool.map(passes, approved), strict=True):
            if passed:
                verified.append(row)
            else:
                rejected[row["id"]] = "isolated execution failed"
    if len(verified) < 24 or sum(row["training_source"] == "programs" for row in verified) < 5:
        raise RuntimeError(f"Too few verified Python examples: {rejected}")
    dataset = ROOT / "training-briefs.jsonl"
    dataset.write_text("".join(json.dumps(row) + "\n" for row in verified))
    audit = {"data_sha256": digest(dataset), "examples": len(verified), "sources": dict(Counter(
        row["training_source"] for row in verified)), "licenses": sorted({row["license"] for row in verified}),
        "overlap": 0, "benchmarks": {str(path): digest(path) for path in benchmarks}, "rejected": rejected}
    (ROOT / "corpus-audit.json").write_text(json.dumps(audit, indent=2) + "\n")
    print(json.dumps(audit), flush=True)

def cpu_adapter(linear):
    # Use the same rank and scale as the MPS adapter without allocating on Metal.
    adapter = LoRA.__new__(LoRA)
    nn.Module.__init__(adapter)
    adapter.linear = linear
    adapter.down = nn.Linear(linear.in_features, RANK, bias=False)
    adapter.up = nn.Linear(RANK, linear.out_features, bias=False)
    nn.init.zeros_(adapter.up.weight)
    return adapter


if __name__ == "__main__":
    corpus()
