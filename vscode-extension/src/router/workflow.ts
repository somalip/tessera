import type { Manifest } from "../contracts";
import type { InstalledModel } from "../registry/download";

export const workflowKey = "workflows";
export const stageCapabilities = { router: "chat", autocomplete: "fim", parser: "fim", generator: "chat" } as const;
export type Stage = keyof typeof stageCapabilities;
export interface Workflow {
  router: string;
  autocomplete: string;
  parser: string;
  generator: string;
}
export type Workflows = Record<string, Workflow>;

export function workflowLanguage(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const entered = value.trim();
  const name = entered.toLowerCase();
  if (name === "c++" || name === "c/c++") return "cpp";
  if (name === "c#") return "csharp";
  if (name === "cpp" || name === "python" || name === "javascript" || name === "typescript") return name;
  if (/^(?:\*|[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63})$/.test(entered)) return entered;
}

export function workflowForLanguage(workflows: Workflows, language: string): Workflow | undefined {
  return Object.hasOwn(workflows, language) ? workflows[language] : workflows["*"];
}

export function byCapability(models: readonly InstalledModel[], id: string, capability: Manifest["capabilities"][number]) {
  return models.find(({ manifest }) => manifest.id === id && manifest.capabilities.includes(capability));
}

export function validateWorkflow(value: unknown, models: readonly InstalledModel[]): Workflow {
  if (!value || typeof value !== "object") throw new Error("Invalid workflow");
  const result: Workflow = { router: "", autocomplete: "", parser: "", generator: "" };
  for (const stage of Object.keys(stageCapabilities) as Stage[]) {
    const id: unknown = (value as Record<string, unknown>)[stage];
    if (typeof id !== "string" || (id && !byCapability(models, id, stageCapabilities[stage]))) {
      throw new Error(`Choose an available model for ${stage}.`);
    }
    result[stage] = id;
  }
  if (result.router && !result.parser) throw new Error("Connect a parser to use a router model.");
  if (result.parser && !result.generator) throw new Error("Connect the parser to a generator.");
  if (!result.autocomplete && !result.generator) throw new Error("Connect an autocomplete model or a generator.");
  return result;
}
