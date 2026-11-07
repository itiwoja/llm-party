import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, lstatSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { unifiedDiff } from "./diff";
import { isInside, PathDeniedError, relativeTo, resolveInWorkspace, safeReal } from "./paths";
import { runShell, SHELL_NAME } from "./shell";

/** D-26 */
const MAX_READ_BYTES = 2 * 1024 * 1024;
/** 中を見せないフォルダ（FR-009） */
const HIDDEN_DIRS = new Set([".git", "node_modules"]);

export type ToolKind = "read" | "write" | "command";
export type ToolStatus = "succeeded" | "failed" | "timed_out";

/** モデルに返す結果。output は切り詰め前 */
export interface ToolResult {
  status: ToolStatus;
  output: string;
  exitCode?: number | null;
}

/** FR-011 が記録する変更。before が null なら新規作成 */
export interface FileChange {
  /** ワークスペースからの相対パス */
  path: string;
  before: string | null;
  after: string;
}

export interface ToolContext {
  workspace: string;
  /** ワークスペースの中でも触らせない場所（データフォルダ） */
  deny: string[];
  signal: AbortSignal;
  commandTimeoutMs: number;
  onOutput?(chunk: string): void;
  /** write_file / edit_file が書いた直後。FR-011 の file_changes はここへ差し込む */
  onFileChange?(change: FileChange): void;
}

/** モデルに「失敗」として返す（status = failed）。メッセージがそのままモデルに届く */
class ToolFailure extends Error {}

const path_ = z.string().min(1).describe("ワークスペースからの相対パス");

const SPECS = {
  list_dir: {
    kind: "read" as const,
    description: "フォルダの中のファイルとフォルダを一覧する。.git と node_modules の中は見せない",
    schema: z.object({ path: path_.default("."), depth: z.number().int().min(1).default(1).describe("たどる深さ（既定 1）") }),
  },
  read_file: {
    kind: "read" as const,
    description: "テキストファイルを行番号つきで読む。2MB を超えるファイルとバイナリは読めない",
    schema: z.object({ path: path_, startLine: z.number().int().min(1).optional(), endLine: z.number().int().min(1).optional() }),
  },
  search: {
    kind: "read" as const,
    description: "正規表現に一致した行を「パス:行番号: 内容」で返す",
    schema: z.object({ pattern: z.string().min(1).describe("正規表現"), path: path_.optional(), glob: z.string().min(1).optional().describe("対象のファイル名（例: *.ts）") }),
  },
  write_file: {
    kind: "write" as const,
    description: "ファイルを新規作成するか、全体を上書きする。フォルダがなければ作る",
    schema: z.object({ path: path_, content: z.string() }),
  },
  edit_file: {
    kind: "write" as const,
    description: "oldText が1か所だけ一致するときに newText へ置換する。replaceAll なら一致した全部を置換する。0 か所・複数は失敗",
    schema: z.object({ path: path_, oldText: z.string().min(1), newText: z.string(), replaceAll: z.boolean().optional() }),
  },
  run_command: {
    kind: "command" as const,
    description: `シェル（${SHELL_NAME}）でコマンドを実行し、終了コードと出力を返す。cwd はワークスペース内。120 秒で終了する`,
    schema: z.object({ command: z.string().min(1), cwd: path_.optional() }),
  },
};

export type ToolName = keyof typeof SPECS;
export const isToolName = (name: string): name is ToolName => Object.hasOwn(SPECS, name);
export const toolKind = (name: ToolName): ToolKind => SPECS[name].kind;

/** llama-server の `tools`（API-101） */
export function toolDefinitions() {
  return (Object.keys(SPECS) as ToolName[]).map((name) => {
    const { $schema: _unused, ...parameters } = z.toJSONSchema(SPECS[name].schema, { io: "input" }) as Record<string, unknown>;
    return { type: "function" as const, function: { name, description: SPECS[name].description, parameters } };
  });
}

/** 実行前の下ごしらえの結果。ok でなければそのままモデルに返す */
export type Plan =
  | { ok: false; status: "failed" | "denied"; message: string }
  | { ok: true; kind: ToolKind; args: Record<string, unknown>; preview?: string; run(): Promise<ToolResult> };

const fail = (status: "failed" | "denied", message: string): Plan => ({ ok: false, status, message });

