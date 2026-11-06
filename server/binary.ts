import { existsSync } from "node:fs";

/**
 * 外部バイナリ（llama-server / sd-server）のパスが実在するかを確かめる。
 * パスの形（/ や \ を含む）で指定されたものだけ見る。PATH 上の名前は spawn に任せる。
 * 問題がなければ null、あれば画面に出す説明を返す。
 */
export function missingBinaryMessage(bin: string, envName: string): string | null {
  if (!/[\\/]/.test(bin)) return null;
  if (existsSync(bin)) return null;
  return `${envName} のファイルが見つかりません: ${bin}（パスが正しいか確かめてください）`;
}
