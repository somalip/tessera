"""Apply the C++ provider changes to the local TinyCoders 0.1.22 VSIX."""
import argparse
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


def replace_once(text, before, after):
    if text.count(before) != 1:
        raise ValueError(f"Unexpected TinyCoders build: {before!r}")
    return text.replace(before, after, 1)


def update_provider(code):
    changes = (
        ('const { streamCommentSuggestion } = require("./commentPreview");',
         '''const { streamCommentSuggestion } = require("./commentPreview");
const { cppAnswerKind, cppCommentRequest, cppFinishedCode, cppGenerationProblem, cppShouldContinue, cppSystemPrompt, foreignCppSnippet } = require("./cppSnippet");'''),
        (r'        return /^\/\/\s*tinycoders:\s*\S/.test(comment) ? instruction : undefined;',
         '        return undefined;'),
        ('async function generateCode(', r'''function cppProjectComment(document, position) {
    const lines = [];
    for (let line = position.line - 1; line >= 0; line--) {
        const match = /^\s*\/\/\s*(.*)$/.exec(document.lineAt(line).text);
        if (!match) break;
        lines.unshift(match[1]);
    }
    const request = cppCommentRequest(lines);
    return request && { instruction: request.instruction, line: position.line - lines.length + request.start };
}
async function generateCode('''),
        ('    const project = projectLine !== undefined;',
         '    const cpp = document.languageId === "cpp";\n    const project = !cpp && projectLine !== undefined;'),
        ('    const before = source.slice(Math.max(0, commentOffset - 240), commentOffset).trimEnd();\n'
         '    const after = source.slice(offset, offset + 160).trim();',
         r'''    const before = source.slice(Math.max(0, commentOffset - (cpp ? 1200 : 240)), commentOffset).trimEnd();
    const tail = source.slice(offset, offset + (cpp ? 600 : 160));
    const after = cpp ? tail.replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd() : tail.trim();
    const contextual = Boolean(before.trim() || after.trim());
    const cppKind = cppAnswerKind(instruction, contextual);'''),
        ('{ role: "system", content: "Return only complete, runnable code for insertion at the cursor. " +',
         '{ role: "system", content: cpp ? cppSystemPrompt(cppKind) : "Return only complete, runnable code for insertion at the cursor. " +'),
        (r'''content: `Language: ${document.languageId}\nRequest: ${instruction}\n` +
                `Before cursor:\n${before}\nAfter cursor:\n${after}${guidance}`''',
         r'''content: `Language: ${document.languageId}\nRequest: ${instruction}` +
                (cpp && !contextual ? "" : `\nBefore cursor:\n${before}\nAfter cursor:\n${after}${guidance}`)'''),
        ('    const tokens = project ?', '    const tokens = cpp ? 768 : project ?'),
        ('                    result += chunk;\n                    onProgress?.(result);',
         '''                    result += chunk;
                    const finished = cpp ? cppFinishedCode(result, cppKind) : undefined;
                    if (finished !== undefined) {
                        result = finished;
                        break;
                    }
                    onProgress?.(result);'''),
        (': project ? pythonSyntaxProblem(source.slice(0, offset) + insertion + source.slice(offset), standalone) ??',
         ': cpp ? cppGenerationProblem(snippet, code, cppKind)\n'
         '                : project ? pythonSyntaxProblem(source.slice(0, offset) + insertion + source.slice(offset), standalone) ??'),
        ('        const project = afterComment ? pythonProjectComment(document, position) : undefined;',
         '''        const cpp = document.languageId === "cpp";
        if (cpp && automaticRequest && !afterComment && !originalLine.trim() &&
            (!position.line || !cppShouldContinue(document.lineAt(position.line - 1).text))) return [];
        const project = !afterComment ? undefined : !cpp ? pythonProjectComment(document, position)
            : position.character === originalLine.length ? cppProjectComment(document, position) : undefined;'''),
        ('        if (chat && instruction) {\n            cancellation.dispose();',
         '''        if (chat && instruction && cpp) {
            try {
                await (0, promises_1.setTimeout)(180, undefined, { signal });
                const requested = performance.now();
                this.reportRoute?.(document, { mode: "Inline generation", model: chat.installed });
                let firstToken;
                const result = await generateCode(chat, document, position, instruction, signal,
                    () => { firstToken ??= performance.now() - requested; }, project?.line, this.validateProject);
                return this.suggestion(document, position, version, signal, result, firstToken, requested);
            }
            catch (error) {
                if (!signal.aborted) this.log.appendLine(String(error));
                return [];
            }
            finally {
                cancellation.dispose();
                if (this.pending.get(key) === controller) this.pending.delete(key);
            }
        }
        if (chat && instruction) {
            cancellation.dispose();'''),
        ('                if (model.documentation)\n                    stop.push("<|im_end|>");',
         '                if (model.documentation || cpp)\n                    stop.push("<|im_end|>");'),
        ('if (signal.aborted || document.version !== version || !result.trim())',
         'if (signal.aborted || document.version !== version || !result.trim() ||\n'
         '            (document.languageId === "cpp" && foreignCppSnippet(result)))'),
    )
    for before, after in changes:
        code = replace_once(code, before, after)
    return code


def package(source, helper, output):
    if source.resolve() == output.resolve():
        raise ValueError("The output must differ from the original VSIX")
    with ZipFile(source) as old, ZipFile(output, "w", compression=ZIP_DEFLATED) as new:
        for entry in old.infolist():
            data = old.read(entry)
            if entry.filename == "extension.vsixmanifest":
                data = replace_once(data.decode(), 'Version="0.1.22"', 'Version="0.1.23"').encode()
            elif entry.filename == "extension/package.json":
                manifest = json.loads(data)
                if (manifest["publisher"], manifest["name"], manifest["version"]) != (
                    "tinycoders", "tinycoders", "0.1.22",
                ):
                    raise ValueError("Expected the local TinyCoders 0.1.22 build")
                manifest["version"] = "0.1.23"
                data = json.dumps(manifest, indent=2).encode()
            elif entry.filename == "extension/dist/extension.js":
                data = replace_once(
                    data.decode(),
                    'id === "python-local" ? 4096',
                    '["python-local", "cpp-local"].includes(id) ? 4096',
                ).encode()
            elif entry.filename == "extension/dist/providers/inlineCompletion.js":
                data = update_provider(data.decode()).encode()
            new.writestr(entry, data)
        new.write(helper, "extension/dist/providers/cppSnippet.js")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("helper", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    package(args.source, args.helper, args.output)
