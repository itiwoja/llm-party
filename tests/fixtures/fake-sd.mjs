#!/usr/bin/env node
// sd-server の代役。実機の sd-server を動かさずに、読み込み・生成・取り消しの流れを試す
// FAKE_SD_MODE: ok（すぐ完了）/ fail（起動直後に終了）/ slow（完了せず、取り消しを待つ）
import { createServer } from "node:http";

const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name) + 1];
const mode = process.env.FAKE_SD_MODE ?? "ok";
if (mode === "fail") {
  console.error("error: failed to load model");
  process.exit(1);
}
// 受け取った引数を1行で標準エラーに出す（テストが読む）
console.error(`args: ${args.join(" ")}`);
const hasParts = ["--diffusion-model", "--llm", "--vae", "--tokenizer"].every((name) => args.includes(name));
if (!args.includes("-m") && !hasParts) {
  console.error("model is required");
  process.exit(1);
}
const port = Number(arg("--listen-port"));
// 1x1 の PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64").toString("base64");
const jobs = new Map();
let counter = 0;

const send = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && url.pathname === "/sdcpp/v1/capabilities") return send(res, 200, { model: { id: "fake" } });
  if (req.method === "POST" && url.pathname === "/sdcpp/v1/img_gen") {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      const id = `job_${++counter}`;
      jobs.set(id, { id, status: mode === "slow" ? "generating" : "completed", body, cancelled: false });
      send(res, 202, { id, kind: "img_gen", status: "queued", created: Date.now(), poll_url: `/sdcpp/v1/jobs/${id}` });
    });
    return;
  }
  const job = url.pathname.match(/^\/sdcpp\/v1\/jobs\/([^/]+)(\/cancel)?$/);
  if (job) {
    const found = jobs.get(job[1]);
    if (!found) return send(res, 404, { error: "not found" });
    if (job[2] && req.method === "POST") {
      found.cancelled = true;
      found.status = "cancelled";
      return send(res, 200, { id: found.id, status: "cancelled", cancel_requested: true });
    }
    const base = { id: found.id, kind: "img_gen", status: found.status, created: 1, started: 2, completed: found.status === "completed" ? 3 : null, queue_position: 0, error: null };
    if (found.status === "completed") base.result = { output_format: "png", images: [{ index: 0, b64_json: PNG }] };
    else base.result = null;
    if (found.status === "cancelled") base.error = { code: "cancelled", message: "job cancelled by client" };
    return send(res, 200, base);
  }
  send(res, 404, { error: "not found" });
}).listen(port, "127.0.0.1");
