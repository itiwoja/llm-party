import { statfsSync } from "node:fs";
import path from "node:path";
import { ulid } from "ulid";
import type { Db } from "../db";
import { readGguf } from "../gguf";
import { ApiError } from "../http-error";
import { isUniqueError, now } from "./shared";

/** コピーのときに置き場に残す余裕（BR-05・D-31）。単位は GB を 1024 のべきで数える */
export const COPY_MARGIN_BYTES = 2_000_000_000;

/** 複数部品で読む画像モデルの部品（絶対パス）。単一ファイルの画像モデルは null */
export interface ImageParts { diffusion: string; llm: string; vae: string; tokenizer: string }

/** 音楽モデルの部品（絶対パス。D-78） */
export interface MusicParts { lm: string; textEncoder: string; dit: string; vae: string }

export interface ModelInput {
  name: string;
  path: string;
  source: "local_ref" | "local_copy" | "hf";
  /** チャット用（llama-server）か画像生成用（sd-server）か音楽生成用（acestep.cpp）か。DB の列は kind */
  use?: "chat" | "image" | "music";
  architecture: string;
  quantization: string | null;
  sizeBytes: number;
  trainContext: number | null;
  /** 部品でできたモデルだけ。単一ファイルの画像モデルは null（-m で読む） */
  parts?: ImageParts | MusicParts | null;
  /** チャットテンプレートから読んだ対応（D-76）。画像モデルには無い */
  supportsThinking?: boolean;
  supportsEffort?: boolean;
}

interface ModelRow {
  id: string; name: string; path: string; source: string; kind: string; architecture: string;
  quantization: string | null; size_bytes: number; train_context: number | null; created_at: string; parts: string | null;
  supports_thinking: number | null; supports_effort: number | null;
}

const toModel = (row: ModelRow) => ({
  id: row.id, name: row.name, path: row.path, source: row.source, use: row.kind, architecture: row.architecture,
  quantization: row.quantization, sizeBytes: row.size_bytes, trainContext: row.train_context,
  parts: row.parts ? (JSON.parse(row.parts) as ImageParts | MusicParts) : null, createdAt: row.created_at,
  supportsThinking: row.supports_thinking === 1, supportsEffort: row.supports_effort === 1,
});

const flag = (value: boolean | undefined) => (value === undefined ? null : value ? 1 : 0);

export class ModelStore {
  constructor(private db: Db) {}

  list() {
    return (this.db.prepare("SELECT * FROM models ORDER BY created_at DESC").all() as ModelRow[]).map(toModel);
  }

  get(id: string) {
    const row = this.db.prepare("SELECT * FROM models WHERE id = ?").get(id) as ModelRow | undefined;
    return row ? toModel(row) : null;
  }

  create(input: ModelInput) {
    const id = ulid();
    const time = now();
    try {
      this.db.prepare(`INSERT INTO models (id, name, path, source, kind, architecture, quantization, size_bytes, train_context, parts, supports_thinking, supports_effort, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.name, input.path, input.source, input.use ?? "chat", input.architecture, input.quantization, input.sizeBytes, input.trainContext, input.parts ? JSON.stringify(input.parts) : null, flag(input.supportsThinking), flag(input.supportsEffort), time, time);
    } catch (error) {
      if (isUniqueError(error)) throw new ApiError("CONFLICT", "このファイルは登録済みです");
      throw error;
    }
    return this.get(id)!;
  }

  /** v5 より前に登録したチャットモデルの対応を読む。ファイルが読めなければ NULL のままにして次の起動でまた読む */
  fillThinkingSupport(): void {
    const rows = this.db.prepare("SELECT id, path FROM models WHERE kind = 'chat' AND supports_thinking IS NULL").all() as { id: string; path: string }[];
    const update = this.db.prepare("UPDATE models SET supports_thinking = ?, supports_effort = ? WHERE id = ?");
    for (const row of rows) {
      try {
        const info = readGguf(row.path);
        update.run(flag(info.supportsThinking), flag(info.supportsEffort), row.id);
      } catch {
        // 外部ドライブが外れている等
      }
    }
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM models WHERE id = ?").run(id);
  }

  /** このモデルを使っているプリセットの名前 */
  presetNames(id: string): string[] {
    return (this.db.prepare("SELECT name FROM presets WHERE model_id = ? ORDER BY name").all(id) as { name: string }[]).map((row) => row.name);
  }

  /** このモデルを元にした LoRA の名前（外部キーが RESTRICT なので先に確かめる） */
  adapterNames(id: string): string[] {
    return (this.db.prepare("SELECT name FROM adapters WHERE base_model_id = ? ORDER BY name").all(id) as { name: string }[]).map((row) => row.name);
  }

  /** 置き場。settings の modelsDir（JSON の値）があればそれ、なければ <dataDir>/models */
  modelsDir(dataDir: string): string {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'modelsDir'").get() as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as string) : path.join(dataDir, "models");
  }

  /** 空き容量（バイト）。テストで差し替えて 507 を確かめる */
  freeBytes(dir: string): number {
    const stats = statfsSync(dir);
    return stats.bavail * stats.bsize;
  }
}
