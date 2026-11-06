import type { Grader } from "./schema";

/** D-38：1to5 の合格ライン */
export const PASS_SCORE = 4;

export type MatchGrader = Extract<Grader, { type: "match" }>;

/** FR-017 の match。正規表現が不正なら error */
export function gradeMatch(grader: MatchGrader, answer: string): { status: "passed" | "failed" | "error"; error?: string } {
  const fold = (text: string) => (grader.ignoreCase ? text.toLowerCase() : text);
  if (grader.mode === "contains") return { status: fold(answer).includes(fold(grader.expected)) ? "passed" : "failed" };
  if (grader.mode === "exact") return { status: fold(answer.trim()) === fold(grader.expected) ? "passed" : "failed" };
  let pattern: RegExp;
  try {
    pattern = new RegExp(grader.expected, grader.ignoreCase ? "i" : "");
  } catch (error) {
    return { status: "error", error: `正規表現が正しくありません: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { status: pattern.test(answer) ? "passed" : "failed" };
}

export interface Gradable {
  status: string;
  score: number | null;
  tokensPerSec: number | null;
}

const mean = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);

/** 正解率 = passed ÷（needs_review・skipped と、まだ流れていないものを除いた数）。score があるのは 1to5 だけ */
export function summarize(results: Gradable[]) {
  const judged = results.filter((result) => !["needs_review", "skipped", "pending", "running"].includes(result.status));
  return {
    passRate: judged.length ? judged.filter((result) => result.status === "passed").length / judged.length : null,
    avgScore: mean(results.filter((result) => result.score !== null).map((result) => result.score!)),
    avgTokensPerSec: mean(results.filter((result) => result.tokensPerSec !== null).map((result) => result.tokensPerSec!)),
  };
}
