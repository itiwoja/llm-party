import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { ApiError } from "./http-error";
import type { MusicParts } from "./store/models";

export interface MusicParams {
  /** 曲の説明 */
  prompt: string;
  /** 空なら LM が作詞する。"[Instrumental]" なら歌なし */
  lyrics: string;
  /** 秒 */
  duration: number;
  /** -1 でランダム */
  seed: number;
}

/** LM が埋めた曲の情報。画面に出す */
export interface MusicResult {
  audio: Buffer;
  lyrics: string;
  /** LM の思考（曲の説明・BPM など）。ログから取れなければ空 */
  reasoning: string;
  bpm: number | null;
  keyscale: string | null;
  seed: number;
}

export type MusicPhase = "composing" | "rendering";

/**
 * ace-lm のログから LM の思考を取り出す。標準エラーの [fill Batch0] 〜 </think> の行がそれで、
 * おまかせ作詞・歌詞あり・歌なしのどれでも同じ形で出る（実機で確認）。行の途中でチャンクが切れても読める
 */
function thoughtReader(onThought: (text: string) => void): (chunk: Buffer) => void {
  const decoder = new StringDecoder("utf8");
  let rest = "";
  let inside = false;
  let text = "";
  return (chunk) => {
    const lines = (rest + decoder.write(chunk)).split(/\r?\n/);
    rest = lines.pop() ?? "";
    for (const line of lines) {
      if (/^\[fill Batch\d+\]/.test(line)) inside = true;
      else if (inside && /^(<\/think>|\[LM-)/.test(line)) inside = false;
      else if (inside) onThought((text += `${line}\n`));
    }
  };
}

export interface MusicEngineOptions {
  /** ace-lm / ace-synth のあるフォルダ（LLM_PARTY_ACE_DIR）。未設定なら <dataDir>/runtime/ace */
  dir: string | null;
  dataDir: string;
}

export const INSTRUMENTAL = "[Instrumental]";

/**
 * VAE の分割（フレーム）。既定の 1024 は Vulkan で 8.6GB を要求して 8GB の GPU で失敗する。
 * 384 なら約 3.4GB で済み、240 秒の曲も通った（ADR-013）
 */
const VAE_CHUNK = "384";

/** かな・漢字があれば日本語の歌にする。無ければ LM に任せる */
const hasJapanese = (text: string) => /[぀-ヿ一-鿿]/.test(text);

function languageOf({ prompt, lyrics }: Pick<MusicParams, "prompt" | "lyrics">): string {
  if (lyrics === INSTRUMENTAL) return "unknown";
  return hasJapanese(`${prompt}\n${lyrics}`) ? "ja" : "";
}

/**
 * acestep.cpp を子プロセスで動かす（ADR-013）。
 * 常駐させず、1曲ごとに ace-lm（作詞と構成）→ ace-synth（音声）の順に起動する。
 * ace-server を使わないのは、WSL から Windows の exe を呼ぶとき Windows 側のポートへ届かないため
 */
export class MusicEngine {
  private readonly dir: string;
  private readonly logsDir: string;
  private readonly runDir: string;

  constructor(private options: MusicEngineOptions) {
    this.dir = options.dir ?? path.join(options.dataDir, "runtime", "ace");
    this.logsDir = path.join(options.dataDir, "logs");
    this.runDir = path.join(options.dataDir, "runtime");
  }

  private binary(name: "ace-lm" | "ace-synth"): string | null {
    for (const file of [`${name}.exe`, name]) {
      const full = path.join(this.dir, file);
      if (existsSync(full)) return full;
    }
    return null;
  }

  /** 実行ファイルは後から置けるので、起動時ではなく毎回確かめる */
  get available(): boolean {
    return this.binary("ace-lm") !== null && this.binary("ace-synth") !== null;
  }

  /** WSL から Windows の exe を呼ぶときは、パスを Windows 形式（\\wsl.localhost\...）に直す */
  private host(bin: string, file: string): string {
    if (!bin.toLowerCase().endsWith(".exe") || process.platform !== "linux") return file;
    return execFileSync("wslpath", ["-w", file], { encoding: "utf8" }).trim();
  }

  /**
   * 歌詞だけを下書きする（FR-023）。ace-lm を CPU で動かすだけで、音声コードは作らない（VRAM を使わない）。
   * LM が返す bpm・keyscale・caption などは使わず、歌詞だけを返す
   */
  async draft(input: { prompt: string }, parts: MusicParts, signal: AbortSignal, onThought: (reasoning: string) => void): Promise<string> {
    const lm = this.binary("ace-lm");
    if (!lm) throw new ApiError("ENGINE_FAILED", "音楽エンジンがありません");
    const work = path.join(this.runDir, `music-${randomUUID()}`);
    mkdirSync(work, { recursive: true });
    try {
      const request = path.join(work, "request.json");
      writeFileSync(request, JSON.stringify({
        caption: input.prompt,
        lyrics: "",
        lm_mode: "inspire",
        vocal_language: languageOf({ prompt: input.prompt, lyrics: "" }),
        lm_model: path.basename(parts.lm),
      }));
      await this.run(lm, ["--models", this.host(lm, path.dirname(parts.dit)), "--request", this.host(lm, request), "--device", "CPU"], signal, thoughtReader(onThought));
      const drafted = path.join(work, "request0.json");
      if (!existsSync(drafted)) throw new ApiError("ENGINE_FAILED", "歌詞の下書きに失敗しました");
      const lyrics = (JSON.parse(readFileSync(drafted, "utf8")) as { lyrics?: string }).lyrics?.trim() ?? "";
      if (!lyrics) throw new ApiError("ENGINE_FAILED", "歌詞の下書きに失敗しました");
      return lyrics;
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  /** 1 曲作る。signal が止まれば子プロセスを止める。時間の上限は置かない（D-78） */
  async generate(params: MusicParams, parts: MusicParts, signal: AbortSignal, onProgress: (phase: MusicPhase, reasoning?: string) => void): Promise<MusicResult> {
    const lm = this.binary("ace-lm");
    const synth = this.binary("ace-synth");
    if (!lm || !synth) throw new ApiError("ENGINE_FAILED", "音楽エンジンがありません");
    const work = path.join(this.runDir, `music-${randomUUID()}`);
    mkdirSync(work, { recursive: true });
    try {
      const request = path.join(work, "request.json");
      writeFileSync(request, JSON.stringify({
        caption: params.prompt,
        lyrics: params.lyrics,
        duration: params.duration,
        seed: params.seed,
        vocal_language: languageOf(params),
        lm_model: path.basename(parts.lm),
        synth_model: path.basename(parts.dit),
        output_format: "mp3",
        mp3_bitrate: 128,
      }));
      const models = path.dirname(parts.dit);

      onProgress("composing");
      let reasoning = "";
      // LM は Vulkan だと文字化けした結果を返す（ADR-013）。CPU でも実用の速さで動く
      await this.run(lm, ["--models", this.host(lm, models), "--request", this.host(lm, request), "--device", "CPU"], signal, thoughtReader((text) => {
        reasoning = text;
        onProgress("composing", text);
      }));
      const composed = path.join(work, "request0.json");
      if (!existsSync(composed)) throw new ApiError("ENGINE_FAILED", "作詞に失敗しました");
      const filled = JSON.parse(readFileSync(composed, "utf8")) as { lyrics?: string; bpm?: number; keyscale?: string; seed?: number };

      onProgress("rendering");
      await this.run(synth, ["--models", this.host(synth, models), "--request", this.host(synth, composed), "--vae-chunk", VAE_CHUNK], signal);
      // 失敗しても終了コードは 0 のことがある（VRAM 不足など）ので、ファイルで確かめる
      const audio = path.join(work, "request00.mp3");
      if (!existsSync(audio)) throw new ApiError("ENGINE_FAILED", "曲の生成に失敗しました。VRAM が足りない可能性があります");
      return {
        audio: readFileSync(audio),
        lyrics: filled.lyrics ?? params.lyrics,
        reasoning: reasoning.trim(),
        bpm: filled.bpm || null,
        keyscale: filled.keyscale || null,
        seed: filled.seed ?? params.seed,
      };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  private async run(bin: string, args: string[], signal: AbortSignal, onStderr?: (chunk: Buffer) => void): Promise<void> {
    if (signal.aborted) throw new ApiError("ENGINE_FAILED", "曲の生成が取り消されました");
    const child: ChildProcess = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let tail: string[] = [];
    const log = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      tail = [...tail, ...text.split("\n").filter(Boolean)].slice(-20);
      const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
      appendFileSync(path.join(this.logsDir, `ace-${date}.log`), text);
    };
    mkdirSync(this.logsDir, { recursive: true });
    child.stdout?.on("data", log);
    child.stderr?.on("data", log);
    if (onStderr) child.stderr?.on("data", onStderr);
    // WSL 側のプロセスを止めると Windows 側の exe も止まる（実機で確認）
    const abort = () => child.kill("SIGKILL");
    signal.addEventListener("abort", abort, { once: true });
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      if (signal.aborted) throw new ApiError("ENGINE_FAILED", "曲の生成が取り消されました");
      if (code !== 0) throw new ApiError("ENGINE_FAILED", `曲の生成に失敗しました\n${tail.join("\n")}`);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError("ENGINE_FAILED", `音楽エンジンを起動できません: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
}
