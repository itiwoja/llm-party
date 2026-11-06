import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const tokenFile = (dataDir: string) => path.join(dataDir, "secrets", "hf-token");

/** HF トークン（API-094）。平文で保存し、画面には返さない */
export function readHfToken(dataDir: string): string | null {
  try {
    return readFileSync(tokenFile(dataDir), "utf8").trim() || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function writeHfToken(dataDir: string, token: string | null): void {
  const file = tokenFile(dataDir);
  if (token === null) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, token, { mode: 0o600 });
  chmodSync(file, 0o600); // 既にあるファイルは mode が効かない
}
