import { lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ulid } from "ulid";
import { CONTEXT_FULL, isContextFull, messageText, needsCompaction, planCompaction, SUMMARY_MAX_TOKENS, summaryRequest } from "./agent/compact";
import { unifiedDiff } from "./agent/diff";
import { PathDeniedError, resolveInWorkspace } from "./agent/paths";
import { runAgentLoop, STEP_LIMIT, type AgentHost, type Decision } from "./agent/loop";
import { agentSystemPrompt } from "./agent/prompt";
import { streamCompletion, type ChatMessage, type Generation } from "./agent/stream";
import { toolDefinitions } from "./agent/tools";
import { loadKey, type EngineManager } from "./engine";
import type { EventBus } from "./events";
import { GENERATION_SLOTS, type GenerationSlot } from "./generation-slot";
import { ApiError } from "./http-error";
import type { Store } from "./store";
import { sha256 } from "./store/changes";
import { thinkingKwargs } from "./thinking";

const ENGINE_STOPPED = "推論エンジンが停止しました";
/** 画面の数字の更新間隔。毎トークン送ると無駄が多い */
const USAGE_INTERVAL_MS = 500;
/** 1回の生成の上限（D-61）。思考が終わらないときに止める */
const MAX_TOKENS = 8192;
/** 文脈の測定は /tokenize の値でテンプレートの分を含まないので、測定を通っても llama-server に断られることがある */
const CONTEXT_EXCEEDED = /exceeds the available context size/;

interface Active {
  turnId: string;
  threadId: string;
  workspaceId: string | null;
  /** 読み込みの同一性。違う読み込みのターンは同時に動かさない */
  loadKey: string;
  abort: AbortController;
  done: Promise<void>;
  /** 承認待ちのツール呼び出し（FR-010） */
  pending?: { toolCallId: string; preview?: string; resolve(decision: Decision): void };
  /** 40 回上限で止まっているときの返事待ち（API-037） */
  stepWait?: { resolve(answer: "continue" | "stop"): void };
}

export interface ChatOptions {
  /** ワークスペースの中でも触らせない場所 */
  dataDir: string;
  /** run_command の時間切れ。テストで縮める */
  commandTimeoutMs?: number;
}

/**
 * FR-005・FR-008。生成は同時に GENERATION_SLOTS 本まで（D-60 の改訂）。
 * 同じスレッド・同じワークスペースのターンは1つだけ（D-36）。読み込みが違うターンは待たせず断る。
 * 承認待ち・上限待ちの間もこのターンが枠を持ち続けるので、その間の送信は BUSY になる
 */
export class ChatService {
  /** 動いているターン（turnId → 状態） */
  private active = new Map<string, Active>();

  constructor(private store: Store, private engine: EngineManager, private bus: EventBus, private slot: GenerationSlot, private options: ChatOptions) {}

  send(threadId: string, presetId: string, content: string): { turnId: string; status: "running" } {
    const thread = this.store.threads.get(threadId);
    if (!thread) throw new ApiError("NOT_FOUND", "スレッドがありません");
    if (!this.store.presets.get(presetId)) throw new ApiError("NOT_FOUND", "プリセットがありません");
    if (this.slot.evalPresetId && this.slot.evalPresetId !== presetId) throw new ApiError("BUSY", "評価の実行中です");

    const key = this.keyOf(presetId);
    const running = [...this.active.values()];
    const sameOwner = running.some((a) => a.threadId === threadId || (thread.workspaceId !== null && a.workspaceId === thread.workspaceId));
    if (sameOwner || running.length >= GENERATION_SLOTS) throw new ApiError("BUSY", "別の生成が動いています");
    if (running.some((a) => a.loadKey !== key)) throw new ApiError("BUSY", "別のモデル・文脈長の生成が動いています");

    const turnId = this.store.threads.beginTurn(threadId, presetId, content);
    const abort = new AbortController();
    const entry: Active = { turnId, threadId, workspaceId: thread.workspaceId, loadKey: key, abort, done: Promise.resolve() };
    this.active.set(turnId, entry);
    entry.done = this.run(turnId, threadId, presetId, abort.signal).finally(() => {
      this.active.delete(turnId);
    });
    return { turnId, status: "running" };
  }

