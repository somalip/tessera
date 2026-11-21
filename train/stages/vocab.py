"""Measure and optionally trim trailing, unassigned vocabulary rows."""

from typing import Any


def experiment(model: Any, tokenizer: Any, trim: bool) -> dict[str, int | bool]:
    configured = model.config.vocab_size
    required = max(tokenizer.get_vocab().values()) + 1
    if required > configured:
        raise ValueError("Tokenizer vocabulary exceeds model embeddings")
    if trim and required < configured:
        model.resize_token_embeddings(required, mean_resizing=False)
    return {
        "original_rows": configured,
        "required_rows": required,
        "trimmed": trim and required < configured,
        "potential_4bit_bytes_saved": (configured - required)
        * model.config.hidden_size
        // 2,
    }
