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
    if (messages?.[0]?.content.startsWith("Classify this coding request.") && max_tokens === 8 &&
        flag("--model").includes("/qwen-coder-chat/")) {
      response.setHeader("Content-Type", "text/event-stream");
      response.end('data: {"choices":[{"delta":{"content":"PARSE"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      return;
    }
    const task = /^(?:Actual request|Request): (.+)$/m.exec(messages?.[1]?.content ?? "")?.[1];
    if (task === "write a for loop") {
      const user = messages[1].content;
      if (!flag("--model").endsWith("/cpp-chat.gguf") || max_tokens !== 768 ||
          !messages[0].content.startsWith("Return only C++20 source code.") ||
          !user.includes("Print the loop index.") || user.includes("Before cursor:")) {
        response.writeHead(400).end();
        return;
      }
      response.setHeader("Content-Type", "text/event-stream");
      const content = user.includes("used a different language")
        ? "#include <iostream>\nint main() {\n    for (int i = 0; i < 10; ++i) {\n        std::cout << i;\n    }\n}"
        : "for (let i = 0; i < 10; ++i) { console.log(i); }";
      response.write("data: " + JSON.stringify({ choices: [{ delta: { content } }] }) + "\n\n");
      response.write('data: {"choices":[{"finish_reason":"stop"}]}\n\n');
      response.end("data: [DONE]\n\n");
      return;
    }
    if (task === "Implement answer") {
      if (!flag("--model").endsWith("/cpp-chat.gguf") || !messages[1].content.startsWith("Language: cpp")) {
        response.writeHead(400).end();
        return;
      }
      response.setHeader("Content-Type", "text/event-stream");
      response.write('data: {"choices":[{"delta":{"content":"int answer() { return 42; }"}}]}\n\n');
      response.write('data: {"choices":[{"finish_reason":"stop"}]}\n\n');
      response.end("data: [DONE]\n\n");
      return;
    }
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
    if (!/\/(parsing|cpp-fim)\.gguf$/.test(flag("--model")) || max_tokens !== 64) {
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
  if (prompt.includes("int test_javascript_guard")) {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [{ text: "console.log(42);" }] }));
    return;
  }
  if (prompt.includes("// Return the C++ answer")) {
    const text = flag("--model").endsWith("/cpp-fim.gguf") && max_tokens === 32 &&
      stop.includes("\n") && prompt.includes("<|fim_suffix|>\n}") ? "return 42;" : "";
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [{ text }] }));
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
