import { ulid } from "ulid";
import type { Db } from "../db";
import { ApiError } from "../http-error";
import { PASS_SCORE, summarize } from "../eval/grade";
import type { CaseInput, Grader } from "../eval/schema";
import type { Effort } from "../thinking";
import { isUniqueError, now } from "./shared";

export interface SetInput {
  name: string;
  description?: string | null;
  fixturesDir?: string | null;
}

export interface EvalCase {
  id: string;
  evalSetId: string;
  name: string;
  sortOrder: number;
  kind: "chat" | "agent";
  input: string;
  fixture: string | null;
  grader: Grader;
  tags: string[];
}

/** ラン作成時にプリセットから写す中身（FR-016） */
export interface PresetSnapshot {
  presetId: string;
  name: string;
  modelId: string;
  modelName: string;
  modelPath: string;
  modelSha256: string | null;
  adapters: { path: string; scale: number }[];
  sampling: { temperature: number; topP: number; topK: number; minP: number; presencePenalty: number; repeatPenalty: number };
  systemPrompt: string | null;
  thinking: boolean;
  /** 送った段階。送っていない・この項目ができる前のランは無い（D-76） */
  effort?: Effort | null;
  contextSize: number;
  /** GPU に載せる割合。null は自動。この項目ができる前のランは無い（D-77） */
  gpuRatio?: number | null;
}

export type RunStatus = "queued" | "running" | "completed" | "cancelled" | "failed";

interface SetRow { id: string; name: string; description: string | null; fixtures_dir: string | null; created_at: string; updated_at: string }
interface CaseRow {
  id: string; eval_set_id: string; name: string; sort_order: number; kind: string; input: string;
  fixture: string | null; grader: string; tags: string; created_at: string; updated_at: string;
}
interface RunRow {
  id: string; eval_set_id: string; preset_id: string | null; preset_name: string; preset_snapshot: string; backend: string;
  tag_filter: string | null; status: string; pass_rate: number | null; avg_score: number | null; avg_tokens_per_sec: number | null;
  started_at: string | null; finished_at: string | null; created_at: string;
}
interface ResultRow {
  id: string; eval_run_id: string; eval_case_id: string | null; case_name: string; status: string; answer: string | null;
  transcript: string | null; test_output: string | null; score: number | null; reviewed_at: string | null;
  prompt_tokens: number | null; completion_tokens: number | null; tokens_per_sec: number | null; duration_ms: number | null;
}

const toCase = (row: CaseRow): EvalCase => ({
  id: row.id, evalSetId: row.eval_set_id, name: row.name, sortOrder: row.sort_order, kind: row.kind as EvalCase["kind"],
  input: row.input, fixture: row.fixture, grader: JSON.parse(row.grader) as Grader, tags: JSON.parse(row.tags) as string[],
});

const toSet = (row: SetRow) => ({
  id: row.id, name: row.name, description: row.description, fixturesDir: row.fixtures_dir, createdAt: row.created_at, updatedAt: row.updated_at,
});

const toRun = (row: RunRow) => ({
  id: row.id, evalSetId: row.eval_set_id, presetId: row.preset_id, presetName: row.preset_name,
  snapshot: JSON.parse(row.preset_snapshot) as PresetSnapshot, backend: row.backend,
  tagFilter: row.tag_filter ? (JSON.parse(row.tag_filter) as string[]) : null, status: row.status as RunStatus,
  passRate: row.pass_rate, avgScore: row.avg_score, avgTokensPerSec: row.avg_tokens_per_sec,
  startedAt: row.started_at, finishedAt: row.finished_at, createdAt: row.created_at,
});

export type EvalRun = ReturnType<typeof toRun>;

const toResult = (row: ResultRow) => ({
  id: row.id, runId: row.eval_run_id, caseId: row.eval_case_id, caseName: row.case_name, status: row.status,
  answer: row.answer, transcript: row.transcript ? (JSON.parse(row.transcript) as unknown) : null, testOutput: row.test_output,
  score: row.score, reviewedAt: row.reviewed_at, promptTokens: row.prompt_tokens, completionTokens: row.completion_tokens,
  tokensPerSec: row.tokens_per_sec, durationMs: row.duration_ms,
});

export type EvalResult = ReturnType<typeof toResult>;

export interface ResultUpdate {
  status: string;
  answer?: string | null;
  transcript?: unknown;
  testOutput?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  tokensPerSec?: number | null;
  durationMs?: number | null;
}

/** 評価セット・ラン・結果（FR-015〜FR-018） */
export class EvalStore {
  constructor(private db: Db) {}

  // ---- 評価セット・ケース（FR-015）

