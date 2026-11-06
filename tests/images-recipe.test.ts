import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MOSS_IMAGE } from "../server/hf/recipes";
import { ggufBytes, startFakeHf, type FakeHf } from "./fixtures/fake-hf";
import { FAKE_LLAMA, startWorker, type TestWorker } from "./helpers";

const repos = (reported?: number) => ({
  "unsloth/MOSS-Image-SFT-GGUF": { files: [{ path: "MOSS-Image-SFT-UD-Q4_K_XL.gguf", data: ggufBytes(), reportedSize: reported }] },
  "unsloth/Qwen3.5-9B-GGUF": { files: [{ path: "Qwen3.5-9B-Q8_0.gguf", data: ggufBytes() }] },
  "unsloth/MOSS-Image-SFT-FP8": {
    files: [
      { path: "vae/diffusion_pytorch_model.safetensors", data: Buffer.from("vae-bytes") },
      { path: "tokenizer/tokenizer.json", data: Buffer.from("{}") },
    ],
  },
});

let hf: FakeHf;
let worker: TestWorker;

const open = async (reported?: number) => {
  hf = await startFakeHf(repos(reported));
  worker = await startWorker(FAKE_LLAMA, { hfBaseUrl: hf.baseUrl });
};

afterEach(async () => {
  await worker.close();
  await hf.close();
});

const until = async <T,>(fn: () => Promise<T | false>, timeoutMs = 5000): Promise<T> => {
  const limit = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > limit) throw new Error("条件が満たされません");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
};

const finish = (id: string, status: string) =>
  until(async () => {
    const item = (await worker.api("/downloads")).body.items.find((row: { id: string }) => row.id === id);
    return item?.status === status ? item : false;
  });

describe("画像モデルのレシピ（API-097・098, D-73）", () => {
  describe("取得できる", () => {
    beforeEach(() => open());

    it("4 部品を取り、parts 付きの画像モデルが1つ登録される", async () => {
      const created = await worker.api("/image-recipes", { body: { recipe: "moss-image" } });
      expect(created.status).toBe(202);
      expect(created.body.download).toMatchObject({ kind: "image-set", status: "queued" });
      await finish(created.body.download.id, "completed");

      const root = path.join(worker.dir, "models");
      const at = (key: string) => {
        const part = MOSS_IMAGE.find((item) => item.key === key)!;
        return path.join(root, part.repo, part.file);
      };
      const models = (await worker.api("/models")).body.items;
      expect(models).toHaveLength(1);
      expect(models[0]).toMatchObject({
        name: "MOSS-Image", use: "image", quantization: null, path: at("diffusion"),
        parts: { diffusion: at("diffusion"), llm: at("llm"), vae: at("vae"), tokenizer: at("tokenizer") },
      });
      for (const part of MOSS_IMAGE) expect(existsSync(at(part.key))).toBe(true);
      const total = [...hf.repos.values()].flatMap((repo) => repo.files).reduce((sum, file) => sum + (file.reportedSize ?? file.data.length), 0);
      expect(models[0].sizeBytes).toBe(total);
    });

    it("登録済みなら CONFLICT（409）", async () => {
      const created = await worker.api("/image-recipes", { body: { recipe: "moss-image" } });
      await finish(created.body.download.id, "completed");
      const again = await worker.api("/image-recipes", { body: { recipe: "moss-image" } });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("CONFLICT");
    });

    it("不明なレシピは 400", async () => {
      expect((await worker.api("/image-recipes", { body: { recipe: "nope" } })).status).toBe(400);
    });

    it("API-098 は部品ごとの installed と合計を返す", async () => {
      const before = (await worker.api("/image-recipes")).body.items;
      expect(before).toHaveLength(1);
      expect(before[0]).toMatchObject({ id: "moss-image", name: "MOSS-Image", installed: false });
      expect(before[0].parts).toHaveLength(4);
      expect(before[0].parts.every((part: { installed: boolean; sizeBytes: number }) => !part.installed && part.sizeBytes > 0)).toBe(true);
      expect(before[0].sizeBytes).toBe(before[0].parts.reduce((sum: number, part: { sizeBytes: number }) => sum + part.sizeBytes, 0));

      const created = await worker.api("/image-recipes", { body: { recipe: "moss-image" } });
      await finish(created.body.download.id, "completed");
      const after = (await worker.api("/image-recipes")).body.items[0];
      expect(after.installed).toBe(true);
      expect(after.parts.every((part: { installed: boolean }) => part.installed)).toBe(true);
    });
  });

  it("空き容量が足りなければ 507 で始めない", async () => {
    await open(10 ** 15);
    const res = await worker.api("/image-recipes", { body: { recipe: "moss-image" } });
    expect(res.status).toBe(507);
    expect(res.body.error.code).toBe("INSUFFICIENT_STORAGE");
    expect((await worker.api("/downloads")).body.items).toEqual([]);
  });
});
