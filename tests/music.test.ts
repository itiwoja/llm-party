import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MusicEngine } from "../server/music-engine";
import type { BusEvent } from "../server/events";
import { startWorker, tempDir, type TestWorker, waitForEvent } from "./helpers";

const FAKE = path.resolve("tests/fixtures/fake-ace.mjs");
const PARTS = { lm: "/m/lm.gguf", textEncoder: "/m/enc.gguf", dit: "/m/dit.gguf", vae: "/m/vae.gguf" };
const PARAMS = { prompt: "明るい曲", lyrics: "", duration: 30, seed: -1 };

/** 代役の ace-lm / ace-synth をフォルダに置く */
function fakeBinaries(dir: string): string {
  mkdirSync(dir, { recursive: true });
  for (const tool of ["lm", "synth"]) {
    const file = path.join(dir, `ace-${tool}`);
    writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" ${tool} "$@"\n`);
    chmodSync(file, 0o755);
  }
  return dir;
}

describe("MusicEngine", () => {
  let temp: ReturnType<typeof tempDir>;
  beforeEach(() => { temp = tempDir(); });
  afterEach(() => {
    delete process.env.FAKE_ACE_MODE;
    temp.remove();
  });
  const engine = () => new MusicEngine({ dir: fakeBinaries(path.join(temp.dir, "ace")), dataDir: temp.dir });
  const runtime = () => (existsSync(path.join(temp.dir, "runtime")) ? readdirSync(path.join(temp.dir, "runtime")) : []);

  it("実行ファイルが無ければ使えない", () => {
    expect(new MusicEngine({ dir: null, dataDir: temp.dir }).available).toBe(false);
  });

  it("LM → 合成の順に動き、LM が埋めた情報を返す。作業フォルダは消す", async () => {
    const phases: string[] = [];
    const thoughts: string[] = [];
    const result = await engine().generate(PARAMS, PARTS, new AbortController().signal, (phase, reasoning) => {
      if (reasoning) thoughts.push(reasoning);
      else phases.push(phase);
    });
    expect(phases).toEqual(["composing", "rendering"]);
    expect(thoughts.at(-1)).toBe("bpm:120\ncaption: 夏の曲\n");
    expect(result.reasoning).toBe("bpm:120\ncaption: 夏の曲");
    expect(result.audio.toString()).toBe("ID3fake");
    expect(result).toMatchObject({ bpm: 120, keyscale: "C major", seed: 7 });
    expect(result.lyrics).toContain("テスト");
    expect(runtime()).toEqual([]);
  });

  it("下書きは LM だけを CPU で動かし、歌詞だけを返す。作業フォルダは消す", async () => {
    const thoughts: string[] = [];
    const lyrics = await engine().draft({ prompt: "夏の曲" }, PARTS, new AbortController().signal, (text) => thoughts.push(text));
    expect(lyrics).toBe("[Verse]\n下書きの歌詞");
    expect(thoughts.at(-1)).toBe("bpm:120\ncaption: 夏の曲\n");
    expect(runtime()).toEqual([]);
  });

  it("下書きの出力が無い・歌詞が空なら失敗にする", async () => {
    process.env.FAKE_ACE_MODE = "lm-silent";
    await expect(engine().draft({ prompt: "x" }, PARTS, new AbortController().signal, () => undefined)).rejects.toMatchObject({ code: "ENGINE_FAILED" });
    process.env.FAKE_ACE_MODE = "lm-empty";
    await expect(engine().draft({ prompt: "x" }, PARTS, new AbortController().signal, () => undefined)).rejects.toMatchObject({ code: "ENGINE_FAILED" });
    expect(runtime()).toEqual([]);
  });

  it("終了コードが 0 でも音声が無ければ失敗にする", async () => {
    process.env.FAKE_ACE_MODE = "silent";
    await expect(engine().generate(PARAMS, PARTS, new AbortController().signal, () => undefined))
      .rejects.toMatchObject({ code: "ENGINE_FAILED", message: expect.stringContaining("VRAM") });
  });

  it("0 以外で終われば失敗にする", async () => {
    process.env.FAKE_ACE_MODE = "fail";
    await expect(engine().generate(PARAMS, PARTS, new AbortController().signal, () => undefined)).rejects.toMatchObject({ code: "ENGINE_FAILED" });
  });

  it("止めると子プロセスを終わらせて作業フォルダも消す", async () => {
    process.env.FAKE_ACE_MODE = "slow";
    const abort = new AbortController();
    const running = engine().generate(PARAMS, PARTS, abort.signal, () => undefined);
    setTimeout(() => abort.abort(), 100);
    await expect(running).rejects.toMatchObject({ message: "曲の生成が取り消されました" });
    expect(runtime()).toEqual([]);
  });
});

