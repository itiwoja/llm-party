import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { thinkingKwargs } from "../server/thinking";
import { thinkingChoice, thinkingLevels, thinkingOptions, thinkingPatch } from "../src/thinking";
import { SAMPLING, startWorker, type TestWorker, waitForEvent, writeGguf } from "./helpers";

const NONE = { supportsThinking: false, supportsEffort: false };
const TOGGLE = { supportsThinking: true, supportsEffort: false };
const LEVELS = { supportsThinking: false, supportsEffort: true };
const BOTH = { supportsThinking: true, supportsEffort: true };

describe("thinkingKwargs", () => {
  it("段階に対応しないモデルへは reasoning_effort を送らない", () => {
    expect(thinkingKwargs(TOGGLE, { thinking: true, effort: "high" })).toEqual({ enable_thinking: true });
    expect(thinkingKwargs(NONE, { thinking: false, effort: "high" })).toEqual({ enable_thinking: false });
  });

  it("段階だけのモデルは思考 OFF でも段階を送る", () => {
    expect(thinkingKwargs(LEVELS, { thinking: false, effort: "low" })).toEqual({ enable_thinking: true, reasoning_effort: "low" });
  });

  it("両方に対応するモデルは、思考 OFF なら段階を送らない", () => {
    expect(thinkingKwargs(BOTH, { thinking: false, effort: "low" })).toEqual({ enable_thinking: false });
    expect(thinkingKwargs(BOTH, { thinking: true, effort: "low" })).toEqual({ enable_thinking: true, reasoning_effort: "low" });
  });
});

describe("思考の選択肢", () => {
  it("入力欄の段階は、思考がオンのときだけ出す。段階だけのモデルは常に出す", () => {
    const values = (model: typeof NONE, thinking: boolean) => thinkingLevels(model, { thinking, effort: "medium" }).map((o) => o.value);
    expect(values(TOGGLE, true)).toEqual([]);
    expect(values(BOTH, false)).toEqual([]);
    expect(values(BOTH, true)).toEqual(["low", "medium", "high"]);
    expect(values(LEVELS, false)).toEqual(["low", "medium", "high"]);
  });

  it("モデルの対応で選択肢が決まる", () => {
    const values = (model?: typeof NONE) => thinkingOptions(model).map((o) => o.value);
    expect(values(undefined)).toEqual([]);
    expect(values(NONE)).toEqual([]);
    expect(values(TOGGLE)).toEqual(["off", "on"]);
    expect(values(LEVELS)).toEqual(["low", "medium", "high"]);
    expect(values(BOTH)).toEqual(["off", "low", "medium", "high"]);
  });

  it("今の値は必ず選択肢の中にある", () => {
    for (const model of [TOGGLE, LEVELS, BOTH]) {
      for (const thinking of [true, false]) {
        const choice = thinkingChoice(model, { thinking, effort: "high" });
        expect(thinkingOptions(model).map((o) => o.value)).toContain(choice);
      }
    }
  });

  it("選んだ値をプリセットの項目に直す", () => {
    expect(thinkingPatch("off")).toEqual({ thinking: false });
    expect(thinkingPatch("on")).toEqual({ thinking: true });
    expect(thinkingPatch("high")).toEqual({ thinking: true, effort: "high" });
  });
});

describe("思考の段階の保存と送信", () => {
  let worker: TestWorker;
  beforeEach(async () => { worker = await startWorker(); });
  afterEach(() => worker.close());

  async function setup(chatTemplate: string) {
    const file = path.join(worker.dir, "model.gguf");
    writeGguf(file, { chatTemplate });
    const model = await worker.api("/models", { body: { path: file, mode: "reference" } });
    const preset = await worker.api("/presets", { body: { name: "p", modelId: model.body.id, sampling: SAMPLING, thinking: true, contextSize: 8192 } });
    return { model: model.body, preset: preset.body };
  }

  it("登録したモデルの対応を返し、プリセットの段階は既定が中で、変更を保存する", async () => {
    const { model, preset } = await setup("{{ reasoning_effort }}");
    expect(model).toMatchObject({ supportsThinking: false, supportsEffort: true });
    expect(preset.effort).toBe("medium");
    const patched = await worker.api(`/presets/${preset.id}`, { method: "PATCH", body: { thinking: true, effort: "high" } });
    expect(patched.body.effort).toBe("high");
    const bad = await worker.api(`/presets/${preset.id}`, { method: "PATCH", body: { effort: "max" } });
    expect(bad.status).toBe(400);
  });

  it("GPU の割合は既定が自動で、0〜100 を保存し、自動へ戻せる（D-77）", async () => {
    const { preset } = await setup("{{ enable_thinking }}");
    expect(preset.gpuRatio).toBeNull();
    const patched = await worker.api(`/presets/${preset.id}`, { method: "PATCH", body: { gpuRatio: 60 } });
    expect(patched.body.gpuRatio).toBe(60);
    const unrelated = await worker.api(`/presets/${preset.id}`, { method: "PATCH", body: { name: "q" } });
    expect(unrelated.body.gpuRatio).toBe(60);
    const auto = await worker.api(`/presets/${preset.id}`, { method: "PATCH", body: { gpuRatio: null } });
    expect(auto.body.gpuRatio).toBeNull();
    expect((await worker.api(`/presets/${preset.id}`, { method: "PATCH", body: { gpuRatio: 101 } })).status).toBe(400);
  });

  it("起動時に、対応を読んでいないモデルをファイルから埋める", async () => {
    const file = path.join(worker.dir, "old.gguf");
    writeGguf(file, { chatTemplate: "{{ enable_thinking }}" });
    const { store, db } = worker.context;
    const stale = store.models.create({ name: "old", path: file, source: "local_ref", architecture: "a", quantization: null, sizeBytes: 1, trainContext: null });
    const missing = store.models.create({ name: "gone", path: path.join(worker.dir, "gone.gguf"), source: "local_ref", architecture: "a", quantization: null, sizeBytes: 1, trainContext: null });
    store.models.fillThinkingSupport();
    expect(store.models.get(stale.id)).toMatchObject({ supportsThinking: true, supportsEffort: false });
    const row = db.prepare("SELECT supports_thinking FROM models WHERE id = ?").get(missing.id) as { supports_thinking: number | null };
    expect(row.supports_thinking).toBeNull();
  });

  it("選んだ段階を llama-server へ渡す", async () => {
    const { preset } = await setup("{{ reasoning_effort }}");
    await worker.api(`/presets/${preset.id}`, { method: "PATCH", body: { effort: "low" } });
    const thread = await worker.api("/threads", { body: { presetId: preset.id } });
    const { body } = await worker.api(`/threads/${thread.body.id}/turns`, { body: { presetId: preset.id, content: "hi" } });
    await waitForEvent(worker.context.bus, (e) => e.event === "turn.finished" && (e.data as { turnId: string }).turnId === body.turnId);
    const dir = path.join(worker.dir, "logs");
    const log = readFileSync(path.join(dir, readdirSync(dir)[0]), "utf8");
    const logged = JSON.parse(log.split("\n").filter((line) => line.startsWith("REQUEST ")).at(-1)!.slice("REQUEST ".length));
    expect(logged.chat_template_kwargs).toEqual({ enable_thinking: true, reasoning_effort: "low" });
  });
});
