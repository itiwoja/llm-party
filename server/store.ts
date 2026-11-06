import { ulid } from "ulid";
import type { Db } from "./db";
import { ApiError } from "./http-error";

export const now = () => new Date().toISOString();

export interface Sampling {
  temperature: number;
  topP: number;
  topK: number;
  minP: number;
  presencePenalty: number;
  repeatPenalty: number;
}

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

interface PresetRow {
  id: string; name: string; model_id: string; sampling: string; system_prompt: string | null;
  thinking: number; context_size: number; created_at: string; updated_at: string;
}

interface ThreadRow {
  id: string; title: string; workspace_id: string | null; last_preset_id: string | null;
  auto_approve: number; created_at: string; updated_at: string;
}

interface MessageRow {
  id: string; turn_id: string | null; seq: number; role: string; content: string;
  reasoning: string | null; created_at: string;
}

const toModel = (row: ModelRow) => ({
  id: row.id, name: row.name, path: row.path, source: row.source, architecture: row.architecture,
  quantization: row.quantization, sizeBytes: row.size_bytes, trainContext: row.train_context, createdAt: row.created_at,
});

const toPreset = (row: PresetRow) => ({
  id: row.id, name: row.name, modelId: row.model_id, sampling: JSON.parse(row.sampling) as Sampling,
  systemPrompt: row.system_prompt, thinking: row.thinking === 1, contextSize: row.context_size,
  createdAt: row.created_at, updatedAt: row.updated_at,
});

const toThread = (row: ThreadRow) => ({
  id: row.id, title: row.title, workspaceId: row.workspace_id, lastPresetId: row.last_preset_id,
  autoApprove: row.auto_approve === 1, createdAt: row.created_at, updatedAt: row.updated_at,
});

const toMessage = (row: MessageRow) => ({
  id: row.id, turnId: row.turn_id, seq: row.seq, role: row.role, content: row.content,
  reasoning: row.reasoning, createdAt: row.created_at,
});

function isUniqueError(error: unknown): boolean {
  return (error as { code?: string }).code?.startsWith("SQLITE_CONSTRAINT_UNIQUE") ?? false;
}

export class Store {
  constructor(private db: Db) {}

  listModels() {
    return (this.db.prepare("SELECT * FROM models ORDER BY created_at DESC").all() as ModelRow[]).map(toModel);
  }

  getModel(id: string) {
    const row = this.db.prepare("SELECT * FROM models WHERE id = ?").get(id) as ModelRow | undefined;
    return row ? toModel(row) : null;
  }

  createModel(input: ModelInput) {
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
    return this.getModel(id)!;
  }

  listPresets() {
    return (this.db.prepare("SELECT * FROM presets ORDER BY name").all() as PresetRow[]).map(toPreset);
  }

  getPreset(id: string) {
    const row = this.db.prepare("SELECT * FROM presets WHERE id = ?").get(id) as PresetRow | undefined;
    return row ? toPreset(row) : null;
  }

  createPreset(input: { name: string; modelId: string; sampling: Sampling; systemPrompt?: string | null; thinking: boolean; contextSize: number }) {
    const model = this.getModel(input.modelId);
    if (!model) throw new ApiError("NOT_FOUND", "モデルがありません");
    if (model.trainContext !== null && input.contextSize > model.trainContext) {
      throw new ApiError("VALIDATION_ERROR", "contextSize はモデルの学習時の文脈長以下にしてください", [{ field: "contextSize" }]);
    }
    const id = ulid();
    const time = now();
    try {
      this.db.prepare(`INSERT INTO presets (id, name, model_id, sampling, system_prompt, thinking, context_size, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.name, input.modelId, JSON.stringify(input.sampling), input.systemPrompt ?? null, input.thinking ? 1 : 0, input.contextSize, time, time);
    } catch (error) {
      if (isUniqueError(error)) throw new ApiError("CONFLICT", "同じ名前のプリセットがあります");
      throw error;
    }
    return this.getPreset(id)!;
  }

  /** プリセットの LoRA を --lora の並び順で返す */
  presetAdapters(presetId: string) {
    return this.db.prepare(`SELECT a.path, pa.scale FROM preset_adapters pa JOIN adapters a ON a.id = pa.adapter_id
      WHERE pa.preset_id = ? ORDER BY pa.sort_order, a.id`).all(presetId) as { path: string; scale: number }[];
  }

  createThread(presetId: string | null) {
    const id = ulid();
    const time = now();
    this.db.prepare("INSERT INTO threads (id, title, last_preset_id, created_at, updated_at) VALUES (?, '', ?, ?, ?)")
      .run(id, presetId, time, time);
    return this.getThread(id)!;
  }

  getThread(id: string) {
    const row = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as ThreadRow | undefined;
    return row ? toThread(row) : null;
  }

  /** 更新の新しい順。カーソルは「updated_at|id」（D-41） */
  listThreads({ q, limit = 50, cursor }: { q?: string; limit?: number; cursor?: string }) {
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
    const sql = `SELECT * FROM threads ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC, id DESC LIMIT ?`;
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

  addMessage(input: { threadId: string; turnId: string | null; role: string; content: string; pinned?: boolean }) {
    const id = ulid();
    this.db.prepare(`INSERT INTO messages (id, thread_id, turn_id, seq, role, content, pinned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.threadId, input.turnId, this.nextSeq(input.threadId), input.role, input.content, input.pinned ? 1 : 0, now());
    return id;
  }

  updateMessage(id: string, content: string, reasoning: string | null): void {
    this.db.prepare("UPDATE messages SET content = ?, reasoning = ? WHERE id = ?").run(content, reasoning, id);
  }

  /** 送信を受け付ける：ターンとユーザーメッセージを1つのトランザクションで作る */
  beginTurn(threadId: string, presetId: string, content: string): string {
    return this.db.transaction(() => {
      const thread = this.getThread(threadId)!;
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

  /** 前回の異常終了で running のまま残ったターンを閉じる */
  failUnfinishedTurns(): void {
    this.db.prepare("UPDATE turns SET status = 'failed', error = 'アプリが終了しました', finished_at = ? WHERE status IN ('running', 'awaiting_approval', 'step_limit')").run(now());
  }

  /** モデルに送る会話。要約済みは除く */
  conversation(threadId: string) {
    return this.db.prepare(`SELECT role, content FROM messages WHERE thread_id = ? AND compacted_at IS NULL
      AND role IN ('user', 'assistant') AND content <> '' ORDER BY seq`).all(threadId) as { role: "user" | "assistant"; content: string }[];
  }

  threadDetail(threadId: string) {
    const messages = (this.db.prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY seq").all(threadId) as MessageRow[]).map(toMessage);
    const turns = this.db.prepare(`SELECT id, preset_id AS presetId, status, prompt_tokens AS promptTokens, completion_tokens AS completionTokens,
      started_at AS startedAt, finished_at AS finishedAt, error FROM turns WHERE thread_id = ? ORDER BY started_at`).all(threadId);
    return { messages, turns, toolCalls: [] as unknown[] };
  }
}
