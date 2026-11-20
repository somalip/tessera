"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Lifecycle = void 0;
class Lifecycle {
    budget;
    limit;
    idleMs;
    allowPaging;
    entries = new Map();
    queue;
    closed = false;
    constructor(budget, limit, idleMs, after = Promise.resolve(), allowPaging = false) {
        this.budget = budget;
        this.limit = limit;
        this.idleMs = idleMs;
        this.allowPaging = allowPaging;
        this.queue = after;
    }
    serialize(operation) {
        const result = this.queue.then(operation);
        this.queue = result.then(() => undefined, () => undefined);
        return result;
    }
    async remove(key) {
        const entry = this.entries.get(key);
        if (!entry)
            return;
        clearTimeout(entry.idle);
        this.entries.delete(key);
        await entry.host.dispose();
    }
    async acquire(key, bytes, create) {
        if (this.closed)
            throw new Error("Model lifecycle has shut down");
        let entry = this.entries.get(key);
        if (entry?.ready && !entry.host.alive && !entry.leases) {
            await this.remove(key);
            entry = undefined;
        }
        if (!entry) {
            const paged = bytes > this.budget;
            if (paged && !this.allowPaging)
                throw new Error("Model exceeds the configured RAM budget");
            const fits = (count, occupied) => paged ? count === 0 : count < this.limit && occupied + bytes <= this.budget;
            let occupied = [...this.entries.values()].reduce((sum, model) => sum + model.bytes, 0);
            const idle = [...this.entries].filter(([, model]) => !model.leases)
                .sort(([, left], [, right]) => left.lastUsed - right.lastUsed);
            const evictions = [];
            for (const [id, model] of idle) {
                if (fits(this.entries.size - evictions.length, occupied))
                    break;
                occupied -= model.bytes;
                evictions.push(id);
            }
            if (!fits(this.entries.size - evictions.length, occupied)) {
                throw new Error("RAM budget or model limit reached while inference is active");
            }
            for (const id of evictions)
                await this.remove(id);
            if (this.closed)
                throw new Error("Model lifecycle has shut down");
            entry = { host: create(paged), bytes, leases: 0, lastUsed: 0, ready: false };
            this.entries.set(key, entry);
        }
        clearTimeout(entry.idle);
        entry.leases += 1;
        return entry;
    }
    async use(key, bytes, create, operation) {
        const entry = await this.serialize(() => this.acquire(key, bytes, create));
        try {
            const host = await entry.host.start();
            entry.ready = true;
            return await operation(host);
        }
        finally {
            entry.leases -= 1;
            entry.lastUsed = performance.now();
            if (this.entries.get(key) === entry && !entry.leases) {
                const removeIdle = () => this.serialize(async () => {
                    if (this.entries.get(key) === entry && !entry.leases)
                        await this.remove(key);
                });
                if (!entry.host.alive)
                    await removeIdle();
                else
                    entry.idle = setTimeout(() => { void removeIdle(); }, this.idleMs);
            }
        }
    }
    dispose() {
        this.closed = true;
        return this.serialize(async () => {
            await Promise.all([...this.entries.keys()].map(key => this.remove(key)));
        });
    }
}
exports.Lifecycle = Lifecycle;
