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
  const text = prompt === "<|fim_prefix|>def f():\n    <|fim_suffix|>\n<|fim_middle|>"
    ? "return 42" : "";
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ choices: [{ text }] }));
});
server.listen(Number(flag("--port")), flag("--host"));
