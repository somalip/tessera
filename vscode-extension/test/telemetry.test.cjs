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
