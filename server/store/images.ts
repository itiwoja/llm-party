import type { Db } from "../db";
import { now } from "./shared";
import { ulid } from "ulid";

export interface ImageRecord {
  id: string;
  threadId: string;
  modelName: string;
  prompt: string;
  width: number;
  height: number;
  steps: number;
  seed: number;
  path: string;
  createdAt: string;
}

interface ImageRow {
  id: string; thread_id: string; model_name: string; prompt: string; width: number; height: number;
  steps: number; seed: number; path: string; created_at: string;
}

const toImage = (row: ImageRow): ImageRecord => ({
  id: row.id, threadId: row.thread_id, modelName: row.model_name, prompt: row.prompt, width: row.width,
  height: row.height, steps: row.steps, seed: row.seed, path: row.path, createdAt: row.created_at,
});

/** 画像生成の結果（D-72）。履歴の文脈には入らず、スレッドの表示にだけ使う */
export class ImageStore {
  constructor(private db: Db) {}

  create(input: Omit<ImageRecord, "id" | "createdAt">): string {
    const id = ulid();
    this.db.prepare(`INSERT INTO images (id, thread_id, model_name, prompt, width, height, steps, seed, path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.threadId, input.modelName, input.prompt, input.width, input.height, input.steps, input.seed, input.path, now());
    return id;
  }

  get(id: string): ImageRecord | null {
    const row = this.db.prepare("SELECT * FROM images WHERE id = ?").get(id) as ImageRow | undefined;
    return row ? toImage(row) : null;
  }
}
