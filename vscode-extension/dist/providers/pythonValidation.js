"use strict";

const { spawnSync } = require("node:child_process");

const check = [
    "import ast, sys",
    "source = sys.stdin.buffer.read().decode('utf-8')",
    "try:",
    "    compile(source, '<suggestion>', 'exec')",
    "except SyntaxError as error:",
    "    print(f'Python syntax error on line {error.lineno}: {error.msg}.')",
    "    sys.exit(1)",
    "if sys.argv[1] == 'standalone':",
    "    module = ast.parse(source)",
    "    if any(isinstance(node, ast.FunctionDef) and node.name == 'main' for node in module.body):",
    "        def invokes_main(node):",
    "            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):",
    "                return False",
    "            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'main':",
    "                return True",
    "            return any(invokes_main(child) for child in ast.iter_child_nodes(node))",
    "        if not invokes_main(module):",
    "            print('The Python program defines main() but never calls it.')",
    "            sys.exit(1)",
].join("\n");

function pythonSyntaxProblem(source, standalone = false) {
    const result = spawnSync("python3", ["-I", "-S", "-c", check, standalone ? "standalone" : "snippet"], {
        input: source, encoding: "utf8", timeout: 1500, maxBuffer: 8192, windowsHide: true,
    });
    if (result.status === 0)
        return;
    if (result.status === 1 && result.stdout?.trim())
        return result.stdout.trim();
    throw new Error("TinyCoders could not run python3 to check the suggested program.");
}

exports.pythonSyntaxProblem = pythonSyntaxProblem;

const findPrefix = [
    "import json, sys",
    "before, suggestion, after = json.load(sys.stdin)",
    "lines = suggestion.splitlines(keepends=True)",
    "while lines:",
    "    prefix = ''.join(lines).rstrip(chr(13) + chr(10))",
    "    if prefix.strip():",
    "        try:",
    "            compile(before + prefix + after, '<suggestion>', 'exec')",
    "        except SyntaxError:",
    "            pass",
    "        else:",
    "            print(json.dumps(prefix))",
    "            break",
    "    lines.pop()",
].join("\n");

function pythonAcceptablePrefix(before, suggestion, after) {
    const result = spawnSync("python3", ["-I", "-S", "-c", findPrefix], {
        input: JSON.stringify([before, suggestion, after]), encoding: "utf8",
        timeout: 1500, maxBuffer: 65536, windowsHide: true,
    });
    return result.status === 0 && result.stdout.trim() ? JSON.parse(result.stdout) : "";
}

exports.pythonAcceptablePrefix = pythonAcceptablePrefix;
