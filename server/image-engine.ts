import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { missingBinaryMessage } from "./binary";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import type { EventBus } from "./events";
import { HostModelCache, windowsCacheDir } from "./host-model-cache";
import { ApiError } from "./http-error";
import type { ImageParts } from "./store/models";

export interface ImageParams {
  prompt: string;
  width: number;
  height: number;
  steps: number;
  /** -1 でサーバー任せ（ランダム） */
  seed: number;
}

/** 生成の途中経過。ステップが分かれば step・totalSteps、途中の画像が出ていれば preview（PNG）が付く */
export interface ImageProgress {
  percent: number;
  step?: number;
  totalSteps?: number;
  preview?: Buffer;
}

export interface ImageEngineOptions {
  /** sd-server の場所（LLM_PARTY_SD_BIN）。未設定なら画像生成は使えない */
  bin: string | null;
  dataDir: string;
  bus: EventBus;
  /** 1枚の生成の上限（ミリ秒）。null なら上限を置かない（既定）。過ぎたら sd-server に取り消しを頼んで失敗にする */
  generateTimeoutMs?: number | null;
  loadTimeoutMs?: number;
  stopGraceMs?: number;
  pollMs?: number;
}

/** 読み込む画像モデル。parts があれば複数部品、なければ path の単一ファイル */
export interface ImageModelSpec { path: string; parts: ImageParts | null }

const POLL_MS = 500;

/**
 * 部品モデルも全部 GPU で動かす（D-85）。テキストエンコーダは大きく、8GB の GPU では DiT と一緒に載らないので、
 * 使う分の予算を絞って順に載せ替えさせる。絞らないと作業領域が足りず失敗する
 */
const PARTS_GPU = ["--max-vram", "5.5"];

/** 途中の画像の作り方（D-85）。proj は潜在を色へ写すだけなので VRAM を使わず、速度にもほぼ響かない */
const PREVIEW_MODE = "proj";

/** sd-cli のサンプリングの進捗行。読み込みの進捗（|### |）とは棒の文字で見分ける */
const CLI_STEP = /\|[=> ]*\|\s*(\d+)\/(\d+) - /g;

/** 書きかけの PNG を見せないよう、終端（IEND）まであるものだけ受け取る */
const isWholePng = (data: Buffer): boolean => data.length > 12 && data.subarray(0, 4).toString("hex") === "89504e47" && data.subarray(-8, -4).toString("latin1") === "IEND";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => (address && typeof address === "object" ? resolve(address.port) : reject(new Error("空きポートなし"))));
    });
  });
}

/**
 * sd-server（stable-diffusion.cpp）を子プロセスとして1つだけ動かす。
 * 画像モデルは単一ファイル（チェックポイント）なら起動引数 -m、複数部品なら --diffusion-model / --llm / --vae / --tokenizer で読む。読み込みが済むまで待ち受けないので、/sdcpp/v1/capabilities が応えたら準備完了
 */
export class ImageEngine {
  modelPath: string | null = null;
  private modelKey: string | null = null;
  private child: ChildProcess | null = null;
  private baseUrl = "";
  private queue: Promise<unknown> = Promise.resolve();
  private readonly pidFile: string;
  private readonly logsDir: string;
  private readonly generateTimeoutMs: number | null;
  private readonly loadTimeoutMs: number;
  private readonly stopGraceMs: number;
  private readonly pollMs: number;

  constructor(private options: ImageEngineOptions) {
    this.pidFile = path.join(options.dataDir, "runtime", "sd-engine.pid");
    this.logsDir = path.join(options.dataDir, "logs");
    this.generateTimeoutMs = options.generateTimeoutMs ?? null;
    this.loadTimeoutMs = options.loadTimeoutMs ?? 180_000;
    this.stopGraceMs = options.stopGraceMs ?? 5_000;
    this.pollMs = options.pollMs ?? POLL_MS;
    mkdirSync(path.dirname(this.pidFile), { recursive: true });
    mkdirSync(this.logsDir, { recursive: true });
    this.killLeftover();
  }

  get available(): boolean {
    return this.options.bin !== null;
  }

  /** sd-cli（Windows の .exe も可）なら、生成のたびに起動する。待ち受けないので WSL から Windows の GPU 版を呼べる */
  private get cliMode(): boolean {
    return this.options.bin !== null && /sd-cli[^/\\]*$/i.test(this.options.bin);
  }

  private cliModel: ImageModelSpec | null = null;
  private hostCache: HostModelCache | null | undefined;

  /** Windows の exe のときだけ、モデルを Windows のディスクの写しから読ませる */
  private get modelCache(): HostModelCache | null {
    if (this.hostCache === undefined) {
      const dir = this.options.bin?.toLowerCase().endsWith(".exe") ? windowsCacheDir() : null;
      this.hostCache = dir ? new HostModelCache(dir) : null;
    }
    return this.hostCache;
  }

