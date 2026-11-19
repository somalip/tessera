"""Run candidate code only inside preinstalled, isolated Docker images."""
import subprocess
import uuid
from dataclasses import dataclass


@dataclass(frozen=True)
class Outcome:
    passed: bool
    returncode: int
    timed_out: bool = False


class VerifierError(RuntimeError):
    pass


def run_container(image: str, command: list[str], source: str,
                  timeout: float = 15, docker: str = "docker") -> Outcome:
    name = f"tinycoders-{uuid.uuid4().hex}"
    args = [
        docker, "run", "--rm", "--pull=never", "--name", name, "--interactive",
        "--network=none", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m",
        "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user=65534:65534",
        "--memory=512m", "--memory-swap=512m", "--pids-limit=64", "--cpus=1",
        "--ulimit", "nofile=128:128", "--workdir", "/tmp", image, *command,
    ]
    try:
        result = subprocess.run(args, input=source.encode(), stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        try:
            cleanup = subprocess.run([docker, "rm", "-f", name], timeout=10, check=False,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise VerifierError(f"Could not clean up sandbox {name}") from error
        if cleanup.returncode:
            raise VerifierError(f"Could not confirm sandbox cleanup for {name}")
        return Outcome(False, 124, timed_out=True)
    except OSError as error:
        raise VerifierError(f"Could not launch the Docker client: {error}") from error
    if result.returncode in (125, 126, 127):
        raise VerifierError(f"Docker run failed ({result.returncode}); check daemon, image, and command")
    return Outcome(result.returncode == 0, result.returncode)
