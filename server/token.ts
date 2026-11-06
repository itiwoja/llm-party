import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** data/local-token を読む。なければ作る（権限 600）。起動をまたいで同じ値を使う */
export function loadOrCreateToken(dataDir: string): string {
  const file = path.join(dataDir, "local-token");
  mkdirSync(dataDir, { recursive: true });
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing) {
      chmodSync(file, 0o600);
      return existing;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}
