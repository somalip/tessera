export interface Message {
  role: "user" | "system" | "assistant";
  content: string;
}

export interface InferenceHost {
  complete(prompt: string, stop: string[], signal: AbortSignal, onFirstToken?: () => void, maxTokens?: number): Promise<string>;
  chat(messages: Message[], signal: AbortSignal, codeTokens?: number): AsyncIterable<string>;
}

export class IncompleteCodeError extends Error {}

type ResponseChunk = {
  choices?: Array<{ text?: string; delta?: { content?: string }; finish_reason?: string }>;
  error?: { message?: string };
};

async function* events(response: Response): AsyncIterable<ResponseChunk> {
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
        const event = JSON.parse(data) as ResponseChunk;
        if (event.error) throw new Error(event.error.message ?? "llama-server returned an inference error");
        yield event;
      }
      if (done) return;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export class LlamaClient implements InferenceHost {
  constructor(
    private readonly origin: string, private readonly apiKey: string,
    private readonly contextLength: number,
  ) {}

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

  async complete(prompt: string, stop: string[], signal: AbortSignal, onFirstToken?: () => void, maxTokens = 96): Promise<string> {
    const response = await this.post("/v1/completions", {
      prompt, stop, max_tokens: maxTokens, temperature: 0, stream: true,
    }, signal);
    if (response.headers.get("Content-Type")?.includes("application/json")) {
      const text = ((await response.json()) as ResponseChunk).choices?.[0]?.text ?? "";
      if (text) onFirstToken?.();
      return text;
    }
    let text = "";
    for await (const event of events(response)) {
      const chunk = event.choices?.[0]?.text;
      if (chunk && !text) onFirstToken?.();
      text += chunk ?? "";
    }
    return text;
  }

  async *chat(messages: Message[], signal: AbortSignal, codeTokens?: number): AsyncIterable<string> {
    const response = await this.post("/v1/chat/completions", {
      messages, max_tokens: codeTokens ?? Math.min(512, Math.floor(this.contextLength / 4)), stream: true,
      ...(codeTokens === undefined ? {} : { temperature: 0, chat_template_kwargs: { enable_thinking: false } }),
    }, signal);
    let finished = false;
    for await (const event of events(response)) {
      const choice = event.choices?.[0];
      const content = choice?.delta?.content;
      if (content) yield content;
      if (choice?.finish_reason === "stop") finished = true;
    }
    if (codeTokens !== undefined && !finished) {
      throw new IncompleteCodeError("The local model did not finish generating the inline code.");
    }
  }
}