/** FR-008・FR-010：名前・引数・パスを確かめる。承認の前に呼び、通れば run() で実行する */
export function planToolCall(name: string, rawArguments: string, context: ToolContext): Plan {
  if (!isToolName(name)) return fail("failed", `不明なツールです: ${name}`);
  let json: unknown;
  try {
    json = JSON.parse(rawArguments || "{}");
  } catch {
    return fail("failed", "引数が JSON として壊れています。JSON で書き直して呼び直してください");
  }
  const parsed = SPECS[name].schema.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join(".") || "引数"}: ${issue.message}`).join(", ");
    return fail("failed", `引数が正しくありません（${detail}）`);
  }
  const args = parsed.data as Record<string, unknown>;
  const kind = SPECS[name].kind;

  try {
    // 承認の前にパスを実体に解決して、外なら拒否する
    const target = (relative: string) => resolveInWorkspace(context.workspace, relative, { deny: context.deny });
    const rel = (args.path ?? args.cwd) as string | undefined;
    if (rel !== undefined) target(rel);
    if (name === "run_command" && args.cwd === undefined) target(".");

    const preview = kind === "write" ? previewWrite(name, args, context) : undefined;
    return {
      ok: true, kind, args, preview,
      run: () => execute(name, args, context),
    };
  } catch (error) {
    if (error instanceof PathDeniedError) return fail("denied", error.message);
    if (error instanceof ToolFailure) return fail("failed", error.message);
    throw error;
  }
}

async function execute(name: ToolName, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  try {
    const target = (relative: string) => resolveInWorkspace(context.workspace, relative, { deny: context.deny });
    switch (name) {
      case "list_dir": return ok(listDir(target(args.path as string), args.depth as number, hiddenRoots(context)));
      case "read_file": return ok(readFileTool(target(args.path as string), args.startLine as number | undefined, args.endLine as number | undefined));
      case "search": return ok(searchTool(context, target((args.path as string | undefined) ?? "."), args.pattern as string, args.glob as string | undefined));
      case "write_file": return ok(writeFileTool(context, target(args.path as string), args.content as string));
      case "edit_file": return ok(editFileTool(context, target(args.path as string), args.oldText as string, args.newText as string, args.replaceAll === true));
      case "run_command": return await runCommandTool(context, target((args.cwd as string | undefined) ?? "."), args.command as string);
    }
  } catch (error) {
    if (error instanceof ToolFailure) return { status: "failed", output: error.message };
    throw error;
  }
}

const ok = (output: string): ToolResult => ({ status: "succeeded", output });

/** 一覧・検索でたどるときに入らない場所。読み取りは承認なしで動くので、データフォルダの秘密を見せない */
const hiddenRoots = (context: ToolContext) => context.deny.map(safeReal);
const isHidden = (dir: string, name: string, roots: string[]) =>
  HIDDEN_DIRS.has(name) || roots.some((root) => isInside(path.join(dir, name), root));

// ---- 読み取り ----

function readText(file: string): string {
  let info;
  try {
    info = statSync(file);
  } catch {
    throw new ToolFailure("ファイルがありません");
  }
  if (!info.isFile()) throw new ToolFailure("ファイルではありません");
  if (info.size > MAX_READ_BYTES) throw new ToolFailure("2MB を超えるファイルは読めません");
  const raw = readFileSync(file);
  if (raw.includes(0)) throw new ToolFailure("バイナリファイルは読めません");
  return raw.toString("utf8");
}

const splitLines = (text: string) => {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

function listDir(dir: string, depth: number, roots: string[]): string {
  let info;
  try {
    info = statSync(dir);
  } catch {
    throw new ToolFailure("フォルダがありません");
  }
  if (!info.isDirectory()) throw new ToolFailure("フォルダではありません");
  const lines: string[] = [];
  const walk = (current: string, level: number) => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const indent = "  ".repeat(level);
      if (entry.isDirectory()) {
        lines.push(`${indent}${entry.name}/`);
        if (level + 1 < depth && !isHidden(current, entry.name, roots)) walk(path.join(current, entry.name), level + 1);
      } else {
        lines.push(`${indent}${entry.name}`);
      }
    }
  };
  walk(dir, 0);
  return lines.length ? lines.join("\n") : "（空のフォルダ）";
}

function readFileTool(file: string, startLine?: number, endLine?: number): string {
  const lines = splitLines(readText(file));
  if (lines.length === 0) return "（空のファイル）";
  const from = startLine ?? 1;
  const to = Math.min(endLine ?? lines.length, lines.length);
  if (from > lines.length) throw new ToolFailure(`ファイルは ${lines.length} 行です`);
  if (to < from) throw new ToolFailure("endLine は startLine 以上にしてください");
  return lines.slice(from - 1, to).map((line, index) => `${from + index}\t${line}`).join("\n");
}

function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      i += 1;
      if (glob[i + 1] === "/") {
        i += 1;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

function* walkFiles(dir: string, roots: string[]): Generator<string> {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!isHidden(dir, entry.name, roots)) yield* walkFiles(full, roots);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function searchTool(context: ToolContext, start: string, pattern: string, glob?: string): string {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (error) {
    throw new ToolFailure(`正規表現が正しくありません: ${(error as Error).message}`);
  }
  const matcher = glob ? globToRegExp(glob) : null;
  let info;
  try {
    info = statSync(start);
  } catch {
    throw new ToolFailure("パスがありません");
  }
  const root = info.isDirectory() ? start : path.dirname(start);
  const files = info.isDirectory() ? walkFiles(start, hiddenRoots(context)) : [start];
  const hits: string[] = [];
  for (const file of files) {
    const fromRoot = path.relative(root, file).split(path.sep).join("/");
    if (matcher && !matcher.test(glob!.includes("/") ? fromRoot : path.basename(file))) continue;
    let text: string;
    try {
      text = readText(file);
    } catch {
      continue; // バイナリ・巨大・読めないファイルは飛ばす
    }
    splitLines(text).forEach((line, index) => {
      if (regex.test(line)) hits.push(`${relativeTo(context.workspace, file)}:${index + 1}: ${line}`);
    });
  }
  return hits.length ? hits.join("\n") : "一致なし";
}

// ---- 書き込み ----

/** 既存なら中身、なければ null。読めないファイルは例外 */
function readExisting(file: string): string | null {
  try {
    lstatSync(file);
  } catch {
    return null;
  }
  return readText(file);
}

/** write_file と edit_file が書くのはここだけ。FR-011 の記録はここの onFileChange に差し込む */
function applyWrite(context: ToolContext, file: string, before: string | null, after: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, after);
  context.onFileChange?.({ path: relativeTo(context.workspace, file), before, after });
}

function computeEdit(before: string, oldText: string, newText: string, replaceAll: boolean): string {
  const count = before.split(oldText).length - 1;
  if (count === 0) throw new ToolFailure("oldText が見つかりません。read_file で今の中身を確かめてください");
  if (count > 1 && !replaceAll) {
    throw new ToolFailure(`oldText が ${count} か所に一致します。前後の行を足して1か所に絞るか、replaceAll を指定してください`);
  }
  return before.split(oldText).join(newText);
}

function previewWrite(name: ToolName, args: Record<string, unknown>, context: ToolContext): string {
  const file = resolveInWorkspace(context.workspace, args.path as string, { deny: context.deny });
  const before = readExisting(file);
  const after = name === "write_file"
    ? (args.content as string)
    : computeEdit(before ?? failMissing(), args.oldText as string, args.newText as string, args.replaceAll === true);
  return unifiedDiff(relativeTo(context.workspace, file), before, after) || "（変更なし）";
}

function failMissing(): never {
  throw new ToolFailure("ファイルがありません");
}

function writeFileTool(context: ToolContext, file: string, content: string): string {
  const before = readExisting(file);
  applyWrite(context, file, before, content);
  return `${before === null ? "作成" : "上書き"}しました: ${relativeTo(context.workspace, file)}`;
}

function editFileTool(context: ToolContext, file: string, oldText: string, newText: string, replaceAll: boolean): string {
  const before = readExisting(file) ?? failMissing();
  const after = computeEdit(before, oldText, newText, replaceAll);
  applyWrite(context, file, before, after);
  const count = before.split(oldText).length - 1;
  return `置換しました（${count} か所）: ${relativeTo(context.workspace, file)}`;
}

// ---- コマンド ----

async function runCommandTool(context: ToolContext, cwd: string, command: string): Promise<ToolResult> {
  try {
    if (!statSync(cwd).isDirectory()) throw new Error();
  } catch {
    throw new ToolFailure("cwd がフォルダではありません");
  }
  const result = await runShell({ command, cwd, timeoutMs: context.commandTimeoutMs, signal: context.signal, onOutput: context.onOutput });
  if (result.aborted) return { status: "failed", output: `${result.output}\n停止しました`.trimStart(), exitCode: result.exitCode };
  if (result.timedOut) {
    return { status: "timed_out", output: `${result.output}\n${context.commandTimeoutMs / 1000} 秒で時間切れになり、プロセスを終了しました`.trimStart(), exitCode: result.exitCode };
  }
  return {
    status: result.exitCode === 0 ? "succeeded" : "failed",
    output: `終了コード: ${result.exitCode}\n${result.output}`,
    exitCode: result.exitCode,
  };
}
