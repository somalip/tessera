const assert = require("node:assert/strict");
const { test } = require("node:test");
const { LlamaClient } = require("../dist/host/client");

test("chat decodes split UTF-8 SSE chunks and respects the output token budget", async t => {
  const events = Buffer.from('data: {"choices":[{"delta":{"content":"café"}}]}\n\ndata: [DONE]\n\n');
  const split = events.indexOf(Buffer.from("é")) + 1;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "http://127.0.0.1:1234/v1/chat/completions");
    assert.equal(JSON.parse(options.body).max_tokens, 64);
    assert.equal(options.headers.Authorization, "Bearer key");
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(events.subarray(0, split));
        controller.enqueue(events.subarray(split));
        controller.close();
      },
    });
    return new Response(body);
  });
  const client = new LlamaClient("http://127.0.0.1:1234", "key", 256);
  const parts = [];
  for await (const part of client.chat([{ role: "user", content: "Hello" }], new AbortController().signal)) {
    parts.push(part);
  }
  assert.deepEqual(parts, ["café"]);
});
