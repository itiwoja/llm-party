import { PathDeniedError } from "./paths";
import { COMMAND_TIMEOUT_MS } from "./shell";
import type { AssembledToolCall, ChatMessage, Generation } from "./stream";
import { type CountTokens, truncateOutput } from "./truncate";
import { type FileChange, isToolName, planToolCall, type ToolContext, type ToolKind, type ToolStatus, toolKind } from "./tools";

/** D-24：1 指示のツール呼び出しの上限。「続ける」でさらにこの数 */
export const STEP_LIMIT = 40;

export type Decision = { decision: "approve" | "approve_and_auto" } | { decision: "reject"; note?: string };

/** 1つのツール呼び出しの記録（DB の tool_calls に当たる） */
export interface ToolCallRecord {
  /** host が付ける ID（DB の tool_calls.id） */
  id: string;
  callRef: string;
  tool: string;
  /** 解釈できたら オブジェクト、壊れていたら生の文字列 */
  args: unknown;
  kind: ToolKind;
}

export type ToolCallEnd = { status: ToolStatus | "denied" | "rejected"; output: string; exitCode?: number | null; note?: string };

/** ループが外へ出す手がかり。保存と通知は呼ぶ側がやる（HTTP・DB に依存しない） */
export interface AgentHost {
  /** モデルを1回呼ぶ。messages は今の会話。本文の差分の通知や保存は host がやる */
  generate(messages: ChatMessage[], signal: AbortSignal): Promise<Generation>;
  /** 応答の生成が終わった直後（assistant メッセージの確定）。呼び出しがなくても呼ぶ */
  onAssistant?(generation: Generation): void;
  /** 呼び出しを記録する。承認待ちなら pending、すぐ実行なら running、拒否・形式エラーはその後すぐ onToolEnd */
  onToolStart(record: ToolCallRecord, state: "pending_approval" | "running" | "denied" | "failed", preview?: string): void;
  /** 承認が要るとき、判断が来るまで待つ。signal が止まったら reject して良い */
  awaitDecision(record: ToolCallRecord, signal: AbortSignal): Promise<Decision>;
  /** 承認されて実行に入った */
  onToolRunning?(record: ToolCallRecord): void;
  onToolOutput?(record: ToolCallRecord, chunk: string): void;
  /** 結果が出た（モデルに返す文字列は切り詰め後） */
  onToolEnd(record: ToolCallRecord, end: ToolCallEnd): void;
  /** FR-011 の変更記録を差し込む場所 */
  onFileChange?(record: ToolCallRecord, change: FileChange): void;
  /** 呼び出しが 1 つ増えるたび（step_count の保存） */
  onStep?(stepCount: number): void;
  /** 上限に達した。判断が来るまで待つ。signal が止まったら reject して良い */
  awaitContinue(stepCount: number, signal: AbortSignal): Promise<"continue" | "stop">;
}

export interface AgentRunOptions {
  /** 実体のパスに解決済みのワークスペース */
  workspace: string;
  /** ワークスペースの中でも触らせない場所 */
  deny?: string[];
  /** 承認が要るときに毎回読む。「以後自動で承認」で途中から変わる */
  autoApprove: () => boolean;
  signal: AbortSignal;
  /** 会話。ループが assistant と tool を足していく */
  messages: ChatMessage[];
  countTokens: CountTokens;
  host: AgentHost;
  /** 数え始めの回数（「続ける」の後や再開のとき） */
  stepCount?: number;
  stepLimit?: number;
  commandTimeoutMs?: number;
  makeId(): string;
}

export type AgentOutcome = { status: "completed" | "cancelled"; stepCount: number; truncated: boolean };

/**
 * FR-008 のループ。生成 → ツール呼び出しを並んだ順に処理 → 結果を足して再び生成、を
 * 呼び出しのない応答が来るまで繰り返す。上限は応答1つ分の呼び出しをすべて処理した後で見る
 * （モデルの履歴に結果のない呼び出しを残さないため）。
 * 生成の失敗は例外のまま投げる。呼び出し側がターンを failed にする
 */
