import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { MIGRATIONS } from "./schema";

export type Db = Database.Database;

function migrate(db: Db, backupFile: string | null): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  const latest = MIGRATIONS.length;
  if (current > latest) {
    throw new Error(`DB の版 ${current} はこのアプリより新しいです（対応は ${latest} まで）`);
  }
  if (current === latest) return;

  // 版上げの前に1世代だけ残す（NFR-023）。新規作成のときは残すものがない
  if (current > 0 && backupFile) {
    mkdirSync(path.dirname(backupFile), { recursive: true });
    rmSync(backupFile, { force: true });
    db.prepare("VACUUM INTO ?").run(backupFile);
  }
  db.transaction(() => {
    for (let version = current; version < latest; version += 1) db.exec(MIGRATIONS[version]);
    db.pragma(`user_version = ${latest}`);
  })();
}

export function openDatabase(dataDir: string): Db {
  const dir = path.join(dataDir, "db");
  mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, "llm-party.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db, path.join(dir, "backup", "llm-party.sqlite"));
  return db;
}

export function openMemoryDatabase(): Db {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db, null);
  return db;
}
