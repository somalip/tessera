"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.selectModel = selectModel;
const node_path_1 = require("node:path");
const siblings = {
    javascript: ["typescript"], javascriptreact: ["typescriptreact", "typescript"],
    typescript: ["javascript"], typescriptreact: ["typescript", "javascriptreact"],
    c: ["cpp"], cpp: ["c"], java: ["kotlin"], kotlin: ["java"],
};
function selectModel(models, route) {
    const eligible = models.filter(({ manifest }) => manifest.capabilities.includes(route.capability));
    const byId = (id) => eligible.find(({ manifest }) => manifest.id === id);
    const byLanguage = (id) => eligible.find(({ manifest }) => id !== undefined &&
        (manifest.vscode_language_ids.includes(id) || manifest.language_ids.includes(id)));
    const byGlob = eligible.find(({ manifest }) => manifest.file_globs.some(glob => (0, node_path_1.matchesGlob)(route.filename.replaceAll("\\", "/"), glob)));
    return byId(route.override) ?? byLanguage(route.embedded) ?? byLanguage(route.project)
        ?? byLanguage(route.language) ?? byGlob
        ?? (siblings[route.project ?? route.language] ?? []).map(byLanguage).find(Boolean)
        ?? byId(route.generalist);
}