  sets() {
    const rows = this.db.prepare("SELECT * FROM eval_sets ORDER BY name").all() as SetRow[];
    return rows.map((row) => {
      const caseCount = (this.db.prepare("SELECT COUNT(*) AS n FROM eval_cases WHERE eval_set_id = ?").get(row.id) as { n: number }).n;
      const latest = this.db.prepare("SELECT id, pass_rate FROM eval_runs WHERE eval_set_id = ? ORDER BY created_at DESC, id DESC LIMIT 1").get(row.id) as
        | { id: string; pass_rate: number | null }
        | undefined;
      return { ...toSet(row), caseCount, latestRunId: latest?.id ?? null, latestPassRate: latest?.pass_rate ?? null };
    });
  }

  set(id: string) {
    const row = this.db.prepare("SELECT * FROM eval_sets WHERE id = ?").get(id) as SetRow | undefined;
    return row ? toSet(row) : null;
  }

  setWithCases(id: string) {
    const set = this.set(id);
    return set ? { ...set, cases: this.cases(id) } : null;
  }

  createSet(input: SetInput) {
    const id = ulid();
    const time = now();
    try {
      this.db.prepare("INSERT INTO eval_sets (id, name, description, fixtures_dir, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, input.name, input.description ?? null, input.fixturesDir ?? null, time, time);
    } catch (error) {
      if (isUniqueError(error)) throw new ApiError("CONFLICT", "同じ名前の評価セットがあります");
      throw error;
    }
    return this.set(id)!;
  }

  /** API-072：セットとケースをまとめて保存。id か名前が合うケースは残す（結果との結びつきを保つため） */
  saveSet(id: string, input: SetInput & { cases: (CaseInput & { id?: string })[] }) {
    if (!this.set(id)) throw new ApiError("NOT_FOUND", "評価セットがありません");
    const names = input.cases.map((item) => item.name);
    const duplicate = names.find((name, index) => names.indexOf(name) !== index);
    if (duplicate !== undefined) throw new ApiError("VALIDATION_ERROR", `ケース名が重複しています: ${duplicate}`, [{ field: "cases", message: duplicate }]);
    const time = now();
    try {
      this.db.transaction(() => {
        this.db.prepare("UPDATE eval_sets SET name = ?, description = ?, fixtures_dir = ?, updated_at = ? WHERE id = ?")
          .run(input.name, input.description ?? null, input.fixturesDir ?? null, time, id);
        const existing = this.cases(id);
        const byId = new Map(existing.map((item) => [item.id, item]));
        const byName = new Map(existing.map((item) => [item.name, item]));
        const used = new Set<string>();
        const plan = input.cases.map((item) => {
          const match = (item.id ? byId.get(item.id) : undefined) ?? byName.get(item.name);
          const keep = match && !used.has(match.id) ? match.id : null;
          if (keep) used.add(keep);
          return { item, id: keep };
        });
        for (const old of existing) {
          if (!used.has(old.id)) this.db.prepare("DELETE FROM eval_cases WHERE id = ?").run(old.id);
        }
        // 名前の入れ替えで UNIQUE に当たらないよう、先に仮の名前へ移す
        for (const keepId of used) this.db.prepare("UPDATE eval_cases SET name = ? WHERE id = ?").run(`\u0000${keepId}`, keepId);
        plan.forEach(({ item, id: keepId }, order) => {
          if (keepId) this.updateCase(keepId, item, order, time);
          else this.insertCase(id, item, order, time);
        });
      })();
    } catch (error) {
      if (isUniqueError(error)) throw new ApiError("CONFLICT", "同じ名前の評価セットがあります");
      throw error;
    }
    return this.setWithCases(id)!;
  }

  deleteSet(id: string): void {
    this.db.prepare("DELETE FROM eval_sets WHERE id = ?").run(id);
  }

  cases(setId: string): EvalCase[] {
    return (this.db.prepare("SELECT * FROM eval_cases WHERE eval_set_id = ? ORDER BY sort_order, rowid").all(setId) as CaseRow[]).map(toCase);
  }

  case(id: string): EvalCase | null {
    const row = this.db.prepare("SELECT * FROM eval_cases WHERE id = ?").get(id) as CaseRow | undefined;
    return row ? toCase(row) : null;
  }

  /** FR-015 の取込。同名は overwrite（中身を置き換える）か skip */
  importCases(setId: string, cases: CaseInput[], onDuplicate: "overwrite" | "skip") {
    if (!this.set(setId)) throw new ApiError("NOT_FOUND", "評価セットがありません");
    let added = 0;
    let skipped = 0;
    const time = now();
    this.db.transaction(() => {
      const byName = new Map(this.cases(setId).map((item) => [item.name, item.id]));
      let order = (this.db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS n FROM eval_cases WHERE eval_set_id = ?").get(setId) as { n: number }).n + 1;
      for (const item of cases) {
        const existing = byName.get(item.name);
        if (existing && onDuplicate === "skip") {
          skipped += 1;
        } else if (existing) {
          const current = this.case(existing)!;
          this.updateCase(existing, item, current.sortOrder, time);
          added += 1;
        } else {
          byName.set(item.name, this.insertCase(setId, item, order, time));
          order += 1;
          added += 1;
        }
      }
    })();
    return { added, skipped };
  }

  private insertCase(setId: string, item: CaseInput, order: number, time: string): string {
    const id = ulid();
    this.db.prepare(`INSERT INTO eval_cases (id, eval_set_id, name, sort_order, kind, input, fixture, grader, tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, setId, item.name, order, item.kind, item.input, item.kind === "agent" ? item.fixture ?? null : null, JSON.stringify(item.grader), JSON.stringify(item.tags), time, time);
    return id;
  }

  private updateCase(id: string, item: CaseInput, order: number, time: string): void {
    this.db.prepare("UPDATE eval_cases SET name = ?, sort_order = ?, kind = ?, input = ?, fixture = ?, grader = ?, tags = ?, updated_at = ? WHERE id = ?")
      .run(item.name, order, item.kind, item.input, item.kind === "agent" ? item.fixture ?? null : null, JSON.stringify(item.grader), JSON.stringify(item.tags), time, id);
  }

  // ---- ラン・結果（FR-016）

  /** プリセットのモデルのハッシュ。スナップショットに写す */
  modelSha256(modelId: string): string | null {
    return (this.db.prepare("SELECT sha256 FROM models WHERE id = ?").get(modelId) as { sha256: string | null } | undefined)?.sha256 ?? null;
  }

  /** ランと pending の結果を作る。ケースの並び順がそのまま流す順になる */
  createRun(input: { evalSetId: string; snapshot: PresetSnapshot; backend: string; tags: string[] | null; cases: EvalCase[] }): string {
    const id = ulid();
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO eval_runs (id, eval_set_id, preset_id, preset_name, preset_snapshot, backend, tag_filter, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`)
        .run(id, input.evalSetId, input.snapshot.presetId, input.snapshot.name, JSON.stringify(input.snapshot), input.backend, input.tags ? JSON.stringify(input.tags) : null, now());
      const insert = this.db.prepare("INSERT INTO eval_results (id, eval_run_id, eval_case_id, case_name, status) VALUES (?, ?, ?, ?, 'pending')");
      for (const item of input.cases) insert.run(ulid(), id, item.id, item.name);
    })();
    return id;
  }

