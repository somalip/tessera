"""Install pinned verifier toolchains before an offline evaluation run."""
import argparse
import subprocess
from pathlib import Path

from verifiers.compiled import COMPILERS, LANGUAGES
from verifiers.python.runner import IMAGE


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("language", choices=(*LANGUAGES, "all"))
    parser.add_argument("--docker", default="docker")
    args = parser.parse_args()
    targets = LANGUAGES if args.language == "all" else (args.language,)
    images = set()
    for language in targets:
        if language == "typescript":
            subprocess.run([args.docker, "build", "--tag", COMPILERS[language][0],
                            str(Path(__file__).with_name("typescript"))], check=True)
        else:
            image = IMAGE if language == "python" else COMPILERS[language][0]
            if image not in images:
                subprocess.run([args.docker, "pull", image], check=True)
                images.add(image)


if __name__ == "__main__":
    main()
