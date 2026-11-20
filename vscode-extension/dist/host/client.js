"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LlamaClient = exports.IncompleteCodeError = void 0;
class IncompleteCodeError extends Error {
}
exports.IncompleteCodeError = IncompleteCodeError;
const streamOptions = { include_usage: true };
function readUsage(event, usage) {
    const tokens = event.usage?.completion_tokens ?? event.timings?.predicted_n;
    const speed = event.timings?.predicted_per_second;
    if (typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0)
        usage.outputTokens = tokens;
    if (typeof speed === "number" && Number.isFinite(speed) && speed > 0)
        usage.tokensPerSecond = speed;
}
async function* events(response) {
    if (!response.body)
        throw new Error("llama-server returned an empty response");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
        for (;;) {
            const { value, done } = await reader.read();
            buffer += decoder.decode(value, { stream: !done });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            if (done && buffer)
                lines.push(buffer);
            for (const line of lines) {
                if (!line.startsWith("data:"))
                    continue;
                const data = line.slice(5).trim();
                if (data === "[DONE]")
                    return;
                const event = JSON.parse(data);
                if (event.error)
                    throw new Error(event.error.message ?? "llama-server returned an inference error");
                yield event;
            }
            if (done)
                return;
        }
    }
    finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
}
class LlamaClient {
    origin;
    apiKey;
    contextLength;
    onUsage;
    constructor(origin, apiKey, contextLength, onUsage) {
        this.origin = origin;
        this.apiKey = apiKey;
        this.contextLength = contextLength;
        this.onUsage = onUsage;
    }
    async post(path, body, signal) {
        const response = await fetch(this.origin + path, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
            redirect: "error",
            body: JSON.stringify(body),
            signal,
        });
        if (!response.ok)
            throw new Error(`llama-server returned HTTP ${response.status}`);
        return response;
    }
    async complete(prompt, stop, signal, onFirstToken, maxTokens = 96) {
        const response = await this.post("/v1/completions", {
            prompt, stop, max_tokens: maxTokens, temperature: 0, stream: true, stream_options: streamOptions,
        }, signal);
        const usage = {};
        if (response.headers.get("Content-Type")?.includes("application/json")) {
            const event = (await response.json());
            const text = event.choices?.[0]?.text ?? "";
            readUsage(event, usage);
            if (text)
                onFirstToken?.();
            if (!signal.aborted)
                this.onUsage?.(usage);
            return text;
        }
        let text = "";
        for await (const event of events(response)) {
            readUsage(event, usage);
            const chunk = event.choices?.[0]?.text;
            if (chunk && !text)
                onFirstToken?.();
            text += chunk ?? "";
        }
        if (!signal.aborted)
            this.onUsage?.(usage);
        return text;
    }
    async *chat(messages, signal, codeTokens) {
        const response = await this.post("/v1/chat/completions", {
            messages, max_tokens: codeTokens ?? Math.min(512, Math.floor(this.contextLength / 4)), stream: true,
            stream_options: streamOptions,
            ...(codeTokens === undefined ? {} : { temperature: 0, chat_template_kwargs: { enable_thinking: false } }),
        }, signal);
        const usage = {};
        let finished = false;
        for await (const event of events(response)) {
            readUsage(event, usage);
            const choice = event.choices?.[0];
            const content = choice?.delta?.content;
            if (content)
                yield content;
            if (choice?.finish_reason === "stop")
                finished = true;
        }
        if (!signal.aborted)
            this.onUsage?.(usage);
        if (codeTokens !== undefined && !finished) {
            throw new IncompleteCodeError("The local model did not finish generating the inline code.");
        }
    }
}
exports.LlamaClient = LlamaClient;
