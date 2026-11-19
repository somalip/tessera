export interface FimTokens {
  prefix: string;
  suffix: string;
  middle: string;
}

export const qwenFim: FimTokens = {
  prefix: "<|fim_prefix|>", suffix: "<|fim_suffix|>", middle: "<|fim_middle|>",
};

export function buildFim(source: string, offset: number, contextLength: number, tokens: FimTokens) {
  // Byte budgets bound token counts conservatively for byte-level tokenizers.
  const bytes = Math.max(0, Math.min(contextLength, 2048) - 112);
  const prefix = Buffer.from(source.slice(Math.max(0, offset - bytes), offset));
  const suffix = Buffer.from(source.slice(offset, offset + bytes));
  const suffixBytes = Math.min(suffix.length, Math.floor(bytes / 4));
  const prefixBytes = Math.min(prefix.length, bytes - suffixBytes);
  const left = prefix.subarray(prefix.length - prefixBytes).toString().replace(/^�/, "");
  const right = suffix.subarray(0, suffixBytes).toString().replace(/�$/, "");
  return tokens.prefix + left + tokens.suffix + right + tokens.middle;
}
