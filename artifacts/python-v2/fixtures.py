"""Frozen CC0-1.0 Python implementation and maintenance tasks."""
import json
from pathlib import Path
from textwrap import dedent

rows = []
def add(name, prompt, source, tests):
    rows.append(dict(id=name, license="CC0-1.0", prompt=dedent(prompt).strip(),
                     canonical_solution=dedent(source).strip(), tests=dedent(tests).strip()))

add("stable_group", """
    Implement group_updates(updates) for a data import. Each element is a (key, value) pair.
    Return a list of (key, values) tuples, with keys in order of first appearance
    and each values list in arrival order. Accept a one-pass iterable and preserve duplicates.
    """, """
    def group_updates(updates):
        grouped = {}
        for key, value in updates:
            grouped.setdefault(key, []).append(value)
        return list(grouped.items())
    """, """
    assert group_updates(iter([("z", 7), ("a", 0), ("z", 7), ("a", None)])) == [("z", [7, 7]), ("a", [0, None])]
    assert group_updates(iter(())) == []
    """)

add("recursive_config", """
    Implement merge_config(base, patch) for nested configuration dictionaries.
    Merge nested dictionaries recursively when both sides have dictionaries.
    A patch value of None is stored as None. All other patch values replace the base value.
    Return an independent result, including lists or dictionaries kept from either side.
    """, """
    from copy import deepcopy

    def merge_config(base, patch):
        result = deepcopy(base)
        for key, item in patch.items():
            previous = result.get(key)
            if isinstance(previous, dict) and isinstance(item, dict):
                result[key] = merge_config(previous, item)
            else:
                result[key] = deepcopy(item)
        return result
    """, """
    original = {"service": {"ports": [9000], "cache": True}, "strict": True}
    patch = {"service": {"cache": None, "labels": ["blue"]}, "strict": False}
    merged = merge_config(original, patch)
    assert merged == {"service": {"ports": [9000], "cache": None, "labels": ["blue"]}, "strict": False}
    merged["service"]["ports"].append(9001)
    merged["service"]["labels"].clear()
    assert original["service"]["ports"] == [9000] and patch["service"]["labels"] == ["blue"]
    """)

add("pathlib_api", """
    Implement report_paths(root) inside a reporting module. Return pairs (day, path).
    A report is a regular file directly under root whose name exactly matches
    report-YYYY-MM-DD.csv, where YYYY-MM-DD parses to a valid date.
    Use date objects for day, pathlib.Path for path, sorted by date ascending.
    """, """
    import re
    from datetime import date
    from pathlib import Path

    def report_paths(root):
        reports = []
        for path in Path(root).iterdir():
            match = re.fullmatch(r"report-([0-9]{4}-[0-9]{2}-[0-9]{2})\\.csv", path.name)
            if match is None or not path.is_file():
                continue
            try:
                day = date.fromisoformat(match[1])
            except ValueError:
                continue
            reports.append((day, path))
        return sorted(reports)
    """, """
    from datetime import date
    from pathlib import Path
    from tempfile import TemporaryDirectory

    with TemporaryDirectory() as directory:
        root = Path(directory)
        for name in ["report-2024-02-29.csv", "report-2023-02-29.csv", "report-2024-01-02.csv", "report-2024-1-02.csv"]:
            (root / name).touch()
        (root / "report-2024-01-01.csv").mkdir()
        assert report_paths(root) == [
            (date(2024, 1, 2), root / "report-2024-01-02.csv"),
            (date(2024, 2, 29), root / "report-2024-02-29.csv"),
        ]
    """)

add("legacy_cursor", """
    A local API uses one-based page numbers. Correct this function, keeping its signature.

    def page_bounds(page, size, total):
        start = page * size
        return start, start + size

    Return a half-open index pair (start, stop), with both endpoints clamped to total.
    Raise ValueError if page or size is nonpositive or total is negative.
    """, """
    def page_bounds(page, size, total):
        if page < 1 or size < 1 or total < 0:
            raise ValueError("invalid pagination")
        return min((page - 1) * size, total), min(page * size, total)
    """, """
    assert page_bounds(1, 4, 11) == (0, 4)
    assert page_bounds(3, 4, 11) == (8, 11)
    assert page_bounds(4, 4, 11) == (11, 11)
    assert page_bounds(1, 4, 0) == (0, 0)
    for arguments in [(0, 5, 7), (1, 0, 0), (1, 1, -1)]:
        try:
            page_bounds(*arguments)
        except ValueError:
            continue
        raise AssertionError(arguments)
    """)

