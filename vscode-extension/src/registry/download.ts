import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import Ajv from "ajv/dist/2020";
import * as zip from "yauzl";
import { manifestSchema, registrySchema, type Manifest, type Registry } from "../contracts";
import { modelMemoryBytes } from "../host/memory";

const validator = new Ajv();
const isRegistry = validator.compile<Registry>(registrySchema);
const isManifest = validator.compile<Manifest>(manifestSchema);
const limit = 1_000_000_000;
const maxMetadata = 1_000_000;
const versionPattern = /^\d+\.\d+\.\d+$/;
const idPattern = /^[a-z0-9][a-z0-9-]*$/;
type ModelEntry = Registry["models"][number];
export interface InstalledModel { manifest: Manifest; path: string; memoryBytes: number }

export function verifyIndex(content: Buffer, signature: Buffer, publicKey: string): Registry {
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== "ed25519" || !verify(null, content, key, signature)) {
    throw new Error("Registry signature verification failed");
  }
  const index: unknown = JSON.parse(content.toString("utf8"));
  if (!isRegistry(index)) throw new Error("Invalid registry schema");
  const keys = index.models.map(({ id, version }) => `${id}/${version}`);
  if (new Set(keys).size !== keys.length) throw new Error("Duplicate registry version");
  return index;
}

async function download(url: string, maxBytes: number, signal: AbortSignal) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("Registry and model URLs must use HTTPS without credentials");
  }
  const response = await fetch(parsed, { signal, redirect: "error" });
  if (!response.ok || !response.body) throw new Error(`Download returned HTTP ${response.status}`);
  return Readable.from((async function* () {
    const reader = response.body!.getReader();
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maxBytes) throw new Error("Download exceeds its size limit");
        yield Buffer.from(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  })());
}

