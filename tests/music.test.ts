import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    delete process.env.FAKE_ACE_MODE;
    await worker?.close();
    worker = null;
    temp?.remove();
  });

  /** 音楽モデルを DB に直接入れて、スレッドを作る */
  async function setup() {
    temp = tempDir();
    worker = await startWorker(undefined, { aceDir: fakeBinaries(temp.dir) });
    const model = worker.context.store.models.create({
      name: "ACE-Step 1.5", path: "/m/dit.gguf", source: "hf", architecture: "ace-step",
      quantization: null, sizeBytes: 1, trainContext: null, use: "music", parts: PARTS,
    });
    const thread = worker.context.store.threads.create(null);
    return { modelId: model.id, threadId: thread.id };
  }
  const music = (status: string) => (event: BusEvent) => event.event === "music" && (event.data as { status: string }).status === status;

  it("生成して履歴に残し、MP3 を返す。チャットの文脈には入らない", async () => {
    const { modelId, threadId } = await setup();
    const started = await worker!.api(`/threads/${threadId}/music`, { body: { modelId, prompt: "夏の曲", duration: 20 } });
    expect(started.status).toBe(202);
    // 一覧に空の行を出さないよう、受け付けた時点で題名が付いている
    expect(worker!.context.store.threads.get(threadId)?.title).toBe("夏の曲");
    const done = await waitForEvent(worker!.context.bus, music("completed"));
    const { trackId } = done.data as { trackId: string };
    const audio = await fetch(`http://127.0.0.1:${worker!.port}/api/music/${trackId}`, { headers: { Authorization: "Bearer secret" } });
    expect(audio.status).toBe(200);
    expect(audio.headers.get("content-type")).toContain("audio/mpeg");
    const roles = (worker!.context.db.prepare("SELECT role FROM messages WHERE thread_id = ?").all(threadId) as { role: string }[]).map((m) => m.role);
    expect(roles).toEqual(["music"]);
    const stored = worker!.context.db.prepare("SELECT content FROM messages WHERE thread_id = ?").get(threadId) as { content: string };
    expect(JSON.parse(stored.content).reasoning).toContain("bpm:120");
    expect(worker!.context.store.threads.conversation(threadId)).toEqual([]);
    expect(worker!.context.store.threads.get(threadId)?.title).toBe("夏の曲");
  });

  it("長さの範囲外は断る", async () => {
    const { modelId, threadId } = await setup();
    const res = await worker!.api(`/threads/${threadId}/music`, { body: { modelId, prompt: "x", duration: 241 } });
    expect(res.status).toBe(400);
  });

  it("音楽モデル以外は断る", async () => {
    const { threadId } = await setup();
    const res = await worker!.api(`/threads/${threadId}/music`, { body: { modelId: "nope", prompt: "x" } });
    expect(res.status).toBe(404);
  });

  it("止めると cancelled が届く", async () => {
    process.env.FAKE_ACE_MODE = "slow";
    const { modelId, threadId } = await setup();
    await worker!.api(`/threads/${threadId}/music`, { body: { modelId, prompt: "x" } });
    expect((await worker!.api(`/threads/${threadId}/music/cancel`, { body: {} })).body).toEqual({ status: "cancelling" });
    await waitForEvent(worker!.context.bus, music("cancelled"));
  });

  it("生成中は別の生成を受けない", async () => {
    process.env.FAKE_ACE_MODE = "slow";
    const { modelId, threadId } = await setup();
    await worker!.api(`/threads/${threadId}/music`, { body: { modelId, prompt: "x" } });
    const second = await worker!.api(`/threads/${threadId}/music`, { body: { modelId, prompt: "y" } });
    expect(second.status).toBe(409);
    expect((await worker!.api("/engine/load", { body: { presetId: "any" } })).status).toBe(409);
    await worker!.api(`/threads/${threadId}/music/cancel`, { body: {} });
    await waitForEvent(worker!.context.bus, music("cancelled"));
  });
});
