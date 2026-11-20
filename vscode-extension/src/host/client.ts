export interface Message {
  role: "user" | "system" | "assistant";
  content: string;
}

export interface InferenceHost {
  complete(prompt: string, stop: string[], signal: AbortSignal, onFirstToken?: () => void, maxTokens?: number): Promise<string>;
  chat(messages: Message[], signal: AbortSignal, codeTokens?: number): AsyncIterable<string>;
}

export class IncompleteCodeError extends Error {}

export interface InferenceUsage {
  outputTokens?: number;
  tokensPerSecond?: number;
}

const streamOptions = { include_usage: true };

type ResponseChunk = {
  usage?: { completion_tokens?: number };
  timings?: { predicted_n?: number; predicted_per_second?: number };
  choices?: Array<{ text?: string; delta?: { content?: string }; finish_reason?: string }>;
  error?: { message?: string };
};

function readUsage(event: ResponseChunk, usage: InferenceUsage): void {
  const tokens = event.usage?.completion_tokens ?? event.timings?.predicted_n;
  const speed = event.timings?.predicted_per_second;
  if (typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0) usage.outputTokens = tokens;
  if (typeof speed === "number" && Number.isFinite(speed) && speed > 0) usage.tokensPerSecond = speed;
}

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
    private readonly onUsage?: (usage: InferenceUsage) => void,
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
      prompt, stop, max_tokens: maxTokens, temperature: 0, stream: true, stream_options: streamOptions,
    }, signal);
    const usage: InferenceUsage = {};
    if (response.headers.get("Content-Type")?.includes("application/json")) {
      const event = (await response.json()) as ResponseChunk;
      const text = event.choices?.[0]?.text ?? "";
      readUsage(event, usage);
      if (text) onFirstToken?.();
      if (!signal.aborted) this.onUsage?.(usage);
      return text;
    }
    let text = "";
    for await (const event of events(response)) {
      readUsage(event, usage);
      const chunk = event.choices?.[0]?.text;
      if (chunk && !text) onFirstToken?.();
      text += chunk ?? "";
    }
    if (!signal.aborted) this.onUsage?.(usage);
    return text;
  }

  async *chat(messages: Message[], signal: AbortSignal, codeTokens?: number): AsyncIterable<string> {
    const response = await this.post("/v1/chat/completions", {
      messages, max_tokens: codeTokens ?? Math.min(512, Math.floor(this.contextLength / 4)), stream: true,
      stream_options: streamOptions,
      ...(codeTokens === undefined ? {} : { temperature: 0, chat_template_kwargs: { enable_thinking: false } }),
    }, signal);
    const usage: InferenceUsage = {};
    let finished = false;
    for await (const event of events(response)) {
      readUsage(event, usage);
      const choice = event.choices?.[0];
      const content = choice?.delta?.content;
      if (content) yield content;
      if (choice?.finish_reason === "stop") finished = true;
    }
    if (!signal.aborted) this.onUsage?.(usage);
    if (codeTokens !== undefined && !finished) {
      throw new IncompleteCodeError("The local model did not finish generating the inline code.");
    }
  }
}
