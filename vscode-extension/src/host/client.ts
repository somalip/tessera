export interface Message {
  role: "user" | "system" | "assistant";
  content: string;
}

export interface InferenceHost {
  complete(prompt: string, stop: string[], signal: AbortSignal): Promise<string>;
  chat(messages: Message[], signal: AbortSignal): AsyncIterable<string>;
}

type ResponseChunk = { choices: Array<{ text?: string; delta?: { content?: string } }> };

export class LlamaClient implements InferenceHost {
  constructor(private readonly origin: string, private readonly apiKey: string) {}

  private async post(path: string, body: object, signal: AbortSignal) {
    const response = await fetch(this.origin + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      redirect: "error",
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw new Error(`llama-server returned HTTP ${response.status}`);
    return response;
  }

  async complete(prompt: string, stop: string[], signal: AbortSignal): Promise<string> {
    const response = await this.post("/v1/completions", {
      prompt, stop, max_tokens: 96, temperature: 0, stream: false,
    }, signal);
    return ((await response.json()) as ResponseChunk).choices[0]?.text ?? "";
  }

  async *chat(messages: Message[], signal: AbortSignal): AsyncIterable<string> {
    const response = await this.post("/v1/chat/completions", {
      messages, max_tokens: 512, stream: true,
    }, signal);
    if (!response.body) throw new Error("llama-server returned an empty response");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        if (done && buffer) lines.push(buffer);
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") return;
          const content = (JSON.parse(data) as ResponseChunk).choices[0]?.delta?.content;
          if (content) yield content;
        }
        if (done) return;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}
