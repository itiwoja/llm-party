import { createServer } from "node:http";
import path from "node:path";
import express from "express";
import { createApp } from "./app";
import { loadLocalConfig } from "./config";
import { createContext } from "./context";
import { logger, pruneLogs } from "./logger";
import { ignoredOverrideWarning } from "./runtime/resolver";
import { localRoutes } from "./routes/local";
import { loadOrCreateToken } from "./token";

/** localhost 段階の起動の入口（12） */
const config = loadLocalConfig();
const token = loadOrCreateToken(config.dataDir);
const logsDir = path.join(config.dataDir, "logs");
logger.init(logsDir);
pruneLogs(logsDir);
const context = createContext({ bin: config.llamaBin, backend: config.backend, dataDir: config.dataDir, sdBin: config.sdBin });
const app = createApp({ port: config.port, token, context, extraRoutes: localRoutes });
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
  logger.info(`起動 port=${config.port} backend=${config.backend}`);
  console.log(`LLM-PARTY: http://127.0.0.1:${config.port}/#token=${token}`);
  if (!config.llamaBin) console.log("llama-server は未指定です。取得していなければ、初回のモデル読み込みで自動に取得します（ADR-011）");
  else {
    const ignored = ignoredOverrideWarning(config.llamaBin);
    if (ignored) console.warn(ignored);
  }
  if (!config.sdBin) console.warn("LLM_PARTY_SD_BIN が未設定です。画像生成は使えません");
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