  private async localModel(model: ImageModelSpec): Promise<ImageModelSpec> {
    const cache = this.modelCache;
    if (!cache) return model;
    const { parts } = model;
    if (!parts) return { path: await cache.localize(model.path), parts: null };
    return {
      path: model.path,
      parts: {
        diffusion: await cache.localize(parts.diffusion),
        llm: await cache.localize(parts.llm),
        vae: await cache.localize(parts.vae),
        tokenizer: await cache.localize(parts.tokenizer),
      },
    };
  }

  /** モデルを消すときに写しも消す */
  async dropCopies(model: ImageModelSpec): Promise<void> {
    const cache = this.modelCache;
    if (!cache) return;
    const files = model.parts ? [model.parts.diffusion, model.parts.llm, model.parts.vae, model.parts.tokenizer] : [model.path];
    await Promise.all(files.map((file) => cache.drop(file)));
  }
  private cliChild: ChildProcess | null = null;

  /** WSL から Windows の exe を呼ぶときは、パスを Windows 形式（\\wsl.localhost\...）に直す */
  private toHostPath(file: string): string {
    if (!this.options.bin?.toLowerCase().endsWith(".exe")) return file;
    return execFileSync("wslpath", ["-w", file], { encoding: "utf8" }).trim();
  }

  /** 前回のプロセスが残っていれば止める（PID の再利用を避けるため中身を確かめる） */
  private killLeftover(): void {
    let pid: number;
    try {
      pid = Number(readFileSync(this.pidFile, "utf8"));
    } catch {
      return;
    }
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (this.options.bin && cmdline.includes(path.basename(this.options.bin))) process.kill(-pid, "SIGKILL");
    } catch {
      // もう終わっている
    }
    rmSync(this.pidFile, { force: true });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** 同じモデルが読めていれば何もしない。違えば止めて読み直す */
  load(model: ImageModelSpec): Promise<void> {
    if (this.cliMode) return this.enqueue(async () => { this.cliModel = model; });
    return this.enqueue(() => this.doLoad(model));
  }

  stop(): Promise<void> {
    return this.enqueue(() => this.doStop());
  }

  private async doLoad(model: ImageModelSpec): Promise<void> {
    const key = JSON.stringify([model.path, model.parts]);
    if (this.child && this.modelKey === key) return;
    if (!this.options.bin) throw new ApiError("ENGINE_FAILED", "LLM_PARTY_SD_BIN が設定されていません");
    const missing = missingBinaryMessage(this.options.bin, "LLM_PARTY_SD_BIN");
    if (missing) throw new ApiError("ENGINE_FAILED", missing);
    await this.doStop();

    const port = await freePort();
    this.baseUrl = `http://127.0.0.1:${port}`;
    // 終了はプロセスグループごと行うので、自分のグループを持たせる
    const { parts } = model;
    const modelArgs = parts
      ? ["--diffusion-model", parts.diffusion, "--llm", parts.llm, "--vae", parts.vae, "--tokenizer", parts.tokenizer, ...PARTS_GPU]
      : ["-m", model.path];
    const child = spawn(this.options.bin, [...modelArgs, "--listen-ip", "127.0.0.1", "--listen-port", String(port)], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    this.child = child;
    this.modelPath = model.path;
    this.modelKey = key;
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const spawnFailed = new Promise<never>((_, reject) => child.once("error", reject));
    if (child.pid) writeFileSync(this.pidFile, String(child.pid));
    let tail: string[] = [];
    const log = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      tail = [...tail, ...text.split("\n").filter(Boolean)].slice(-20);
      const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
      appendFileSync(path.join(this.logsDir, `sd-server-${date}.log`), text);
    };
    child.stdout?.on("data", log);
    child.stderr?.on("data", log);
    child.once("close", () => {
      if (this.child !== child) return;
      this.child = null;
      this.modelPath = null;
      this.modelKey = null;
      rmSync(this.pidFile, { force: true });
    });

    try {
      await Promise.race([this.waitReady(child), spawnFailed, exited.then(() => { throw new Error("start-exit"); })]);
    } catch (error) {
      await this.doStop();
      const reason = error instanceof Error && error.message === "timeout"
        ? `画像モデルを読み込めませんでした（${Math.round(this.loadTimeoutMs / 1000)} 秒）`
        : error instanceof Error && error.message !== "start-exit"
          ? `sd-server を起動できません: ${error.message}`
          : tail.length ? `画像モデルの読み込みに失敗しました\n${tail.join("\n")}` : "画像モデルの読み込みに失敗しました";
      throw new ApiError("ENGINE_FAILED", reason);
    }
  }

