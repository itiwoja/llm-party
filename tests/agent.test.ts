import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BusEvent } from "../server/events";
import { FAKE_LLAMA, SAMPLING, startWorker, tempDir, type TestWorker, waitForEvent, writeGguf } from "./helpers";

interface Step {
  content?: string;
  toolCalls?: { id: string; name: string; arguments: unknown }[];
  times?: number;
  loop?: boolean;
}

type Worker = TestWorker;

const startAgentWorker = (commandTimeoutMs = 5000) => startWorker(FAKE_LLAMA, { commandTimeoutMs });

const data = (event: BusEvent) => event.data as Record<string, any>;
const finished = (worker: Worker, turnId: string) =>
  waitForEvent(worker.context.bus, (e) => e.event === "turn.finished" && data(e).turnId === turnId);
const pending = (worker: Worker, after = 0) => waitForEvent(worker.context.bus, (e) => e.id > after && e.event === "tool.pending");
const lastId = (worker: Worker) => worker.context.bus.since(0).at(-1)?.id ?? 0;

function requests(worker: Worker): any[] {
  const dir = path.join(worker.dir, "logs");
  const log = readFileSync(path.join(dir, readdirSync(dir)[0]), "utf8");
  return log.split("\n").filter((line) => line.startsWith("REQUEST ")).map((line) => JSON.parse(line.slice("REQUEST ".length)));
}

