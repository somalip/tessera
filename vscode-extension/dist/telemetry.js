"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LocalMetrics = void 0;
const node_crypto_1 = require("node:crypto");
const sampleLimit = 256;
function p95(samples) {
    if (!samples.length)
        return null;
    const sorted = [...samples].sort((left, right) => left - right);
    return Math.round(sorted[Math.ceil(sorted.length * 0.95) - 1]);
}
class LocalMetrics {
    firstToken = [];
    completed = [];
    pending = new Set();
    offered = 0;
    accepted = 0;
    record(firstTokenMs, completedMs) {
        const id = (0, node_crypto_1.randomUUID)();
        this.offered += 1;
        if (this.pending.size >= sampleLimit)
            this.pending.delete(this.pending.values().next().value);
        this.pending.add(id);
        if (firstTokenMs !== undefined) {
            this.firstToken.push(firstTokenMs);
            if (this.firstToken.length > sampleLimit)
                this.firstToken.shift();
        }
        this.completed.push(completedMs);
        if (this.completed.length > sampleLimit)
            this.completed.shift();
        return id;
    }
    accept(id) {
        if (this.pending.delete(id))
            this.accepted += 1;
    }
    export() {
        return {
            schema_version: 1, offered: this.offered, accepted: this.accepted,
            acceptance_rate: this.offered ? this.accepted / this.offered : null,
            first_token_p95_ms: p95(this.firstToken),
            completed_request_p95_ms: p95(this.completed),
        };
    }
}
exports.LocalMetrics = LocalMetrics;
