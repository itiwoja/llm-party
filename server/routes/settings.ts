import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { statfs } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { zipSync } from "fflate";
import { z } from "zod";
import type { Context } from "../context";
import { ApiError } from "../http-error";
import { logger, scrub } from "../logger";
import { THEMES } from "../store/settings";
import { parse } from "./parse";

const { version } = JSON.parse(readFileSync(path.resolve(fileURLToPath(import.meta.url), "../../../package.json"), "utf8")) as { version: string };

/** 存在する一番近い親の空き（バイト） */
async function freeBytes(dir: string): Promise<number> {
  let target = path.resolve(dir);
  while (!existsSync(target)) target = path.dirname(target);
  const stats = await statfs(target);
  return stats.bavail * stats.bsize;
}

const absolutePath = z.string().refine((value) => path.isAbsolute(value), "絶対パスで指定してください");

const patchSchema = z
  .object({
    modelsDir: absolutePath,
    defaultAutoApprove: z.boolean(),
    defaultContextSize: z.number().int().positive(),
    theme: z.enum(THEMES),
  })
  .partial()
  .strict();

/** 設定・診断・システム（API-021, 090〜092） */
export function settingRoutes({ store, engine, dataDir }: Context): Router {
  const api = Router();

  const view = async () => {
    const settings = store.settings.all();
    const modelsDir = store.models.modelsDir(dataDir);
    return { ...settings, modelsDir, modelsFreeBytes: await freeBytes(modelsDir), backend: engine.backend };
  };

  api.get("/settings", async (_req, res) => {
    res.json(await view());
  });

  api.patch("/settings", async (req, res) => {
    const patch = parse(patchSchema, req.body);
    if (patch.modelsDir !== undefined) {
      if (!existsSync(patch.modelsDir) || !statSync(patch.modelsDir).isDirectory()) {
        throw new ApiError("VALIDATION_ERROR", "入力が正しくありません", [{ field: "modelsDir", message: "存在するフォルダを指定してください" }]);
      }
    }
    store.settings.update(patch);
    res.json(await view());
  });

  api.get("/system", async (_req, res) => {
    // パックは localhost 段階では空（12）
    res.json({ backend: engine.backend, packs: [], freeBytes: await freeBytes(store.models.modelsDir(dataDir)) });
  });

  api.post("/diagnostics/export", (req, res) => {
    const { path: target } = parse(z.object({ path: absolutePath }), req.body);
    const parent = path.dirname(target);
    if (!existsSync(parent) || !statSync(parent).isDirectory()) {
      throw new ApiError("VALIDATION_ERROR", "入力が正しくありません", [{ field: "path", message: "保存先のフォルダがありません" }]);
    }
    const encode = (text: string) => new TextEncoder().encode(text);
    const files: Record<string, Uint8Array> = {
      "info.json": encode(JSON.stringify({ version, backend: engine.backend, exportedAt: new Date().toISOString() }, null, 2)),
      // settings に秘密は入らないが、HF トークンの置き場（secrets/）は読まない
      "settings.json": encode(JSON.stringify(store.settings.all(), null, 2)),
    };
    const logsDir = path.join(dataDir, "logs");
    if (existsSync(logsDir)) {
      for (const name of readdirSync(logsDir).filter((file) => file.endsWith(".log"))) {
        files[`logs/${name}`] = encode(scrub(readFileSync(path.join(logsDir, name), "utf8")));
      }
    }
    mkdirSync(parent, { recursive: true });
    writeFileSync(target, zipSync(files));
    logger.info("診断情報を書き出した");
    res.json({ path: target });
  });

  return api;
}
