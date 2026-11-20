import json
import tempfile
import unittest
from pathlib import Path

from tokenizers import Tokenizer, models, pre_tokenizers  # type: ignore[import-untyped]

from data.pipelines.build import EOS, FIM, build
from data.pipelines.filtering import Dedupe, tokens


class CorpusTests(unittest.TestCase):
    def test_one_percent_sample_is_decontaminated_and_sharded(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            vocab = {token: index for index, token in enumerate(("[UNK]", *FIM, EOS))}
            tokenizer = Tokenizer(models.WordLevel(vocab, unk_token="[UNK]"))
            tokenizer.add_special_tokens([*FIM, EOS])
            tokenizer.pre_tokenizer = pre_tokenizers.Whitespace()
            tokenizer.save(str(root / "tokenizer.json"))
            blocked = "print(predict_heldout(current_target, previous_target + 9001))"
            (root / "eval.jsonl").write_text(json.dumps({"text": blocked}) + "\n")
            rows = []
            for index in range(6000):
                source = f"print({index})\n"
                license_id = "MIT"
                if index % 5 == 0:
                    source = blocked + "\n"
                elif index % 5 == 1:
                    license_id = "GPL-3.0-only"
                elif index % 5 == 2:
                    source = "def invalid(:"
                elif index % 5 == 3:
                    source = "print(90000)\n"
                rows.append(dict(repo="fixture", path=f"{index}.py", text=source, license=license_id))
            (root / "source.jsonl").write_text("".join(json.dumps(row) + "\n" for row in rows))
            stats = build(root / "source.jsonl", [root / "eval.jsonl"], root / "tokenizer.json",
                          root / "out", 0.01, 3, 42)
            self.assertEqual(stats["input"], 6000)
            for count in ("contamination", "license", "parse", "exact_duplicate", "accepted"):
                self.assertGreater(stats[count], 0)
            self.assertEqual(stats["accepted_overlap"], 0)
            shards = list((root / "out").glob("shard-*.jsonl"))
            self.assertEqual(len(shards), stats["shards"])
            accepted = [json.loads(line) for path in shards for line in path.read_text().splitlines()]
            self.assertEqual(len(accepted), stats["accepted"])
            self.assertTrue(all(row["license"] == "MIT" and row["input_ids"][-1] == vocab[EOS]
                                for row in accepted))

    def test_minhash_near_duplicate(self) -> None:
        dedupe = Dedupe()
        source = "\n".join(f"variable{i} = {i}" for i in range(50))
        self.assertIsNone(dedupe.seen(tokens(source)))
        self.assertEqual(dedupe.seen(tokens(source.replace("variable20", "replacement"))),
                         "near_duplicate")
