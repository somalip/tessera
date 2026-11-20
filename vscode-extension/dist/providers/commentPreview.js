"use strict";

const path = require("node:path");
const vscode = require("vscode");

const visibleContext = "tessera.commentPreviewVisible";
let activePreview;

function registerCommentPreviewCommands(acceptCommand, dismissCommand) {
    return vscode.Disposable.from(
        vscode.commands.registerCommand(acceptCommand, async () => {
            if (activePreview)
                await activePreview.accept();
            else
                await vscode.commands.executeCommand("editor.action.inlineSuggest.commit");
        }),
        vscode.commands.registerCommand(dismissCommand, async () => {
            activePreview?.dispose();
            await vscode.commands.executeCommand("editor.action.inlineSuggest.hide");
        }),
    );
}

function streamCommentSuggestion(document, position, generate, { rawIndentation = false, canAcceptPartial } = {}) {
    activePreview?.dispose();
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== document)
        return;
    let version = document.version;
    let cursor = position;
    let accepted = "";
    let accepting = false;
    let latest = [];
    let pending = true;
    let acceptanceRequested = false;
    const controller = new AbortController();
    const { signal } = controller;
    const arrow = vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.file(path.join(__dirname, "commentPreviewArrow.svg")),
        gutterIconSize: "contain",
    });
    const indent = document.lineAt(position.line).text;
    const newline = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    let items = [];
    let shownText = "";
    let servedText = "";
    let ready;
    const firstItems = new Promise(resolve => { ready = resolve; });
    let timer;
    let visible = false;
    const selection = vscode.window.onDidChangeTextEditorSelection(() => {
        if (!accepting && !isCurrent())
            dispose();
    });
    const activeEditor = vscode.window.onDidChangeActiveTextEditor(() => {
        if (!isCurrent())
            dispose();
    });

    function isCurrent() {
        return !signal.aborted && document.version === version && vscode.window.activeTextEditor === editor &&
            editor.selections.length === 1 && editor.selection.isEmpty && editor.selection.active.isEqual(cursor);
    }

    function setVisible(hasCode) {
        editor.setDecorations(arrow, hasCode ? [new vscode.Range(cursor, cursor)] : []);
        if (visible !== hasCode) {
            visible = hasCode;
            void vscode.commands.executeCommand("setContext", visibleContext, visible);
        }
    }

    if (isCurrent()) {
        editor.setDecorations(arrow, [{
            range: new vscode.Range(cursor, cursor),
            hoverMessage: "TinyCoders is waiting for the local model.",
        }]);
    }

    function dispose() {
        if (signal.aborted)
            return;
        controller.abort();
        clearTimeout(timer);
        setVisible(false);
        arrow.dispose();
        selection.dispose();
        activeEditor.dispose();
        ready?.([]);
        if (activePreview === session)
            activePreview = undefined;
    }

    function publish(next, streaming) {
        latest = next;
        pending = streaming;
        if (signal.aborted || accepting || !isCurrent())
            return;
        const fullText = next[0]?.insertText ?? "";
        if (accepted && fullText && !fullText.startsWith(accepted)) {
            if (streaming && (canAcceptPartial || accepted.startsWith(fullText)))
                return;
            dispose();
            return;
        }
        const text = fullText.slice(accepted.length);
        if (streaming && !text && !shownText)
            return;
        if (streaming && text === shownText)
            return;
        shownText = text;
        items = [];
        if (text.trim()) {
            const item = new vscode.InlineCompletionItem(text, new vscode.Range(cursor, cursor));
            item.command = next[0].command;
            items = [item];
        }
        setVisible(Boolean(items.length));
        if (ready && (items.length || !streaming)) {
            ready(items);
            ready = undefined;
        }
        else if (!ready && !timer) {
            timer = setTimeout(() => {
                timer = undefined;
                if (isCurrent() && !accepting)
                    void vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
            }, 65);
        }
    }

    async function accept() {
        if (!isCurrent() || accepting)
            return;
        const previousText = document.getText();
        const offset = document.offsetAt(cursor);
        const suggested = servedText;
        const acceptedText = canAcceptPartial
            ? canAcceptPartial(previousText.slice(0, offset), suggested, previousText.slice(offset))
            : suggested;
        if (!acceptedText) {
            acceptanceRequested = pending;
            return;
        }
        acceptanceRequested = false;
        accepting = true;
        try {
            if (acceptedText === suggested)
                await vscode.commands.executeCommand("editor.action.inlineSuggest.commit");
            else
                await editor.edit(edit => edit.insert(cursor, acceptedText));
        }
        finally {
            accepting = false;
            if (!signal.aborted && document.version !== version) {
                const currentText = document.getText();
                const suffixStart = currentText.length - (previousText.length - offset);
                const inserted = currentText.slice(offset, suffixStart);
                if (!inserted || !suggested.startsWith(inserted) ||
                    currentText.slice(0, offset) !== previousText.slice(0, offset) ||
                    currentText.slice(suffixStart) !== previousText.slice(offset)) {
                    dispose();
                }
                else {
                    accepted += inserted;
                    cursor = document.positionAt(offset + inserted.length);
                    version = document.version;
                    shownText = undefined;
                    if (!isCurrent() || (!pending && latest[0]?.insertText === accepted))
                        dispose();
                    else
                        publish(latest, pending);
                }
            }
            else if (!signal.aborted) {
                publish(latest, pending);
            }
        }
    }

    function update(raw) {
        const body = rawIndentation ? raw
            : raw.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/^```[^\r\n]*\r?\n/, "");
        const lastBreak = body.lastIndexOf("\n");
        const lines = lastBreak < 0 ? [] : body.slice(0, lastBreak).split(/\r?\n/);
        const fence = lines.findIndex(line => /^\s*```/.test(line));
        if (fence >= 0)
            lines.length = fence;
        const text = lines.map((line, index) => !rawIndentation && index && line ? indent + line : line)
            .join(newline).trimEnd();
        publish(text.trim() ? [new vscode.InlineCompletionItem(text, new vscode.Range(position, position))] : [], true);
    }

    const session = {
        document,
        matches(target, at) { return target === document && at.isEqual(cursor) && isCurrent(); },
        get accepting() { return accepting; },
        accept,
        async suggestions() {
            const result = ready ? await firstItems : items;
            servedText = result[0]?.insertText ?? "";
            return result;
        },
        dispose,
    };
    activePreview = session;
    void (async () => {
        try {
            const result = await generate(signal, update, () => accepted);
            if (acceptanceRequested && result.length && isCurrent() && result[0].insertText.startsWith(accepted)) {
                const [item] = result;
                const remainder = item.insertText.slice(accepted.length);
                accepting = true;
                if (remainder && await editor.edit(edit => edit.insert(cursor, remainder))) {
                    dispose();
                    if (item.command)
                        await vscode.commands.executeCommand(item.command.command, ...item.command.arguments);
                    return;
                }
                accepting = false;
            }
            publish(result, false);
        }
        catch {
            accepting = false;
            publish([], false);
        }
        finally {
            if (ready) {
                ready([]);
                ready = undefined;
            }
        }
    })();
    return session;
}

exports.streamCommentSuggestion = streamCommentSuggestion;
exports.registerCommentPreviewCommands = registerCommentPreviewCommands;
