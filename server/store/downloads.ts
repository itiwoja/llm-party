import path from "node:path";
import { ulid } from "ulid";
import type { Db } from "../db";
import { now } from "./shared";

export type DownloadStatus = "queued" | "downloading" | "retrying" | "verifying" | "completed" | "failed" | "cancelled";

export interface DownloadFile {
  name: string;
  size: number;
  sha256: string | null;
  /** 部品ごとにリポジトリが違う DL（image-set）だけ。name は destDir からの相対で `<repo>/<file>` */
  repo?: string;
}

export interface DownloadRecord {
  id: string;
  /** file は保存だけ。チャットのモデルにはならない（形式を問わない） */
  kind: "model" | "adapter" | "image" | "image-set" | "file";
  repo: string;
  files: DownloadFile[];
  destDir: string;
  status: DownloadStatus;
  receivedBytes: number;
  totalBytes: number | null;
  retryCount: number;
  error: string | null;
  resultId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DownloadRow {
  id: string; kind: string; hf_repo: string; files: string; dest_dir: string; status: string; received_bytes: number;
  total_bytes: number | null; retry_count: number; error: string | null; result_id: string | null; created_at: string; updated_at: string;
}

const toRecord = (row: DownloadRow): DownloadRecord => ({
  id: row.id, kind: row.kind as DownloadRecord["kind"], repo: row.hf_repo, files: JSON.parse(row.files), destDir: row.dest_dir,
  status: row.status as DownloadStatus, receivedBytes: row.received_bytes, totalBytes: row.total_bytes, retryCount: row.retry_count,
  error: row.error, resultId: row.result_id, createdAt: row.created_at, updatedAt: row.updated_at,
});

export interface DownloadPatch {
  status?: DownloadStatus;
  receivedBytes?: number;
  retryCount?: number;
  error?: string | null;
  resultId?: string | null;
}

const COLUMNS: Record<keyof DownloadPatch, string> = {
  status: "status", receivedBytes: "received_bytes", retryCount: "retry_count", error: "error", resultId: "result_id",
};

/** DL（FR-012） */
export class DownloadStore {
  constructor(private db: Db) {}

  list(): DownloadRecord[] {
    return (this.db.prepare("SELECT * FROM downloads ORDER BY created_at DESC, id DESC").all() as DownloadRow[]).map(toRecord);
  }

  get(id: string): DownloadRecord | null {
    const row = this.db.prepare("SELECT * FROM downloads WHERE id = ?").get(id) as DownloadRow | undefined;
    return row ? toRecord(row) : null;
  }

  create(input: { kind: DownloadRecord["kind"]; repo: string; files: DownloadFile[]; destDir: string }): DownloadRecord {
    const id = ulid();
    const time = now();
    const total = input.files.reduce((sum, file) => sum + file.size, 0);
    this.db.prepare(`INSERT INTO downloads (id, kind, hf_repo, files, dest_dir, status, received_bytes, total_bytes, retry_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, 0, ?, ?)`)
      .run(id, input.kind, input.repo, JSON.stringify(input.files), input.destDir, total, time, time);
    return this.get(id)!;
  }

  update(id: string, patch: DownloadPatch): DownloadRecord {
    const keys = Object.keys(patch) as (keyof DownloadPatch)[];
    const sets = keys.map((key) => `${COLUMNS[key]} = ?`);
    this.db.prepare(`UPDATE downloads SET ${[...sets, "updated_at = ?"].join(", ")} WHERE id = ?`)
      .run(...keys.map((key) => patch[key] ?? null), now(), id);
    return this.get(id)!;
  }

  /** 待っているものを古い順に1つ */
  nextQueued(): DownloadRecord | null {
    const row = this.db.prepare("SELECT * FROM downloads WHERE status = 'queued' ORDER BY created_at, id LIMIT 1").get() as DownloadRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** 異常終了で動いたまま残った行を failed にする。手動の再開で続きから取れる */
  failInterrupted(message: string): void {
    this.db.prepare("UPDATE downloads SET status = 'failed', error = ?, updated_at = ? WHERE status IN ('downloading', 'retrying', 'verifying')")
      .run(message, now());
  }

  /** モデルの置き場。設定（FR-020）に modelsDir があればそれ、なければ <dataDir>/models */
  modelsDir(dataDir: string): string {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'modelsDir'").get() as { value: string } | undefined;
    if (row) {
      try {
        const value: unknown = JSON.parse(row.value);
        if (typeof value === "string" && path.isAbsolute(value)) return value;
      } catch {
        // 壊れた値は既定に戻す
      }
    }
    return path.join(dataDir, "models");
  }

  /** そのファイルが models / adapters に登録済みか（再 DL を入口で 409 にする） */
  isRegistered(kind: "model" | "adapter" | "image" | "image-set", file: string): boolean {
    return this.db.prepare(`SELECT 1 FROM ${kind === "adapter" ? "adapters" : "models"} WHERE path = ?`).get(file) !== undefined;
  }

  /** models.create は hf_repo を受けないので、できたモデルに由来のリポジトリを足す */
  setModelRepo(modelId: string, repo: string): void {
    this.db.prepare("UPDATE models SET hf_repo = ? WHERE id = ?").run(repo, modelId);
  }
}
