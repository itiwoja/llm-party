import { lstatSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** 中身ごと不可の場所（12 WSL での違い） */
const SYSTEM_DIRS = ["/etc", "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/boot", "/proc", "/sys", "/dev", "/var"];
/** `/mnt/c` のようなドライブ直下。この下のフォルダは選べる */
const DRIVE_ROOT = /^\/mnt\/[A-Za-z]$/;

const isSame = (a: string, b: string) => a === b;
export const isInside = (child: string, parent: string) => child === parent || child.startsWith(parent === "/" ? "/" : parent + path.sep);

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
  if (real === "/" || DRIVE_ROOT.test(real) || isSame(real, safeReal(home))) return null;
  if (SYSTEM_DIRS.some((dir) => isInside(real, dir))) return null;
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

/** 画面とモデルに見せる、ワークスペースからの相対パス */
export function relativeTo(workspace: string, absolute: string): string {
  return path.relative(safeReal(workspace), absolute) || ".";
}
