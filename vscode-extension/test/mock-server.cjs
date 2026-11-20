#!/usr/bin/env node
const http = require("node:http");

const flag = name => process.argv[process.argv.indexOf(name) + 1];
const server = http.createServer(async (request, response) => {
  if (request.url === "/health") return response.end("{}");
  if (!["/v1/completions", "/v1/chat/completions"].includes(request.url) ||
      request.headers.authorization !== `Bearer ${flag("--api-key")}`) {
    response.writeHead(404).end();
    return;
  }
  let body = "";
  for await (const chunk of request) body += chunk;
  const { prompt, stop, max_tokens, messages } = JSON.parse(body);
  if (request.url === "/v1/chat/completions") {
    const task = /^(?:Actual request|Request): (.+)$/m.exec(messages?.[1]?.content ?? "")?.[1];
    const multiline = task === "Build a JSON export tool." && messages[1].content.includes("Keep UTF-8 names and an --output flag.");
    const project = task === "make a tui snake game" || task === "Build a command-line Pomodoro timer that handles Ctrl-C." || multiline;
    const retry = messages?.[1]?.content.includes("previous answer");
    const partial = task === "make a tui snake game" && !retry;
    const code = task === "make a tui snake game" ? (retry ? "print('Game ready')" : "def main():")
      : task === "loop" ? "for i in range(10):\n    print(i)"
      : task === "Build a command-line Pomodoro timer that handles Ctrl-C." ? "print('Pomodoro timer')"
      : multiline ? "print('JSON export')"
      : task === "return answer" ? "return 42" : undefined;
    if (code && messages[0].content.includes(project ? "complete, runnable Python" : "complete, runnable code") &&
        max_tokens >= 1024 && flag("--model").endsWith("/mock.gguf")) {
      response.setHeader("Content-Type", "text/event-stream");
      const content = "\x60\x60\x60python\n" + code + "\n\x60\x60\x60";
      response.write("data: " + JSON.stringify({ choices: [{ delta: { content } }] }) + "\n\n");
      response.write("data: " + JSON.stringify({ choices: [{ finish_reason: partial ? "length" : "stop" }] }) + "\n\n");
      response.end("data: [DONE]\n\n");
    } else {
      response.writeHead(400).end();
    }
    return;
  }
  const comment = /# Request: (.+)\n# Brief:<\|fim_suffix\|>/.exec(prompt)?.[1];
  if (comment) {
    if (!flag("--model").endsWith("/parsing.gguf") || max_tokens !== 64) {
      response.writeHead(400).end();
      return;
    }
    const text = /return (an|the) answer/i.test(comment) ? "return answer" : "";
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [{ text }] }));
    return;
  }
  if (prompt.includes("def slow()")) {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write('data: {"choices":[{"text":"return"}]}\n\n');
    const timer = setTimeout(() => response.end("data: [DONE]\n\n"), 5000);
    response.on("close", () => clearTimeout(timer));
    return;
  }
  const switchProbe = prompt.includes("# Installation");
  if (switchProbe) {
    const model = flag("--model");
    const text = model.endsWith("/docs.gguf") && prompt.startsWith("<|im_start|>system") &&
      prompt.includes("Install the extension by <CURSOR>") ? "docs"
      : model.endsWith("/parsing.gguf") && prompt.startsWith("<|fim_prefix|>") &&
        prompt.includes("WHERE active = <|fim_suffix|>") ? "parsing"
      : model.endsWith("/mock.gguf") && prompt.startsWith("<|fim_prefix|>") &&
        prompt.includes("    <|fim_suffix|>") && max_tokens === 32 ? "python" : "";
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [{ text }] }));
    return;
  }
  if (prompt.includes('print(bin(num))\n<|fim_suffix|>')) {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [{ text: "print(num)" }] }));
    return;
  }
  const short = prompt === "<|fim_prefix|>def answer():\n    # Return the answer\n    <|fim_suffix|><|fim_middle|>" &&
    max_tokens === 32 && stop.includes("\n");
  const text = short || prompt === "<|fim_prefix|>def f():\n    <|fim_suffix|>\n<|fim_middle|>" ||
    prompt === "<|fim_prefix|>def f():\n    # tessera: return an answer\n    <|fim_suffix|><|fim_middle|>"
    ? "return 42" : "";
  response.setHeader("Content-Type", "text/event-stream");
  response.write("data: " + JSON.stringify({ choices: [{ text }] }) + "\n\n");
  response.end("data: [DONE]\n\n");
});
server.listen(Number(flag("--port")), flag("--host"));
