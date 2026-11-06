import { ulid } from "ulid";
import type { Db } from "../db";
import { ApiError } from "../http-error";
import { type CompactRow, summaryMessage } from "../agent/compact";
import type { ChatMessage } from "../agent/stream";
import { now } from "./shared";

interface ThreadRow {
  id: string; title: string; workspace_id: string | null; workspace_name: string | null; last_preset_id: string | null;
  auto_approve: number; created_at: string; updated_at: string;
}

interface MessageRow {
  id: string; turn_id: string | null; seq: number; role: string; content: string;
  reasoning: string | null; tool_call_id: string | null; pinned: number; compacted_at: string | null; created_at: string;
}

/** 一覧に種類（チャット / エージェント）とワークスペース名を出すため、名前も一緒に読む */
const THREAD_SELECT = "SELECT threads.*, (SELECT name FROM workspaces WHERE workspaces.id = threads.workspace_id) AS workspace_name FROM threads";

const toThread = (row: ThreadRow) => ({
  id: row.id, title: row.title, workspaceId: row.workspace_id, workspaceName: row.workspace_name, lastPresetId: row.last_preset_id,
  autoApprove: row.auto_approve === 1, createdAt: row.created_at, updatedAt: row.updated_at,
});

const toMessage = (row: MessageRow) => ({
  id: row.id, turnId: row.turn_id, seq: row.seq, role: row.role, content: row.content,
  reasoning: row.reasoning, toolCallId: row.tool_call_id, pinned: row.pinned === 1, compactedAt: row.compacted_at, createdAt: row.created_at,
});

export class ThreadStore {
  constructor(private db: Db) {}

