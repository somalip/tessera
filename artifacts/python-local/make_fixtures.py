import json
from pathlib import Path
from textwrap import dedent

root = Path(__file__).parent
train, heldout = [], []

def example(group, name, prompt, solution, tests):
    instruction = prompt
    source = dedent(solution).strip()
    row = dict(id=name, prompt=instruction, tests=tests, license="CC0-1.0")
    row["solution" if group is train else "canonical_solution"] = source
    group.append(row)

example(train, "env_flag", "Implement env_flag(value: str | None, default: bool = False) -> bool. Accept 1, true, yes and on as true, and 0, false, no and off as false. Ignore surrounding whitespace and case. Use default for None and reject other strings with ValueError.", """
    def env_flag(value: str | None, default: bool = False) -> bool:
        if value is None:
            return default
        normalized = value.strip().casefold()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
        raise ValueError(f"Invalid boolean: {value!r}")
""", """assert env_flag(None, True) is True
assert env_flag(" YES ") is True and env_flag("Off", True) is False
try:
    env_flag("sometimes")
except ValueError:
    pass
else:
    raise AssertionError("invalid flag accepted")""")
example(train, "decimal_totals", "Implement invoice_totals(rows), where each row has sku, quantity (int), and price (decimal string). Return a dict from SKU to Decimal total. Accumulate repeated SKUs exactly without changing the input.", """
    from decimal import Decimal

    def invoice_totals(rows):
        totals = {}
        for row in rows:
            sku = row["sku"]
            line_total = Decimal(row["price"]) * row["quantity"]
            totals[sku] = totals.get(sku, Decimal(0)) + line_total
        return totals
""", """assert invoice_totals(iter([])) == {}
rows = [{"sku":"x","quantity":3,"price":"0.10"},{"sku":"x","quantity":2,"price":"0.20"}]
totals = invoice_totals(iter(rows))
assert totals == {"x": Decimal("0.70")}
assert isinstance(totals["x"], Decimal) and rows[0]["price"] == "0.10" """)
example(train, "jsonl", "Write iter_objects(lines), a generator parsing JSON Lines from an iterable of strings. Skip blank lines. For invalid JSON or non-object JSON raise ValueError mentioning the original 1-based line number.", """
    import json

    def iter_objects(lines):
        for number, line in enumerate(lines, start=1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except ValueError as exc:
                raise ValueError(f"Invalid JSON on line {number}") from exc
            if not isinstance(value, dict):
                raise ValueError(f"Expected object on line {number}")
            yield value
""", """items = iter_objects(['{"a": 1}', '  ', '[]'])
assert next(items) == {"a": 1}
try:
    next(items)
except ValueError as exc:
    assert "3" in str(exc)
else:
    raise AssertionError("accepted array")""")
