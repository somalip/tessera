"""Trade rarely used vocabulary rows for higher transformer precision."""
import json
from pathlib import Path

import numpy as np
from gguf import GGUFReader, GGUFWriter, GGUFValueType
from tokenizers import Tokenizer

ROOT = Path(__file__).resolve().parent
BASE = ROOT.parent / "python-local/base"
SOURCE = ROOT.parent / "python-base-comparison/scaled.f16.gguf"
TARGET = ROOT / "compact-vocab.f16.gguf"
LIMIT = 44_000

reader = GGUFReader(SOURCE, "r")
fields = reader.fields
token_names = fields["tokenizer.ggml.tokens"].contents()
token_types = fields["tokenizer.ggml.token_type"].contents()
merges = fields["tokenizer.ggml.merges"].contents()
assert len(token_names) == len(token_types)
id_fields = [key for key in fields if key.startswith("tokenizer.ggml.") and key.endswith("_token_id")]
keep = set(range(LIMIT))
tokenizer = Tokenizer.from_file(str(BASE / "tokenizer.json"))
tokenizer_data = json.loads((BASE / "tokenizer.json").read_text())
keep.update(item["id"] for item in tokenizer_data["added_tokens"])
keep.update(fields[key].contents() for key in id_fields)
for filename in ("exercism-verified.jsonl",):
    for line in (ROOT / filename).read_text().splitlines():
        row = json.loads(line)
        for field in ("prompt", "solution"):
            keep.update(tokenizer.encode(row[field]).ids)
ids = {name: i for i, name in enumerate(token_names)}
# A retained merged token must remain reachable through its earlier BPE symbols.
pairs = [merge.split(" ", 1) for merge in merges]
for left, right in reversed(pairs):
    if ids.get(left + right) in keep:
        keep.update(ids[name] for name in (left, right) if name in ids)
selected = sorted(keep)
remap = {old: new for new, old in enumerate(selected)}
pieces = {token_names[i] for i in selected}
retained_merges = [merge for merge, (left,right) in zip(merges, pairs, strict=True)
                   if left in pieces and right in pieces and left + right in pieces]
assert len(selected) < len(token_names)
metadata = {
    "tokenizer.ggml.tokens": [token_names[i] for i in selected],
    "tokenizer.ggml.token_type": [token_types[i] for i in selected],
    "tokenizer.ggml.merges": retained_merges,
    **{key: remap[fields[key].contents()] for key in id_fields},
}
if "qwen2.vocab_size" in fields:
    metadata["qwen2.vocab_size"] = len(selected)
if "tokenizer.ggml.scores" in fields:
    scores = fields["tokenizer.ggml.scores"].contents()
    assert len(scores) == len(token_names)
    metadata["tokenizer.ggml.scores"] = [scores[i] for i in selected]

writer = GGUFWriter(TARGET, fields["general.architecture"].contents(), endianess=reader.endianess)
for name, field in fields.items():
    if name.startswith("GGUF.") or name == "general.architecture":
        continue
    spec = field.types[0]
    subtype = field.types[-1] if spec == GGUFValueType.ARRAY else None
    value = metadata[name] if name in metadata else field.contents()
    if value is not None:
        writer.add_key_value(name, value, spec, sub_type=subtype)

matrices = {}
for tensor in reader.tensors:
    data = tensor.data
    if tensor.name in {"token_embd.weight","output.weight"}:
        assert data.ndim == 2 and data.shape[0] == len(token_names), (tensor.name,data.shape)
        data = np.ascontiguousarray(data[selected])
        matrices[tensor.name] = data
    writer.add_tensor_info(tensor.name, data.shape, data.dtype, data.nbytes, tensor.tensor_type)
assert "token_embd.weight" in matrices
writer.write_header_to_file()
writer.write_kv_data_to_file()
writer.write_ti_data_to_file()
for tensor in reader.tensors:
    writer.write_tensor_data(matrices.get(tensor.name,tensor.data), tensor_endianess=reader.endianess)
writer.close()
(ROOT / "compact-vocab.json").write_text(json.dumps(
    {"original_rows": len(token_names), "retained_rows": len(selected), "original_merges": len(merges),
     "retained_merges": len(retained_merges), "training_source": "exercism-verified.jsonl"}, indent=2) + "\n")
