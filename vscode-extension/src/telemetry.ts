import { randomUUID } from "node:crypto";

import type { InferenceUsage } from "./host/client";

const sampleLimit = 256;

function p95(samples: number[]): number | null {
  if (!samples.length) return null;
  const sorted = [...samples].sort((left, right) => left - right);
  return Math.round(sorted[Math.ceil(sorted.length * 0.95) - 1]);
}

export class LocalMetrics {
  private readonly firstToken: number[] = [];
  private readonly completed: number[] = [];
  private readonly pending = new Set<string>();
  private offered = 0;
  private accepted = 0;

  private readonly modelRequests = new Map<string, number>();
  private requests = 0;
  private outputTokens: number | null = null;
  private latestSpeed?: { model: string; tokensPerSecond: number };

  constructor(private readonly onChange?: () => void) {}

  recordInference(model: string, { outputTokens, tokensPerSecond }: InferenceUsage): void {
    this.requests += 1;
    this.modelRequests.set(model, (this.modelRequests.get(model) ?? 0) + 1);
    if (outputTokens !== undefined) this.outputTokens = (this.outputTokens ?? 0) + outputTokens;
    if (tokensPerSecond !== undefined) this.latestSpeed = { model, tokensPerSecond };
    this.onChange?.();
  }

  usage() {
    let mostUsed: { model: string; requests: number } | undefined;
    for (const [model, requests] of this.modelRequests) {
      if (!mostUsed || requests > mostUsed.requests) mostUsed = { model, requests };
    }
    return { requests: this.requests, outputTokens: this.outputTokens, latestSpeed: this.latestSpeed,
      mostUsed, completions: this.export() };
  }

  record(firstTokenMs: number | undefined, completedMs: number): string {
    const id = randomUUID();
    this.offered += 1;
    if (this.pending.size >= sampleLimit) this.pending.delete(this.pending.values().next().value!);
    this.pending.add(id);
    if (firstTokenMs !== undefined) {
      this.firstToken.push(firstTokenMs);
      if (this.firstToken.length > sampleLimit) this.firstToken.shift();
    }
    this.completed.push(completedMs);
    if (this.completed.length > sampleLimit) this.completed.shift();
    this.onChange?.();
    return id;
  }

  accept(id: string): void {
    if (!this.pending.delete(id)) return;
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
