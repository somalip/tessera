import type { Snippet } from "./bm25";

export interface FimTokens {
  prefix: string;
  suffix: string;
  middle: string;
}

export const qwenFim: FimTokens = {
  prefix: "<|fim_prefix|>", suffix: "<|fim_suffix|>", middle: "<|fim_middle|>",
};

function front(text: string, bytes: number): string {
  if (bytes <= 0) return "";
  const buffer = Buffer.from(text);
  let end = Math.min(bytes, buffer.length);
  while (end > 0 && end < buffer.length && (buffer[end] & 0xC0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString();
}

function back(text: string, bytes: number): string {
  const buffer = Buffer.from(text);
  let start = Math.max(0, buffer.length - bytes);
  while (start < buffer.length && (buffer[start] & 0xC0) === 0x80) start += 1;
  return buffer.subarray(start).toString();
}

export function repositoryContext(snippets: Snippet[], byteBudget: number, lineComment = "#"): string {
  const lines: string[] = [];
  let remaining = byteBudget;
  for (const snippet of snippets) {
    const clean = (snippet.path + "\n" + snippet.text).replace(/<\|[^\r\n|]*\|>/g, "");
    for (const line of clean.split(/\r?\n/).slice(0, 6)) {
      const text = front(`${lineComment} ${line}`, remaining - 1);
      if (text.length <= lineComment.length + 1) return lines.join("");
      const output = text + "\n";
      lines.push(output);
      remaining -= Buffer.byteLength(output);
    }
  }
  return lines.join("");
}

export function buildFim(
  source: string, offset: number, contextLength: number, tokens: FimTokens,
  snippets: Snippet[] = [], lineComment = "#",
) {
  // UTF-8 byte budgets are conservative for byte-level tokenizers.
  const overhead = Object.values(tokens).reduce((sum, token) => sum + Buffer.byteLength(token), 0);
  const bytes = Math.max(0, Math.min(contextLength, 2048) - 96 - overhead);
  const extras = repositoryContext(snippets, Math.floor(bytes / 4), lineComment);
  const remainder = bytes - Buffer.byteLength(extras);
  const right = front(source.slice(offset, offset + remainder), Math.floor(remainder / 4));
  const left = back(source.slice(Math.max(0, offset - remainder), offset), remainder - Buffer.byteLength(right));
  return tokens.prefix + extras + left + tokens.suffix + right + tokens.middle;
}
