import { existsSync, rmSync } from "node:fs";
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

  /** ファイルは dataDir/music の中だけを扱う */
  const insideStorage = (file: string) => path.resolve(file).startsWith(path.resolve(dataDir, "music") + path.sep);

  // 歌詞の下書き（FR-023）。202 で返し、結果は "music" イベントで届く
  api.post("/music/draft", (req, res) => {
    const input = parse(z.object({ modelId: z.string().min(1), prompt: z.string().trim().min(1).max(2000) }), req.body);
    res.status(202).json(music.draft(input));
  });

  // 音楽生成（D-78）。202 で返し、結果は "music" イベントで届く
  api.post("/music/generate", (req, res) => {
    const input = parse(
      z.object({
        modelId: z.string().min(1),
        prompt: z.string().trim().min(1).max(2000),
        lyrics: z.string().trim().max(4000).default(""),
        duration: z.number().int().min(MUSIC_MIN_SECONDS).max(MUSIC_MAX_SECONDS).default(MUSIC_DEFAULT_SECONDS),
      }),
      req.body,
    );
    res.status(202).json(music.start(input));
  });

  // 実行中の下書き・生成を止める（終わった後に呼んでも何もしない）
  api.post("/music/cancel", (_req, res) => {
    res.json(music.cancel());
  });

  // 今の状態。:id より前に登録しないと "status" が曲の id として 404 になる
  api.get("/music/status", (_req, res) => {
    res.json(music.status());
  });

  // 生成した MP3
  api.get("/music/:id", (req, res) => {
    const track = store.tracks.get(req.params.id);
    if (!track || !existsSync(track.path)) throw new ApiError("NOT_FOUND", "曲がありません");
    if (!insideStorage(track.path)) throw new ApiError("PATH_NOT_ALLOWED", "置き場の外の曲は返せません");
    res.type("audio/mpeg").sendFile(path.resolve(track.path));
  });

  // 曲の一覧。説明は全文を返し、1行目だけを出すのは画面の仕事
  api.get("/tracks", (req, res) => {
    const query = parse(z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).optional() }), req.query);
    const page = store.tracks.list(query);
    res.json({ items: page.items.map(({ id, prompt, duration, createdAt }) => ({ id, prompt, duration, createdAt })), nextCursor: page.nextCursor });
  });

  api.get("/tracks/:id", (req, res) => {
    const track = store.tracks.get(req.params.id);
    if (!track) throw new ApiError("NOT_FOUND", "曲がありません");
    const { id, prompt, lyrics, reasoning, duration, bpm, keyscale, modelName, seed, createdAt } = track;
    res.json({ id, prompt, lyrics, reasoning, duration, bpm, keyscale, modelName, seed, createdAt });
  });

  // 行と MP3 を消す。MP3 が先にどこかへ消えていても行は消す（UC-010 E1）。
  // 置き場の外を指す行は、ファイルには触れず行だけ消す（PATH_NOT_ALLOWED で断ると消せない行が残るため）
  api.delete("/tracks/:id", (req, res) => {
    const track = store.tracks.get(req.params.id);
    if (!track) throw new ApiError("NOT_FOUND", "曲がありません");
    if (insideStorage(track.path)) rmSync(track.path, { force: true });
    store.tracks.delete(track.id);
    res.status(204).end();
  });

  return api;
}
