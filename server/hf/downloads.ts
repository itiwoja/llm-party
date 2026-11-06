import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readSync, openSync, closeSync, statSync } from "node:fs";
import { open, rename, rm, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EventBus } from "../events";
import { readGguf } from "../gguf";
import { ApiError } from "../http-error";
import type { Store } from "../store";
import type { DownloadRecord } from "../store/downloads";
import { HfClient, RetryableError } from "./client";
import { readSafetensors } from "../safetensors";
import { RECIPES, type Recipe } from "./recipes";
import { assertFileName, assertGguf, assertRepo, assertSafetensors, expandSelection, insideDir, quantOf } from "./names";

export interface DownloadOptions {
  store: Store;
  bus: EventBus;
  dataDir: string;
  hfBaseUrl: string;
}

/** 自動で再試行する回数（D-31） */
const MAX_RETRIES = 3;
/** 空きに足す余白（BR-05, D-31）。2GB を 2×1024³ バイトとして扱う */
const FREE_MARGIN = 2_000_000_000;
/** 完了した DL のプリセットの文脈長の上限（学習時の文脈長がこれより短ければそちら） */
const DEFAULT_CONTEXT = 32768;

export const INTERRUPTED_MESSAGE = "中断されました";
const BROKEN_MESSAGE = "ファイル破損。再試行で取り直し";
const NOT_LORA_MESSAGE = "llama.cpp 形式の LoRA ではない。convert_lora_to_gguf.py で変換が必要";
const NOT_MODEL_MESSAGE = "これはモデルの GGUF ではありません";

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });

interface Job {
  id: string;
  controller: AbortController;
  stop: "cancel" | "shutdown" | null;
  received: number;
  lastTick: number;
  done: Promise<void>;
}

async function freeBytes(dir: string): Promise<number> {
  let target = path.resolve(dir);
  while (!existsSync(target)) target = path.dirname(target);
  const stats = await statfs(target);
  return stats.bavail * stats.bsize;
}

/** 空き容量が「残りのサイズ＋2GB」以上か確かめる */
async function ensureSpace(dir: string, remaining: number): Promise<void> {
  const need = remaining + FREE_MARGIN;
  if ((await freeBytes(dir)) < need) {
    throw new ApiError("INSUFFICIENT_STORAGE", `空き容量不足。${(need / 1e9).toFixed(1)} GB 必要。置き場の変更で解消`);
  }
}

function hasMagic(file: string): boolean {
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(4);
    readSync(fd, head, 0, 4, 0);
    return head.toString("latin1") === "GGUF";
  } finally {
    closeSync(fd);
  }
}

async function sha256(file: string, signal: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest("hex");
}

/** FR-012 の DL。同時に1つ */
export class DownloadService {
  /** 間隔は設計にない仮の値。テストが縮める */
  tuning = { retryDelayMs: 2000, progressIntervalMs: 500 };

  private client: HfClient;
  private job: Job | null = null;
  private closed = false;

  constructor(private options: DownloadOptions) {
    this.client = new HfClient(options.hfBaseUrl, options.dataDir);
    options.store.downloads.failInterrupted(INTERRUPTED_MESSAGE);
    this.pump();
  }

  list(): DownloadRecord[] {
    return this.options.store.downloads.list();
  }

