import { createHash } from "node:crypto";
import { cpSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { ulid } from "ulid";
import { runAgentLoop } from "../agent/loop";
import { isInside } from "../agent/paths";
import { agentSystemPrompt } from "../agent/prompt";
import { runShell } from "../agent/shell";
import { type ChatMessage, type Generation, streamCompletion } from "../agent/stream";
import { toolDefinitions } from "../agent/tools";
import type { EngineManager } from "../engine";
import type { EventBus } from "../events";
import type { GenerationSlot } from "../generation-slot";
import { ApiError } from "../http-error";
import type { Store } from "../store";
import type { EvalCase, EvalResult, EvalRun, PresetSnapshot, ResultUpdate } from "../store/eval";
import { gradeMatch, summarize } from "./grade";

/** D-29：1ケースの時間切れ */
const CASE_TIMEOUT_MS = 300_000;
/** 1回の生成の上限（chat.ts と同じ。D-61） */
const MAX_TOKENS = 8192;
const WORKSPACES_DIR = "eval-workspaces";

export interface EvalOptions {
  store: Store;
  engine: EngineManager;
  bus: EventBus;
  slot: GenerationSlot;
  dataDir: string;
}

/** 推論エンジンが落ちた（読み込めない・生成の途中で止まった）。1回だけやり直す対象 */
class EngineDown extends Error {}
/** そのケースだけの失敗（fixture がないなど）。結果を error にする */
class CaseError extends Error {}

interface ToolLog {
  tool: string;
  args: unknown;
  status: string;
  output?: string;
  exitCode?: number | null;
}

/** ケースの途中経過。時間切れや失敗でも、ここまでの内容を結果に残す */
interface Trace {
  answer: string;
  reasoning: string;
  messages: ChatMessage[];
  toolCalls: ToolLog[];
  testOutput: string | null;
  promptTokens: number | null;
  completionTokens: number;
  speeds: number[];
}

/** ケース名をフォルダ名にする。`..`・区切り文字を含め、安全な文字以外は `~16進~` にして別の名前が同じ形に潰れないようにする */
export function safeCaseName(name: string): string {
  const encoded = [...name].map((ch) => (/[A-Za-z0-9_-]/.test(ch) ? ch : `~${ch.codePointAt(0)!.toString(16)}~`)).join("");
  return encoded.length <= 100 ? encoded : `${encoded.slice(0, 60)}~~${createHash("sha1").update(name).digest("hex").slice(0, 16)}`;
}

/** fixturesDir の中のフォルダか。外を指すリンクも realpath で断る */
function resolveFixture(fixturesDir: string | null, fixture: string): { path: string } | { error: string } {
  if (!fixturesDir) return { error: "fixturesDir が設定されていません" };
  let root: string;
  try {
    root = realpathSync(fixturesDir);
  } catch {
    return { error: "fixturesDir がありません" };
  }
  let real: string;
  try {
    real = realpathSync(path.resolve(root, fixture));
  } catch {
    return { error: `fixture のフォルダがありません: ${fixture}` };
  }
  if (!isInside(real, root)) return { error: `fixture が fixturesDir の外を指しています: ${fixture}` };
  if (!statSync(real).isDirectory()) return { error: `fixture がフォルダではありません: ${fixture}` };
  return { path: real };
}

/** 待ちを止められるようにする。元の処理は止まらず、そのまま続く（エンジンの読み込みなど） */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      promise.catch(() => undefined);
      return reject(signal.reason);
    }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** FR-016 の実行。ランを順番に流す（D-35） */
export class EvalService {
  /** 1ケースの時間切れ。テストで縮める */
  caseTimeoutMs = CASE_TIMEOUT_MS;

  private queue: string[] = [];
  private controllers = new Map<string, AbortController>();
  private current: { id: string; done: Promise<void> } | null = null;
  private draining = false;
  private drained: Promise<void> = Promise.resolve();
  private stopping = false;

  constructor(private options: EvalOptions) {
    // 前回の終了で止まったまま残ったランは続きから流さず、failed にする
    options.store.evals.recoverUnfinished();
  }

  private get evals() {
    return this.options.store.evals;
  }

