import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CompactRow, CONTEXT_FULL, isContextFull, needsCompaction, planCompaction } from "../server/agent/compact";
import type { BusEvent } from "../server/events";
import { openDatabase } from "../server/db";
import { Store } from "../server/store";
import { FAKE_LLAMA, SAMPLING, startWorker, tempDir, type TestWorker, waitForEvent, writeGguf } from "./helpers";

const row = (seq: number, role: string, extra: Partial<CompactRow> = {}): CompactRow => ({ id: `m${seq}`, seq, role, content: `c${seq}`, pinned: false, ...extra });

describe("planCompaction（FR-006 の残すもの）", () => {
  it("閾値は 80% を超えたときだけ。100% を超えると送らない", () => {
    expect(needsCompaction(3276, 4096)).toBe(false);
    expect(needsCompaction(3277, 4096)).toBe(true);
    expect(needsCompaction(32768 * 0.8, 32768)).toBe(false);
    expect(isContextFull(4096, 4096)).toBe(false);
    expect(isContextFull(4097, 4096)).toBe(true);
  });

  it("最初の指示と直近 6 件を残し、その前を要約する", () => {
    const rows = [row(1, "user", { pinned: true }), ...[2, 3, 4, 5, 6, 7, 8, 9].map((seq) => row(seq, seq % 2 ? "user" : "assistant"))];
    const plan = planCompaction(rows)!;
    expect(plan.middle.map((r) => r.seq)).toEqual([2, 3]);
    expect(plan.keepFromSeq).toBe(4);
  });

  it("6 件以下なら要約しない。前回の要約だけでも要約しない", () => {
    const rows = [row(1, "user", { pinned: true }), ...[2, 3, 4, 5, 6, 7].map((seq) => row(seq, "user"))];
    expect(planCompaction(rows)).toBeNull();
    const withSummary = [row(1, "user", { pinned: true }), row(2, "summary"), ...[3, 4, 5, 6, 7, 8].map((seq) => row(seq, "user"))];
    expect(planCompaction(withSummary)).toBeNull();
  });

  it("残す側の先頭が tool なら、呼び出しを出した assistant まで遡る（組を割らない）", () => {
    const rows = [
      row(1, "user", { pinned: true }), row(2, "user"), row(3, "assistant"), row(4, "tool"),
      row(5, "assistant"), row(6, "tool"), row(7, "tool"), row(8, "assistant"), row(9, "tool"), row(10, "user"),
    ];
    // 素直に 6 件なら seq 5 から（assistant）。seq 5 から始まる組はそのまま残る
    expect(planCompaction(rows)!.keepFromSeq).toBe(5);
    // 6 件の先頭が tool になる並び：seq 4（tool）から数えると assistant の seq 3 まで戻る
    const shifted = [row(1, "user", { pinned: true }), row(2, "user"), row(3, "assistant"), row(4, "tool"), row(5, "assistant"), row(6, "assistant"), row(7, "assistant"), row(8, "user"), row(9, "assistant")];
    expect(planCompaction(shifted)!.keepFromSeq).toBe(3);
    const toolsHead = [row(1, "user", { pinned: true }), row(2, "user"), row(3, "assistant"), row(4, "tool"), row(5, "tool"), row(6, "tool"), row(7, "assistant"), row(8, "tool"), row(9, "user")];
    // 末尾 6 件は seq 4 から。tool 3 つ（seq 4〜6）の呼び出し元 seq 3 まで戻る → 要約するのは seq 2 だけ
    const plan = planCompaction(toolsHead)!;
    expect(plan.keepFromSeq).toBe(3);
    expect(plan.middle.map((r) => r.seq)).toEqual([2]);
  });

  it("空のまま残った assistant は数えない", () => {
    const rows = [row(1, "user", { pinned: true }), row(2, "user"), row(3, "assistant", { content: "" }), ...[4, 5, 6, 7, 8, 9].map((seq) => row(seq, "user"))];
    const plan = planCompaction(rows)!;
    expect(plan.middle.map((r) => r.seq)).toEqual([2]);
    expect(plan.keepFromSeq).toBe(4);
  });
});