add("queue_accounting", """
    A worker tracker already provides this interface.

    class Job:
        def __init__(self, status, size):
            self.status = status
            self.size = size

    Implement summarize_jobs(jobs) in the consumer module. Treat jobs as any iterable
    of objects that expose those attributes. Return a dictionary from status to
    (count, total_size) pairs, retaining statuses whose total_size is zero.
    """, """
    def summarize_jobs(jobs):
        result = {}
        for job in jobs:
            count, size = result.get(job.status, (0, 0))
            result[job.status] = count + 1, size + job.size
        return result
    """, """
    from types import SimpleNamespace

    def item(status, size):
        return SimpleNamespace(status=status, size=size)

    jobs = iter([item("queued", 2), item("live", 5), item("queued", -2)])
    assert summarize_jobs(jobs) == {"queued": (2, 0), "live": (1, 5)}
    assert summarize_jobs(jobs) == {}
    """)

add("retry", """
    Implement retry_read(read, attempts). Call read() up to attempts times and
    return its first successful result, including None. Retry only TimeoutError.
    If all attempts time out, propagate the final exception. Raise ValueError before
    calling read if attempts is less than one. Do not sleep.
    """, """
    def retry_read(read, attempts):
        if attempts < 1:
            raise ValueError("attempts must be positive")
        for attempt in range(attempts):
            try:
                return read()
            except TimeoutError:
                if attempt == attempts - 1:
                    raise
    """, """
    calls = []
    last = TimeoutError("last")
    def read():
        calls.append(1)
        if len(calls) == 1:
            raise last
    assert retry_read(read, 2) is None and len(calls) == 2
    for exception in [last, KeyError("broken")]:
        def fail():
            raise exception
        try:
            retry_read(fail, 2)
        except type(exception) as received:
            assert received is exception
        else:
            raise AssertionError("exception suppressed")
    """)

add("event_dedup", """
    Implement iter_unique_events(events). An event is a dict with a string id,
    except that id may be absent or None. Yield the original objects in input order,
    keeping only the first event for each non-None id. Events with missing or None
    ids are always retained. Process the input lazily.
    """, """
    def iter_unique_events(events):
        seen = set()
        for event in events:
            identifier = event.get("id")
            if identifier is not None:
                if identifier in seen:
                    continue
                seen.add(identifier)
            yield event
    """, """
    history = []
    first = {"id": ""}
    rest = [{"id": ""}, {"id": None}, {}, {"id": "a"}, {"id": "a"}, {}]
    def generate():
        for value in [first, *rest]:
            history.append(value)
            yield value
    stream = iter_unique_events(generate())
    assert next(stream) is first and len(history) == 1
    assert list(stream) == [rest[1], rest[2], rest[3], rest[5]]
    """)

add("record_composition", """
    Implement render_row(fields, record, missing="-") for a tab-separated exporter.
    fields is ordered and can contain repeats. For absent names or None values
    insert missing. Preserve meaningful falsey values by converting them with str().
    Escape tabs and newlines in every output field as the literal two-character
    sequences backslash-t and backslash-n. Escape literal backslashes first.
    """, r"""
    def render_row(fields, record, missing="-"):
        def encode(value):
            return str(value).replace("\\", "\\\\").replace("\t", "\\t").replace("\n", "\\n")

        result = []
        for key in fields:
            value = record.get(key)
            result.append(encode(missing if value is None else value))
        return "\t".join(result)
    """, r"""
    row = {"x": False, "y": 0, "z": "one\tline\\with\nnewline", "nil": None}
    assert render_row(["x", "y", "x", "z", "absent", "nil"], row) == "False\t0\tFalse\tone\\tline\\\\with\\nnewline\t-\t-"
    assert render_row([], row) == ""
    """)

Path(__file__).with_name("heldout.jsonl").write_text("".join(json.dumps(row) + "\n" for row in rows))