  /** プリセットの読み込みの key（枠を一緒に持てるかの判定に使う） */
  private keyOf(presetId: string): string {
    const preset = this.store.presets.get(presetId)!;
    const model = this.store.models.get(preset.modelId)!;
    return loadKey({
      modelPath: model.path,
      contextSize: preset.contextSize,
      adapterPaths: this.store.presets.adapters(presetId).map((adapter) => adapter.path),
    });
  }

  /** 生成が動いているか（画像生成の開始を断るのに使う） */
  get busy(): boolean {
    return this.active.size > 0;
  }

  cancel(turnId: string): void {
    const active = this.active.get(turnId);
    if (!active || active.stepWait) throw new ApiError("CONFLICT", "このターンは動いていません");
    active.abort.abort();
  }

  /** API-038：承認・却下 */
  decide(toolCallId: string, decision: Decision["decision"], note?: string): { status: "running" | "rejected" } {
    const call = this.store.agent.toolCall(toolCallId);
    if (!call) throw new ApiError("NOT_FOUND", "ツール呼び出しがありません");
    const pending = this.pendingOf(toolCallId);
    if (!pending) throw new ApiError("CONFLICT", "承認待ちではありません");
    const approved = decision !== "reject";
    if (!this.store.agent.decide(toolCallId, approved ? "running" : "rejected", note)) {
      throw new ApiError("CONFLICT", "承認待ちではありません");
    }
    if (decision === "approve_and_auto") this.store.threads.setAutoApprove(call.threadId, true);
    pending.resolve(decision === "reject" ? { decision, note } : { decision });
    return { status: approved ? "running" : "rejected" };
  }

  /** API-037：40 回上限の後の「続ける / やめる」 */
  continueTurn(turnId: string, action: "continue" | "stop"): { status: "running" | "completed" } {
    const active = this.active.get(turnId);
    const wait = active?.stepWait;
    if (!active || !wait) throw new ApiError("CONFLICT", "上限で止まっていません");
    active.stepWait = undefined;
    if (action === "continue") {
      const turn = this.store.threads.turn(turnId)!;
      this.store.threads.setStepLimit(turnId, turn.stepCount + STEP_LIMIT);
      this.store.threads.setTurnStatus(turnId, "running");
    }
    wait.resolve(action);
    return { status: action === "continue" ? "running" : "completed" };
  }

  /** 承認待ちの書き込みの差分。画面を開き直したときにカードへ戻す */
  pendingPreview(toolCallId: string): string | undefined {
    return this.pendingOf(toolCallId)?.preview;
  }

  /** API-039：変更記録。ファイルごとに、取り消していない変更をまとめた差分と、1回ずつの差分を返す */
  changes(threadId: string) {
    if (!this.store.threads.get(threadId)) throw new ApiError("NOT_FOUND", "スレッドがありません");
    const items = this.store.changes.ofThread(threadId).map((change) => ({
      ...change,
      diff: unifiedDiff(change.path, change.before, change.after),
    }));
    const files = new Map<string, typeof items>();
    for (const item of items) files.set(item.path, [...(files.get(item.path) ?? []), item]);
    return {
      items,
      files: [...files].map(([filePath, list]) => {
        const live = list.filter((item) => !item.revertedAt);
        return {
          path: filePath,
          changeIds: list.map((item) => item.id),
          // 最初の「実行前」から最後の「実行後」まで。取り消し済みは含めない
          diff: live.length ? unifiedDiff(filePath, live[0].before, live.at(-1)!.after) : "",
        };
      }),
    };
  }

