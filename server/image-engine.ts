import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import type { EventBus } from "./events";
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

export interface ImageEngineOptions {
  /** sd-server の場所（LLM_PARTY_SD_BIN）。未設定なら画像生成は使えない */
  bin: string | null;
  dataDir: string;
  bus: EventBus;
  /** 1枚の生成の上限（設計 D-72）。過ぎたら sd-server に取り消しを頼んで失敗にする */
  generateTimeoutMs?: number;
  loadTimeoutMs?: number;
  stopGraceMs?: number;
  pollMs?: number;
}

/** 読み込む画像モデル。parts があれば複数部品、なければ path の単一ファイル */
export interface ImageModelSpec { path: string; parts: ImageParts | null }

const POLL_MS = 500;

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
  private readonly generateTimeoutMs: number;
  private readonly loadTimeoutMs: number;
  private readonly stopGraceMs: number;
  private readonly pollMs: number;

  constructor(private options: ImageEngineOptions) {
    this.pidFile = path.join(options.dataDir, "runtime", "sd-engine.pid");
    this.logsDir = path.join(options.dataDir, "logs");
    this.generateTimeoutMs = options.generateTimeoutMs ?? 300_000;
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
    return this.enqueue(() => this.doLoad(model));
  }

  stop(): Promise<void> {
    return this.enqueue(() => this.doStop());
  }

  private async doLoad(model: ImageModelSpec): Promise<void> {
    const key = JSON.stringify([model.path, model.parts]);
    if (this.child && this.modelKey === key) return;
    if (!this.options.bin) throw new ApiError("ENGINE_FAILED", "LLM_PARTY_SD_BIN が設定されていません");
    await this.doStop();

    const port = await freePort();
    this.baseUrl = `http://127.0.0.1:${port}`;
    // 終了はプロセスグループごと行うので、自分のグループを持たせる
    const { parts } = model;
    const modelArgs = parts
      ? ["--diffusion-model", parts.diffusion, "--llm", parts.llm, "--vae", parts.vae, "--tokenizer", parts.tokenizer]
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

  /** 1枚生成して PNG のバイト列を返す。時間を過ぎたら取り消して失敗にする */
  generate(params: ImageParams, signal: AbortSignal): Promise<Buffer> {
    return this.enqueue(() => this.doGenerate(params, signal));
  }

  private async doGenerate(params: ImageParams, signal: AbortSignal): Promise<Buffer> {
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
    while (true) {
      if (Date.now() - started > this.generateTimeoutMs || signal.aborted) {
        await this.cancelJob(id);
        throw new ApiError("ENGINE_FAILED", `画像の生成が時間切れになりました（${Math.round(this.generateTimeoutMs / 1000)} 秒）`);
      }
      await sleep(this.pollMs);
      const res = await fetch(`${this.baseUrl}/sdcpp/v1/jobs/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(this.pollMs * 4) }).catch(() => null);
      if (!res || !res.ok) continue;
      const job = (await res.json()) as {
        status: string;
        result?: { images?: { b64_json?: string }[] } | null;
        error?: { message?: string } | null;
      };
      if (job.status === "completed") {
        const b64 = job.result?.images?.[0]?.b64_json;
        if (!b64) throw new ApiError("ENGINE_FAILED", "画像が返りませんでした");
        return Buffer.from(b64, "base64");
      }
      if (job.status === "failed") throw new ApiError("ENGINE_FAILED", `画像の生成に失敗しました: ${job.error?.message ?? "原因不明"}`);
      if (job.status === "cancelled") throw new ApiError("ENGINE_FAILED", "画像の生成が取り消されました");
    }
  }

  private async cancelJob(id: string): Promise<void> {
    await fetch(`${this.baseUrl}/sdcpp/v1/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST", signal: AbortSignal.timeout(this.pollMs * 4) }).catch(() => undefined);
  }

  private async doStop(): Promise<void> {
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