async function smallDownload(url: string, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of await download(url, maxBytes, signal)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export async function fetchIndex(url: string, key: string, signal: AbortSignal): Promise<Registry> {
  const signature = new URL(url);
  signature.pathname += ".sig";
  const [content, signed] = await Promise.all([
    smallDownload(url, maxMetadata, signal), smallDownload(signature.href, 64, signal),
  ]);
  return verifyIndex(content, signed, key);
}

async function sha256(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

async function extract(archive: string, target: string, signal: AbortSignal): Promise<void> {
  const file = await new Promise<zip.ZipFile>((resolve, reject) => {
    zip.open(archive, { lazyEntries: true, strictFileNames: true, autoClose: false },
      (error, opened) => error || !opened ? reject(error) : resolve(opened));
  });
  await new Promise<void>((resolve, reject) => {
    const seen = new Set<string>();
    let total = 0;
    file.on("error", reject);
    file.on("end", () => {
      for (const name of ["manifest.json", "eval_report.json", "LICENSE"]) {
        if (!seen.has(name)) return reject(new Error(`Model package is missing ${name}`));
      }
      resolve();
    });
    file.on("entry", (entry: zip.Entry) => {
      const name = entry.fileName;
      const model = /^model\.[A-Za-z0-9_-]+\.gguf$/.test(name);
      total += entry.uncompressedSize;
      if (seen.has(name) || total >= limit || (!model &&
        (!["manifest.json", "eval_report.json", "LICENSE", "NOTICE"].includes(name)
          || entry.uncompressedSize > maxMetadata))) {
        reject(new Error("Invalid model package entry"));
        return;
      }
      if (model && [...seen].some(existing => existing.endsWith(".gguf"))) {
        reject(new Error("Package contains multiple GGUF files"));
        return;
      }
      seen.add(name);
      file.openReadStream(entry, (error, stream) => {
        if (error || !stream) return reject(error);
        void pipeline(stream, createWriteStream(join(target, name), { flags: "wx" }), { signal })
          .then(() => file.readEntry(), reject);
      });
    });
    file.readEntry();
  }).finally(() => file.close());
}

async function modelAt(directory: string, id: string, version: string): Promise<InstalledModel> {
  const manifest: unknown = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  if (!isManifest(manifest) || manifest.id !== id || manifest.version !== version ||
      !/^[A-Za-z0-9_-]+$/.test(manifest.quant)) throw new Error("Invalid model manifest");
  const path = join(directory, `model.${manifest.quant}.gguf`);
  const file = await stat(path);
  if (!file.isFile() || file.size !== manifest.size_bytes) throw new Error("Invalid model size");
  return { manifest, path, memoryBytes: modelMemoryBytes(file.size, manifest.context_length) };
}

export class ModelStore {
  constructor(private readonly root: string) {}

  private modelRoot(id: string): string {
    if (!idPattern.test(id)) throw new Error("Invalid model ID");
    return join(this.root, id);
  }

  async activate(id: string, version: string): Promise<void> {
    if (!versionPattern.test(version)) throw new Error("Invalid model version");
    const root = this.modelRoot(id);
    const model = await modelAt(join(root, version), id, version);
    if (await sha256(model.path) !== model.manifest.sha256) throw new Error("Installed model SHA-256 mismatch");
    const temporary = await mkdtemp(join(root, ".activation-"));
    try {
      await writeFile(join(temporary, "active"), version);
      await rename(join(temporary, "active"), join(root, "active"));
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  }

  async versions(id: string): Promise<string[]> {
    const entries = await readdir(this.modelRoot(id), { withFileTypes: true });
    return entries.filter(entry => entry.isDirectory() && versionPattern.test(entry.name))
      .map(entry => entry.name);
  }

  async installed(): Promise<InstalledModel[]> {
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root, { withFileTypes: true });
    const models = await Promise.all(entries.filter(entry => entry.isDirectory() && idPattern.test(entry.name))
      .map(async ({ name }) => {
        const root = this.modelRoot(name);
        try {
          const version = await readFile(join(root, "active"), "utf8");
          if (!versionPattern.test(version)) return;
          const model = await modelAt(join(root, version), name, version);
          if (await sha256(model.path) === model.manifest.sha256) return model;
        } catch {
          // An incomplete or damaged install is unavailable.
        }
      }));
    return models.filter(model => model !== undefined);
  }

  async install(entry: ModelEntry, signal: AbortSignal): Promise<void> {
    if (!versionPattern.test(entry.version) || !Number.isSafeInteger(entry.size_bytes)
      || entry.size_bytes <= 0 || entry.size_bytes >= limit) throw new Error("Invalid registry entry");
    const root = this.modelRoot(entry.id);
    await mkdir(root, { recursive: true });
    const staging = await mkdtemp(join(root, ".install-"));
    try {
      const archive = join(staging, "model.tcm");
      await pipeline(await download(entry.url, entry.size_bytes, signal),
        createWriteStream(archive), { signal });
      if ((await stat(archive)).size !== entry.size_bytes || await sha256(archive) !== entry.sha256) {
        throw new Error("Model package SHA-256 or size mismatch");
      }
      const unpacked = join(staging, "package");
      await mkdir(unpacked);
      await extract(archive, unpacked, signal);
      const model = await modelAt(unpacked, entry.id, entry.version);
      if (await sha256(model.path) !== model.manifest.sha256 ||
          JSON.stringify([...model.manifest.language_ids].sort()) !==
          JSON.stringify([...entry.language_ids].sort())) {
        throw new Error("Model weights or languages do not match the signed package");
      }
      signal.throwIfAborted();
      const destination = join(root, entry.version);
      try {
        await rename(unpacked, destination);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "EPERM") throw error;
        const existing = await modelAt(destination, entry.id, entry.version);
        if (JSON.stringify(existing.manifest) !== JSON.stringify(model.manifest)
          || await sha256(existing.path) !== model.manifest.sha256) {
          throw new Error("Installed version differs from the signed package");
        }
      }
      await this.activate(entry.id, entry.version);
    } finally {
      await rm(staging, { force: true, recursive: true });
    }
  }
}
