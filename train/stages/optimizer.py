"""Run a bounded causal language modeling stage."""
import math
from collections.abc import Callable, Iterator
from typing import Any

Pair = tuple[list[int], list[int]]


def optimize(model: Any, torch: Any, batches: Callable[[], Iterator[Pair]], device: str,
             steps: int, accumulation: int, rate: float) -> dict[str, float | int]:
    if steps < 1 or accumulation < 1 or not math.isfinite(rate) or rate <= 0:
        raise ValueError("Training stages need positive steps, accumulation, and learning rate")
    model.train()
    optimizer = torch.optim.AdamW(model.parameters(), lr=rate)
    stream = batches()
    loss_sum = 0.0
    token_count = 0
    for _ in range(steps):
        optimizer.zero_grad(set_to_none=True)
        for _ in range(accumulation):
            pair = next(stream, None)
            if pair is None:
                stream = batches()
                pair = next(stream, None)
            if pair is None:
                raise ValueError("Training stage has no eligible examples")
            ids, labels = pair
            loss = model(input_ids=torch.tensor([ids], device=device),
                         labels=torch.tensor([labels], device=device), use_cache=False).loss
            if not torch.isfinite(loss).item():
                raise RuntimeError("Training loss is nonfinite")
            (loss / accumulation).backward()
            loss_sum += loss.item()
            token_count += len(ids)
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()
    return {"steps": steps, "tokens": token_count, "mean_loss": loss_sum / (steps * accumulation)}
