"""Python candidate verifier."""
from verifiers.sandbox import Outcome, run_container

IMAGE = "python:3.12.12-slim"


def verify(source: str, tests: str, timeout: float = 15, docker: str = "docker") -> Outcome:
    return run_container(IMAGE, ["python", "-I", "-B", "-"], f"{source}\n\n{tests}\n",
                         timeout=timeout, docker=docker)