describe("自動要約（fake-llama）", () => {
  let worker: TestWorker;
  let scratch: ReturnType<typeof tempDir>;
  beforeEach(async () => {
    worker = await startWorker();
    scratch = tempDir();
  });
  afterEach(async () => {
    await worker.close();
    scratch.remove();
    vi.unstubAllEnvs();
  });

  const script = (steps: unknown[]) => {
    const file = path.join(scratch.dir, "script.json");
    writeFileSync(file, JSON.stringify(steps));
    vi.stubEnv("FAKE_LLAMA_SCRIPT", file);
  };
  const SUMMARY = "## 目的\nテスト\n## 決まったこと\nなし\n## 触ったファイル\nなし\n## 残りの作業\nなし";

  async function setup(workspacePath?: string) {
    const file = path.join(worker.dir, "model.gguf");
    writeGguf(file);
    const model = await worker.api("/models", { body: { path: file, mode: "reference" } });
    const preset = await worker.api("/presets", {
      body: { name: "対話", modelId: model.body.id, sampling: SAMPLING, thinking: true, contextSize: 8192, systemPrompt: "短く答える" },
    });
    const workspace = workspacePath ? (await worker.api("/workspaces", { body: { path: workspacePath } })).body.id : undefined;
    const thread = await worker.api("/threads", { body: { presetId: preset.body.id, workspaceId: workspace } });
    return { presetId: preset.body.id as string, threadId: thread.body.id as string };
  }
  const send = async (threadId: string, presetId: string, content: string) => {
    const res = await worker.api(`/threads/${threadId}/turns`, { body: { presetId, content } });
    expect(res.status).toBe(202);
    return waitForEvent(worker.context.bus, (e) => e.event === "turn.finished" && (e.data as any).turnId === res.body.turnId);
  };
  const requests = (): any[] => {
    const dir = path.join(worker.dir, "logs");
    if (!existsSync(dir) || readdirSync(dir).length === 0) return [];
    const log = readFileSync(path.join(dir, readdirSync(dir)[0]), "utf8");
    return log.split("\n").filter((line) => line.startsWith("REQUEST ")).map((line) => JSON.parse(line.slice("REQUEST ".length)));
  };
  const compacted = (): BusEvent[] => worker.context.bus.since(0).filter((e) => e.event === "turn.compacted");
  const big = (char: string, n: number) => char.repeat(n);

  it("80% を超えると要約して続きが送れる。元は残り、再起動後も同じ会話がつながる", async () => {
    // 1〜4 回目は普通の応答、5 回目の頭で要約（5 つ目の応答）、その後の応答
    script([{ content: "返事1" }, { content: "返事2" }, { content: "返事3" }, { content: "返事4" }, { content: SUMMARY }, { content: "続き" }, { content: "続き2" }]);
    const { presetId, threadId } = await setup();
    for (let n = 1; n <= 4; n += 1) expect((await send(threadId, presetId, `${n}${big("あ", 699)}`)).data).toMatchObject({ status: "completed" });
    expect(compacted()).toHaveLength(0);
    expect((await send(threadId, presetId, `5${big("あ", 699)}`)).data).toMatchObject({ status: "completed" });

    const [event] = compacted();
    expect(event.data).toMatchObject({ threadId, count: 2 });

    // 要約の依頼：同じモデル・思考 OFF・ツールなし・上限あり
    const summaryRequest = requests()[4];
    expect(summaryRequest.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(summaryRequest.tools).toBeUndefined();
    expect(summaryRequest.messages).toHaveLength(1);
    expect(summaryRequest.messages[0].content).toContain("目的");
    expect(summaryRequest.messages[0].content).toContain("返事1");

    // 続きの送信：システム、最初の指示、要約、直近 6 件
    const next = requests()[5].messages.map((m: any) => [m.role, m.content.slice(0, 11)]);
    expect(next).toEqual([
      ["system", "短く答える"],
      ["user", `1${big("あ", 10)}`],
      ["user", "これまでの会話の要約:"],
      ["assistant", "返事2"], ["user", `3${big("あ", 10)}`], ["assistant", "返事3"], ["user", `4${big("あ", 10)}`], ["assistant", "返事4"], ["user", `5${big("あ", 10)}`],
    ]);

    // threadDetail には全部残り、seq の順で要約は要約した部分の直後に入る
    const detail = await worker.api(`/threads/${threadId}/messages`);
    const messages = detail.body.messages as { id: string; role: string; content: string; compactedAt: string | null; pinned: boolean }[];
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "summary", "assistant", "user", "assistant", "user", "assistant", "user", "assistant"]);
    expect(messages.filter((m) => m.compactedAt).map((m) => m.content.slice(0, 3))).toEqual(["返事1", `2${big("あ", 2)}`]);
    expect(messages[0]).toMatchObject({ pinned: true, compactedAt: null });
    expect(messages[3]).toMatchObject({ id: (event.data as { summaryMessageId: string }).summaryMessageId, content: SUMMARY });

    // さらに送れる。再起動（DB を開き直す）後の会話の組み立ても同じ
    expect((await send(threadId, presetId, "もう一つ")).data).toMatchObject({ status: "completed" });
    const reopened = new Store(openDatabase(worker.dir));
    expect(reopened.threads.conversation(threadId)).toEqual(worker.context.store.threads.conversation(threadId));
    expect(reopened.threads.conversation(threadId).filter((m) => m.content.startsWith("これまでの会話の要約")))
      .toEqual([{ role: "user", content: `これまでの会話の要約:\n${SUMMARY}` }]);
  });

  it("要約しても 100% を超えるときは送らず CP-050 で失敗し、要約から新しいスレッドを作れる", async () => {
    script([{ content: "返事1" }, { content: "返事2" }, { content: "返事3" }, { content: "返事4" }, { content: SUMMARY }, { content: "届かない" }]);
    const { presetId, threadId } = await setup();
    const sizes = [100, 1300, 1300, 1300, 1400];
    for (const [index, size] of sizes.slice(0, 4).entries()) {
      expect((await send(threadId, presetId, `${index + 1}${big("あ", size - 1)}`)).data).toMatchObject({ status: "completed" });
    }
    const last = await send(threadId, presetId, `5${big("あ", sizes[4] - 1)}`);
    expect(last.data).toMatchObject({ status: "failed", error: CONTEXT_FULL });
    expect(compacted()).toHaveLength(1);
    expect(requests()).toHaveLength(5); // 5 つ目は要約の依頼で、送信はされていない

    const created = await worker.api("/threads", { body: { presetId, summaryFromThreadId: threadId } });
    expect(created.status).toBe(201);
    const detail = await worker.api(`/threads/${created.body.id}/messages`);
    expect(detail.body.messages).toHaveLength(1);
    expect(detail.body.messages[0]).toMatchObject({ role: "user", content: SUMMARY, pinned: true });
    expect(created.body.title).toBe(`1${big("あ", 99)}`.split("\n")[0]);

    // 要約のないスレッドからは作れない
    const fresh = await worker.api("/threads", { body: { presetId } });
    expect((await worker.api("/threads", { body: { presetId, summaryFromThreadId: fresh.body.id } })).status).toBe(409);
    expect((await worker.api("/threads", { body: { presetId, summaryFromThreadId: "nothing" } })).status).toBe(404);
  });

  it("測定を通っても llama-server に断られたら CP-050 にし、最初の指示から新しいスレッドで続けられる", async () => {
    vi.stubEnv("FAKE_LLAMA_MODE", "overflow");
    const { presetId, threadId } = await setup();
    const result = await send(threadId, presetId, "最初の指示");
    expect(result.data).toMatchObject({ status: "failed", error: CONTEXT_FULL });
    const created = await worker.api("/threads", { body: { presetId, summaryFromThreadId: threadId } });
    expect(created.status).toBe(201);
    const detail = await worker.api(`/threads/${created.body.id}/messages`);
    expect(detail.body.messages[0]).toMatchObject({ role: "user", content: "最初の指示", pinned: true });
  });

  it("要約するものがないまま 100% を超えたら、要約せず失敗する", async () => {
    script([{ content: "届かない" }]);
    const { presetId, threadId } = await setup();
    const result = await send(threadId, presetId, big("あ", 5000));
    expect(result.data).toMatchObject({ status: "failed", error: CONTEXT_FULL });
    expect(compacted()).toHaveLength(0);
    expect(requests()).toHaveLength(0);
  });

  it("要約の生成が失敗したらターンが failed になり、何も書き換わらない", async () => {
    script([{ content: "返事1" }, { content: "返事2" }, { content: "返事3" }, { content: "返事4" }, { content: "   " }]);
    const { presetId, threadId } = await setup();
    for (let n = 1; n <= 4; n += 1) await send(threadId, presetId, `${n}${big("あ", 699)}`);
    const result = await send(threadId, presetId, `5${big("あ", 699)}`);
    expect(result.data).toMatchObject({ status: "failed", error: "要約が空でした" });
    const detail = await worker.api(`/threads/${threadId}/messages`);
    expect(detail.body.messages.every((m: any) => m.compactedAt === null && m.role !== "summary")).toBe(true);
  });

  it("エージェントはツールを実行するたびに測り直し、要約してもツールの組が揃っている", async () => {
    const ws = realpathSync(scratch.dir);
    const call = (n: number) => ({ toolCalls: [{ id: `call_${n}`, name: "write_file", arguments: { path: `f${n}.txt`, content: `${n}\n` } }], usage: { prompt_tokens: 3500, completion_tokens: 10 } });
    // 4 回ツールを呼ぶ → 5 回目の生成の頭で 80% 超 → 要約 → 最終応答
    script([call(1), call(2), call(3), call(4), { content: SUMMARY }, { content: "できました" }]);
    const { presetId, threadId } = await setup(ws);
    await worker.api(`/threads/${threadId}`, { method: "PATCH", body: { autoApprove: true } });
    expect((await send(threadId, presetId, "ファイルを作って")).data).toMatchObject({ status: "completed" });

    expect(compacted()).toHaveLength(1);
    const final = requests()[5].messages;
    const calls = final.flatMap((m: any) => (m.tool_calls ?? []).map((c: any) => c.id));
    const results = final.filter((m: any) => m.role === "tool").map((m: any) => m.tool_call_id);
    expect(results).toEqual(calls);
    expect(calls).toEqual(["call_2", "call_3", "call_4"]);
    expect(final[2].content).toContain(SUMMARY);
  });
});
