"""Build verified chat, repair and infill supervision from original CC0 examples."""
import ast
import copy
import json
from pathlib import Path

from data.pipelines.filtering import Contamination, tokens
from train.stages.examples import Supervision
from verifiers.python.runner import verify

ROOT = Path(__file__).resolve().parent
PREVIOUS = ROOT.parent / "python-v2"
FIRST = ROOT.parent / "python-local"
BENCHMARKS = [
    Path("/private/tmp/tessera-model/HumanEval.jsonl.gz"),
    FIRST / "heldout.jsonl",
    PREVIOUS / "heldout.jsonl",
    PREVIOUS / "fim.jsonl",
]

OPERATORS = {
    ast.Lt: ast.LtE, ast.LtE: ast.Lt, ast.Gt: ast.GtE, ast.GtE: ast.Gt,
    ast.Eq: ast.NotEq, ast.NotEq: ast.Eq, ast.Is: ast.IsNot, ast.IsNot: ast.Is,
    ast.In: ast.NotIn, ast.NotIn: ast.In, ast.Add: ast.Sub, ast.Sub: ast.Add,
    ast.Mult: ast.FloorDiv, ast.And: ast.Or, ast.Or: ast.And,
}

def mutate(source):
    tree = ast.parse(source)
    nodes = list(ast.walk(tree))
    for index, node in enumerate(nodes):
        if type(node) not in OPERATORS:
            continue
        changed = copy.deepcopy(tree)
        old = list(ast.walk(changed))[index]
        new = OPERATORS[type(node)]()
        for parent in ast.walk(changed):
            for name, value in ast.iter_fields(parent):
                if value is old:
                    setattr(parent, name, new)
                if isinstance(value, list):
                    for slot, entry in enumerate(value):
                        if entry is old:
                            value[slot] = new
        yield ast.unparse(changed)

def keep(row, contamination):
    content = "\n".join(row[key] for key in ("prompt", "solution", "tests"))
    return not contamination.overlaps(content, tokens(content))

def main():
    source = Supervision(PREVIOUS / "supervised-filtered.jsonl", BENCHMARKS, "docker", "python")
    rows = source.rows
    examples = list(source.teacher())
    if len(examples) != len(rows):
        raise ValueError("A baseline training reference failed verification")
    contamination = Contamination(BENCHMARKS)
    compiled = []
    for row in rows:
        compiled.append(dict(row, format="chat"))
        for candidate in mutate(row["solution"]):
            if verify(candidate, row["tests"]).passed:
                continue
            repair = dict(row, id=row["id"] + "-repair", format="chat",
                          prompt="Correct this implementation.\n\n" + row["prompt"] + "\n\n" + candidate)
            if keep(repair, contamination):
                compiled.append(repair)
                break
        solution = row["solution"]
        source_lines = solution.splitlines(keepends=True)
        nodes = ast.parse(solution).body
        function = next((node for node in nodes if isinstance(node, ast.FunctionDef)), None)
        if function is not None and function.body[0].lineno > function.lineno:
            body_start = function.body[0].lineno - 1
            prefix = "".join(source_lines[:body_start]) + "    " + repr(row["prompt"]) + "\n"
            continuation = dict(row, id=row["id"] + "-completion", format="raw",
                                prompt=prefix, solution="".join(source_lines[body_start:]))
            if keep(continuation, contamination) and verify(prefix + continuation["solution"], row["tests"]).passed:
                compiled.append(continuation)
        for line in solution.splitlines():
            if line.lstrip().startswith("return ") and len(line.strip()) > len("return "):
                prefix, target, suffix = solution.partition(line)
                indent = line[:len(line) - len(line.lstrip())]
                infill = dict(row, id=row["id"] + "-infill", format="fim",
                              prompt=prefix + indent + "return ", solution=target.strip()[7:], suffix=suffix)
                rebuilt = infill["prompt"] + infill["solution"] + infill["suffix"]
                if rebuilt == solution and keep(dict(infill, solution=rebuilt), contamination):
                    compiled.append(infill)
                break

    repairs = sum(row["id"].endswith("-repair") for row in compiled)
    infills = sum(row["format"] == "fim" for row in compiled)
    print(f"{len(rows)} chat references, {repairs} test-rejected buggy inputs, {infills} infill targets", flush=True)
    if not repairs or not infills:
        raise ValueError("Insufficient verified repair and infill coverage")
    (ROOT / "supervised.jsonl").write_text("".join(json.dumps(row) + "\n" for row in compiled))

if __name__ == "__main__":
    main()
