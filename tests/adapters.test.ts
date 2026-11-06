import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SAMPLING, startWorker, type TestWorker, writeGguf } from "./helpers";

describe("LoRA（API-058〜059）", () => {
  let worker: TestWorker;
  beforeEach(async () => {
    worker = await startWorker(null);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await worker.close();
  });

  async function baseModel(name = "base.gguf") {
    const file = path.join(worker.dir, name);
    writeGguf(file);
    const res = await worker.api("/models", { body: { path: file, mode: "reference" } });
    return res.body as { id: string };
  }

  const registerAdapter = (body: object) => worker.api("/adapters", { body });

  it("llama.cpp 形式の LoRA を参照で登録し、一覧の adapters に出す", async () => {
    const model = await baseModel();
    const file = path.join(worker.dir, "lora.gguf");
    writeGguf(file, { type: "adapter" });
    const res = await registerAdapter({ path: file, baseModelId: model.id, mode: "reference" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ baseModelId: model.id, source: "local_ref", name: "Test Model" });

    const list = await worker.api("/models");
    expect(list.body.adapters).toEqual([expect.objectContaining({ id: res.body.id, missing: false })]);
  });

  it("PEFT など GGUF の LoRA でないファイルは INVALID_GGUF で変換を案内する", async () => {
    const model = await baseModel();
    const file = path.join(worker.dir, "peft.gguf");
    writeGguf(file);
    const res = await registerAdapter({ path: file, baseModelId: model.id, mode: "reference" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_GGUF");
    expect(res.body.error.message).toContain("convert_lora_to_gguf.py");
  });

  it("ベースモデルとアーキテクチャが違う LoRA は拒否する", async () => {
    const other = worker.context.store.models.create({
      name: "other", path: "/x/other.gguf", source: "local_ref", architecture: "other",
      quantization: null, sizeBytes: 1, trainContext: null,
    });
    const file = path.join(worker.dir, "lora.gguf");
    writeGguf(file, { type: "adapter" });
    const res = await registerAdapter({ path: file, baseModelId: other.id, mode: "reference" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.message).toContain("ベースモデルが不一致");
  });

  it("ないベースモデルは 404", async () => {
    const file = path.join(worker.dir, "lora.gguf");
    writeGguf(file, { type: "adapter" });
    expect((await registerAdapter({ path: file, baseModelId: "none", mode: "reference" })).status).toBe(404);
  });

  it("copy は置き場へコピーし、容量不足なら 507", async () => {
    const model = await baseModel();
    const file = path.join(worker.dir, "lora.gguf");
    writeGguf(file, { type: "adapter" });
    const res = await registerAdapter({ path: file, baseModelId: model.id, mode: "copy" });
    expect(res.body.source).toBe("local_copy");
    expect(existsSync(res.body.path)).toBe(true);

    vi.spyOn(worker.context.store.models, "freeBytes").mockReturnValue(0);
    const file2 = path.join(worker.dir, "lora2.gguf");
    writeGguf(file2, { type: "adapter" });
    expect((await registerAdapter({ path: file2, baseModelId: model.id, mode: "copy" })).status).toBe(507);
  });

  it("プリセットで使用中の LoRA は 409 で、プリセット名を返す", async () => {
    const model = await baseModel();
    const file = path.join(worker.dir, "lora.gguf");
    writeGguf(file, { type: "adapter" });
    const adapter = (await registerAdapter({ path: file, baseModelId: model.id, mode: "reference" })).body;
    await worker.api("/presets", {
      body: {
        name: "LoRA 入り", modelId: model.id, adapters: [{ adapterId: adapter.id, scale: 1 }],
        sampling: SAMPLING, thinking: false, contextSize: 4096,
      },
    });
    const res = await worker.api(`/adapters/${adapter.id}?deleteFile=true`, { method: "DELETE" });
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual([{ name: "LoRA 入り" }]);
    expect(existsSync(file)).toBe(true);
  });

  it("使っていない LoRA は消せて、参照のファイルは残り、コピーのファイルは deleteFile=true で消える", async () => {
    const model = await baseModel();
    const ref = path.join(worker.dir, "ref.gguf");
    writeGguf(ref, { type: "adapter" });
    const refAdapter = (await registerAdapter({ path: ref, baseModelId: model.id, mode: "reference" })).body;
    expect((await worker.api(`/adapters/${refAdapter.id}?deleteFile=true`, { method: "DELETE" })).status).toBe(204);
    expect(existsSync(ref)).toBe(true);

    const src = path.join(worker.dir, "copy.gguf");
    writeGguf(src, { type: "adapter" });
    const copied = (await registerAdapter({ path: src, baseModelId: model.id, mode: "copy" })).body;
    expect((await worker.api(`/adapters/${copied.id}?deleteFile=true`, { method: "DELETE" })).status).toBe(204);
    expect(existsSync(copied.path)).toBe(false);
  });

  it("ないファイルの LoRA は一覧で missing になる", async () => {
    const model = await baseModel();
    const file = path.join(worker.dir, "lora.gguf");
    writeGguf(file, { type: "adapter" });
    await registerAdapter({ path: file, baseModelId: model.id, mode: "reference" });
    unlinkSync(file);
    const list = await worker.api("/models");
    expect(list.body.adapters[0].missing).toBe(true);
  });
});
