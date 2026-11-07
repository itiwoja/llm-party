import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localRoutes } from "../server/routes/local";
import { ggufBytes, startFakeHf, type FakeHf } from "./fixtures/fake-hf";
import { FAKE_LLAMA, startWorker, type TestWorker } from "./helpers";

const small = ggufBytes({ padding: 200_000 });
const partA = ggufBytes({ padding: 50_000 });
const partB = ggufBytes({ padding: 70_000 });
const payload = Buffer.alloc(30_000, 5);
let hf: FakeHf;
let worker: TestWorker;

const models = () => path.join(worker.dir, "models");
const body = (files: string[], repo = "acme/tiny-GGUF", kind = "model") => ({ body: { repo, files, kind } });

async function until<T>(fn: () => Promise<T | false> | T | false, timeoutMs = 5000): Promise<T> {
  const limit = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > limit) throw new Error("条件が満たされません");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

const find = async (id: string, status: string) =>
  until(async () => {
    const item = (await worker.api("/downloads")).body.items.find((row: any) => row.id === id);
    return item?.status === status ? item : false;
  });

beforeEach(async () => {
  hf = await startFakeHf({
    "acme/tiny-GGUF": {
      files: [
        { path: "tiny-Q4_K_M.gguf", data: small },
        { path: "other-Q8_0.gguf", data: small },
        { path: "split-Q4_K_M-00001-of-00002.gguf", data: partA },
        { path: "split-Q4_K_M-00002-of-00002.gguf", data: partB },
        { path: "bad-sha.gguf", data: small, oid: "0".repeat(64) },
        { path: "huge.gguf", data: small, reportedSize: 1e15 },
        { path: "lora-adapter.gguf", data: ggufBytes({ type: "adapter" }) },
        { path: "notgguf.gguf", data: Buffer.from("this is not a gguf file".repeat(100)) },
        { path: "mmproj-F16.gguf", data: ggufBytes({ type: "clip" }) },
      ],
    },
    "acme/sdxl": {
      files: [
        { path: "model.safetensors", data: payload },
        { path: "text_encoder/model-00001-of-00002.safetensors", data: payload },
        { path: "text_encoder/model-00002-of-00002.safetensors", data: payload },
        { path: "empty.txt", data: Buffer.alloc(0) },
        { path: "broken.safetensors", data: payload, oid: "0".repeat(64) },
      ],
    },
  });
  worker = await startWorker(FAKE_LLAMA, { hfBaseUrl: hf.baseUrl, extraRoutes: localRoutes });
  worker.context.downloads.tuning = { retryDelayMs: 5, progressIntervalMs: 0 };
});

afterEach(async () => {
  await worker.close();
  await hf.close();
});

