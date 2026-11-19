import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
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
  private readonly abort = new AbortController();
  private healthy = false;

  constructor(
    private readonly executable: string,
    private readonly modelPath: string,
    private readonly contextLength: number,
    private readonly gpuLayers = 0,
  ) {}

  get alive(): boolean {
    return this.healthy && !this.abort.signal.aborted
      && this.process?.exitCode === null && this.process.signalCode === null;
  }

  start(): Promise<LlamaClient> {
    this.pending ??= this.launch().catch(error => {
      this.dispose();
      throw error;
    });
    return this.pending;
  }

  private async launch(): Promise<LlamaClient> {
    const port = await availablePort();
    const apiKey = randomUUID();
    this.abort.signal.throwIfAborted();
    const child = spawn(this.executable, [
      "--host", "127.0.0.1", "--port", String(port), "--model", this.modelPath,
      "--ctx-size", String(this.contextLength), "--n-gpu-layers", String(this.gpuLayers),
      "--parallel", "1", "--api-key", apiKey,
    ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    this.process = child;
    let error: Error | undefined;
    let diagnostics = "";
    child.stderr.on("data", chunk => { diagnostics = (diagnostics + String(chunk)).slice(-2000); });
    child.on("error", cause => { error = cause; });
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30_000;
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

  dispose(): void {
    this.abort.abort();
    this.process?.kill();
  }
}
