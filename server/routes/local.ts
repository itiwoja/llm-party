import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { z } from "zod";
import type { Context } from "../context";
import { readHfToken, writeHfToken } from "../hf/token";
import { parse } from "./parse";

const { version } = JSON.parse(readFileSync(path.resolve(fileURLToPath(import.meta.url), "../../../package.json"), "utf8")) as { version: string };

/** localhost 段階の起動の入口でだけ載せる（API-093〜094） */
export function localRoutes({ dataDir }: Context): Router {
  const api = Router();

  api.get("/local/info", (_req, res) => {
    // llamaBuild の取得方法は設計にないので null（報告済みの未決事項）
    res.json({ version, llamaBuild: null, isPackaged: false, dataDir, logsDir: path.join(dataDir, "logs") });
  });

  api.get("/local/hf-token", (_req, res) => {
    res.json({ has: readHfToken(dataDir) !== null });
  });
  api.put("/local/hf-token", (req, res) => {
    // ヘッダーに入れるので、改行や空白を含む値は通さない
    const { token } = parse(z.object({ token: z.string().trim().regex(/^[\x21-\x7e]+$/).nullable() }), req.body);
    writeHfToken(dataDir, token);
    res.json({ has: token !== null });
  });

  return api;
}
