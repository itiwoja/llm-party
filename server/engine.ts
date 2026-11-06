import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import type { EventBus } from "./events";
import { ApiError } from "./http-error";
import { GENERATION_SLOTS } from "./generation-slot";

export type EngineState = "stopped" | "starting" | "ready" | "failed";

export interface EngineSpec {
  presetId: string;
  modelPath: string;
  contextSize: number;
  /** --lora に渡す順。リクエストの lora の id はこの並び順になる */
  adapterPaths: string[];
}

export interface EngineOptions {
  bin: string | null;
  backend: "cuda" | "vulkan" | "cpu";
  dataDir: string;
  bus: EventBus;
  loadTimeoutMs?: number;
  stopGraceMs?: number;
  /** 読み込みの前に呼ぶ。画像生成の sd-server を止めて VRAM を空けるのに使う */
  beforeLoad?: () => Promise<void>;
}

const POLL_MS = 500;
const ERROR_TAIL_LINES = 20;

/** FR-003 の起動引数 */
export function buildArgs(spec: EngineSpec, backend: EngineOptions["backend"], port: number, apiKey: string): string[] {
  const args = [
    "-m", spec.modelPath,
    "-c", String(spec.contextSize),
    "-ngl", backend === "cpu" ? "0" : "auto",
    "--host", "127.0.0.1",
    "--port", String(port),
    "--api-key", apiKey,
    "--parallel", String(GENERATION_SLOTS),
    "--jinja",
    "--no-webui",
  ];
  if (spec.adapterPaths.length > 0) {
    args.push("--lora", spec.adapterPaths.join(","), "--lora-init-without-apply");
  }
  return args;
}

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

/** 読み込みの同一性。同じ key なら llama-server を読み直さず、生成の枠を一緒に持てる */
export function loadKey(spec: Pick<EngineSpec, "modelPath" | "contextSize" | "adapterPaths">): string {
  return JSON.stringify([spec.modelPath, spec.contextSize, spec.adapterPaths]);
}

function sameLoad(a: EngineSpec, b: EngineSpec): boolean {
  return loadKey(a) === loadKey(b);
}

/** llama-server を子プロセスとして1つだけ動かす（FR-003, BR-01） */
export class EngineManager {
  state: EngineState = "stopped";
  presetId: string | null = null;
  error: string | null = null;
  baseUrl = "";
  apiKey = "";

  private child: ChildProcess | null = null;
  private spec: EngineSpec | null = null;
  private tail: string[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private readonly pidFile: string;
  private readonly logsDir: string;
  private readonly loadTimeoutMs: number;
  private readonly stopGraceMs: number;

  constructor(private options: EngineOptions) {
    this.pidFile = path.join(options.dataDir, "runtime", "engine.pid");
    this.logsDir = path.join(options.dataDir, "logs");
    this.loadTimeoutMs = options.loadTimeoutMs ?? 60_000;
    this.stopGraceMs = options.stopGraceMs ?? 5_000;
    mkdirSync(path.dirname(this.pidFile), { recursive: true });
    mkdirSync(this.logsDir, { recursive: true });
    this.killLeftover();
  }

  /** 前回のプロセスが残っていれば止める。PID が再利用されていることがあるので中身を確かめる */
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

  get backend(): EngineOptions["backend"] {
    return this.options.backend;
  }

  private publish(): void {
    this.options.bus.publish("engine", {
      state: this.state,
      presetId: this.presetId,
      backend: this.options.backend,
      ...(this.error ? { error: this.error } : {}),
    });
  }

  private setState(state: EngineState, error: string | null = null): void {
    this.state = state;
    this.error = error;
    this.publish();
  }

  /** 読み込みと停止は順番に処理する */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  load(spec: EngineSpec): Promise<void> {
    return this.enqueue(() => this.doLoad(spec));
  }

  stop(): Promise<void> {
    return this.enqueue(async () => {
      await this.doStop();
      this.presetId = null;
      this.setState("stopped");
    });
  }

  private async doLoad(spec: EngineSpec): Promise<void> {
    if (this.state === "ready" && this.spec && sameLoad(this.spec, spec)) {
      this.presetId = spec.presetId;
      return;
    }
    await this.options.beforeLoad?.();
    if (!this.options.bin) {
      this.setState("failed", "LLM_PARTY_LLAMA_BIN が設定されていません");
      throw new ApiError("ENGINE_FAILED", "LLM_PARTY_LLAMA_BIN が設定されていません");
    }
    await this.doStop();

    this.presetId = spec.presetId;
    this.spec = spec;
    this.tail = [];
    this.setState("starting");

    const port = await freePort();
    this.apiKey = randomBytes(32).toString("hex");
    this.baseUrl = `http://127.0.0.1:${port}`;
    // 終了はプロセスグループごと行うので、自分のグループを持たせる
    const child = spawn(this.options.bin, buildArgs(spec, this.options.backend, port, this.apiKey), {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    this.child = child;
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const spawnFailed = new Promise<never>((_, reject) => child.once("error", reject));
    if (child.pid) writeFileSync(this.pidFile, String(child.pid));

    child.stdout?.on("data", (chunk: Buffer) => this.log(chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.log(chunk));
    child.once("close", () => {
      if (this.child !== child) return;
      this.child = null;
      this.spec = null;
      rmSync(this.pidFile, { force: true });
      if (this.state === "ready") this.setState("failed", "推論エンジンが停止しました");
    });

    try {
      await Promise.race([this.waitReady(child), spawnFailed, exited.then(() => {
        throw new Error("start-exit");
      })]);
    } catch (error) {
      const message = this.describeFailure(error);
      await this.doStop();
      this.setState("failed", message);
      throw new ApiError("ENGINE_FAILED", message);
    }
    this.setState("ready");
  }

  private describeFailure(error: unknown): string {
    if (error instanceof Error && error.message === "timeout") {
      return `モデルを読み込めませんでした（${Math.round(this.loadTimeoutMs / 1000)} 秒）`;
    }
    if (error instanceof Error && error.message !== "start-exit") return `llama-server を起動できません: ${error.message}`;
    const tail = this.tail.join("\n");
    return tail ? `モデルの読み込みに失敗しました\n${tail}` : "モデルの読み込みに失敗しました";
  }

  /** いま応答できるか。通信エラーの原因がエンジンの停止かどうかの判定に使う */
  async healthy(): Promise<boolean> {
    if (!this.child) return false;
    try {
      return (await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(POLL_MS * 2) })).ok;
    } catch {
      return false;
    }
  }

  private async waitReady(child: ChildProcess): Promise<void> {
    const deadline = Date.now() + this.loadTimeoutMs;
    while (this.child === child) {
      if (Date.now() > deadline) throw new Error("timeout");
      try {
        const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(POLL_MS * 2) });
        if (res.ok) return;
      } catch {
        // 起動中
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  private log(chunk: Buffer): void {
    const text = chunk.toString("utf8");
    this.tail.push(...text.split("\n").filter(Boolean));
    this.tail = this.tail.slice(-ERROR_TAIL_LINES);
    const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    appendFileSync(path.join(this.logsDir, `llama-server-${date}.log`), text);
  }

  private async doStop(): Promise<void> {
    const child = this.child;
    this.spec = null;
    if (!child?.pid) return;
    this.child = null;
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
