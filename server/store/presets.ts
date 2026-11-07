import { ulid } from "ulid";
import type { Db } from "../db";
import { ApiError } from "../http-error";
import { DEFAULT_EFFORT, type Effort } from "../thinking";
import type { ModelStore } from "./models";
import { isUniqueError, now } from "./shared";

/** 文脈長の下限（D-44） */
export const CONTEXT_MIN = 2048;

export interface Sampling {
  temperature: number;
  topP: number;
  topK: number;
  minP: number;
  presencePenalty: number;
  repeatPenalty: number;
}

export interface PresetAdapter {
  adapterId: string;
  scale: number;
}

export interface PresetInput {
  name: string;
  modelId: string;
  adapters?: PresetAdapter[];
  sampling: Sampling;
  systemPrompt?: string | null;
  thinking: boolean;
  /** 省けば DEFAULT_EFFORT。段階に対応するモデルでだけ使う（D-76） */
  effort?: Effort;
  contextSize: number;
  /** GPU に載せる割合（0〜100）。null か省略は自動（D-77） */
  gpuRatio?: number | null;
}

interface PresetRow {
  id: string; name: string; model_id: string; sampling: string; system_prompt: string | null;
  thinking: number; effort: string; context_size: number; gpu_ratio: number | null; created_at: string; updated_at: string;
}

export class PresetStore {
  constructor(private db: Db, private models: ModelStore) {}

  list() {
    return (this.db.prepare("SELECT * FROM presets ORDER BY name").all() as PresetRow[]).map((row) => this.toPreset(row));
  }

  get(id: string) {
    const row = this.db.prepare("SELECT * FROM presets WHERE id = ?").get(id) as PresetRow | undefined;
    return row ? this.toPreset(row) : null;
  }