  /** auto_approve の既定は設定 defaultAutoApprove（TBL-016, API-031） */
  create(presetId: string | null, workspaceId: string | null = null, title = "") {
    const id = ulid();
    const time = now();
    this.db.prepare("INSERT INTO threads (id, title, workspace_id, last_preset_id, auto_approve, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, title, workspaceId, presetId, this.autoApproveDefault() ? 1 : 0, time, time);
    return this.get(id)!;
  }

  /** settings は別担当の store.settings が持つ。ここでは値を読むだけ（JSON の真偽値。なければ OFF） */
  private autoApproveDefault(): boolean {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'defaultAutoApprove'").get() as { value: string } | undefined;
    try {
      return row ? JSON.parse(row.value) === true : false;
    } catch {
      return false;
    }
  }

  get(id: string) {
    const row = this.db.prepare(`${THREAD_SELECT} WHERE id = ?`).get(id) as ThreadRow | undefined;
    return row ? toThread(row) : null;
  }

  /** API-032。ワークスペースは後から変えない */
  update(id: string, patch: { title?: string; autoApprove?: boolean }): void {
    this.db.transaction(() => {
      if (patch.title !== undefined) this.db.prepare("UPDATE threads SET title = ? WHERE id = ?").run(patch.title, id);
      if (patch.autoApprove !== undefined) this.setAutoApprove(id, patch.autoApprove);
    })();
  }

  setAutoApprove(id: string, value: boolean): void {
    this.db.prepare("UPDATE threads SET auto_approve = ? WHERE id = ?").run(value ? 1 : 0, id);
  }

  /** メッセージ・ターン・ツール呼び出し・変更記録は外部キーの CASCADE で消える。ワークスペースのファイルには触らない */
  delete(id: string): void {
    this.db.prepare("DELETE FROM threads WHERE id = ?").run(id);
  }

  turn(id: string) {
    return this.db.prepare("SELECT id, thread_id AS threadId, status, step_count AS stepCount, step_limit AS stepLimit FROM turns WHERE id = ?")
      .get(id) as { id: string; threadId: string; status: string; stepCount: number; stepLimit: number } | undefined;
  }

  setTurnStatus(id: string, status: "running" | "awaiting_approval" | "step_limit"): void {
    this.db.prepare("UPDATE turns SET status = ? WHERE id = ?").run(status, id);
  }

  setStepCount(id: string, stepCount: number): void {
    this.db.prepare("UPDATE turns SET step_count = ? WHERE id = ?").run(stepCount, id);
  }

  setStepLimit(id: string, stepLimit: number): void {
    this.db.prepare("UPDATE turns SET step_limit = ? WHERE id = ?").run(stepLimit, id);
  }

  /** 更新の新しい順。カーソルは「updated_at|id」（D-41） */
  list({ q, limit = 50, cursor }: { q?: string; limit?: number; cursor?: string }) {
    const where: string[] = [];
    const params: unknown[] = [];
    const term = q?.trim();
    if (term) {
      if ([...term].length >= 3) {
        where.push("id IN (SELECT thread_id FROM threads_fts WHERE threads_fts MATCH ?)");
        params.push(`body:"${term.replaceAll('"', '""')}"`);
      } else {
        // trigram は2文字以下を探せない（D-58）
        const like = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
        where.push(`(title LIKE ? ESCAPE '\\' OR id IN (SELECT thread_id FROM messages WHERE role IN ('user', 'assistant') AND content LIKE ? ESCAPE '\\'))`);
        params.push(like, like);
      }
    }
    if (cursor) {
      const separator = cursor.lastIndexOf("|");
      if (separator < 0) throw new ApiError("VALIDATION_ERROR", "cursor が正しくありません");
      where.push("(updated_at, id) < (?, ?)");
      params.push(cursor.slice(0, separator), cursor.slice(separator + 1));
    }
    const sql = `${THREAD_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC, id DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, limit + 1) as ThreadRow[];
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(toThread),
      nextCursor: rows.length > limit && last ? `${last.updated_at}|${last.id}` : null,
    };
  }

  private nextSeq(threadId: string): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE thread_id = ?").get(threadId) as { seq: number };
    return row.seq;
  }

  addMessage(input: { threadId: string; turnId: string | null; role: string; content: string; pinned?: boolean; toolCallId?: string }) {
    const id = ulid();
    this.db.prepare(`INSERT INTO messages (id, thread_id, turn_id, seq, role, content, tool_call_id, pinned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.threadId, input.turnId, this.nextSeq(input.threadId), input.role, input.content, input.toolCallId ?? null, input.pinned ? 1 : 0, now());
    return id;
  }

  updateMessage(id: string, content: string, reasoning: string | null): void {
    this.db.prepare("UPDATE messages SET content = ?, reasoning = ? WHERE id = ?").run(content, reasoning, id);
  }

  /** 送信を受け付ける：ターンとユーザーメッセージを1つのトランザクションで作る */
  beginTurn(threadId: string, presetId: string, content: string): string {
    return this.db.transaction(() => {
      const thread = this.get(threadId)!;
      const turnId = ulid();
      const time = now();
      this.db.prepare("INSERT INTO turns (id, thread_id, preset_id, status, started_at) VALUES (?, ?, ?, 'running', ?)")
        .run(turnId, threadId, presetId, time);
      const first = this.nextSeq(threadId) === 1;
      this.addMessage({ threadId, turnId, role: "user", content, pinned: first });
      const title = thread.title || content.split("\n", 1)[0];
      this.db.prepare("UPDATE threads SET title = ?, last_preset_id = ?, updated_at = ? WHERE id = ?").run(title, presetId, time, threadId);
      return turnId;
    })();
  }

  finishTurn(id: string, status: "completed" | "cancelled" | "failed", result: { promptTokens?: number; completionTokens?: number; error?: string }): void {
    this.db.prepare("UPDATE turns SET status = ?, prompt_tokens = ?, completion_tokens = ?, error = ?, finished_at = ? WHERE id = ?")
      .run(status, result.promptTokens ?? null, result.completionTokens ?? null, result.error ?? null, now(), id);
  }

  /**
   * 前回の異常終了で残ったターンを閉じる。承認待ち・実行中のツール呼び出しも一緒に閉じる
   * （承認待ち → rejected、実行中 → failed。04 の状態遷移にある行き先）
   */
  failUnfinishedTurns(): void {
    const time = now();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE tool_calls SET status = 'rejected', decision_note = 'アプリが終了しました', finished_at = ?
        WHERE status = 'pending_approval'`).run(time);
      this.db.prepare(`UPDATE tool_calls SET status = 'failed', output = 'アプリが終了しました', finished_at = ?
        WHERE status = 'running'`).run(time);
      this.db.prepare("UPDATE turns SET status = 'failed', error = 'アプリが終了しました', finished_at = ? WHERE status IN ('running', 'awaiting_approval', 'step_limit')").run(time);
    })();
  }

  /** モデルに送る会話（チャット）。要約済みは除く */
  conversation(threadId: string) {
    return (this.db.prepare(`SELECT role, content FROM messages WHERE thread_id = ? AND compacted_at IS NULL
      AND role IN ('user', 'assistant', 'summary') AND content <> '' ORDER BY seq`).all(threadId) as { role: string; content: string }[])
      .map((row): { role: "user" | "assistant"; content: string } => (row.role === "summary" ? summaryMessage(row.content) : { role: row.role as "user" | "assistant", content: row.content }));
  }

  /**
   * モデルに送る会話（エージェント）。assistant の直後に並ぶ tool メッセージから、
   * そのメッセージが出した tool_calls を組み立てる。本文が空でも tool_calls があれば残す
   */
  agentConversation(threadId: string): ChatMessage[] {
    const rows = this.db.prepare(`SELECT m.role, m.content, tc.call_ref, tc.tool, tc.args FROM messages m
      LEFT JOIN tool_calls tc ON tc.id = m.tool_call_id
      WHERE m.thread_id = ? AND m.compacted_at IS NULL AND m.role IN ('user', 'assistant', 'tool', 'summary') ORDER BY m.seq`)
      .all(threadId) as { role: string; content: string; call_ref: string | null; tool: string | null; args: string | null }[];
    const result: ChatMessage[] = [];
    let current: Extract<ChatMessage, { role: "assistant" }> | null = null;
    for (const row of rows) {
      if (row.role === "tool" && row.call_ref && current) {
        current.tool_calls ??= [];
        current.tool_calls.push({ id: row.call_ref, type: "function", function: { name: row.tool!, arguments: validJson(row.args!) } });
        result.push({ role: "tool", tool_call_id: row.call_ref, content: row.content });
      } else if (row.role === "assistant") {
        current = { role: "assistant", content: row.content };
        result.push(current);
      } else if (row.role === "user") {
        current = null;
        result.push({ role: "user", content: row.content });
      } else if (row.role === "summary") {
        current = null;
        result.push(summaryMessage(row.content));
      }
    }
    // 呼び出しも本文もない assistant（失敗・停止で空のまま残ったもの）は送らない
    return result.filter((message) => message.role !== "assistant" || message.content !== "" || message.tool_calls);
  }

  /** FR-006：要約の候補（要約済みを除く）。古い順 */
  compactRows(threadId: string): CompactRow[] {
    const rows = this.db.prepare(`SELECT m.id, m.seq, m.role, m.content, m.pinned, tc.tool, tc.args FROM messages m
      LEFT JOIN tool_calls tc ON tc.id = m.tool_call_id
      WHERE m.thread_id = ? AND m.compacted_at IS NULL AND m.role IN ('user', 'assistant', 'tool', 'summary') ORDER BY m.seq`)
      .all(threadId) as (Omit<CompactRow, "pinned"> & { pinned: number })[];
    return rows.map((row) => ({ ...row, pinned: row.pinned === 1 }));
  }

  /**
   * 要約を保存し、元のメッセージに compacted_at を付ける。要約は残す側の先頭の位置に入れ、
   * 残す側の seq を 1 つずつ後ろへずらす（画面が seq の順に並べても、要約が要約した部分の直後に出る）
   */
  applyCompaction(threadId: string, turnId: string, middleIds: string[], keepFromSeq: number, summary: string): string {
    return this.db.transaction(() => {
      const time = now();
      // seq は (thread_id, seq) で一意なので、いったん負にしてからずらす
      this.db.prepare("UPDATE messages SET seq = -seq WHERE thread_id = ? AND seq >= ?").run(threadId, keepFromSeq);
      this.db.prepare("UPDATE messages SET seq = 1 - seq WHERE thread_id = ? AND seq < 0").run(threadId);
      const mark = this.db.prepare("UPDATE messages SET compacted_at = ? WHERE id = ?");
      for (const id of middleIds) mark.run(time, id);
      const id = ulid();
      this.db.prepare("INSERT INTO messages (id, thread_id, turn_id, seq, role, content, pinned, created_at) VALUES (?, ?, ?, ?, 'summary', ?, 0, ?)")
        .run(id, threadId, turnId, keepFromSeq, summary, time);
      return id;
    })();
  }

  /** 新しいスレッドで続ける：最新の要約を最初のメッセージ（pinned）にしたスレッドを作る。要約がなければ最初の指示を使い、それもなければ null */
  createFromSummary(sourceId: string, presetId: string | null, workspaceId: string | null) {
    const source = this.get(sourceId);
    const summary = this.db.prepare(`SELECT content FROM messages WHERE thread_id = ? AND compacted_at IS NULL AND (role = 'summary' OR pinned = 1)
      ORDER BY role = 'summary' DESC, seq DESC LIMIT 1`).get(sourceId) as { content: string } | undefined;
    if (!source || !summary) return null;
    return this.db.transaction(() => {
      const thread = this.create(presetId, workspaceId ?? source.workspaceId, source.title);
      this.addMessage({ threadId: thread.id, turnId: null, role: "user", content: summary.content, pinned: true });
      return thread;
    })();
  }

  threadDetail(threadId: string) {
    const messages = (this.db.prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY seq").all(threadId) as MessageRow[]).map(toMessage);
    const turns = this.db.prepare(`SELECT id, preset_id AS presetId, status, step_count AS stepCount, step_limit AS stepLimit,
      prompt_tokens AS promptTokens, completion_tokens AS completionTokens,
      started_at AS startedAt, finished_at AS finishedAt, error FROM turns WHERE thread_id = ? ORDER BY started_at, rowid`).all(threadId);
    return { messages, turns };
  }
}

/** 壊れた JSON はテンプレートが読めないので空のオブジェクトにして渡す */
function validJson(text: string): string {
  try {
    JSON.parse(text);
    return text;
  } catch {
    return "{}";
  }
}
