"""Independent CC0 Python implementation and maintenance fixtures."""
import json
from pathlib import Path
from textwrap import dedent

rows = []
def add(name, prompt, source, tests):
    rows.append(dict(id=name, license="CC0-1.0", prompt=dedent(prompt).strip(),
                     canonical_solution=dedent(source).strip(), tests=dedent(tests).strip()))

add("partial_write", """
    Implement write_all(write, data). write(memoryview_slice) returns how many bytes it consumed.
    Keep calling write on the remaining bytes until they are all written, then return the total.
    Never call write for empty data. Raise OSError if write returns zero, a negative number, or
    a count larger than the offered slice. Propagate any exception raised by write.
    """, """
    def write_all(write, data):
        remaining = memoryview(data)
        total = len(remaining)
        while remaining:
            written = write(remaining)
            if not 0 < written <= len(remaining):
                raise OSError("invalid write count")
            remaining = remaining[written:]
        return total
    """, """
    seen = []
    def writer(chunk):
        assert isinstance(chunk, memoryview)
        seen.append(bytes(chunk))
        return min(2, len(chunk))
    assert write_all(writer, b"abcdef") == 6
    assert seen == [b"abcdef", b"cdef", b"ef"]
    assert write_all(writer, b"") == 0 and len(seen) == 3
    try:
        write_all(lambda chunk: 0, b"a")
    except OSError:
        pass
    else:
        raise AssertionError("zero write accepted")
    """)

add("ordered_observations", """
    Implement attach_readings(sensors, latest). Return a list of new dictionaries with the fields
    of each sensor and a 'reading' field. sensors is an iterable of mappings containing 'sensor_id'.
    Use latest[sensor_id] when present; otherwise preserve the existing reading, using None when
    it is absent. A latest value of None or 0 must overwrite the old value. Preserve order.
    """, """
    def attach_readings(sensors, latest):
        return [dict(sensor, reading=latest.get(sensor["sensor_id"], sensor.get("reading"))) for sensor in sensors]
    """, """
    entries = [{"sensor_id":"b","reading":3},{"sensor_id":"a","reading":7},{"sensor_id":"c"},{"sensor_id":"d","reading":9}]
    rows = attach_readings(iter(entries), {"b":None,"a":0})
    assert rows == [{"sensor_id":"b","reading":None},{"sensor_id":"a","reading":0},
                    {"sensor_id":"c","reading":None},{"sensor_id":"d","reading":9}]
    assert entries[0]["reading"] == 3 and "reading" not in entries[2]
    """)

add("type_dispatch", """
    Implement coerce_field(value). For None return None. For bool return 'true' or 'false'.
    For str return the stripped string, including an empty string. For int or float return str(value).
    Raise TypeError for other objects. bool is a subclass of int, but must use the specified strings.
    """, """
    def coerce_field(value):
        if value is None:
            return None
        if isinstance(value, bool):
            return "true" if value else "false"
        if isinstance(value, str):
            return value.strip()
        if isinstance(value, (int, float)):
            return str(value)
        raise TypeError("unsupported field type")
    """, """
    items = [None, True, 0, False, 1.5, "   "," yes "]
    assert [coerce_field(x) for x in items] == [None,"true","0","false","1.5","","yes"]
    try:
        coerce_field([3])
    except TypeError:
        pass
    else:
        raise AssertionError("unsupported value accepted")
    """)

add("non_overlapping_spans", """
    Implement total_coverage(spans) for half-open integer spans (start, end).
    Return the number of covered integer positions across unsorted spans without double counting.
    Ignore empty spans. Raise ValueError for any end below start. Accept a one-pass iterable.
    """, """
    def total_coverage(spans):
        intervals = []
        for start, end in spans:
            if end < start:
                raise ValueError("reversed span")
            if end > start:
                intervals.append((start, end))
        total = 0
        previous_end = None
        for start, end in sorted(intervals):
            if previous_end is None or start > previous_end:
                total += end - start
                previous_end = end
            elif end > previous_end:
                total += end - previous_end
                previous_end = end
        return total
    """, """
    assert total_coverage(iter([(6,10),(1,4),(-4,-2),(3,7),(8,8),(2,3)])) == 11
    assert total_coverage([(8,8)]) == 0
    try:
        total_coverage([(9,1)])
    except ValueError:
        pass
    else:
        raise AssertionError("reversed interval accepted")
    """)

add("cache_expiry", """
    Implement ttl_lookup(cache, key, now, fetch, ttl). A cache entry is (expires_at, value).
    Return the cached value if expires_at is strictly greater than now, even if value is None.
    Otherwise fetch(key), store (now + ttl, result) and return result. If fetch raises, leave
    the cache with its original entries and propagate the error.
    """, """
    def ttl_lookup(cache, key, now, fetch, ttl):
        entry = cache.get(key)
        if entry is not None and entry[0] > now:
            return entry[1]
        result = fetch(key)
        cache[key] = (now + ttl, result)
        return result
    """, """
    cache = {"a":(5,None),"b":(1,"old")}
    def fail(key):
        raise RuntimeError(key)
    assert ttl_lookup(cache, "a", 4, fail, 2) is None
    try:
        ttl_lookup(cache, "b", 1, fail, 2)
    except RuntimeError:
        assert cache["b"] == (1,"old")
    else:
        raise AssertionError("expired entry reused")
    assert ttl_lookup(cache, "a", 5, lambda key: 0, 2) == 0
    assert cache["a"] == (7,0)
    """)

