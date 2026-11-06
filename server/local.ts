import { createServer } from "node:http";
import path from "node:path";
import express from "express";
import { createApp } from "./app";
import { loadLocalConfig } from "./config";
import { createContext } from "./context";
import { loadOrCreateToken } from "./token";

/** localhost 段階の起動の入口（12） */
const config = loadLocalConfig();
const token = loadOrCreateToken(config.dataDir);
const context = createContext({ bin: config.llamaBin, backend: config.backend, dataDir: config.dataDir });
const app = createApp({ port: config.port, token, context });
const server = createServer(app);

if (process.env.NODE_ENV === "production") {
  const dist = path.resolve("dist");
  app.use((_req, res, next) => {
    res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'");
    next();
  });
  app.use(express.static(dist));
  app.use((_req, res) => res.sendFile(path.join(dist, "index.html")));
} else {
  const { createServer: createVite } = await import("vite");
  const vite = await createVite({
    server: { middlewareMode: true, hmr: { server }, watch: { usePolling: true, interval: 300 } },
    appType: "spa",
  });
  app.use(vite.middlewares);
}

server.once("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(`ポート ${config.port} は使用中です。LLM_PARTY_PORT で変えるか、使っているプロセスを止めてください`);
  } else {
    console.error(error);
  }
  process.exit(1);
});

// LAN から見えるアドレスでは待ち受けない（NFR-011）
server.listen(config.port, "127.0.0.1", () => {
  console.log(`LLM-PARTY: http://127.0.0.1:${config.port}/#token=${token}`);
  if (!config.llamaBin) console.warn("LLM_PARTY_LLAMA_BIN が未設定です。モデルを読み込むときに失敗します");
});

// Ctrl+C で生成を止めて DB を閉じ、llama-server も止める（12 WSL での違い）
let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  server.closeAllConnections();
  server.close();
  await context.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
