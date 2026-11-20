"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stageCapabilities = exports.workflowKey = void 0;
exports.workflowLanguage = workflowLanguage;
exports.workflowForLanguage = workflowForLanguage;
exports.byCapability = byCapability;
exports.validateWorkflow = validateWorkflow;
exports.workflowKey = "workflows";
exports.stageCapabilities = { router: "chat", autocomplete: "fim", parser: "fim", generator: "chat" };
function workflowLanguage(value) {
    if (typeof value !== "string")
        return;
    const entered = value.trim();
    const name = entered.toLowerCase();
    if (name === "c++" || name === "c/c++")
        return "cpp";
    if (name === "c#")
        return "csharp";
    if (name === "cpp" || name === "python" || name === "javascript" || name === "typescript")
        return name;
    if (/^(?:\*|[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63})$/.test(entered))
        return entered;
}
function workflowForLanguage(workflows, language) {
    return Object.hasOwn(workflows, language) ? workflows[language] : workflows["*"];
}
function byCapability(models, id, capability) {
    return models.find(({ manifest }) => manifest.id === id && manifest.capabilities.includes(capability));
}
function validateWorkflow(value, models) {
    if (!value || typeof value !== "object")
        throw new Error("Invalid workflow");
    const result = { router: "", autocomplete: "", parser: "", generator: "" };
    for (const stage of Object.keys(exports.stageCapabilities)) {
        const id = value[stage];
        if (typeof id !== "string" || (id && !byCapability(models, id, exports.stageCapabilities[stage]))) {
            throw new Error(`Choose an available model for ${stage}.`);
        }
        result[stage] = id;
    }
    if (result.router && !result.parser)
        throw new Error("Connect a parser to use a router model.");
    if (result.parser && !result.generator)
        throw new Error("Connect the parser to a generator.");
    if (!result.autocomplete && !result.generator)
        throw new Error("Connect an autocomplete model or a generator.");
    return result;
}
