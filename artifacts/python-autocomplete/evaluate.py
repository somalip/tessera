"""Compare single-line FIM checkpoints on CPU using held-out Python fixtures."""
import argparse
import ast
import hashlib
import json
from pathlib import Path
import socket
import statistics
import subprocess
import time
from urllib.error import URLError
from urllib.request import Request, urlopen

# Original CC0-1.0 prompts. Operations are held out by family.
FIXTURES = [
    ("def greeting(name):\n    # Return Hello, followed by the name\n    ", "",
     ('return f"Hello, {name}"', 'return "Hello, " + name')),
    ("def average(samples):\n    # Calculate the arithmetic mean of the samples\n    mean = ",
     "\n    return mean\n", ("sum(samples) / len(samples)",)),
    ("def indexes(names):\n    # Map each name to its position, starting at zero\n    ",
     "\n    return by_name\n", ("by_name = {name: index for index, name in enumerate(names)}",
                              "by_name = {name: i for i, name in enumerate(names)}")),
    ("def is_even(number):\n    # Return whether the number is divisible by two\n    ",
     "", ("return number % 2 == 0", "return not number % 2")),
    ("def extend_all(groups):\n    # Flatten one level of nested lists\n    flat = ",
     "\n    return flat\n", ("[item for group in groups for item in group]",)),
    ("def domain(address):\n    # Return the part after the last @\n    ", "",
     ('return address.rsplit("@", 1)[-1]', 'return address.split("@")[-1]')),
    ("def factorials(n):\n    import math\n    # Compute n factorial\n    answer = ",
     "\n    return answer\n", ("math.factorial(n)",)),
    ("def categorize(count):\n    # Use the label 'item' for one, otherwise 'items'\n    word = ",
     "\n    return word\n", ('"item" if count == 1 else "items"',)),
    ("def character_counts(text):\n    from collections import Counter\n    counts = ",
     "\n    return counts\n", ("Counter(text)",)),
    ("def combinations(left, right):\n    result = list(zip(", "))\n    return result\n",
     ("left, right",)),
    ("def with_index(rows):\n    for index, row in ", ":\n        yield index, row\n",
     ("enumerate(rows)",)),
    ("def powers(values):\n    return [", " for v in values]\n", ("v ** 2", "v * v")),
]

STOP = ["\n", "\r", "<|endoftext|>", "<|fim_prefix|>", "<|fim_suffix|>", "<|fim_middle|>"]


def score(origin):
    results = []
    for prefix, suffix, expected in FIXTURES:
        prompt = f"<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>"
        request = Request(origin + "/v1/completions", json.dumps({
            "prompt": prompt, "stop": STOP, "max_tokens": 32, "temperature": 0, "stream": True,
        }).encode(), {"Content-Type": "application/json"})
        start = time.perf_counter()
        first = None
        text = ""
        with urlopen(request, timeout=30) as response:
            for line in response:
                if not line.startswith(b"data: ") or line.strip() == b"data: [DONE]":
                    continue
                chunk = json.loads(line[6:])["choices"][0]["text"]
                if chunk and first is None:
                    first = round((time.perf_counter() - start) * 1000, 1)
                text += chunk
        complete = round((time.perf_counter() - start) * 1000, 1)
        clean = text.strip()
        try:
            tree = ast.dump(ast.parse(prefix + text + suffix))
            valid = bool(clean)
        except SyntaxError:
            tree = None
            valid = False
        matches = valid and any(
            tree == ast.dump(ast.parse(prefix + candidate + suffix)) for candidate in expected
        )
        results.append({"prefix": prefix, "suffix": suffix, "completion": text,
                        "expected": expected, "valid": valid, "match": matches,
                        "first_ms": first, "complete_ms": complete})
    return results


def measure(server, model):
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    origin = f"http://127.0.0.1:{port}"
    start = time.perf_counter()
    process = subprocess.Popen([
        str(server), "--model", str(model), "--host", "127.0.0.1", "--port", str(port),
        "--ctx-size", "768", "--device", "none", "--n-gpu-layers", "0",
        "--parallel", "1", "--cache-ram", "0",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        while True:
            try:
                with urlopen(origin + "/health", timeout=0.5):
                    break
            except (URLError, TimeoutError) as error:
                if process.poll() is not None or time.perf_counter() - start > 20:
                    raise RuntimeError("llama-server failed to start") from error
                time.sleep(0.02)
        startup = round((time.perf_counter() - start) * 1000, 1)
        results = score(origin)
        first = [row["first_ms"] for row in results if row["first_ms"] is not None]
        with model.open("rb") as weights:
            digest = hashlib.file_digest(weights, "sha256").hexdigest()
        return {
            "sha256": digest, "model": model.name, "size_bytes": model.stat().st_size,
            "startup_ms": startup, "median_first_ms": statistics.median(first) if first else None,
            "median_complete_ms": statistics.median(row["complete_ms"] for row in results),
            "exact_ast_matches": sum(row["match"] for row in results),
            "valid_completions": sum(row["valid"] for row in results),
            "results": results,
        }
    finally:
        process.terminate()
        process.wait(timeout=10)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", required=True, type=Path)
    parser.add_argument("models", nargs="+", type=Path)
    args = parser.parse_args()
    print(json.dumps([measure(args.server, model) for model in args.models], indent=2))
