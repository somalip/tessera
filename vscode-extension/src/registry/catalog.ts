import type { Manifest, Registry } from "../contracts";
import { qwenFim } from "../context/builder";

export type CatalogEntry = Registry["models"][number] & { upstreamManifest?: Manifest };

const languages = ["python", "typescript", "typescriptreact", "javascript", "javascriptreact", "cpp", "c",
  "csharp", "go", "java", "kotlin", "php", "ruby", "rust", "shellscript", "sql", "swift"];

function qwenModel(
  id: string, source: string, size: number, sha256: string, capabilities: Manifest["capabilities"],
): CatalogEntry {
  const upstreamManifest: Manifest = {
    id, version: "1.0.0", schema_version: 1, language_ids: languages, vscode_language_ids: languages,
    file_globs: ["**/*.{py,ts,tsx,js,jsx,c,cpp,h,hpp,cs,go,java,kt,php,rb,rs,sh,sql,swift}"], base_model: "Qwen2.5-Coder-0.5B", params: 500_000_000,
    quant: "Q4_K_M", size_bytes: size, context_length: 2048, capabilities,
    min_runtime: { llama_cpp_build: "local" }, prompt_formats: { fim: qwenFim, chat_template: "chatml" }, sha256,
  };
  return {
    id, version: upstreamManifest.version, url: `https://huggingface.co/${source}`,
    size_bytes: size, language_ids: languages, sha256, upstreamManifest,
  };
}

// The pinned revisions and LFS SHA-256 digests identify the Apache-2.0 upstream GGUFs.
export const builtInModels = [
  qwenModel("qwen-coder-autocomplete",
    "bartowski/Qwen2.5-Coder-0.5B-GGUF/resolve/01c1b8072277dfbfd0d051ec95b7a43bb23d2f6a/Qwen2.5-Coder-0.5B-Q4_K_M.gguf",
    397_808_128, "fefe9d34df79d3ad3db33519d81112be76096626a5fdb87a98092035dc79ad68", ["fim"]),
  qwenModel("qwen-coder-chat",
    "Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/ebb2015119c907b064c512bf053e945850b5875f/qwen2.5-coder-0.5b-instruct-q4_k_m.gguf",
    491_400_064, "1d9614638d18024d0fbb36575a15f1302a3adf044df10345688ec4f6e1c4ff32", ["chat", "edit"]),
];
