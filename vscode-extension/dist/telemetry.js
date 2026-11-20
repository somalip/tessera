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
    onChange;
    firstToken = [];
    completed = [];
    pending = new Set();
    offered = 0;
    accepted = 0;
    modelRequests = new Map();
    requests = 0;
    outputTokens = null;
    latestSpeed;
    constructor(onChange) {
        this.onChange = onChange;
    }
    recordInference(model, { outputTokens, tokensPerSecond }) {
        this.requests += 1;
        this.modelRequests.set(model, (this.modelRequests.get(model) ?? 0) + 1);
        if (outputTokens !== undefined)
            this.outputTokens = (this.outputTokens ?? 0) + outputTokens;
        if (tokensPerSecond !== undefined)
            this.latestSpeed = { model, tokensPerSecond };
        this.onChange?.();
    }
    usage() {
        let mostUsed;
        for (const [model, requests] of this.modelRequests) {
            if (!mostUsed || requests > mostUsed.requests)
                mostUsed = { model, requests };
        }
        return { requests: this.requests, outputTokens: this.outputTokens, latestSpeed: this.latestSpeed,
            mostUsed, completions: this.export() };
    }
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
        this.onChange?.();
        return id;
    }
    accept(id) {
        if (!this.pending.delete(id))
            return;
        this.accepted += 1;
        this.onChange?.();
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
