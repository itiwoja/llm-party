import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import type { Context } from "../context";
import { HfClient } from "../hf/client";
import { assertRepo, groupFiles } from "../hf/names";
import { parse } from "./parse";

/** HF 検索・DL（API-053〜057） */
export function hfRoutes({ downloads, hfBaseUrl, dataDir }: Context): Router {
  const api = Router();
  const hf = new HfClient(hfBaseUrl, dataDir);

  api.get("/hf/search", async (req, res) => {
    const { q } = parse(z.object({ q: z.string().trim().min(1) }), req.query);
    res.json({ items: await hf.search(q) });
  });

  api.get("/hf/files", async (req, res) => {
    const { repo } = parse(z.object({ repo: z.string().min(1) }), req.query);
    assertRepo(repo);
    const items = groupFiles(await hf.listGguf(repo)).map((group) => ({
      name: group.name,
      quantization: group.quantization,
      sizeBytes: group.sizeBytes,
      split: group.split,
      complete: group.complete,
      parts: group.parts.map((part) => ({ name: part.path, sizeBytes: part.size })),
    }));
    res.json({ items });
  });

  const view = ({ destDir, files, ...rest }: ReturnType<typeof downloads.list>[number]) => ({
    ...rest,
    // 完了した LoRA の保存先。画面が POST /api/adapters の reference に使う
    ...(rest.kind === "adapter" && rest.status === "completed" ? { filePath: path.join(destDir, files[0].name) } : {}),
    files: files.map((file) => ({ name: file.name, sizeBytes: file.size })),
  });

  api.post("/downloads", async (req, res) => {
    const input = parse(
      z.object({ repo: z.string().min(1), files: z.array(z.string().min(1)).min(1), kind: z.enum(["model", "adapter"]) }),
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
