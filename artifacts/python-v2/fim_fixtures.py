import json
from pathlib import Path

def row(name, prefix, middle, suffix, tests):
    return dict(id=name, license="CC0-1.0", prompt=prefix, expected=middle, suffix=suffix, tests=tests)

rows = [
    row("region_normalization",
        'def normalize_region(value):\n    """Use casefold after stripping whitespace."""\n    return ',
        'value.strip().casefold()', '\n\nREGION_UNKNOWN = "unknown"\n',
        'assert normalize_region("  STRAẞE  ") == "strasse"'),
    row("factory_call",
        "def read_limit(config, default=20):\n    # Use default only when the key is missing.\n    return ",
        'config.get("limit", default)', "\n\ndef get_mode(config):\n    return config.get('mode', 'local')\n",
        'assert read_limit({"limit":0}) == 0\nassert read_limit({}, 5) == 5'),
    row("frozen_timestamp",
        "from datetime import datetime\n\ndef format_day(stamp: datetime) -> str:\n    # Use the YYYY-MM-DD ISO representation of the date only.\n    return ",
        "stamp.date().isoformat()", "\n\n__all__ = ['format_day']\n",
        'assert format_day(datetime(2025, 8, 9, 12, 13)) == "2025-08-09"'),
    row("integer_chunks",
        "def required_pages(total, size):\n    if size <= 0:\n        raise ValueError('size must be positive')\n    # Compute ceiling division using integer arithmetic.\n    return ",
        "(total + size - 1) // size", "\n\nFIRST_PAGE = 1\n",
        "assert required_pages(0, 5) == 0\nassert required_pages(11, 5) == 3\nassert required_pages(10**24+1, 10) == 10**23+1"),
]
Path(__file__).with_name("fim.jsonl").write_text("".join(json.dumps(row) + "\n" for row in rows))
