import { matchesGlob } from "node:path";
import type { Manifest } from "../contracts";

const siblings: Record<string, string[]> = {
  javascript: ["typescript"], javascriptreact: ["typescriptreact", "typescript"],
  typescript: ["javascript"], typescriptreact: ["typescript", "javascriptreact"],
  c: ["cpp"], cpp: ["c"], java: ["kotlin"], kotlin: ["java"],
};

interface Route {
  language: string;
  filename: string;
  embedded?: string;
  project?: string;
  override?: string;
  generalist?: string;
  capability: Manifest["capabilities"][number];
}

export function selectModel<T extends { manifest: Manifest }>(models: readonly T[], route: Route) {
  const eligible = models.filter(({ manifest }) => manifest.capabilities.includes(route.capability));
  const byId = (id?: string) => eligible.find(({ manifest }) => manifest.id === id);
  const byLanguage = (id?: string) => eligible.find(({ manifest }) => id !== undefined &&
    (manifest.vscode_language_ids.includes(id) || manifest.language_ids.includes(id)));
  const byGlob = eligible.find(({ manifest }) =>
    manifest.file_globs.some(glob => matchesGlob(route.filename.replaceAll("\\", "/"), glob)));
  return byId(route.override) ?? byLanguage(route.embedded) ?? byLanguage(route.project)
    ?? byLanguage(route.language) ?? byGlob
    ?? (siblings[route.project ?? route.language] ?? []).map(byLanguage).find(Boolean)
    ?? byId(route.generalist);
}
