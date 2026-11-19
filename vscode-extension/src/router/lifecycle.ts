import type { InferenceHost } from "../host/client";

export interface Host {
  readonly alive: boolean;
  start(): Promise<InferenceHost>;
  dispose(): void;
}

interface Entry {
  host: Host;
  bytes: number;
  leases: number;
  lastUsed: number;
  ready: boolean;
  idle?: ReturnType<typeof setTimeout>;
}

export class Lifecycle {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly budget: number,
    private readonly limit: number,
    private readonly idleMs: number,
  ) {}

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    clearTimeout(entry.idle);
    this.entries.delete(key);
    entry.host.dispose();
  }

  async use<T>(
    key: string, bytes: number, create: () => Host,
    operation: (host: InferenceHost) => Promise<T>,
  ): Promise<T> {
    let entry = this.entries.get(key);
    if (entry?.ready && !entry.host.alive && !entry.leases) {
      this.remove(key);
      entry = undefined;
    }
    if (!entry) {
      if (bytes > this.budget) throw new Error("Model exceeds the configured RAM budget");
      let occupied = [...this.entries.values()].reduce((sum, model) => sum + model.bytes, 0);
      const idle = [...this.entries].filter(([, model]) => !model.leases)
        .sort(([, left], [, right]) => left.lastUsed - right.lastUsed);
      for (const [id, model] of idle) {
        if (this.entries.size < this.limit && occupied + bytes <= this.budget) break;
        occupied -= model.bytes;
        this.remove(id);
      }
      if (this.entries.size >= this.limit || occupied + bytes > this.budget) {
        throw new Error("RAM budget or model limit reached while inference is active");
      }
      entry = { host: create(), bytes, leases: 0, lastUsed: 0, ready: false };
      this.entries.set(key, entry);
    }
    clearTimeout(entry.idle);
    entry.leases += 1;
    try {
      const host = await entry.host.start();
      entry.ready = true;
      return await operation(host);
    } finally {
      entry.leases -= 1;
      entry.lastUsed = performance.now();
      if (this.entries.get(key) === entry && !entry.leases) {
        if (!entry.host.alive) this.remove(key);
        else entry.idle = setTimeout(() => this.remove(key), this.idleMs);
      }
    }
  }

  dispose(): void {
    for (const key of this.entries.keys()) this.remove(key);
  }
}
