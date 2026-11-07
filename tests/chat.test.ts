import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BusEvent } from "../server/events";
import { SAMPLING, startWorker, type TestWorker, waitForEvent, writeGguf } from "./helpers";

async function setup(worker: TestWorker, thinking = false) {
  const file = path.join(worker.dir, "model.gguf");
  writeGguf(file);
  const model = await worker.api("/models", { body: { path: file, mode: "reference" } });
  expect(model.status).toBe(201);
  const preset = await worker.api("/presets", {
    body: { name: "対話", modelId: model.body.id, sampling: SAMPLING, thinking, contextSize: 8192, systemPrompt: "短く答える" },
  });
  expect(preset.status).toBe(201);
  const thread = await worker.api("/threads", { body: { presetId: preset.body.id } });
  return { presetId: preset.body.id as string, threadId: thread.body.id as string, modelId: model.body.id as string };
}

const finished = (worker: TestWorker, turnId: string) =>
  waitForEvent(worker.context.bus, (e) => e.event === "turn.finished" && (e.data as { turnId: string }).turnId === turnId);

const lastRequest = (worker: TestWorker) => {
  const dir = path.join(worker.dir, "logs");
  const log = readFileSync(path.join(dir, readdirSync(dir)[0]), "utf8");
  return JSON.parse(log.split("\n").filter((line) => line.startsWith("REQUEST ")).at(-1)!.slice("REQUEST ".length));
};

