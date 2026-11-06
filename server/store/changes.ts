import { createHash } from "node:crypto";
import { ulid } from "ulid";
import type { Db } from "../db";
import { now } from "./shared";

interface ChangeRow {
  id: string; tool_call_id: string; thread_id: string; path: string; before_content: string | null; after_content: string | null;
  after_sha256: string | null; reverted_at: string | null; created_at: string;
}

const toChange = (row: ChangeRow) => ({
  id: row.id, toolCallId: row.tool_call_id, threadId: row.thread_id, path: row.path,
  before: row.before_content, after: row.after_content ?? "", afterSha256: row.after_sha256,
  revertedAt: row.reverted_at, createdAt: row.created_at,
});

export type FileChangeRecord = ReturnType<typeof toChange>;

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** 変更記録（FR-011）。before が null なら新規作成 */
export class ChangeStore {
  constructor(private db: Db) {}

  record(input: { toolCallId: string; threadId: string; path: string; before: string | null; after: string }): string {
    const id = ulid();
    this.db.prepare(`INSERT INTO file_changes (id, tool_call_id, thread_id, path, before_content, after_content, after_sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.toolCallId, input.threadId, input.path, input.before, input.after, sha256(input.after), now());
    return id;
  }

  /** 記録した順 */
  ofThread(threadId: string): FileChangeRecord[] {
    return (this.db.prepare("SELECT * FROM file_changes WHERE thread_id = ? ORDER BY rowid").all(threadId) as ChangeRow[]).map(toChange);
  }

  get(id: string): FileChangeRecord | null {
    const row = this.db.prepare("SELECT * FROM file_changes WHERE id = ?").get(id) as ChangeRow | undefined;
    return row ? toChange(row) : null;
  }

  /** まだ取り消していないときだけ記録する。記録できたら true */
  markReverted(id: string): boolean {
    return this.db.prepare("UPDATE file_changes SET reverted_at = ? WHERE id = ? AND reverted_at IS NULL").run(now(), id).changes === 1;
  }
}