export async function runAgentLoop(options: AgentRunOptions): Promise<AgentOutcome> {
  const { host, signal, messages } = options;
  const stepLimit = options.stepLimit ?? STEP_LIMIT;
  let limit = (options.stepCount ?? 0) + stepLimit;
  let steps = options.stepCount ?? 0;
  let truncated = false;

  const toolContext = (): ToolContext => ({
    workspace: options.workspace,
    deny: options.deny ?? [],
    signal,
    commandTimeoutMs: options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS,
  });

  for (;;) {
    signal.throwIfAborted();
    const generation = await host.generate(messages, signal);
    truncated = generation.truncated;
    host.onAssistant?.(generation);
    messages.push({
      role: "assistant",
      content: generation.content,
      ...(generation.toolCalls.length
        ? { tool_calls: generation.toolCalls.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: historyArguments(call) } })) }
        : {}),
    });
    if (generation.toolCalls.length === 0) return { status: "completed", stepCount: steps, truncated };

    for (const call of generation.toolCalls) {
      if (signal.aborted) return { status: "cancelled", stepCount: steps, truncated };
      steps += 1;
      host.onStep?.(steps);
      const output = await handleCall(call, options, toolContext);
      messages.push({ role: "tool", tool_call_id: call.id, content: output.content });
      if (output.cancelled) return { status: "cancelled", stepCount: steps, truncated };
    }

    if (steps >= limit) {
      let answer: "continue" | "stop";
      try {
        answer = await host.awaitContinue(steps, signal);
      } catch (error) {
        if (signal.aborted) return { status: "cancelled", stepCount: steps, truncated };
        throw error;
      }
      if (answer === "stop") return { status: "completed", stepCount: steps, truncated };
      limit = steps + stepLimit;
    }
  }
}

/** 壊れた引数は、次の生成のときテンプレートが読めるように空のオブジェクトにして渡す */
function historyArguments(call: AssembledToolCall): string {
  try {
    JSON.parse(call.arguments || "{}");
    return call.arguments || "{}";
  } catch {
    return "{}";
  }
}

async function handleCall(
  call: AssembledToolCall,
  options: AgentRunOptions,
  makeContext: () => ToolContext,
): Promise<{ content: string; cancelled: boolean }> {
  const { host, signal } = options;
  let parsedArgs: unknown = call.arguments;
  try {
    parsedArgs = JSON.parse(call.arguments || "{}");
  } catch {
    // 壊れた JSON は生のまま記録する
  }
  const context = makeContext();
  const plan = planToolCall(call.name, call.arguments, context);
  const record: ToolCallRecord = {
    id: options.makeId(), callRef: call.id, tool: call.name, args: parsedArgs,
    kind: plan.ok ? plan.kind : isToolName(call.name) ? toolKind(call.name) : "read",
  };
  context.onOutput = (chunk) => host.onToolOutput?.(record, chunk);
  context.onFileChange = (change) => host.onFileChange?.(record, change);
  const conclude = async (end: ToolCallEnd) => {
    const output = await truncateOutput(end.output, options.countTokens);
    host.onToolEnd(record, { ...end, output });
    return output;
  };

  if (!plan.ok) {
    host.onToolStart(record, plan.status);
    return { content: await conclude({ status: plan.status, output: plan.message, note: plan.status === "denied" ? plan.message : undefined }), cancelled: false };
  }

  if (plan.kind !== "read" && !options.autoApprove()) {
    host.onToolStart(record, "pending_approval", plan.preview);
    let answer: Decision;
    try {
      answer = await host.awaitDecision(record, signal);
    } catch (error) {
      if (!signal.aborted) throw error;
      return { content: await conclude({ status: "rejected", output: "停止しました", note: "停止しました" }), cancelled: true };
    }
    if (answer.decision === "reject") {
      const note = answer.note?.trim();
      const text = note ? `利用者が却下しました。理由: ${note}` : "利用者が却下しました";
      return { content: await conclude({ status: "rejected", output: text, note: note || undefined }), cancelled: false };
    }
    host.onToolRunning?.(record);
  } else {
    host.onToolStart(record, "running", plan.preview);
  }

  const result = await runPlan(plan);
  return { content: await conclude(result), cancelled: signal.aborted && result.status !== "succeeded" };
}

/** 承認を待つ間にリンクが張り替えられて外を指した場合は、実行時の検査で拒否になる */
async function runPlan(plan: Extract<ReturnType<typeof planToolCall>, { ok: true }>) {
  try {
    return await plan.run();
  } catch (error) {
    if (error instanceof PathDeniedError) return { status: "denied" as const, output: error.message, note: error.message };
    throw error;
  }
}
