import { ulid } from "ulid";
import type { Db } from "../db";
import { ApiError } from "../http-error";
import { now } from "./shared";

export interface TrackRecord {
  id: string;
  /** 音楽の画面で作った曲、スレッドが消えた曲は null（v7 までの曲はスレッドでも再生できる） */
  threadId: string | null;
  modelName: string;
  prompt: string;
  lyrics: string;
  duration: number;
  seed: number;
  path: string;
  bpm: number | null;
  keyscale: string | null;
  reasoning: string;
  createdAt: string;
}

interface TrackRow {
  id: string; thread_id: string | null; model_name: string; prompt: string; lyrics: string; duration: number;
  seed: number; path: string; bpm: number | null; keyscale: string | null; reasoning: string; created_at: string;
}

const toTrack = (row: TrackRow): TrackRecord => ({
  id: row.id, threadId: row.thread_id, modelName: row.model_name, prompt: row.prompt, lyrics: row.lyrics,
  duration: row.duration, seed: row.seed, path: row.path, bpm: row.bpm, keyscale: row.keyscale, reasoning: row.reasoning,
  createdAt: row.created_at,
});

/** 音楽生成の結果（D-78, D-80）。履歴の文脈には入らず、スレッドからも独立している */
export class TrackStore {
  constructor(private db: Db) {}

  create(input: Omit<TrackRecord, "id" | "createdAt">): string {
    const id = ulid();
    this.db.prepare(`INSERT INTO tracks (id, thread_id, model_name, prompt, lyrics, duration, seed, path, bpm, keyscale, reasoning, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.threadId, input.modelName, input.prompt, input.lyrics, input.duration, input.seed, input.path, input.bpm, input.keyscale, input.reasoning, now());
    return id;
  }

  get(id: string): TrackRecord | null {
    const row = this.db.prepare("SELECT * FROM tracks WHERE id = ?").get(id) as TrackRow | undefined;
    return row ? toTrack(row) : null;
  }

  /** 新しい順。カーソルは「created_at|id」（スレッドの一覧と同じ形。D-41） */
  list({ limit = 50, cursor }: { limit?: number; cursor?: string }): { items: TrackRecord[]; nextCursor: string | null } {
    const params: unknown[] = [];
    let where = "";
    if (cursor) {
      const separator = cursor.lastIndexOf("|");
      if (separator < 0) throw new ApiError("VALIDATION_ERROR", "cursor が正しくありません");
      where = "WHERE (created_at, id) < (?, ?)";
      params.push(cursor.slice(0, separator), cursor.slice(separator + 1));
    }
    const rows = this.db.prepare(`SELECT * FROM tracks ${where} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...params, limit + 1) as TrackRow[];
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return { items: page.map(toTrack), nextCursor: rows.length > limit && last ? `${last.created_at}|${last.id}` : null };
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM tracks WHERE id = ?").run(id);
  }
}
