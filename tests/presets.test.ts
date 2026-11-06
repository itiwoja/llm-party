import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SAMPLING, startWorker, type TestWorker, writeGguf } from "./helpers";

describe("プリセット（API-060〜063）", () => {
  let worker: TestWorker;
  beforeEach(async () => {
    worker = await startWorker(null);
  });
  afterEach(async () => {
    await worker.close();
  });

  async function model(name: string, contextLength = 65536, architecture = "testarch") {
    const file = path.join(worker.dir, `${name}.gguf`);
    writeGguf(file, { contextLength });
    const res = await worker.api("/models", { body: { path: file, mode: "reference" } });
    if (architecture !== "testarch") {
      // テスト用に別のアーキテクチャのモデルを直接置く
      return worker.context.store.models.create({
        name, path: `/x/${name}.gguf`, source: "local_ref", architecture, quantization: null, sizeBytes: 1, trainContext: contextLength,
      });
    }
    return res.body as { id: string; trainContext: number };
  }

  async function adapter(baseModelId: string, name: string) {
    const file = path.join(worker.dir, `${name}.lora.gguf`);
    writeGguf(file, { type: "adapter" });
    const res = await worker.api("/adapters", { body: { path: file, baseModelId, mode: "reference" } });
    expect(res.status).toBe(201);
    return res.body as { id: string };
  }

  const base = (modelId: string, extra: object = {}) => ({
    name: "対話", modelId, sampling: SAMPLING, thinking: false, contextSize: 4096, ...extra,
  });

  it("作成でプリセットと LoRA の倍率を返し、一覧にも出す", async () => {
    const m = await model("m");
    const a = await adapter(m.id, "a");
    const res = await worker.api("/presets", { body: base(m.id, { adapters: [{ adapterId: a.id, scale: 0.5 }] }) });
    expect(res.status).toBe(201);
    expect(res.body.adapters).toEqual([{ adapterId: a.id, scale: 0.5 }]);
    const list = await worker.api("/presets");
    expect(list.body.items[0].adapters).toEqual([{ adapterId: a.id, scale: 0.5 }]);
  });

  it("同じ名前は 409 で、別の名前を求める", async () => {
    const m = await model("m");
    await worker.api("/presets", { body: base(m.id) });
    const res = await worker.api("/presets", { body: base(m.id) });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
    expect(res.body.error.message).toBe("同じ名前のプリセットあり。別の名前が必要");
  });

  it("文脈長がモデルの学習時の値を超える、または 2048 未満は 400", async () => {
    const m = await model("m", 4096);
    expect((await worker.api("/presets", { body: base(m.id, { contextSize: 8192 }) })).status).toBe(400);
    expect((await worker.api("/presets", { body: base(m.id, { contextSize: 1024 }) })).status).toBe(400);
  });

  it("ベースモデルが違う LoRA と負の倍率は 400", async () => {
    const m1 = await model("m1");
    const m2 = await model("m2");
    const a = await adapter(m1.id, "a");
    const wrong = await worker.api("/presets", { body: base(m2.id, { adapters: [{ adapterId: a.id, scale: 1 }] }) });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.message).toBe("ベースモデルが違う LoRA。別の LoRA を選択");

    const negative = await worker.api("/presets", { body: base(m1.id, { adapters: [{ adapterId: a.id, scale: -1 }] }) });
    expect(negative.status).toBe(400);
  });

  it("同じ LoRA を2回選ぶと 400", async () => {
    const m = await model("m");
    const a = await adapter(m.id, "a");
    const res = await worker.api("/presets", {
      body: base(m.id, { adapters: [{ adapterId: a.id, scale: 1 }, { adapterId: a.id, scale: 0.5 }] }),
    });
    expect(res.status).toBe(400);
  });

  it("編集は値を入れ替え、名前の重複と文脈長超過を同じ規則で断る", async () => {
    const m = await model("m", 4096);
    const a = await adapter(m.id, "a");
    const first = (await worker.api("/presets", { body: base(m.id) })).body;
    await worker.api("/presets", { body: base(m.id, { name: "別" }) });

    const edited = await worker.api(`/presets/${first.id}`, {
      method: "PATCH", body: { thinking: true, adapters: [{ adapterId: a.id, scale: 2 }] },
    });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ thinking: true, adapters: [{ adapterId: a.id, scale: 2 }] });

    expect((await worker.api(`/presets/${first.id}`, { method: "PATCH", body: { name: "別" } })).status).toBe(409);
    expect((await worker.api(`/presets/${first.id}`, { method: "PATCH", body: { contextSize: 9999 } })).status).toBe(400);
    expect((await worker.api(`/presets/${first.id}`, { method: "PATCH", body: { adapters: [] } })).body.adapters).toEqual([]);
    expect((await worker.api("/presets/none", { method: "PATCH", body: { thinking: true } })).status).toBe(404);
  });

  it("編集でモデルを変えると、LoRA のベースモデル一致を改めて確かめる", async () => {
    const m1 = await model("m1");
    const m2 = await model("m2");
    const a = await adapter(m1.id, "a");
    const preset = (await worker.api("/presets", { body: base(m1.id, { adapters: [{ adapterId: a.id, scale: 1 }] }) })).body;
    const res = await worker.api(`/presets/${preset.id}`, { method: "PATCH", body: { modelId: m2.id } });
    expect(res.status).toBe(400);
    expect(worker.context.store.presets.get(preset.id)!.modelId).toBe(m1.id);
  });

  it("削除で LoRA の対応は消え、LoRA 本体と eval_runs の結果は残る", async () => {
    const m = await model("m");
    const a = await adapter(m.id, "a");
    const preset = (await worker.api("/presets", { body: base(m.id, { adapters: [{ adapterId: a.id, scale: 1 }] }) })).body;
    const db = worker.context.db;
    db.prepare("INSERT INTO eval_sets (id, name, created_at, updated_at) VALUES ('set1', 'セット', 'now', 'now')").run();
    const snapshot = JSON.stringify({ sampling: SAMPLING, adapters: [{ path: "x", scale: 1 }] });
    db.prepare(`INSERT INTO eval_runs (id, eval_set_id, preset_id, preset_name, preset_snapshot, backend, status, created_at)
      VALUES ('run1', 'set1', ?, '対話', ?, 'cpu', 'finished', 'now')`).run(preset.id, snapshot);

    const res = await worker.api(`/presets/${preset.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect((await worker.api("/presets")).body.items).toEqual([]);
    expect(db.prepare("SELECT count(*) AS n FROM preset_adapters").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT preset_id, preset_name, preset_snapshot FROM eval_runs WHERE id = 'run1'").get())
      .toEqual({ preset_id: null, preset_name: "対話", preset_snapshot: snapshot });
    expect(worker.context.store.adapters.get(a.id)).not.toBeNull();
    expect((await worker.api(`/presets/${preset.id}`, { method: "DELETE" })).status).toBe(404);
  });
});
