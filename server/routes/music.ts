import { existsSync } from "node:fs";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import type { Context } from "../context";
import { ApiError } from "../http-error";
import { parse } from "./parse";

/** 曲の長さ（秒）。下限はモデルの制約、上限は D-78 */
export const MUSIC_MIN_SECONDS = 10;
export const MUSIC_MAX_SECONDS = 240;
export const MUSIC_DEFAULT_SECONDS = 60;

export function musicRoutes({ store, music, dataDir }: Context): Router {
  const api = Router();

  // 音楽生成（D-78）。202 で返し、結果は "music" イベントで届く
  api.post("/threads/:id/music", (req, res) => {
    const input = parse(
      z.object({
        modelId: z.string().min(1),
        prompt: z.string().trim().min(1).max(2000),
        lyrics: z.string().trim().max(4000).default(""),
        duration: z.number().int().min(MUSIC_MIN_SECONDS).max(MUSIC_MAX_SECONDS).default(MUSIC_DEFAULT_SECONDS),
        seed: z.number().int().min(-1).default(-1),
      }),
      req.body,
    );
    res.status(202).json(music.start(req.params.id, input));
  });

  // 実行中の音楽生成を止める（終わった後に呼んでも何もしない）
  api.post("/threads/:id/music/cancel", (req, res) => {
    res.json(music.cancel(req.params.id));
  });

  // 生成した MP3（ファイルは dataDir/music の中だけを返す）
  api.get("/music/:id", (req, res) => {
    const track = store.tracks.get(req.params.id);
    if (!track || !existsSync(track.path)) throw new ApiError("NOT_FOUND", "曲がありません");
    const root = path.resolve(dataDir, "music") + path.sep;
    const file = path.resolve(track.path);
    if (!file.startsWith(root)) throw new ApiError("PATH_NOT_ALLOWED", "置き場の外の曲は返せません");
    res.type("audio/mpeg").sendFile(file);
  });

  return api;
}
