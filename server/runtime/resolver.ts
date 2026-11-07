import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { isMissingBinaryPath } from "../binary";
import { LLAMA_FLAVORS, type LlamaFlavor } from "./manifest";

/** nvidia-smi が動けば NVIDIA の GPU があるとみなす（判断 D3） */
export function hasNvidiaGpu(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("nvidia-smi", ["-L"], { timeout: 5000 }, (error, stdout) => {
      resolve(!error && stdout.trim().length > 0);
    });
  });
}

export type LlamaResolution =
  /** LLM_PARTY_LLAMA_BIN で指定された（バックエンドは呼び出し側の設定を使う） */
  | { status: "override"; bin: string }
  /** 取得済み */
  | { status: "installed"; bin: string; flavor: LlamaFlavor["id"] }
  /** まだ無い。取得すると installDir に入る */
  | { status: "missing"; flavor: LlamaFlavor["id"]; installDir: string };

/** 置き場のフォルダ。<データ>/runtime/llama/<版-種類>/ */
export function installDirFor(dataDir: string, flavor: LlamaFlavor["id"]): string {
  return path.join(dataDir, "runtime", "llama", LLAMA_FLAVORS[flavor].dirName);
}

/** 実在しないパスの指定を無視したときの警告（CP-313）。無視しないなら null（ADR-012） */
export function ignoredOverrideWarning(override: string | null): string | null {
  if (!override || !isMissingBinaryPath(override)) return null;
  return `LLM_PARTY_LLAMA_BIN のパスが見つからないので、指定を無視しました: ${override}。起動コマンドから外すと消えます`;
}

/** llama-server の場所を決める。順番：上書き → 取得済み → 未導入。実在しないパスの指定は無視する */
export function resolveLlama(input: { override: string | null; dataDir: string; flavor: LlamaFlavor["id"] }): LlamaResolution {
  if (input.override && !isMissingBinaryPath(input.override)) return { status: "override", bin: input.override };
  const installDir = installDirFor(input.dataDir, input.flavor);
  const bin = path.join(installDir, "llama-server");
  if (existsSync(bin)) return { status: "installed", bin, flavor: input.flavor };
  return { status: "missing", flavor: input.flavor, installDir };
}
