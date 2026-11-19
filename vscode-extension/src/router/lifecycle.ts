import type { InferenceHost } from "../host/client";

export interface Host {
  readonly alive: boolean;
  start(): Promise<InferenceHost>;
  dispose(): void | Promise<void>;
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
  private queue: Promise<void>;
  private closed = false;

  constructor(
    private readonly budget: number,
    private readonly limit: number,
    private readonly idleMs: number,
    after: Promise<void> = Promise.resolve(),
  ) {
    this.queue = after;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async remove(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    clearTimeout(entry.idle);
    this.entries.delete(key);
    await entry.host.dispose();
  }

  private async acquire(key: string, bytes: number, create: () => Host): Promise<Entry> {
    if (this.closed) throw new Error("Model lifecycle has shut down");
    let entry = this.entries.get(key);
    if (entry?.ready && !entry.host.alive && !entry.leases) {
      await this.remove(key);
      entry = undefined;
    }
    if (!entry) {
      if (bytes > this.budget) throw new Error("Model exceeds the configured RAM budget");
      let occupied = [...this.entries.values()].reduce((sum, model) => sum + model.bytes, 0);
      const idle = [...this.entries].filter(([, model]) => !model.leases)
        .sort(([, left], [, right]) => left.lastUsed - right.lastUsed);
      const evictions: string[] = [];
      for (const [id, model] of idle) {
        if (this.entries.size - evictions.length < this.limit && occupied + bytes <= this.budget) break;
        occupied -= model.bytes;
        evictions.push(id);
      }
      if (this.entries.size - evictions.length >= this.limit || occupied + bytes > this.budget) {
        throw new Error("RAM budget or model limit reached while inference is active");
      }
      for (const id of evictions) await this.remove(id);
      if (this.closed) throw new Error("Model lifecycle has shut down");
      entry = { host: create(), bytes, leases: 0, lastUsed: 0, ready: false };
      this.entries.set(key, entry);
    }
    clearTimeout(entry.idle);
    entry.leases += 1;
    return entry;
  }

  async use<T>(
    key: string, bytes: number, create: () => Host,
    operation: (host: InferenceHost) => Promise<T>,
  ): Promise<T> {
    const entry = await this.serialize(() => this.acquire(key, bytes, create));
    try {
      const host = await entry.host.start();
      entry.ready = true;
      return await operation(host);
    } finally {
      entry.leases -= 1;
      entry.lastUsed = performance.now();
      if (this.entries.get(key) === entry && !entry.leases) {
        const removeIdle = () => this.serialize(async () => {
          if (this.entries.get(key) === entry && !entry.leases) await this.remove(key);
        });
        if (!entry.host.alive) await removeIdle();
        else entry.idle = setTimeout(() => { void removeIdle(); }, this.idleMs);
      }
    }
  }

  dispose(): Promise<void> {
    this.closed = true;
    return this.serialize(async () => {
      await Promise.all([...this.entries.keys()].map(key => this.remove(key)));
    });
  }
}
