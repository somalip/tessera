type CppAnswerKind = "insertion" | "function" | "program";

export function cppAnswerKind(instruction: string, contextual: boolean): CppAnswerKind {
  if (contextual) return "insertion";
  if (/\bmain\s*\(/.test(instruction)) return "program";
  return /^(?:(?:implement|define|write)\s+[^\n.]+\([^\n]*\)|(?:write|implement|define)\s+(?:a\s+)?function\b)/i
    .test(instruction) ? "function" : "program";
}

export function cppSystemPrompt(kind: CppAnswerKind): string {
  const mode = kind === "insertion" ? "Return only the code to insert at the cursor. Do not repeat surrounding code."
    : kind === "function" ? "Return the requested function definition with its required headers or imports and helpers. " +
      "Leave out the entry point, example calls, and tests."
      : "Return one complete standalone program with the required headers or imports and a runnable entry point.";
  return "Return only C++20 source code. " + mode + " Stop immediately after the code.";
}

export function cppCommentRequest(lines: readonly string[]): { instruction: string; start: number } | undefined {
  const start = lines.findIndex(line => /^(?:tessera:|tinycoders:)\s*\S/i.test(line) ||
    /^(?:make|build|create|implement|write|generate|add|insert|define|fix|refactor)\s+\S/i.test(line));
  if (start === -1) return undefined;
  return {
    instruction: lines.slice(start).join("\n").replace(/^(?:tessera:|tinycoders:)\s*/i, ""),
    start,
  };
}

function withoutLiterals(code: string): string {
  return code.replace(/(?:u8|u|U|L)?R"([^\s()\\]*)\([\s\S]*?\)\1"|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
    match => match.replace(/[^\r\n]/g, " "));
}

export function foreignCppSnippet(code: string): boolean {
  return /\bconsole\s*\.\s*(?:log|warn|error)\s*\(|\b(?:for\s*\(\s*let|let)\s+[$\w]+|^\s*(?:export\s+default|import\s+.+\s+from)\b/m
    .test(withoutLiterals(code));
}

export function cppGenerationProblem(snippet: string, response: string, kind: CppAnswerKind = "insertion"): string | undefined {
  if (/^\s*```(?!cpp\s*$|c\+\+\s*$|cxx\s*$|\s*$)\w/im.test(response) || foreignCppSnippet(snippet)) {
    return "The previous answer used a different language.";
  }
  const code = withoutLiterals(snippet);
  if (kind !== "insertion" && /^\s*(?:(?:for|while|if|switch|return)\b|std::(?:cout|cerr)\s*<<)/.test(code)) {
    return "The previous answer put a statement outside a function. Return a complete implementation.";
  }
  if (kind === "function" && /^\s*(?:int|auto)\s+main\s*\(/m.test(code)) {
    return "The previous answer added a program entry point to a function request.";
  }
  const stack: string[] = [];
  for (const delimiter of code.matchAll(/[{}()[\]]/g)) {
    const symbol = delimiter[0];
    const index = "})]".indexOf(symbol);
    if (index === -1) stack.push(symbol);
    else if (stack.pop() !== "{(["[index]) return "The previous answer had unbalanced delimiters.";
  }
  if (stack.length) return "The previous answer ended inside an unfinished block.";
  const lines = code.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (let width = 3; width * 2 <= lines.length; width++) {
    const previous = lines.slice(-2 * width, -width).join("\n");
    if (previous === lines.slice(-width).join("\n")) return "The previous answer repeated a block of code.";
  }
  return undefined;
}

export function cppFinishedCode(response: string, kind: CppAnswerKind): string | undefined {
  const fenced = /^\s*```(?:cpp|c\+\+|cxx)?[ \t]*\r?\n([\s\S]*?)^\s*```[ \t]*(?:\r?\n|$)/im.exec(response.trimStart());
  if (fenced?.index === 0 && fenced[1].trim() && !cppGenerationProblem(fenced[1], response, kind)) {
    return fenced[1].trimEnd();
  }
  if (kind === "insertion") return undefined;
  const entries = [...withoutLiterals(response).matchAll(/^\s*(?:int|auto)\s+main\s*\(/gm)];
  const extra = entries[kind === "function" ? 0 : 1];
  if (!extra?.index) return undefined;
  const implementation = response.slice(0, extra.index).trimEnd();
  if (!implementation.endsWith("}") || cppGenerationProblem(implementation, implementation, kind)) return undefined;
  return implementation;
}

export function cppShouldContinue(previous: string): boolean {
  return /[{(\[,\\]\s*$/.test(withoutLiterals(previous));
}