  private async waitReady(child: ChildProcess): Promise<void> {
    const deadline = Date.now() + this.loadTimeoutMs;
    while (this.child === child) {
      if (Date.now() > deadline) throw new Error("timeout");
      try {
        const res = await fetch(`${this.baseUrl}/sdcpp/v1/capabilities`, { signal: AbortSignal.timeout(this.pollMs * 2) });
        if (res.ok) return;
      } catch {
        // 読み込み中
      }
      await sleep(this.pollMs);
    }
  }

  /** 1枚生成して PNG のバイト列を返す。時間を過ぎたら取り消して失敗にする。途中経過は onProgress に届く */
  generate(params: ImageParams, signal: AbortSignal, onProgress?: (progress: ImageProgress) => void): Promise<Buffer> {
    return this.enqueue(() => (this.cliMode ? this.doGenerateCli(params, signal, onProgress) : this.doGenerate(params, signal, onProgress)));
  }

  /** sd-cli で 1 枚作る。時間を過ぎたら、または取り消されたら子プロセスを止める */
  private async doGenerateCli(params: ImageParams, signal: AbortSignal, onProgress?: (progress: ImageProgress) => void): Promise<Buffer> {
    if (!this.cliModel || !this.options.bin) throw new ApiError("ENGINE_FAILED", "画像モデルが読み込まれていません");
    const model = await this.localModel(this.cliModel);
    if (signal.aborted) throw new ApiError("ENGINE_FAILED", "画像の生成が取り消されました");
    const runDir = path.join(this.options.dataDir, "runtime");
    mkdirSync(runDir, { recursive: true });
    const out = path.join(runDir, `${randomUUID()}.png`);
    const previewFile = path.join(runDir, `${randomUUID()}-preview.png`);
    const host = (file: string) => this.toHostPath(file);
    const modelArgs = model.parts
      ? ["--diffusion-model", host(model.parts.diffusion), "--llm", host(model.parts.llm), "--vae", host(model.parts.vae), "--tokenizer", host(model.parts.tokenizer), ...PARTS_GPU]
      : ["-m", host(model.path)];
    const args = [
      ...modelArgs,
      "-p", params.prompt,
      "-W", String(params.width),
      "-H", String(params.height),
      "--steps", String(params.steps),
      "--seed", String(params.seed),
      "--preview", PREVIEW_MODE,
      "--preview-path", host(previewFile),
      "--preview-interval", "1",
      "-o", host(out),
    ];
    const child = spawn(this.options.bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.cliChild = child;
    let tail: string[] = [];
    let lastStep = 0;
    const reportSteps = (text: string) => {
      const last = [...text.matchAll(CLI_STEP)].at(-1);
      if (!last) return;
      const step = Number(last[1]);
      const totalSteps = Number(last[2]);
      if (step === lastStep || totalSteps === 0) return;
      lastStep = step;
      onProgress?.({ percent: Math.round((step / totalSteps) * 100), step, totalSteps, preview: this.readPreview(previewFile) });
    };
    const log = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      tail = [...tail, ...text.split("\n").filter(Boolean)].slice(-20);
      const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
      appendFileSync(path.join(this.logsDir, `sd-cli-${date}.log`), text);
      reportSteps(text);
    };
    child.stdout?.on("data", log);
    child.stderr?.on("data", log);

    let timer: NodeJS.Timeout | undefined;
    const finished = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    });
    const timeout = new Promise<never>((_, reject) => {
      if (this.generateTimeoutMs === null) return;
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("timeout"));
      }, this.generateTimeoutMs);
    });
    const aborted = new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => {
        child.kill("SIGKILL");
        reject(new Error("aborted"));
      }, { once: true });
    });
    try {
      const code = await Promise.race([finished, timeout, aborted]);
      if (code !== 0) throw new ApiError("ENGINE_FAILED", `画像の生成に失敗しました\n${tail.join("\n")}`);
      return readFileSync(out);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof Error && error.message === "timeout") {
        throw new ApiError("ENGINE_FAILED", `画像の生成が時間切れになりました（${Math.round((this.generateTimeoutMs ?? 0) / 1000)} 秒）`);
      }
      if (error instanceof Error && error.message === "aborted") throw new ApiError("ENGINE_FAILED", "画像の生成が取り消されました");
      throw new ApiError("ENGINE_FAILED", `sd-cli を起動できません: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
      this.cliChild = null;
      rmSync(out, { force: true });
      rmSync(previewFile, { force: true });
    }
  }

  /** 途中の画像は表示だけなので、読めなくても生成は続ける */
  private readPreview(file: string): Buffer | undefined {
    try {
      const data = readFileSync(file);
      return isWholePng(data) ? data : undefined;
    } catch {
      return undefined;
    }
  }

  private async doGenerate(params: ImageParams, signal: AbortSignal, onProgress?: (progress: ImageProgress) => void): Promise<Buffer> {
    if (!this.child) throw new ApiError("ENGINE_FAILED", "画像モデルが読み込まれていません");
    const submit = await fetch(`${this.baseUrl}/sdcpp/v1/img_gen`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: params.prompt,
        width: params.width,
        height: params.height,
        seed: params.seed,
        batch_count: 1,
        output_format: "png",
        preview: PREVIEW_MODE,
        preview_interval: 1,
        sample_params: { sample_steps: params.steps },
      }),
      signal,
    }).catch(() => null);
    if (!submit || submit.status !== 202) {
      const detail = submit ? await submit.text().catch(() => "") : "";
      throw new ApiError("ENGINE_FAILED", `画像生成を始められませんでした${detail ? `: ${detail.slice(0, 300)}` : ""}`);
    }
    const { id } = (await submit.json()) as { id: string };

    const started = Date.now();
    let lastPercent = -1;
    let lastStep = 0;
    while (true) {
      if ((this.generateTimeoutMs !== null && Date.now() - started > this.generateTimeoutMs) || signal.aborted) {
        await this.cancelJob(id);
        throw new ApiError("ENGINE_FAILED", `画像の生成が時間切れになりました（${Math.round((this.generateTimeoutMs ?? 0) / 1000)} 秒）`);
      }
      await sleep(this.pollMs);
      const percent = await this.progressPercent();
      const res = await fetch(`${this.baseUrl}/sdcpp/v1/jobs/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(this.pollMs * 4) }).catch(() => null);
      if (!res || !res.ok) continue;
      const job = (await res.json()) as {
        status: string;
        result?: { images?: { b64_json?: string }[] } | null;
        error?: { message?: string } | null;
        preview?: { step?: number; total_steps?: number; b64_json?: string } | null;
      };
      const { step, total_steps: totalSteps, b64_json: previewB64 } = job.preview ?? {};
      if (typeof step === "number" && typeof totalSteps === "number" && totalSteps > 0 && step !== lastStep) {
        lastStep = step;
        const preview = previewB64 ? Buffer.from(previewB64, "base64") : undefined;
        onProgress?.({ percent: Math.round((step / totalSteps) * 100), step, totalSteps, preview: preview && isWholePng(preview) ? preview : undefined });
      } else if (lastStep === 0 && percent !== null && percent !== lastPercent) {
        // 途中の画像が出ないモデルは、割合だけ伝える
        lastPercent = percent;
        onProgress?.({ percent });
      }
      if (job.status === "completed") {
        const b64 = job.result?.images?.[0]?.b64_json;
        if (!b64) throw new ApiError("ENGINE_FAILED", "画像が返りませんでした");
        return Buffer.from(b64, "base64");
      }
      if (job.status === "failed") throw new ApiError("ENGINE_FAILED", `画像の生成に失敗しました: ${job.error?.message ?? "原因不明"}`);
      if (job.status === "cancelled") throw new ApiError("ENGINE_FAILED", "画像の生成が取り消されました");
    }
  }

  /** sd-server の進捗（0.0〜1.0）を 0〜100 の整数で返す。取れなければ null（進捗は表示だけなので失敗しても生成は続ける） */
  private async progressPercent(): Promise<number | null> {
    const res = await fetch(`${this.baseUrl}/sdapi/v1/progress`, { signal: AbortSignal.timeout(this.pollMs * 4) }).catch(() => null);
    if (!res || !res.ok) return null;
    const body = (await res.json().catch(() => null)) as { progress?: unknown } | null;
    if (typeof body?.progress !== "number" || !Number.isFinite(body.progress)) return null;
    return Math.min(100, Math.max(0, Math.round(body.progress * 100)));
  }

  private async cancelJob(id: string): Promise<void> {
    await fetch(`${this.baseUrl}/sdcpp/v1/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST", signal: AbortSignal.timeout(this.pollMs * 4) }).catch(() => undefined);
  }

  private async doStop(): Promise<void> {
    if (this.cliMode) {
      this.cliModel = null;
      this.cliChild?.kill("SIGKILL");
      this.cliChild = null;
      return;
    }
    const child = this.child;
    this.child = null;
    this.modelPath = null;
    this.modelKey = null;
    if (!child?.pid) return;
    const pid = child.pid;
    const closed = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("close", () => resolve());
    });
    const kill = (signal: NodeJS.Signals) => {
      try {
        process.kill(-pid, signal);
      } catch {
        // もう終わっている
      }
    };
    kill("SIGTERM");
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([closed, new Promise((resolve) => { timer = setTimeout(resolve, this.stopGraceMs); })]);
    clearTimeout(timer);
    kill("SIGKILL");
    await closed;
    rmSync(this.pidFile, { force: true });
  }
}
