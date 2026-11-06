import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import type { Context } from "../context";
import { HfClient } from "../hf/client";
import { GENRE_NAMES } from "../hf/genres";
import { fileNeedGb } from "../hf/memory";
import { assertRepo, groupFiles } from "../hf/names";
import { parse } from "./parse";

/** 空欄は指定なし。数字は GB の上限（1〜1024） */
const memoryLimit = z.preprocess((value) => (value === undefined || value === "" ? undefined : Number(value)), z.number().positive().max(1024).optional());

/** 語かジャンルか無検閲か VRAM・RAM のどれかが要る（全件の一覧は出さない） */
const searchQuery = z.object({
  q: z.string().trim().default(""),
  genre: z.enum(GENRE_NAMES).default("all"),
  uncensored: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  vram: memoryLimit,
  ram: memoryLimit,
}).refine(
  (input) => input.q !== "" || input.genre !== "all" || input.uncensored || input.vram !== undefined || input.ram !== undefined,
  { path: ["q"] },
);

/** HF 検索・DL（API-053〜057） */
export function hfRoutes({ downloads, hfBaseUrl, dataDir }: Context): Router {
  const api = Router();
  const hf = new HfClient(hfBaseUrl, dataDir);

  api.get("/hf/search", async (req, res) => {
    const { q, genre, uncensored, vram, ram } = parse(searchQuery, req.query);
    res.json({ items: await hf.search({ query: q, genre, uncensored, vram: vram ?? null, ram: ram ?? null }) });
  });

  api.get("/hf/files", async (req, res) => {
    const { repo } = parse(z.object({ repo: z.string().min(1) }), req.query);
    assertRepo(repo);
    const items = groupFiles(await hf.listFiles(repo)).map((group) => ({
      name: group.name,
      quantization: group.quantization,
      sizeBytes: group.sizeBytes,
      split: group.split,
      complete: group.complete,
      parts: group.parts.map((part) => ({ name: part.path, sizeBytes: part.size })),
      // 動かすときの目安（実ファイルのサイズから）
      memoryGb: fileNeedGb(group.sizeBytes),
    }));
    res.json({ items });
  });

  const view = ({ destDir, files, ...rest }: ReturnType<typeof downloads.list>[number]) => ({
    ...rest,
    // 完了した LoRA の保存先。画面が POST /api/adapters の reference に使う
    ...(rest.kind === "adapter" && rest.status === "completed" ? { filePath: path.join(destDir, files[0].name) } : {}),
    // 保存だけの DL の置き場。登録されないので、ここでしか場所が分からない
    ...(rest.kind === "file" && rest.status === "completed" ? { savedDir: destDir } : {}),
    files: files.map((file) => ({ name: file.name, sizeBytes: file.size })),
  });

  api.post("/downloads", async (req, res) => {
    const input = parse(
      z.object({ repo: z.string().min(1), files: z.array(z.string().min(1)).min(1).optional(), kind: z.enum(["model", "adapter", "image", "file"]) }),
      req.body,
    );
    res.status(202).json(view(await downloads.create(input)));
  });
  api.get("/downloads", (_req, res) => {
    res.json({ items: downloads.list().map(view) });
  });
  api.post("/downloads/:id/cancel", async (req, res) => {
    res.json(view(await downloads.cancel(req.params.id)));
  });
  api.post("/downloads/:id/resume", (req, res) => {
    res.json(view(downloads.resume(req.params.id)));
  });

  return api;
}
