import { createHash } from "node:crypto";
import { upstreamModel } from "./catalog";
import { modelSizeLimit, smallDownload } from "./download";

const origin = "https://huggingface.co";
const repositoryPattern = /^[\w.-]{1,96}\/[\w.-]{1,96}$/;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function isRepository(repo: string): boolean {
  return repositoryPattern.test(repo) && repo.split("/").every(part => part !== "." && part !== "..");
}

export function repositoryFromInput(input: string): { repository: string; revision?: string; file?: string } | undefined {
  if (isRepository(input)) return { repository: input };
  if (!input.includes("://")) return;
  const url = new URL(input);
  const parts = url.pathname.replace(/^\/|\/$/g, "").split("/");
  const repository = parts.slice(0, 2).join("/");
  const message = "Enter a Hugging Face model repository URL, GGUF file URL, publisher/model, or search terms.";
  if (url.origin !== origin || url.username || url.password || !isRepository(repository)) throw new Error(message);
  if (parts.length === 2) return { repository };
  const [, , route, revision, ...filePath] = parts;
  if (!["blob", "resolve"].includes(route) || !/^[\w.-]{1,96}$/.test(revision) || [".", ".."].includes(revision)) {
    throw new Error(message);
  }
  const file = filePath.map(part => decodeURIComponent(part)).join("/");
  if (!/\.gguf$/i.test(file)) throw new Error(message);
  return { repository, revision, file };
}

async function metadata(url: URL): Promise<unknown> {
  return JSON.parse((await smallDownload(url.href, 4_000_000, AbortSignal.timeout(15_000))).toString("utf8"));
}

export async function searchRepositories(query: string): Promise<string[]> {
  const url = new URL("/api/models", origin);
  url.search = new URLSearchParams({ search: query, filter: "gguf", limit: "30" }).toString();
  const result = await metadata(url);
  if (!Array.isArray(result)) throw new Error("Unexpected Hugging Face search response");
  return result.map(record).filter(model => !model.private && !model.gated)
    .map(model => model.id).filter((id): id is string => typeof id === "string" && isRepository(id));
}

export async function repositoryFiles(repository: string, revisionHint?: string) {
  if (!isRepository(repository)) throw new Error("Invalid Hugging Face repository");
  if (revisionHint && (!/^[\w.-]{1,96}$/.test(revisionHint) || [".", ".."].includes(revisionHint))) {
    throw new Error("Invalid model revision");
  }
  const url = new URL(`/api/models/${repository}${revisionHint ? `/revision/${encodeURIComponent(revisionHint)}` : ""}`, origin);
  url.searchParams.set("blobs", "true");
  const info = record(await metadata(url));
  if (info.private || info.gated) throw new Error("Choose a public GGUF repository that can be downloaded without signing in.");
  const revision = info.sha;
  if (typeof revision !== "string" || !/^[a-f0-9]{40}$/.test(revision)) throw new Error("Could not verify the model revision.");
  if (info.pipeline_tag && !["text-generation", "text2text-generation", "conversational"].includes(String(info.pipeline_tag))) {
    throw new Error("Choose a text-generation model for Tessera workflows.");
  }
  const gguf = record(info.gguf);
  const license = record(info.cardData).license;
  const licenseTag = Array.isArray(info.tags) ? info.tags.find(tag => typeof tag === "string" && tag.startsWith("license:")) : undefined;
  const declaredLicense = typeof license === "string" ? license : typeof licenseTag === "string" ? licenseTag.slice(8) : undefined;
  if (!declaredLicense || declaredLicense === "unknown") throw new Error("This repository does not declare a model license.");
  const knownFim = /qwen2[._-]5[ _-]+coder/i.test(repository) && !/instruct|chat/i.test(repository);
  return (Array.isArray(info.siblings) ? info.siblings : []).flatMap(value => {
    const file = record(value);
    const lfs = record(file.lfs);
    const { rfilename: name, size } = file;
    const sha256 = lfs.sha256;
    if (typeof name !== "string" || !/\.gguf$/i.test(name) ||
        name.split("/").some(part => !part || part === "." || part === ".." || part.includes("\\")) ||
        /(?:^|\/)(?:mmproj|mtp[-_.])|\d{5}-of-\d{5}\.gguf$/i.test(name) ||
        typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0 || size >= modelSizeLimit ||
        lfs.size !== size || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) return [];
    const slug = name.split("/").at(-1)!.toLowerCase().replace(/\.gguf$/, "").replace(/[^a-z0-9]+/g, "-").slice(0, 54);
    const suffix = createHash("sha256").update(`${repository}/${revision}/${name}`).digest("hex").slice(0, 12);
    return [{
      name, license: declaredLicense, architecture: typeof gguf.architecture === "string" ? gguf.architecture : undefined,
      entry: upstreamModel({
        id: `hf-${slug}-${suffix}`, label: name, base: repository,
        source: `${repository}/resolve/${revision}/${name.split("/").map(encodeURIComponent).join("/")}`,
        size, sha256, quant: /[._-]((?:IQ|Q|TQ)\d[A-Z0-9_]*)\.gguf$/i.exec(name)?.[1] ?? "GGUF",
        params: typeof gguf.total === "number" && Number.isSafeInteger(gguf.total) && gguf.total > 0 ? gguf.total : 1,
        context: typeof gguf.context_length === "number" && gguf.context_length > 0
          ? Math.min(4096, Math.floor(gguf.context_length)) : 2048,
        capabilities: knownFim ? ["fim"] : ["chat", "edit"],
      }),
    }];
  }).sort((a, b) => a.entry.size_bytes - b.entry.size_bytes);
}
