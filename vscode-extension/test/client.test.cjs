const assert = require("node:assert/strict");
const { test } = require("node:test");
const { LlamaClient } = require("../dist/host/client");

test("chat decodes split UTF-8 SSE chunks and respects the output token budget", async t => {
  const events = Buffer.from('data: {"choices":[{"delta":{"content":"café"}}]}\n\n' +
    'data: {"choices":[],"timings":{"predicted_per_second":12.5}}\n\n' +
    'data: {"choices":[],"usage":{"completion_tokens":3}}\n\ndata: [DONE]\n\n');
  const split = events.indexOf(Buffer.from("é")) + 1;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "http://127.0.0.1:1234/v1/chat/completions");
    assert.equal(JSON.parse(options.body).max_tokens, 64);
    assert.deepEqual(JSON.parse(options.body).stream_options, { include_usage: true });
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
  const usage = [];
  const client = new LlamaClient("http://127.0.0.1:1234", "key", 256, sample => usage.push(sample));
  const parts = [];
  for await (const part of client.chat([{ role: "user", content: "Hello" }], new AbortController().signal)) {
    parts.push(part);
  }
  assert.deepEqual(parts, ["café"]);
  assert.deepEqual(usage, [{ outputTokens: 3, tokensPerSecond: 12.5 }]);
});

test("inline code generation rejects streams that hit the token limit", async t => {
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.max_tokens, 1536);
    assert.equal(body.chat_template_kwargs.enable_thinking, false);
    return new Response('data: {"choices":[{"delta":{"content":"partial code"}}]}\n\n' +
      'data: {"choices":[{"finish_reason":"length"}]}\n\ndata: [DONE]\n\n');
  });
  const client = new LlamaClient("http://127.0.0.1:1234", "key", 2048);
  await assert.rejects(async () => {
    for await (const part of client.chat([{ role: "user", content: "Build a game" }],
      new AbortController().signal, 1536)) {
      assert.equal(part, "partial code");
    }
  }, /did not finish/);
});

test("completion reads token counts and speed from a JSON response", async t => {
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body).stream_options, { include_usage: true });
    return Response.json({
      choices: [{ text: "return 42" }],
      timings: { predicted_n: 4, predicted_per_second: 20 },
    });
  });
  const usage = [];
  const client = new LlamaClient("http://127.0.0.1:1234", "key", 256, sample => usage.push(sample));
  assert.equal(await client.complete("prompt", [], new AbortController().signal), "return 42");
  assert.deepEqual(usage, [{ outputTokens: 4, tokensPerSecond: 20 }]);
});