describe("チャット1往復", () => {
  let worker: TestWorker;
  beforeEach(async () => { worker = await startWorker(); });
  afterEach(async () => {
    await worker.close();
    vi.unstubAllEnvs();
  });

  it("送信すると差分が流れ、保存され、題名が付く", async () => {
    const { presetId, threadId } = await setup(worker);
    const sent = await worker.api(`/threads/${threadId}/turns`, { body: { presetId, content: "挨拶して\n2行目" } });
    expect(sent.status).toBe(202);
    const { turnId } = sent.body;

    expect((await finished(worker, turnId)).data).toEqual({ turnId, status: "completed" });

    const events = worker.context.bus.since(0);
    const delta = events.filter((e: BusEvent) => e.event === "turn.delta").map((e) => (e.data as { content: string }).content);
    expect(delta.join("")).toBe("こんにちは");
    const usage = events.filter((e) => e.event === "turn.usage").map((e) => e.data);
    expect(lastRequest(worker).timings_per_token).toBe(true);
    expect(usage[0]).toEqual({ turnId, usedTokens: 11, contextSize: 4096, tokensPerSecond: 30.5 }); // 生成中
    expect(usage.at(-1)).toEqual({ turnId, usedTokens: 13, contextSize: 4096, tokensPerSecond: 30.5 }); // 終わり

    const detail = await worker.api(`/threads/${threadId}/messages`);
    expect(detail.body.messages.map((m: { role: string; content: string }) => [m.role, m.content])).toEqual([
      ["user", "挨拶して\n2行目"],
      ["assistant", "こんにちは"],
    ]);
    expect(detail.body.turns[0]).toMatchObject({ status: "completed", promptTokens: 10, completionTokens: 3 });
    expect((await worker.api(`/threads?q=挨拶`)).body.items[0]).toMatchObject({ id: threadId, title: "挨拶して" });
  });

  it("生成設定・システム・思考 OFF を llama-server へ渡す", async () => {
    const { presetId, threadId } = await setup(worker);
    const { body } = await worker.api(`/threads/${threadId}/turns`, { body: { presetId, content: "hi" } });
    await finished(worker, body.turnId);
    expect(lastRequest(worker)).toMatchObject({
      max_tokens: 8192,
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0, presence_penalty: 1.5, repeat_penalty: 1,
      chat_template_kwargs: { enable_thinking: false },
      messages: [{ role: "system", content: "短く答える" }, { role: "user", content: "hi" }],
    });
    expect(lastRequest(worker).lora).toBeUndefined();
  });

  it("2回目の送信で前の会話を渡す。思考は本文と分けて保存する", async () => {
    const { presetId, threadId } = await setup(worker, true);
    const first = await worker.api(`/threads/${threadId}/turns`, { body: { presetId, content: "1回目" } });
    await finished(worker, first.body.turnId);
    const second = await worker.api(`/threads/${threadId}/turns`, { body: { presetId, content: "2回目" } });
    await finished(worker, second.body.turnId);

    expect(lastRequest(worker).messages.slice(1)).toEqual([
      { role: "user", content: "1回目" },
      { role: "assistant", content: "こんにちは" },
      { role: "user", content: "2回目" },
    ]);
    const detail = await worker.api(`/threads/${threadId}/messages`);
    expect(detail.body.messages[1]).toMatchObject({ content: "こんにちは", reasoning: "考え中" });
  });

  it("生成中に読み直すと、そこまでの本文が返る（D-84）", async () => {
    vi.stubEnv("FAKE_LLAMA_MODE", "slow");
    const { presetId, threadId } = await setup(worker);
    const { body } = await worker.api(`/threads/${threadId}/turns`, { body: { presetId, content: "長く" } });
    await waitForEvent(worker.context.bus, (e) => e.event === "turn.delta");
    const detail = await worker.api(`/threads/${threadId}/messages`);
    expect(detail.body.messages[1].content.length).toBeGreaterThan(0);

    await worker.api(`/turns/${body.turnId}/cancel`, { body: {} });
    await finished(worker, body.turnId);
  });

  it("停止すると途中までの本文を残して cancelled", async () => {
    vi.stubEnv("FAKE_LLAMA_MODE", "slow");
    const { presetId, threadId } = await setup(worker);
    const { body } = await worker.api(`/threads/${threadId}/turns`, { body: { presetId, content: "長く" } });
    await waitForEvent(worker.context.bus, (e) => e.event === "turn.delta");
    expect((await worker.api(`/turns/${body.turnId}/cancel`, { body: {} })).status).toBe(200);

    expect((await finished(worker, body.turnId)).data).toEqual({ turnId: body.turnId, status: "cancelled" });
    const detail = await worker.api(`/threads/${threadId}/messages`);
    expect(detail.body.messages[1].content.length).toBeGreaterThan(0);
    expect(detail.body.messages[1].content.length).toBeLessThan(100);
  });

  it("生成の上限に達したら truncated を知らせる", async () => {
    vi.stubEnv("FAKE_LLAMA_MODE", "length");
    const { presetId, threadId } = await setup(worker);
    const { body } = await worker.api(`/threads/${threadId}/turns`, { body: { presetId, content: "長く" } });
    expect((await finished(worker, body.turnId)).data).toEqual({ turnId: body.turnId, status: "completed", truncated: true });
  });

  const scriptThoughts = (worker: TestWorker, reasoning: string[]) => {
    const file = path.join(worker.dir, "script.json");
    writeFileSync(file, JSON.stringify([{ reasoning, content: "本文" }]));
    vi.stubEnv("FAKE_LLAMA_SCRIPT", file);
  };

  it("思考が同じ行を繰り返したら止めて looped を知らせる（D-70）", async () => {
    scriptThoughts(worker, Array(6).fill("こんにちは！何かお手伝いできることはありますか？長めの行\n"));
    const { presetId, threadId } = await setup(worker, true);
    const { body } = await worker.api(`/threads/${threadId}/turns`, { body: { presetId, content: "こんちくわ" } });
    expect((await finished(worker, body.turnId)).data).toEqual({ turnId: body.turnId, status: "completed", looped: true });
    const detail = await worker.api(`/threads/${threadId}/messages`);
    expect(detail.body.messages[1].content).toBe("");
    expect(detail.body.messages[1].reasoning.split("\n").filter(Boolean)).toHaveLength(5);
  });

  it("違う思考が続くだけなら止めない", async () => {
    scriptThoughts(worker, Array.from({ length: 6 }, (_, i) => `これは ${i} 番目の、少し長めの思考の行です\n`));
    const { presetId, threadId } = await setup(worker, true);
    const { body } = await worker.api(`/threads/${threadId}/turns`, { body: { presetId, content: "こんちくわ" } });
    expect((await finished(worker, body.turnId)).data).toEqual({ turnId: body.turnId, status: "completed" });
    const detail = await worker.api(`/threads/${threadId}/messages`);
    expect(detail.body.messages[1].content).toBe("本文");
  });

  it("生成中の別の送信は BUSY", async () => {
    vi.stubEnv("FAKE_LLAMA_MODE", "slow");
    const { presetId, threadId } = await setup(worker);
    const { body } = await worker.api(`/threads/${threadId}/turns`, { body: { presetId, content: "長く" } });
    const second = await worker.api(`/threads/${threadId}/turns`, { body: { presetId, content: "割り込み" } });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("BUSY");
    await worker.api(`/turns/${body.turnId}/cancel`, { body: {} });
    await finished(worker, body.turnId);
  });

  it("生成中にエンジンが落ちると failed", async () => {
    vi.stubEnv("FAKE_LLAMA_MODE", "die");
    const { presetId, threadId } = await setup(worker);
    const { body } = await worker.api(`/threads/${threadId}/turns`, { body: { presetId, content: "落ちる" } });
    const event = await finished(worker, body.turnId);
    expect(event.data).toMatchObject({ status: "failed", error: "推論エンジンが停止しました" });
    await waitForEvent(worker.context.bus, (e) => e.event === "engine" && (e.data as { state: string }).state === "failed");
  });

  it("読み込みに失敗したターンは failed で、次の送信を止めない", async () => {
    vi.stubEnv("FAKE_LLAMA_MODE", "fail");
    const { presetId, threadId } = await setup(worker);
    const first = await worker.api(`/threads/${threadId}/turns`, { body: { presetId, content: "失敗" } });
    expect((await finished(worker, first.body.turnId)).data).toMatchObject({ status: "failed" });

    vi.stubEnv("FAKE_LLAMA_MODE", "ok");
    const second = await worker.api(`/threads/${threadId}/turns`, { body: { presetId, content: "成功" } });
    expect(second.status).toBe(202);
    expect((await finished(worker, second.body.turnId)).data).toMatchObject({ status: "completed" });
  });
});

