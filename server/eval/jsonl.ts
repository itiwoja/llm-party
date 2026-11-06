import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ApiError } from "../http-error";
import type { EvalStore } from "../store/eval";
import { type CaseInput, caseSchema } from "./schema";

export interface ImportResult {
  added: number;
  skipped: number;
  errors: { line: number; reason: string }[];
}

/** 1行ずつ検証する。空行は飛ばす。行番号は 1 始まり */
export function parseJsonl(text: string): { cases: CaseInput[]; errors: ImportResult["errors"] } {
  const cases: CaseInput[] = [];
  const errors: ImportResult["errors"] = [];
  text.replace(/^﻿/, "").split("\n").forEach((raw, index) => {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "") return;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      errors.push({ line: index + 1, reason: "JSON として読めません" });
      return;
    }
    const result = caseSchema.safeParse(json);
    if (result.success) cases.push(result.data);
    else errors.push({ line: index + 1, reason: result.error.issues.map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message)).join(" / ") });
  });
  return { cases, errors };
}

export function formatJsonl(cases: CaseInput[]): string {
  return cases
    .map((item) =>
      JSON.stringify({
        name: item.name, kind: item.kind, input: item.input,
        ...(item.fixture ? { fixture: item.fixture } : {}),
        grader: item.grader,
        ...(item.tags.length ? { tags: item.tags } : {}),
      }),
    )
    .join("\n")
    .concat(cases.length ? "\n" : "");
}

/** API-075。パスはファイルであること（D-51） */
export function importJsonl(store: EvalStore, setId: string, file: string, onDuplicate: "overwrite" | "skip"): ImportResult {
  if (!path.isAbsolute(file)) throw new ApiError("VALIDATION_ERROR", "絶対パスで指定してください", [{ field: "path" }]);
  let isFile = false;
  try {
    isFile = statSync(file).isFile();
  } catch {
    throw new ApiError("NOT_FOUND", "ファイルがありません");
  }
  if (!isFile) throw new ApiError("VALIDATION_ERROR", "ファイルを指定してください", [{ field: "path" }]);
  const { cases, errors } = parseJsonl(readFileSync(file, "utf8"));
  const { added, skipped } = store.importCases(setId, cases, onDuplicate);
  return { added, skipped, errors };
}

/** API-076。親フォルダがあること。既存のファイルは上書き */
export function exportJsonl(store: EvalStore, setId: string, file: string): { count: number } {
  if (!path.isAbsolute(file)) throw new ApiError("VALIDATION_ERROR", "絶対パスで指定してください", [{ field: "path" }]);
  const parent = path.dirname(file);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) throw new ApiError("NOT_FOUND", "保存先のフォルダがありません");
  if (existsSync(file) && statSync(file).isDirectory()) throw new ApiError("VALIDATION_ERROR", "ファイルを指定してください", [{ field: "path" }]);
  const cases = store.cases(setId).map(({ name, kind, input, fixture, grader, tags }) => ({ name, kind, input, fixture, grader, tags }));
  writeFileSync(file, formatJsonl(cases));
  return { count: cases.length };
}