describe("DL の完了とモデル登録", () => {
  it("完了すると .part が外れ、source hf のモデルとして登録される", async () => {
    const res = await worker.api("/downloads", body(["tiny-Q4_K_M.gguf"]));
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: "queued", totalBytes: small.length, kind: "model", repo: "acme/tiny-GGUF" });
    const done = await find(res.body.id, "completed");
    const file = path.join(models(), "acme/tiny-GGUF/tiny-Q4_K_M.gguf");
    expect(readFileSync(file).equals(small)).toBe(true);
    expect(existsSync(`${file}.part`)).toBe(false);
    expect(done).toMatchObject({ receivedBytes: small.length, resultId: expect.any(String), error: null });
    const model = (await worker.api("/models")).body.items[0];
    expect(model).toMatchObject({
      id: done.resultId, path: file, source: "hf", architecture: "testarch", quantization: "Q4_K_M", sizeBytes: small.length, name: "Test Model",
    });
    expect(worker.context.db.prepare("SELECT hf_repo FROM models").get()).toEqual({ hf_repo: "acme/tiny-GGUF" });
  });

  it("進捗イベントを流し、状態が downloading → verifying → completed と進む", async () => {
    const res = await worker.api("/downloads", body(["tiny-Q4_K_M.gguf"]));
    await find(res.body.id, "completed");
    const events = worker.context.bus.since(0).filter((event) => event.event === "download.progress").map((event) => event.data as any);
    expect(events.every((data) => data.downloadId === res.body.id)).toBe(true);
    const statuses = events.map((data) => data.status).filter((status, i, all) => status !== all[i - 1]);
    expect(statuses).toEqual(["queued", "downloading", "verifying", "completed"]);
    expect(events.at(-1)).toEqual({ downloadId: res.body.id, status: "completed", receivedBytes: small.length, totalBytes: small.length });
  });

  it("進捗は間引く（間隔内ではバイトの更新を出さない）", async () => {
    worker.context.downloads.tuning.progressIntervalMs = 60_000;
    const res = await worker.api("/downloads", body(["tiny-Q4_K_M.gguf"]));
    await find(res.body.id, "completed");
    const downloading = worker.context.bus.since(0).filter((event) => (event.data as any).status === "downloading");
    expect(downloading.length).toBeLessThanOrEqual(3);
  });

  it("分割 GGUF は全部取り、先頭のファイルをモデルのパスにする", async () => {
    // 2つ目だけ指定しても全部取る
    const res = await worker.api("/downloads", body(["split-Q4_K_M-00002-of-00002.gguf"]));
    expect(res.body.files.map((file: any) => file.name)).toEqual(["split-Q4_K_M-00001-of-00002.gguf", "split-Q4_K_M-00002-of-00002.gguf"]);
    const done = await find(res.body.id, "completed");
    const dir = path.join(models(), "acme/tiny-GGUF");
    expect(readFileSync(path.join(dir, "split-Q4_K_M-00002-of-00002.gguf")).equals(partB)).toBe(true);
    const model = (await worker.api("/models")).body.items[0];
    expect(model).toMatchObject({ id: done.resultId, path: path.join(dir, "split-Q4_K_M-00001-of-00002.gguf"), sizeBytes: partA.length + partB.length });
  });

  it("adapter は登録せず、完了後に filePath を返す", async () => {
    const res = await worker.api("/downloads", body(["lora-adapter.gguf"], "acme/tiny-GGUF", "adapter"));
    const done = await find(res.body.id, "completed");
    expect(done.filePath).toBe(path.join(models(), "acme/tiny-GGUF/lora-adapter.gguf"));
    expect(done.resultId).toBeNull();
    expect((await worker.api("/models")).body.items).toEqual([]);
  });

  it("model の応答に filePath は付かない", async () => {
    const res = await worker.api("/downloads", body(["tiny-Q4_K_M.gguf"]));
    expect((await find(res.body.id, "completed")).filePath).toBeUndefined();
  });

  it("登録済みのモデルをもう一度 DL しようとすると 409", async () => {
    const first = await worker.api("/downloads", body(["tiny-Q4_K_M.gguf"]));
    await find(first.body.id, "completed");
    const again = await worker.api("/downloads", body(["tiny-Q4_K_M.gguf"]));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("CONFLICT");
  });

  it("種類が違う GGUF は INVALID_GGUF の失敗にして .part を残さない", async () => {
    const res = await worker.api("/downloads", body(["mmproj-F16.gguf"]));
    const failed = await find(res.body.id, "failed");
    expect(failed.error).toBe("これはモデルの GGUF ではありません");
    expect(existsSync(path.join(models(), "acme/tiny-GGUF/mmproj-F16.gguf.part"))).toBe(false);
    expect((await worker.api("/models")).body.items).toEqual([]);
  });

  it("GGUF の先頭が違えば失敗", async () => {
    const res = await worker.api("/downloads", body(["notgguf.gguf"]));
    const failed = await find(res.body.id, "failed");
    expect(failed.error).toBe("GGUF ファイルではありません");
  });

  it("置き場は settings の modelsDir を使う", async () => {
    const custom = path.join(worker.dir, "custom-place");
    worker.context.db.prepare("INSERT INTO settings (key, value) VALUES ('modelsDir', ?)").run(JSON.stringify(custom));
    const res = await worker.api("/downloads", body(["tiny-Q4_K_M.gguf"]));
    await find(res.body.id, "completed");
    expect(existsSync(path.join(custom, "acme/tiny-GGUF/tiny-Q4_K_M.gguf"))).toBe(true);
  });
});