  run(id: string): EvalRun | null {
    const row = this.db.prepare("SELECT * FROM eval_runs WHERE id = ?").get(id) as RunRow | undefined;
    return row ? toRun(row) : null;
  }

  runs(evalSetId?: string) {
    const rows = (evalSetId
      ? this.db.prepare("SELECT * FROM eval_runs WHERE eval_set_id = ? ORDER BY created_at DESC, id DESC").all(evalSetId)
      : this.db.prepare("SELECT * FROM eval_runs ORDER BY created_at DESC, id DESC").all()) as RunRow[];
    return rows.map((row) => ({ ...toRun(row), ...this.counts(row.id) }));
  }

  /** 一覧の列（件数・合計時間）。平均は eval_runs の列にある */
  counts(runId: string) {
    const row = this.db.prepare(`SELECT COUNT(*) AS total,
        COALESCE(SUM(status NOT IN ('pending', 'running')), 0) AS done,
        COALESCE(SUM(status = 'passed'), 0) AS passed,
        COALESCE(SUM(status = 'needs_review'), 0) AS needsReview,
        COALESCE(SUM(duration_ms), 0) AS totalDurationMs
      FROM eval_results WHERE eval_run_id = ?`).get(runId) as { total: number; done: number; passed: number; needsReview: number; totalDurationMs: number };
    return row;
  }

  results(runId: string): EvalResult[] {
    return (this.db.prepare("SELECT * FROM eval_results WHERE eval_run_id = ? ORDER BY rowid").all(runId) as ResultRow[]).map(toResult);
  }

  result(id: string): EvalResult | null {
    const row = this.db.prepare("SELECT * FROM eval_results WHERE id = ?").get(id) as ResultRow | undefined;
    return row ? toResult(row) : null;
  }

  deleteRun(id: string): void {
    this.db.prepare("DELETE FROM eval_runs WHERE id = ?").run(id);
  }

  /** 削除の前に、セットのランを知るため */
  runIdsOfSet(setId: string): string[] {
    return (this.db.prepare("SELECT id FROM eval_runs WHERE eval_set_id = ?").all(setId) as { id: string }[]).map((row) => row.id);
  }

