// Allow for repacked weights, compute buffers, and the per-sequence KV cache.
export function modelMemoryBytes(weights: number, contextLength: number): number {
  return Math.ceil(weights * 1.35 + 128 * 1024 ** 2 + contextLength * 24 * 1024);
}
