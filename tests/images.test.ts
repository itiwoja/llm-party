import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ImageEngine } from "../server/image-engine";
import { readSafetensors } from "../server/safetensors";
import { EventBus } from "../server/events";
import { FAKE_SD, startWorker, tempDir, type TestWorker, waitForEvent } from "./helpers";

/** 8 バイトの長さ＋JSON ヘッダー（重みは付けない） */
function safetensors(header: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(json.length));
  return Buffer.concat([length, json]);
}

describe("readSafetensors", () => {
  let temp: ReturnType<typeof tempDir>;
  afterEach(() => temp?.remove());

  it("ヘッダーを読んで、__metadata__ の名前を取る", () => {
    temp = tempDir();
    const file = path.join(temp.dir, "m.safetensors");
    writeFileSync(file, safetensors({ __metadata__: { "modelspec.title": "Anime XL" } }));
    const info = readSafetensors(file);
    expect(info.name).toBe("Anime XL");
    expect(info.sizeBytes).toBe(file ? info.sizeBytes : 0);
  });

  it("名前がなければ null", () => {
    temp = tempDir();
    const file = path.join(temp.dir, "m.safetensors");
    writeFileSync(file, safetensors({ "w": { dtype: "F16", shape: [1], data_offsets: [0, 2] } }));
    expect(readSafetensors(file).name).toBeNull();
  });

  it("壊れたファイルは INVALID_SAFETENSORS", () => {
    temp = tempDir();
    const file = path.join(temp.dir, "bad.safetensors");
    writeFileSync(file, Buffer.from("GGUF0000000000000000"));
    expect(() => readSafetensors(file)).toThrowError(expect.objectContaining({ code: "INVALID_SAFETENSORS" }) as never);
  });
});

describe("ImageEngine", () => {
  let temp: ReturnType<typeof tempDir>;
  let engine: ImageEngine | null = null;
  afterEach(async () => {
    await engine?.stop();
    engine = null;
    temp?.remove();
  });

  const create = (mode: string, generateTimeoutMs = 2000) => {
    temp = tempDir();
    process.env.FAKE_SD_MODE = mode;
    engine = new ImageEngine({ bin: FAKE_SD, dataDir: temp.dir, bus: new EventBus(), loadTimeoutMs: 3000, stopGraceMs: 300, pollMs: 50, generateTimeoutMs });
    return engine;
  };
  const params = { prompt: "a cat", width: 64, height: 64, steps: 2, seed: 1 };

  it("生成中の進捗を 0〜100 の整数で通知する", async () => {
    const e = create("ok");
    await e.load({ path: "/models/a.safetensors", parts: null });
    const seen: number[] = [];
    await e.generate(params, new AbortController().signal, ({ percent }) => seen.push(percent));
    expect(seen).toEqual([50]);
  });

  it("途中の画像とステップ数を通知し、同じステップは繰り返さない（D-85）", async () => {
    const e = create("preview");
    await e.load({ path: "/models/a.safetensors", parts: null });
    const abort = new AbortController();
    const seen: { step?: number; totalSteps?: number; png: boolean }[] = [];
    const done = e.generate(params, abort.signal, ({ step, totalSteps, preview }) => {
      seen.push({ step, totalSteps, png: preview?.subarray(0, 4).toString("hex") === "89504e47" });
      setTimeout(() => abort.abort(), 200);
    });
    await expect(done).rejects.toThrow();
    expect(seen).toEqual([{ step: 1, totalSteps: 2, png: true }]);
    expect(loggedBody()).toMatchObject({ preview: "proj", preview_interval: 1 });
  });

  it("読み込んで1枚生成し、PNG のバイト列を返す", async () => {
    const e = create("ok");
    await e.load({ path: "/models/a.safetensors", parts: null });
    const png = await e.generate(params, new AbortController().signal);
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });

  /** fake-sd が標準エラーに出した args 行（sd-server のログ）を読む */
  const loggedArgs = () => {
    const dir = path.join(temp.dir, "logs");
    const text = readdirSync(dir).map((f) => readFileSync(path.join(dir, f), "utf8")).join("\n");
    return text.split("\n").find((l) => l.startsWith("args: ")) ?? "";
  };

  const loggedBody = () => {
    const dir = path.join(temp.dir, "logs");
    const text = readdirSync(dir).map((f) => readFileSync(path.join(dir, f), "utf8")).join("\n");
    return JSON.parse(text.split("\n").find((l) => l.startsWith("body: "))?.slice(6) ?? "{}");
  };

  it("sd-cli の進捗行からステップを読み、読み込みの進捗は数えず、途中の画像を渡す（D-85）", async () => {
    temp = tempDir();
    const bin = path.join(temp.dir, "sd-cli");
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    writeFileSync(bin, `#!/bin/sh
while [ $# -gt 0 ]; do
  case "$1" in --preview-path) p="$2";; -o) o="$2";; esac
  shift
done
printf '  |#####     | 231/462 - 59.26MB/s\\r'
sleep 0.1
echo ${png} | base64 -d > "$p"
printf '  |==>       |  1/2 - 1.57s/it - ETA 00:10\\r'
sleep 0.1
printf '  |==========|  2/2 - 1.57s/it\\n'
sleep 0.1
echo ${png} | base64 -d > "$o"
`, { mode: 0o755 });
    engine = new ImageEngine({ bin, dataDir: temp.dir, bus: new EventBus() });
    await engine.load({ path: "/m.safetensors", parts: null });
    const seen: { percent: number; step?: number; totalSteps?: number; png: boolean }[] = [];
    const out = await engine.generate(params, new AbortController().signal, ({ percent, step, totalSteps, preview }) => {
      seen.push({ percent, step, totalSteps, png: preview !== undefined });
    });
    expect(out.subarray(0, 4).toString("hex")).toBe("89504e47");
    expect(seen).toEqual([
      { percent: 50, step: 1, totalSteps: 2, png: true },
      { percent: 100, step: 2, totalSteps: 2, png: true },
    ]);
  });

  it("parts があれば --diffusion-model / --llm / --vae / --tokenizer を渡し、-m は付けない", async () => {
    const e = create("ok");
    const parts = { diffusion: "/m/d.gguf", llm: "/m/l.gguf", vae: "/m/v.safetensors", tokenizer: "/m/t.json" };
    await e.load({ path: parts.diffusion, parts });
    const line = loggedArgs();
    expect(line).toContain("--diffusion-model /m/d.gguf");
    expect(line).toContain("--llm /m/l.gguf");
    expect(line).toContain("--vae /m/v.safetensors");
    expect(line).toContain("--tokenizer /m/t.json");
    expect(line).toContain("--max-vram 5.5");
    expect(line).not.toContain("--backend");
    expect(line.split(" ")).not.toContain("-m");
  });

  it("parts がなければ従来どおり -m を渡す", async () => {
    const e = create("ok");
    await e.load({ path: "/models/a.safetensors", parts: null });
    const line = loggedArgs();
    expect(line).toContain("-m /models/a.safetensors");
    expect(line).not.toContain("--diffusion-model");
    expect(line).not.toContain("--backend");
  });

  it("起動直後に落ちたら ENGINE_FAILED", async () => {
    const e = create("fail");
    await expect(e.load({ path: "/models/a.safetensors", parts: null })).rejects.toMatchObject({ code: "ENGINE_FAILED" });
  });

  it("時間を過ぎたら取り消して ENGINE_FAILED", async () => {
    const e = create("slow", 400);
    await e.load({ path: "/models/a.safetensors", parts: null });
    await expect(e.generate(params, new AbortController().signal)).rejects.toMatchObject({ code: "ENGINE_FAILED" });
  });

  it("bin がなければ読み込みを断る", async () => {
    temp = tempDir();
    engine = new ImageEngine({ bin: null, dataDir: temp.dir, bus: new EventBus() });
    expect(engine.available).toBe(false);
    await expect(engine.load({ path: "/models/a.safetensors", parts: null })).rejects.toMatchObject({ code: "ENGINE_FAILED" });
  });
});

