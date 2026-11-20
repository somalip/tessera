const assert = require("node:assert/strict");
const { test } = require("node:test");
const { parseGpuUsage } = require("../dist/host/resources");
const { renderResources } = require("../dist/views/dashboardHtml");

test("GPU readings preserve zero and ignore unsupported or out-of-range values", () => {
  assert.deepEqual(parseGpuUsage('"PerformanceStatistics" = {"Device Utilization %"=0,"Renderer Utilization %"=10}', "darwin"), [0]);
  assert.deepEqual(parseGpuUsage(" 42\r\n[N/A]\r\n0\r\n101\r\n", "win32"), [42, 0]);
  assert.deepEqual(parseGpuUsage("", "linux"), []);
});

test("the monitor distinguishes missing readings from idle hardware", () => {
  const memory = { ramUsed: 1024 ** 3, ramTotal: 4 * 1024 ** 3 };
  const initial = renderResources({ ...memory, gpu: [] });
  assert.match(initial, /Sampling/);
  assert.match(initial, /GPU<\/span><span>Unavailable/);
  const sample = renderResources({ ...memory, cpu: 0, gpu: [0, 12] });
  assert.match(sample, /CPU<\/span><span>0%/);
  assert.match(sample, /1.0 \/ 4.0 GiB/);
  assert.match(sample, /GPU 1<\/span><span>0%/);
  assert.match(sample, /GPU 2<\/span><span>12%/);
});
