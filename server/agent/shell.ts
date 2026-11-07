import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { killTree, treeSpawnOptions } from "../process-tree";

/** D-23 */
export const COMMAND_TIMEOUT_MS = 120_000;
/** メモリを守るために持つ出力の量。先頭とは別に、末尾（エラーが出やすい）をこの量だけ持つ */
const KEEP_HEAD_BYTES = 1024 * 1024;
const KEEP_TAIL_BYTES = 1024 * 1024;
/** シェルが終わった後、孫プロセスがパイプを握り続けていても待たない時間 */
const DRAIN_MS = 100;

export interface CommandResult {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  output: string;
}

/** 先頭と末尾だけを持つ出力バッファ。あふれたら間を捨てる */
class OutputBuffer {
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private dropped = false;

  push(chunk: Buffer): void {
    if (this.headBytes < KEEP_HEAD_BYTES) {
      const room = KEEP_HEAD_BYTES - this.headBytes;
      this.head.push(chunk.subarray(0, room));
      this.headBytes += Math.min(room, chunk.length);
      chunk = chunk.subarray(room);
      if (chunk.length === 0) return;
    }
    this.tail.push(chunk);
    this.tailBytes += chunk.length;
    while (this.tailBytes - this.tail[0].length >= KEEP_TAIL_BYTES) {
      this.tailBytes -= this.tail.shift()!.length;
      this.dropped = true;
    }
  }

  toString(): string {
    const head = Buffer.concat(this.head).toString("utf8");
    const tail = Buffer.concat(this.tail).toString("utf8");
    return this.dropped ? `${head}\n…途中の出力を省略…\n${tail}` : head + tail;
  }
}

/** モデルに伝えるシェルの名前（Q-06 の決着。D-86） */
export const SHELL_NAME = process.platform === "win32" ? "Windows PowerShell 5.1" : "bash";

/**
 * シェルの起動コマンド。Windows は日本語や引用符が崩れないよう、本文を base64 で渡して実行の段階で解釈させる。
 * 既定の出力は CP932 なので先に UTF-8 へ変える（構文エラーも UTF-8 になる）。-EncodedCommand はエラーが CLIXML になるので使わない。
 * 終了コードは外部コマンドのものか、失敗なら 1 を返す。$? を見るので判定は本文と同じ実行に入れる
 */
export function shellInvocation(command: string, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  if (platform !== "win32") return { file: "/bin/bash", args: ["-c", command] };
  const body = `${command}\n$llmPartyOk = $?\nif ($LASTEXITCODE) { exit $LASTEXITCODE } elseif (-not $llmPartyOk) { exit 1 }`;
  const encoded = Buffer.from(body, "utf8").toString("base64");
  const script = [
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
    "$OutputEncoding = [Console]::OutputEncoding",
    `Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))`,
    "if (-not $?) { exit 1 }",
  ].join("; ");
  return { file: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script] };
}

/** FR-009：シェルで実行する。時間切れと停止は子孫ごと終了（12 実行環境での違い） */
export function runShell(options: {
  command: string;
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  onOutput?(chunk: string): void;
}): Promise<CommandResult> {
  const { command, cwd, timeoutMs, signal, onOutput } = options;
  return new Promise((resolve) => {
    const shell = shellInvocation(command);
    const child = spawn(shell.file, shell.args, { cwd, stdio: ["ignore", "pipe", "pipe"], ...treeSpawnOptions });
    const buffer = new OutputBuffer();
    let timedOut = false;
    let aborted = false;
    let settled = false;

    /** チャンクの境目で日本語の1文字が割れても化けないよう、出力元ごとに復号する */
    const collector = () => {
      const decoder = new StringDecoder("utf8");
      return (data: Buffer) => {
        buffer.push(data);
        const text = decoder.write(data);
        if (text) onOutput?.(text);
      };
    };
    child.stdout.on("data", collector());
    child.stderr.on("data", collector());

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ exitCode, timedOut, aborted, output: buffer.toString() });
    };
    const stop = () => {
      if (child.pid !== undefined) killTree(child.pid, "SIGKILL");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      stop();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });

    child.once("error", (error) => {
      buffer.push(Buffer.from(`起動できませんでした: ${error.message}`));
      finish(null);
    });
    child.once("close", (code) => finish(code));
    // close は孫プロセスがパイプを握っていると来ないので、exit の少し後で打ち切る
    child.once("exit", (code) => setTimeout(() => finish(code), DRAIN_MS));
  });
}
