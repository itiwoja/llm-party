import { existsSync } from "node:fs";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import type { Context } from "../context";
import { ApiError } from "../http-error";
import { parse } from "./parse";

/** 幅・高さは 8 の倍数。大きすぎると VRAM が足りないので上限を置く（数値は仮。最後に確認） */
const size = z.number().int().min(64).max(2048).refine((value) => value % 8 === 0, "8 の倍数");

export function imageRoutes({ store, images, dataDir }: Context): Router {
  const api = Router();

  // 画像生成（D-72）。202 で返し、結果は "image" イベントで届く
  api.post("/threads/:id/images", (req, res) => {
    const input = parse(
      z.object({
        modelId: z.string().min(1),
        prompt: z.string().trim().min(1).max(2000),
        width: size.default(512),
        height: size.default(512),
        steps: z.number().int().min(1).max(100).default(20),
        seed: z.number().int().min(-1).default(-1),
      }),
      req.body,
    );
    res.status(202).json(images.start(req.params.id, { ...input, modelId: input.modelId }));
  });

  // 実行中の画像生成を止める（終わった後に呼んでも何もしない）
  api.post("/threads/:id/images/cancel", (req, res) => {
    res.json(images.cancel(req.params.id));
  });

  // 今の状態（/images/:id より先に置く）
  api.get("/images/status", (_req, res) => {
    res.json(images.status());
  });

  // 生成の途中の画像（/images/:id より先に置く）。D-85
  api.get("/images/preview", (_req, res) => {
    const preview = images.preview();
    if (!preview) throw new ApiError("NOT_FOUND", "途中の画像がありません");
    res.type("png").set("Cache-Control", "no-store").send(preview);
  });

  // 生成した PNG（ファイルは dataDir/images の中だけを返す）
  api.get("/images/:id", (req, res) => {
    const image = store.images.get(req.params.id);
    if (!image || !existsSync(image.path)) throw new ApiError("NOT_FOUND", "画像がありません");
    const root = path.resolve(dataDir, "images") + path.sep;
    const file = path.resolve(image.path);
    if (!file.startsWith(root)) throw new ApiError("PATH_NOT_ALLOWED", "置き場の外の画像は返せません");
    res.type("png").sendFile(file);
  });

  return api;
}