  /**
   * 空き容量と、ゲートの有無を確かめてから待ち行列に入れる。
   * files を省くとリポジトリ全体を取る（保存だけの file に限る）
   */
  async create(input: { repo: string; files?: string[]; kind: DownloadRecord["kind"] }): Promise<DownloadRecord> {
    const { store } = this.options;
    assertRepo(input.repo);
    input.files?.forEach((file) => assertFileName(file));
    if (input.kind === "image") {
      if (!input.files || input.files.length !== 1) throw new ApiError("VALIDATION_ERROR", "入力が正しくありません", [{ field: "files" }]);
      assertSafetensors(input.files[0]);
    } else if (input.kind !== "file") {
      if (!input.files) throw new ApiError("VALIDATION_ERROR", "入力が正しくありません", [{ field: "files" }]);
      input.files.forEach((file) => assertGguf(file));
    }
    const tree = await this.client.listFiles(input.repo);
    const selected = input.files ? expandSelection(input.files, tree) : tree;
    if (selected.length === 0) throw new ApiError("VALIDATION_ERROR", "ファイルが見つかりません", [{ field: "files" }]);
    // 全体を取るときの名前は HF から来る。保存先の外へ出る形が混ざらないよう同じ検査を通す
    selected.forEach((file) => assertFileName(file.path));
    const destDir = insideDir(store.downloads.modelsDir(this.options.dataDir), input.repo);
    selected.forEach((file) => insideDir(destDir, file.path));
    // 登録済みのファイルを取り直しても models.create が衝突するだけなので、入口で断る
    if (input.kind !== "file" && store.downloads.isRegistered(input.kind, insideDir(destDir, selected[0].path))) {
      throw new ApiError("CONFLICT", "このファイルは登録済みです");
    }

    // ゲート付きは始める前に分かるよう、先頭の1バイトだけ取ってみる。空のファイルは Range が通らないので避ける
    const probeFile = selected.find((file) => file.size > 0);
    try {
      if (probeFile) {
        const probe = await this.client.check(await this.client.fetch(this.client.resolveUrl(input.repo, probeFile.path), { headers: { Range: "bytes=0-0" } }));
        await probe.body?.cancel();
      }
    } catch (error) {
      if (error instanceof RetryableError) throw new ApiError("UPSTREAM_ERROR", error.message);
      throw error;
    }
    await ensureSpace(destDir, selected.reduce((sum, file) => sum + file.size, 0));

    const record = store.downloads.create({
      kind: input.kind,
      repo: input.repo,
      files: selected.map((file) => ({ name: file.path, size: file.size, sha256: file.sha256 })),
      destDir,
    });
    this.emit(record);
    this.pump();
    return record;
  }

  /**
   * レシピの部品を1つの DL（image-set）にして待ち行列に入れる（D-73）。
   * 部品ごとにリポジトリが違うので、file の name は `<repo>/<file>`、repo は部品のリポジトリ
   */
  async createRecipe(recipeId: Recipe["id"]): Promise<DownloadRecord> {
    const { store } = this.options;
    const recipe = RECIPES.find((item) => item.id === recipeId);
    if (!recipe) throw new ApiError("VALIDATION_ERROR", "入力が正しくありません", [{ field: "recipe" }]);
    const destDir = store.downloads.modelsDir(this.options.dataDir);
    const pathOf = (part: { repo: string; file: string }) => insideDir(destDir, part.repo, part.file);
    const diffusion = recipe.parts.find((part) => part.key === "diffusion")!;
    const active = ["queued", "downloading", "retrying", "verifying"];
    if (store.downloads.isRegistered("image-set", pathOf(diffusion)) || this.list().some((item) => item.kind === "image-set" && active.includes(item.status))) {
      throw new ApiError("CONFLICT", "このモデルは登録済みか、取得中です");
    }

    const trees = new Map<string, Awaited<ReturnType<HfClient["listFiles"]>>>();
    const files: DownloadRecord["files"] = [];
    for (const part of recipe.parts) {
      assertRepo(part.repo);
      assertFileName(part.file);
      pathOf(part);
      if (!trees.has(part.repo)) trees.set(part.repo, await this.client.listFiles(part.repo));
      const found = trees.get(part.repo)!.find((file) => file.path === part.file);
      if (!found) throw new ApiError("UPSTREAM_ERROR", `${part.repo} に ${part.file} がありません`);
      files.push({ name: `${part.repo}/${part.file}`, size: found.size, sha256: found.sha256, repo: part.repo });
    }
    // ゲート付きは始める前に分かるよう、リポジトリごとに先頭の1バイトだけ取ってみる
    try {
      for (const repo of trees.keys()) {
        const part = recipe.parts.find((item) => item.repo === repo && files.find((file) => file.name === `${repo}/${item.file}`)!.size > 0);
        if (!part) continue;
        const probe = await this.client.check(await this.client.fetch(this.client.resolveUrl(repo, part.file), { headers: { Range: "bytes=0-0" } }));
        await probe.body?.cancel();
      }
    } catch (error) {
      if (error instanceof RetryableError) throw new ApiError("UPSTREAM_ERROR", error.message);
      throw error;
    }
    await ensureSpace(destDir, files.reduce((sum, file) => sum + file.size, 0));

    const record = store.downloads.create({ kind: "image-set", repo: diffusion.repo, files, destDir });
    this.emit(record);
    this.pump();
    return record;
  }

