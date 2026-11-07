import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ulid } from "ulid";
import type { ChatService } from "./chat";
import type { EngineManager } from "./engine";
import type { EventBus } from "./events";
import type { GenerationSlot } from "./generation-slot";
import { ImageEngine, type ImageParams, type ImageProgress } from "./image-engine";
import { ApiError } from "./http-error";
import type { Store } from "./store";
import type { ImageParts } from "./store/models";

export interface ImageRequest extends ImageParams {
  modelId: string;
}

/**
 * 画像生成（D-72）。同時に1枚だけ、チャットの生成とは重ねない。
 * 画像モデルを読むときはチャットの llama-server を止める（VRAM を空ける）
 */
export class ImageService {
  /** 今動いている生成の取り消し口（止めるときに使う） */
  private running: { threadId: string; prompt: string; modelId: string; abort: AbortController; step: number | null; totalSteps: number | null; previewSeq: number } | null = null;
  /** 途中の画像（PNG）。SSE は再送用に直近を保持するので流さず、previewSeq を見た画面が取りに来る（D-85） */
  private latestPreview: Buffer | null = null;

  constructor(
    private store: Store,
    private engine: EngineManager,
    private image: ImageEngine,
    private bus: EventBus,
    private slot: GenerationSlot,
    private chat: ChatService,
    private dataDir: string,
  ) {}

  /** 202 で返して裏で生成する。結果は "image" イベントで届く */
  start(threadId: string, input: ImageRequest): { status: "running" } {
    if (!this.store.threads.get(threadId)) throw new ApiError("NOT_FOUND", "スレッドがありません");
    const model = this.store.models.get(input.modelId);
    if (!model || model.use !== "image") throw new ApiError("NOT_FOUND", "画像モデルがありません");
    if (!this.image.available) throw new ApiError("ENGINE_FAILED", "LLM_PARTY_SD_BIN が設定されていません");
    if (this.slot.mediaBusy || this.chat.busy) throw new ApiError("BUSY", "別の生成が動いています");
    if (this.slot.evalPresetId) throw new ApiError("BUSY", "評価の実行中です");

    this.store.threads.titleFromPrompt(threadId, input.prompt);
    this.slot.mediaBusy = true;
    const abort = new AbortController();
    this.running = { threadId, prompt: input.prompt, modelId: model.id, abort, step: null, totalSteps: null, previewSeq: 0 };
    this.latestPreview = null;
    void this.run(threadId, { ...model, parts: model.parts as ImageParts | null }, input, abort.signal).finally(() => {
      this.slot.mediaBusy = false;
      this.running = null;
      this.latestPreview = null;
    });
    return { status: "running" };
  }

  /** API-115。依頼の文は生成が終わるまで DB に入らないので、画面を開き直したらここから戻す */
  status(): { status: "idle" } | { status: "running"; threadId: string; prompt: string; modelId: string; step: number | null; totalSteps: number | null; previewSeq: number } {
    if (!this.running) return { status: "idle" };
    const { threadId, prompt, modelId, step, totalSteps, previewSeq } = this.running;
    return { status: "running", threadId, prompt, modelId, step, totalSteps, previewSeq };
  }

  /** API-116。今の途中の画像（PNG）。まだ無いか、生成していなければ null */
  preview(): Buffer | null {
    return this.latestPreview;
  }

  private onProgress(threadId: string, { percent, step, totalSteps, preview }: ImageProgress): void {
    const running = this.running;
    if (!running || running.threadId !== threadId) return;
    if (step !== undefined) running.step = step;
    if (totalSteps !== undefined) running.totalSteps = totalSteps;
    if (preview) {
      this.latestPreview = preview;
      running.previewSeq += 1;
    }
    this.bus.publish("image", { threadId, status: "progress", percent, step: running.step, totalSteps: running.totalSteps, previewSeq: running.previewSeq });
  }

  /** 実行中の画像生成を止める。止まると "image" イベントで status = cancelled が届く */
  cancel(threadId: string): { status: "cancelling" | "idle" } {
    if (!this.running || this.running.threadId !== threadId) return { status: "idle" };
    this.running.abort.abort();
    return { status: "cancelling" };
  }

  private async run(threadId: string, model: { id: string; name: string; path: string; parts: ImageParts | null }, input: ImageRequest, signal: AbortSignal): Promise<void> {
    let release: () => void;
    try {
      release = await this.slot.acquire(signal, "image");
    } catch {
      // 順番を待っている間に止められた
      this.bus.publish("image", { threadId, status: "cancelled" });
      return;
    }
    try {
      await this.engine.stop();
      await this.image.load({ path: model.path, parts: model.parts });
      if (signal.aborted) throw new Error("取り消されました");
      const png = await this.image.generate(
        { prompt: input.prompt, width: input.width, height: input.height, steps: input.steps, seed: input.seed },
        signal,
        (progress) => this.onProgress(threadId, progress),
      );
      const dir = path.join(this.dataDir, "images");
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${ulid()}.png`);
      writeFileSync(file, png);
      const id = this.store.images.create({
        threadId, modelName: model.name, prompt: input.prompt, width: input.width, height: input.height,
        steps: input.steps, seed: input.seed, path: file,
      });
      // 表示に要るものを持たせる。履歴には role = image が入らないので、ここの中身はチャットの文脈に出ない
      this.store.threads.addMessage({
        threadId, turnId: null, role: "image",
        content: JSON.stringify({ imageId: id, prompt: input.prompt, modelName: model.name, width: input.width, height: input.height }),
      });
      this.bus.publish("image", { threadId, status: "completed", imageId: id });
    } catch (error) {
      // 止められたのは失敗ではないので、エラーとしては出さない
      if (signal.aborted) {
        this.bus.publish("image", { threadId, status: "cancelled" });
        return;
      }
      const message = error instanceof Error ? error.message : "画像の生成に失敗しました";
      this.bus.publish("image", { threadId, status: "failed", error: message });
    } finally {
      release();
    }
  }

  /** 終了時に sd-server も止める */
  async shutdown(): Promise<void> {
    await this.image.stop();
  }
}
