import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localRoutes } from "../server/routes/local";
import { ggufBytes, startFakeHf, type FakeHf } from "./fixtures/fake-hf";
import { FAKE_LLAMA, startWorker, type TestWorker } from "./helpers";

/** 8 バイトの長さ＋JSON ヘッダー。重みは空でよい（登録はヘッダーだけ見る） */
function safetensors(title: string): Buffer {
  const json = Buffer.from(JSON.stringify({ __metadata__: { "modelspec.title": title } }), "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(json.length));
  return Buffer.concat([length, json]);
}

let hf: FakeHf;
let worker: TestWorker;

beforeEach(async () => {
  hf = await startFakeHf({
    "acme/sd-image": {
      files: [
        { path: "anime-xl.safetensors", data: safetensors("Anime XL") },
        { path: "split-00001-of-00002.safetensors", data: safetensors("Split") },
        { path: "split-00002-of-00002.safetensors", data: safetensors("Split") },
        { path: "fake.safetensors", data: Buffer.from("not safetensors at all") },
        { path: "some.gguf", data: ggufBytes() },
      ],
    },
  });
  worker = await startWorker(FAKE_LLAMA, { hfBaseUrl: hf.baseUrl, extraRoutes: localRoutes });
});

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

describe("画像モデルの DL（D-72）", () => {
  it("単一の .safetensors は image として登録され、名前はヘッダーのタイトル", async () => {
    const created = await worker.api("/downloads", { body: { repo: "acme/sd-image", files: ["anime-xl.safetensors"], kind: "image" } });
    expect(created.status).toBe(202);
    await finish(created.body.id, "completed");

    const models = (await worker.api("/models")).body.items;
    expect(models).toEqual([expect.objectContaining({ name: "Anime XL", use: "image", architecture: "safetensors", source: "hf" })]);
    expect(existsSync(models[0].path)).toBe(true);
  });

  it("分割の safetensors は画像モデルにできない（400）", async () => {
    const created = await worker.api("/downloads", { body: { repo: "acme/sd-image", files: ["split-00001-of-00002.safetensors"], kind: "image" } });
    expect(created.status).toBe(400);
  });

  it("GGUF は image として DL できない（400）", async () => {
    const created = await worker.api("/downloads", { body: { repo: "acme/sd-image", files: ["some.gguf"], kind: "image" } });
    expect(created.status).toBe(400);
  });

  it("safetensors でなければ失敗し、.part を残さず、モデルにも登録しない", async () => {
    const created = await worker.api("/downloads", { body: { repo: "acme/sd-image", files: ["fake.safetensors"], kind: "image" } });
    const failed = await finish(created.body.id, "failed");
    expect(failed.error).toContain("safetensors ファイルではありません");
    expect((await worker.api("/models")).body.items).toEqual([]);
    const dir = path.join(worker.dir, "models", "acme", "sd-image");
    expect(existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".part")) : []).toEqual([]);
  });
});
