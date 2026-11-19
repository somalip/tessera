const aliases: Record<string, string> = {
  py: "python", ts: "typescript", tsx: "typescriptreact", js: "javascript",
  jsx: "javascriptreact", rs: "rust", "c++": "cpp", hpp: "cpp", kt: "kotlin",
};

export function embeddedLanguage(language: string, source: string, offset: number): string | undefined {
  const before = source.slice(0, offset);
  if (language === "markdown") {
    let open: { mark: string; length: number; language: string } | undefined;
    const lines = before.split(/\r?\n/);
    lines.pop();
    for (const line of lines) {
      const fence = /^ {0,3}(`{3,}|~{3,})\s*([^\s`~]*)[^\n]*$/.exec(line);
      if (!fence) continue;
      const [, marks, dialect] = fence;
      if (!open) open = { mark: marks[0], length: marks.length, language: dialect.toLowerCase() };
      else if (marks[0] === open.mark && marks.length >= open.length
        && line.trim().replace(/[`~]/g, "") === "") open = undefined;
    }
    return open?.language ? aliases[open.language] ?? open.language : undefined;
  }
  if (language === "html") {
    let region: string | undefined;
    for (const match of before.matchAll(/<(\/)?(script|style)\b([^>]*)>/gi)) {
      region = match[1] ? undefined : match[2].toLowerCase() === "style" ? "css" :
        /\b(?:lang|type)=["'](?:ts|typescript)["']/i.test(match[3]) ? "typescript" : "javascript";
    }
    return region;
  }
  if (language === "python") {
    const quotes = /"""|'''/g;
    let opening: RegExpExecArray | undefined;
    for (const match of before.matchAll(quotes)) {
      if (!opening) opening = match;
      else if (match[0] === opening[0]) opening = undefined;
    }
    if (opening && /^\s*(?:select|insert|update|delete|create|with)\b/i.test(
      source.slice(opening.index + 3, opening.index + 100),
    )) return "sql";
  }
}

export function projectLanguage(filename: string, files: ReadonlySet<string>): string | undefined {
  if (/\.h$/i.test(filename)) {
    if (["cpp", "compile_flags_cpp"].some(file => files.has(file))) return "cpp";
    if (files.has("c")) return "c";
  }
  if (/\.(?:[cm]?js|jsx)$/i.test(filename) && files.has("tsconfig.json")) return "typescript";
}