  /** API-077：ランを作って順番に並べる。プリセットの数だけ */
  createRuns(input: { evalSetId: string; presetIds: string[]; tags?: string[] }): { runIds: string[] } {
    const { store, bus } = this.options;
    const set = this.evals.set(input.evalSetId);
    if (!set) throw new ApiError("NOT_FOUND", "評価セットがありません");
    const presets = input.presetIds.map((id) => {
      const preset = store.presets.get(id);
      if (!preset) throw new ApiError("NOT_FOUND", "プリセットがありません");
      return preset;
    });
    const tags = input.tags?.length ? input.tags : null;
    const cases = this.evals.cases(set.id).filter((item) => !tags || item.tags.some((tag) => tags.includes(tag)));
    if (cases.length === 0) {
      throw new ApiError("VALIDATION_ERROR", tags ? "タグに合うケースがありません" : "ケースがありません", [{ field: tags ? "tags" : "evalSetId" }]);
    }
    for (const item of cases) {
      if (item.kind !== "agent") continue;
      const fixture = item.fixture ? resolveFixture(set.fixturesDir, item.fixture) : { error: "fixture がありません" };
      if ("error" in fixture) throw new ApiError("VALIDATION_ERROR", `${item.name}：${fixture.error}`, [{ field: "cases", message: item.name }]);
    }

    const backend = this.options.engine.backend;

    const runIds = presets.map((preset) => {
      const model = store.models.get(preset.modelId)!;
      const snapshot: PresetSnapshot = {
        presetId: preset.id, name: preset.name, modelId: model.id, modelName: model.name, modelPath: model.path,
        modelSha256: this.evals.modelSha256(model.id), adapters: store.presets.adapters(preset.id),
        sampling: preset.sampling, systemPrompt: preset.systemPrompt, thinking: preset.thinking, contextSize: preset.contextSize,
      };
      const id = this.evals.createRun({ evalSetId: set.id, snapshot, backend, tags, cases });
      this.controllers.set(id, new AbortController());
      this.queue.push(id);
      return id;
    });
    this.start();
    return { runIds };
  }

  /** API-080：キューにあれば外し、動いていれば止めて終わるのを待つ */
  async cancelRun(id: string): Promise<EvalRun> {
    const run = this.evals.run(id);
    if (!run) throw new ApiError("NOT_FOUND", "ランがありません");
    if (run.status !== "queued" && run.status !== "running") throw new ApiError("CONFLICT", "このランは動いていません");
    this.controllers.get(id)?.abort(new Error("cancelled"));
    const at = this.queue.indexOf(id);
    if (at >= 0) {
      this.queue.splice(at, 1);
      this.finalize(id, "cancelled");
    } else if (this.current?.id === id) {
      await this.current.done;
    }
    return this.evals.run(id)!;
  }

  /** ラン・結果・使い捨てフォルダを消す。動いていれば先に止める */
  async deleteRun(id: string): Promise<void> {
    const run = this.evals.run(id);
    if (!run) throw new ApiError("NOT_FOUND", "ランがありません");
    if (run.status === "queued" || run.status === "running") await this.cancelRun(id);
    this.evals.deleteRun(id);
    rmSync(this.workspaceRoot(id), { recursive: true, force: true });
  }

  /** 評価セットを消す。ランが動いていれば先に止め、使い捨てフォルダも消す */
  async deleteSet(id: string): Promise<void> {
    if (!this.evals.set(id)) throw new ApiError("NOT_FOUND", "評価セットがありません");
    const runIds = this.evals.runIdsOfSet(id);
    for (const runId of runIds) {
      const run = this.evals.run(runId)!;
      if (run.status === "queued" || run.status === "running") await this.cancelRun(runId);
    }
    this.evals.deleteSet(id);
    for (const runId of runIds) rmSync(this.workspaceRoot(runId), { recursive: true, force: true });
  }

