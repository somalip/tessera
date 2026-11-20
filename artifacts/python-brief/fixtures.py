"""Freeze concise variants of the existing CC0 holdout before training."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ARTIFACTS = ROOT.parent
BRIEFS = {
    "partial_write": "write_all(write, data): repeatedly pass a memoryview of remaining bytes; return total. Empty: no calls. Raise OSError for counts <=0 or above remaining length.",
    "ordered_observations": "attach_readings(sensors, latest) -> fresh dicts in input order. Look up sensor_id; use latest value even None, else old reading or None. Inputs unchanged.",
    "type_dispatch": "coerce_field(value): None stays None; bool to 'true'/'false'; strip str; int/float to str; other types raise TypeError.",
    "non_overlapping_spans": "total_coverage(spans): count union length of unsorted half-open integer intervals. One-pass input; ignore empty; reversed intervals raise ValueError.",
    "cache_expiry": "ttl_lookup(cache,key,now,fetch,ttl): entries (expires_at,value). Use unexpired value including None. Else fetch(key), store (now+ttl,result); leave cache unchanged on error.",
    "path_manifest": "select_manifest(root): sorted relative POSIX strings for regular files ending in exactly '.manifest'. Exclude hidden path components.",
    "bounded_unique": "first_unique(values,count): distinct hashables in encounter order; stop consuming at count. If exhausted, return fewer. Nonpositive count consumes nothing.",
    "byte_frame": "encode_frame(payload): 2-byte unsigned big-endian length followed by original bytes. Raise ValueError for lengths above 65535.",
    "duration_value": "wait_microseconds(start,end): exact signed integer microseconds via datetime subtraction, including multi-day spans and naive/aware mismatch errors. No floats.",
    "nested_context": "capture_append(target): yield list via context manager; on exception truncate additions since entry and rethrow. Preserve on success. Support nested calls.",
    "select_rows": "find_matches(records,columns,needle): lazy original dicts where any named string field contains needle case-insensitively. Skip missing/nonstring fields. Both inputs can be generators.",
    "guarded_quantities": "pad_rows(rows,width,fill=None): yield fresh lists of length width; pad short rows, take at most width items per row. Negative width raises ValueError.",
}
SNAKE_SMOKE = r'''
import fcntl
import os
import pty
import select
import struct
import subprocess
import sys
import tempfile
import termios
import time

with tempfile.TemporaryDirectory() as folder:
    script = os.path.join(folder, "app.py")
    with open(script, "w", encoding="utf-8") as output:
        output.write(CANDIDATE)
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    with subprocess.Popen([sys.executable, "-I", script], stdin=slave, stdout=slave,
                          stderr=slave, env={"TERM": "xterm"}) as process:
        os.close(slave)
        frames = bytearray()
        try:
            deadline = time.monotonic() + 0.8
            while time.monotonic() < deadline and process.poll() is None:
                if select.select([master], [], [], 0.05)[0]:
                    frames.extend(os.read(master, 4096))
            assert process.poll() is None, f"Snake exited before input: {frames!r}"
            os.write(master, b"q")
            assert process.wait(timeout=2) == 0
            assert len(frames) >= 70 and b"Traceback" not in frames, frames
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            os.close(master)
'''

def build():
    original = ARTIFACTS / "python-strength/fresh-audited.jsonl"
    rows = []
    for line in original.read_text().splitlines():
        item = json.loads(line)
        rows.append({"id": item["id"], "prompt": BRIEFS[item["id"]], "tests": item["tests"],
                     "license": item["license"]})
    rows.append({"id": "snake-terminal-smoke", "prompt": "tui snake game", "tests": SNAKE_SMOKE,
                 "license": "CC0-1.0", "standalone": True})
    (ROOT / "heldout-briefs.jsonl").write_text("".join(json.dumps(row) + "\n" for row in rows))

if __name__ == "__main__":
    build()
