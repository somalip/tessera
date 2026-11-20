"""Scale down the first LoRA checkpoint's weight changes before quantization."""
import json
import subprocess
from pathlib import Path

import numpy as np
from gguf import GGUFReader

root = Path(__file__).resolve().parent
previous = root.parent / "python-local"
base = previous / "base.f16.gguf"
fine_tune = previous / "tuned.f16.gguf"
output = root / "scaled.f16.gguf"
pending = root / "scaled.f16.gguf.part"
scale = 0.75
if output.exists() or pending.exists():
    raise FileExistsError(output)
subprocess.run(["cp", "-c", str(fine_tune), str(pending)], check=True)
original = GGUFReader(base, "r")
interpolated = GGUFReader(pending, "r+")
base_tensors = {tensor.name: tensor for tensor in original.tensors}
assert base_tensors.keys() == {tensor.name for tensor in interpolated.tensors}
adapted = {f"blk.{layer}.{name}.weight" for layer in range(20, 28)
           for name in ("attn_q", "attn_v", "attn_output", "ffn_down")}
count = 0
for tensor in interpolated.tensors:
    if tensor.name not in adapted:
        continue
    reference = base_tensors[tensor.name].data
    destination = tensor.data
    assert reference.dtype == destination.dtype == np.float16
    assert reference.shape == destination.shape
    start = reference.reshape(-1)
    end = destination.reshape(-1)
    assert np.shares_memory(destination, end)
    batch = 512_000
    for offset in range(0, len(start), batch):
        region = slice(offset, offset + batch)
        baseline = start[region].astype(np.float32)
        endpoint = end[region].astype(np.float32)
        end[region] = baseline + scale * (endpoint - baseline)
    count += 1
assert count == len(adapted)
interpolated.data.flush()
pending.rename(output)
(root / "scaling.json").write_text(json.dumps({"scale": scale, "projections": count}, indent=2) + "\n")
