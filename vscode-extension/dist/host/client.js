"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LlamaClient = void 0;
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
                yield JSON.parse(data);
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
    constructor(origin, apiKey, contextLength) {
        this.origin = origin;
        this.apiKey = apiKey;
        this.contextLength = contextLength;
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
    async complete(prompt, stop, signal, onFirstToken, onProgress) {
        const response = await this.post("/v1/completions", {
            prompt, stop, max_tokens: 96, temperature: 0, stream: true,
        }, signal);
        if (response.headers.get("Content-Type")?.includes("application/json")) {
            const text = (await response.json()).choices[0]?.text ?? "";
            if (text)
                onFirstToken?.();
            return text;
        }
        let text = "";
        for await (const event of events(response)) {
            const chunk = event.choices[0]?.text;
            if (chunk && !text)
                onFirstToken?.();
            if (chunk) {
                text += chunk;
                onProgress?.(text);
            }
        }
        return text;
    }
    async *chat(messages, signal) {
        const response = await this.post("/v1/chat/completions", {
            messages, max_tokens: Math.min(512, Math.floor(this.contextLength / 4)), stream: true,
        }, signal);
        for await (const event of events(response)) {
            const content = event.choices[0]?.delta?.content;
            if (content)
                yield content;
        }
    }
}
exports.LlamaClient = LlamaClient;