example(train, "cache_fix", "Fix this method's cache lookup so legitimate falsey cached values are returned without calling load. Implement lookup(cache, key, load). Cache results even when falsey, and propagate errors from load without inserting the key.\n\ndef lookup(cache, key, load):\n    result = cache.get(key) or load(key)\n    cache[key] = result\n    return result", """
    def lookup(cache, key, load):
        if key not in cache:
            cache[key] = load(key)
        return cache[key]
""", """cache = {"empty": None, "zero": 0}
def unexpected(key):
    raise AssertionError(key)
assert lookup(cache, "empty", unexpected) is None
assert lookup(cache, "zero", unexpected) == 0
assert lookup(cache, "new", lambda key: False) is False
assert lookup(cache, "new", unexpected) is False""")
example(train, "optional_merge", "Implement apply_options(defaults, overrides) returning a new shallow dict. Override values other than None, including 0 and False. Permit keys absent from defaults. Leave input dictionaries unchanged.", """
    def apply_options(defaults, overrides):
        options = defaults.copy()
        options.update({name: value for name, value in overrides.items() if value is not None})
        return options
""", """defaults = {"a": 2, "b": True}
overrides = {"a": 0, "b": None, "c": False}
assert apply_options(defaults, overrides) == {"a": 0, "b": True, "c": False}
assert defaults == {"a": 2, "b": True} and overrides["b"] is None""")
example(train, "incremental_batch", "Write packet_batches(packets, limit) to split a generator into lists of at most limit items. Yield each batch as soon as it fills. Keep a final short batch, omit empty batches, and raise ValueError for a non-positive limit.", """
    def packet_batches(packets, limit):
        if limit <= 0:
            raise ValueError("limit must be positive")
        batch = []
        for packet in packets:
            batch.append(packet)
            if len(batch) == limit:
                yield batch
                batch = []
        if batch:
            yield batch
""", """seen = []
def packet_source():
    for i in range(5):
        seen.append(i)
        yield i
batches = packet_batches(packet_source(), 2)
assert next(batches) == [0, 1] and seen == [0, 1]
assert list(batches) == [[2, 3], [4]]
assert list(packet_batches([], 2)) == []""")
example(train, "timestamps", "Implement parse_utc_timestamp(value) returning an aware UTC datetime from an ISO timestamp. Accept Z and numeric offsets; reject timestamps with no timezone.", """
    from datetime import datetime, timezone

    def parse_utc_timestamp(value):
        if value.endswith("Z"):
            value = value[:-1] + "+00:00"
        stamp = datetime.fromisoformat(value)
        if stamp.utcoffset() is None:
            raise ValueError("timestamp requires a timezone")
        return stamp.astimezone(timezone.utc)
""", """from datetime import datetime, timezone
assert parse_utc_timestamp("2025-05-01T09:00:00+03:00") == datetime(2025, 5, 1, 6, tzinfo=timezone.utc)
assert parse_utc_timestamp("2025-05-01T06:00:00Z").isoformat().endswith("+00:00")
try:
    parse_utc_timestamp("2025-05-01T06:00:00")
except ValueError:
    pass
else:
    raise AssertionError("accepted naive timestamp")""")
example(train, "rollback", "Write a contextmanager named temporary_setting(settings, field, value) that sets a dict key for the duration of a with block. Restore the old value even on exceptions, and remove a key that was originally absent.", """
    from contextlib import contextmanager

    @contextmanager
    def temporary_setting(settings, field, value):
        absent = object()
        previous = settings.get(field, absent)
        settings[field] = value
        try:
            yield
        finally:
            if previous is absent:
                settings.pop(field, None)
            else:
                settings[field] = previous
""", """settings = {"mode": None}
try:
    with temporary_setting(settings, "mode", "debug"):
        assert settings["mode"] == "debug"
        raise RuntimeError("stop")
except RuntimeError:
    pass
assert settings == {"mode": None}
with temporary_setting(settings, "temporary", 4):
    assert settings["temporary"] == 4
assert "temporary" not in settings""")
example(train, "replace_dataclass", "Given this code, implement with_retries(config, retries) returning a new Config with only retries changed. Reject negative retries.\n\nfrom dataclasses import dataclass\n@dataclass(frozen=True)\nclass Config:\n    endpoint: str\n    retries: int\n\nInclude the Config definition in your code.", """
    from dataclasses import dataclass, replace

    @dataclass(frozen=True)
    class Config:
        endpoint: str
        retries: int

    def with_retries(config, retries):
        if retries < 0:
            raise ValueError("retries must be nonnegative")
        return replace(config, retries=retries)
""", """original = Config("/reports", 2)
assert with_retries(original, 0) == Config("/reports", 0)
assert original.retries == 2
try:
    with_retries(original, -1)
except ValueError:
    pass
else:
    raise AssertionError("accepted negative retries")""")
