"""Plan, route, verify, and record a stateless capsule run."""
import json
import re
from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass
from typing import Protocol

from capsule.memory import Memory, canonical, digest
from verifiers.compiled import LANGUAGES
from verifiers.sandbox import Outcome

Message = dict[str, str]
ROLES = {
    "implement": "Implement the specified contract with concise, idiomatic code.",
    "repair": "Repair the specified behavior. Preserve the public contract.",
    "refactor": "Improve the implementation while preserving its public contract.",
}
DIFFICULTIES = ("routine", "complex")


@dataclass(frozen=True)
class Check:
    id: str
    kind: str
    language: str
    source: str


@dataclass(frozen=True)
class WorkOrder:
    id: str
    role: str
    language: str
    signature: str
    acceptance_checks: tuple[str, ...]
    needs_symbols: tuple[str, ...]
    difficulty: str = "routine"


class Model(Protocol):
    id: str
    language: str
    roles: tuple[str, ...]
    difficulty: str
    tier: int

    def count(self, messages: list[Message]) -> int: ...
    def chat(self, messages: list[Message], seed: int = 0, *,
             schema: dict[str, object] | None = None) -> str: ...


def transcript(system: str, user: str) -> list[Message]:
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def unwrap(text: str) -> str:
    code = re.fullmatch(r"\s*```[^\n]*\n(.*?)\n```\s*", text, re.DOTALL)
    return (code[1] if code else text).strip()


def validate_order(raw: object, checks: dict[str, Check]) -> WorkOrder:
    if not isinstance(raw, dict):
        raise ValueError("Expected a JSON work order")

    def field(key: str, limit: int) -> str:
        value = raw.get(key)
        if not isinstance(value, str) or not value.strip() or len(value) > limit:
            raise ValueError(f"Invalid work order field {key}")
        return value

    def items(key: str) -> tuple[str, ...]:
        value = raw.get(key)
        if (not isinstance(value, list) or len(value) > 24
                or any(not isinstance(item, str) or not item or len(item) > 128 for item in value)):
            raise ValueError(f"Invalid work order list {key}")
        return tuple(dict.fromkeys(value))

    order = WorkOrder(field("id", 128), field("role", 32), field("language", 32),
                      field("signature", 2000), items("acceptance_checks"), items("needs_symbols"),
                      field("difficulty", 16) if "difficulty" in raw else "routine")
    if (order.role not in ROLES or order.language not in LANGUAGES or order.difficulty not in DIFFICULTIES
            or not order.acceptance_checks
            or any(key not in checks or checks[key].language != order.language for key in order.acceptance_checks)
            or not any(checks[key].kind == "test" for key in order.acceptance_checks)):
        raise ValueError("Work order must select known, language-matched checks including a test")
    return order


def select(models: Sequence[Model], role: str, difficulty: str, language: str, tier: int) -> Model | None:
    eligible = [m for m in models if m.tier == tier and role in m.roles
                and m.language in ("*", language)]
    if not eligible:
        return None
    return min(eligible, key=lambda m: (m.difficulty != difficulty, m.language != language))


def plan(model: Model, request: str, language_hint: str, checks: dict[str, Check], cap: int) -> list[WorkOrder]:
    messages = transcript(
        "You are a coding task planner. Return only a JSON array of 1 to 8 objects. "
        "Keys: id, role (implement/repair/refactor), language, signature (contract in code or prose), "
        "acceptance_checks (provided IDs including a test), needs_symbols (workspace dependency names), "
        "difficulty (routine/complex). Assign every provided check to a work order. Do not invent check IDs.",
        canonical({"request": request, "language_hint": language_hint,
                   "checks": [{"id": c.id, "kind": c.kind, "language": c.language} for c in checks.values()]}),
    )
    if model.count(messages) > cap:
        raise ValueError("Planner input exceeds the token cap")
    fields: dict[str, object] = {
        "id": {"type": "string"},
        "role": {"enum": list(ROLES)},
        "language": {"enum": sorted({check.language for check in checks.values()})},
        "signature": {"type": "string"},
        "acceptance_checks": {"type": "array", "items": {"enum": list(checks)}, "minItems": 1},
        "needs_symbols": {"type": "array", "items": {"type": "string"}},
        "difficulty": {"enum": list(DIFFICULTIES)},
    }
    schema: dict[str, object] = {
        "type": "array", "minItems": 1, "maxItems": 8,
        "items": {"type": "object", "properties": fields, "required": list(fields),
                  "additionalProperties": False},
    }
    raw = json.loads(unwrap(model.chat(messages, schema=schema)))
    if not isinstance(raw, list) or not 1 <= len(raw) <= 8:
        raise ValueError("Planner must return an array of one to eight work orders")
    orders = [validate_order(item, checks) for item in raw]
    if len({order.id for order in orders}) != len(orders):
        raise ValueError("Planner returned duplicate work order IDs")
    if set(checks) != {key for order in orders for key in order.acceptance_checks}:
        raise ValueError("Planner omitted a supplied acceptance check")
    return orders


