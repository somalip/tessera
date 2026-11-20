const assert = require("node:assert/strict");
const { test } = require("node:test");
const { LocalMetrics } = require("../dist/telemetry");

test("only issued suggestion IDs count once and exports aggregate values", () => {
  const metrics = new LocalMetrics();
  const accepted = metrics.record(50, 70);
  metrics.record(70.5, 100);
  metrics.accept("unknown");
  metrics.accept(accepted);
  metrics.accept(accepted);
  assert.deepEqual(metrics.export(), {
    schema_version: 1, offered: 2, accepted: 1, acceptance_rate: 0.5,
    first_token_p95_ms: 71, completed_request_p95_ms: 100,
  });
});

test("session usage counts completed requests even without token metadata", () => {
  const metrics = new LocalMetrics();
  metrics.recordInference("chat", {});
  assert.equal(metrics.usage().outputTokens, null);
  metrics.recordInference("inline", { outputTokens: 8, tokensPerSecond: 16 });
  metrics.recordInference("chat", { outputTokens: 2 });
  const { requests, outputTokens, latestSpeed, mostUsed } = metrics.usage();
  assert.equal(requests, 3);
  assert.equal(outputTokens, 10);
  assert.deepEqual(latestSpeed, { model: "inline", tokensPerSecond: 16 });
  assert.deepEqual(mostUsed, { model: "chat", requests: 2 });
});

test("dashboard displays session usage and adds latency in Advanced mode", () => {
  const { renderDashboard } = require("../dist/views/dashboardHtml");
  const groups = { routing: [], editor: [], models: [], tools: [] };
  const metrics = new LocalMetrics();
  const render = advanced => renderDashboard({ trusted: true, advanced, models: [], usage: metrics.usage() }, groups);

  assert.match(render(false), /Usage appears after your first completed model request/);
  metrics.recordInference("python<&>", {});
  assert.match(render(false), /Latest reported speed<\/dt><dd>Unavailable/);
  metrics.recordInference("python<&>", { outputTokens: 20, tokensPerSecond: 10 });
  metrics.accept(metrics.record(50, 120));
  const simple = render(false);
  assert.match(simple, /10 tok\/s · python&lt;&amp;&gt;/);
  assert.match(simple, /Most-used model<\/dt><dd>python&lt;&amp;&gt; · 2 requests/);
  assert.match(simple, /Reported output tokens<\/dt><dd>20/);
  assert.match(simple, /100% \(1 \/ 1\)/);
  assert.doesNotMatch(simple, /Inline first token/);
  assert.match(render(true), /Inline first token \(p95\)<\/dt><dd>50 ms/);
});
