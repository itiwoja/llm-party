import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/** D-23 */
export const COMMAND_TIMEOUT_MS = 120_000;
/** メモリを守るために持つ出力の量。先頭とは別に、末尾（エラーが出やすい）をこの量だけ持つ */
const KEEP_HEAD_BYTES = 1024 * 1024;
const KEEP_TAIL_BYTES = 1024 * 1024;
/** bash が終わった後、孫プロセスがパイプを握り続けていても待たない時間 */
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

/** プロセスグループごと終了する。もう居ないなら何もしない */
export function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/** FR-009：/bin/bash -c で実行する。時間切れと停止はプロセスグループごと終了（12 WSL での違い） */
export function runShell(options: {
  command: string;
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  onOutput?(chunk: string): void;
}): Promise<CommandResult> {
  const { command, cwd, timeoutMs, signal, onOutput } = options;
  return new Promise((resolve) => {
    const child = spawn("/bin/bash", ["-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
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
      if (child.pid !== undefined) killGroup(child.pid);
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