  /**
   * API-040：取り消し。今のファイルが記録した「実行後」と同じときだけ戻す。違えば force が要る。
   * パスは今のワークスペースで検査し直す
   */
  revertChange(id: string, force: boolean): { id: string; revertedAt: string } {
    const change = this.store.changes.get(id);
    if (!change) throw new ApiError("NOT_FOUND", "変更記録がありません");
    if (change.revertedAt) throw new ApiError("CONFLICT", "取り消し済みです");
    const thread = this.store.threads.get(change.threadId);
    const workspace = thread?.workspaceId ? this.store.agent.workspace(thread.workspaceId) : null;
    if (!workspace) throw new ApiError("NOT_FOUND", "ワークスペースがありません");
    let file: string;
    try {
      file = resolveInWorkspace(workspace.path, change.path, { deny: [this.options.dataDir] });
    } catch (error) {
      if (error instanceof PathDeniedError) throw new ApiError("PATH_NOT_ALLOWED", error.message);
      throw error;
    }

    let current: Buffer | null = null;
    try {
      if (!lstatSync(file).isFile()) throw new ApiError("CONFLICT", "ファイルではありません");
      current = readFileSync(file);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!force && (current ? sha256(current) : null) !== change.afterSha256) {
      throw new ApiError("CONFLICT", "変更後に編集されています");
    }

    if (change.before === null) {
      if (current) unlinkSync(file);
    } else {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, change.before);
    }
    this.store.changes.markReverted(id);
    return { id, revertedAt: this.store.changes.get(id)!.revertedAt! };
  }

  /** FR-004：動いているターンを先に止めてから消す */
  async deleteThread(threadId: string): Promise<void> {
    if (!this.store.threads.get(threadId)) throw new ApiError("NOT_FOUND", "スレッドがありません");
    const running = [...this.active.values()].filter((a) => a.threadId === threadId);
    for (const a of running) a.abort.abort();
    await Promise.all(running.map((a) => a.done));
    this.store.threads.delete(threadId);
  }

  /** 動いているターンを止めて、終わるのを待つ（終了時） */
  async shutdown(): Promise<void> {
    const running = [...this.active.values()];
    for (const a of running) a.abort.abort();
    await Promise.all(running.map((a) => a.done));
  }

  /** 承認待ちのツール呼び出しの状態（どのターンのものかを探す） */
  private pendingOf(toolCallId: string): Active["pending"] {
    return [...this.active.values()].find((a) => a.pending?.toolCallId === toolCallId)?.pending;
  }

  private async run(turnId: string, threadId: string, presetId: string, signal: AbortSignal): Promise<void> {
    const preset = this.store.presets.get(presetId)!;
    const model = this.store.models.get(preset.modelId)!;
    const adapters = this.store.presets.adapters(presetId);
    const thread = this.store.threads.get(threadId)!;
    const workspace = thread.workspaceId ? this.store.agent.workspace(thread.workspaceId) : null;
    const { sampling, contextSize } = preset;
    // llama-server は -c を枠の数で割って使うので、1本ぶんの文脈で数える
    const slotContext = Math.floor(contextSize / GENERATION_SLOTS);

    const system = [preset.systemPrompt, workspace ? agentSystemPrompt(workspace.path) : "", workspace?.instructions].filter(Boolean).join("\n\n");
    const samplingBody = {
      temperature: sampling.temperature,
      top_p: sampling.topP,
      top_k: sampling.topK,
      min_p: sampling.minP,
      presence_penalty: sampling.presencePenalty,
      repeat_penalty: sampling.repeatPenalty,
      ...(adapters.length ? { lora: adapters.map((adapter, id) => ({ id, scale: adapter.scale })) } : {}),
    };
    const toolsText = workspace ? JSON.stringify(toolDefinitions()) : "";
    /** 直前の生成の usage（入力＋出力）と、そのとき history に入っていた件数（応答の assistant を含む） */
    let baseline: { used: number; count: number } | undefined;

    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    let truncated = false;
    let looped = false;
    let lastUsageAt = 0;

    const finish = (status: "completed" | "cancelled" | "failed", error?: string) => {
      if (status !== "completed") this.store.agent.closeToolCalls(turnId, error ?? "停止しました");
      this.store.threads.finishTurn(turnId, status, { promptTokens, completionTokens, error });
      this.bus.publish("turn.finished", { turnId, status, ...(error ? { error } : {}), ...(truncated ? { truncated } : {}), ...(looped ? { looped } : {}) });
    };

    /** FR-006：直前の usage に、新しく足した分を /tokenize で数えて足す。基準がなければ全体を数える */
    const measure = async (history: ChatMessage[]): Promise<number> => {
      if (baseline) {
        const added = history.slice(baseline.count).map(messageText).join("\n");
        return baseline.used + (added ? await this.countTokens(added) : 0);
      }
      return this.countTokens([system, toolsText, ...history.map(messageText)].filter(Boolean).join("\n"));
    };

    const complete: typeof streamCompletion = (request) =>
      streamCompletion(request).catch((error: unknown) => {
        if (error instanceof Error && CONTEXT_EXCEEDED.test(error.message)) throw new ApiError("CONFLICT", CONTEXT_FULL);
        throw error;
      });

    /** 古い部分を要約して保存し、history を組み直す（同じ配列を書き換える。ループがそれを持っている）。要約するものがなければ false */
    const compact = async (history: ChatMessage[]): Promise<boolean> => {
      const plan = planCompaction(this.store.threads.compactRows(threadId));
      if (!plan) return false;
      // 失敗はそのまま投げる（ターンが failed になる）。停止なら signal で cancelled。保存は成功した後だけ
      const generation = await complete({
        baseUrl: this.engine.baseUrl, apiKey: this.engine.apiKey, signal, makeId: ulid,
        body: {
          messages: summaryRequest(plan.middle),
          max_tokens: SUMMARY_MAX_TOKENS,
          ...samplingBody,
          chat_template_kwargs: { enable_thinking: false },
        },
      });
      const summary = generation.content.trim();
      if (!summary) throw new Error("要約が空でした");
      signal.throwIfAborted();
      const summaryMessageId = this.store.threads.applyCompaction(threadId, turnId, plan.middle.map((row) => row.id), plan.keepFromSeq, summary);
      history.splice(0, history.length, ...(workspace ? this.store.threads.agentConversation(threadId) : this.store.threads.conversation(threadId)));
      baseline = undefined;
      this.bus.publish("turn.compacted", { threadId, summaryMessageId, count: plan.middle.length });
      return true;
    };

    /** 1回の生成。assistant メッセージを作り、差分を流し、止まっても途中までを保存する */
    const generate = async (history: ChatMessage[]): Promise<Generation> => {
      let used = await measure(history);
      if (needsCompaction(used, slotContext) && (await compact(history))) used = await measure(history);
      // 要約しても入らないなら送らない（CP-050。画面は error がこの文かどうかで判別する）
      if (isContextFull(used, slotContext)) throw new ApiError("CONFLICT", CONTEXT_FULL);

      const messageId = this.store.threads.addMessage({ threadId, turnId, role: "assistant", content: "" });
      let content = "";
      let reasoning = "";
      try {
        const generation = await complete({
          baseUrl: this.engine.baseUrl, apiKey: this.engine.apiKey, signal, makeId: ulid,
          stopOnRepeatedThought: true,
          body: {
            messages: system ? [{ role: "system", content: system }, ...history] : history,
            ...(workspace ? { tools: toolDefinitions() } : {}),
            max_tokens: MAX_TOKENS,
            ...samplingBody,
            chat_template_kwargs: thinkingKwargs(model, preset),
          },
          onDelta: (delta) => {
            content += delta.content ?? "";
            reasoning += delta.reasoning ?? "";
            this.bus.publish("turn.delta", { turnId, messageId, ...delta });
          },
          onChunk: (chunk, usage) => {
            if (chunk.usage || (chunk.timings && Date.now() - lastUsageAt >= USAGE_INTERVAL_MS)) {
              lastUsageAt = Date.now();
              this.bus.publish("turn.usage", {
                turnId,
                usedTokens: usage
                  ? usage.prompt_tokens + usage.completion_tokens
                  : (chunk.timings?.cache_n ?? 0) + (chunk.timings?.prompt_n ?? 0) + (chunk.timings?.predicted_n ?? 0),
                contextSize: slotContext,
                tokensPerSecond: chunk.timings?.predicted_per_second,
              });
            }
          },
        });
        baseline = generation.usage ? { used: generation.usage.prompt_tokens + generation.usage.completion_tokens, count: history.length + 1 } : undefined;
        if (generation.usage) {
          promptTokens = generation.usage.prompt_tokens;
          completionTokens = (completionTokens ?? 0) + generation.usage.completion_tokens;
        }
        truncated = generation.truncated;
        looped = generation.looped ?? false;
        return generation;
      } finally {
        this.store.threads.updateMessage(messageId, content, reasoning || null);
      }
    };

    let release: (() => void) | undefined;
    try {
      // 評価のケースが動いていたら、その合間まで待つ（FR-016）
      release = await this.slot.acquire(signal, this.keyOf(presetId));
      await this.engine.load({
        presetId,
        modelPath: model.path,
        contextSize: preset.contextSize,
        adapterPaths: adapters.map((adapter) => adapter.path),
      });
      signal.throwIfAborted();

      if (!workspace) {
        await generate(this.store.threads.conversation(threadId));
        finish("completed");
        return;
      }

      this.store.agent.touchWorkspace(workspace.id);
      const outcome = await runAgentLoop({
        workspace: workspace.path,
        deny: [this.options.dataDir],
        autoApprove: () => this.store.threads.get(threadId)?.autoApprove ?? false,
        signal,
        messages: this.store.threads.agentConversation(threadId),
        countTokens: (text) => this.countTokens(text),
        commandTimeoutMs: this.options.commandTimeoutMs,
        makeId: ulid,
        host: this.agentHost(turnId, threadId, signal, generate),
      });
      truncated = outcome.truncated;
      finish(outcome.status);
    } catch (error) {
      if (signal.aborted) {
        finish("cancelled");
      } else if (error instanceof ApiError) {
        finish("failed", error.message);
      } else if (await this.engine.healthy()) {
        finish("failed", error instanceof Error ? error.message : String(error));
      } else {
        finish("failed", ENGINE_STOPPED);
      }
    } finally {
      release?.();
    }
  }

  /** ループの保存と通知（FR-008〜FR-010）。DB は tool_calls と messages、通知は tool.* と turn.stepLimit */
  private agentHost(turnId: string, threadId: string, signal: AbortSignal, generate: (history: ChatMessage[]) => Promise<Generation>): AgentHost {
    const { store, bus } = this;
    const previews = new Map<string, string>();
    /** 止められる待ち。signal が止まったら reject する */
    const wait = <T>(register: (resolve: (value: T) => void) => void, cleanup: () => void): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        const onAbort = () => {
          cleanup();
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        register((value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        });
      });

    return {
      generate: (messages) => generate(messages),
      onToolStart: (record, state, preview) => {
        store.agent.createToolCall({ id: record.id, turnId, callRef: record.callRef, tool: record.tool, args: record.args, kind: record.kind, status: state });
        if (state === "pending_approval") {
          if (preview) previews.set(record.id, preview);
          bus.publish("tool.pending", { toolCallId: record.id, tool: record.tool, args: record.args, ...(preview ? { preview } : {}) });
        } else {
          bus.publish("tool.started", { toolCallId: record.id });
        }
      },
      awaitDecision: async (record) => {
        const active = this.active.get(turnId)!;
        store.threads.setTurnStatus(turnId, "awaiting_approval");
        const decision = await wait<Decision>(
          (resolve) => {
            active.pending = { toolCallId: record.id, preview: previews.get(record.id), resolve };
          },
          () => {
            active.pending = undefined;
          },
        );
        active.pending = undefined;
        store.threads.setTurnStatus(turnId, "running");
        return decision;
      },
      onToolRunning: (record) => bus.publish("tool.started", { toolCallId: record.id }),
      onToolOutput: (record, chunk) => bus.publish("tool.output", { toolCallId: record.id, chunk }),
      onToolEnd: (record, end) => {
        store.agent.finishToolCall(record.id, { status: end.status, output: end.output, exitCode: end.exitCode, note: end.note });
        store.threads.addMessage({ threadId, turnId, role: "tool", content: end.output, toolCallId: record.id });
        bus.publish("tool.finished", { toolCallId: record.id, status: end.status, ...(end.exitCode != null ? { exitCode: end.exitCode } : {}) });
      },
      onFileChange: (record, change) => store.changes.record({ toolCallId: record.id, threadId, path: change.path, before: change.before, after: change.after }),
      onStep: (stepCount) => store.threads.setStepCount(turnId, stepCount),
      awaitContinue: async (stepCount) => {
        const active = this.active.get(turnId)!;
        store.threads.setTurnStatus(turnId, "step_limit");
        bus.publish("turn.stepLimit", { turnId, stepCount });
        return wait<"continue" | "stop">(
          (resolve) => {
            active.stepWait = { resolve };
          },
          () => {
            active.stepWait = undefined;
          },
        );
      },
    };
  }

  private async countTokens(text: string): Promise<number> {
    const res = await fetch(`${this.engine.baseUrl}/tokenize`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.engine.apiKey}` },
      body: JSON.stringify({ content: text }),
    });
    if (!res.ok) throw new Error(`llama-server が ${res.status} を返しました: ${await res.text()}`);
    return ((await res.json()) as { tokens: unknown[] }).tokens.length;
  }
}
