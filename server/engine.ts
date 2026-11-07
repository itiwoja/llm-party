import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { installLlama, type InstallInput } from "./runtime/installer";
import type { LlamaFlavor } from "./runtime/manifest";
import { killTree, processLabel, treeSpawnOptions } from "./process-tree";
import { hasNvidiaGpu, ignoredOverrideWarning, resolveLlama } from "./runtime/resolver";
import type { EventBus } from "./events";
import { MTP_ONLY_MESSAGE, readGguf } from "./gguf";
import { ApiError } from "./http-error";
import { GENERATION_SLOTS } from "./generation-slot";

export type EngineState = "stopped" | "starting" | "ready" | "failed" | "installing";

export interface EngineSpec {
  presetId: string;
  modelPath: string;
  contextSize: number;
  /** GPU に載せる割合（0〜100）。null か省略は自動（llama-server が空き VRAM に合わせる） */
  gpuRatio?: number | null;
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
  /** llama-server の取得。テストで差し替える（省略時は runtime/installer の installLlama） */
  installer?: (input: InstallInput) => Promise<string>;
}

const POLL_MS = 500;
const ERROR_TAIL_LINES = 20;

/** -ngl の値。層は block_count に出力層を足した数。層の数が分からないと計算できないので自動にする */
export function gpuLayersArg(gpuRatio: number | null | undefined, blockCount: number | null): string {
  if (gpuRatio === null || gpuRatio === undefined) return "auto";
  if (gpuRatio === 0) return "0";
  if (gpuRatio === 100) return "all";
  return blockCount === null ? "auto" : String(Math.round(((blockCount + 1) * gpuRatio) / 100));
}

/** 層の数を読むのは、割合から層数を計算するときだけ。読めないファイルの失敗は llama-server に報告させる */
function blockCountOf({ gpuRatio, modelPath }: EngineSpec): number | null {
  if (gpuRatio === null || gpuRatio === undefined || gpuRatio === 0 || gpuRatio === 100) return null;
  try {
    return readGguf(modelPath).blockCount;
  } catch {
    return null;
  }
}

/** 先読みの補助部分（MTP）だけのファイルか。読めないファイルの失敗は llama-server に報告させる */
function isMtpOnly(modelPath: string): boolean {
  try {
    return readGguf(modelPath).type === "mtp";
  } catch {
    return false;
  }
}

/** FR-003 の起動引数 */
export function buildArgs(spec: EngineSpec, backend: EngineOptions["backend"], port: number, apiKey: string, blockCount: number | null = null): string[] {
  const args = [
    "-m", spec.modelPath,
    "-c", String(spec.contextSize),
    "-ngl", backend === "cpu" ? "0" : gpuLayersArg(spec.gpuRatio, blockCount),
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
export function loadKey(spec: Pick<EngineSpec, "modelPath" | "contextSize" | "gpuRatio" | "adapterPaths">): string {
  return JSON.stringify([spec.modelPath, spec.contextSize, spec.gpuRatio ?? null, spec.adapterPaths]);
}

function sameLoad(a: EngineSpec, b: EngineSpec): boolean {
  return loadKey(a) === loadKey(b);
}

/** llama-server を子プロセスとして1つだけ動かす（FR-003, BR-01） */
export class EngineManager {
  state: EngineState = "stopped";
  presetId: string | null = null;
  error: string | null = null;
  /** 実在しない LLM_PARTY_LLAMA_BIN を無視したときの警告（ADR-012）。無ければ null */
  warning: string | null = null;
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
  /** 実際に動かしているバックエンド（取得した種類に従う）。動かしていないときは null */
  private activeBackend: EngineOptions["backend"] | null = null;
  /** 取得中の割合（0〜100） */
  private installPercent: number | null = null;

  constructor(private options: EngineOptions) {
    this.pidFile = path.join(options.dataDir, "runtime", "engine.pid");
    this.logsDir = path.join(options.dataDir, "logs");
    this.loadTimeoutMs = options.loadTimeoutMs ?? 60_000;
    this.stopGraceMs = options.stopGraceMs ?? 5_000;
    this.warning = ignoredOverrideWarning(options.bin);
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
      if (processLabel(pid)?.includes("llama-server")) killTree(pid, "SIGKILL");
    } catch {
      // もう終わっている
    }
    rmSync(this.pidFile, { force: true });
  }

  get backend(): EngineOptions["backend"] {
    return this.activeBackend ?? this.options.backend;
  }

  private publish(): void {
    this.options.bus.publish("engine", {
      state: this.state,
      presetId: this.presetId,
      backend: this.backend,
      ...(this.error ? { error: this.error } : {}),
      ...(this.warning ? { warning: this.warning } : {}),
      ...(this.state === "installing" && this.installPercent !== null ? { installPercent: this.installPercent } : {}),
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
    if (isMtpOnly(spec.modelPath)) {
      // llama-server はこのファイルでエラーを出さずに落ちるので、起動する前に理由を返す
      this.setState("failed", MTP_ONLY_MESSAGE);
      throw new ApiError("ENGINE_FAILED", MTP_ONLY_MESSAGE);
    }
    await this.options.beforeLoad?.();
    this.warning = ignoredOverrideWarning(this.options.bin);
    const resolution = resolveLlama({ override: this.options.bin, dataDir: this.options.dataDir, flavor: await this.preferredFlavor() });
    let bin: string;
    let backend: EngineOptions["backend"];
    if (resolution.status === "override") {
      bin = resolution.bin;
      backend = this.options.backend;
    } else if (resolution.status === "installed") {
      bin = resolution.bin;
      backend = resolution.flavor;
    } else {
      // 初回：取得してから読み込む（ADR-011）
      bin = await this.install(resolution.flavor);
      backend = resolution.flavor;
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
    this.activeBackend = backend;
    const child = spawn(bin, buildArgs(spec, backend, port, this.apiKey, blockCountOf(spec)), {
      stdio: ["ignore", "pipe", "pipe"],
      ...treeSpawnOptions,
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

  /** 種類の選び方（判断 D3）：NVIDIA の GPU があれば CUDA、無ければ CPU */
  private async preferredFlavor(): Promise<LlamaFlavor["id"]> {
    return (await hasNvidiaGpu()) ? "cuda" : "cpu";
  }

  /** llama-server を取得する。状態は installing（進捗つき）→ 成功なら呼び出し元が続ける、失敗なら failed */
  private async install(flavor: LlamaFlavor["id"]): Promise<string> {
    this.installPercent = 0;
    this.setState("installing");
    try {
      const install = this.options.installer ?? installLlama;
      const bin = await install({
        dataDir: this.options.dataDir,
        flavor,
        signal: new AbortController().signal,
        onProgress: (percent) => {
          this.installPercent = percent;
          this.publish();
        },
      });
      this.installPercent = null;
      return bin;
    } catch (error) {
      this.installPercent = null;
      const message = error instanceof Error ? error.message : "llama-server を取得できませんでした";
      this.setState("failed", message);
      throw new ApiError("ENGINE_FAILED", message);
    }
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
    const kill = (signal: "SIGTERM" | "SIGKILL") => {
      try {
        killTree(pid, signal);
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
