import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

/** Windows の %LOCALAPPDATA% の下の置き場（WSL から見たパス）。取れなければ null */
export function windowsCacheDir(): string | null {
  try {
    const local = execFileSync("cmd.exe", ["/c", "echo %LOCALAPPDATA%"], { encoding: "utf8", cwd: "/mnt/c", timeout: 5000 }).trim();
    return path.join(execFileSync("wslpath", ["-u", local], { encoding: "utf8" }).trim(), "llm-party", "image-models");
  } catch {
    return null;
  }
}

/**
 * Windows の exe が読むモデルの写し（D-85）。\\wsl.localhost 経由の読み取りは遅く、
 * 1 枚の大半が読み込みになるので、Windows のディスクに写してそこから読ませる。元のファイルは消さない
 */
export class HostModelCache {
  constructor(private dir: string) {}

  /** 同じパスでも別のフォルダの同名ファイルと混ざらないよう、元のパスの hash を名前に入れる */
  private copyPath(file: string): string {
    const hash = createHash("sha256").update(file).digest("hex").slice(0, 12);
    return path.join(this.dir, `${hash}-${path.basename(file)}`);
  }

  /** 写しのパスを返す。無いか大きさが違えば写す。写せなければ元のパスのまま（遅いが動く） */
  async localize(file: string): Promise<string> {
    const copy = this.copyPath(file);
    try {
      const source = await stat(file);
      const existing = await stat(copy).catch(() => null);
      if (existing?.size === source.size) return copy;
      await mkdir(this.dir, { recursive: true });
      // 途中で止まっても、書きかけを写しとして使わない
      const partial = `${copy}.partial`;
      await copyFile(file, partial);
      await rename(partial, copy);
      return copy;
    } catch {
      return file;
    }
  }

  /** モデルを消したら写しも消す */
  async drop(file: string): Promise<void> {
    const copy = this.copyPath(file);
    await Promise.all([rm(copy, { force: true }), rm(`${copy}.partial`, { force: true })]);
  }
}