  /** 動いているランを止める（終了時） */
  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const controller of this.controllers.values()) controller.abort(new Error("shutdown"));
    await this.drained;
    for (const id of this.queue.splice(0)) this.finalize(id, "cancelled");
  }

  /** FR-018：プリセット名ごとの正解率の推移。tags で絞ると、そのタグのケースだけで計算し直す */
  trend(setId: string, tags: string[] | null) {
    if (!this.evals.set(setId)) throw new ApiError("NOT_FOUND", "評価セットがありません");
    const runs = this.evals.runs(setId).filter((run) => run.status === "completed").reverse();
    const series = new Map<string, { runId: string; at: string; passRate: number; avgScore: number | null }[]>();
    for (const run of runs) {
      const stats = tags?.length ? summarize(this.evals.resultsFiltered(run.id, tags)) : run;
      if (stats.passRate === null) continue;
      const points = series.get(run.presetName) ?? [];
      points.push({ runId: run.id, at: run.startedAt ?? run.createdAt, passRate: stats.passRate, avgScore: stats.avgScore });
      series.set(run.presetName, points);
    }
    return { series: [...series.entries()].map(([presetName, points]) => ({ presetName, points })) };
  }

  /** FR-018：同じ評価セットの2つのランをケースごとに比べる。悪くなったものが先頭 */
  compare(setId: string, runAId: string, runBId: string, tags: string[] | null) {
    if (!this.evals.set(setId)) throw new ApiError("NOT_FOUND", "評価セットがありません");
    const [runA, runB] = [runAId, runBId].map((id) => {
      const run = this.evals.run(id);
      if (!run) throw new ApiError("NOT_FOUND", "ランがありません");
      if (run.evalSetId !== setId) throw new ApiError("VALIDATION_ERROR", "別の評価セットのランは比べられません", [{ field: "compare" }]);
      return run;
    });
    const side = (result: EvalResult) => ({
      resultId: result.id, status: result.status, score: result.score, answer: result.answer, transcript: result.transcript,
      testOutput: result.testOutput, tokensPerSec: result.tokensPerSec, durationMs: result.durationMs,
    });
    const failing = new Set(["failed", "timed_out", "error"]);
    const rank = { regressed: 0, improved: 1, same: 2 };
    const resultsB = new Map(this.evals.resultsFiltered(runB.id, tags).map((result) => [result.caseName, result]));
    const cases = this.evals.resultsFiltered(runA.id, tags).flatMap((a) => {
      const b = resultsB.get(a.caseName);
      if (!b) return [];
      const change = failing.has(a.status) && b.status === "passed" ? "improved" : a.status === "passed" && failing.has(b.status) ? "regressed" : "same";
      return [{ caseName: a.caseName, caseId: a.caseId ?? b.caseId, change, a: side(a), b: side(b) }];
    });
    cases.sort((x, y) => rank[x.change as keyof typeof rank] - rank[y.change as keyof typeof rank]);
    return { runs: [runA, runB], cases };
  }

  // ---- 実行

  private workspaceRoot(runId: string): string {
    return path.join(this.options.dataDir, WORKSPACES_DIR, runId);
  }

  private start(): void {
    if (this.draining) return;
    this.draining = true;
    this.drained = this.drain();
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.length > 0 && !this.stopping) {
        const id = this.queue.shift()!;
        const done = this.execute(id);
        this.current = { id, done };
        try {
          await done;
        } finally {
          this.current = null;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private finalize(runId: string, status: "completed" | "cancelled" | "failed"): void {
    this.evals.skipUnfinished(runId);
    const stats = this.evals.finishRun(runId, status);
    this.controllers.delete(runId);
    this.options.bus.publish("eval.finished", { runId, status, passRate: stats.passRate });
  }

  private publishProgress(runId: string, currentCase: string): void {
    this.options.bus.publish("eval.progress", { runId, ...this.evals.progress(runId), currentCase });
  }

  private async execute(runId: string): Promise<void> {
    const { slot } = this.options;
    const run = this.evals.run(runId);
    const controller = this.controllers.get(runId);
    if (!run || run.status !== "queued" || !controller) return;
    const signal = controller.signal;
    if (signal.aborted) return this.finalize(runId, "cancelled");

    this.evals.startRun(runId);
    slot.evalPresetId = run.presetId ?? run.id;
    let status: "completed" | "cancelled" | "failed" = "completed";
    try {
      const set = this.evals.set(run.evalSetId)!;
      for (const result of this.evals.results(runId)) {
        if (signal.aborted) {
          status = "cancelled";
          break;
        }
        const item = result.caseId ? this.evals.case(result.caseId) : null;
        const outcome = await this.runCase(run, item, result, set.fixturesDir, signal);
        if (outcome !== "done") {
          status = outcome === "cancelled" ? "cancelled" : "failed";
          break;
        }
      }
    } catch (error) {
      console.error("[worker] 評価の実行に失敗", error);
      status = signal.aborted ? "cancelled" : "failed";
    } finally {
      slot.evalPresetId = null;
    }
    this.finalize(runId, status);
  }

  /** 1ケース。枠を取り、時間切れまで流し、採点して保存する。エンジンが落ちたら1回だけやり直す（UC-007 E2） */
  private async runCase(
    run: EvalRun, item: EvalCase | null, result: EvalResult, fixturesDir: string | null, signal: AbortSignal,
  ): Promise<"done" | "cancelled" | "engine_failed"> {
    let retried = false;
    for (;;) {
      let release: () => void;
      try {
        release = await this.options.slot.acquire(signal, "eval");
      } catch {
        return "cancelled";
      }
      this.evals.beginResult(result.id);
      this.publishProgress(run.id, result.caseName);
      try {
        const update = await this.attempt(run, item, result, fixturesDir, signal);
        this.evals.completeResult(result.id, update);
        this.publishProgress(run.id, result.caseName);
        return "done";
      } catch (error) {
        if (signal.aborted) return "cancelled";
        if (!(error instanceof EngineDown)) throw error;
        if (!retried) {
          retried = true;
          // 落ちたことを engine がまだ知らないと、同じ指定の load は読み込み直さない。止めてから始め直させる
          await this.options.engine.stop();
          continue;
        }
        this.evals.completeResult(result.id, { status: "failed", transcript: { messages: [], toolCalls: [], error: error.message } });
        this.publishProgress(run.id, result.caseName);
        return "engine_failed";
      } finally {
        release();
      }
    }
  }

  private async attempt(run: EvalRun, item: EvalCase | null, result: EvalResult, fixturesDir: string | null, runSignal: AbortSignal): Promise<ResultUpdate> {
    const { engine } = this.options;
    const snapshot = run.snapshot;
    const trace: Trace = { answer: "", reasoning: "", messages: [], toolCalls: [], testOutput: null, promptTokens: null, completionTokens: 0, speeds: [] };
    const caseAbort = new AbortController();
    const relay = () => caseAbort.abort(runSignal.reason);
    runSignal.addEventListener("abort", relay, { once: true });
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    let started = Date.now();

    const build = (status: string, error?: string): ResultUpdate => ({
      status,
      answer: trace.answer,
      transcript: {
        messages: trace.messages, toolCalls: trace.toolCalls,
        ...(trace.reasoning ? { reasoning: trace.reasoning } : {}),
        ...(error ? { error } : {}),
      },
      testOutput: trace.testOutput,
      promptTokens: trace.promptTokens,
      completionTokens: trace.completionTokens || null,
      tokensPerSec: trace.speeds.length ? trace.speeds.reduce((sum, value) => sum + value, 0) / trace.speeds.length : null,
      durationMs: Date.now() - started,
    });

    try {
      if (!item) throw new CaseError("ケースが削除されています");
      let workspace: string | null = null;
      if (item.kind === "agent") workspace = this.prepareWorkspace(run.id, item, fixturesDir);

      try {
        await abortable(
          engine.load({
            presetId: snapshot.presetId, modelPath: snapshot.modelPath, contextSize: snapshot.contextSize,
            adapterPaths: snapshot.adapters.map((adapter) => adapter.path),
          }),
          runSignal,
        );
      } catch (error) {
        if (runSignal.aborted) throw error;
        throw new EngineDown(messageOf(error));
      }
      this.evals.setBackend(run.id, engine.backend);

      started = Date.now();
      timer = setTimeout(() => {
        timedOut = true;
        caseAbort.abort(new Error("timeout"));
      }, this.caseTimeoutMs);
      const signal = caseAbort.signal;

      if (item.kind === "chat") {
        trace.messages = [{ role: "user", content: item.input }];
        const generation = await this.generate(snapshot, snapshot.systemPrompt ?? "", trace.messages, false, signal, trace);
        trace.messages.push({ role: "assistant", content: generation.content });
      } else {
        const ws = workspace!;
        const history: ChatMessage[] = [{ role: "user", content: item.input }];
        trace.messages = history;
        const system = [snapshot.systemPrompt, agentSystemPrompt(ws)].filter(Boolean).join("\n\n");
        const logs = new Map<string, ToolLog>();
        await runAgentLoop({
          workspace: ws,
          // 作業フォルダ自体が dataDir の中にあるので、dataDir を deny にすると全部断られる。外へ出る道は realpath が塞ぐ
          autoApprove: () => true,
          signal,
          messages: history,
          countTokens: (text) => this.countTokens(text),
          makeId: ulid,
          host: {
            generate: (messages) => this.generate(snapshot, system, messages, true, signal, trace),
            onToolStart: (record) => {
              const entry: ToolLog = { tool: record.tool, args: record.args, status: "running" };
              logs.set(record.id, entry);
              trace.toolCalls.push(entry);
            },
            awaitDecision: async () => {
              throw new Error("評価は自動承認なので、承認待ちにはなりません");
            },
            onToolEnd: (record, end) => {
              Object.assign(logs.get(record.id)!, { status: end.status, output: end.output, exitCode: end.exitCode ?? null });
            },
            awaitContinue: async () => "stop",
          },
        });
        signal.throwIfAborted();
      }
      signal.throwIfAborted();

      const grader = item.grader;
      if (grader.type === "manual") return build("needs_review");
      if (grader.type === "match") {
        const graded = gradeMatch(grader, trace.answer);
        return build(graded.status, graded.error);
      }
      // test：作業フォルダで実行する。時間切れの枠の残りの中で（FR-017）
      if (!workspace) throw new CaseError("test の採点は agent のケースだけです");
      const shell = await runShell({
        command: grader.command, cwd: workspace, signal,
        timeoutMs: Math.max(1, this.caseTimeoutMs - (Date.now() - started)),
      });
      trace.testOutput = shell.output;
      signal.throwIfAborted();
      if (shell.timedOut) return build("timed_out");
      return build(shell.exitCode === 0 ? "passed" : "failed");
    } catch (error) {
      if (runSignal.aborted) throw error;
      if (timedOut) return build("timed_out");
      if (error instanceof CaseError) return build("error", error.message);
      if (error instanceof EngineDown) throw error;
      if (error instanceof ApiError && error.code === "ENGINE_FAILED") throw new EngineDown(error.message);
      if (!(await engine.healthy())) throw new EngineDown("推論エンジンが停止しました");
      return build("error", messageOf(error));
    } finally {
      clearTimeout(timer);
      runSignal.removeEventListener("abort", relay);
    }
  }

  /** fixture を <dataDir>/eval-workspaces/<runId>/<caseName>/ にコピーする。やり直しのときは作り直す */
  private prepareWorkspace(runId: string, item: EvalCase, fixturesDir: string | null): string {
    const fixture = resolveFixture(fixturesDir, item.fixture ?? "");
    if ("error" in fixture) throw new CaseError(fixture.error);
    const dest = path.join(this.workspaceRoot(runId), safeCaseName(item.name));
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    cpSync(fixture.path, dest, { recursive: true });
    return realpathSync(dest);
  }

  /** chat.ts の generate と同じ形の body。評価では要約も変更記録もしない */
  private async generate(
    snapshot: PresetSnapshot, system: string, history: ChatMessage[], tools: boolean, signal: AbortSignal, trace: Trace,
  ): Promise<Generation> {
    const { engine } = this.options;
    const { sampling } = snapshot;
    trace.answer = "";
    trace.reasoning = "";
    let speed: number | undefined;
    const generation = await streamCompletion({
      baseUrl: engine.baseUrl, apiKey: engine.apiKey, signal, makeId: ulid,
      body: {
        messages: system ? [{ role: "system", content: system }, ...history] : history,
        ...(tools ? { tools: toolDefinitions() } : {}),
        max_tokens: MAX_TOKENS,
        temperature: sampling.temperature,
        top_p: sampling.topP,
        top_k: sampling.topK,
        min_p: sampling.minP,
        presence_penalty: sampling.presencePenalty,
        repeat_penalty: sampling.repeatPenalty,
        ...(snapshot.adapters.length ? { lora: snapshot.adapters.map((adapter, id) => ({ id, scale: adapter.scale })) } : {}),
        chat_template_kwargs: { enable_thinking: snapshot.thinking },
      },
      onDelta: (delta) => {
        trace.answer += delta.content ?? "";
        trace.reasoning += delta.reasoning ?? "";
      },
      onChunk: (chunk) => {
        speed = chunk.timings?.predicted_per_second ?? speed;
      },
    });
    if (generation.usage) {
      trace.promptTokens = generation.usage.prompt_tokens;
      trace.completionTokens += generation.usage.completion_tokens;
    }
    if (speed !== undefined) trace.speeds.push(speed);
    return generation;
  }

  private async countTokens(text: string): Promise<number> {
    const { engine } = this.options;
    const res = await fetch(`${engine.baseUrl}/tokenize`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${engine.apiKey}` },
      body: JSON.stringify({ content: text }),
    });
    if (!res.ok) throw new Error(`llama-server が ${res.status} を返しました: ${await res.text()}`);
    return ((await res.json()) as { tokens: unknown[] }).tokens.length;
  }
}
