"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ModelStore = void 0;
exports.verifyIndex = verifyIndex;
exports.fetchIndex = fetchIndex;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const node_stream_1 = require("node:stream");
const promises_2 = require("node:stream/promises");
const _2020_1 = __importDefault(require("ajv/dist/2020"));
const zip = __importStar(require("yauzl"));
const contracts_1 = require("../contracts");
const memory_1 = require("../host/memory");
const validator = new _2020_1.default();
const isRegistry = validator.compile(contracts_1.registrySchema);
const isManifest = validator.compile(contracts_1.manifestSchema);
const limit = 1_000_000_000;
const maxMetadata = 1_000_000;
const versionPattern = /^\d+\.\d+\.\d+$/;
const idPattern = /^[a-z0-9][a-z0-9-]*$/;
function verifyIndex(content, signature, publicKey) {
    const key = (0, node_crypto_1.createPublicKey)(publicKey);
    if (key.asymmetricKeyType !== "ed25519" || !(0, node_crypto_1.verify)(null, content, key, signature)) {
        throw new Error("Registry signature verification failed");
    }
    const index = JSON.parse(content.toString("utf8"));
    if (!isRegistry(index))
        throw new Error("Invalid registry schema");
    const keys = index.models.map(({ id, version }) => `${id}/${version}`);
    if (new Set(keys).size !== keys.length)
        throw new Error("Duplicate registry version");
    return index;
}
async function download(url, maxBytes, signal) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
        throw new Error("Registry and model URLs must use HTTPS without credentials");
    }
    const response = await fetch(parsed, { signal, redirect: "error" });
    if (!response.ok || !response.body)
        throw new Error(`Download returned HTTP ${response.status}`);
    return node_stream_1.Readable.from((async function* () {
        const reader = response.body.getReader();
        let length = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                length += value.byteLength;
                if (length > maxBytes)
                    throw new Error("Download exceeds its size limit");
                yield Buffer.from(value);
            }
        }
        finally {
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
        }
    })());
}
async function smallDownload(url, maxBytes, signal) {
    const chunks = [];
    for await (const chunk of await download(url, maxBytes, signal))
        chunks.push(chunk);
    return Buffer.concat(chunks);
}
async function fetchIndex(url, key, signal) {
    const signature = new URL(url);
    signature.pathname += ".sig";
    const [content, signed] = await Promise.all([
        smallDownload(url, maxMetadata, signal), smallDownload(signature.href, 64, signal),
    ]);
    return verifyIndex(content, signed, key);
}
async function sha256(path) {
    const digest = (0, node_crypto_1.createHash)("sha256");
    for await (const chunk of (0, node_fs_1.createReadStream)(path))
        digest.update(chunk);
    return digest.digest("hex");
}
async function extract(archive, target, signal) {
    const file = await new Promise((resolve, reject) => {
        zip.open(archive, { lazyEntries: true, strictFileNames: true, autoClose: false }, (error, opened) => error || !opened ? reject(error) : resolve(opened));
    });
    await new Promise((resolve, reject) => {
        const seen = new Set();
        let total = 0;
        file.on("error", reject);
        file.on("end", () => {
            for (const name of ["manifest.json", "eval_report.json", "LICENSE"]) {
                if (!seen.has(name))
                    return reject(new Error(`Model package is missing ${name}`));
            }
            resolve();
        });
        file.on("entry", (entry) => {
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
                if (error || !stream)
                    return reject(error);
                void (0, promises_2.pipeline)(stream, (0, node_fs_1.createWriteStream)((0, node_path_1.join)(target, name), { flags: "wx" }), { signal })
                    .then(() => file.readEntry(), reject);
            });
        });
        file.readEntry();
    }).finally(() => file.close());
}
async function modelAt(directory, id, version) {
    const manifest = JSON.parse(await (0, promises_1.readFile)((0, node_path_1.join)(directory, "manifest.json"), "utf8"));
    if (!isManifest(manifest) || manifest.id !== id || manifest.version !== version ||
        !/^[A-Za-z0-9_-]+$/.test(manifest.quant))
        throw new Error("Invalid model manifest");
    const path = (0, node_path_1.join)(directory, `model.${manifest.quant}.gguf`);
    const file = await (0, promises_1.stat)(path);
    if (!file.isFile() || file.size !== manifest.size_bytes)
        throw new Error("Invalid model size");
    return { manifest, path, memoryBytes: (0, memory_1.modelMemoryBytes)(file.size, manifest.context_length) };
}
class ModelStore {
    root;
    constructor(root) {
        this.root = root;
    }
    modelRoot(id) {
        if (!idPattern.test(id))
            throw new Error("Invalid model ID");
        return (0, node_path_1.join)(this.root, id);
    }
    async activate(id, version) {
        if (!versionPattern.test(version))
            throw new Error("Invalid model version");
        const root = this.modelRoot(id);
        const model = await modelAt((0, node_path_1.join)(root, version), id, version);
        if (await sha256(model.path) !== model.manifest.sha256)
            throw new Error("Installed model SHA-256 mismatch");
        const temporary = await (0, promises_1.mkdtemp)((0, node_path_1.join)(root, ".activation-"));
        try {
            await (0, promises_1.writeFile)((0, node_path_1.join)(temporary, "active"), version);
            await (0, promises_1.rename)((0, node_path_1.join)(temporary, "active"), (0, node_path_1.join)(root, "active"));
        }
        finally {
            await (0, promises_1.rm)(temporary, { force: true, recursive: true });
        }
    }
    async versions(id) {
        const entries = await (0, promises_1.readdir)(this.modelRoot(id), { withFileTypes: true });
        return entries.filter(entry => entry.isDirectory() && versionPattern.test(entry.name))
            .map(entry => entry.name);
    }
    async installed() {
        await (0, promises_1.mkdir)(this.root, { recursive: true });
        const entries = await (0, promises_1.readdir)(this.root, { withFileTypes: true });
        const models = await Promise.all(entries.filter(entry => entry.isDirectory() && idPattern.test(entry.name))
            .map(async ({ name }) => {
            const root = this.modelRoot(name);
            try {
                const version = await (0, promises_1.readFile)((0, node_path_1.join)(root, "active"), "utf8");
                if (!versionPattern.test(version))
                    return;
                const model = await modelAt((0, node_path_1.join)(root, version), name, version);
                if (await sha256(model.path) === model.manifest.sha256)
                    return model;
            }
            catch {
                // An incomplete or damaged install is unavailable.
            }
        }));
        return models.filter(model => model !== undefined);
    }
    async install(entry, signal) {
        if (!versionPattern.test(entry.version) || !Number.isSafeInteger(entry.size_bytes)
            || entry.size_bytes <= 0 || entry.size_bytes >= limit)
            throw new Error("Invalid registry entry");
        const root = this.modelRoot(entry.id);
        await (0, promises_1.mkdir)(root, { recursive: true });
        const staging = await (0, promises_1.mkdtemp)((0, node_path_1.join)(root, ".install-"));
        try {
            const archive = (0, node_path_1.join)(staging, "model.tcm");
            await (0, promises_2.pipeline)(await download(entry.url, entry.size_bytes, signal), (0, node_fs_1.createWriteStream)(archive), { signal });
            if ((await (0, promises_1.stat)(archive)).size !== entry.size_bytes || await sha256(archive) !== entry.sha256) {
                throw new Error("Model package SHA-256 or size mismatch");
            }
            const unpacked = (0, node_path_1.join)(staging, "package");
            await (0, promises_1.mkdir)(unpacked);
            await extract(archive, unpacked, signal);
            const model = await modelAt(unpacked, entry.id, entry.version);
            if (await sha256(model.path) !== model.manifest.sha256 ||
                JSON.stringify([...model.manifest.language_ids].sort()) !==
                    JSON.stringify([...entry.language_ids].sort())) {
                throw new Error("Model weights or languages do not match the signed package");
            }
            signal.throwIfAborted();
            const destination = (0, node_path_1.join)(root, entry.version);
            try {
                await (0, promises_1.rename)(unpacked, destination);
            }
            catch (error) {
                const code = error.code;
                if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "EPERM")
                    throw error;
                const existing = await modelAt(destination, entry.id, entry.version);
                if (JSON.stringify(existing.manifest) !== JSON.stringify(model.manifest)
                    || await sha256(existing.path) !== model.manifest.sha256) {
                    throw new Error("Installed version differs from the signed package");
                }
            }
            await this.activate(entry.id, entry.version);
        }
        finally {
            await (0, promises_1.rm)(staging, { force: true, recursive: true });
        }
    }
}
exports.ModelStore = ModelStore;
