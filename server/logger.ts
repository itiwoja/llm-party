import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

/** ログを残す日数（D-30） */
export const LOG_KEEP_DAYS = 14;

/** Bearer の値と HF トークンらしい文字列を伏せる。会話の本文は呼ぶ側が渡さない */
export function scrub(text: string): string {
  return text.replace(/Bearer\s+[^\s"']+/gi, "Bearer ***").replace(/\bhf_[A-Za-z0-9]{8,}/g, "hf_***");
}

/** 14 日より古い .log を消す。llama-server のログも対象。消した数を返す */
export function pruneLogs(logsDir: string, nowMs = Date.now()): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(logsDir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.endsWith(".log")) continue;
    const file = path.join(logsDir, name);
    if (nowMs - statSync(file).mtimeMs > LOG_KEEP_DAYS * 24 * 60 * 60 * 1000) {
      rmSync(file, { force: true });
      removed += 1;
    }
  }
  return removed;
}

type Level = "INFO" | "WARN" | "ERROR";

/** worker の動作とエラーを logs/app-YYYYMMDD.log に書く（FR-021）。初期化前は何もしない */
class Logger {
  private dir: string | null = null;

  init(logsDir: string): void {
    mkdirSync(logsDir, { recursive: true });
    this.dir = logsDir;
  }

  info(message: string): void {
    this.write("INFO", message);
  }

  warn(message: string): void {
    this.write("WARN", message);
  }

  /** エラーはスタックまで書く */
  error(message: string, error?: unknown): void {
    const detail = error instanceof Error ? (error.stack ?? error.message) : error === undefined ? "" : String(error);
    this.write("ERROR", detail ? `${message}\n${detail}` : message);
  }

  private write(level: Level, message: string): void {
    if (!this.dir) return;
    const time = new Date().toISOString();
    try {
      appendFileSync(path.join(this.dir, `app-${time.slice(0, 10).replaceAll("-", "")}.log`), `${time} ${level} ${scrub(message)}\n`);
    } catch {
      // ログが書けなくても処理は止めない
    }
  }
}

export const logger = new Logger();
