"""Fixed offline compile and test commands for language verifiers."""
from collections.abc import Callable
from functools import partial

from verifiers.python.runner import verify as verify_python
from verifiers.sandbox import Outcome, run_container

COMPILERS = {
    "typescript": (
        "tessera-verifier-typescript:5.9.3",
        "cat > main.ts; tsc --strict --target ES2022 --module commonjs main.ts; node main.js",
    ),
    "rust": (
        "rust:1.90.0-slim-bookworm@sha256:64232e656c058f4468e8d024e990acff04f0fd5a5c0a88a574dc37773d7325c9",
        "cat > main.rs; rustc --edition=2021 main.rs -o /tmp/program; /tmp/program",
    ),
    "go": (
        "golang:1.25.3-bookworm@sha256:4f43b271f9673eb7bd0cb3a49cc17b08d8d6ee110277e26dbacc93c43a5a7793",
        "cat > main.go; GOTOOLCHAIN=local GOMAXPROCS=1 GOPATH=/tmp/go GOCACHE=/tmp/cache "
        "GO111MODULE=off go run main.go",
    ),
    "java": (
        "eclipse-temurin:21.0.9_10-jdk-noble"
        "@sha256:f3f6ba56a9ab68c1e99310d3b06bd1279ed03db00c581d8e22bb2e65d6ce8fa4",
        "cat > Main.java; javac -J-Xmx128m Main.java; java -XX:ActiveProcessorCount=1 -Xmx128m Main",
    ),
    "c": (
        "gcc:15.2.0-bookworm@sha256:9ca91b05c7b07d2979f16413e8b2cd6ec8a7c80ffca4121ccab0aeba33f90460",
        "cat > main.c; gcc -std=c17 -O0 -Wall -Wextra main.c -lm -o /tmp/program; /tmp/program",
    ),
    "cpp": (
        "gcc:15.2.0-bookworm@sha256:9ca91b05c7b07d2979f16413e8b2cd6ec8a7c80ffca4121ccab0aeba33f90460",
        "cat > main.cpp; g++ -std=c++20 -O0 -Wall -Wextra main.cpp -o /tmp/program; /tmp/program",
    ),
}
LANGUAGES = ("python", *COMPILERS)


def verify_compiled(language: str, source: str, tests: str,
                    timeout: float = 45, docker: str = "docker") -> Outcome:
    image, script = COMPILERS[language]
    return run_container(image, ["/bin/sh", "-ec", script], f"{source}\n\n{tests}\n",
                         timeout=timeout, docker=docker, executable_scratch=True)


def verifier(language: str, docker: str = "docker") -> Callable[[str, str], Outcome]:
    if language == "python":
        return partial(verify_python, docker=docker)
    if language not in COMPILERS:
        raise ValueError(f"Unsupported verifier language: {language}")
    return partial(verify_compiled, language, docker=docker)