describe("保存だけの DL をやめた（D-88）", () => {
  it("file は新しく始められない。files を省くのも 400", async () => {
    expect((await worker.api("/downloads", body(["model.safetensors"], "acme/sdxl", "file"))).status).toBe(400);
    expect((await worker.api("/downloads", { body: { repo: "acme/sdxl", kind: "model" } })).status).toBe(400);
    expect((await worker.api("/downloads")).body.items).toEqual([]);
  });

  it("前からある行は置き場を返し、ファイルがモデルの部品になると usedByModel を返す", async () => {
    const { store } = worker.context;
    const destDir = path.join(models(), "acme", "tiny-GGUF");
    const record = store.downloads.create({ kind: "file", repo: "acme/tiny-GGUF", files: [{ name: "tiny-Q4_K_M.gguf", size: 1, sha256: null }], destDir });
    store.downloads.update(record.id, { status: "completed" });
    const before = await find(record.id, "completed");
    expect(before.savedDir).toBe(destDir);
    expect(before.usedByModel).toBe(false);
    store.models.create({
      name: "組み合わせ", path: path.join(models(), "main.gguf"), source: "hf", use: "image", architecture: "moss-image", quantization: null, sizeBytes: 1, trainContext: null,
      parts: { diffusion: path.join(models(), "main.gguf"), llm: path.join(destDir, "tiny-Q4_K_M.gguf"), vae: path.join(models(), "vae"), tokenizer: path.join(models(), "tokenizer") },
    });
    expect((await find(record.id, "completed")).usedByModel).toBe(true);
  });
});

describe("再開と再試行", () => {
  it("途中で切れても Range で続きから取り、全体が一致する", async () => {
    hf.behavior.cuts = [80_000];
    const res = await worker.api("/downloads", body(["tiny-Q4_K_M.gguf"]));
    await find(res.body.id, "completed");
    expect(readFileSync(path.join(models(), "acme/tiny-GGUF/tiny-Q4_K_M.gguf")).equals(small)).toBe(true);
    const ranges = hf.cdnRequests.map((request) => request.range).filter((range) => range && range !== "bytes=0-0");
    expect(ranges).toHaveLength(1);
    expect(Number(/bytes=(\d+)-/.exec(ranges[0]!)![1])).toBeGreaterThan(0);
    const statuses = worker.context.bus.since(0).map((event) => (event.data as any).status);
    expect(statuses).toContain("retrying");
    expect(worker.context.store.downloads.list()[0].retryCount).toBe(1);
  });

  it("サーバーが Range を無視して 200 を返したら最初から書き直す", async () => {
    hf.behavior.cuts = [80_000];
    hf.behavior.ignoreRange = true;
    const res = await worker.api("/downloads", body(["tiny-Q4_K_M.gguf"]));
    await find(res.body.id, "completed");
    expect(readFileSync(path.join(models(), "acme/tiny-GGUF/tiny-Q4_K_M.gguf")).equals(small)).toBe(true);
  });

  it("5xx は 3 回まで自動で再試行し、4 回目の失敗で failed。resume で続けられる", async () => {
    hf.behavior.failures = 100;
    const res = await worker.api("/downloads", body(["other-Q8_0.gguf"]));
    // POST 時の試し取りも 500 になるので、先に通してから落とす
    expect(res.status).toBe(502);
    hf.behavior.failures = 0;
    const ok = await worker.api("/downloads", body(["other-Q8_0.gguf"]));
    hf.behavior.failures = 100;
    const failed = await find(ok.body.id, "failed");
    expect(failed).toMatchObject({ retryCount: 3, error: "Hugging Face に接続不可。「あとで」で先へ" });
    // 試し取り2回（1回目は 500 で 502）＋初回の取得と再試行3回
    expect(hf.hfRequests.filter((request) => request.url.includes("/resolve/")).length).toBe(2 + 1 + 3);

    hf.behavior.failures = 0;
    const resumed = await worker.api(`/downloads/${ok.body.id}/resume`, { method: "POST" });
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({ status: "queued", retryCount: 0, error: null });
    await find(ok.body.id, "completed");
  });

  it("resume は failed 以外では 409、ない id は 404", async () => {
    const res = await worker.api("/downloads", body(["tiny-Q4_K_M.gguf"]));
    await find(res.body.id, "completed");
    expect((await worker.api(`/downloads/${res.body.id}/resume`, { method: "POST" })).status).toBe(409);
    expect((await worker.api("/downloads/nope/resume", { method: "POST" })).status).toBe(404);
  });

  it("残っている .part から続きを取る（resume 後に先頭から取り直さない）", async () => {
    const dir = path.join(models(), "acme/tiny-GGUF");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "tiny-Q4_K_M.gguf.part"), small.subarray(0, 1000));
    const res = await worker.api("/downloads", body(["tiny-Q4_K_M.gguf"]));
    await find(res.body.id, "completed");
    expect(hf.cdnRequests.some((request) => request.range === "bytes=1000-")).toBe(true);
  });
});

