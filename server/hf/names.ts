import path from "node:path";
import { ApiError } from "../http-error";

const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SPLIT = /^(.*)-(\d{5})-of-(\d{5})\.(gguf|safetensors)$/;
/** モデル本体と分かる拡張子。ファイル一覧で設定ファイルより先に並べる */
const WEIGHTS = /\.(gguf|safetensors|ckpt|pt|pth|bin|onnx)$/i;
const QUANT = /(?:^|[-_.])((?:UD-)?(?:IQ\d(?:_[A-Z0-9]+)*|Q\d(?:_[A-Z0-9]+)*|BF16|F16|F32|MXFP4))(?=[-_.]|$)/gi;

/** repo は `owner/name` の形だけ。`..` や絶対パスは通さない */
export function assertRepo(repo: string): void {
  if (!REPO.test(repo) || repo.includes("..")) throw new ApiError("VALIDATION_ERROR", "入力が正しくありません", [{ field: "repo" }]);
}

/** リポジトリ内のファイル名（サブフォルダ可）。置き場の外へ出る形は通さない */
export function assertFileName(name: string, field = "files"): void {
  const segments = name.split("/");
  const bad =
    name.includes("\\") ||
    name.includes("\0") ||
    path.isAbsolute(name) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..");
  if (bad) throw new ApiError("VALIDATION_ERROR", "入力が正しくありません", [{ field }]);
}

/** 置き場の中に収まる絶対パスを返す。収まらなければ拒否 */
export function insideDir(root: string, ...parts: string[]): string {
  const resolved = path.resolve(root, ...parts);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) {
    throw new ApiError("PATH_NOT_ALLOWED", "置き場の外には保存できません");
  }
  return resolved;
}

/** チャット用（model / adapter）の DL は GGUF に限る。それ以外は保存だけの `file` で取る */
export function assertGguf(name: string, field = "files"): void {
  if (!name.toLowerCase().endsWith(".gguf")) throw new ApiError("VALIDATION_ERROR", "入力が正しくありません", [{ field }]);
}

export const encodePath = (value: string) => value.split("/").map(encodeURIComponent).join("/");

/** ファイル名から量子化の種類を取る（最後に見つかったもの） */
export function quantOf(file: string): string | null {
  const matches = [...path.basename(file).matchAll(QUANT)];
  return matches.length ? matches[matches.length - 1][1].toUpperCase() : null;
}

export interface TreeFile {
  path: string;
  size: number;
  sha256: string | null;
}

export interface FileGroup {
  /** 登録に使う名前（分割なら先頭のファイル） */
  name: string;
  quantization: string | null;
  sizeBytes: number;
  split: boolean;
  /** 分割の部品が全部そろっているか */
  complete: boolean;
  parts: TreeFile[];
}

/** 分割ファイル（`-00001-of-0000N`）を1つにまとめる。並びはモデル本体が先、その中はファイル名順 */
export function groupFiles(files: TreeFile[]): FileGroup[] {
  const groups = new Map<string, { total: number; parts: TreeFile[] }>();
  const singles: FileGroup[] = [];
  for (const file of files) {
    const match = SPLIT.exec(file.path);
    if (!match) {
      singles.push({ name: file.path, quantization: quantOf(file.path), sizeBytes: file.size, split: false, complete: true, parts: [file] });
      continue;
    }
    const key = `${match[1]}\0${match[3]}\0${match[4]}`;
    const group = groups.get(key) ?? { total: Number(match[3]), parts: [] };
    group.parts.push(file);
    groups.set(key, group);
  }
  const split = [...groups.values()].map(({ total, parts }): FileGroup => {
    parts.sort((a, b) => a.path.localeCompare(b.path));
    return {
      name: parts[0].path,
      quantization: quantOf(parts[0].path),
      sizeBytes: parts.reduce((sum, part) => sum + part.size, 0),
      split: true,
      complete: parts.length === total && SPLIT.exec(parts[0].path)![2] === "00001",
      parts,
    };
  });
  const rank = (group: FileGroup) => (WEIGHTS.test(group.name) ? 0 : 1);
  return [...singles, ...split].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** 画像モデルは単一の .safetensors に限る（分割は未対応） */
export function assertSafetensors(name: string, field = "files"): void {
  if (!name.toLowerCase().endsWith(".safetensors") || SPLIT.test(name)) {
    throw new ApiError("VALIDATION_ERROR", "入力が正しくありません", [{ field }]);
  }
}

/** 指定されたファイルに、分割の仲間を足して返す。ツリーにないものは拒否 */
export function expandSelection(requested: string[], tree: TreeFile[]): TreeFile[] {
  const groups = groupFiles(tree);
  const picked = new Map<string, TreeFile>();
  for (const name of requested) {
    const group = groups.find((item) => item.parts.some((part) => part.path === name));
    if (!group) throw new ApiError("VALIDATION_ERROR", "ファイルが見つかりません", [{ field: "files" }]);
    if (!group.complete) throw new ApiError("VALIDATION_ERROR", "分割ファイルがそろっていません", [{ field: "files" }]);
    for (const part of group.parts) picked.set(part.path, part);
  }
  return [...picked.values()];
}
