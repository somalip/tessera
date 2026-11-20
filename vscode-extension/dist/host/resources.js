"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SystemResources = void 0;
exports.parseGpuUsage = parseGpuUsage;
const node_child_process_1 = require("node:child_process");
const node_os_1 = require("node:os");
const node_util_1 = require("node:util");
const run = (0, node_util_1.promisify)(node_child_process_1.execFile);
function cpuTimes() {
    let idle = 0;
    let total = 0;
    for (const { times } of (0, node_os_1.cpus)()) {
        idle += times.idle;
        total += times.user + times.nice + times.sys + times.idle + times.irq;
    }
    return { idle, total };
}
function parseGpuUsage(output, platform) {
    const values = platform === "darwin"
        ? [...output.matchAll(/"Device Utilization %"\s*=\s*(\d+)/g)].map(match => match[1])
        : output.trim().split(/\r?\n/).map(line => line.trim());
    return values.filter(value => /^\d+$/.test(value)).map(Number).filter(value => value <= 100);
}
async function gpuUsage(signal) {
    const platform = process.platform;
    const options = { signal, timeout: 1500, windowsHide: true };
    try {
        const { stdout } = platform === "darwin"
            ? await run("/usr/sbin/ioreg", ["-r", "-c", "IOAccelerator", "-d", "1", "-l", "-w", "0"], options)
            : await run("nvidia-smi", ["--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"], options);
        return parseGpuUsage(stdout, platform);
    }
    catch {
        return [];
    }
}
class SystemResources {
    previous = cpuTimes();
    async sample(signal) {
        const current = cpuTimes();
        const elapsed = current.total - this.previous.total;
        const busy = elapsed - (current.idle - this.previous.idle);
        this.previous = current;
        const ramTotal = (0, node_os_1.totalmem)();
        return {
            cpu: elapsed > 0 ? Math.max(0, Math.min(100, 100 * busy / elapsed)) : undefined,
            ramUsed: ramTotal - (0, node_os_1.freemem)(),
            ramTotal,
            gpu: await gpuUsage(signal),
        };
    }
}
exports.SystemResources = SystemResources;
