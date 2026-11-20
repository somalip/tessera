const assert = require("node:assert/strict");
const { test } = require("node:test");
const { repositoryFiles, repositoryFromInput, searchRepositories } = require("../dist/registry/huggingFace");

test("Hugging Face discovery accepts repository IDs and rejects URLs outside model repositories", () => {
  assert.deepEqual(repositoryFromInput("Qwen/Qwen3-0.6B-GGUF"), { repository: "Qwen/Qwen3-0.6B-GGUF" });
  assert.deepEqual(repositoryFromInput("https://huggingface.co/Qwen/Qwen3-0.6B-GGUF"), { repository: "Qwen/Qwen3-0.6B-GGUF" });
  assert.deepEqual(repositoryFromInput("https://huggingface.co/author/model/blob/main/files/small%20model.gguf"), {
    repository: "author/model", revision: "main", file: "files/small model.gguf",
  });
  assert.equal(repositoryFromInput("small coding model"), undefined);
  assert.throws(() => repositoryFromInput("https://example.com/publisher/model"), /repository URL/);
  assert.throws(() => repositoryFromInput("https://huggingface.co/datasets/publisher/model"), /repository URL/);
});

test("Hugging Face search filters public repositories and resolves only pinned single-file GGUFs", async t => {
  const sha = "1".repeat(40);
  const digest = "a".repeat(64);
  const file = (rfilename, size, sha256 = digest) => ({ rfilename, size, lfs: { sha256, size } });
  let data = [{ id: "author/small" }, { id: "author/gated", gated: "manual" }, { id: "../../wrong" }];
  t.mock.method(globalThis, "fetch", async url => {
    assert.equal(url.origin, "https://huggingface.co");
    if (url.pathname === "/api/models") assert.equal(url.searchParams.get("filter"), "gguf");
    else assert.equal(url.searchParams.get("blobs"), "true");
    return Response.json(data);
  });
  assert.deepEqual(await searchRepositories("small"), ["author/small"]);
  data = {
    sha, gated: false, private: false, pipeline_tag: "text-generation", cardData: { license: "apache-2.0" },
    gguf: { architecture: "llama", context_length: 8192, total: 360000000 },
    siblings: [
      file("files/small chat.Q4_K_M.gguf", 270000000),
      file("too-big.gguf", 1000000000), file("broken.gguf", 1024, "short"),
      file("small-00001-of-00002.gguf", 300000000), file("mmproj.gguf", 400000000),
      file("../escape.gguf", 1024), { rfilename: "missing-hash.gguf", size: 1024 },
    ],
  };
  const [match, ...rest] = await repositoryFiles("author/small");
  assert.deepEqual(rest, []);
  assert.equal(match.entry.url, `https://huggingface.co/author/small/resolve/${sha}/files/small%20chat.Q4_K_M.gguf`);
  assert.equal(match.entry.sha256, digest);
  assert.equal(match.entry.upstreamManifest.context_length, 4096);
  assert.deepEqual(match.entry.upstreamManifest.capabilities, ["chat", "edit"]);
  assert.deepEqual((await repositoryFiles("author/Qwen2.5-Coder-GGUF"))[0].entry.upstreamManifest.capabilities, ["fim"]);
  data.gated = "manual";
  await assert.rejects(repositoryFiles("author/small"), /without signing in/);
  data.gated = false;
  delete data.cardData.license;
  await assert.rejects(repositoryFiles("author/small"), /declare a model license/);
});