example(train, "csv_import", "Implement read_inventory(stream), reading CSV headers item,stock from an open text stream. Return a dict from stripped item names to integer stock, summing repeated items. Ignore entries with empty item names.", """
    import csv

    def read_inventory(stream):
        inventory = {}
        for row in csv.DictReader(stream):
            item = row["item"].strip()
            if item:
                inventory[item] = inventory.get(item, 0) + int(row["stock"])
        return inventory
""", """from io import StringIO
stream = StringIO('item,stock\\n" pen, red ",2\\n"pen, red",3\\n ,ignored\\n')
assert read_inventory(stream) == {"pen, red": 5}
assert not stream.closed""")
example(train, "resource", "Implement write_message(open_stream, message), where open_stream is a callable returning a context manager yielding a writable text object. Write message followed by one newline and return the count from write. Always let the manager exit when a write fails.", """
    def write_message(open_stream, message):
        with open_stream() as stream:
            return stream.write(message + "\\n")
""", """from contextlib import contextmanager
state = []
class Writer:
    def write(self, message):
        state.append(message)
        return len(message)
@contextmanager
def opener():
    try:
        yield Writer()
    finally:
        state.append("closed")
assert write_message(opener, "ready") == 6
assert state == ["ready\\n", "closed"]""")
example(train, "cli", "Implement parse_port(value) for use as an argparse type. Return an int between 1 and 65535 inclusive. Raise argparse.ArgumentTypeError for invalid integers and numbers outside the allowed range.", """
    import argparse

    def parse_port(value):
        try:
            port = int(value)
        except ValueError as exc:
            raise argparse.ArgumentTypeError("port must be an integer") from exc
        if not 1 <= port <= 65535:
            raise argparse.ArgumentTypeError("port must be between 1 and 65535")
        return port
""", """from argparse import ArgumentTypeError
assert parse_port("1") == 1 and parse_port("65535") == 65535
for value in ("", "0", "65536", "1.2"):
    try:
        parse_port(value)
    except ArgumentTypeError:
        continue
    raise AssertionError(value)""")

example(heldout, "sqlite_query", "Implement active_names(conn, minimum), using the caller's sqlite3 connection. Query the users table (name TEXT, active INTEGER, points INTEGER) for active=1 and points at least minimum. Return names ordered by descending points, then ascending name. Bind minimum as a parameter. Leave the connection open.", """
    def active_names(conn, minimum):
        cursor = conn.execute(
            "SELECT name FROM users WHERE active = 1 AND points >= ? ORDER BY points DESC, name",
            (minimum,),
        )
        return [name for (name,) in cursor]
""", """import sqlite3
db = sqlite3.connect(":memory:")
db.execute("CREATE TABLE users(name TEXT, active INT, points INT)")
db.executemany("INSERT INTO users VALUES(?, ?, ?)", [("zed", 1, 4), ("ann", 1, 4), ("bob", 0, 9), ("eve", 1, 1)])
assert active_names(db, 2) == ["ann", "zed"]
assert active_names(db, "0 OR 1=1") == []
assert db.execute("SELECT count(*) FROM users").fetchone() == (4,)""")
example(heldout, "snapshot", "Fix enqueue(queue, task, tags=[]) so calls without tags never share mutable state and subsequent caller changes to the supplied tags list cannot affect a queued task. Append a dict with keys task and tags to queue, and return None.", """
    def enqueue(queue, task, tags=None):
        queue.append({"task": task, "tags": [] if tags is None else list(tags)})
""", """tasks = []
enqueue(tasks, "index")
enqueue(tasks, "backup")
given = ["urgent"]
assert enqueue(tasks, "clean", given) is None
given.clear()
tasks[0]["tags"].append("internal")
assert tasks == [{"task":"index","tags":["internal"]},{"task":"backup","tags":[]},{"task":"clean","tags":["urgent"]}]""")
example(heldout, "async_limit", "Implement async map_limited(fn, inputs, limit). Run the async function fn concurrently with at most limit calls in flight, and return results in input order. Raise ValueError for a non-positive limit.", """
    import asyncio

    async def map_limited(fn, inputs, limit):
        if limit <= 0:
            raise ValueError("limit must be positive")
        semaphore = asyncio.Semaphore(limit)

        async def call(value):
            async with semaphore:
                return await fn(value)

        return await asyncio.gather(*(call(value) for value in inputs))
""", """import asyncio
async def exercise():
    active = 0
    peak = 0
    async def get(number):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep((5 - number) / 1000)
        active -= 1
        return number ** 2
    assert await map_limited(get, iter(range(5)), 2) == [0, 1, 4, 9, 16]
    assert peak == 2
    assert await map_limited(get, [], 1) == []
asyncio.run(exercise())""")
example(heldout, "path_parts", "Implement image_files(root) with pathlib. Recursively find regular files ending in .png or .jpg case-insensitively. Return sorted POSIX-style paths relative to root as strings. Exclude directories whose names end in those extensions.", """
    from pathlib import Path

    def image_files(root):
        base = Path(root)
        return sorted(
            path.relative_to(base).as_posix()
            for path in base.rglob("*")
            if path.is_file() and path.suffix.lower() in {".png", ".jpg"}
        )
""", """from tempfile import TemporaryDirectory
from pathlib import Path
with TemporaryDirectory() as work:
    base = Path(work)
    (base / "nested.PNG").mkdir()
    (base / "nested.PNG" / "photo.jPg").touch()
    (base / "header.PNG").touch()
    (base / "report.pdf").touch()
    assert image_files(work) == ["header.PNG", "nested.PNG/photo.jPg"]""")