  create(input: PresetInput) {
    this.validate(input);
    this.checkName(input.name);
    const id = ulid();
    const time = now();
    try {
      this.db.transaction(() => {
        this.db.prepare(`INSERT INTO presets (id, name, model_id, sampling, system_prompt, thinking, effort, context_size, gpu_ratio, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, input.name, input.modelId, JSON.stringify(input.sampling), input.systemPrompt ?? null, input.thinking ? 1 : 0, input.effort ?? DEFAULT_EFFORT, input.contextSize, input.gpuRatio ?? null, time, time);
        this.writeAdapters(id, input.adapters ?? []);
      })();
    } catch (error) {
      if (isUniqueError(error)) throw new ApiError("CONFLICT", "同じ名前のプリセットがあります");
      throw error;
    }
    return this.get(id)!;
  }

  /** 編集。値を合わせてから、変更後の全体を同じ規則で検証する */
  update(id: string, patch: Partial<PresetInput>) {
    const current = this.get(id);
    if (!current) throw new ApiError("NOT_FOUND", "プリセットがありません");
    const next: PresetInput = {
      name: current.name,
      modelId: current.modelId,
      adapters: current.adapters,
      sampling: current.sampling,
      systemPrompt: current.systemPrompt,
      thinking: current.thinking,
      effort: current.effort,
      contextSize: current.contextSize,
      gpuRatio: current.gpuRatio,
      ...patch,
    };
    this.validate(next);
    this.checkName(next.name, id);
    const time = now();
    try {
      this.db.transaction(() => {
        this.db.prepare(`UPDATE presets SET name = ?, model_id = ?, sampling = ?, system_prompt = ?, thinking = ?, effort = ?, context_size = ?, gpu_ratio = ?, updated_at = ?
          WHERE id = ?`)
          .run(next.name, next.modelId, JSON.stringify(next.sampling), next.systemPrompt ?? null, next.thinking ? 1 : 0, next.effort ?? DEFAULT_EFFORT, next.contextSize, next.gpuRatio ?? null, time, id);
        this.db.prepare("DELETE FROM preset_adapters WHERE preset_id = ?").run(id);
        this.writeAdapters(id, next.adapters ?? []);
      })();
    } catch (error) {
      if (isUniqueError(error)) throw new ApiError("CONFLICT", "同じ名前のプリセットがあります");
      throw error;
    }
    return this.get(id)!;
  }

  delete(id: string): void {
    // preset_adapters は CASCADE。eval_runs・threads・turns は SET NULL で、ランは中身を写して持つ
    this.db.prepare("DELETE FROM presets WHERE id = ?").run(id);
  }

  /** プリセットの LoRA を --lora の並び順で返す */
  adapters(presetId: string) {
    return this.db.prepare(`SELECT a.path, pa.scale FROM preset_adapters pa JOIN adapters a ON a.id = pa.adapter_id
      WHERE pa.preset_id = ? ORDER BY pa.sort_order, a.id`).all(presetId) as { path: string; scale: number }[];
  }

  /** API の形（{adapterId, scale}[]） */
  private presetAdapters(presetId: string): PresetAdapter[] {
    const rows = this.db.prepare("SELECT adapter_id, scale FROM preset_adapters WHERE preset_id = ? ORDER BY sort_order, adapter_id")
      .all(presetId) as { adapter_id: string; scale: number }[];
    return rows.map((row) => ({ adapterId: row.adapter_id, scale: row.scale }));
  }

  private toPreset(row: PresetRow) {
    return {
      id: row.id, name: row.name, modelId: row.model_id, adapters: this.presetAdapters(row.id),
      sampling: JSON.parse(row.sampling) as Sampling, systemPrompt: row.system_prompt, thinking: row.thinking === 1, effort: row.effort as Effort,
      contextSize: row.context_size, gpuRatio: row.gpu_ratio, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  private writeAdapters(presetId: string, adapters: PresetAdapter[]): void {
    const insert = this.db.prepare("INSERT INTO preset_adapters (preset_id, adapter_id, scale, sort_order) VALUES (?, ?, ?, ?)");
    adapters.forEach((adapter, order) => insert.run(presetId, adapter.adapterId, adapter.scale, order));
  }

  private checkName(name: string, exceptId?: string): void {
    const row = this.db.prepare("SELECT id FROM presets WHERE name = ?").get(name) as { id: string } | undefined;
    if (row && row.id !== exceptId) throw new ApiError("CONFLICT", "同じ名前のプリセットあり。別の名前が必要");
  }

  /** 作成と編集で共通の検証（モデル・文脈長・LoRA のベースモデル一致・重複） */
  private validate(input: Pick<PresetInput, "modelId" | "contextSize" | "adapters">): void {
    const model = this.models.get(input.modelId);
    if (model && model.use !== "chat") throw new ApiError("VALIDATION_ERROR", "画像・音楽のモデルはチャットのプリセットに使えません", [{ field: "modelId" }]);
    if (!model) throw new ApiError("NOT_FOUND", "モデルがありません");
    if (model.trainContext !== null && input.contextSize > model.trainContext) {
      throw new ApiError("VALIDATION_ERROR", `文脈長の範囲外。${CONTEXT_MIN}〜${model.trainContext} で指定`, [{ field: "contextSize" }]);
    }
    const adapters = input.adapters ?? [];
    if (new Set(adapters.map((adapter) => adapter.adapterId)).size !== adapters.length) {
      throw new ApiError("VALIDATION_ERROR", "同じ LoRA を2つ選べません", [{ field: "adapters" }]);
    }
    for (const adapter of adapters) {
      const row = this.db.prepare("SELECT base_model_id FROM adapters WHERE id = ?").get(adapter.adapterId) as { base_model_id: string } | undefined;
      if (!row) throw new ApiError("NOT_FOUND", "LoRA がありません");
      if (row.base_model_id !== input.modelId) {
        throw new ApiError("VALIDATION_ERROR", "ベースモデルが違う LoRA。別の LoRA を選択", [{ field: "adapters" }]);
      }
    }
  }
}
