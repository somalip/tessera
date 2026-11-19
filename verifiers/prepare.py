"""Install pinned verifier toolchains before an offline evaluation run."""
import argparse
import subprocess
from pathlib import Path

from verifiers.compiled import COMPILERS, LANGUAGES
from verifiers.python.runner import IMAGE, QUALITY_IMAGE


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("language", choices=(*LANGUAGES, "python-quality", "all"))
    parser.add_argument("--docker", default="docker")
    args = parser.parse_args()
    targets = (*LANGUAGES, "python-quality") if args.language == "all" else (args.language,)
    images = set()
    for language in targets:
        if language == "python-quality":
            subprocess.run([args.docker, "build", "--tag", QUALITY_IMAGE,
                            str(Path(__file__).with_name("python") / "quality")], check=True)
        elif language == "typescript":
            subprocess.run([args.docker, "build", "--tag", COMPILERS[language][0],
                            str(Path(__file__).with_name("typescript"))], check=True)
        else:
            image = IMAGE if language == "python" else COMPILERS[language][0]
            if image not in images:
                subprocess.run([args.docker, "pull", image], check=True)
                images.add(image)


if __name__ == "__main__":
    main()
