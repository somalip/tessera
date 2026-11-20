"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.qwenFim = void 0;
exports.repositoryContext = repositoryContext;
exports.buildFim = buildFim;
exports.buildDocumentation = buildDocumentation;
exports.qwenFim = {
    prefix: "<|fim_prefix|>", suffix: "<|fim_suffix|>", middle: "<|fim_middle|>",
};
function front(text, bytes) {
    if (bytes <= 0)
        return "";
    const buffer = Buffer.from(text);
    let end = Math.min(bytes, buffer.length);
    while (end > 0 && end < buffer.length && (buffer[end] & 0xC0) === 0x80)
        end -= 1;
    return buffer.subarray(0, end).toString();
}
function back(text, bytes) {
    const buffer = Buffer.from(text);
    let start = Math.max(0, buffer.length - bytes);
    while (start < buffer.length && (buffer[start] & 0xC0) === 0x80)
        start += 1;
    return buffer.subarray(start).toString();
}
function repositoryContext(snippets, byteBudget, lineComment = "#") {
    const lines = [];
    let remaining = byteBudget;
    for (const snippet of snippets) {
        const clean = (snippet.path + "\n" + snippet.text).replace(/<\|[^\r\n|]*\|>/g, "");
        for (const line of clean.split(/\r?\n/).slice(0, 6)) {
            const text = front(`${lineComment} ${line}`, remaining - 1);
            if (text.length <= lineComment.length + 1)
                return lines.join("");
            const output = text + "\n";
            lines.push(output);
            remaining -= Buffer.byteLength(output);
        }
    }
    return lines.join("");
}
function buildFim(source, offset, contextLength, tokens, snippets = [], lineComment = "#") {
    // UTF-8 byte budgets are conservative for byte-level tokenizers.
    const overhead = Object.values(tokens).reduce((sum, token) => sum + Buffer.byteLength(token), 0);
    const bytes = Math.max(0, Math.min(contextLength, 2048) - 96 - overhead);
    const extras = repositoryContext(snippets, Math.floor(bytes / 4), lineComment);
    const remainder = bytes - Buffer.byteLength(extras);
    const right = front(source.slice(offset, offset + remainder), Math.floor(remainder / 4));
    const left = back(source.slice(Math.max(0, offset - remainder), offset), remainder - Buffer.byteLength(right));
    return tokens.prefix + extras + left + tokens.suffix + right + tokens.middle;
}
function buildDocumentation(source, offset) {
    const clean = (text) => text.replace(/<\|[^\r\n|]*\|>/g, "");
    const left = clean(back(source.slice(Math.max(0, offset - 480), offset), 480));
    const right = clean(front(source.slice(offset, offset + 96), 96));
    return "<|im_start|>system\nComplete Markdown prose or Python docstrings. " +
        "Output only the short text to insert at the cursor, on one line. " +
        "Continue the existing wording. Do not repeat the surrounding text or invent commands.<|im_end|>\n" +
        `<|im_start|>user\n${left}<CURSOR>${right}<|im_end|>\n` +
        "<|im_start|>assistant\n<think>\n\n</think>\n\n";
}
