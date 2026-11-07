import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACE_STEP } from "../server/hf/recipes";
import { ggufBytes, startFakeHf, type FakeHf } from "./fixtures/fake-hf";
import { FAKE_LLAMA, startWorker, type TestWorker } from "./helpers";

const OLD_DIT = "acestep-v15-turbo-Q8_0.gguf";
const repos = () => ({
  "Serveurperso/ACE-Step-1.5-GGUF": {
    files: [
      { path: "acestep-v15-xl-turbo-Q8_0.gguf", data: ggufBytes() },
      { path: "acestep-5Hz-lm-1.7B-Q8_0.gguf", data: ggufBytes() },
      { path: "Qwen3-Embedding-0.6B-Q8_0.gguf", data: ggufBytes() },
      { path: "vae-BF16.gguf", data: ggufBytes() },
    ],
  },
});

let hf: FakeHf;
let worker: TestWorker;

beforeEach(async () => {
  hf = await startFakeHf(repos());
  worker = await startWorker(FAKE_LLAMA, { hfBaseUrl: hf.baseUrl });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await worker.close();
  await hf.close();
});

const root = () => path.join(worker.dir, "models");
const at = (key: string) => {
  const part = ACE_STEP.find((item) => item.key === key)!;
  return path.join(root(), part.repo, part.file);
};
const oldDit = () => path.join(root(), ACE_STEP[0].repo, OLD_DIT);

/** 2B で登録済みの環境を作る。共有の部品は XL のものと同じパス */
const seedOld = (options: { dit?: string; write?: boolean } = {}) => {
  const dit = options.dit ?? oldDit();
  if (options.write !== false) {
    mkdirSync(path.dirname(dit), { recursive: true });
    writeFileSync(dit, ggufBytes());
  }
  return worker.context.store.models.create({
    name: "ACE-Step 1.5", path: dit, source: "hf", architecture: "ace-step", quantization: null, sizeBytes: 1,
    trainContext: null, use: "music", parts: { lm: at("lm"), textEncoder: at("textEncoder"), dit, vae: at("vae") },
  });
};

const until = async <T,>(fn: () => Promise<T | false>, timeoutMs = 5000): Promise<T> => {
  const limit = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > limit) throw new Error("条件が満たされません");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
};
const finish = (id: string, status = "completed") =>
  until(async () => {
    const item = (await worker.api("/downloads")).body.items.find((row: { id: string }) => row.id === id);
    return item?.status === status ? item : false;
  });
const install = async () => {
  const created = await worker.api("/music-recipes", { body: { recipe: "ace-step" } });
  expect(created.status).toBe(202);
  return finish(created.body.download.id);
};
const musicModels = () => worker.context.store.models.list().filter((model) => model.use === "music");

describe("音楽モデルの置き換え（D-79, ADR-014）", () => {
  it("2B の登録がある環境で XL を入れると、古い行と 2B の DiT だけが消える", async () => {
    seedOld();
    const old = musicModels()[0];
    // 2B の部品は共有部品だけ先に置いてある（同じサイズなので DL を飛ばす）
    for (const key of ["lm", "textEncoder", "vae"]) {
      mkdirSync(path.dirname(at(key)), { recursive: true });
      writeFileSync(at(key), hf.repos.get(ACE_STEP[0].repo)!.files.find((file) => file.path === ACE_STEP.find((p) => p.key === key)!.file)!.data);
    }
    // API-107 は XL が未登録の間は installed にしない
    expect((await worker.api("/music-recipes")).body.items[0]).toMatchObject({ id: "ace-step", name: "ACE-Step 1.5 XL", installed: false });
    const trackSql = worker.context.db.prepare("INSERT INTO tracks (id, thread_id, model_name, prompt, lyrics, duration, seed, path, created_at) VALUES ('t1', ?, 'ACE-Step 1.5', 'p', 'l', 60, 1, 'x.mp3', '2026-01-01')");
    trackSql.run(worker.context.store.threads.create(null).id);

    await install();

    // 同じサイズの共有部品は取り直さず、XL の DiT だけを取る
    expect(hf.cdnRequests.map((req) => req.url).filter((url) => /lm-1\.7B|Embedding|vae-BF16/.test(url))).toEqual([]);
    expect(hf.cdnRequests.some((req) => req.url.includes("xl-turbo"))).toBe(true);
    const models = musicModels();
    expect(models).toHaveLength(1);
    expect(models[0].id).not.toBe(old.id);
    expect(models[0]).toMatchObject({ name: "ACE-Step 1.5 XL", path: at("dit"), parts: { dit: at("dit"), lm: at("lm"), textEncoder: at("textEncoder"), vae: at("vae") } });
    expect(existsSync(oldDit())).toBe(false);
    for (const key of ["dit", "lm", "textEncoder", "vae"]) expect(existsSync(at(key))).toBe(true);
    expect(worker.context.db.prepare("SELECT COUNT(*) AS n FROM tracks").get()).toEqual({ n: 1 });
    expect((await worker.api("/music-recipes")).body.items[0].installed).toBe(true);
  });

  it("古い行が無い環境でも入る", async () => {
    await install();
    expect(musicModels()).toHaveLength(1);
    expect(musicModels()[0].name).toBe("ACE-Step 1.5 XL");
  });

  it("古い行の dit が XL と同じパスでも、XL のファイルは消さない", async () => {
    // 既存の行は新しい行と path が同じだと登録できないので、DL 後に同じ dit を指す古い行を作る状況を、parts だけ同じにして再現する
    seedOld({ dit: path.join(root(), ACE_STEP[0].repo, "other.gguf"), write: false });
    worker.context.db.prepare("UPDATE models SET parts = ? WHERE kind = 'music'").run(JSON.stringify({ lm: at("lm"), textEncoder: at("textEncoder"), dit: at("dit"), vae: at("vae") }));
    await install();
    expect(musicModels()).toHaveLength(1);
    expect(existsSync(at("dit"))).toBe(true);
  });

  it("置き場の外の dit は消さない", async () => {
    const outside = path.join(worker.dir, "outside", "mine.gguf");
    seedOld({ dit: outside });
    await install();
    expect(musicModels()).toHaveLength(1);
    expect(existsSync(outside)).toBe(true);
  });

  it("削除に失敗しても DL は completed のまま", async () => {
    seedOld();
    const spy = vi.spyOn(worker.context.store.models, "delete").mockImplementation(() => {
      throw new Error("FOREIGN KEY constraint failed");
    });
    const done = await install();
    expect(done.status).toBe("completed");
    expect(spy).toHaveBeenCalled();
    expect(existsSync(oldDit())).toBe(true); // 行が消えていないので DiT も残す
    expect(musicModels().map((model) => model.name).sort()).toEqual(["ACE-Step 1.5", "ACE-Step 1.5 XL"]);
  });
});
