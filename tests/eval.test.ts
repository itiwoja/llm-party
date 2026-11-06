import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EvalService } from "../server/eval/service";
import type { BusEvent } from "../server/events";
import { SAMPLING, startWorker, tempDir, type TestWorker, waitForEvent, writeGguf } from "./helpers";

const data = (event: BusEvent) => event.data as Record<string, any>;

const chat = (name: string, grader: object, extra: object = {}) => ({ name, kind: "chat", input: `入力:${name}`, grader, tags: [], ...extra });
const contains = (expected: string) => ({ type: "match", mode: "contains", expected });

function requests(worker: TestWorker): any[] {
  const dir = path.join(worker.dir, "logs");
  const log = readFileSync(path.join(dir, readdirSync(dir)[0]), "utf8");
  return log.split("\n").filter((line) => line.startsWith("REQUEST ")).map((line) => JSON.parse(line.slice("REQUEST ".length)));
}

describe("評価の実行（fake-llama）", () => {
  let worker: TestWorker;
  let scratch: ReturnType<typeof tempDir>;
  let fixtures: string;
  let presetA: string;
  let presetB: string;

  beforeEach(async () => {
    worker = await startWorker();
    scratch = tempDir();
    fixtures = path.join(scratch.dir, "fixtures");
    mkdirSync(path.join(fixtures, "fizz"), { recursive: true });
    writeFileSync(path.join(fixtures, "fizz", "seed.txt"), "種\n");
    const file = path.join(worker.dir, "model.gguf");
    writeGguf(file);
    const model = await worker.api("/models", { body: { path: file, mode: "reference" } });
    const preset = (name: string, extra: object = {}) =>
      worker.api("/presets", { body: { name, modelId: model.body.id, sampling: SAMPLING, thinking: false, contextSize: 4096, systemPrompt: "短く答える", ...extra } });
    presetA = (await preset("A")).body.id;
    presetB = (await preset("B", { contextSize: 8192 })).body.id;
  });
  afterEach(async () => {
    await worker.close();
    scratch.remove();
    vi.unstubAllEnvs();
  });

  const script = (steps: object[]) => {
    const file = path.join(scratch.dir, "script.json");
    writeFileSync(file, JSON.stringify(steps));
    vi.stubEnv("FAKE_LLAMA_SCRIPT", file);
  };

  async function makeSet(cases: object[], name = "セット", fixturesDir: string | null = fixtures) {
    const created = await worker.api("/eval-sets", { body: { name } });
    expect(created.status).toBe(201);
    const saved = await worker.api(`/eval-sets/${created.body.id}`, { method: "PUT", body: { name, fixturesDir, cases } });
    expect(saved.status).toBe(200);
    return saved.body as { id: string; cases: { id: string; name: string }[] };
  }

  async function start(evalSetId: string, presetIds: string[] = [presetA], tags?: string[]) {
    const res = await worker.api("/eval-runs", { body: { evalSetId, presetIds, ...(tags ? { tags } : {}) } });
    expect(res.status).toBe(202);
    return res.body.runIds as string[];
  }

  const finished = (runId: string) => waitForEvent(worker.context.bus, (e) => e.event === "eval.finished" && data(e).runId === runId, 15_000);
  const detail = async (runId: string) => (await worker.api(`/eval-runs/${runId}`)).body as { run: Record<string, any>; results: Record<string, any>[] };

  it("chat の3種の採点が流れ、進捗と完了が通知され、正解率が出る", async () => {
    const set = await makeSet([
      chat("含む", contains("にちは")),
      chat("不一致", { type: "match", mode: "exact", expected: "さようなら" }),
      chat("正規表現", { type: "match", mode: "regex", expected: "^こん.*は$" }),
      chat("壊れた式", { type: "match", mode: "regex", expected: "(" }),
      chat("人手", { type: "manual", scale: "pass_fail" }),
    ]);
    const [runId] = await start(set.id);
    expect((await detail(runId)).run.status).toMatch(/queued|running/);
    expect((await finished(runId)).data).toEqual({ runId, status: "completed", passRate: 0.5 });

    const { run, results } = await detail(runId);
    expect(results.map((r) => [r.caseName, r.status])).toEqual([
      ["含む", "passed"], ["不一致", "failed"], ["正規表現", "passed"], ["壊れた式", "error"], ["人手", "needs_review"],
    ]);
    expect(results[0]).toMatchObject({ answer: "こんにちは", promptTokens: 10, completionTokens: 3, tokensPerSec: 30.5 });
    expect(results[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(results[0].transcript.messages).toEqual([{ role: "user", content: "入力:含む" }, { role: "assistant", content: "こんにちは" }]);
    expect(results[3].transcript.error).toContain("正規表現");
    expect(run).toMatchObject({ status: "completed", passRate: 0.5, avgTokensPerSec: 30.5, total: 5, done: 5, passed: 2, needsReview: 1 });
    expect(run.snapshot).toMatchObject({ name: "A", systemPrompt: "短く答える", contextSize: 4096 });

    const progress = worker.context.bus.since(0).filter((e) => e.event === "eval.progress").map(data);
    expect(progress.at(-1)).toEqual({ runId, done: 5, total: 5, passed: 2, currentCase: "人手" });
    expect(progress[0]).toMatchObject({ done: 0, total: 5, currentCase: "含む" });
    // chat のケースはツールなしで、システムプロンプトとケースの入力だけ
    const first = requests(worker)[0];
    expect(first.tools).toBeUndefined();
    expect(first.messages).toEqual([{ role: "system", content: "短く答える" }, { role: "user", content: "入力:含む" }]);
    expect(first).toMatchObject({ max_tokens: 8192, temperature: 0.7, chat_template_kwargs: { enable_thinking: false } });
    // 実行が終わったら別プリセットの送信を断る状態は戻る
    expect(worker.context.slot.evalPresetId).toBeNull();
  });

  it("agent のケースは fixture のコピーで動き、test の採点がフォルダの状態を見る。ランの削除でフォルダが消える", async () => {
    script([{ toolCalls: [{ id: "c1", name: "write_file", arguments: { path: "hello.txt", content: "やあ\n" } }] }, { content: "書きました" }]);
    const set = await makeSet([
      { name: "../fizz/案", kind: "agent", input: "hello.txt を作って", fixture: "fizz", grader: { type: "test", command: "test -f hello.txt && test -f seed.txt" } },
    ]);
    const [runId] = await start(set.id);
    await finished(runId);

    const { results } = await detail(runId);
    expect(results[0]).toMatchObject({ status: "passed", answer: "書きました", testOutput: "" });
    expect(results[0].transcript.toolCalls).toMatchObject([{ tool: "write_file", status: "succeeded" }]);
    // 本物の fixture は汚れず、コピー先は eval-workspaces の下
    expect(existsSync(path.join(fixtures, "fizz", "hello.txt"))).toBe(false);
    const root = path.join(worker.dir, "eval-workspaces", runId);
    const [folder] = readdirSync(root);
    expect(folder).not.toContain("/");
    expect(folder).not.toContain("..");
    expect(readFileSync(path.join(root, folder, "hello.txt"), "utf8")).toBe("やあ\n");
    // ツール付きで、作業フォルダの説明が system に入る
    const first = requests(worker)[0];
    expect(first.tools).toHaveLength(6);
    expect(first.messages[0].content).toContain("短く答える");
    expect(first.messages[0].content).toContain(path.join(root, folder));

    expect((await worker.api(`/eval-runs/${runId}`, { method: "DELETE" })).status).toBe(204);
    expect(existsSync(root)).toBe(false);
    expect((await worker.api(`/eval-runs/${runId}`)).status).toBe(404);
  });

  it("test が失敗したら failed で出力を残す", async () => {
    script([{ content: "何もしない" }]);
    const set = await makeSet([
      { name: "直す", kind: "agent", input: "直して", fixture: "fizz", grader: { type: "test", command: "echo 失敗した; exit 3" } },
    ]);
    const [runId] = await start(set.id);
    await finished(runId);
    expect((await detail(runId)).results[0]).toMatchObject({ status: "failed", testOutput: "失敗した\n" });
  });

  it("複数のプリセットは順番に流れる（それぞれのモデル設定で）", async () => {
    const set = await makeSet([chat("一", contains("こん")), chat("二", contains("こん"))]);
    const runIds = await start(set.id, [presetA, presetB]);
    expect(runIds).toHaveLength(2);
    const order: string[] = [];
    const unsubscribe = worker.context.bus.subscribe((e) => {
      if (e.event === "eval.progress" && data(e).done === 0) order.push(`${data(e).runId}:${data(e).currentCase}`);
    });
    await finished(runIds[1]);
    unsubscribe();
    const events = worker.context.bus.since(0).filter((e) => e.event === "eval.finished").map((e) => data(e).runId);
    expect(events).toEqual(runIds);
    const [a, b] = await Promise.all(runIds.map(detail));
    expect(a.run).toMatchObject({ presetName: "A", status: "completed", passRate: 1 });
    expect(b.run).toMatchObject({ presetName: "B", status: "completed", passRate: 1 });
    expect(a.run.finishedAt <= b.run.startedAt).toBe(true);
  });

  it("中止すると実行中のケースも残りも skipped で、ランは cancelled", async () => {
    vi.stubEnv("FAKE_LLAMA_MODE", "slow");
    const set = await makeSet([chat("一", contains("あ")), chat("二", contains("あ"))]);
    const [runId] = await start(set.id);
    await waitForEvent(worker.context.bus, (e) => e.event === "eval.progress" && data(e).currentCase === "一");
    await waitForEvent(worker.context.bus, (e) => e.event === "engine" && data(e).state === "ready");
    const res = await worker.api(`/eval-runs/${runId}/cancel`, { body: {} });
    expect(res).toMatchObject({ status: 200, body: { status: "cancelled" } });
    expect((await finished(runId)).data).toMatchObject({ status: "cancelled" });
    expect((await detail(runId)).results.map((r) => r.status)).toEqual(["skipped", "skipped"]);
    expect(worker.context.slot.evalPresetId).toBeNull();
    expect((await worker.api(`/eval-runs/${runId}/cancel`, { body: {} })).status).toBe(409);
  });

  it("待ちのランを中止すると流れずに cancelled", async () => {
    const set = await makeSet([chat("一", contains("こん"))]);
    const hold = await worker.context.slot.acquire(new AbortController().signal, "test");
    const [runId] = await start(set.id);
    expect((await worker.api(`/eval-runs/${runId}/cancel`, { body: {} })).body.status).toBe("cancelled");
    hold();
    expect((await detail(runId)).results[0].status).toBe("skipped");
    expect(worker.context.engine.state).toBe("stopped");
  });

  it("300 秒（ここでは縮めた値）を超えたケースは timed_out で、次のケースへ進む", async () => {
    vi.stubEnv("FAKE_LLAMA_MODE", "slow");
    worker.context.evals.caseTimeoutMs = 400;
    const set = await makeSet([chat("一", contains("あ")), chat("二", contains("あ"))]);
    const [runId] = await start(set.id);
    expect((await finished(runId)).data).toEqual({ runId, status: "completed", passRate: 0 });
    const { results } = await detail(runId);
    expect(results.map((r) => r.status)).toEqual(["timed_out", "timed_out"]);
    // 途中までの本文は残る
    expect(results[0].answer.length).toBeGreaterThan(0);
    expect(results[0].answer.length).toBeLessThan(100);
  });

  it("test 採点の実行も、ケースの残り時間の中で止まる", async () => {
    script([{ content: "完了" }]);
    worker.context.evals.caseTimeoutMs = 600;
    const set = await makeSet([{ name: "遅い", kind: "agent", input: "やって", fixture: "fizz", grader: { type: "test", command: "sleep 30" } }]);
    const began = Date.now();
    const [runId] = await start(set.id);
    await finished(runId);
    expect(Date.now() - began).toBeLessThan(5000);
    expect((await detail(runId)).results[0].status).toBe("timed_out");
  });

  it("エンジンが落ちたら1回だけ読み込み直してそのケースからやり直す", async () => {
    vi.stubEnv("FAKE_LLAMA_MODE", "die");
    let starts = 0;
    worker.context.bus.subscribe((e) => {
      // 2回目の起動からは落ちない
      if (e.event === "engine" && data(e).state === "starting" && ++starts === 2) vi.stubEnv("FAKE_LLAMA_MODE", "ok");
    });
    const set = await makeSet([chat("一", contains("こんにちは")), chat("二", contains("こんにちは"))]);
    const [runId] = await start(set.id);
    expect((await finished(runId)).data).toEqual({ runId, status: "completed", passRate: 1 });
    expect((await detail(runId)).results.map((r) => r.status)).toEqual(["passed", "passed"]);
    expect(starts).toBe(2);
  });

  it("やり直しでも落ちたらそのケースは failed、ランも failed で残りは skipped", async () => {
    vi.stubEnv("FAKE_LLAMA_MODE", "die");
    const set = await makeSet([chat("一", contains("こん")), chat("二", contains("こん"))]);
    const [runId] = await start(set.id);
    expect((await finished(runId)).data).toMatchObject({ runId, status: "failed" });
    const { run, results } = await detail(runId);
    expect(run.status).toBe("failed");
    expect(results.map((r) => r.status)).toEqual(["failed", "skipped"]);
    expect(worker.context.slot.evalPresetId).toBeNull();
  });

  it("人手採点で正解率が計算し直される（1to5 は 4 点以上が合格・平均点も出る）", async () => {
    const set = await makeSet([
      chat("一", contains("こんにちは")),
      chat("丁寧", { type: "manual", scale: "1to5", rubric: "敬語" }),
      chat("正誤", { type: "manual", scale: "pass_fail" }),
    ]);
    const [runId] = await start(set.id);
    await finished(runId);
    let { run, results } = await detail(runId);
    expect(run).toMatchObject({ passRate: 1, avgScore: null });
    expect(results.map((r) => r.status)).toEqual(["passed", "needs_review", "needs_review"]);

    const point = async (id: string, body: object) => worker.api(`/eval-results/${id}`, { method: "PATCH", body });
    expect((await point(results[1].id, { score: 4 })).body).toMatchObject({ result: { status: "passed", score: 4 }, run: { passRate: 1, avgScore: 4 } });
    expect((await point(results[2].id, { verdict: "failed" })).body.run).toMatchObject({ passRate: 2 / 3 });
    // 付け直し
    expect((await point(results[1].id, { score: 2 })).body).toMatchObject({ result: { status: "failed", score: 2 }, run: { passRate: 1 / 3, avgScore: 2 } });
    expect((await detail(runId)).run).toMatchObject({ passRate: 1 / 3, avgScore: 2 });

    // 形が合わない採点・範囲外・人手でない結果は断る
    expect((await point(results[1].id, { verdict: "passed" })).status).toBe(400);
    expect((await point(results[2].id, { score: 5 })).status).toBe(400);
    expect((await point(results[1].id, { score: 6 })).status).toBe(400);
    expect((await point(results[1].id, {})).status).toBe(400);
    expect((await point(results[0].id, { verdict: "failed" })).status).toBe(409);
    expect((await point("none", { verdict: "failed" })).status).toBe(404);
  });

  it("比較（悪化が先頭）と推移（プリセット名ごと・タグで絞り込み）", async () => {
    const set = await makeSet([
      chat("挨拶", contains("こんにちは"), { tags: ["日本語"] }),
      chat("別れ", contains("さようなら"), { tags: ["英語"] }),
      chat("計算", contains("こん"), { tags: ["日本語", "英語"] }),
    ]);
    const [first] = await start(set.id, [presetA]);
    await finished(first);
    // 挨拶を変えて悪化させ、別れを変えて改善させる
    const edited = await worker.api(`/eval-sets/${set.id}`, {
      method: "PUT",
      body: {
        name: "セット", fixturesDir: fixtures,
        cases: [
          { id: set.cases[0].id, ...chat("挨拶", contains("さようなら"), { tags: ["日本語"] }) },
          { id: set.cases[1].id, ...chat("別れ", contains("こんにちは"), { tags: ["英語"] }) },
          chat("計算", contains("こん"), { tags: ["日本語", "英語"] }),
        ],
      },
    });
    expect(edited.body.cases.map((c: any) => c.id)).toEqual(set.cases.map((c) => c.id));
    const [second] = await start(set.id, [presetB]);
    await finished(second);

    const compared = await worker.api(`/eval-sets/${set.id}/trend?compare=${first},${second}`);
    expect(compared.status).toBe(200);
    expect(compared.body.cases.map((c: any) => [c.caseName, c.change])).toEqual([["挨拶", "regressed"], ["別れ", "improved"], ["計算", "same"]]);
    expect(compared.body.cases[0].a).toMatchObject({ status: "passed", answer: "こんにちは" });
    expect(compared.body.cases[0].b.status).toBe("failed");
    // タグで絞るとそのタグのケースだけ
    const tagged = await worker.api(`/eval-sets/${set.id}/trend?compare=${first},${second}&tags=英語`);
    expect(tagged.body.cases.map((c: any) => c.caseName)).toEqual(["別れ", "計算"]);

    const trend = await worker.api(`/eval-sets/${set.id}/trend`);
    expect(trend.body.series.map((s: any) => [s.presetName, s.points.map((p: any) => p.passRate)])).toEqual([["A", [2 / 3]], ["B", [2 / 3]]]);
    const byTag = await worker.api(`/eval-sets/${set.id}/trend?tags=${encodeURIComponent("日本語")}`);
    expect(byTag.body.series.map((s: any) => [s.presetName, s.points.map((p: any) => p.passRate)])).toEqual([["A", [1]], ["B", [0.5]]]);

    // 別の評価セットのランは比べられない。2つ以外・存在しないランも
    const other = await makeSet([chat("他", contains("こん"))], "別セット");
    const [third] = await start(other.id);
    await finished(third);
    expect((await worker.api(`/eval-sets/${set.id}/trend?compare=${first},${third}`)).status).toBe(400);
    expect((await worker.api(`/eval-sets/${set.id}/trend?compare=${first}`)).status).toBe(400);
    expect((await worker.api(`/eval-sets/${set.id}/trend?compare=${first},none`)).status).toBe(404);
    expect((await worker.api("/eval-sets/none/trend")).status).toBe(404);

    // 一覧
    const runs = await worker.api(`/eval-runs?evalSetId=${set.id}`);
    expect(runs.body.items.map((r: any) => [r.presetName, r.passRate])).toEqual([["B", 2 / 3], ["A", 2 / 3]]);
    expect(runs.body.items[0]).toHaveProperty("totalDurationMs");
    const sets = await worker.api("/eval-sets");
    expect(sets.body.items.find((s: any) => s.id === set.id)).toMatchObject({ caseCount: 3, latestRunId: second, latestPassRate: 2 / 3 });
  });

  it("実行中は別プリセットの送信が BUSY で、同じプリセットはケースの合間に通る", async () => {
    const set = await makeSet([chat("一", contains("こん")), chat("二", contains("こん"))]);
    const thread = await worker.api("/threads", { body: { presetId: presetA } });
    const hold = await worker.context.slot.acquire(new AbortController().signal, "test");
    const [runId] = await start(set.id, [presetA]);
    expect(worker.context.slot.evalPresetId).toBe(presetA);

    const other = await worker.api(`/threads/${thread.body.id}/turns`, { body: { presetId: presetB, content: "割り込み" } });
    expect(other).toMatchObject({ status: 409, body: { error: { code: "BUSY", message: "評価の実行中です" } } });
    const same = await worker.api(`/threads/${thread.body.id}/turns`, { body: { presetId: presetA, content: "会話" } });
    expect(same.status).toBe(202);

    hold();
    await finished(runId);
    await waitForEvent(worker.context.bus, (e) => e.event === "turn.finished" && data(e).turnId === same.body.turnId);
    const users = requests(worker).map((r) => r.messages.at(-1).content);
    // 先に待っていたケース一 → 会話 → ケース二 の順
    expect(users).toEqual(["入力:一", "会話", "入力:二"]);
    expect((await detail(runId)).results.map((r) => r.status)).toEqual(["passed", "passed"]);
  });

  it("プリセットを後で変えても、ランは作った時点の中身で流れる", async () => {
    const set = await makeSet([chat("一", contains("こん"))]);
    const hold = await worker.context.slot.acquire(new AbortController().signal, "test");
    const [runId] = await start(set.id, [presetA]);
    const changed = await worker.api(`/presets/${presetA}`, { method: "PATCH", body: { systemPrompt: "変えた", sampling: { ...SAMPLING, temperature: 0.1 } } });
    expect(changed.status).toBe(200);
    hold();
    await finished(runId);
    expect(requests(worker)[0]).toMatchObject({ temperature: 0.7, messages: [{ role: "system", content: "短く答える" }, expect.anything()] });
    expect((await detail(runId)).run.snapshot).toMatchObject({ systemPrompt: "短く答える", sampling: SAMPLING });

    // プリセットを消してもランは残り、プリセット名で推移に出る
    await worker.api(`/presets/${presetA}`, { method: "DELETE" });
    expect((await detail(runId)).run).toMatchObject({ presetId: null, presetName: "A" });
  });

  it("作成時に弾くもの：ケース 0 件・タグで 0 件・fixture なし・プリセットなし", async () => {
    const empty = await makeSet([], "空");
    expect((await worker.api("/eval-runs", { body: { evalSetId: empty.id, presetIds: [presetA] } })).status).toBe(400);

    const set = await makeSet([chat("一", contains("こん"), { tags: ["a"] }), { name: "直す", kind: "agent", input: "x", fixture: "fizz", grader: { type: "manual", scale: "pass_fail" }, tags: ["b"] }]);
    expect((await worker.api("/eval-runs", { body: { evalSetId: set.id, presetIds: [presetA], tags: ["none"] } })).status).toBe(400);
    expect((await worker.api("/eval-runs", { body: { evalSetId: set.id, presetIds: ["none"] } })).status).toBe(404);
    expect((await worker.api("/eval-runs", { body: { evalSetId: "none", presetIds: [presetA] } })).status).toBe(404);
    expect((await worker.api("/eval-runs", { body: { evalSetId: set.id, presetIds: [] } })).status).toBe(400);
    expect((await worker.api("/eval-runs", { body: { evalSetId: set.id, presetIds: [presetA], tags: ["a"] } })).status).toBe(202);

    // fixturesDir がない・fixture がない・fixturesDir の外を指すリンク
    const noDir = await makeSet([{ name: "直す", kind: "agent", input: "x", fixture: "fizz", grader: { type: "manual", scale: "pass_fail" } }], "dirなし", null);
    expect((await worker.api("/eval-runs", { body: { evalSetId: noDir.id, presetIds: [presetA] } })).status).toBe(400);
    const missing = await makeSet([{ name: "直す", kind: "agent", input: "x", fixture: "nothing", grader: { type: "manual", scale: "pass_fail" } }], "fixtureなし");
    expect((await worker.api("/eval-runs", { body: { evalSetId: missing.id, presetIds: [presetA] } })).status).toBe(400);
    symlinkSync(scratch.dir, path.join(fixtures, "escape"));
    const escape = await makeSet([{ name: "直す", kind: "agent", input: "x", fixture: "escape", grader: { type: "manual", scale: "pass_fail" } }], "外");
    const denied = await worker.api("/eval-runs", { body: { evalSetId: escape.id, presetIds: [presetA] } });
    expect(denied.status).toBe(400);
    expect(denied.body.error.message).toContain("外");
    // 保存の時点で agent の fixture 必須・.. は断る
    const bad = await worker.api(`/eval-sets/${set.id}`, { method: "PUT", body: { name: "セット", cases: [{ name: "x", kind: "agent", input: "x", grader: { type: "manual", scale: "pass_fail" } }] } });
    expect(bad.status).toBe(400);
  });

  it("評価セットの保存：ケース名の重複は 400、セット名の重複は 409、削除でランも使い捨てフォルダも消える", async () => {
    expect((await worker.api("/eval-sets", { body: { name: "" } })).status).toBe(400);
    const set = await makeSet([chat("一", contains("こん"))]);
    expect((await worker.api("/eval-sets", { body: { name: "セット" } })).status).toBe(409);
    const dup = await worker.api(`/eval-sets/${set.id}`, { method: "PUT", body: { name: "セット", cases: [chat("同じ", contains("a")), chat("同じ", contains("b"))] } });
    expect(dup.status).toBe(400);
    expect((await worker.api(`/eval-sets/${set.id}`)).body.cases.map((c: any) => c.name)).toEqual(["一"]);

    script([{ content: "完了" }]);
    const agent = await makeSet([{ name: "直す", kind: "agent", input: "x", fixture: "fizz", grader: { type: "manual", scale: "pass_fail" } }], "agent");
    const [runId] = await start(agent.id);
    await finished(runId);
    const root = path.join(worker.dir, "eval-workspaces", runId);
    expect(existsSync(root)).toBe(true);
    expect((await worker.api(`/eval-sets/${agent.id}`, { method: "DELETE" })).status).toBe(204);
    expect(existsSync(root)).toBe(false);
    expect((await worker.api(`/eval-runs/${runId}`)).status).toBe(404);
    expect((await worker.api(`/eval-sets/${agent.id}`)).status).toBe(404);
  });

  it("JSONL の取込（行ごとの検証・上書きか飛ばす）と書出", async () => {
    const set = await makeSet([chat("既存", contains("古い"), { tags: ["x"] })]);
    const file = path.join(scratch.dir, "cases.jsonl");
    writeFileSync(file, [
      JSON.stringify(chat("既存", contains("新しい"))),
      JSON.stringify(chat("追加", { type: "manual", scale: "1to5", rubric: "丁寧" }, { tags: ["日本語"] })),
      "壊れた行",
      JSON.stringify({ name: "不足", kind: "chat" }),
    ].join("\n"));

    const skipped = await worker.api(`/eval-sets/${set.id}/import`, { body: { path: file, onDuplicate: "skip" } });
    expect(skipped.body).toMatchObject({ added: 1, skipped: 1 });
    expect(skipped.body.errors.map((e: any) => e.line)).toEqual([3, 4]);
    expect((await worker.api(`/eval-sets/${set.id}`)).body.cases[0].grader.expected).toBe("古い");

    const overwritten = await worker.api(`/eval-sets/${set.id}/import`, { body: { path: file, onDuplicate: "overwrite" } });
    expect(overwritten.body).toMatchObject({ added: 2, skipped: 0 });
    const cases = (await worker.api(`/eval-sets/${set.id}`)).body.cases;
    expect(cases.map((c: any) => [c.name, c.grader.expected ?? c.grader.scale])).toEqual([["既存", "新しい"], ["追加", "1to5"]]);

    const out = path.join(scratch.dir, "out.jsonl");
    writeFileSync(out, "古い中身");
    const exported = await worker.api(`/eval-sets/${set.id}/export`, { body: { path: out } });
    expect(exported.body).toEqual({ count: 2 });
    const lines = readFileSync(out, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((line) => line.name)).toEqual(["既存", "追加"]);

    // パスの検査
    expect((await worker.api(`/eval-sets/${set.id}/import`, { body: { path: scratch.dir, onDuplicate: "skip" } })).status).toBe(400);
    expect((await worker.api(`/eval-sets/${set.id}/import`, { body: { path: path.join(scratch.dir, "none.jsonl"), onDuplicate: "skip" } })).status).toBe(404);
    expect((await worker.api(`/eval-sets/${set.id}/export`, { body: { path: path.join(scratch.dir, "no-dir", "x.jsonl") } })).status).toBe(404);
    expect((await worker.api(`/eval-sets/${set.id}/export`, { body: { path: scratch.dir } })).status).toBe(400);
    expect((await worker.api(`/eval-sets/none/import`, { body: { path: file, onDuplicate: "skip" } })).status).toBe(404);
  });

  it("起動時：動いたまま残ったランは failed、流れていない結果は skipped になる", async () => {
    const set = await makeSet([chat("一", contains("こん")), chat("二", contains("こん"))]);
    const { store, engine, bus, slot, dataDir } = worker.context;
    const snapshot = { presetId: presetA, name: "A", modelId: "m", modelName: "m", modelPath: "/m.gguf", modelSha256: null, adapters: [], sampling: SAMPLING, systemPrompt: null, thinking: false, contextSize: 4096 };
    const runId = store.evals.createRun({ evalSetId: set.id, snapshot, backend: "cpu", tags: null, cases: store.evals.cases(set.id) });
    store.evals.startRun(runId);
    const [first] = store.evals.results(runId);
    store.evals.beginResult(first.id);
    const queued = store.evals.createRun({ evalSetId: set.id, snapshot, backend: "cpu", tags: null, cases: store.evals.cases(set.id) });

    new EvalService({ store, engine, bus, slot, dataDir });
    expect(store.evals.run(runId)).toMatchObject({ status: "failed" });
    expect(store.evals.run(runId)!.finishedAt).not.toBeNull();
    expect(store.evals.run(queued)!.status).toBe("failed");
    expect(store.evals.results(runId).map((r) => r.status)).toEqual(["skipped", "skipped"]);
  });

  it("終了時は実行中のケースを止める", async () => {
    vi.stubEnv("FAKE_LLAMA_MODE", "slow");
    const set = await makeSet([chat("一", contains("あ")), chat("二", contains("あ"))]);
    const [runId, second] = await start(set.id, [presetA, presetB]);
    await waitForEvent(worker.context.bus, (e) => e.event === "engine" && data(e).state === "ready");
    await worker.context.evals.shutdown();
    expect(worker.context.store.evals.run(runId)).toMatchObject({ status: "cancelled" });
    expect(worker.context.store.evals.run(second)).toMatchObject({ status: "cancelled" });
    expect(worker.context.store.evals.results(runId).map((r) => r.status)).toEqual(["skipped", "skipped"]);
  });
});
