"""Profile first-token latency, throughput, and resident memory on a local CPU."""

import argparse
import json
import math
import platform
import statistics
import threading
import time
from pathlib import Path
from typing import Any

import psutil  # type: ignore[import-untyped]

from eval.inference import Client, serve
from eval.report import digest

FIM = "<|fim_prefix|>{prefix}<|fim_suffix|>\n<|fim_middle|>"


def profile_request(client: Client, prompt: str, cache: bool) -> dict[str, Any]:
    start = time.perf_counter()
    first = None
    measurements = None
    with client.open(
        "/completion",
        {
            "prompt": prompt,
            "n_predict": 32,
            "stream": True,
            "seed": 0,
            "temperature": 0,
            "cache_prompt": cache,
            "ignore_eos": True,
        },
    ) as stream:
        for line in stream:
            if not line.startswith(b"data:"):
                continue
            event = json.loads(line[5:])
            if first is None and event.get("content"):
                first = (time.perf_counter() - start) * 1000
            if event.get("stop"):
                measurements = event["timings"]
    if first is None or not measurements:
        raise RuntimeError("Runtime did not provide content and timing events")
    return {
        "first_token_ms": first,
        "tokens_per_second": measurements["predicted_per_second"],
        "prompt_tokens": measurements["prompt_n"] + measurements.get("cache_n", 0),
        "generated_tokens": measurements["predicted_n"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--server", default="llama-server")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--mode", choices=["cold", "warm"], default="cold")
    parser.add_argument("--runs", type=int, default=20)
    parser.add_argument("--memory-mib", type=int, required=True)
    parser.add_argument("--enforce", action="store_true")
    args = parser.parse_args()
    if args.runs < 1 or args.memory_mib < 1:
        parser.error("Runs and memory budget must be positive")
    start = time.perf_counter()
    with serve(args.model, args.server) as client:
        load_ms = (time.perf_counter() - start) * 1000
        if client.pid is None:
            raise RuntimeError("Missing llama-server process ID")
        process = psutil.Process(client.pid)
        finished = threading.Event()
        memory = [process.memory_info().rss]

        def sample() -> None:
            while not finished.wait(0.02):
                try:
                    memory[0] = max(memory[0], process.memory_info().rss)
                except psutil.NoSuchProcess:
                    break

        monitor = threading.Thread(target=sample, daemon=True)
        monitor.start()
        try:
            warm = args.mode == "warm"
            lines = "".join(
                f"    items.append(({value}, {value}))\n" for value in range(110)
            )

            def run(index: int) -> dict[str, Any]:
                name = "values" if warm else f"values_{index}"
                prefix = f"def {name}():\n    items = []\n{lines}    last = {index}\n    return "
                return profile_request(client, FIM.format(prefix=prefix), warm)

            if warm:
                run(-1)
            runs = [run(index) for index in range(args.runs)]
        finally:
            finished.set()
            monitor.join()
    sorted_first = sorted(row["first_token_ms"] for row in runs)
    p95 = sorted_first[math.ceil(len(sorted_first) * 0.95) - 1]
    throughput = statistics.median(row["tokens_per_second"] for row in runs)
    budget = args.memory_mib * 1024**2
    gates = {
        "size": args.model.stat().st_size < 1_000_000_000,
        "prompt_window": all(1000 <= row["prompt_tokens"] <= 2000 for row in runs),
        "load_time": load_ms < 2000,
        "first_token": p95 < 300,
        "throughput": throughput >= 25,
        "resident_memory": memory[0] <= budget,
    }
    report = {
        "host": platform.platform(),
        "machine": platform.machine(),
        "mode": args.mode,
        "model_sha256": digest(args.model),
        "load_ms": load_ms,
        "first_token_p95_ms": p95,
        "median_tokens_per_second": throughput,
        "peak_rss_bytes": memory[0],
        "memory_budget_bytes": budget,
        "gates": gates,
        "runs": runs,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf8")
    print(
        json.dumps(
            {key: value for key, value in report.items() if key != "runs"}, indent=2
        )
    )
    if args.enforce and not all(gates.values()):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