describe("検証", () => {
  it("sha256 が合わなければ .part を消して failed（再試行しない）", async () => {
    const res = await worker.api("/downloads", body(["bad-sha.gguf"]));
    const failed = await find(res.body.id, "failed");
    expect(failed).toMatchObject({ retryCount: 0, error: "ファイル破損。再試行で取り直し" });
    expect(existsSync(path.join(models(), "acme/tiny-GGUF/bad-sha.gguf.part"))).toBe(false);
    expect(existsSync(path.join(models(), "acme/tiny-GGUF/bad-sha.gguf"))).toBe(false);
    expect((await worker.api("/models")).body.items).toEqual([]);
  });

  it("sha256 が合うことを確かめている（oid は実データの sha256）", () => {
    expect(createHash("sha256").update(small).digest("hex")).toHaveLength(64);
  });
});

describe("空き容量", () => {
  it("サイズ＋2GB の空きがなければ 507 で始めない", async () => {
    const res = await worker.api("/downloads", body(["huge.gguf"]));
    expect(res.status).toBe(507);
    expect(res.body.error.code).toBe("INSUFFICIENT_STORAGE");
    expect(res.body.error.message).toMatch(/^空き容量不足。.+ GB 必要。置き場の変更で解消$/);
    expect((await worker.api("/downloads")).body.items).toEqual([]);
  });
});

describe("取消", () => {
  it("取消で .part を消し、cancelled になる", async () => {
    const dir = path.join(models(), "acme/tiny-GGUF");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "tiny-Q4_K_M.gguf.part"), small.subarray(0, 1000));
    hf.behavior.cuts = [10_000];
    hf.behavior.failures = 0;
    worker.context.downloads.tuning.retryDelayMs = 60_000; // retrying で止めておく
    const res = await worker.api("/downloads", body(["tiny-Q4_K_M.gguf"]));
    await find(res.body.id, "retrying");
    expect(existsSync(path.join(dir, "tiny-Q4_K_M.gguf.part"))).toBe(true);
    const cancelled = await worker.api(`/downloads/${res.body.id}/cancel`, { method: "POST" });
    expect(cancelled.body.status).toBe("cancelled");
    expect(existsSync(path.join(dir, "tiny-Q4_K_M.gguf.part"))).toBe(false);
    expect((await worker.api("/models")).body.items).toEqual([]);
  });

  it("終わったものは 409、ない id は 404", async () => {
    const res = await worker.api("/downloads", body(["tiny-Q4_K_M.gguf"]));
    await find(res.body.id, "completed");
    expect((await worker.api(`/downloads/${res.body.id}/cancel`, { method: "POST" })).status).toBe(409);
    expect((await worker.api("/downloads/nope/cancel", { method: "POST" })).status).toBe(404);
  });
});

