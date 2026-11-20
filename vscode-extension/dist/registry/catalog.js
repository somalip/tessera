"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.builtInModels = void 0;
exports.upstreamModel = upstreamModel;
const builder_1 = require("../context/builder");
const languages = ["python", "typescript", "typescriptreact", "javascript", "javascriptreact", "cpp", "c",
    "csharp", "go", "java", "kotlin", "php", "ruby", "rust", "shellscript", "sql", "swift"];
function upstreamModel(details) {
    const { id, label, source, size, sha256, capabilities, base, params, quant, context = 2048, automaticCoding } = details;
    const languageIds = automaticCoding ? languages : ["workflow-assigned"];
    const upstreamManifest = {
        id, version: "1.0.0", schema_version: 1, language_ids: languageIds, vscode_language_ids: languageIds,
        file_globs: automaticCoding ? ["**/*.{py,ts,tsx,js,jsx,c,cpp,h,hpp,cs,go,java,kt,php,rb,rs,sh,sql,swift}"]
            : ["**/.tessera-workflow-only"],
        base_model: base, params, quant, size_bytes: size, context_length: context, capabilities,
        min_runtime: { llama_cpp_build: "local" }, prompt_formats: { fim: builder_1.qwenFim, chat_template: "embedded" }, sha256,
    };
    return {
        id, label, version: upstreamManifest.version, url: `https://huggingface.co/${source}`,
        size_bytes: size, language_ids: languageIds, sha256, upstreamManifest,
    };
}
function qwenModel(id, source, size, sha256, capabilities) {
    const entry = upstreamModel({ id, source, size, sha256, capabilities, base: "Qwen2.5-Coder-0.5B",
        params: 500_000_000, quant: "Q4_K_M", automaticCoding: true });
    // Preserve the metadata already used by installed Qwen Coder versions.
    if (entry.upstreamManifest)
        entry.upstreamManifest.prompt_formats.chat_template = "chatml";
    return entry;
}
// The pinned revisions and LFS SHA-256 digests identify the Apache-2.0 upstream GGUFs.
exports.builtInModels = [
    qwenModel("qwen-coder-autocomplete", "bartowski/Qwen2.5-Coder-0.5B-GGUF/resolve/01c1b8072277dfbfd0d051ec95b7a43bb23d2f6a/Qwen2.5-Coder-0.5B-Q4_K_M.gguf", 397_808_128, "fefe9d34df79d3ad3db33519d81112be76096626a5fdb87a98092035dc79ad68", ["fim"]),
    qwenModel("qwen-coder-chat", "Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/ebb2015119c907b064c512bf053e945850b5875f/qwen2.5-coder-0.5b-instruct-q4_k_m.gguf", 491_400_064, "1d9614638d18024d0fbb36575a15f1302a3adf044df10345688ec4f6e1c4ff32", ["chat", "edit"]),
    upstreamModel({ id: "smollm2-router", label: "SmolLM2 360M Instruct",
        source: "bartowski/SmolLM2-360M-Instruct-GGUF/resolve/7be6f65f1db715fe5dc5a4634c0d459b4eed42ec/SmolLM2-360M-Instruct-Q4_K_M.gguf",
        size: 270_590_880, sha256: "2fa3f013dcdd7b99f9b237717fa0b12d75bbb89984cc1274be1471a465bac9c2",
        capabilities: ["chat"], base: "HuggingFaceTB/SmolLM2-360M-Instruct", params: 361_821_120, quant: "Q4_K_M" }),
    upstreamModel({ id: "qwen3-small", label: "Qwen3 0.6B",
        source: "Qwen/Qwen3-0.6B-GGUF/resolve/23749fefcc72300e3a2ad315e1317431b06b590a/Qwen3-0.6B-Q8_0.gguf",
        size: 639_446_688, sha256: "9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031",
        capabilities: ["chat", "edit"], base: "Qwen/Qwen3-0.6B", params: 596_049_920, quant: "Q8_0" }),
];
