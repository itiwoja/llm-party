import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ulid } from "ulid";
import type { ChatService } from "./chat";
import type { EngineManager } from "./engine";
import type { EventBus } from "./events";
import type { GenerationSlot } from "./generation-slot";
import { ImageEngine, type ImageParams } from "./image-engine";
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
  private busy = false;

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
    if (this.busy || this.chat.busy) throw new ApiError("BUSY", "別の生成が動いています");
    if (this.slot.evalPresetId) throw new ApiError("BUSY", "評価の実行中です");

    this.busy = true;
    void this.run(threadId, model, input).finally(() => {
      this.busy = false;
    });
    return { status: "running" };
  }

  private async run(threadId: string, model: { id: string; name: string; path: string; parts: ImageParts | null }, input: ImageRequest): Promise<void> {
    const release = await this.slot.acquire(new AbortController().signal);
    try {
      await this.engine.stop();
      await this.image.load({ path: model.path, parts: model.parts });
      const png = await this.image.generate(
        { prompt: input.prompt, width: input.width, height: input.height, steps: input.steps, seed: input.seed },
        new AbortController().signal,
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
