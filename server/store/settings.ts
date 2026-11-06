import path from "node:path";
import type { Db } from "../db";

export const THEMES = ["system", "light", "dark"] as const;

/** 設定（FR-020）。localhost 段階で使うものだけ。modelsDir は未設定なら null（既定は呼ぶ側が決める） */
export interface Settings {
  modelsDir: string | null;
  defaultAutoApprove: boolean;
  defaultContextSize: number;
  theme: (typeof THEMES)[number];
}

/** 既定（FR-020 の表） */
const DEFAULTS: Settings = { modelsDir: null, defaultAutoApprove: false, defaultContextSize: 32768, theme: "system" };

export class SettingStore {
  constructor(private db: Db) {}

  /** 保存されたキーと既定を合わせた全部。壊れた値は既定に戻す */
  all(): Settings {
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
    const stored = new Map(rows.map((row) => [row.key, row.value]));
    const read = <K extends keyof Settings>(key: K, valid: (value: unknown) => boolean): Settings[K] => {
      const raw = stored.get(key);
      if (raw === undefined) return DEFAULTS[key];
      try {
        const value: unknown = JSON.parse(raw);
        return valid(value) ? (value as Settings[K]) : DEFAULTS[key];
      } catch {
        return DEFAULTS[key];
      }
    };
    return {
      modelsDir: read("modelsDir", (v) => typeof v === "string" && path.isAbsolute(v)),
      defaultAutoApprove: read("defaultAutoApprove", (v) => typeof v === "boolean"),
      defaultContextSize: read("defaultContextSize", (v) => Number.isInteger(v) && (v as number) > 0),
      theme: read("theme", (v) => THEMES.includes(v as Settings["theme"])),
    };
  }

  /** 値は JSON で入れる（TBL-016）。検証は呼ぶ側 */
  update(patch: Partial<Settings>): void {
    const upsert = this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) upsert.run(key, JSON.stringify(value));
      }
    })();
  }
}
