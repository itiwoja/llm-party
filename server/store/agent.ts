import { ulid } from "ulid";
import type { Db } from "../db";
import { now } from "./shared";

interface WorkspaceRow {
  id: string; path: string; name: string; created_at: string; last_used_at: string | null;
  hidden_at: string | null; instructions: string | null; default_preset_id: string | null; auto_approve: number | null;
}

interface ToolCallRow {
  id: string; turn_id: string; call_ref: string; tool: string; args: string; kind: string; status: string;
  decision_note: string | null; output: string | null; exit_code: number | null; started_at: string | null; finished_at: string | null;
}

const toWorkspace = (row: WorkspaceRow) => ({
  id: row.id, path: row.path, name: row.name, createdAt: row.created_at, lastUsedAt: row.last_used_at,
  hiddenAt: row.hidden_at, instructions: row.instructions, defaultPresetId: row.default_preset_id,
  autoApprove: row.auto_approve === null ? null : row.auto_approve === 1,
});

const toToolCall = (row: ToolCallRow) => {
  let args: unknown = row.args;
  try {
    args = JSON.parse(row.args);
  } catch {
    // 壊れた引数は文字列のまま返す
  }
  return {
    id: row.id, turnId: row.turn_id, callRef: row.call_ref, tool: row.tool, args, kind: row.kind, status: row.status,
    decisionNote: row.decision_note, output: row.output, exitCode: row.exit_code, startedAt: row.started_at, finishedAt: row.finished_at,
  };
};

export type ToolCallStatus = "pending_approval" | "running" | "denied" | "rejected" | "succeeded" | "failed" | "timed_out";

/** ワークスペース・ツール呼び出し（FR-007〜FR-010） */
export class AgentStore {
  constructor(private db: Db) {}

  /** 左の一覧に出すプロジェクト。外したものは出さない */
  workspaces() {
    return (this.db.prepare("SELECT * FROM workspaces WHERE hidden_at IS NULL ORDER BY COALESCE(last_used_at, created_at) DESC, id DESC").all() as WorkspaceRow[]).map(toWorkspace);
  }

  workspace(id: string) {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as WorkspaceRow | undefined;
    return row ? toWorkspace(row) : null;
  }

  /** 実体のパスで登録する。同じパスは使い回し、外してあれば一覧へ戻す（FR-007） */
  registerWorkspace(realPath: string, name: string) {
    const found = this.db.prepare("SELECT * FROM workspaces WHERE path = ?").get(realPath) as WorkspaceRow | undefined;
    if (found) {
      if (found.hidden_at) this.db.prepare("UPDATE workspaces SET hidden_at = NULL WHERE id = ?").run(found.id);
      return this.workspace(found.id)!;
    }
    const id = ulid();
    this.db.prepare("INSERT INTO workspaces (id, path, name, created_at) VALUES (?, ?, ?, ?)").run(id, realPath, name, now());
    return this.workspace(id)!;
  }

  /** API-043。autoApprove の null は設定 defaultAutoApprove に従う */
  updateWorkspace(id: string, patch: { name?: string; instructions?: string | null; defaultPresetId?: string | null; autoApprove?: boolean | null }): void {
    const update = (column: string, value: unknown) => this.db.prepare(`UPDATE workspaces SET ${column} = ? WHERE id = ?`).run(value, id);
    this.db.transaction(() => {
      if (patch.name !== undefined) update("name", patch.name);
      if (patch.instructions !== undefined) update("instructions", patch.instructions);
      if (patch.defaultPresetId !== undefined) update("default_preset_id", patch.defaultPresetId);
      if (patch.autoApprove !== undefined) update("auto_approve", patch.autoApprove === null ? null : patch.autoApprove ? 1 : 0);
    })();
  }

  /** API-044。一覧から外すだけで、スレッドは残す。同じフォルダを登録し直すと戻る */
  hideWorkspace(id: string): void {
    this.db.prepare("UPDATE workspaces SET hidden_at = ? WHERE id = ?").run(now(), id);
  }

  touchWorkspace(id: string): void {
    this.db.prepare("UPDATE workspaces SET last_used_at = ? WHERE id = ?").run(now(), id);
  }

  createToolCall(input: { id: string; turnId: string; callRef: string; tool: string; args: unknown; kind: string; status: ToolCallStatus }): void {
    const args = typeof input.args === "string" ? input.args : JSON.stringify(input.args);
    this.db.prepare(`INSERT INTO tool_calls (id, turn_id, call_ref, tool, args, kind, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.id, input.turnId, input.callRef, input.tool, args, input.kind, input.status, input.status === "running" ? now() : null);
  }

  /** 承認待ち → 実行中 */
  startToolCall(id: string): void {
    this.db.prepare("UPDATE tool_calls SET status = 'running', started_at = ? WHERE id = ?").run(now(), id);
  }

  finishToolCall(id: string, end: { status: ToolCallStatus; output: string; exitCode?: number | null; note?: string }): void {
    this.db.prepare("UPDATE tool_calls SET status = ?, output = ?, exit_code = ?, decision_note = COALESCE(?, decision_note), finished_at = ? WHERE id = ?")
      .run(end.status, end.output, end.exitCode ?? null, end.note ?? null, now(), id);
  }

  /** 承認待ちの1件を、まだ承認待ちのときだけ更新する。更新できたら true（二重の判断を防ぐ） */
  decide(id: string, status: "running" | "rejected", note?: string): boolean {
    const result = this.db.prepare(`UPDATE tool_calls SET status = ?, decision_note = ?,
      started_at = CASE WHEN ? = 'running' THEN ? ELSE started_at END WHERE id = ? AND status = 'pending_approval'`)
      .run(status, note ?? null, status, now(), id);
    return result.changes === 1;
  }

  /** ターンが終わったときに残った承認待ち・実行中を閉じる（ループが例外で抜けた場合の保険） */
  closeToolCalls(turnId: string, note: string): void {
    const time = now();
    this.db.prepare("UPDATE tool_calls SET status = 'rejected', decision_note = ?, finished_at = ? WHERE turn_id = ? AND status = 'pending_approval'").run(note, time, turnId);
    this.db.prepare("UPDATE tool_calls SET status = 'failed', output = ?, finished_at = ? WHERE turn_id = ? AND status = 'running'").run(note, time, turnId);
  }

  toolCall(id: string) {
    const row = this.db.prepare(`SELECT tool_calls.*, turns.thread_id AS thread_id FROM tool_calls JOIN turns ON turns.id = tool_calls.turn_id WHERE tool_calls.id = ?`)
      .get(id) as (ToolCallRow & { thread_id: string }) | undefined;
    return row ? { ...toToolCall(row), threadId: row.thread_id } : null;
  }

  toolCallsOfThread(threadId: string) {
    const rows = this.db.prepare(`SELECT tool_calls.* FROM tool_calls JOIN turns ON turns.id = tool_calls.turn_id
      WHERE turns.thread_id = ? ORDER BY tool_calls.rowid`).all(threadId) as ToolCallRow[];
    return rows.map(toToolCall);
  }
}
