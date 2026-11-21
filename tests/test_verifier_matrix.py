import os
import unittest

from data.pipelines.grammars import parser_for
from train.config import load
from verifiers.compiled import COMPILERS, verifier, verify_compiled

POSITIVES = {
    "typescript": "const add = (x: number): number => x + 1; if (add(2) !== 3) throw Error();",
    "rust": "fn main() { assert_eq!(2 + 1, 3); }",
    "go": 'package main\nfunc main() { if 2 + 1 != 3 { panic("sum") } }',
    "java": "public class Main { public static void main(String[] args) { if (2 + 1 != 3) throw new Error(); } }",
    "c": "int main(void) { return 2 + 1 != 3; }",
    "cpp": "int main() { return 2 + 1 != 3; }",
}
LOOPS = {
    "typescript": "while (true) {}",
    "rust": "fn main() { loop {} }",
    "go": "package main\nfunc main() { for {} }",
    "java": "public class Main { public static void main(String[] args) { while (true) {} } }",
    "c": "int main(void) { for (;;) {} }",
    "cpp": "int main() { for (;;) {} }",
}


class VerifierMatrix(unittest.TestCase):
    def test_compiler_configuration_and_grammar(self) -> None:
        from pathlib import Path

        for language in COMPILERS:
            with self.subTest(language=language):
                self.assertFalse(
                    parser_for(language)
                    .parse(POSITIVES[language].encode())
                    .root_node.has_error
                )
                self.assertEqual(
                    load(Path(f"train/configs/{language}.yaml"))["language"], language
                )

    @unittest.skipUnless(
        os.environ.get("TESSERA_DOCKER_MATRIX"), "Docker matrix is opt-in"
    )
    def test_sandboxes_enforce_compilation_and_timeouts(self) -> None:
        docker = os.environ["TESSERA_DOCKER_MATRIX"]
        target = os.environ.get("TESSERA_VERIFIER_LANG")
        for language in COMPILERS:
            if target and target != language:
                continue
            with self.subTest(language=language):
                check = verifier(language, docker)
                self.assertTrue(check(POSITIVES[language], "").passed)
                self.assertFalse(check("not valid source, at all!", "").passed)
                timeout = 12 if language == "go" else 5
                self.assertTrue(
                    verify_compiled(
                        language, LOOPS[language], "", timeout=timeout, docker=docker
                    ).timed_out
                )
