import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MusicEngine } from "../server/music-engine";
import { cleanLyrics, LYRICS_MAX_CHARS, lyricsMessages } from "../server/music-lyrics";
import type { BusEvent } from "../server/events";
import { SAMPLING, startWorker, tempDir, type TestWorker, waitForEvent, writeGguf } from "./helpers";

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

describe("FR-023 歌詞の依頼と整形", () => {
  const ask = (duration: number) => lyricsMessages({ prompt: "夏", duration })[0].content;

  it("長さから行数を決め、短い曲は構成を絞る", () => {
    expect(ask(60)).toContain("15 行以内");
    expect(ask(240)).toContain("60 行以内");
    expect(ask(10)).toContain("[Verse] と [Chorus] だけ");
    expect(ask(60)).not.toContain("[Verse] と [Chorus] だけ");
  });

  it("前置き・見出し・コードブロック・太字・思考を落とす", () => {
    expect(cleanLyrics("<think>考え</think>\nはい！\n```\n# 題名\n**[Verse]**\n海へ\n\n[Chorus]\n走る\n```\n")).toBe("[Verse]\n海へ\n\n[Chorus]\n走る");
  });

  it("タグが無くても本文は残す", () => {
    expect(cleanLyrics("海へ\n走る")).toBe("海へ\n走る");
  });

  it("空なら空を返す", () => {
    expect(cleanLyrics("```\n```\n")).toBe("");
  });

  it("上限を超えたら行の切れ目で切る", () => {
    const lyrics = cleanLyrics(`[Verse]\n${"あ".repeat(1000)}\n`.repeat(5));
    expect(lyrics.length).toBeLessThanOrEqual(LYRICS_MAX_CHARS);
    expect(lyrics.endsWith("あ")).toBe(true);
    expect(lyrics.split("\n").at(-1)).toHaveLength(1000);
  });
});

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

  it("LM の出力が無ければ失敗にする", async () => {
    process.env.FAKE_ACE_MODE = "lm-silent";
    await expect(engine().generate(PARAMS, PARTS, new AbortController().signal, () => undefined)).rejects.toMatchObject({ code: "ENGINE_FAILED" });
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
    vi.unstubAllEnvs();
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

  /** 歌詞を書くチャットのプリセットを用意する */
  async function lyricsPreset(thinking = false) {
    const file = path.join(worker!.dir, "chat.gguf");
    writeGguf(file);
    const model = await worker!.api("/models", { body: { path: file, mode: "reference" } });
    const preset = await worker!.api("/presets", { body: { name: "作詞", modelId: model.body.id, sampling: SAMPLING, thinking, contextSize: 8192, systemPrompt: "コードを書く" } });
    return preset.body.id as string;
  }
  /** 代役の llama-server の応答を決める。worker を起動する前に呼ぶ */
  function script(steps: unknown[]) {
    const dir = tempDir();
    const file = path.join(dir.dir, "script.json");
    writeFileSync(file, JSON.stringify(steps));
    vi.stubEnv("FAKE_LLAMA_SCRIPT", file);
    return dir;
  }
  /** 代役の llama-server が受け取った最後の依頼 */
  function lastRequest() {
    const logs = path.join(worker!.dir, "logs");
    const text = readdirSync(logs).filter((f) => f.startsWith("llama-server")).map((f) => readFileSync(path.join(logs, f), "utf8")).join("\n");
    return JSON.parse(text.match(/REQUEST (.+)/g)!.at(-1)!.slice("REQUEST ".length)) as {
      messages: { role: string; content: string }[]; max_tokens: number; temperature: number; chat_template_kwargs: { enable_thinking: boolean };
    };
  }

  it("下書きはチャットのモデルが説明と長さをもとに書き、整えた歌詞だけをイベントで返す", async () => {
    const dir = script([{ reasoning: ["考え", "中"], content: "はい、書きます。\n\n# 突き進む\n**[Verse]**\nむらかみいっき 進む\n" }]);
    await setup();
    const presetId = await lyricsPreset();
    const stop = vi.spyOn(worker!.context.engine, "stop");
    expect((await worker!.api("/music/draft", { body: { presetId, prompt: "むらかみいっきの曲", duration: 120 } })).status).toBe(202);
    const done = await waitForEvent(worker!.context.bus, music("draft", "completed"));
    expect(done.data).toEqual({ job: "draft", status: "completed", lyrics: "[Verse]\nむらかみいっき 進む" });
    expect(musicEvents().filter((e) => e.status === "progress").at(-1)).toMatchObject({ job: "draft", phase: "drafting", reasoning: "考え中" });

    const request = lastRequest();
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0].content).toContain("むらかみいっきの曲");
    expect(request.messages[0].content).toContain("曲の長さは 120 秒");
    expect(request.messages[0].content).toContain("30 行以内");
    // プリセットの生成設定を使い、コーディング用などの指示は持ち込まない
    expect(request.messages[0].content).not.toContain("コードを書く");
    expect(request).toMatchObject({ temperature: SAMPLING.temperature, chat_template_kwargs: { enable_thinking: false } });

    expect(worker!.context.engine.state).toBe("ready");
    expect(stop).not.toHaveBeenCalled();
    expect(tracks()).toBe(0);
    expect((await worker!.api("/music/status")).body).toEqual({ status: "idle" });
    dir.remove();
  });

  it("音楽エンジンが無くても下書きはできる", async () => {
    const dir = script([{ content: "[Verse]\nla" }]);
    worker = await startWorker();
    temp = tempDir();
    const presetId = await lyricsPreset();
    expect((await worker!.api("/music/draft", { body: { presetId, prompt: "x" } })).status).toBe(202);
    await waitForEvent(worker!.context.bus, music("draft", "completed"));
    dir.remove();
  });

  it("下書きの本文が空なら failed", async () => {
    const dir = script([{ reasoning: ["考えただけ"] }]);
    await setup();
    const presetId = await lyricsPreset();
    await worker!.api("/music/draft", { body: { presetId, prompt: "x" } });
    const failed = await waitForEvent(worker!.context.bus, music("draft", "failed"));
    expect(failed.data).toMatchObject({ job: "draft", error: expect.stringContaining("下書き") });
    dir.remove();
  });

  it("下書きを止めると cancelled が届く", async () => {
    vi.stubEnv("FAKE_LLAMA_MODE", "slow");
    await setup();
    const presetId = await lyricsPreset();
    await worker!.api("/music/draft", { body: { presetId, prompt: "x" } });
    expect((await worker!.api("/music/status")).body).toEqual({ status: "drafting" });
    expect((await worker!.api("/music/cancel", { body: {} })).body).toEqual({ status: "cancelling" });
    expect((await waitForEvent(worker!.context.bus, music("draft", "cancelled"))).data).toEqual({ job: "draft", status: "cancelled" });
    await vi.waitFor(async () => expect((await worker!.api("/music/cancel", { body: {} })).body).toEqual({ status: "idle" }));
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
    const presetId = await lyricsPreset();
    expect((await worker!.api("/music/draft", { body: { presetId, prompt: "  " } })).status).toBe(400);
    expect((await worker!.api("/music/draft", { body: { presetId, prompt: "x", duration: 241 } })).status).toBe(400);
  });

  it("音楽モデル以外は断る。下書きは無いプリセットを断る", async () => {
    await setup();
    expect((await worker!.api("/music/generate", { body: { modelId: "nope", prompt: "x" } })).status).toBe(404);
    expect((await worker!.api("/music/draft", { body: { presetId: "nope", prompt: "x" } })).status).toBe(404);
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
    const presetId = await lyricsPreset();
    await worker!.api("/music/generate", { body: { modelId, prompt: "x" } });
    expect((await worker!.api("/music/generate", { body: { modelId, prompt: "y" } })).status).toBe(409);
    const draft = await worker!.api("/music/draft", { body: { presetId, prompt: "y" } });
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
