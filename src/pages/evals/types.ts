/** PG-005〜007 で使う型（API-070〜082 の応答の形。src/types.ts は変えない） */
export type Grader =
  | { type: "match"; mode: "contains" | "exact" | "regex"; expected: string; ignoreCase: boolean }
  | { type: "manual"; scale: "pass_fail" | "1to5"; rubric?: string }
  | { type: "test"; command: string };

export interface EvalCase {
  id?: string;
  name: string;
  kind: "chat" | "agent";
  input: string;
  fixture: string | null;
  grader: Grader;
  tags: string[];
}

export interface EvalSetSummary {
  id: string;
  name: string;
  description: string | null;
  fixturesDir: string | null;
  caseCount: number;
  latestRunId: string | null;
  latestPassRate: number | null;
}

export interface EvalSetFull {
  id: string;
  name: string;
  description: string | null;
  fixturesDir: string | null;
  cases: (EvalCase & { id: string })[];
}

export type RunStatus = "queued" | "running" | "completed" | "cancelled" | "failed";

export interface RunItem {
  id: string;
  evalSetId: string;
  presetName: string;
  status: RunStatus;
  passRate: number | null;
  avgScore: number | null;
  avgTokensPerSec: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  total: number;
  done: number;
  passed: number;
  needsReview: number;
  totalDurationMs: number;
}

export interface ToolLog {
  tool: string;
  args: unknown;
  status: string;
  output?: string;
  exitCode?: number | null;
}

export interface Transcript {
  messages?: unknown[];
  toolCalls?: ToolLog[];
  reasoning?: string;
  error?: string;
}

export interface ResultItem {
  id: string;
  runId: string;
  caseId: string | null;
  caseName: string;
  status: string;
  answer: string | null;
  transcript: Transcript | null;
  testOutput: string | null;
  score: number | null;
  reviewedAt: string | null;
  tokensPerSec: number | null;
  durationMs: number | null;
}
