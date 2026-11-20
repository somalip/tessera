"""Apply a conservative fraction of the new training update to the active model."""
import json
from pathlib import Path
import subprocess

import numpy as np
from gguf import GGUFReader

root = Path(__file__).resolve().parent
active = root.parent / "python-base-comparison/scaled.f16.gguf"
parent = root.parent / "python-local/tuned.f16.gguf"
trained = root / "exercism-sft.f16.gguf"
output = root / "exercise-replay.f16.gguf"
pending = output.with_suffix(".gguf.part")
weight = 0.5
if output.exists() or pending.exists():
    raise FileExistsError(output)
subprocess.run(["cp","-c",str(active),str(pending)],check=True)
left = {tensor.name:tensor for tensor in GGUFReader(parent).tensors}
right = {tensor.name:tensor for tensor in GGUFReader(trained).tensors}
result = GGUFReader(pending,"r+")
expected = {f"blk.{i}.{kind}.weight" for i in range(20,28)
            for kind in ("attn_q","attn_v","attn_output","ffn_down")}
assert left.keys() == right.keys() == {tensor.name for tensor in result.tensors}
updated = 0
for tensor in result.tensors:
    if tensor.name not in expected:
        continue
    before, after, output_data = left[tensor.name].data, right[tensor.name].data, tensor.data
    assert before.shape == after.shape == output_data.shape
    assert before.dtype == after.dtype == output_data.dtype == np.float16
    original, revised, target = [data.reshape(-1) for data in (before,after,output_data)]
    assert np.shares_memory(output_data,target)
    limit = 512_000
    for begin in range(0,len(target),limit):
        span = slice(begin,begin+limit)
        delta = revised[span].astype(np.float32) - original[span].astype(np.float32)
        target[span] = target[span].astype(np.float32) + weight*delta
    updated += 1
assert updated == len(expected)
result.data.flush()
pending.rename(output)
(root/"exercise-replay-metadata.json").write_text(json.dumps(
    {"update_fraction":weight,"projections":updated},indent=2)+"\n")
