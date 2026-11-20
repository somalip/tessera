"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.modelMemoryBytes = modelMemoryBytes;
// Allow for repacked weights, compute buffers, and the per-sequence KV cache.
function modelMemoryBytes(weights, contextLength) {
    return Math.ceil(weights * 1.35 + 128 * 1024 ** 2 + contextLength * 24 * 1024);
}