describe("エージェント（fake-llama）", () => {
  let worker: Worker;
  let scratch: ReturnType<typeof tempDir>;
  let ws: string;

  beforeEach(async () => {
    worker = await startAgentWorker();
    scratch = tempDir();
    ws = realpathSync(scratch.dir);
  });
  afterEach(async () => {
    await worker.close();
    scratch.remove();
    vi.unstubAllEnvs();
  });

  const script = (steps: Step[]) => {
    const file = path.join(scratch.dir, "script.json");
    writeFileSync(file, JSON.stringify(steps));
    vi.stubEnv("FAKE_LLAMA_SCRIPT", file);
  };

  async function setup(workspacePath: string | null = ws) {
    const file = path.join(worker.dir, "model.gguf");
    writeGguf(file);
    const model = await worker.api("/models", { body: { path: file, mode: "reference" } });
    const preset = await worker.api("/presets", {
      body: { name: "対話", modelId: model.body.id, sampling: SAMPLING, thinking: false, contextSize: 4096, systemPrompt: "短く答える" },
    });
    let workspaceId: string | undefined;
    if (workspacePath) {
      const registered = await worker.api("/workspaces", { body: { path: workspacePath } });
      expect(registered.status).toBe(201);
      workspaceId = registered.body.id;
    }
    const thread = await worker.api("/threads", { body: { presetId: preset.body.id, workspaceId } });
    expect(thread.status).toBe(201);
    return { presetId: preset.body.id as string, threadId: thread.body.id as string };
  }

  const send = async (threadId: string, presetId: string, content = "やって") => {
    const res = await worker.api(`/threads/${threadId}/turns`, { body: { presetId, content } });
    expect(res.status).toBe(202);
    return res.body.turnId as string;
  };

  const write = { id: "call_1", name: "write_file", arguments: { path: "hello.txt", content: "こんにちは\n" } };

  it("承認すると実行して続きが来る。差分のプレビュー・イベントの順・保存・次の生成への引き継ぎ", async () => {
    script([{ toolCalls: [write] }, { content: "書きました" }]);
    const { presetId, threadId } = await setup();
    const turnId = await send(threadId, presetId);

    const card = await pending(worker);
    expect(card.data).toMatchObject({ tool: "write_file", args: write.arguments });
    expect(data(card).preview).toContain("--- /dev/null\n+++ b/hello.txt");
    const toolCallId = data(card).toolCallId as string;
    expect(existsSync(path.join(ws, "hello.txt"))).toBe(false);

    // 承認待ちの間はターンも承認待ちで、画面を開き直しても差分が戻る
    const mid = await worker.api(`/threads/${threadId}/messages`);
    expect(mid.body.turns[0].status).toBe("awaiting_approval");
    expect(mid.body.toolCalls[0]).toMatchObject({ id: toolCallId, status: "pending_approval", kind: "write" });
    expect(mid.body.toolCalls[0].preview).toContain("+こんにちは");
    expect((await worker.api(`/threads/${threadId}/turns`, { body: { presetId, content: "割り込み" } })).body.error.code).toBe("BUSY");

    const decision = await worker.api(`/tool-calls/${toolCallId}/decision`, { body: { decision: "approve" } });
    expect(decision).toMatchObject({ status: 200, body: { status: "running" } });
    expect((await worker.api(`/tool-calls/${toolCallId}/decision`, { body: { decision: "approve" } })).status).toBe(409);
    expect((await finished(worker, turnId)).data).toEqual({ turnId, status: "completed" });

    expect(readFileSync(path.join(ws, "hello.txt"), "utf8")).toBe("こんにちは\n");
    const names = worker.context.bus.since(0).map((e) => e.event).filter((name) => name.startsWith("tool.") || name === "turn.finished");
    expect(names).toEqual(["tool.pending", "tool.started", "tool.finished", "turn.finished"]);

    const detail = await worker.api(`/threads/${threadId}/messages`);
    expect(detail.body.turns[0]).toMatchObject({ status: "completed", stepCount: 1, stepLimit: 40 });
    expect(detail.body.toolCalls[0]).toMatchObject({ status: "succeeded", tool: "write_file", callRef: "call_1", args: write.arguments });
    expect(detail.body.messages.map((m: any) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(detail.body.messages[2]).toMatchObject({ toolCallId, content: expect.stringContaining("作成しました") });

    // 2 回目の生成には assistant の tool_calls と tool の結果が並ぶ。ツールと作業フォルダの説明も付く
    const [first, second] = requests(worker);
    expect(first.tools.map((t: any) => t.function.name)).toHaveLength(6);
    expect(first.messages[0].content).toContain(ws);
    expect(first.messages[0].content).toContain("短く答える");
    expect(second.messages.slice(-2)).toEqual([
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "write_file", arguments: JSON.stringify(write.arguments) } }] },
      { role: "tool", tool_call_id: "call_1", content: expect.stringContaining("作成しました") },
    ]);

    // 次の指示でも履歴に残る
    script([{ content: "次" }]);
    const again = await send(threadId, presetId, "続き");
    await finished(worker, again);
    const last = requests(worker).at(-1);
    expect(last.messages.map((m: any) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant", "user"]);
  });

  it("却下すると実行せず、理由がモデルに届く", async () => {
    script([{ toolCalls: [write] }, { content: "別の方法にします" }]);
    const { presetId, threadId } = await setup();
    const turnId = await send(threadId, presetId);
    const card = await pending(worker);
    const res = await worker.api(`/tool-calls/${data(card).toolCallId}/decision`, { body: { decision: "reject", note: "名前を変えて" } });
    expect(res.body).toEqual({ status: "rejected" });
    await finished(worker, turnId);

    expect(existsSync(path.join(ws, "hello.txt"))).toBe(false);
    const detail = await worker.api(`/threads/${threadId}/messages`);
    expect(detail.body.toolCalls[0]).toMatchObject({ status: "rejected", decisionNote: "名前を変えて" });
    expect(requests(worker)[1].messages.at(-1)).toMatchObject({ role: "tool", content: "利用者が却下しました。理由: 名前を変えて" });
  });

  it("approve_and_auto でスレッドの自動承認が ON になり、以後は聞かない", async () => {
    const second = { id: "call_2", name: "write_file", arguments: { path: "two.txt", content: "2" } };
    script([{ toolCalls: [write] }, { toolCalls: [second] }, { content: "完了" }]);
    const { presetId, threadId } = await setup();
    const turnId = await send(threadId, presetId);
    const card = await pending(worker);
    await worker.api(`/tool-calls/${data(card).toolCallId}/decision`, { body: { decision: "approve_and_auto" } });
    await finished(worker, turnId);

    expect(readFileSync(path.join(ws, "two.txt"), "utf8")).toBe("2");
    expect(worker.context.bus.since(0).filter((e) => e.event === "tool.pending")).toHaveLength(1);
    expect((await worker.api("/threads")).body.items[0]).toMatchObject({ id: threadId, autoApprove: true });
  });

  it("PATCH で自動承認を ON にしておくと最初から聞かない。外は ON でも denied", async () => {
    script([{ toolCalls: [write, { id: "call_2", name: "write_file", arguments: { path: "../escape.txt", content: "x" } }] }, { content: "完了" }]);
    const { presetId, threadId } = await setup();
    const patched = await worker.api(`/threads/${threadId}`, { method: "PATCH", body: { autoApprove: true, title: "作業" } });
    expect(patched.body).toMatchObject({ autoApprove: true, title: "作業" });
    const turnId = await send(threadId, presetId);
    await finished(worker, turnId);

    expect(worker.context.bus.since(0).filter((e) => e.event === "tool.pending")).toHaveLength(0);
    expect(existsSync(path.join(ws, "hello.txt"))).toBe(true);
    const detail = await worker.api(`/threads/${threadId}/messages`);
    expect(detail.body.toolCalls.map((c: any) => c.status)).toEqual(["succeeded", "denied"]);
    expect(existsSync(path.join(path.dirname(ws), "escape.txt"))).toBe(false);
  });

  it("読み取りは自動。壊れた JSON・不明なツールはエラーがモデルに返り、複数の呼び出しは順番に処理する", async () => {
    writeFileSync(path.join(ws, "a.txt"), "中身\n");
    script([
      { toolCalls: [
        { id: "c1", name: "read_file", arguments: { path: "a.txt" } },
        { id: "c2", name: "read_file", arguments: "{\"path\": \"a" },
        { id: "c3", name: "unknown_tool", arguments: {} },
      ] },
      { content: "完了" },
    ]);
    const { presetId, threadId } = await setup();
    const turnId = await send(threadId, presetId);
    await finished(worker, turnId);

    const detail = await worker.api(`/threads/${threadId}/messages`);
    expect(detail.body.toolCalls.map((c: any) => [c.callRef, c.status])).toEqual([["c1", "succeeded"], ["c2", "failed"], ["c3", "failed"]]);
    expect(detail.body.turns[0].stepCount).toBe(3);
    const tail = requests(worker)[1].messages.slice(-3);
    expect(tail.map((m: any) => m.tool_call_id)).toEqual(["c1", "c2", "c3"]);
    expect(tail[0].content).toBe("1\t中身");
    expect(tail[1].content).toContain("JSON として壊れています");
    expect(tail[2].content).toContain("不明なツール");
    // 壊れた引数は履歴では {} で渡す
    expect(requests(worker)[1].messages.at(-4).tool_calls[1].function.arguments).toBe("{}");
  });

  it("ワークスペース外のパスは denied で、承認カードを出さない", async () => {
    script([{ toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "../../etc/passwd" } }] }, { content: "完了" }]);
    const { presetId, threadId } = await setup();
    const turnId = await send(threadId, presetId);
    await finished(worker, turnId);
    const detail = await worker.api(`/threads/${threadId}/messages`);
    expect(detail.body.toolCalls[0]).toMatchObject({ status: "denied", decisionNote: expect.any(String) });
    expect(worker.context.bus.since(0).find((e) => e.event === "tool.finished")?.data).toMatchObject({ status: "denied" });
  });

  it("大きな出力は 8,000 トークンに切り詰めて、保存もその形", async () => {
    writeFileSync(path.join(ws, "big.txt"), Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n"));
    script([{ toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "big.txt" } }] }, { content: "完了" }]);
    const { presetId, threadId } = await setup();
    await finished(worker, await send(threadId, presetId));
    const output = (await worker.api(`/threads/${threadId}/messages`)).body.toolCalls[0].output as string;
    expect(output.length).toBeLessThanOrEqual(8000);
    expect(output).toMatch(/…\d+ 行省略。startLine \/ endLine を指定して読めます…/);
    expect(output.startsWith("1\tline 0\n")).toBe(true);
    expect(output.endsWith("5000\tline 4999")).toBe(true);
  });

  it("40 回で step_limit。続けるとさらに進み、やめると completed", async () => {
    script([{ toolCalls: [{ id: "c", name: "list_dir", arguments: {} }], loop: true }]);
    const { presetId, threadId } = await setup();
    const turnId = await send(threadId, presetId);
    const limit = await waitForEvent(worker.context.bus, (e) => e.event === "turn.stepLimit");
    expect(limit.data).toEqual({ turnId, stepCount: 40 });

    const detail = await worker.api(`/threads/${threadId}/messages`);
    expect(detail.body.turns[0]).toMatchObject({ status: "step_limit", stepCount: 40, stepLimit: 40 });
    // 止まっている間も枠を持ち、止めるのは「続ける / やめる」で行う
    expect((await worker.api(`/threads/${threadId}/turns`, { body: { presetId, content: "割り込み" } })).body.error.code).toBe("BUSY");
    expect((await worker.api(`/turns/${turnId}/cancel`, { body: {} })).status).toBe(409);
    expect((await worker.api(`/turns/${turnId}/continue`, { body: { action: "later" } })).status).toBe(400);

    const mark = lastId(worker);
    expect((await worker.api(`/turns/${turnId}/continue`, { body: { action: "continue" } })).body).toEqual({ status: "running" });
    const second = await waitForEvent(worker.context.bus, (e) => e.id > mark && e.event === "turn.stepLimit");
    expect(second.data).toEqual({ turnId, stepCount: 80 });
    expect((await worker.api(`/threads/${threadId}/messages`)).body.turns[0]).toMatchObject({ status: "step_limit", stepLimit: 80 });

    expect((await worker.api(`/turns/${turnId}/continue`, { body: { action: "stop" } })).body).toEqual({ status: "completed" });
    expect((await finished(worker, turnId)).data).toEqual({ turnId, status: "completed" });
    expect((await worker.api(`/turns/${turnId}/continue`, { body: { action: "stop" } })).status).toBe(409);
    // 終わったら次の送信を受け付ける
    script([{ content: "次" }]);
    expect((await worker.api(`/threads/${threadId}/turns`, { body: { presetId, content: "次" } })).status).toBe(202);
  }, 20000);

  it("承認待ちの間のキャンセルは cancelled。呼び出しは rejected で閉じる", async () => {
    script([{ toolCalls: [write] }, { content: "完了" }]);
    const { presetId, threadId } = await setup();
    const turnId = await send(threadId, presetId);
    const card = await pending(worker);
    expect((await worker.api(`/turns/${turnId}/cancel`, { body: {} })).status).toBe(200);
    expect((await finished(worker, turnId)).data).toEqual({ turnId, status: "cancelled" });

    const detail = await worker.api(`/threads/${threadId}/messages`);
    expect(detail.body.turns[0].status).toBe("cancelled");
    expect(detail.body.toolCalls[0]).toMatchObject({ id: data(card).toolCallId, status: "rejected" });
    expect(existsSync(path.join(ws, "hello.txt"))).toBe(false);
    expect((await worker.api(`/tool-calls/${data(card).toolCallId}/decision`, { body: { decision: "approve" } })).status).toBe(409);
  });

  it("run_command：出力を tool.output で流し、時間切れでプロセスグループごと消える", async () => {
    await worker.close();
    worker = await startAgentWorker(600);
    // 孫プロセスを残して待つ。時間切れでグループごと消えなければ pid が生きている
    const command = "sleep 300 & echo $! > pid.txt; echo started; wait";
    script([{ toolCalls: [{ id: "c1", name: "run_command", arguments: { command } }] }, { content: "完了" }]);
    const { presetId, threadId } = await setup();
    await worker.api(`/threads/${threadId}`, { method: "PATCH", body: { autoApprove: true } });
    const turnId = await send(threadId, presetId);
    await finished(worker, turnId);

    const detail = await worker.api(`/threads/${threadId}/messages`);
    expect(detail.body.toolCalls[0]).toMatchObject({ status: "timed_out", kind: "command" });
    expect(detail.body.toolCalls[0].output).toContain("started");
    expect(detail.body.toolCalls[0].output).toContain("時間切れ");
    const chunks = worker.context.bus.since(0).filter((e) => e.event === "tool.output").map((e) => data(e).chunk);
    expect(chunks.join("")).toContain("started");

    const pid = Number(readFileSync(path.join(ws, "pid.txt"), "utf8").trim());
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(/ESRCH/), { timeout: 3000 });
  });

  it("run_command：停止（キャンセル）でも子プロセスが消える", async () => {
    const command = "sleep 300 & echo $! > pid.txt; echo started; wait";
    script([{ toolCalls: [{ id: "c1", name: "run_command", arguments: { command } }] }]);
    const { presetId, threadId } = await setup();
    await worker.api(`/threads/${threadId}`, { method: "PATCH", body: { autoApprove: true } });
    const turnId = await send(threadId, presetId);
    await waitForEvent(worker.context.bus, (e) => e.event === "tool.output");
    await worker.api(`/turns/${turnId}/cancel`, { body: {} });
    expect((await finished(worker, turnId)).data).toEqual({ turnId, status: "cancelled" });
    const pid = Number(readFileSync(path.join(ws, "pid.txt"), "utf8").trim());
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(/ESRCH/), { timeout: 3000 });
    expect((await worker.api(`/threads/${threadId}/messages`)).body.toolCalls[0].status).toBe("failed");
  });

  it("スレッド削除は動いているターンを止めてから、メッセージ・ツール呼び出しごと消す。ファイルは残る", async () => {
    writeFileSync(path.join(ws, "keep.txt"), "残る");
    script([{ toolCalls: [write] }]);
    const { presetId, threadId } = await setup();
    const turnId = await send(threadId, presetId);
    await pending(worker);

    expect((await worker.api(`/threads/${threadId}`, { method: "DELETE" })).status).toBe(204);
    expect((await finished(worker, turnId)).data).toMatchObject({ status: "cancelled" });
    expect((await worker.api(`/threads/${threadId}/messages`)).status).toBe(404);
    expect((await worker.api(`/threads/${threadId}`, { method: "DELETE" })).status).toBe(404);
    const db = worker.context.db;
    expect(db.prepare("SELECT COUNT(*) AS n FROM tool_calls").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 0 });
    expect(readFileSync(path.join(ws, "keep.txt"), "utf8")).toBe("残る");
    // 枠も空く
    script([{ content: "次" }]);
    const next = await worker.api("/threads", { body: { presetId } });
    expect((await worker.api(`/threads/${next.body.id}/turns`, { body: { presetId, content: "a" } })).status).toBe(202);
  });

  it("ワークスペースのないスレッドはツールを渡さない", async () => {
    const { presetId, threadId } = await setup(null);
    await finished(worker, await send(threadId, presetId, "挨拶"));
    const [request] = requests(worker);
    expect(request.tools).toBeUndefined();
    expect(request.messages[0].content).toBe("短く答える");
    expect((await worker.api(`/threads/${threadId}/messages`)).body.toolCalls).toEqual([]);
  });

  it("ツール呼び出しの判断 API のエラー", async () => {
    expect((await worker.api("/tool-calls/none/decision", { body: { decision: "approve" } })).status).toBe(404);
    expect((await worker.api("/tool-calls/none/decision", { body: { decision: "maybe" } })).status).toBe(400);
    expect((await worker.api("/turns/none/continue", { body: { action: "stop" } })).status).toBe(409);
  });
});