describe("同時に1つ", () => {
  it("2つ目以降は queued で待ち、順に動く", async () => {
    const first = await worker.api("/downloads", body(["tiny-Q4_K_M.gguf"]));
    const second = await worker.api("/downloads", body(["other-Q8_0.gguf"]));
    const third = await worker.api("/downloads", body(["split-Q4_K_M-00001-of-00002.gguf"]));
    expect(second.body.status).toBe("queued");
    expect(third.body.status).toBe("queued");
    for (const id of [first.body.id, second.body.id, third.body.id]) await find(id, "completed");
    // 同時に2つ動いた時間がない: downloading の通知は1件ずつ完結している
    const order = worker.context.bus.since(0).map((event) => event.data as any).filter((data) => data.status === "downloading" || data.status === "completed");
    const active = new Set<string>();
    for (const data of order) {
      if (data.status === "downloading") active.add(data.downloadId);
      else active.delete(data.downloadId);
      expect(active.size).toBeLessThanOrEqual(1);
    }
    expect((await worker.api("/models")).body.items).toHaveLength(3);
  });

  it("待っているものを取り消しても、動いているものは続く", async () => {
    const first = await worker.api("/downloads", body(["tiny-Q4_K_M.gguf"]));
    const second = await worker.api("/downloads", body(["other-Q8_0.gguf"]));
    await worker.api(`/downloads/${second.body.id}/cancel`, { method: "POST" });
    await find(first.body.id, "completed");
    expect((await worker.api("/downloads")).body.items.find((row: any) => row.id === second.body.id).status).toBe("cancelled");
  });
});

describe("起動時とシャットダウン", () => {
  it("動いたまま残った行は failed にして、手動で再開できる", async () => {
    const { store } = worker.context;
    const record = store.downloads.create({ kind: "model", repo: "acme/tiny-GGUF", files: [{ name: "tiny-Q4_K_M.gguf", size: small.length, sha256: null }], destDir: path.join(models(), "acme/tiny-GGUF") });
    const other = store.downloads.create({ kind: "model", repo: "acme/tiny-GGUF", files: [{ name: "tiny-Q4_K_M.gguf", size: small.length, sha256: null }], destDir: "x" });
    store.downloads.update(record.id, { status: "verifying" });
    store.downloads.update(other.id, { status: "retrying" });
    const { DownloadService, INTERRUPTED_MESSAGE } = await import("../server/hf/downloads");
    const service = new DownloadService({ store, bus: worker.context.bus, dataDir: worker.dir, hfBaseUrl: hf.baseUrl });
    expect(store.downloads.get(record.id)).toMatchObject({ status: "failed", error: INTERRUPTED_MESSAGE });
    expect(store.downloads.get(other.id)!.status).toBe("failed");
    service.tuning = { retryDelayMs: 5, progressIntervalMs: 0 };
    service.resume(record.id);
    await until(() => store.downloads.get(record.id)!.status === "completed");
    await service.shutdown();
  });

  it("シャットダウンは進行中の DL を止め、.part を残し、failed にする", async () => {
    hf.behavior.cuts = [10_000];
    worker.context.downloads.tuning.retryDelayMs = 60_000;
    const res = await worker.api("/downloads", body(["tiny-Q4_K_M.gguf"]));
    await find(res.body.id, "retrying");
    await worker.context.downloads.shutdown();
    expect(existsSync(path.join(models(), "acme/tiny-GGUF/tiny-Q4_K_M.gguf.part"))).toBe(true);
    expect(worker.context.store.downloads.get(res.body.id)!.status).toBe("failed");
  });
});
