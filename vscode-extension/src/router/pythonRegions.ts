import { Language, Parser } from "@vscode/tree-sitter-wasm";

const sql = /^\s*(?:select|insert|update|delete|create|alter|drop|with)\b/i;
type Region = { first: number; last: number; language: string };

export class PythonRegions {
  private parser?: Parser;
  private disposed = false;
  private readonly cache = new Map<string, { version: number; regions: Region[] }>();

  get available(): boolean {
    return this.parser !== undefined;
  }

  async initialize(): Promise<void> {
    await Parser.init();
    const grammar = await Language.load(require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm"));
    if (this.disposed) return;
    this.parser = new Parser();
    this.parser.setLanguage(grammar);
  }

  at(key: string, version: number, source: string, offset: number): string | undefined {
    if (!this.parser || source.length > 512_000) return;
    let entry = this.cache.get(key);
    if (entry?.version !== version) {
      const tree = this.parser.parse(source);
      if (!tree) return;
      const regions: Region[] = [];
      try {
        for (const node of tree.rootNode.descendantsOfType("string")) {
          if (!node) continue;
          const start = node.namedChildren.find(child => child?.type === "string_start");
          const end = node.namedChildren.find(child => child?.type === "string_end");
          if (!start) continue;
          const statement = node.parent;
          const container = statement?.parent;
          const owner = container?.parent;
          const docstring = statement?.type === "expression_statement" &&
            container?.namedChildren.find(child => child?.type !== "comment")?.equals(statement) &&
            (container.type === "module" || (container.type === "block" &&
              (owner?.type === "function_definition" || owner?.type === "class_definition")));
          const argument = node.parent;
          const callee = argument?.parent?.childForFieldName("function")?.text;
          const firstArgument = argument?.type === "argument_list" && argument.firstNamedChild?.equals(node);
          const language = docstring && !/^[bf]/i.test(start.text) ? "python-docstring"
            : firstArgument && callee === "json.loads" ? "json"
            : firstArgument && /^re\.(?:compile|search|match|fullmatch|findall|finditer|split|sub|subn)$/.test(callee ?? "") ? "regex"
            : sql.test(source.slice(start.endIndex, start.endIndex + 96)) ? "sql"
            : undefined;
          if (language) regions.push({ first: start.endIndex, last: end?.startIndex ?? node.endIndex, language });
        }
        // A live editor may contain an opening triple quote without its closing delimiter.
        for (const error of tree.rootNode.descendantsOfType("ERROR")) {
          if (!error) continue;
          const start = error.namedChildren.find(child => child?.type === "string_start");
          if (!start || !/"""|'''/.test(start.text)) continue;
          const parent = error.parent;
          const docstring = (parent?.type === "module" &&
            parent.namedChildren.find(child => child?.type !== "comment")?.equals(error)) ||
            ((parent?.type === "function_definition" || parent?.type === "class_definition") &&
              start.startIndex < (parent.childForFieldName("body")?.startIndex ?? source.length));
          const language = docstring && !/^[bf]/i.test(start.text) ? "python-docstring"
            : sql.test(source.slice(start.endIndex, start.endIndex + 96)) ? "sql" : undefined;
          if (language) regions.push({ first: start.endIndex, last: source.length, language });
        }
      } finally {
        tree.delete();
      }
      entry = { version, regions };
      this.cache.set(key, entry);
      if (this.cache.size > 16) this.cache.delete(this.cache.keys().next().value!);
    }
    return entry.regions.find(region => region.first <= offset && offset <= region.last)?.language;
  }

  projectProblem(source: string, newFile: boolean): string | undefined {
    const tree = this.parser?.parse(source);
    if (!tree) return;
    try {
      const root = tree.rootNode;
      if (root.hasError) return "The previous answer contained invalid Python syntax.";
      if (!newFile) return;
      const statements = root.namedChildren.filter(node => node !== null);
      const entryPoint = statements.find(node => node.type === "function_definition" &&
        node.childForFieldName("name")?.text === "main");
      const body = entryPoint?.childForFieldName("body");
      if (body && body.namedChildren.every(node => !node || node.type === "comment" ||
        node.type === "pass_statement" || (node.type === "expression_statement" &&
        ["string", "ellipsis"].includes(node.firstNamedChild?.type ?? "")))) {
        return "The previous answer left main unimplemented.";
      }
      if (statements.every(node => ["comment", "import_statement", "import_from_statement", "pass_statement"]
        .includes(node.type))) return "The previous answer did not implement the program.";
    } finally {
      tree.delete();
    }
  }

  close(key: string): void {
    this.cache.delete(key);
  }

  dispose(): void {
    this.disposed = true;
    this.parser?.delete();
    this.parser = undefined;
    this.cache.clear();
  }
}
