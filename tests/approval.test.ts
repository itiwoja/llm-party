import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentHost, type Decision, runAgentLoop, type ToolCallEnd, type ToolCallRecord } from "../server/agent/loop";
import type { ChatMessage, Generation } from "../server/agent/stream";
import { tempDir } from "./helpers";

/** FR-010 の判定と FR-008 の回数を、HTTP・DB なしでループだけ確かめる（FR-016 の評価と同じ呼び方） */

const call = (id: string, name: string, args: unknown): Generation["toolCalls"][number] => ({ id, name, arguments: typeof args === "string" ? args : JSON.stringify(args) });
const reply = (toolCalls: Generation["toolCalls"], content = ""): Generation => ({ content, reasoning: "", toolCalls, truncated: false });

describe("承認の判定とループ", () => {
  let tmp: ReturnType<typeof tempDir>;
  let ws: string;
  let ends: { record: ToolCallRecord; end: ToolCallEnd; state?: string }[];
  let asked: ToolCallRecord[];
  let seen: string[];

  beforeEach(() => {
    tmp = tempDir();
    ws = realpathSync(tmp.dir);
    ends = [];
    asked = [];
    seen = [];
  });
  afterEach(() => tmp.remove());

  function start(script: Generation[], options: { autoApprove?: boolean; decide?: (record: ToolCallRecord) => Decision; stepLimit?: number; onLimit?: () => "continue" | "stop"; signal?: AbortSignal } = {}) {
    const states = new Map<string, string>();
    let round = 0;
    const host: AgentHost = {
      generate: async (messages: ChatMessage[]) => {
        seen.push(JSON.stringify(messages.at(-1)));
        return script[Math.min(round++, script.length - 1)];
      },
      onToolStart: (record, state) => states.set(record.id, state),
      awaitDecision: async (record) => {
        asked.push(record);
        return options.decide?.(record) ?? { decision: "approve" };
      },
      onToolEnd: (record, end) => ends.push({ record, end, state: states.get(record.id) }),
      awaitContinue: async () => options.onLimit?.() ?? "stop",
    };
    const messages: ChatMessage[] = [{ role: "user", content: "やって" }];
    const done = runAgentLoop({
      workspace: ws, autoApprove: () => options.autoApprove ?? false, signal: options.signal ?? new AbortController().signal,
      messages, countTokens: async (text) => text.length, host, makeId: (() => { let n = 0; return () => `id${++n}`; })(),
      stepLimit: options.stepLimit, commandTimeoutMs: 5000,
    });
    return { done, messages };
  }

  it("読み取りは承認なしで実行する", async () => {
    writeFileSync(path.join(ws, "a.txt"), "中身");
    const { done } = start([reply([call("c1", "read_file", { path: "a.txt" })]), reply([], "完了")]);
    expect(await done).toMatchObject({ status: "completed", stepCount: 1 });
    expect(asked).toEqual([]);
    expect(ends[0].end).toMatchObject({ status: "succeeded", output: "1\t中身" });
  });

  it("書き込み・コマンドは承認が要る。承認すると実行して結果が会話に足される", async () => {
    const { done, messages } = start([
      reply([call("c1", "write_file", { path: "n.txt", content: "新規" }), call("c2", "run_command", { command: "echo hi" })]),
      reply([], "完了"),
    ]);
    await done;
    expect(asked.map((r) => r.tool)).toEqual(["write_file", "run_command"]);
    expect(readFileSync(path.join(ws, "n.txt"), "utf8")).toBe("新規");
    expect(ends.map((e) => e.end.status)).toEqual(["succeeded", "succeeded"]);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool", "assistant"]);
    expect(messages[1]).toMatchObject({ tool_calls: [{ id: "c1" }, { id: "c2" }] });
  });

  it("却下は実行せず、理由をモデルに返す", async () => {
    const { done, messages } = start(
      [reply([call("c1", "write_file", { path: "n.txt", content: "x" })]), reply([], "了解")],
      { decide: () => ({ decision: "reject", note: "別の名前で" }) },
    );
    await done;
    expect(existsSync(path.join(ws, "n.txt"))).toBe(false);
    expect(ends[0].end).toMatchObject({ status: "rejected", note: "別の名前で" });
    expect(messages[2]).toMatchObject({ role: "tool", tool_call_id: "c1", content: "利用者が却下しました。理由: 別の名前で" });
  });

  it("自動承認 ON なら聞かずに実行する。ワークスペース外は ON でも denied", async () => {
    const { done } = start(
      [reply([call("c1", "write_file", { path: "n.txt", content: "x" }), call("c2", "write_file", { path: "../escape.txt", content: "x" }), call("c3", "run_command", { command: "echo", cwd: "/etc" })]), reply([], "完了")],
      { autoApprove: true },
    );
    await done;
    expect(asked).toEqual([]);
    expect(ends.map((e) => e.end.status)).toEqual(["succeeded", "denied", "denied"]);
    expect(existsSync(path.join(ws, "..", "escape.txt"))).toBe(false);
  });

  it("名前の不明・壊れた JSON はエラーをモデルに返し、1 回に数える", async () => {
    const { done, messages } = start([reply([call("c1", "nope", {}), call("c2", "read_file", "{\"path\": ")]), reply([], "完了")]);
    expect(await done).toMatchObject({ status: "completed", stepCount: 2 });
    expect(ends.map((e) => e.end.status)).toEqual(["failed", "failed"]);
    expect(messages.filter((m) => m.role === "tool").map((m) => m.content)).toEqual(["不明なツールです: nope", expect.stringContaining("JSON として壊れています")]);
    // 壊れた引数は履歴では {} にして次の生成へ渡す
    expect((messages[1] as { tool_calls: { function: { arguments: string } }[] }).tool_calls[1].function.arguments).toBe("{}");
  });

  it("上限に達したら聞き、続けるとさらに上限まで、やめると completed", async () => {
    mkdirSync(path.join(ws, "d"));
    const looping = reply([call("c", "list_dir", { path: "d" })]);
    let asks = 0;
    const { done } = start([looping], { stepLimit: 3, onLimit: () => (++asks === 1 ? "continue" : "stop") });
    expect(await done).toMatchObject({ status: "completed", stepCount: 6 });
    expect(asks).toBe(2);
  });

  it("1 応答の呼び出しは上限をまたいでも最後まで処理する", async () => {
    const calls = [1, 2, 3].map((n) => call(`c${n}`, "list_dir", {}));
    const { done } = start([reply(calls), reply([], "完了")], { stepLimit: 2, onLimit: () => "continue" });
    expect(await done).toMatchObject({ status: "completed", stepCount: 3 });
    expect(ends).toHaveLength(3);
  });

  it("承認待ちの間に止めると cancelled。呼び出しは rejected で閉じる", async () => {
    const abort = new AbortController();
    const states = ends;
    const host: AgentHost = {
      generate: async () => reply([call("c1", "run_command", { command: "echo hi" })]),
      onToolStart: () => {},
      awaitDecision: (_record, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
      onToolEnd: (record, end) => states.push({ record, end }),
      awaitContinue: async () => "stop",
    };
    const done = runAgentLoop({
      workspace: ws, autoApprove: () => false, signal: abort.signal, messages: [{ role: "user", content: "x" }],
      countTokens: async (t) => t.length, host, makeId: () => "id",
    });
    setTimeout(() => abort.abort(), 50);
    expect(await done).toMatchObject({ status: "cancelled" });
    expect(ends[0].end.status).toBe("rejected");
  });
});
