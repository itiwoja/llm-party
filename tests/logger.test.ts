import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { logger, pruneLogs, scrub } from "../server/logger";
import { tempDir } from "./helpers";

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  tmp = tempDir();
});
afterEach(() => tmp.remove());

const age = (file: string, days: number) => {
  const time = new Date(Date.now() - days * 86_400_000);
  utimesSync(file, time, time);
};

describe("ログ", () => {
  it("app-YYYYMMDD.log に時刻・レベル付きで書き、Bearer を伏せる", () => {
    logger.init(tmp.dir);
    logger.info("hello Bearer topsecret");
    logger.error("boom", new Error("failed"));
    const name = readdirSync(tmp.dir).find((file) => /^app-\d{8}\.log$/.test(file))!;
    const text = readFileSync(path.join(tmp.dir, name), "utf8");
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z INFO hello Bearer \*\*\*\n/);
    expect(text).toContain("ERROR boom");
    expect(text).not.toContain("topsecret");
  });

  it("scrub は Bearer と HF トークンを伏せる", () => {
    expect(scrub("Authorization: Bearer abc123 and hf_abcdefghijk")).toBe("Authorization: Bearer *** and hf_***");
  });

  it("14 日より古い .log だけ消す（llama-server のログも）", () => {
    mkdirSync(tmp.dir, { recursive: true });
    const files = { "app-old.log": 15, "llama-server-old.log": 20, "app-new.log": 13, "note.txt": 30 };
    for (const [name, days] of Object.entries(files)) {
      const file = path.join(tmp.dir, name);
      writeFileSync(file, "x");
      age(file, days);
    }
    expect(pruneLogs(tmp.dir)).toBe(2);
    expect(existsSync(path.join(tmp.dir, "app-old.log"))).toBe(false);
    expect(existsSync(path.join(tmp.dir, "llama-server-old.log"))).toBe(false);
    expect(existsSync(path.join(tmp.dir, "app-new.log"))).toBe(true);
    expect(existsSync(path.join(tmp.dir, "note.txt"))).toBe(true);
  });

  it("フォルダがなくても落ちない", () => {
    expect(pruneLogs(path.join(tmp.dir, "none"))).toBe(0);
  });
});