add("path_manifest", """
    Implement select_manifest(root). Return a sorted list of relative POSIX path strings for
    files ending in exactly '.manifest' under root. Skip paths containing any dot-prefixed
    component relative to root. A directory ending in '.manifest' is not itself a result.
    """, """
    from pathlib import Path

    def select_manifest(root):
        base = Path(root)
        paths = []
        for path in base.rglob("*.manifest"):
            relative = path.relative_to(base)
            if path.is_file() and all(not part.startswith(".") for part in relative.parts):
                paths.append(relative.as_posix())
        return sorted(paths)
    """, """
    from pathlib import Path
    from tempfile import TemporaryDirectory
    with TemporaryDirectory() as temp:
        base = Path(temp)
        for name in ("nested", ".state", "a.manifest"):
            (base / name).mkdir()
        for name in ("z.manifest","nested/a.manifest",".private.manifest",".state/hidden.manifest","UP.MANIFEST"):
            (base / name).touch()
        assert select_manifest(temp) == ["nested/a.manifest","z.manifest"]
    """)

add("bounded_unique", """
    Implement first_unique(values, count), returning the first count distinct hashable objects
    in encounter order. Stop immediately once that many distinct objects are found. Return all
    distinct values if the iterable ends first. Return [] without iterating when count <= 0.
    """, """
    def first_unique(values, count):
        if count <= 0:
            return []
        seen = set()
        result = []
        for value in values:
            if value not in seen:
                seen.add(value)
                result.append(value)
                if len(result) == count:
                    break
        return result
    """, """
    def data():
        yield "b"
        yield "b"
        yield None
        raise AssertionError("overconsumed")
    assert first_unique(data(), 2) == ["b",None]
    assert first_unique(data(), 0) == []
    assert first_unique(iter([2,1,2]), 9) == [2,1]
    """)

add("byte_frame", """
    Implement encode_frame(payload), accepting a bytes object. Return its length as exactly two
    unsigned big-endian bytes, followed by the unchanged payload. Raise ValueError if the length
    does not fit in two bytes.
    """, """
    def encode_frame(payload):
        length = len(payload)
        if length > 65_535:
            raise ValueError("payload too large")
        return length.to_bytes(2, "big") + payload
    """, """
    assert encode_frame(b"") == bytes([0,0])
    assert encode_frame(b"a"*258) == bytes([1,2]) + b"a"*258
    try:
        encode_frame(b"z"*65536)
    except ValueError:
        pass
    else:
        raise AssertionError("oversize frame accepted")
    """)

add("duration_value", """
    Implement wait_microseconds(start, end) for two aware or two naive datetime objects.
    Return elapsed whole microseconds as an exact integer, including when negative and when
    the duration spans days. Use normal datetime subtraction and let it reject incompatible
    inputs. Avoid floating-point conversion.
    """, """
    def wait_microseconds(start, end):
        delta = end - start
        return (delta.days * 86_400 + delta.seconds) * 1_000_000 + delta.microseconds
    """, """
    from datetime import datetime, timedelta
    ref = datetime(2000,1,1)
    assert wait_microseconds(ref, ref - timedelta(microseconds=1)) == -1
    assert wait_microseconds(ref, ref + timedelta(days=2, seconds=1, microseconds=3)) == 172801000003
    far = ref + timedelta(days=2000000, microseconds=9)
    assert wait_microseconds(ref, far) == 2000000*86400*1000000 + 9
    """)

add("nested_context", """
    Implement capture_append(target) as a context manager that yields target. If the with block
    raises, truncate items appended since entry and re-raise the exception. On success leave the
    list alone. Existing elements will not be changed by the with block. Support nested uses.
    """, """
    from contextlib import contextmanager

    @contextmanager
    def capture_append(target):
        original_length = len(target)
        try:
            yield target
        except BaseException:
            del target[original_length:]
            raise
    """, """
    history = ["old"]
    with capture_append(history) as group:
        assert group is history
        history.append("outer")
        try:
            with capture_append(history):
                history.append("discard")
                raise RuntimeError("cancel")
        except RuntimeError:
            assert history == ["old","outer"]
        history.append("new")
    assert history == ["old","outer","new"]
    """)

add("select_rows", """
    Implement find_matches(records, columns, needle). Yield original record dictionaries if
    at least one listed field is a string containing needle, case-insensitively. Both arguments
    records and columns may be generators. Skip missing or non-string fields. Keep results lazy
    and yield each matching record only once.
    """, """
    def find_matches(records, columns, needle):
        fields = tuple(columns)
        term = needle.casefold()
        for record in records:
            for field in fields:
                value = record.get(field)
                if isinstance(value, str) and term in value.casefold():
                    yield record
                    break
    """, """
    left = {"notes":"Straße","title":"STRASSE"}
    right = {"notes":None,"title":"Strasse section"}
    empty = {"other":"Straße","title":33}
    assert list(find_matches(iter([left,right,empty]), iter(["notes","title"]), "strasse")) == [left,right]
    def source():
        yield left
        raise AssertionError("read eagerly")
    assert next(find_matches(source(), ["notes"], "STRASSE")) is left
    """)

add("guarded_quantities", """
    Implement pad_rows(rows, width, fill=None) yielding new lists of exactly width elements.
    Accept rows containing arbitrary iterables. Pad short inputs with fill and truncate long
    inputs. Never consume more than width elements of any row. Raise ValueError for negative width.
    """, """
    from itertools import islice

    def pad_rows(rows, width, fill=None):
        if width < 0:
            raise ValueError("negative width")
        for row in rows:
            items = list(islice(row, width))
            yield items + [fill] * (width-len(items))
    """, """
    def row():
        yield "left"
        yield "right"
        raise AssertionError("overconsumed row")
    assert list(pad_rows(iter([row(), [3], []]), 2, 0)) == [["left","right"],[3,0],[0,0]]
    assert list(pad_rows([row()], 0)) == [[]]
    """)

Path(__file__).with_name("fresh.jsonl").write_text("".join(json.dumps(row) + "\n" for row in rows))
