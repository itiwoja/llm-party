import { lstatSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** 中身ごと不可の場所（12 実行環境での違い） */
const SYSTEM_DIRS = ["/etc", "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/boot", "/proc", "/sys", "/dev", "/var"];
/** `/mnt/c` のようなドライブ直下。この下のフォルダは選べる */
const DRIVE_ROOT = /^\/mnt\/[A-Za-z]$/;
/** Windows のドライブ直下と、中身ごと不可の場所（FR-007）。大文字と小文字は区別しない */
const WINDOWS_DRIVE_ROOT = /^[A-Za-z]:\\?$/;
const WINDOWS_SYSTEM_DIR = /^[A-Za-z]:\\(windows|program files[^\\]*)(\\|$)/i;

/** Windows のパスは大文字と小文字を区別しない */
const foldCase = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
const isSame = (a: string, b: string) => foldCase(a) === foldCase(b);
export function isInside(child: string, parent: string): boolean {
  const [inner, outer] = [foldCase(child), foldCase(parent)];
  return inner === outer || inner.startsWith(outer.endsWith(path.sep) ? outer : outer + path.sep);
}

/** ドライブ直下・OS の場所か（FR-007） */
export function isSystemPath(real: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") return WINDOWS_DRIVE_ROOT.test(real) || WINDOWS_SYSTEM_DIR.test(real);
  return real === "/" || DRIVE_ROOT.test(real) || SYSTEM_DIRS.some((dir) => isInside(real, dir));
}

/** 存在すれば realpath。なければ存在する親までを解決して残りを足す。壊れたリンクは例外 */
export function realpathLoose(target: string): string {
  try {
    return realpathSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    lstatSync(target);
  } catch {
    const parent = path.dirname(target);
    if (parent === target) return target;
    return path.join(realpathLoose(parent), path.basename(target));
  }
  // lstat は通るのに realpath が通らない = リンク先がない。外へ向いているかもしれないので辿らない
  throw new PathDeniedError("リンク先がありません");
}

/** ワークスペース外・不可の場所を指したとき（tool_calls.status = denied になる） */
export class PathDeniedError extends Error {}

export interface WorkspaceCheckOptions {
  dataDir: string;
  home?: string;
}

/** FR-007：登録できるフォルダか。できるなら実体のパスを返す。だめなら null */
export function checkWorkspace(input: string, { dataDir, home = os.homedir() }: WorkspaceCheckOptions): string | null {
  let real: string;
  try {
    real = realpathSync(path.resolve(input));
    if (!statSync(real).isDirectory()) return null;
  } catch {
    return null;
  }
  if (isSystemPath(real) || isSame(real, safeReal(home))) return null;
  if (isInside(real, safeReal(dataDir))) return null;
  return real;
}

export function safeReal(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

export interface ResolveOptions {
  /** ワークスペースの中でも触らせない場所（データフォルダ） */
  deny?: string[];
}

/** FR-010：相対パスを実体に解決し、ワークスペース外なら PathDeniedError。以後の操作は返した値で行う */
export function resolveInWorkspace(workspace: string, relative: string, { deny = [] }: ResolveOptions = {}): string {
  const root = safeReal(workspace);
  const real = realpathLoose(path.resolve(root, relative));
  if (!isInside(real, root)) throw new PathDeniedError("ワークスペースの外は使えません");
  if (deny.some((dir) => isInside(real, safeReal(dir)))) throw new PathDeniedError("このパスは使えません");
  return real;
}

/** 画面とモデルに見せる、ワークスペースからの相対パス。区切りは OS によらず / */
export function relativeTo(workspace: string, absolute: string): string {
  return path.relative(safeReal(workspace), absolute).split(path.sep).join("/") || ".";
}