  /** 取り消して .part を消す */
  async cancel(id: string): Promise<DownloadRecord> {
    const record = this.require(id);
    if (record.status === "completed" || record.status === "cancelled") throw new ApiError("CONFLICT", "この DL は操作できません");
    if (this.job?.id === id) {
      this.job.stop = "cancel";
      this.job.controller.abort();
      await this.job.done;
    }
    for (const file of record.files) await rm(`${insideDir(record.destDir, file.name)}.part`, { force: true });
    return this.set(id, { status: "cancelled" });
  }

  /** 失敗したものを手動で再開する（再試行の回数は数え直す） */
  resume(id: string): DownloadRecord {
    const record = this.require(id);
    if (record.status !== "failed") throw new ApiError("CONFLICT", "この DL は操作できません");
    const updated = this.set(id, { status: "queued", retryCount: 0, error: null });
    this.pump();
    return updated;
  }

  /** 動いている DL を止める（終了時）。.part は残す */
  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.job) {
      this.job.stop = "shutdown";
      this.job.controller.abort();
      await this.job.done;
    }
    this.options.store.downloads.failInterrupted(INTERRUPTED_MESSAGE);
  }

  private require(id: string): DownloadRecord {
    const record = this.options.store.downloads.get(id);
    if (!record) throw new ApiError("NOT_FOUND", "対象がありません");
    return record;
  }

  private emit(record: DownloadRecord): void {
    this.options.bus.publish("download.progress", {
      downloadId: record.id, status: record.status, receivedBytes: record.receivedBytes, totalBytes: record.totalBytes,
    });
  }

  private set(id: string, patch: Parameters<Store["downloads"]["update"]>[1]): DownloadRecord {
    const record = this.options.store.downloads.update(id, patch);
    this.emit(record);
    return record;
  }

  /** バイトの進みは間引いて保存・通知する */
  private tick(job: Job, force = false): void {
    const nowMs = Date.now();
    if (!force && nowMs - job.lastTick < this.tuning.progressIntervalMs) return;
    job.lastTick = nowMs;
    this.set(job.id, { receivedBytes: job.received });
  }

  private pump(): void {
    if (this.closed || this.job) return;
    const next = this.options.store.downloads.nextQueued();
    if (!next) return;
    const job: Job = { id: next.id, controller: new AbortController(), stop: null, received: 0, lastTick: 0, done: Promise.resolve() };
    this.job = job;
    job.done = this.run(job).finally(() => {
      this.job = null;
      this.pump();
    });
  }

  private async run(job: Job): Promise<void> {
    for (;;) {
      try {
        await this.transfer(job);
        return;
      } catch (error) {
        if (job.stop) return;
        const record = this.options.store.downloads.get(job.id)!;
        if (error instanceof RetryableError && record.retryCount < MAX_RETRIES) {
          this.set(job.id, { status: "retrying", retryCount: record.retryCount + 1, error: error.message });
          await sleep(this.tuning.retryDelayMs, job.controller.signal);
          if (job.stop) return;
          continue;
        }
        if (!(error instanceof ApiError) && !(error instanceof RetryableError)) console.error("[downloads]", error);
        const message = error instanceof ApiError || error instanceof RetryableError ? error.message : "内部エラーが発生しました";
        this.set(job.id, { status: "failed", receivedBytes: job.received, error: message });
        return;
      }
    }
  }

  private async transfer(job: Job): Promise<void> {
    const { store } = this.options;
    const record = store.downloads.get(job.id)!;
    const target = (name: string) => insideDir(record.destDir, name);
    job.received = 0;
    this.set(job.id, { status: "downloading", error: null });

    const sizeOf = (file: string) => (existsSync(file) ? statSync(file).size : 0);
    const remaining = record.files.reduce((sum, file) => {
      const final = target(file.name);
      const have = existsSync(final) ? file.size : Math.min(sizeOf(`${final}.part`), file.size);
      return sum + file.size - have;
    }, 0);
    mkdirSync(record.destDir, { recursive: true });
    await ensureSpace(record.destDir, remaining);

    for (const file of record.files) {
      const final = target(file.name);
      if (existsSync(final) && statSync(final).size === file.size) {
        job.received += file.size;
        continue;
      }
      mkdirSync(path.dirname(final), { recursive: true });
      const repo = file.repo ?? record.repo;
      // image-set の name は `<repo>/<file>`。HF 上のファイル名は repo の後ろ
      await this.fetchFile(job, repo, file.repo ? file.name.slice(repo.length + 1) : file.name, file.size, `${final}.part`);
      this.tick(job, true);
    }

    this.set(job.id, { status: "verifying", receivedBytes: job.received });
    const toRename: string[] = [];
    for (const file of record.files) {
      const final = target(file.name);
      const part = `${final}.part`;
      if (!existsSync(part)) continue; // 前の回で外し終えている
      await this.verify(job, part, file, record.kind === "model" || record.kind === "adapter" || (record.kind === "image-set" && file.name.endsWith(".gguf")));
      toRename.push(final);
    }
    const total = record.files.reduce((sum, file) => sum + file.size, 0);
    // 保存だけの DL は形式を問わないので、GGUF としての確認も登録もしない
    if (record.kind === "file") {
      for (const final of toRename) await rename(`${final}.part`, final);
      this.set(job.id, { status: "completed", receivedBytes: total });
      return;
    }

    if (record.kind === "image-set") {
      for (const final of toRename) await rename(`${final}.part`, final);
      const recipe = RECIPES.find((item) => record.files.length === item.parts.length && item.parts.every((part) => record.files.some((file) => file.name === `${part.repo}/${part.file}`)));
      if (!recipe) throw new ApiError("VALIDATION_ERROR", "入力が正しくありません", [{ field: "recipe" }]);
      const at = (key: string) => {
        const part = recipe.parts.find((item) => item.key === key)!;
        return target(`${part.repo}/${part.file}`);
      };
      const parts = { diffusion: at("diffusion"), llm: at("llm"), vae: at("vae"), tokenizer: at("tokenizer") };
      const model = store.models.create({
        name: recipe.name, path: parts.diffusion, source: "hf", architecture: recipe.id,
        quantization: null, sizeBytes: total, trainContext: null, use: "image", parts,
      });
      store.downloads.setModelRepo(model.id, record.repo);
      this.set(job.id, { status: "completed", receivedBytes: total, resultId: model.id });
      return;
    }

    const first = target(record.files[0].name);
    const firstFile = existsSync(`${first}.part`) ? `${first}.part` : first;
    if (record.kind === "image") {
      // 画像モデルは safetensors として確かめて登録する。GGUF の検査は通さない
      let info: ReturnType<typeof readSafetensors>;
      try {
        info = readSafetensors(firstFile);
      } catch (error) {
        await Promise.all(toRename.map((final) => rm(`${final}.part`, { force: true })));
        throw error;
      }
      for (const final of toRename) await rename(`${final}.part`, final);
      const name = info.name ?? path.basename(first, ".safetensors");
      const model = store.models.create({
        name, path: first, source: "hf", architecture: "safetensors",
        quantization: null, sizeBytes: total, trainContext: null, use: "image",
      });
      store.downloads.setModelRepo(model.id, record.repo);
      this.set(job.id, { status: "completed", receivedBytes: total, resultId: model.id });
      return;
    }
    const info = readGguf(firstFile);
    const expected = record.kind === "model" ? "model" : "adapter";
    if (info.type !== expected) {
      await Promise.all(toRename.map((final) => rm(`${final}.part`, { force: true })));
      throw new ApiError("INVALID_GGUF", record.kind === "model" ? NOT_MODEL_MESSAGE : NOT_LORA_MESSAGE);
    }
    for (const final of toRename) await rename(`${final}.part`, final);

    // LoRA は登録しない。ベースモデルは利用者が選び、画面が POST /api/adapters を呼ぶ
    let resultId: string | null = null;
    if (record.kind === "model") {
      const name = info.name ?? path.basename(first, ".gguf").replace(/-00001-of-\d{5}$/, "");
      const model = store.models.create({
        name, path: first, source: "hf", architecture: info.architecture,
        quantization: info.quantization ?? quantOf(first), sizeBytes: total, trainContext: info.trainContext,
      });
      store.downloads.setModelRepo(model.id, record.repo);
      resultId = model.id;
      // すぐチャットで使えるように、対話の既定値のプリセットを1つ作る。作れなくてもモデルの登録は残す
      try {
        store.presets.create({
          name: model.name, modelId: model.id, thinking: false, contextSize: Math.min(info.trainContext ?? DEFAULT_CONTEXT, DEFAULT_CONTEXT),
          sampling: { temperature: 0.8, topP: 0.95, topK: 40, minP: 0.05, presencePenalty: 0, repeatPenalty: 1 },
        });
      } catch {
        // 同じ名前のプリセットがある等。登録したモデルはそのまま使える
      }
    }
    this.set(job.id, { status: "completed", receivedBytes: total, resultId });
  }

  /** サイズ・sha256 を確かめる（checkGguf なら GGUF の先頭も）。壊れていれば .part を消して失敗にする */
  private async verify(job: Job, part: string, file: { name: string; size: number; sha256: string | null }, checkGguf: boolean): Promise<void> {
    const broken = async (message: string): Promise<never> => {
      await rm(part, { force: true });
      throw new ApiError("UPSTREAM_ERROR", message);
    };
    if (statSync(part).size !== file.size) return broken(BROKEN_MESSAGE);
    if (checkGguf && !hasMagic(part)) {
      await rm(part, { force: true });
      throw new ApiError("INVALID_GGUF", "GGUF ファイルではありません");
    }
    if (file.sha256 && (await sha256(part, job.controller.signal)) !== file.sha256) return broken(BROKEN_MESSAGE);
  }

  /** .part に続きから書く。Range を無視されたら最初から書き直す */
  private async fetchFile(job: Job, repo: string, name: string, size: number, part: string): Promise<void> {
    let existing = existsSync(part) ? statSync(part).size : 0;
    if (existing > size) {
      await rm(part, { force: true });
      existing = 0;
    }
    if (existing === size) {
      // 空のファイルは取りに行かないが、.part がないと完成させられない
      if (size === 0) await writeFile(part, "");
      job.received += size;
      return;
    }
    const headers: Record<string, string> = existing > 0 ? { Range: `bytes=${existing}-` } : {};
    const res = await this.client.fetch(this.client.resolveUrl(repo, name), { headers, signal: job.controller.signal });
    if (res.status === 416) {
      await res.body?.cancel();
      await rm(part, { force: true });
      throw new RetryableError("範囲が合いません");
    }
    await this.client.check(res);
    let append = false;
    if (res.status === 206) {
      const start = /^bytes (\d+)-/.exec(res.headers.get("content-range") ?? "")?.[1];
      if (Number(start) !== existing) {
        await res.body?.cancel();
        await rm(part, { force: true });
        throw new RetryableError("範囲が合いません");
      }
      append = true;
      job.received += existing;
    }
    const handle = await open(part, append ? "a" : "w");
    try {
      const reader = res.body!.getReader();
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (error) {
          if (job.stop) throw error;
          throw new RetryableError("接続が切れました");
        }
        if (chunk.done) break;
        await handle.write(chunk.value);
        job.received += chunk.value.length;
        this.tick(job);
      }
    } finally {
      await handle.close();
    }
    if (statSync(part).size < size) throw new RetryableError("接続が切れました");
  }
}
