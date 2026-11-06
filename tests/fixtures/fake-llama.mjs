#!/usr/bin/env node
// llama-server の代役。GPU なしで起動・ストリーム・異常終了を試す
import { readFileSync } from "node:fs";
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

// FAKE_LLAMA_SCRIPT=<JSON ファイル> のとき、リクエストごとに決めた応答を返す（エージェントのテスト用）。
// 並びは [{ reasoning?: 文字列の配列（1 要素を 1 チャンクで流す）, content?, toolCalls?: [{ id, name, arguments: 文字列 | オブジェクト }], times?: 回数, loop?: true }]。
// usage は応答の usage の上書き（文脈の計測のテスト用）。arguments は 3 つに分けて流す。loop は残りのリクエストすべて
const script = process.env.FAKE_LLAMA_SCRIPT ? JSON.parse(readFileSync(process.env.FAKE_LLAMA_SCRIPT, "utf8")) : null;
let scripted = 0;
function pickStep() {
  let rest = scripted++;
  for (const step of script) {
    const times = step.loop ? Infinity : (step.times ?? 1);
    if (rest < times) return step;
    rest -= times;
  }
  return script.at(-1);
}
async function respondScripted(res, step) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const thought of step.reasoning ?? []) chunk(res, { choices: [{ delta: { reasoning_content: thought } }] });
  if (step.content) chunk(res, { choices: [{ delta: { content: step.content } }] });
  (step.toolCalls ?? []).forEach((call, index) => {
    const raw = typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {});
    const size = Math.ceil(raw.length / 3);
    chunk(res, { choices: [{ delta: { tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: "" } }] } }] });
    for (let at = 0; at < raw.length; at += size) {
      chunk(res, { choices: [{ delta: { tool_calls: [{ index, function: { arguments: raw.slice(at, at + size) } }] } }] });
    }
  });
  chunk(res, { choices: [{ delta: {}, finish_reason: step.toolCalls?.length ? "tool_calls" : "stop" }] });
  chunk(res, { choices: [], usage: step.usage ?? { prompt_tokens: 10, completion_tokens: 3 }, timings: { predicted_per_second: 30.5 } });
  res.end("data: [DONE]\n\n");
}

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
  // 1 文字を 1 トークンとして数える
  if (req.url === "/tokenize") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ tokens: [...body.content].map(() => 0) }));
    return;
  }
  console.log(`REQUEST ${raw}`);
  if (script) {
    await respondScripted(res, pickStep());
    return;
  }
  if (mode === "overflow") {
    res.writeHead(400).end(JSON.stringify({ error: { code: 400, message: "request (2082 tokens) exceeds the available context size (2048 tokens), try increasing it" } }));
    return;
  }
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
