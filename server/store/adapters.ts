import { ulid } from "ulid";
import type { Db } from "../db";
import { ApiError } from "../http-error";
import { isUniqueError, now } from "./shared";

export interface AdapterInput {
  baseModelId: string;
  name: string;
  path: string;
  source: "local_ref" | "local_copy" | "hf";
  architecture: string;
}

interface AdapterRow {
  id: string; base_model_id: string; name: string; path: string; source: string; architecture: string; created_at: string; updated_at: string;
}

const toAdapter = (row: AdapterRow) => ({
  id: row.id, baseModelId: row.base_model_id, name: row.name, path: row.path, source: row.source,
  architecture: row.architecture, createdAt: row.created_at, updatedAt: row.updated_at,
});

/** LoRA（API-058〜059） */
export class AdapterStore {
  constructor(private db: Db) {}

  list() {
    return (this.db.prepare("SELECT * FROM adapters ORDER BY created_at DESC").all() as AdapterRow[]).map(toAdapter);
  }

  get(id: string) {
    const row = this.db.prepare("SELECT * FROM adapters WHERE id = ?").get(id) as AdapterRow | undefined;
    return row ? toAdapter(row) : null;
  }

  create(input: AdapterInput) {
    const id = ulid();
    const time = now();
    try {
      this.db.prepare(`INSERT INTO adapters (id, base_model_id, name, path, source, architecture, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.baseModelId, input.name, input.path, input.source, input.architecture, time, time);
    } catch (error) {
      if (isUniqueError(error)) throw new ApiError("CONFLICT", "このファイルは登録済みです");
      throw error;
    }
    return this.get(id)!;
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM adapters WHERE id = ?").run(id);
  }

  /** このLoRAを使っているプリセットの名前（preset_adapters は RESTRICT） */
  presetNames(id: string): string[] {
    return (this.db.prepare(`SELECT p.name FROM preset_adapters pa JOIN presets p ON p.id = pa.preset_id
      WHERE pa.adapter_id = ? ORDER BY p.name`).all(id) as { name: string }[]).map((row) => row.name);
  }
}