describe("音楽の API", () => {
  let worker: TestWorker | null = null;
  let temp: ReturnType<typeof tempDir>;
  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.FAKE_ACE_MODE;
    await worker?.close();
    worker = null;
    temp?.remove();
  });

  /** 音楽モデルを DB に直接入れる */
  async function setup() {
    temp = tempDir();
    worker = await startWorker(undefined, { aceDir: fakeBinaries(temp.dir) });
    const model = worker.context.store.models.create({
      name: "ACE-Step 1.5", path: "/m/dit.gguf", source: "hf", architecture: "ace-step",
      quantization: null, sizeBytes: 1, trainContext: null, use: "music", parts: PARTS,
    });
    return { modelId: model.id };
  }
  const music = (job: string, status: string) => (event: BusEvent) => {
    const data = event.data as { job?: string; status?: string };
    return event.event === "music" && data.job === job && data.status === status;
  };
  const musicEvents = () => worker!.context.bus.since(0).filter((e) => e.event === "music").map((e) => e.data as Record<string, unknown>);
  const get = (url: string) => fetch(`http://127.0.0.1:${worker!.port}/api${url}`, { headers: { Authorization: "Bearer secret" } });
  const tracks = () => (worker!.context.db.prepare("SELECT COUNT(*) AS n FROM tracks").get() as { n: number }).n;
  async function generate(modelId: string, prompt: string, extra: object = {}) {
    await worker!.api("/music/generate", { body: { modelId, prompt, duration: 20, ...extra } });
    // 前の曲の完了イベントと取り違えないよう、まだ見ていない曲 ID を待つ
    const before = new Set(musicEvents().map((e) => e.trackId));
    const done = await waitForEvent(worker!.context.bus, (e) => {
      const id = (e.data as { trackId?: string }).trackId;
      return e.event === "music" && id !== undefined && !before.has(id);
    });
    return (done.data as { trackId: string }).trackId;
  }

  it("下書きは歌詞をイベントで返し、エンジンを止めず、曲も増やさない", async () => {
    const { modelId } = await setup();
    const stop = vi.spyOn(worker!.context.engine, "stop");
    const imageStop = vi.spyOn(worker!.context.image, "stop");
    expect((await worker!.api("/music/draft", { body: { modelId, prompt: "夏の曲" } })).status).toBe(202);
    const done = await waitForEvent(worker!.context.bus, music("draft", "completed"));
    expect(done.data).toEqual({ job: "draft", status: "completed", lyrics: "[Verse]\n下書きの歌詞" });
    const progress = musicEvents().filter((e) => e.status === "progress");
    expect(progress.at(-1)).toMatchObject({ job: "draft", phase: "drafting", reasoning: "bpm:120\ncaption: 夏の曲\n" });
    expect(stop).not.toHaveBeenCalled();
    expect(imageStop).not.toHaveBeenCalled();
    expect(tracks()).toBe(0);
    expect((await worker!.api("/music/status")).body).toEqual({ status: "idle" });
  });

  it("下書きが空・出力なしなら failed", async () => {
    for (const mode of ["lm-empty", "lm-silent"]) {
      process.env.FAKE_ACE_MODE = mode;
      const { modelId } = await setup();
      await worker!.api("/music/draft", { body: { modelId, prompt: "x" } });
      const failed = await waitForEvent(worker!.context.bus, music("draft", "failed"));
      expect(failed.data).toMatchObject({ job: "draft", error: expect.stringContaining("下書き") });
      await worker!.close();
      worker = null;
    }
  });

  it("下書きを止めると cancelled が届く", async () => {
    process.env.FAKE_ACE_MODE = "slow";
    const { modelId } = await setup();
    await worker!.api("/music/draft", { body: { modelId, prompt: "x" } });
    expect((await worker!.api("/music/cancel", { body: {} })).body).toEqual({ status: "cancelling" });
    expect((await waitForEvent(worker!.context.bus, music("draft", "cancelled"))).data).toEqual({ job: "draft", status: "cancelled" });
    expect((await worker!.api("/music/cancel", { body: {} })).body).toEqual({ status: "idle" });
  });

  it("生成した曲はスレッドに属さず、messages にも入らない。MP3 を返す", async () => {
    const { modelId } = await setup();
    const titles = vi.spyOn(worker!.context.store.threads, "titleFromPrompt");
    const started = await worker!.api("/music/generate", { body: { modelId, prompt: "夏の曲", duration: 20 } });
    expect(started).toMatchObject({ status: 202, body: { status: "running" } });
    const done = await waitForEvent(worker!.context.bus, music("track", "completed"));
    const { trackId } = done.data as { trackId: string };
    const row = worker!.context.db.prepare("SELECT * FROM tracks WHERE id = ?").get(trackId) as Record<string, unknown>;
    expect(row).toMatchObject({ thread_id: null, bpm: 120, keyscale: "C major", seed: 7, duration: 20, prompt: "夏の曲" });
    expect(row.reasoning).toContain("bpm:120");
    expect((worker!.context.db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n).toBe(0);
    expect(titles).not.toHaveBeenCalled();
    const phases = musicEvents().filter((e) => e.status === "progress" && !e.reasoning).map((e) => [e.job, e.phase]);
    expect(phases).toEqual([["track", "composing"], ["track", "rendering"]]);
    const audio = await get(`/music/${trackId}`);
    expect(audio.status).toBe(200);
    expect(audio.headers.get("content-type")).toContain("audio/mpeg");
  });

  it("seed は常に -1 で LM に渡す", async () => {
    const { modelId } = await setup();
    // 実エンジンの引数を見る：seed をリクエストに足しても -1 のままであること
    const spy = vi.spyOn(MusicEngine.prototype, "generate");
    await generate(modelId, "夏の曲");
    expect(spy.mock.calls[0][0]).toMatchObject({ seed: -1 });
  });

  it("一覧は新しい順にページ送りし、詳細を返す。説明は全文", async () => {
    const { modelId } = await setup();
    const a = await generate(modelId, "一曲目\n二行目");
    const b = await generate(modelId, "二曲目");
    const c = await generate(modelId, "三曲目");
    const first = (await worker!.api("/tracks?limit=2")).body;
    expect(first.items.map((t: { id: string }) => t.id)).toEqual([c, b]);
    expect(Object.keys(first.items[0]).sort()).toEqual(["createdAt", "duration", "id", "prompt"]);
    const second = (await worker!.api(`/tracks?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)).body;
    expect(second.items.map((t: { id: string }) => t.id)).toEqual([a]);
    expect(second.items[0].prompt).toBe("一曲目\n二行目");
    expect(second.nextCursor).toBeNull();
    expect((await worker!.api("/tracks")).body.items).toHaveLength(3);
    expect((await worker!.api("/tracks?limit=0")).status).toBe(400);
    expect((await worker!.api("/tracks?cursor=abc")).status).toBe(400);

    const detail = (await worker!.api(`/tracks/${a}`)).body;
    expect(detail).toMatchObject({ id: a, prompt: "一曲目\n二行目", duration: 20, bpm: 120, keyscale: "C major", modelName: "ACE-Step 1.5", seed: 7 });
    expect(detail.lyrics).toContain("テスト");
    expect(detail.reasoning).toContain("bpm:120");
    expect((await worker!.api("/tracks/nope")).status).toBe(404);
  });

  it("削除すると行と MP3 が消え、2回目は 404。MP3 が無くても 204", async () => {
    const { modelId } = await setup();
    const a = await generate(modelId, "一曲目");
    const b = await generate(modelId, "二曲目");
    const fileA = worker!.context.store.tracks.get(a)!.path;
    const fileB = worker!.context.store.tracks.get(b)!.path;
    expect(existsSync(fileA)).toBe(true);
    expect((await worker!.api(`/tracks/${a}`, { method: "DELETE" })).status).toBe(204);
    expect(existsSync(fileA)).toBe(false);
    expect((await worker!.api(`/tracks/${a}`, { method: "DELETE" })).status).toBe(404);
    expect((await get(`/music/${a}`)).status).toBe(404);
    expect((await worker!.api(`/tracks/${a}`)).status).toBe(404);
    rmSync(fileB);
    expect((await worker!.api(`/tracks/${b}`, { method: "DELETE" })).status).toBe(204);
    expect(tracks()).toBe(0);
  });

  it("置き場の外を指す曲は、ファイルに触れず行だけ消す", async () => {
    const { modelId } = await setup();
    const outside = path.join(temp.dir, "outside.mp3");
    writeFileSync(outside, "x");
    const id = worker!.context.store.tracks.create({ threadId: null, modelName: "m", prompt: "p", lyrics: "", duration: 10, seed: 1, path: outside, bpm: null, keyscale: null, reasoning: "" });
    expect(modelId).toBeTruthy();
    expect((await get(`/music/${id}`)).status).toBe(400);
    expect((await worker!.api(`/tracks/${id}`, { method: "DELETE" })).status).toBe(204);
    expect(existsSync(outside)).toBe(true);
    expect(tracks()).toBe(0);
  });

  it("スレッド用の API は無くなった", async () => {
    const { modelId } = await setup();
    const thread = worker!.context.store.threads.create(null);
    expect((await worker!.api(`/threads/${thread.id}/music`, { body: { modelId, prompt: "x" } })).status).toBe(404);
    expect((await worker!.api(`/threads/${thread.id}/music/cancel`, { body: {} })).status).toBe(404);
  });

  it("長さの範囲外は断る", async () => {
    const { modelId } = await setup();
    expect((await worker!.api("/music/generate", { body: { modelId, prompt: "x", duration: 241 } })).status).toBe(400);
    expect((await worker!.api("/music/generate", { body: { modelId, prompt: "x", duration: 9 } })).status).toBe(400);
    expect((await worker!.api("/music/draft", { body: { modelId, prompt: "  " } })).status).toBe(400);
  });

  it("音楽モデル以外は断る", async () => {
    await setup();
    expect((await worker!.api("/music/generate", { body: { modelId: "nope", prompt: "x" } })).status).toBe(404);
    expect((await worker!.api("/music/draft", { body: { modelId: "nope", prompt: "x" } })).status).toBe(404);
  });

  it("状態は idle と実行中で変わり、/music/status は曲の id に取られない", async () => {
    process.env.FAKE_ACE_MODE = "slow";
    const { modelId } = await setup();
    expect(await worker!.api("/music/status")).toEqual({ status: 200, body: { status: "idle" } });
    await worker!.api("/music/generate", { body: { modelId, prompt: "x" } });
    expect((await worker!.api("/music/status")).body).toEqual({ status: "composing" });
    await worker!.api("/music/cancel", { body: {} });
    expect((await waitForEvent(worker!.context.bus, music("track", "cancelled"))).data).toEqual({ job: "track", status: "cancelled" });
    await vi.waitFor(async () => expect((await worker!.api("/music/status")).body).toEqual({ status: "idle" }));
    await worker!.api("/music/draft", { body: { modelId, prompt: "x" } });
    expect((await worker!.api("/music/status")).body).toEqual({ status: "drafting" });
    await worker!.api("/music/cancel", { body: {} });
    await waitForEvent(worker!.context.bus, music("draft", "cancelled"));
  });

  it("実行中は LM の思考と段階を返す", async () => {
    const { modelId } = await setup();
    // 完了まで待たずに途中を見るため、合成の段階で止める
    const original = MusicEngine.prototype.generate;
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    vi.spyOn(MusicEngine.prototype, "generate").mockImplementation(async function (this: MusicEngine, ...args) {
      args[3]("rendering", "考え中");
      await gate;
      return original.apply(this, args);
    });
    await worker!.api("/music/generate", { body: { modelId, prompt: "x", duration: 20 } });
    await vi.waitFor(async () => expect((await worker!.api("/music/status")).body).toEqual({ status: "rendering", reasoning: "考え中" }));
    resume();
    await waitForEvent(worker!.context.bus, music("track", "completed"));
  });

  it("生成中は下書きも生成も受けない", async () => {
    process.env.FAKE_ACE_MODE = "slow";
    const { modelId } = await setup();
    await worker!.api("/music/generate", { body: { modelId, prompt: "x" } });
    expect((await worker!.api("/music/generate", { body: { modelId, prompt: "y" } })).status).toBe(409);
    const draft = await worker!.api("/music/draft", { body: { modelId, prompt: "y" } });
    expect(draft).toMatchObject({ status: 409, body: { error: { code: "BUSY" } } });
    expect((await worker!.api("/engine/load", { body: { presetId: "any" } })).status).toBe(409);
    await worker!.api("/music/cancel", { body: {} });
    await waitForEvent(worker!.context.bus, music("track", "cancelled"));
  });

  it("失敗には job が付く", async () => {
    process.env.FAKE_ACE_MODE = "fail";
    const { modelId } = await setup();
    await worker!.api("/music/generate", { body: { modelId, prompt: "x" } });
    expect((await waitForEvent(worker!.context.bus, music("track", "failed"))).data).toMatchObject({ job: "track", status: "failed" });
  });
});