describe("画像生成の経路", () => {
  let worker: TestWorker;
  afterEach(async () => {
    await worker?.close();
  });

  it("画像モデルで生成し、スレッドに画像が載り、チャットの履歴には入らない", async () => {
    worker = await startWorker(null, { sdBin: FAKE_SD });
    process.env.FAKE_SD_MODE = "ok";
    const { store } = worker.context;
    const model = store.models.create({
      name: "Test XL", path: path.join(worker.dir, "x.safetensors"), source: "hf", use: "image",
      architecture: "safetensors", quantization: null, sizeBytes: 10, trainContext: null,
    });
    const thread = store.threads.create(null);

    const started = await worker.api(`/threads/${thread.id}/images`, { body: { modelId: model.id, prompt: "a cat", width: 64, height: 64, steps: 2 } });
    expect(started.status).toBe(202);
    // 一覧に空の行を出さないよう、受け付けた時点で題名が付いている
    expect(worker.context.store.threads.get(thread.id)?.title).toBe("a cat");
    const done = await waitForEvent(worker.context.bus, (e) => e.event === "image" && (e.data as { threadId: string; status: string }).status !== "progress" && (e.data as { threadId: string }).threadId === thread.id, 10_000);
    const imageId = (done.data as { imageId: string; status: string }).imageId;
    expect((done.data as { status: string }).status).toBe("completed");

    const png = await fetch(`http://127.0.0.1:${worker.port}/api/images/${imageId}`, { headers: { Authorization: "Bearer secret" } });
    expect(png.headers.get("content-type")).toContain("image/png");

    const detail = await worker.api(`/threads/${thread.id}/messages`);
    expect(JSON.stringify(detail.body)).toContain(imageId);
    expect(store.threads.conversation(thread.id).map((m: { content: string }) => m.content).join("\n")).not.toContain(imageId);
    expect(store.threads.agentConversation(thread.id).map((m) => m.content).join("\n")).not.toContain(imageId);
  });

  it("途中の画像は生成中だけ取れ、ステップと番号は status にも出る（API-115・116, D-85）", async () => {
    worker = await startWorker(null, { sdBin: FAKE_SD });
    process.env.FAKE_SD_MODE = "preview";
    const { store } = worker.context;
    const model = store.models.create({
      name: "Test XL", path: path.join(worker.dir, "preview.safetensors"), source: "hf", use: "image",
      architecture: "safetensors", quantization: null, sizeBytes: 10, trainContext: null,
    });
    const thread = store.threads.create(null);
    await worker.api(`/threads/${thread.id}/images`, { body: { modelId: model.id, prompt: "a cat", width: 64, height: 64, steps: 2 } });
    const progress = await waitForEvent(worker.context.bus, (e) => e.event === "image" && (e.data as { status: string }).status === "progress" && (e.data as { previewSeq?: number }).previewSeq === 1, 10_000);
    expect(progress.data).toMatchObject({ threadId: thread.id, step: 1, totalSteps: 2, previewSeq: 1 });
    expect(JSON.stringify(progress.data)).not.toContain("iVBOR");
    expect((await worker.api("/images/status")).body).toMatchObject({ step: 1, totalSteps: 2, previewSeq: 1 });

    const png = await fetch(`http://127.0.0.1:${worker.port}/api/images/preview`, { headers: { Authorization: "Bearer secret" } });
    expect(png.headers.get("content-type")).toContain("image/png");

    await worker.api(`/threads/${thread.id}/images/cancel`, { body: {} });
    await waitForEvent(worker.context.bus, (e) => e.event === "image" && (e.data as { status: string }).status === "cancelled", 10_000);
    await expect.poll(async () => (await worker.api("/images/preview")).status).toBe(404);
  });

  it("生成中に止めると cancelled になり、画像は残らず、エラーにもならない", async () => {
    worker = await startWorker(null, { sdBin: FAKE_SD });
    process.env.FAKE_SD_MODE = "slow";
    const { store } = worker.context;
    const model = store.models.create({
      name: "Test XL", path: path.join(worker.dir, "stop.safetensors"), source: "hf", use: "image",
      architecture: "safetensors", quantization: null, sizeBytes: 10, trainContext: null,
    });
    const thread = store.threads.create(null);

    expect((await worker.api("/images/status")).body).toEqual({ status: "idle" });
    const started = await worker.api(`/threads/${thread.id}/images`, { body: { modelId: model.id, prompt: "a cat", width: 64, height: 64, steps: 2 } });
    expect(started.status).toBe(202);
    await waitForEvent(worker.context.bus, (e) => e.event === "image" && (e.data as { status: string }).status === "progress", 10_000).catch(() => undefined);
    // 画面を開き直しても、依頼の文と実行中であることが分かる（D-84）
    expect((await worker.api("/images/status")).body).toEqual({ status: "running", threadId: thread.id, prompt: "a cat", modelId: model.id, step: null, totalSteps: null, previewSeq: 0 });
    expect((await worker.api("/images/preview")).status).toBe(404);
    const stopped = await worker.api(`/threads/${thread.id}/images/cancel`, { body: {} });
    expect(stopped.body).toEqual({ status: "cancelling" });

    const done = await waitForEvent(worker.context.bus, (e) => e.event === "image" && (e.data as { status: string }).status !== "progress" && (e.data as { threadId: string }).threadId === thread.id, 10_000);
    expect((done.data as { status: string }).status).toBe("cancelled");
    expect(store.threads.get(thread.id)).toBeTruthy();
    expect(JSON.stringify((await worker.api(`/threads/${thread.id}/messages`)).body)).not.toContain("imageId");

    expect((await worker.api("/images/status")).body).toEqual({ status: "idle" });

    // 終わった後に止めても何もしない
    expect((await worker.api(`/threads/${thread.id}/images/cancel`, { body: {} })).body).toEqual({ status: "idle" });
  });

  it("チャット用のプリセットに画像モデルは使えない", async () => {
    worker = await startWorker(null, { sdBin: FAKE_SD });
    const model = worker.context.store.models.create({
      name: "Test XL", path: path.join(worker.dir, "y.safetensors"), source: "hf", use: "image",
      architecture: "safetensors", quantization: null, sizeBytes: 10, trainContext: null,
    });
    const res = await worker.api("/presets", { body: { name: "x", modelId: model.id, sampling: { temperature: 0.7, topP: 0.8, topK: 20, minP: 0, presencePenalty: 1.5, repeatPenalty: 1 }, contextSize: 4096, thinking: false, adapters: [] } });
    expect(res.status).toBe(400);
  });

  it("画像生成は画像モデルだけを受ける", async () => {
    worker = await startWorker(null, { sdBin: FAKE_SD });
    const thread = worker.context.store.threads.create(null);
    const res = await worker.api(`/threads/${thread.id}/images`, { body: { modelId: "nope", prompt: "a cat" } });
    expect(res.status).toBe(404);
  });
});
