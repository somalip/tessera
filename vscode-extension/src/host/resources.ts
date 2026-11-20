import { execFile } from "node:child_process";
import { cpus, freemem, totalmem } from "node:os";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface ResourceSample {
  cpu?: number;
  ramUsed: number;
  ramTotal: number;
  gpu: number[];
}

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const { times } of cpus()) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

export function parseGpuUsage(output: string, platform: NodeJS.Platform): number[] {
  const values = platform === "darwin"
    ? [...output.matchAll(/"Device Utilization %"\s*=\s*(\d+)/g)].map(match => match[1])
    : output.trim().split(/\r?\n/).map(line => line.trim());
  return values.filter(value => /^\d+$/.test(value)).map(Number).filter(value => value <= 100);
}

async function gpuUsage(signal: AbortSignal): Promise<number[]> {
  const platform = process.platform;
  const options = { signal, timeout: 1500, windowsHide: true };
  try {
    const { stdout } = platform === "darwin"
      ? await run("/usr/sbin/ioreg", ["-r", "-c", "IOAccelerator", "-d", "1", "-l", "-w", "0"], options)
      : await run("nvidia-smi", ["--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"], options);
    return parseGpuUsage(stdout, platform);
  } catch {
    return [];
  }
}

export class SystemResources {
  private previous = cpuTimes();

  async sample(signal: AbortSignal): Promise<ResourceSample> {
    const current = cpuTimes();
    const elapsed = current.total - this.previous.total;
    const busy = elapsed - (current.idle - this.previous.idle);
    this.previous = current;
    const ramTotal = totalmem();
    return {
      cpu: elapsed > 0 ? Math.max(0, Math.min(100, 100 * busy / elapsed)) : undefined,
      ramUsed: ramTotal - freemem(),
      ramTotal,
      gpu: await gpuUsage(signal),
    };
  }
}