example(heldout, "log_summary", "Implement top_errors(events, count) for an iterable of (level, message) pairs. Count only level exactly 'ERROR'. Return up to count (message, frequency) tuples, ranked by descending frequency and lexicographic message for ties. Return [] when count is nonpositive.", """
    from collections import Counter

    def top_errors(events, count):
        if count <= 0:
            return []
        counts = Counter(message for level, message in events if level == "ERROR")
        return sorted(counts.items(), key=lambda pair: (-pair[1], pair[0]))[:count]
""", """events = [("INFO","disk"),("ERROR","disk"),("ERROR","clock"),("ERROR","cache"),("ERROR","disk"),("error","cache")]
assert top_errors(iter(events), 2) == [("disk", 2), ("cache", 1)]
assert top_errors(iter(events), -1) == []""")
example(heldout, "duration", "Fix elapsed(start_ns, finish_ns), currently implemented as round((finish_ns - start_ns) / 1e6), so that it returns the number of complete milliseconds elapsed. Inputs are integer monotonic clock timestamps in nanoseconds. Raise ValueError when finish precedes start. Handle very large integers exactly.", """
    def elapsed(start_ns, finish_ns):
        if finish_ns < start_ns:
            raise ValueError("finish precedes start")
        return (finish_ns - start_ns) // 1_000_000
""", """assert elapsed(100, 999_999) == 0
assert elapsed(100, 1_900_100) == 1
assert elapsed(0, 10**28 + 999_999) == 10**22
try:
    elapsed(3, 2)
except ValueError:
    pass
else:
    raise AssertionError("backwards clock accepted")""")
example(heldout, "decode", "Implement decode_record(payload), taking bytes encoded as UTF-8 JSON. Return the 'record' field if its value is a dict. Raise ValueError for bad encoding, invalid JSON, a non-object top level, or a missing or non-dict record.", """
    import json

    def decode_record(payload):
        value = json.loads(payload.decode("utf-8"))
        if not isinstance(value, dict) or not isinstance(value.get("record"), dict):
            raise ValueError("expected a record object")
        return value["record"]
""", """assert decode_record(b'{"record":{"ok":true}}') == {"ok": True}
for payload in (bytes([255]), b'{', b'[]', b'{}', b'{"record":null}', b'{"record":[]}'):
    try:
        decode_record(payload)
    except ValueError:
        continue
    raise AssertionError(payload)""")
example(heldout, "one_shot", "Implement stream_window(stream, start, stop) yielding items with zero-based offsets in [start, stop). Inputs are a one-pass iterator and nonnegative offsets. Do not consume the item at stop or any item when stop <= start.", """
    from itertools import islice

    def stream_window(stream, start, stop):
        if stop > start:
            yield from islice(stream, start, stop)
""", """events = iter(range(9))
assert list(stream_window(events, 3, 3)) == []
assert next(events) == 0
assert list(stream_window(events, 1, 4)) == [2, 3, 4]
assert next(events) == 5""")

for filename, rows in (("supervised.jsonl", train), ("heldout.jsonl", heldout)):
    (root / filename).write_text("".join(json.dumps(row) + "\n" for row in rows))
