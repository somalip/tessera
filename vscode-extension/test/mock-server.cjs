#!/usr/bin/env node
const http = require("node:http");

const flag = name => process.argv[process.argv.indexOf(name) + 1];
const server = http.createServer(async (request, response) => {
  if (request.url === "/health") return response.end("{}");
  if (request.url !== "/v1/completions" ||
      request.headers.authorization !== `Bearer ${flag("--api-key")}`) {
    response.writeHead(404).end();
    return;
  }
  let body = "";
  for await (const chunk of request) body += chunk;
  const { prompt } = JSON.parse(body);
  if (prompt.includes("def slow()")) {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write('data: {"choices":[{"text":"return"}]}\n\n');
    const timer = setTimeout(() => response.end("data: [DONE]\n\n"), 5000);
    response.on("close", () => clearTimeout(timer));
    return;
  }
  const text = prompt === "<|fim_prefix|>def f():\n    <|fim_suffix|>\n<|fim_middle|>"
    ? "return 42" : "";
  response.setHeader("Content-Type", "text/event-stream");
  response.write("data: " + JSON.stringify({ choices: [{ text }] }) + "\n\n");
  response.end("data: [DONE]\n\n");
});
server.listen(Number(flag("--port")), flag("--host"));
