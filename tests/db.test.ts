import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase, openMemoryDatabase } from "../server/db";
import { MIGRATIONS } from "../server/db/schema";
import { Store } from "../server/store";
import { tempDir } from "./helpers";

function seededStore() {
  const db = openMemoryDatabase();
  return { db, store: new Store(db) };
}

describe("DB の版上げ", () => {
  it("空の DB に 18 テーブルを作る", () => {
    const { db } = seededStore();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'threads_fts%'").all();
    expect(tables).toHaveLength(18);
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("新規作成ではバックアップを作らず、版上げのときだけ1世代残す", () => {
    const { dir, remove } = tempDir();
    const backup = path.join(dir, "db", "backup", "llm-party.sqlite");
    try {
      openDatabase(dir).close();
      expect(existsSync(backup)).toBe(false);

      MIGRATIONS.push("CREATE TABLE extra (id TEXT);");
      try {
        const db = openDatabase(dir);
        expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
        db.close();
        expect(existsSync(backup)).toBe(true);
      } finally {
        MIGRATIONS.pop();
      }
    } finally {
      remove();
    }
  });

  it("アプリより新しい DB は開かない", () => {
    const { dir, remove } = tempDir();
    try {
      const db = openDatabase(dir);
      db.pragma("user_version = 999");
      db.close();
      expect(() => openDatabase(dir)).toThrow(/新しい/);
    } finally {
      remove();
    }
  });
});

describe("スレッド検索（D-58）", () => {
  function storeWithThreads() {
    const { db, store } = seededStore();
    const a = store.threads.create(null);
    const b = store.threads.create(null);
    store.threads.addMessage({ threadId: a.id, turnId: null, role: "user", content: "ログイン処理のバグを直してください" });
    store.threads.addMessage({ threadId: b.id, turnId: null, role: "user", content: "100%_完了 の意味" });
    return { db, store, a, b };
  }

  it("3文字以上は本文の途中でも見つかる", () => {
    const { store, a } = storeWithThreads();
    expect(store.threads.list({ q: "処理のバグ" }).items.map((t) => t.id)).toEqual([a.id]);
  });

  it("2文字以下も見つかる", () => {
    const { store, a } = storeWithThreads();
    expect(store.threads.list({ q: "バグ" }).items.map((t) => t.id)).toEqual([a.id]);
  });

  it("LIKE の記号は文字として扱う", () => {
    const { store, b } = storeWithThreads();
    expect(store.threads.list({ q: "%_" }).items.map((t) => t.id)).toEqual([b.id]);
    expect(store.threads.list({ q: "__" }).items).toEqual([]);
  });

  it("引用符を含む語でも SQL エラーにしない", () => {
    const { store } = storeWithThreads();
    expect(store.threads.list({ q: 'ab"cd' }).items).toEqual([]);
  });

  it("メッセージを消すと検索からも消える", () => {
    const { db, store } = storeWithThreads();
    db.prepare("DELETE FROM messages").run();
    expect(store.threads.list({ q: "処理のバグ" }).items).toEqual([]);
  });

  it("カーソルで続きを取れる", () => {
    const { store, a, b } = storeWithThreads();
    const first = store.threads.list({ limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = store.threads.list({ limit: 1, cursor: first.nextCursor! });
    expect(new Set([first.items[0].id, second.items[0].id])).toEqual(new Set([a.id, b.id]));
    expect(second.nextCursor).toBeNull();
  });
});
