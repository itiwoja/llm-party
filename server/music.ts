import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ulid } from "ulid";
import type { ChatService } from "./chat";
import type { EngineManager } from "./engine";
import type { EventBus } from "./events";
import type { GenerationSlot } from "./generation-slot";
import { ApiError } from "./http-error";
import type { ImageEngine } from "./image-engine";
import type { MusicEngine, MusicParams } from "./music-engine";
import type { Store } from "./store";
import type { MusicParts } from "./store/models";

/** シードは画面から選ばせず、毎回新しくする（D-82） */
export type MusicRequest = Omit<MusicParams, "seed"> & { modelId: string };

interface MusicModel { id: string; name: string; parts: MusicParts }

type Job = "draft" | "track";
export type MusicStatus = "idle" | "drafting" | "composing" | "rendering";

/**
 * 音楽生成（D-78, D-80）。歌詞の下書きと曲の生成を合わせて同時に1つだけ、チャットや画像の生成とは重ねない。
 * 曲の生成は始める前に llama-server と sd-server を止めて VRAM を空ける。下書きは CPU だけなので止めない
 */
export class MusicService {
  private running: { job: Job; abort: AbortController; done: Promise<void> } | null = null;
  /** 今の状態と LM の思考（再読み込みした画面に返す。DB には持たない） */
  private state: { status: MusicStatus; reasoning: string } = { status: "idle", reasoning: "" };

  constructor(
    private store: Store,
    private engine: EngineManager,
    private image: ImageEngine,
    private music: MusicEngine,
    private bus: EventBus,
    private slot: GenerationSlot,
    private chat: ChatService,
    private dataDir: string,
  ) {}

  /** 202 で返して裏で歌詞を作る。結果は "music" イベントで届く */
  draft(input: { modelId: string; prompt: string }): { status: "running" } {
    const model = this.accept(input.modelId);
    return this.begin("draft", "drafting", (signal) => this.runDraft(model, input.prompt, signal));
  }

  /** 202 で返して裏で生成する。結果は "music" イベントで届く */
  start(input: MusicRequest): { status: "running" } {
    const model = this.accept(input.modelId);
    return this.begin("track", "composing", (signal) => this.runTrack(model, input, signal));
  }

  /** 実行中の下書き・生成を止める。止まると "music" イベントで status = cancelled が届く */
  cancel(): { status: "cancelling" | "idle" } {
    if (!this.running) return { status: "idle" };
    this.running.abort.abort();
    return { status: "cancelling" };
  }

  status(): { status: MusicStatus; reasoning?: string } {
    const { status, reasoning } = this.state;
    return status === "idle" || !reasoning ? { status } : { status, reasoning };
  }

  private accept(modelId: string): MusicModel {
    const model = this.store.models.get(modelId);
    if (!model || model.use !== "music" || !model.parts) throw new ApiError("NOT_FOUND", "音楽モデルがありません");
    if (!this.music.available) throw new ApiError("ENGINE_FAILED", "音楽エンジンがありません");
    if (this.slot.mediaBusy || this.chat.busy) throw new ApiError("BUSY", "別の生成が動いています");
    if (this.slot.evalPresetId) throw new ApiError("BUSY", "評価の実行中です");
    return { id: model.id, name: model.name, parts: model.parts as MusicParts };
  }

  private begin(job: Job, status: MusicStatus, run: (signal: AbortSignal) => Promise<void>): { status: "running" } {
    this.slot.mediaBusy = true;
    this.state = { status, reasoning: "" };
    const abort = new AbortController();
    const done = run(abort.signal).finally(() => {
      this.slot.mediaBusy = false;
      this.running = null;
      this.state = { status: "idle", reasoning: "" };
    });
    this.running = { job, abort, done };
    return { status: "running" };
  }

  private progress(job: Job, phase: Exclude<MusicStatus, "idle">, reasoning?: string): void {
    this.state = { status: phase, reasoning: reasoning ?? this.state.reasoning };
    this.bus.publish("music", { job, status: "progress", phase, ...(reasoning ? { reasoning } : {}) });
  }

  /** 順番待ちの取消と、実行中の失敗・取消を同じ形で知らせる */
  private fail(job: Job, signal: AbortSignal, error: unknown): void {
    if (signal.aborted) {
      this.bus.publish("music", { job, status: "cancelled" });
      return;
    }
    this.bus.publish("music", { job, status: "failed", error: error instanceof Error ? error.message : "曲の生成に失敗しました" });
  }

  private async runDraft(model: MusicModel, prompt: string, signal: AbortSignal): Promise<void> {
    let release: () => void;
    try {
      release = await this.slot.acquire(signal, "music");
    } catch {
      this.bus.publish("music", { job: "draft", status: "cancelled" });
      return;
    }
    try {
      const lyrics = await this.music.draft({ prompt }, model.parts, signal, (reasoning) => this.progress("draft", "drafting", reasoning));
      this.bus.publish("music", { job: "draft", status: "completed", lyrics });
    } catch (error) {
      this.fail("draft", signal, error);
    } finally {
      release();
    }
  }

  private async runTrack(model: MusicModel, input: MusicRequest, signal: AbortSignal): Promise<void> {
    let release: () => void;
    try {
      release = await this.slot.acquire(signal, "music");
    } catch {
      this.bus.publish("music", { job: "track", status: "cancelled" });
      return;
    }
    try {
      await this.engine.stop();
      await this.image.stop();
      const result = await this.music.generate({ ...input, seed: -1 }, model.parts, signal, (phase, reasoning) => this.progress("track", phase, reasoning));
      const dir = path.join(this.dataDir, "music");
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${ulid()}.mp3`);
      writeFileSync(file, result.audio);
      const id = this.store.tracks.create({
        threadId: null, modelName: model.name, prompt: input.prompt, lyrics: result.lyrics, duration: input.duration, seed: result.seed, path: file,
        bpm: result.bpm, keyscale: result.keyscale, reasoning: result.reasoning,
      });
      this.bus.publish("music", { job: "track", status: "completed", trackId: id });
    } catch (error) {
      this.fail("track", signal, error);
    } finally {
      release();
    }
  }

  /** 終了時に動いている生成を止める */
  async shutdown(): Promise<void> {
    const running = this.running;
    if (!running) return;
    running.abort.abort();
    await running.done;
  }
}