describe("入力の検証", () => {
  let worker: TestWorker;
  beforeEach(async () => { worker = await startWorker(); });
  afterEach(() => worker.close());

  it("空の送信は 400、ないスレッドは 404", async () => {
    const { presetId, threadId } = await setup(worker);
    expect((await worker.api(`/threads/${threadId}/turns`, { body: { presetId, content: "  " } })).status).toBe(400);
    expect((await worker.api(`/threads/none/turns`, { body: { presetId, content: "a" } })).status).toBe(404);
  });

  it("ないファイル・二重登録・LoRA の GGUF を断る", async () => {
    expect((await worker.api("/models", { body: { path: "/no/such.gguf", mode: "reference" } })).status).toBe(400);
    const file = path.join(worker.dir, "m.gguf");
    writeGguf(file);
    await worker.api("/models", { body: { path: file, mode: "reference" } });
    expect((await worker.api("/models", { body: { path: file, mode: "reference" } })).status).toBe(409);

    const adapter = path.join(worker.dir, "a.gguf");
    writeGguf(adapter, { type: "adapter" });
    const res = await worker.api("/models", { body: { path: adapter, mode: "reference" } });
    expect(res.body.error.code).toBe("INVALID_GGUF");
  });

  it("文脈長がモデルの学習時の値を超えるプリセットは断る", async () => {
    const file = path.join(worker.dir, "m.gguf");
    writeGguf(file, { contextLength: 4096 });
    const model = await worker.api("/models", { body: { path: file, mode: "reference" } });
    const res = await worker.api("/presets", {
      body: { name: "x", modelId: model.body.id, sampling: SAMPLING, thinking: false, contextSize: 8192 },
    });
    expect(res.status).toBe(400);
  });
});

describe("同時に2本まで（D-60 改訂）", () => {
  let worker: TestWorker;
  beforeEach(async () => { worker = await startWorker(); });
  afterEach(async () => {
    await worker.close();
    vi.unstubAllEnvs();
  });

  it("別のスレッドなら2本が同時に動き、3本目は BUSY", async () => {
    vi.stubEnv("FAKE_LLAMA_MODE", "slow");
    const { presetId, threadId } = await setup(worker);
    const second = await worker.api("/threads", { body: { presetId } });
    const third = await worker.api("/threads", { body: { presetId } });

    const first = await worker.api(`/threads/${threadId}/turns`, { body: { presetId, content: "一つ目" } });
    const two = await worker.api(`/threads/${second.body.id}/turns`, { body: { presetId, content: "二つ目" } });
    // 一つ目が動いたままで二つ目が通る（直列なら BUSY になる）
    expect(two.status).toBe(202);
    const over = await worker.api(`/threads/${third.body.id}/turns`, { body: { presetId, content: "三つ目" } });
    expect(over).toMatchObject({ status: 409, body: { error: { code: "BUSY" } } });

    await worker.api(`/turns/${first.body.turnId}/cancel`, { body: {} });
    await worker.api(`/turns/${two.body.turnId}/cancel`, { body: {} });
    await finished(worker, first.body.turnId);
    await finished(worker, two.body.turnId);
  });

  it("同じスレッドの二つ目は BUSY（同じワークスペースも同様）", async () => {
    vi.stubEnv("FAKE_LLAMA_MODE", "slow");
    const { presetId, threadId } = await setup(worker);
    const first = await worker.api(`/threads/${threadId}/turns`, { body: { presetId, content: "一つ目" } });
    const again = await worker.api(`/threads/${threadId}/turns`, { body: { presetId, content: "二つ目" } });
    expect(again.body.error.code).toBe("BUSY");
    await worker.api(`/turns/${first.body.turnId}/cancel`, { body: {} });
    await finished(worker, first.body.turnId);
  });

  it("読み込みの違う（文脈長が違う）プリセットは、動いている間は BUSY で、読み直さない", async () => {
    vi.stubEnv("FAKE_LLAMA_MODE", "slow");
    const { presetId, threadId, modelId } = await setup(worker);
    const other = await worker.api("/presets", {
      body: { name: "別の文脈", modelId, sampling: SAMPLING, thinking: false, contextSize: 4096 },
    });
    const thread = await worker.api("/threads", { body: { presetId: other.body.id } });
    const first = await worker.api(`/threads/${threadId}/turns`, { body: { presetId, content: "一つ目" } });
    const mismatch = await worker.api(`/threads/${thread.body.id}/turns`, { body: { presetId: other.body.id, content: "別" } });
    expect(mismatch).toMatchObject({ status: 409, body: { error: { code: "BUSY", message: "別のモデル・文脈長の生成が動いています" } } });
    await worker.api(`/turns/${first.body.turnId}/cancel`, { body: {} });
    await finished(worker, first.body.turnId);
  });
});
