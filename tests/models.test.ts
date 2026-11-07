import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SAMPLING, startWorker, type TestWorker, writeGguf } from "./helpers";

describe("モデル（API-050〜052）", () => {
  let worker: TestWorker;
  beforeEach(async () => {
    worker = await startWorker(null);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await worker.close();
  });

  const register = (file: string, mode: "reference" | "copy" = "reference") =>
    worker.api("/models", { body: { path: file, mode } });

  it("MTP（先読みの補助部分）だけの GGUF は登録しない", async () => {
    const file = path.join(worker.dir, "mtp-a.gguf");
    writeGguf(file, { nextn: 1, tensors: ["blk.31.attn_q.weight"] });
    const res = await register(file);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/MTP/);
  });

  it("一覧は行ごとに存在を確かめ、ないファイルに missing を付ける", async () => {
    const file = path.join(worker.dir, "a.gguf");
    writeGguf(file);
    expect((await register(file)).status).toBe(201);

    let list = await worker.api("/models");
    expect(list.body.items[0]).toMatchObject({ missing: false, source: "local_ref", sizeBytes: expect.any(Number) });
    expect(list.body.adapters).toEqual([]);

    unlinkSync(file);
    list = await worker.api("/models");
    expect(list.body.items[0].missing).toBe(true);
  });

  it("copy は既定の置き場（<dataDir>/models）へコピーして local_copy で登録する", async () => {
    const file = path.join(worker.dir, "src.gguf");
    writeGguf(file);
    const res = await register(file, "copy");
    expect(res.status).toBe(201);
    expect(res.body.source).toBe("local_copy");
    expect(res.body.path).toBe(path.join(worker.dir, "models", "src.gguf"));
    expect(existsSync(res.body.path)).toBe(true);
  });

  it("copy は設定 modelsDir の場所へコピーする", async () => {
    const other = path.join(worker.dir, "elsewhere");
    worker.context.db.prepare("INSERT INTO settings (key, value) VALUES ('modelsDir', ?)").run(JSON.stringify(other));
    const file = path.join(worker.dir, "src.gguf");
    writeGguf(file);
    const res = await register(file, "copy");
    expect(res.body.path).toBe(path.join(other, "src.gguf"));
    expect(existsSync(res.body.path)).toBe(true);
  });

  it("copy は空きが 容量＋2GB に足りなければ 507 で、コピーしない", async () => {
    const file = path.join(worker.dir, "src.gguf");
    writeGguf(file);
    vi.spyOn(worker.context.store.models, "freeBytes").mockReturnValue(0);
    const res = await register(file, "copy");
    expect(res.status).toBe(507);
    expect(res.body.error.code).toBe("INSUFFICIENT_STORAGE");
    expect(existsSync(path.join(worker.dir, "models", "src.gguf"))).toBe(false);
    expect(worker.context.store.models.list()).toHaveLength(0);
  });

  it("copy は同名のファイルを上書きせず 409", async () => {
    const file = path.join(worker.dir, "src.gguf");
    writeGguf(file);
    mkdirSync(path.join(worker.dir, "models"), { recursive: true });
    writeFileSync(path.join(worker.dir, "models", "src.gguf"), "keep");
    const res = await register(file, "copy");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
  });

  it("参照のファイルは deleteFile=true でも消さない", async () => {
    const file = path.join(worker.dir, "ref.gguf");
    writeGguf(file);
    const { body } = await register(file);
    const res = await worker.api(`/models/${body.id}?deleteFile=true`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
    expect(existsSync(file)).toBe(true);
    expect(worker.context.store.models.get(body.id)).toBeNull();
  });

  it("コピーしたファイルは deleteFile=true のときだけ消す", async () => {
    const file = path.join(worker.dir, "src.gguf");
    writeGguf(file);
    const first = (await register(file, "copy")).body;
    await worker.api(`/models/${first.id}`, { method: "DELETE" });
    expect(existsSync(first.path)).toBe(true);

    const otherFile = path.join(worker.dir, "src2.gguf");
    writeGguf(otherFile);
    const second = await register(otherFile, "copy");
    expect(second.status).toBe(201);
    await worker.api(`/models/${second.body.id}?deleteFile=true`, { method: "DELETE" });
    expect(existsSync(second.body.path)).toBe(false);
  });

  it("プリセットで使用中のモデルは 409 で、プリセット名を details に返す", async () => {
    const file = path.join(worker.dir, "m.gguf");
    writeGguf(file);
    const model = (await register(file)).body;
    await worker.api("/presets", {
      body: { name: "対話", modelId: model.id, sampling: SAMPLING, thinking: false, contextSize: 4096 },
    });
    const res = await worker.api(`/models/${model.id}?deleteFile=true`, { method: "DELETE" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
    expect(res.body.error.message).toContain("対話");
    expect(res.body.error.details).toEqual([{ name: "対話" }]);
    expect(worker.context.store.models.get(model.id)).not.toBeNull();
  });

  it("DL した分割モデルは deleteFile=true で全部の部品を消す", async () => {
    const parts = [1, 2, 3].map((n) => path.join(worker.dir, `m-0000${n}-of-00003.gguf`));
    const other = path.join(worker.dir, "n-00001-of-00003.gguf");
    for (const file of [...parts, other]) writeFileSync(file, "x");
    const model = worker.context.store.models.create({
      name: "分割", path: parts[0], source: "hf", architecture: "testarch", quantization: null, sizeBytes: 3, trainContext: null,
    });
    expect((await worker.api(`/models/${model.id}?deleteFile=true`, { method: "DELETE" })).status).toBe(204);
    for (const file of parts) expect(existsSync(file)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  it("ないモデルの削除は 404", async () => {
    expect((await worker.api("/models/none", { method: "DELETE" })).status).toBe(404);
  });
});
