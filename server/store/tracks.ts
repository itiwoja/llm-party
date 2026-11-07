import { ulid } from "ulid";
import type { Db } from "../db";
import { now } from "./shared";

export interface TrackRecord {
  id: string;
  threadId: string;
  modelName: string;
  prompt: string;
  lyrics: string;
  duration: number;
  seed: number;
  path: string;
  createdAt: string;
}

interface TrackRow {
  id: string; thread_id: string; model_name: string; prompt: string; lyrics: string; duration: number;
  seed: number; path: string; created_at: string;
}

const toTrack = (row: TrackRow): TrackRecord => ({
  id: row.id, threadId: row.thread_id, modelName: row.model_name, prompt: row.prompt, lyrics: row.lyrics,
  duration: row.duration, seed: row.seed, path: row.path, createdAt: row.created_at,
});

/** 音楽生成の結果（D-78）。履歴の文脈には入らず、スレッドの表示にだけ使う */
export class TrackStore {
  constructor(private db: Db) {}

  create(input: Omit<TrackRecord, "id" | "createdAt">): string {
    const id = ulid();
    this.db.prepare(`INSERT INTO tracks (id, thread_id, model_name, prompt, lyrics, duration, seed, path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.threadId, input.modelName, input.prompt, input.lyrics, input.duration, input.seed, input.path, now());
    return id;
  }

  get(id: string): TrackRecord | null {
    const row = this.db.prepare("SELECT * FROM tracks WHERE id = ?").get(id) as TrackRow | undefined;
    return row ? toTrack(row) : null;
  }
}
