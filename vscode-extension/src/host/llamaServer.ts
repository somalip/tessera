import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { LlamaClient } from "./client";

async function availablePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(error => {
        if (error || !address || typeof address === "string") {
          reject(error ?? new Error("Could not allocate loopback port"));
        } else {
          resolve(address.port);
        }
      });
    });
  });
}

export class LlamaServer {
  private process?: ChildProcess;
  private pending?: Promise<LlamaClient>;
  private exited?: Promise<void>;
  private stopping?: Promise<void>;
  private readonly abort = new AbortController();
  private healthy = false;

  constructor(
    private readonly executable: string,
    private readonly modelPath: string,
    private readonly contextLength: number,
    private readonly gpuLayers = 0,
    private readonly minimumBuild = "local",
    private readonly paged = false,
    private readonly cpuThreads = 0,
  ) {}

  get alive(): boolean {
    return this.healthy && !this.abort.signal.aborted
      && this.process?.exitCode === null && this.process.signalCode === null;
  }

  start(): Promise<LlamaClient> {
    this.pending ??= this.launch().catch(async error => {
      await this.dispose();
      throw error;
    });
    return this.pending;
  }

  private async launch(): Promise<LlamaClient> {
    const gpuLayers = this.paged ? 0 : this.gpuLayers;
    const env = { ...process.env };
    if (gpuLayers === 0) env.GGML_METAL_DEVICES = "0";
    if (this.paged) {
      // Keep both older and newer llama.cpp builds on unlocked, file-backed weights.
      delete env.LLAMA_ARG_MLOCK;
      delete env.LLAMA_ARG_DIO;
      env.LLAMA_ARG_MMAP = "1";
      env.LLAMA_ARG_LOAD_MODE = "mmap";
    }
    if (this.minimumBuild !== "local") {
      const required = /^b(\d+)$/.exec(this.minimumBuild);
      const { stdout, stderr } = await promisify(execFile)(this.executable, ["--version"], {
        env, timeout: 5000, signal: this.abort.signal, windowsHide: true,
      });
      const actual = /version:\s*b?(\d+)/i.exec(stdout + stderr);
      if (!required || !actual || Number(actual[1]) < Number(required[1])) {
        throw new Error(`Model requires llama.cpp ${this.minimumBuild}`);
      }
    }
    const port = await availablePort();
    const apiKey = randomUUID();
    this.abort.signal.throwIfAborted();
    const child = spawn(this.executable, [
      "--host", "127.0.0.1", "--port", String(port), "--model", this.modelPath,
      "--ctx-size", String(this.contextLength), "--n-gpu-layers", String(gpuLayers),
      "--parallel", "1", "--api-key", apiKey, "--cache-ram", "0",
      ...(this.cpuThreads > 0 ? ["--threads", String(this.cpuThreads), "--threads-batch", String(this.cpuThreads)] : []),
      ...(gpuLayers === 0 ? ["--device", "none"] : []),
      ...(this.paged ? ["--no-repack", "--no-warmup"] : []),
    ], { env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    this.process = child;
    this.exited = new Promise(resolve => { child.once("close", () => resolve()); });
    let error: Error | undefined;
    let diagnostics = "";
    child.stderr.on("data", chunk => { diagnostics = (diagnostics + String(chunk)).slice(-2000); });
    child.on("error", cause => { error = cause; });
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + (this.paged ? 120_000 : 30_000);
    while (Date.now() < deadline) {
      this.abort.signal.throwIfAborted();
      if (error) throw error;
      if (child.exitCode !== null || child.signalCode !== null) break;
      const response = await fetch(origin + "/health", {
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(500)]),
        redirect: "error",
      }).catch(() => undefined);
      if (response?.ok && child.exitCode === null && child.signalCode === null) {
        this.healthy = true;
        return new LlamaClient(origin, apiKey, this.contextLength);
      }
      await delay(100, undefined, { signal: this.abort.signal });
    }
    throw new Error(`llama-server failed to become ready. ${diagnostics}`);
  }

  dispose(): Promise<void> {
    this.abort.abort();
    this.stopping ??= this.terminate();
    return this.stopping;
  }

  private async terminate(): Promise<void> {
    const child = this.process;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const force = setTimeout(() => child.kill("SIGKILL"), 1500);
    try {
      child.kill();
      await this.exited;
    } finally {
      clearTimeout(force);
    }
  }
}
