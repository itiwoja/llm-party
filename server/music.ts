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

export interface MusicRequest extends MusicParams {
  modelId: string;
}

interface MusicModel { id: string; name: string; parts: MusicParts }

/**
 * 音楽生成（D-78）。同時に1曲だけ、チャットや画像の生成とは重ねない。
 * 始める前に llama-server と sd-server を止めて VRAM を空ける
 */
export class MusicService {
  private running: { threadId: string; abort: AbortController; done: Promise<void> } | null = null;

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

  /** 202 で返して裏で生成する。結果は "music" イベントで届く */
  start(threadId: string, input: MusicRequest): { status: "running" } {
    if (!this.store.threads.get(threadId)) throw new ApiError("NOT_FOUND", "スレッドがありません");
    const model = this.store.models.get(input.modelId);
    if (!model || model.use !== "music" || !model.parts) throw new ApiError("NOT_FOUND", "音楽モデルがありません");
    if (!this.music.available) throw new ApiError("ENGINE_FAILED", "音楽エンジンがありません");
    if (this.slot.mediaBusy || this.chat.busy) throw new ApiError("BUSY", "別の生成が動いています");
    if (this.slot.evalPresetId) throw new ApiError("BUSY", "評価の実行中です");

    this.store.threads.titleFromPrompt(threadId, input.prompt);
    this.slot.mediaBusy = true;
    const abort = new AbortController();
    const done = this.run(threadId, { id: model.id, name: model.name, parts: model.parts as MusicParts }, input, abort.signal).finally(() => {
      this.slot.mediaBusy = false;
      this.running = null;
    });
    this.running = { threadId, abort, done };
    return { status: "running" };
  }

  /** 実行中の生成を止める。止まると "music" イベントで status = cancelled が届く */
  cancel(threadId: string): { status: "cancelling" | "idle" } {
    if (!this.running || this.running.threadId !== threadId) return { status: "idle" };
    this.running.abort.abort();
    return { status: "cancelling" };
  }

  private async run(threadId: string, model: MusicModel, input: MusicRequest, signal: AbortSignal): Promise<void> {
    let release: () => void;
    try {
      release = await this.slot.acquire(signal, "music");
    } catch {
      this.bus.publish("music", { threadId, status: "cancelled" });
      return;
    }
    try {
      await this.engine.stop();
      await this.image.stop();
      const result = await this.music.generate(input, model.parts, signal, (phase, reasoning) => this.bus.publish("music", { threadId, status: "progress", phase, ...(reasoning ? { reasoning } : {}) }));
      const dir = path.join(this.dataDir, "music");
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${ulid()}.mp3`);
      writeFileSync(file, result.audio);
      const id = this.store.tracks.create({
        threadId, modelName: model.name, prompt: input.prompt, lyrics: result.lyrics, duration: input.duration, seed: result.seed, path: file,
      });
      // 履歴には role = music が入らないので、ここの中身はチャットの文脈に出ない
      this.store.threads.addMessage({
        threadId, turnId: null, role: "music",
        content: JSON.stringify({ trackId: id, prompt: input.prompt, lyrics: result.lyrics, reasoning: result.reasoning, modelName: model.name, duration: input.duration, bpm: result.bpm, keyscale: result.keyscale }),
      });
      this.bus.publish("music", { threadId, status: "completed", trackId: id });
    } catch (error) {
      if (signal.aborted) {
        this.bus.publish("music", { threadId, status: "cancelled" });
        return;
      }
      const message = error instanceof Error ? error.message : "曲の生成に失敗しました";
      this.bus.publish("music", { threadId, status: "failed", error: message });
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
