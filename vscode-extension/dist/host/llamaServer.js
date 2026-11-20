"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LlamaServer = void 0;
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const node_net_1 = require("node:net");
const promises_1 = require("node:timers/promises");
const node_util_1 = require("node:util");
const client_1 = require("./client");
async function availablePort() {
    const server = (0, node_net_1.createServer)();
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            server.close(error => {
                if (error || !address || typeof address === "string") {
                    reject(error ?? new Error("Could not allocate loopback port"));
                }
                else {
                    resolve(address.port);
                }
            });
        });
    });
}
class LlamaServer {
    executable;
    modelPath;
    contextLength;
    gpuLayers;
    minimumBuild;
    paged;
    process;
    pending;
    exited;
    stopping;
    abort = new AbortController();
    healthy = false;
    constructor(executable, modelPath, contextLength, gpuLayers = 0, minimumBuild = "local", paged = false) {
        this.executable = executable;
        this.modelPath = modelPath;
        this.contextLength = contextLength;
        this.gpuLayers = gpuLayers;
        this.minimumBuild = minimumBuild;
        this.paged = paged;
    }
    get alive() {
        return this.healthy && !this.abort.signal.aborted
            && this.process?.exitCode === null && this.process.signalCode === null;
    }
    start() {
        this.pending ??= this.launch().catch(async (error) => {
            await this.dispose();
            throw error;
        });
        return this.pending;
    }
    async launch() {
        const gpuLayers = this.paged ? 0 : this.gpuLayers;
        const env = { ...process.env };
        if (gpuLayers === 0)
            env.GGML_METAL_DEVICES = "0";
        if (this.paged) {
            // Keep both older and newer llama.cpp builds on unlocked, file-backed weights.
            delete env.LLAMA_ARG_MLOCK;
            delete env.LLAMA_ARG_DIO;
            env.LLAMA_ARG_MMAP = "1";
            env.LLAMA_ARG_LOAD_MODE = "mmap";
        }
        if (this.minimumBuild !== "local") {
            const required = /^b(\d+)$/.exec(this.minimumBuild);
            const { stdout, stderr } = await (0, node_util_1.promisify)(node_child_process_1.execFile)(this.executable, ["--version"], {
                env, timeout: 5000, signal: this.abort.signal, windowsHide: true,
            });
            const actual = /version:\s*b?(\d+)/i.exec(stdout + stderr);
            if (!required || !actual || Number(actual[1]) < Number(required[1])) {
                throw new Error(`Model requires llama.cpp ${this.minimumBuild}`);
            }
        }
        const port = await availablePort();
        const apiKey = (0, node_crypto_1.randomUUID)();
        this.abort.signal.throwIfAborted();
        const child = (0, node_child_process_1.spawn)(this.executable, [
            "--host", "127.0.0.1", "--port", String(port), "--model", this.modelPath,
            "--ctx-size", String(this.contextLength), "--n-gpu-layers", String(gpuLayers),
            "--parallel", "1", "--api-key", apiKey, "--cache-ram", "0",
            ...(gpuLayers === 0 ? ["--device", "none"] : []),
            ...(this.paged ? ["--no-repack", "--no-warmup"] : []),
        ], { env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
        this.process = child;
        this.exited = new Promise(resolve => { child.once("close", () => resolve()); });
        let error;
        let diagnostics = "";
        child.stderr.on("data", chunk => { diagnostics = (diagnostics + String(chunk)).slice(-2000); });
        child.on("error", cause => { error = cause; });
        const origin = `http://127.0.0.1:${port}`;
        const deadline = Date.now() + (this.paged ? 120_000 : 30_000);
        while (Date.now() < deadline) {
            this.abort.signal.throwIfAborted();
            if (error)
                throw error;
            if (child.exitCode !== null || child.signalCode !== null)
                break;
            const response = await fetch(origin + "/health", {
                signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(500)]),
                redirect: "error",
            }).catch(() => undefined);
            if (response?.ok && child.exitCode === null && child.signalCode === null) {
                this.healthy = true;
                return new client_1.LlamaClient(origin, apiKey, this.contextLength);
            }
            await (0, promises_1.setTimeout)(100, undefined, { signal: this.abort.signal });
        }
        throw new Error(`llama-server failed to become ready. ${diagnostics}`);
    }
    dispose() {
        this.abort.abort();
        this.stopping ??= this.terminate();
        return this.stopping;
    }
    async terminate() {
        const child = this.process;
        if (!child || child.exitCode !== null || child.signalCode !== null)
            return;
        const force = setTimeout(() => child.kill("SIGKILL"), 1500);
        try {
            child.kill();
            await this.exited;
        }
        finally {
            clearTimeout(force);
        }
    }
}
exports.LlamaServer = LlamaServer;