describe("ワークスペース（API-041, 042）", () => {
  let worker: Worker;
  let scratch: ReturnType<typeof tempDir>;
  beforeEach(async () => {
    worker = await startAgentWorker();
    scratch = tempDir();
  });
  afterEach(async () => {
    await worker.close();
    scratch.remove();
  });

  it("登録して一覧に出る。同じパスは使い回す。不可の場所は PATH_NOT_ALLOWED", async () => {
    const first = await worker.api("/workspaces", { body: { path: scratch.dir } });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ path: realpathSync(scratch.dir), name: path.basename(scratch.dir) });
    const again = await worker.api("/workspaces", { body: { path: scratch.dir } });
    expect(again.body.id).toBe(first.body.id);
    expect((await worker.api("/workspaces")).body.items).toHaveLength(1);

    for (const bad of ["/", "/etc", worker.dir, path.join(worker.dir, "db"), path.join(scratch.dir, "none")]) {
      const res = await worker.api("/workspaces", { body: { path: bad } });
      expect(res.status, bad).toBe(400);
      expect(res.body.error).toEqual({ code: "PATH_NOT_ALLOWED", message: "このフォルダは作業フォルダに不可。別のフォルダを選択" });
    }
    const nested = path.join(scratch.dir, "p");
    mkdirSync(nested);
    expect((await worker.api("/workspaces", { body: { path: nested } })).status).toBe(201);
  });

  it("スレッドの作成は存在するワークスペースだけ。一覧にワークスペース名が出る", async () => {
    const file = path.join(worker.dir, "model.gguf");
    writeGguf(file);
    const model = await worker.api("/models", { body: { path: file, mode: "reference" } });
    const preset = await worker.api("/presets", { body: { name: "p", modelId: model.body.id, sampling: SAMPLING, thinking: false, contextSize: 4096 } });
    expect((await worker.api("/threads", { body: { presetId: preset.body.id, workspaceId: "none" } })).status).toBe(404);
    const ws = await worker.api("/workspaces", { body: { path: scratch.dir } });
    const thread = await worker.api("/threads", { body: { presetId: preset.body.id, workspaceId: ws.body.id } });
    expect(thread.body).toMatchObject({ workspaceId: ws.body.id, workspaceName: path.basename(scratch.dir) });
    expect((await worker.api("/threads")).body.items[0].workspaceName).toBe(path.basename(scratch.dir));
  });

  it("再起動で残った承認待ち・実行中の呼び出しを閉じる", async () => {
    const { store, db } = worker.context;
    const thread = store.threads.create(null);
    const turnId = "t1";
    db.prepare("INSERT INTO turns (id, thread_id, status) VALUES ('t1', ?, 'running')").run(thread.id);
    db.prepare("INSERT INTO turns (id, thread_id, status) VALUES ('t2', ?, 'awaiting_approval')").run(thread.id);
    store.agent.createToolCall({ id: "a", turnId, callRef: "r", tool: "write_file", args: {}, kind: "write", status: "pending_approval" });
    store.agent.createToolCall({ id: "b", turnId, callRef: "r", tool: "run_command", args: {}, kind: "command", status: "running" });
    store.agent.createToolCall({ id: "c", turnId, callRef: "r", tool: "list_dir", args: {}, kind: "read", status: "succeeded" });
    store.threads.failUnfinishedTurns();
    expect(store.agent.toolCallsOfThread(thread.id).map((c) => c.status)).toEqual(["rejected", "failed", "succeeded"]);
    expect(store.threads.turn(turnId)?.status).toBe("failed");
    expect(store.threads.turn("t2")?.status).toBe("failed");
  });
});