  startRun(id: string): void {
    this.db.prepare("UPDATE eval_runs SET status = 'running', started_at = ? WHERE id = ?").run(now(), id);
  }

  setBackend(id: string, backend: string): void {
    this.db.prepare("UPDATE eval_runs SET backend = ? WHERE id = ?").run(backend, id);
  }

  /** 終えたランの状態を決め、正解率などを計算し直す */
  finishRun(id: string, status: Exclude<RunStatus, "queued" | "running">) {
    this.db.prepare("UPDATE eval_runs SET status = ?, finished_at = ? WHERE id = ?").run(status, now(), id);
    return this.refreshStats(id);
  }

  /** 流れていない結果をすべて skipped にする（中止・停止・起動時の後始末） */
  skipUnfinished(runId: string): void {
    this.db.prepare("UPDATE eval_results SET status = 'skipped' WHERE eval_run_id = ? AND status IN ('pending', 'running')").run(runId);
  }

  beginResult(id: string): void {
    this.db.prepare("UPDATE eval_results SET status = 'running' WHERE id = ?").run(id);
  }

  completeResult(id: string, update: ResultUpdate): void {
    this.db.prepare(`UPDATE eval_results SET status = ?, answer = ?, transcript = ?, test_output = ?, prompt_tokens = ?,
        completion_tokens = ?, tokens_per_sec = ?, duration_ms = ? WHERE id = ?`)
      .run(update.status, update.answer ?? null, update.transcript === undefined ? null : JSON.stringify(update.transcript), update.testOutput ?? null,
        update.promptTokens ?? null, update.completionTokens ?? null, update.tokensPerSec ?? null, update.durationMs ?? null, id);
  }

  /** 実行中の画面向けの進み具合（eval.progress） */
  progress(runId: string) {
    const { total, done, passed } = this.counts(runId);
    return { done, total, passed };
  }

  /** 結果から正解率・平均点・平均速度を計算して保存する。人手採点のたびにも呼ぶ（FR-017） */
  refreshStats(runId: string) {
    const stats = summarize(this.results(runId));
    this.db.prepare("UPDATE eval_runs SET pass_rate = ?, avg_score = ?, avg_tokens_per_sec = ? WHERE id = ?")
      .run(stats.passRate, stats.avgScore, stats.avgTokensPerSec, runId);
    return stats;
  }

  /** API-081：人手採点。付け直しもできる（採点待ちか、一度付けた結果だけ） */
  grade(resultId: string, input: { verdict: "passed" | "failed" } | { score: number }) {
    const result = this.result(resultId);
    if (!result) throw new ApiError("NOT_FOUND", "結果がありません");
    if (result.status !== "needs_review" && result.reviewedAt === null) throw new ApiError("CONFLICT", "人手採点の結果ではありません");
    const grader = result.caseId ? this.case(result.caseId)?.grader : undefined;
    if (grader && grader.type === "manual") {
      if ("score" in input && grader.scale !== "1to5") throw new ApiError("VALIDATION_ERROR", "このケースは ○× で採点します", [{ field: "score" }]);
      if ("verdict" in input && grader.scale !== "pass_fail") throw new ApiError("VALIDATION_ERROR", "このケースは 1〜5 点で採点します", [{ field: "verdict" }]);
    }
    const [status, score] = "score" in input ? [input.score >= PASS_SCORE ? "passed" : "failed", input.score] : [input.verdict, null];
    this.db.prepare("UPDATE eval_results SET status = ?, score = ?, reviewed_at = ? WHERE id = ?").run(status, score, now(), resultId);
    const stats = this.refreshStats(result.runId);
    return { result: this.result(resultId)!, run: this.run(result.runId)!, stats };
  }

  /** 起動時：動いたまま残ったランを failed、流れていない結果を skipped にする */
  recoverUnfinished(): string[] {
    const ids = (this.db.prepare("SELECT id FROM eval_runs WHERE status IN ('queued', 'running')").all() as { id: string }[]).map((row) => row.id);
    for (const id of ids) {
      this.skipUnfinished(id);
      this.finishRun(id, "failed");
    }
    return ids;
  }

  // ---- 比較・推移（FR-018）

  /** 結果にケースのタグを付けて返す。タグで絞るときに使う（ケースが消えた結果は絞り込みでは外れる） */
  resultsFiltered(runId: string, tags: string[] | null): EvalResult[] {
    const results = this.results(runId);
    if (!tags?.length) return results;
    const wanted = new Set(tags);
    return results.filter((result) => {
      const item = result.caseId ? this.case(result.caseId) : null;
      return item?.tags.some((tag) => wanted.has(tag));
    });
  }
}