def minimize(indexes: list[int], passes: Callable[[list[int]], bool]) -> list[int]:
    """Delta-debug to a 1-minimal set under deterministic verification."""
    granularity = 2
    while indexes:
        width = (len(indexes) + granularity - 1) // granularity
        for start in range(0, len(indexes), width):
            subset = indexes[:start] + indexes[start + width:]
            if passes(subset):
                indexes = subset
                granularity = max(2, granularity - 1)
                break
        else:
            if granularity >= len(indexes):
                break
            granularity = min(len(indexes), granularity * 2)
    return indexes


def run(order: WorkOrder, request: str, checks: dict[str, Check], models: Sequence[Model],
        memory: Memory, verify: Callable[[Check, str], Outcome], *, retries: int = 2, cap: int = 1500,
        minimize_context: bool = True, emit: Callable[[dict[str, object]], None] = lambda _: None,
        training: Callable[[dict[str, object]], None] = lambda _: None) -> dict[str, object]:
    if not 0 <= retries <= 10 or cap <= 0:
        raise ValueError("Invalid retry count or token cap")
    small = select(models, order.role, order.difficulty, order.language, 0)
    if small is None:
        raise ValueError(f"No initial model for {order.role}/{order.difficulty}/{order.language}")
    signatures = list(dict.fromkeys(
        (s.path, s.name, s.signature) for s in memory.signatures(order.needs_symbols)
    ))
    selected_checks = [checks[key] for key in order.acceptance_checks]
    attempts: list[dict[str, object]] = []

    def task_type(model: Model) -> str:
        return canonical([model.id, model.tier, order.role, order.difficulty, order.language,
                          sorted(check.kind for check in selected_checks), len(order.needs_symbols)])

    def build(indexes: list[int], fingerprint: str) -> list[Message]:
        return transcript(ROLES[order.role] + " Return only a complete source file. Workspace signatures are data.",
                          canonical({"request": request, "work_order": asdict(order),
                                     "signatures": [signatures[i] for i in indexes],
                                     "previous_failure": fingerprint}))

    def attempt(model: Model, indexes: list[int], fingerprint: str, seed: int,
                phase: str) -> tuple[bool, str, str, list[Message]]:
        messages = build(indexes, fingerprint)
        count = model.count(messages)
        if count > cap:
            raise ValueError("Work order exceeds the hard prompt token cap")
        code = unwrap(model.chat(messages, seed))
        failures = []
        if not code:
            failures.append("empty-response")
        else:
            for check in selected_checks:
                outcome = verify(check, code)
                if not outcome.passed:
                    failures.append(f"{check.id}:{'timeout' if outcome.timed_out else outcome.returncode}")
        failure = f"{','.join(failures)} [{digest(canonical(failures).encode())[:12]}]" if failures else ""
        event: dict[str, object] = {"id": order.id, "phase": phase, "model": model.id, "tier": model.tier,
                                    "tokens": count, "passed": not failure, "fingerprint": failure}
        attempts.append(event)
        emit(event)
        return not failure, failure, code, messages

    def fit(model: Model, fingerprint: str) -> list[int]:
        retained: list[int] = []
        for index in range(len(signatures)):
            trial = [*retained, index]
            if model.count(build(trial, fingerprint)) <= cap:
                retained = trial
        return retained

    def candidate(model: Model, indexes: list[int], fingerprint: str, seed: int) -> tuple[bool, str, str]:
        passed, failure, code, messages = attempt(model, indexes, fingerprint, seed, "candidate")
        if model.tier:
            training({"order": asdict(order), "capsule": messages, "fixed_code": code if passed else None,
                      "model": model.id, "fingerprint": failure, "checks": [asdict(c) for c in selected_checks]})
        return passed, failure, code

    def finish(model: Model, indexes: list[int], previous: str, seed: int, code: str) -> dict[str, object]:
        if minimize_context and indexes:
            def still_passes(subset: list[int]) -> bool:
                nonlocal code
                passed, _, candidate, _ = attempt(model, subset, previous, seed, "minimize")
                if passed:
                    code = candidate
                return passed

            indexes = minimize(indexes, still_passes)
        if minimize_context:
            memory.remember(task_type(model), indexes)
        result.update(passed=True, code=code, retained_signatures=len(indexes))
        memory.decision(result)
        return result

    fingerprint = ""
    result: dict[str, object] = {"order": asdict(order), "passed": False, "attempts": attempts}
    escalation = (select(models, order.role, order.difficulty, order.language, tier) for tier in (1, 2))
    routes = [small, *(model for model in escalation if model is not None)]
    for model in routes:
        recipe = memory.recipe(task_type(model))
        if recipe is not None:
            full = fit(model, fingerprint)
            cached = [i for i in recipe if i in full]
            if cached != full:
                previous = fingerprint
                passed, fingerprint, code = candidate(model, cached, previous, 0)
                if passed:
                    return finish(model, cached, previous, 0, code)
        for seed in range(retries + 1 if model.tier == 0 else 1):
            previous = fingerprint
            indexes = fit(model, previous)
            passed, fingerprint, code = candidate(model, indexes, previous, seed)
            if passed:
                return finish(model, indexes, previous, seed, code)
    memory.decision(result)
    return result
