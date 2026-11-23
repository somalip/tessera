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

export function resolveRoute<T extends { manifest: Manifest }>(models: readonly T[], route: Route) {
  const eligible = models.filter(({ manifest }) => manifest.capabilities.includes(route.capability));
  const byId = (id?: string) => eligible.find(({ manifest }) => manifest.id === id);
  const byLanguage = (id?: string) => eligible.find(({ manifest }) => id !== undefined &&
    (manifest.vscode_language_ids.includes(id) || manifest.language_ids.includes(id)));
  const byGlob = eligible.find(({ manifest }) =>
    manifest.file_globs.some(glob => matchesGlob(route.filename.replaceAll("\\", "/"), glob)));
  const match = (model: T | undefined, reason: string) => model && { model, reason };
  const explicit = match(byId(route.override), "Model pin")
    ?? match(byLanguage(route.embedded), `Embedded language · ${route.embedded}`);
  if (explicit) return explicit;
  const generalist = () => match(byId(route.generalist), "Configured generalist");
  const sibling = (language: string) =>
    match(siblings[language]?.map(byLanguage).find(Boolean), `Related language · ${language}`);
  if (route.embedded && ["markdown", "mdx"].includes(route.language) && route.capability === "fim") {
    return sibling(route.embedded) ?? generalist();
  }
  return match(byLanguage(route.project), `Project language · ${route.project}`)
    ?? match(byLanguage(route.language), `Editor language · ${route.language}`)
    ?? match(byGlob, "Filename pattern")
    ?? sibling(route.project ?? route.language)
    ?? generalist();
}

export function selectModel<T extends { manifest: Manifest }>(models: readonly T[], route: Route) {
  return resolveRoute(models, route)?.model;
}
