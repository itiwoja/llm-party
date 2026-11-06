#!/usr/bin/env node
// llama-server の代役。GPU なしで起動・ストリーム・異常終了を試す
import { createServer } from "node:http";

const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name) + 1];
const mode = process.env.FAKE_LLAMA_MODE ?? "ok";
if (mode === "fail") {
  console.error("error: not enough VRAM");
  process.exit(1);
}
if (args.includes("--list-args")) process.exit(0);

const apiKey = arg("--api-key");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const chunk = (res, data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

createServer(async (req, res) => {
  if (req.url === "/health") {
    if (mode === "hang") {
      res.writeHead(503).end();
      return;
    }
    res.writeHead(200).end("{}");
    return;
  }
  if (req.headers.authorization !== `Bearer ${apiKey}`) {
    res.writeHead(401).end();
    return;
  }
  let raw = "";
  for await (const part of req) raw += part;
  const body = JSON.parse(raw);
  console.log(`REQUEST ${raw}`);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  if (body.chat_template_kwargs?.enable_thinking) {
    chunk(res, { choices: [{ delta: { reasoning_content: "考え中" } }] });
  }
  const words = mode === "slow" ? Array(100).fill("あ") : ["こん", "にち", "は"];
  for (const [index, word] of words.entries()) {
    if (mode === "die" && index === 1) process.exit(9);
    chunk(res, { choices: [{ delta: { content: word } }], timings: { cache_n: 2, prompt_n: 8, predicted_n: index + 1, predicted_per_second: 30.5 } });
    if (mode === "slow") await sleep(50);
  }
  chunk(res, { choices: [{ delta: {}, finish_reason: mode === "length" ? "length" : "stop" }] });
  chunk(res, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 }, timings: { predicted_per_second: 30.5 } });
  res.end("data: [DONE]\n\n");
}).listen(Number(arg("--port")), "127.0.0.1");
