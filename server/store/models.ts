import { statfsSync } from "node:fs";
import path from "node:path";
import { ulid } from "ulid";
import type { Db } from "../db";
import { ApiError } from "../http-error";
import { isUniqueError, now } from "./shared";

/** コピーのときに置き場に残す余裕（BR-05・D-31）。単位は GB を 1024 のべきで数える */
export const COPY_MARGIN_BYTES = 2_000_000_000;

export interface ModelInput {
  name: string;
  path: string;
  source: "local_ref" | "local_copy" | "hf";
  architecture: string;
  quantization: string | null;
  sizeBytes: number;
  trainContext: number | null;
}

interface ModelRow {
  id: string; name: string; path: string; source: string; architecture: string;
  quantization: string | null; size_bytes: number; train_context: number | null; created_at: string;
}

const toModel = (row: ModelRow) => ({
  id: row.id, name: row.name, path: row.path, source: row.source, architecture: row.architecture,
  quantization: row.quantization, sizeBytes: row.size_bytes, trainContext: row.train_context, createdAt: row.created_at,
});

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
      this.db.prepare(`INSERT INTO models (id, name, path, source, architecture, quantization, size_bytes, train_context, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.name, input.path, input.source, input.architecture, input.quantization, input.sizeBytes, input.trainContext, time, time);
    } catch (error) {
      if (isUniqueError(error)) throw new ApiError("CONFLICT", "このファイルは登録済みです");
      throw error;
    }
    return this.get(id)!;
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
