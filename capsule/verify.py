"""Map trusted check IDs to fixed sandbox commands."""
from capsule.router import Check
from verifiers.compiled import COMPILERS, verifier
from verifiers.python.runner import QUALITY_IMAGE
from verifiers.sandbox import Outcome, run_container

TYPE_CHECKS = {
    "python": "cat > main.py; mypy --strict --cache-dir=/dev/null main.py",
    "typescript": "cat > main.ts; tsc --strict --target ES2022 --noEmit main.ts",
    "rust": "cat > main.rs; rustc --edition=2021 --emit=metadata main.rs",
    "go": "cat > main.go; GOTOOLCHAIN=local GOMAXPROCS=1 GOPATH=/tmp/go GOCACHE=/tmp/cache "
          "GO111MODULE=off go build main.go",
    "java": "cat > Main.java; javac -J-Xmx128m Main.java",
    "c": "cat > main.c; gcc -std=c17 -Wall -Wextra -fsyntax-only main.c",
    "cpp": "cat > main.cpp; g++ -std=c++20 -Wall -Wextra -fsyntax-only main.cpp",
}
LINT = {
    "python": "ruff check --isolated --no-cache --stdin-filename main.py -",
    "typescript": "cat > main.ts; tsc --strict --target ES2022 --noEmit "
                  "--noUnusedLocals --noUnusedParameters --noFallthroughCasesInSwitch main.ts",
    "c": "cat > main.c; gcc -std=c17 -Wall -Wextra -Werror -fsyntax-only main.c",
    "cpp": "cat > main.cpp; g++ -std=c++20 -Wall -Wextra -Werror -fsyntax-only main.cpp",
    "java": "cat > Main.java; javac -J-Xmx128m -Xlint:all -Werror Main.java",
    "rust": "cat > main.rs; rustc --edition=2021 --emit=metadata -D warnings main.rs",
    "go": "cat > main.go; test -z \"$(gofmt -l main.go)\"",
}


def supported(check: Check) -> bool:
    if check.kind == "test":
        return bool(check.source.strip()) and (check.language == "python" or check.language in COMPILERS)
    if check.kind == "typecheck":
        return check.language in TYPE_CHECKS
    return check.kind == "lint" and check.language in LINT


def verify(check: Check, code: str, docker: str = "docker") -> Outcome:
    if not supported(check):
        raise ValueError(f"Unsupported acceptance check: {check.id}")
    if check.kind == "test":
        return verifier(check.language, docker)(code, check.source)
    script = (TYPE_CHECKS if check.kind == "typecheck" else LINT)[check.language]
    image = QUALITY_IMAGE if check.language == "python" else COMPILERS[check.language][0]
    return run_container(image, ["/bin/sh", "-ec", script], code,
                         timeout=45, docker=docker)
